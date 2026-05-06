/**
 * TranscriptStore — 原子事务内容日志
 *
 * 存储路径：<conversationsDir>/<conversationId>/transcript.jsonl
 *
 * 职责边界（ADR-CM-015）：
 * - 内容的写入和读取
 * - 身份操作（list / rename / delete / findLatest）由 ConversationRepository 负责
 *
 * 核心架构：
 *   1. `commitTurn` 是唯一原子写入入口（单向数据流）—— 根治timestamp bug
 *   2. 原子写：写 tmp → rename（POSIX）/ unlink + rename（Windows fallback）
 *   3. Per-id 串行锁（ADR-TR-8）：同 id 写操作串行，跨 id 并发
 *   4. Lazy normalize（ADR-TR-5）：老文件首次 load 同步归一化到 "header + [compact?] + post-turns" 不变量
 *   5. Canonical 回流：commitTurn 写完立即 rebuildCanonicalMessages → 返调用方
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Message } from "../types/messages.js";
import {
  appendRecord,
  cleanupOrphanTmp,
  countTurns as countTurnsFromFile,
  loadRecords,
  writeAtomic,
} from "./serializer.js";
import { needsNormalize, normalize, rebuildCanonicalMessages } from "./rebuild.js";
import type {
  InitTranscriptOptions,
  ITranscriptStore,
  LoadedTranscript,
  CompactMarker,
  TranscriptHeader,
  Turn,
} from "./types.js";
import { TRANSCRIPT_FORMAT_VERSION } from "./types.js";

import { toSafePathSegment } from "../paths.js";

// ─── 配置 ───

export interface TranscriptStoreOptions {
  /**
   * 平台 DI —— 默认 `process.platform`。
   * 测试场景下显式锚定（见 CLAUDE.md：分支 process.platform 时必须 DI）。
   */
  readonly platform?: NodeJS.Platform;
}

// ─── 实现 ───

export class TranscriptStore implements ITranscriptStore {
  private readonly conversationsDir: string;
  private readonly projectPath: string;
  private readonly platform: NodeJS.Platform;

  /**
   * Per-id 串行锁 —— 同 id 写操作按 FIFO 排队。
   *
   * 每个 id 的 value 是"当前末尾任务完成"的 Promise（已吞噬异常，防止一次失败把
   * 整条队列都拉成 rejected 状态）。调用方拿到的是**原始** Promise（带异常），
   * 链尾才吞。
   */
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * 已清理过 orphan .tmp 的 id 集合 —— 每个 id 首次触碰（init / load / commitTurn）
   * 时在锁内清理一次即可。失败静默（权限 / 目录不存在）。
   */
  private readonly cleanedIds = new Set<string>();

  constructor(
    conversationsDir: string,
    projectPath: string,
    options?: TranscriptStoreOptions,
  ) {
    this.conversationsDir = conversationsDir;
    this.projectPath = path.resolve(projectPath);
    this.platform = options?.platform ?? process.platform;
  }

  private transcriptFile(conversationId: string): string {
    return path.join(
      this.conversationsDir,
      toSafePathSegment(conversationId),
      "transcript.jsonl",
    );
  }

  // ─── Per-id 锁 ───

  /**
   * 在指定 id 的锁内运行 fn，FIFO 串行。跨 id 并发不互斥。
   *
   * 锁尾链：每次把"当前任务完成后"作为新尾部，并在尾部 settle 后 GC 过期引用
   * （防止长寿 server 进程的锁 map 单调增长）。
   */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.locks.set(id, tail);
    // 过期锁 GC —— 只在当前 tail 仍是末尾时才清
    tail.then(() => {
      if (this.locks.get(id) === tail) {
        this.locks.delete(id);
      }
    });
    return result;
  }

  // ─── Orphan tmp 清理（首次触碰） ───

  private async cleanupOnce(id: string): Promise<void> {
    if (this.cleanedIds.has(id)) return;
    this.cleanedIds.add(id);
    await cleanupOrphanTmp(this.transcriptFile(id));
  }

  // ─── init ───

  async init(
    conversationId: string,
    options: InitTranscriptOptions,
  ): Promise<void> {
    await this.withLock(conversationId, async () => {
      await this.cleanupOnce(conversationId);
      const file = this.transcriptFile(conversationId);

      const header: TranscriptHeader = {
        type: "header",
        version: TRANSCRIPT_FORMAT_VERSION,
        conversationId,
        name: null,
        projectPath: this.projectPath,
        createdAt: new Date().toISOString(),
        model: options.model,
        provider: options.provider,
      };

      // init 是"创建文件"语义，走原子写（header 单行）—— 崩溃可见性和后续 commitTurn 一致
      await writeAtomic(file, JSON.stringify(header) + "\n", {
        platform: this.platform,
      });
    });
  }

  // ─── commitTurn —— 唯一原子写入入口 ───

  async commitTurn(
    conversationId: string,
    payload: { turn?: Turn; compactBefore?: CompactMarker },
  ): Promise<Message[]> {
    if (!payload.turn && !payload.compactBefore) {
      throw new Error(
        "commitTurn requires at least turn or compactBefore",
      );
    }

    return await this.withLock(conversationId, async () => {
      await this.cleanupOnce(conversationId);
      const { header, turns, compacts } = await this.loadNormalizedInLock(
        conversationId,
      );
      const file = this.transcriptFile(conversationId);

      if (payload.compactBefore) {
        // 原子重写路径：截断 + (可选)新 turn
        //
        // keepCount 算法（§4.1）：文件现有 turns 长度减去 compactBefore.turnsCompacted（累积替代数），
        // 下限 0。slice(-keepCount) 保留末尾 keepCount 个。keepCount=0 时 slice(-0) 返回 []。
        const keepCount = Math.max(
          0,
          turns.length - payload.compactBefore.turnsCompacted,
        );
        const retainedTurns = keepCount > 0 ? turns.slice(-keepCount) : [];
        const newTurns = payload.turn
          ? [...retainedTurns, payload.turn]
          : retainedTurns;

        const content = serializeFile(header, [payload.compactBefore], newTurns);
        await writeAtomic(file, content, { platform: this.platform });

        return rebuildCanonicalMessages(newTurns, [payload.compactBefore]);
      }

      // append 路径（仅 turn，无 compact）：现有文件不改，追加新 turn
      //
      // 此处不走 writeAtomic —— append 本身是加法，POSIX `appendFile` 的写是文件级原子的
      //（单次 write syscall < PIPE_BUF 时），崩溃最多丢失这一行，不会破坏前置内容。
      // 省掉 rewrite 的 O(文件大小) 开销，符合 90% 场景（普通 append）。
      //
      // "不存在" 异常由 loadNormalizedInLock 统一抛出（line 275-278），此处无需再校验。
      await appendRecord(file, payload.turn!);

      const nextTurns = [...turns, payload.turn!];
      return rebuildCanonicalMessages(nextTurns, compacts);
    });
  }

  // ─── Legacy 薄别名 ───

  async appendTurn(conversationId: string, turn: Turn): Promise<void> {
    await this.commitTurn(conversationId, { turn });
  }

  async appendCompact(
    conversationId: string,
    compact: CompactMarker,
  ): Promise<Message[]> {
    return await this.commitTurn(conversationId, { compactBefore: compact });
  }

  // ─── load ───

  async load(conversationId: string): Promise<LoadedTranscript> {
    return await this.withLock(conversationId, async () => {
      await this.cleanupOnce(conversationId);
      const { header, turns, compacts } = await this.loadNormalizedInLock(
        conversationId,
      );
      return {
        header,
        messages: rebuildCanonicalMessages(turns, compacts),
        turnCount: turns.length,
      };
    });
  }

  // ─── countTurns ───

  /**
   * 统计 JSONL 文件中的 turn 数量。
   *
   * 走 per-id 锁：commitTurn 的原子重写（writeAtomic + Windows fallback 的
   * `unlink→rename` 短暂窗口）期间，未加锁的读可能看到瞬时 ENOENT 返回 0。
   * 锁保证同 id 读写串行，结果总是反映 commitTurn 的完整提交状态（ADR-TR-8）。
   */
  async countTurns(conversationId: string): Promise<number> {
    return await this.withLock(conversationId, () =>
      countTurnsFromFile(this.transcriptFile(conversationId)),
    );
  }

  // ─── exists ───

  async exists(conversationId: string): Promise<boolean> {
    try {
      await fs.access(this.transcriptFile(conversationId));
      return true;
    } catch {
      return false;
    }
  }

  // ─── 内部：锁内 load + 可能的同步 normalize 重写 ───

  /**
   * 在 **已持锁** 状态下加载文件并检查归一化。返回已归一化的 `{header, turns, compacts}`。
   *
   * ADR-TR-5：老文件首次 load 同步归一化重写 —— 不能 fire-and-forget，
   * 否则归一化后返回给调用方的 `LoadedTranscript` 基于旧 turns，commitTurn 又
   * 基于新文件，二者不一致。同步写入保证下次读/写立即见到归一化格式。
   */
  private async loadNormalizedInLock(
    conversationId: string,
  ): Promise<{
    header: TranscriptHeader;
    turns: Turn[];
    compacts: CompactMarker[];
  }> {
    const file = this.transcriptFile(conversationId);

    let raw;
    try {
      raw = await loadRecords(file);
    } catch (e) {
      // ENOENT 归一化为用户友好消息 —— 契约与老 assertFileExists 一致，
      // 外层调用方（commitTurn / load）拿到的异常消息稳定包含"不存在"
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Transcript ${conversationId} 不存在`);
      }
      throw e;
    }

    if (!raw.header) {
      throw new Error(
        `Transcript ${conversationId}: JSONL 文件缺少 header 行`,
      );
    }

    if (!needsNormalize(raw)) {
      return { header: raw.header, turns: raw.turns, compacts: raw.compacts };
    }

    // 需要归一化：计算新形态 + 原子重写 + 返新形态
    const normalized = normalize(raw);
    const content = serializeFile(raw.header, normalized.compacts, normalized.turns);
    await writeAtomic(file, content, { platform: this.platform });

    return {
      header: raw.header,
      turns: normalized.turns,
      compacts: normalized.compacts,
    };
  }
}

// ─── 序列化 helper ───

/**
 * 把 `header + [compact?] + turns` 组装成整个 JSONL 文件内容（以换行结尾）。
 * commitTurn 的原子重写 + lazy normalize 重写共用此辅助。
 */
function serializeFile(
  header: TranscriptHeader,
  compacts: readonly CompactMarker[],
  turns: readonly Turn[],
): string {
  const lines: string[] = [JSON.stringify(header)];
  for (const c of compacts) lines.push(JSON.stringify(c));
  for (const t of turns) lines.push(JSON.stringify(t));
  return lines.join("\n") + "\n";
}
