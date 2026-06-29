/**
 * 分片化 transcript store —— append-only 原文持久化。
 *
 * ─── 目录形态 ───
 *
 *   <conversationsDir>/<conversationId>/transcript/
 *     index.json        分片索引（owner 唯一写者，整文件原子重写）
 *     000001.jsonl      分片：首行 header，后续 run / clear 记录，只追加
 *
 * ─── 写入算法 ───
 *
 *   - append 快路径只追加单行，不重写既有内容、不重写索引；索引仅在
 *     rollover / clear 时原子重写。
 *   - rollover「索引先行、分片文件惰性创建」：超过字节上限且来了新 run 时，
 *     先原子重写索引（旧活跃置 inactive、登记新活跃条目），新分片文件在
 *     首次 append 时才落地（header + 记录一次写入）。
 *   - runIndex 唯一 assigner 是 store：打开对话时从活跃分片尾行推导（活跃片
 *     空看前一片，都无则 0），实例内缓存、append 时递增——快路径零全文件读。
 *
 * ─── 崩溃恢复（全枚举） ───
 *
 *   1. rollover 后、首次 append 前崩溃：索引指向不存在的分片文件 → 读容错
 *      视为空分片，下次 append 补建。无修复动作。
 *   2. append 单行被截断：JSONL 尾行解析失败 → 读路径丢弃坏行；推导
 *      nextRunIndex 同样跳过坏行（该 run 视为未持久化——run 级粒度的已知
 *      耐久边界）。
 *   3. 索引原子重写自身：tmp + rename 原子性兜底，无半成品形态。
 *   4. clear 两步写之间崩溃（ClearRecord 已落分片、lastClearAt 未更新）：
 *      读边界不受影响（以分片内记录为权威）；owner 下次打开推导 nextRunIndex
 *      时校核尾行——尾行是 ClearRecord 且晚于 index.lastClearAt 即补写索引，
 *      修复先于任何新写入（崩溃窗口内不可能发生 rollover，ClearRecord 必在
 *      活跃分片尾行，只查尾行即完备）。
 *
 * ─── 并发模型 ───
 *
 *   per-conversation 进程内 FIFO 锁串行写，跨对话完全并发。索引单写者 +
 *   分片行级追加，让"清理进程只删文件、永不写索引"成为安全前提。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { toSafePathSegment } from "../../paths.js";
import { recoverOrphanTmp, writeAtomic } from "../serializer.js";
import {
  DEFAULT_MAX_SHARD_BYTES,
  SHARD_FORMAT_VERSION,
  TRANSCRIPT_INDEX_VERSION,
  type AppendRunResult,
  type ClearRecord,
  type RunRecord,
  type RunRecordInput,
  type ShardHeader,
  type ShardRecordLine,
  type TranscriptIndex,
  type TranscriptShardMeta,
} from "./types.js";

export interface ShardedTranscriptStoreOptions {
  /** 平台 DI（原子写的 rename 策略），默认 process.platform */
  readonly platform?: NodeJS.Platform;
  /** 单分片字节上限 DI（测试锚定 rollover），默认 7M */
  readonly maxShardBytes?: number;
}

/** transcript 子目录与索引文件名 —— 物理布局的单一来源（清理路径同源消费） */
export const TRANSCRIPT_DIR_NAME = "transcript";
export const TRANSCRIPT_INDEX_FILE_NAME = "index.json";

/** 打开态缓存 —— 每对话首次触碰时推导一次，append 快路径零全文件读 */
interface OpenState {
  index: TranscriptIndex;
  nextRunIndex: number;
}

export class ShardedTranscriptStore {
  private readonly conversationsDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly maxShardBytes: number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly opened = new Map<string, OpenState>();
  private readonly cleanedIds = new Set<string>();

  constructor(conversationsDir: string, options?: ShardedTranscriptStoreOptions) {
    this.conversationsDir = conversationsDir;
    this.platform = options?.platform ?? process.platform;
    this.maxShardBytes = options?.maxShardBytes ?? DEFAULT_MAX_SHARD_BYTES;
  }

  // ─── 路径 ───

  private transcriptDir(conversationId: string): string {
    return path.join(
      this.conversationsDir,
      toSafePathSegment(conversationId),
      TRANSCRIPT_DIR_NAME,
    );
  }

  private indexFile(conversationId: string): string {
    return path.join(this.transcriptDir(conversationId), TRANSCRIPT_INDEX_FILE_NAME);
  }

  private shardFile(conversationId: string, meta: TranscriptShardMeta): string {
    return path.join(this.transcriptDir(conversationId), meta.file);
  }

  // ─── per-id 锁（FIFO 串行，跨 id 并发） ───

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.locks.set(id, tail);
    tail.then(() => {
      if (this.locks.get(id) === tail) {
        this.locks.delete(id);
      }
    });
    return result;
  }

  // ─── 公开 API ───

  /** 建索引 + 首个活跃分片条目（幂等：已存在则 no-op） */
  async init(conversationId: string): Promise<void> {
    await this.withLock(conversationId, async () => {
      await this.openInLock(conversationId);
    });
  }

  /**
   * 对话是否有持久化存在 —— 服从"分片文件在，会话就在"不变量：索引可读
   * **或**目录里有分片文件，任一成立即 true。纯只读探测、不触发自愈写盘
   * （自愈在读写路径的索引获取处收敛）。
   */
  async exists(conversationId: string): Promise<boolean> {
    try {
      await fs.access(this.indexFile(conversationId));
      return true;
    } catch {
      // 索引层事故不掩盖事实：有分片即会话存在
    }
    try {
      const entries = await fs.readdir(this.transcriptDir(conversationId));
      return entries.some((e) => SHARD_FILE_PATTERN.test(e));
    } catch {
      return false;
    }
  }

  /**
   * 追加一个 run 的原始记录。runIndex 由 store 分配并随结果带出。
   * 索引不存在时自动初始化（与显式 init 幂等等价）。
   */
  async appendRunRecord(
    conversationId: string,
    input: RunRecordInput,
  ): Promise<AppendRunResult> {
    return await this.withLock(conversationId, async () => {
      const state = await this.openInLock(conversationId);
      await this.rolloverIfNeededInLock(conversationId, state);

      const record: RunRecord = {
        type: "run",
        runIndex: state.nextRunIndex,
        timestamp: input.timestamp,
        messages: input.messages,
        usage: input.usage,
        source: input.source,
        advancement: input.advancement,
      };
      await this.appendLineInLock(conversationId, state, record);
      state.nextRunIndex += 1;
      return { runIndex: record.runIndex, shardId: state.index.activeShardId };
    });
  }

  /**
   * 追加清空事件：分片内落 ClearRecord（读边界的权威）+ 原子重写索引的
   * lastClearAt（清理判据的元数据投影）。两步之间崩溃由打开时校核补写。
   */
  async appendClear(conversationId: string): Promise<void> {
    await this.withLock(conversationId, async () => {
      const state = await this.openInLock(conversationId);
      const record: ClearRecord = {
        type: "clear",
        timestamp: new Date().toISOString(),
      };
      await this.appendLineInLock(conversationId, state, record);
      state.index.lastClearAt = record.timestamp;
      await this.writeIndexInLock(conversationId, state.index);
    });
  }

  /**
   * 读取索引 —— 裸读、不自愈（null = 文件缺失或损坏）。
   * 读路径消费者（倒读原语等）应使用 `ensureReadableIndex`，否则索引层
   * 事故会让完好的分片对读端"暂时失联"。
   */
  async readIndex(conversationId: string): Promise<TranscriptIndex | null> {
    try {
      const raw = await fs.readFile(this.indexFile(conversationId), "utf-8");
      return JSON.parse(raw) as TranscriptIndex;
    } catch {
      return null;
    }
  }

  /**
   * 读路径的索引获取 —— 与写路径同一自愈核：索引缺失 / 损坏时锁内
   * 收尾 tmp（能恢复则恢复）→ 从分片重建（有素材才落盘）。**决不新建**：
   * 读一个不存在的对话不产生任何副作用，仍返回 null。
   *
   * 快路径（索引可读）零锁零开销；只有异常形态才进锁收敛。
   */
  async ensureReadableIndex(
    conversationId: string,
  ): Promise<TranscriptIndex | null> {
    const fast = await this.readIndex(conversationId);
    if (fast) return fast;
    return await this.withLock(conversationId, () =>
      this.ensureIndexInLock(conversationId),
    );
  }

  /** 读取单个分片的全部有效记录行（坏行跳过——崩溃截断容错） */
  async readShardLines(
    conversationId: string,
    meta: TranscriptShardMeta,
  ): Promise<ShardRecordLine[]> {
    let content: string;
    try {
      content = await fs.readFile(
        this.shardFile(conversationId, meta),
        "utf-8",
      );
    } catch {
      // rollover 后尚未首次 append —— 索引指向的文件还不存在 = 空分片
      return [];
    }
    const lines: ShardRecordLine[] = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as ShardRecordLine;
        if (
          parsed.type === "run" ||
          parsed.type === "clear" ||
          parsed.type === "header"
        ) {
          lines.push(parsed);
        }
      } catch {
        // 坏行（崩溃截断）跳过 —— 该 run 视为未持久化
      }
    }
    return lines;
  }

  // ─── 锁内实现 ───

  /**
   * 打开对话：收尾索引的崩溃残留 tmp（能恢复则恢复）→ 读索引 → 读不出则
   * 从分片重建（自愈）→ 真空才新建；随后推导 nextRunIndex、校核 clear
   * 两步写的半成品形态。结果缓存——store 是对话写入的唯一 owner，进程内
   * 缓存与磁盘一致由锁保证。
   */
  private async openInLock(conversationId: string): Promise<OpenState> {
    const cached = this.opened.get(conversationId);
    if (cached) return cached;

    let index = await this.ensureIndexInLock(conversationId);
    if (!index) {
      const meta = buildShardMeta(1);
      index = {
        version: TRANSCRIPT_INDEX_VERSION,
        conversationId,
        activeShardId: meta.id,
        shards: [meta],
      };
      await this.writeIndexInLock(conversationId, index);
    }

    const active = activeShardOf(index);
    const lines = await this.readShardLines(conversationId, active);

    // 推导 nextRunIndex：活跃片最后一条 run；活跃片无 run 看前一片尾
    let nextRunIndex = lastRunIndexIn(lines);
    if (nextRunIndex === null) {
      for (let i = index.shards.length - 1; i >= 0 && nextRunIndex === null; i--) {
        const meta = index.shards[i]!;
        if (meta.id === active.id) continue;
        nextRunIndex = lastRunIndexIn(
          await this.readShardLines(conversationId, meta),
        );
      }
    }

    // clear 两步写中断校核：尾行是 ClearRecord 且晚于索引记录 → 补写索引。
    // 修复先于任何新写入；崩溃窗口内不可能 rollover，只查活跃片尾行即完备。
    const tail = lines[lines.length - 1];
    if (
      tail?.type === "clear" &&
      (index.lastClearAt === undefined || tail.timestamp > index.lastClearAt)
    ) {
      index.lastClearAt = tail.timestamp;
      await this.writeIndexInLock(conversationId, index);
    }

    const state: OpenState = {
      index,
      nextRunIndex: nextRunIndex === null ? 0 : nextRunIndex + 1,
    };
    this.opened.set(conversationId, state);
    return state;
  }

  /**
   * 锁内自愈核 —— 读路径（ensureReadableIndex）与写路径（openInLock）共用：
   * 收尾索引的崩溃残留 tmp（能恢复则恢复）→ 读索引 → 读不出则从分片重建。
   * 返回 null = 既无索引也无分片（是否新建由调用方按读 / 写语义决定）。
   */
  private async ensureIndexInLock(
    conversationId: string,
  ): Promise<TranscriptIndex | null> {
    if (!this.cleanedIds.has(conversationId)) {
      this.cleanedIds.add(conversationId);
      await recoverOrphanTmp(this.indexFile(conversationId));
    }

    const index = await this.readIndex(conversationId);
    if (index) return index;
    // 索引缺失 / 损坏 —— 索引只是分片的派生投影，目录里有分片即全量重建。
    // 决不把已有会话误判为新会话（那会让旧分片失联、rollover 撞号互写）。
    return await this.rebuildIndexInLock(conversationId);
  }

  /**
   * 从分片文件全量重建索引 —— **索引是派生投影，分片原文是唯一真相**。
   * 索引缺失 / 损坏（替换窗口崩溃、坏块、误删）一律走此自愈："分片文件在，
   * 会话就在"。返回 null = 目录无分片（真·新会话，由调用方新建）。
   *
   * 重建物全部取自分片记录值：shards 按文件名序号升序、createdAt 取分片
   * header 记录值（沿"清理判据不依赖文件系统时间戳"纪律，header 缺失时
   * 退化为重建时刻）；activeShardId = 最大序号；lastClearAt = 全部分片中
   * 最新 ClearRecord 时刻（读边界权威本就在分片内，此处只恢复元数据投影）。
   * 重建完成即落盘。
   */
  private async rebuildIndexInLock(
    conversationId: string,
  ): Promise<TranscriptIndex | null> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.transcriptDir(conversationId));
    } catch {
      return null; // 目录不存在 = 新会话
    }
    const shardFiles = entries.filter((e) => SHARD_FILE_PATTERN.test(e)).sort();
    if (shardFiles.length === 0) return null;

    const shards: TranscriptShardMeta[] = [];
    let lastClearAt: string | undefined;
    for (const file of shardFiles) {
      const meta: TranscriptShardMeta = {
        id: file.slice(0, -".jsonl".length),
        file,
        createdAt: new Date().toISOString(),
        isActive: false,
      };
      for (const line of await this.readShardLines(conversationId, meta)) {
        if (line.type === "header") {
          meta.createdAt = line.createdAt;
        } else if (
          line.type === "clear" &&
          (lastClearAt === undefined || line.timestamp > lastClearAt)
        ) {
          lastClearAt = line.timestamp;
        }
      }
      shards.push(meta);
    }
    shards[shards.length - 1]!.isActive = true;

    const index: TranscriptIndex = {
      version: TRANSCRIPT_INDEX_VERSION,
      conversationId,
      activeShardId: shards[shards.length - 1]!.id,
      ...(lastClearAt !== undefined ? { lastClearAt } : {}),
      shards,
    };
    await this.writeIndexInLock(conversationId, index);
    return index;
  }

  /** 超过字节上限且即将写入新 run → 索引先行 rollover，分片文件惰性创建 */
  private async rolloverIfNeededInLock(
    conversationId: string,
    state: OpenState,
  ): Promise<void> {
    const active = activeShardOf(state.index);
    let size = 0;
    try {
      size = (await fs.stat(this.shardFile(conversationId, active))).size;
    } catch {
      return; // 文件尚未创建 = 空分片，必然不超限
    }
    if (size < this.maxShardBytes) return;

    // 序号从现存最大 id 派生而非数组长度 —— 清理路径未来可能惰性剔除死
    // 索引记录，长度缩水会让新序号与现存分片撞号（互写数据）
    const nextSeq =
      Math.max(
        ...state.index.shards.map((s) => Number.parseInt(s.id, 10)),
      ) + 1;
    const meta = buildShardMeta(nextSeq);
    active.isActive = false;
    state.index.shards.push(meta);
    state.index.activeShardId = meta.id;
    await this.writeIndexInLock(conversationId, state.index);
  }

  /** 追加单行；分片文件不存在时连同 header 一次写入（惰性创建） */
  private async appendLineInLock(
    conversationId: string,
    state: OpenState,
    record: RunRecord | ClearRecord,
  ): Promise<void> {
    const active = activeShardOf(state.index);
    const file = this.shardFile(conversationId, active);
    const recordLine = `${JSON.stringify(record)}\n`;

    let exists = true;
    try {
      await fs.access(file);
    } catch {
      exists = false;
    }

    if (exists) {
      await fs.appendFile(file, recordLine, "utf-8");
      return;
    }

    const header: ShardHeader = {
      type: "header",
      version: SHARD_FORMAT_VERSION,
      conversationId,
      shardId: active.id,
      createdAt: active.createdAt,
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(
      file,
      `${JSON.stringify(header)}\n${recordLine}`,
      "utf-8",
    );
  }

  private async writeIndexInLock(
    conversationId: string,
    index: TranscriptIndex,
  ): Promise<void> {
    await writeAtomic(
      this.indexFile(conversationId),
      `${JSON.stringify(index, null, 2)}\n`,
      { platform: this.platform },
    );
  }
}

// ─── 纯辅助 ───

/** 分片文件名形态（零填充 6 位序号）—— exists 探测与索引重建共用 */
const SHARD_FILE_PATTERN = /^\d{6}\.jsonl$/;

function buildShardMeta(seq: number): TranscriptShardMeta {
  const id = String(seq).padStart(6, "0");
  return {
    id,
    file: `${id}.jsonl`,
    createdAt: new Date().toISOString(),
    isActive: true,
  };
}

function activeShardOf(index: TranscriptIndex): TranscriptShardMeta {
  const active = index.shards.find((s) => s.id === index.activeShardId);
  if (!active) {
    throw new Error(
      `transcript 索引损坏：activeShardId=${index.activeShardId} 不在分片列表中`,
    );
  }
  return active;
}

function lastRunIndexIn(lines: readonly ShardRecordLine[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.type === "run") return line.runIndex;
  }
  return null;
}
