/**
 * 分片化 transcript store —— append-only 原文持久化与分片目录的唯一写者。
 *
 * ─── 目录形态 ───
 *
 *   <conversationsDir>/<conversationId>/transcript/
 *     root.bin        已发布根：A / B 两半交替发布，第三段为 clear 意图区
 *     000001.jsonl    分片：首行 header，后续 run / clear 记录，只追加
 *     000001.pos      该片的位置文件：文件头 + 每 run 一个定长位置项（兼作 run 的意图）
 *
 * 设计与不变量见 docs/tasks/terminal-shard-directory-design.md。要点：
 *   - 打开只读固定大小的根与两处固定候选位置项，不倒扫、不列目录；
 *   - 追加分三步：意图（位置项或意图区）→ 正文 → 发布根；任一步失败，在本次调用内恢复，
 *     恢复也无法确认时抛出“结果未知”；发布写入或 fsync 失败的根记为待确认，确认或判定
 *     未发生之前不在其上继续写；
 *   - 重驱只读定位元数据与目标自己的字节；
 *   - 可见范围是序号前缀，retention 先发布撤可见、再物理删除，可续做。
 *
 * ─── 并发模型 ───
 *
 *   per-conversation 进程内 FIFO 锁串行写，跨对话完全并发。唯一写者是 Host 内按 scope 构造的
 *   store 实例；retention 经同一实例执行。只读者不持锁，按已发布前缀读取。
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ensureDurableDirectory, syncDirectory } from "../../persistence/durable-directory.js";
import { readFileRange, writeAt } from "../../persistence/positional-io.js";
import { toSafePathSegment } from "../../paths.js";
import { isProtocolIdentifier } from "../../protocol/validation.js";
import {
  ROOT_FILE_BYTES,
  ROOT_FILE_NAME,
  ROOT_HALF_BYTES,
  ROOT_INTENT_OFFSET,
  ZERO_SHA256,
  decodeIntent,
  encodeIntent,
  encodeRootHalf,
  nextHalfOffset,
  selectCurrentRoot,
  sha256,
  type DirectoryRoot,
  type PublishedRunPosition,
  type RootIntent,
  type RunSourceDigest,
} from "./directory-root.js";
import {
  LEGACY_INDEX_FILE_NAME,
  readDirectoryView,
  readRootFile,
  readShardLinesAt,
} from "./directory-view.js";
import {
  POSITION_RECORD_BYTES,
  decodePositionEntry,
  decodePositionHeader,
  encodePositionEntry,
  encodePositionHeader,
  entryOffset,
  isIntentEntry,
  isPublishedEntry,
  positionFileName,
  shardFileName,
  sourceDigestEquals,
  type PositionEntry,
  type PositionFileHeader,
} from "./position-file.js";
import {
  DEFAULT_MAX_SHARD_BYTES,
  SHARD_FORMAT_VERSION,
  TranscriptDirectoryDamagedError,
  TranscriptOutcomeUnknownError,
  type AppendCommittedRunResult,
  type AppendRunOptions,
  type AppendRunResult,
  type ClearRecord,
  type CommittedRunSource,
  type RunRecord,
  type RunRecordInput,
  type ShardHeader,
  type ShardRecordLine,
  type TranscriptIndex,
  type TranscriptRunRecord,
  type TranscriptShardRef,
  type TranscriptView,
} from "./types.js";

export interface ShardedTranscriptStoreOptions {
  /** 平台 DI，保留与既有构造参数兼容 */
  readonly platform?: NodeJS.Platform;
  /** 单分片字节阈值 DI（测试锚定换片），默认 7M；run 与 clear 都在追加前判断 */
  readonly maxShardBytes?: number;
  /** 时钟 DI（毫秒），测试锚定分片创建时刻 */
  readonly now?: () => number;
}

/** transcript 子目录名 —— 物理布局的单一来源 */
export const TRANSCRIPT_DIR_NAME = "transcript";
/** 早期本地测试资料的 v1 索引文件名，只用于一次性转换 */
export const TRANSCRIPT_INDEX_FILE_NAME = LEGACY_INDEX_FILE_NAME;

/** retention 每步至多处理的分片数 */
const RETENTION_STEP_SHARDS = 32;
const SHARD_FILE_PATTERN = /^\d{6}\.jsonl$/;

interface OpenState {
  root: DirectoryRoot;
  /** 当前根所在的一半 */
  half: 0 | 1;
  /** 有一步失败：下一次操作先执行恢复 R，从磁盘重读根 */
  dirty: boolean;
  /** 本实例写出却未确认耐久的发布（写入或 fsync 失败）：恢复时先确认它，或判定它没有发生 */
  pending?: DirectoryRoot;
  /**
   * 本实例确认过耐久的发布序号。打开时从盘上读到的根由更早的实例发布，可能没有完成 fsync；
   * 依据它作出确认（重驱返回已投影、retention 物理删除）之前，先把这一半原样重写并 fsync。
   */
  confirmedPub: number;
}

/** inline：本次调用内的恢复，两种来源都可发布；later：以后的恢复，local-turn 未发布意图一律放弃 */
type RecoveryMode = "inline" | "later";

type WriteOp =
  | { readonly kind: "run"; readonly record: RunRecord | TranscriptRunRecord; readonly source: RunSourceDigest }
  | { readonly kind: "clear"; readonly record: ClearRecord };

type CommittedRunLocation =
  | { readonly kind: "located"; readonly record: RunRecord | TranscriptRunRecord; readonly seq: number; readonly source: RunSourceDigest }
  | { readonly kind: "retired"; readonly seq: number }
  | { readonly kind: "missing" };

export interface RetainShardsReport {
  retired: number;
  deleted: number;
  warnings: string[];
}

export class ShardedTranscriptStore {
  private readonly conversationsDir: string;
  private readonly maxShardBytes: number;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly opened = new Map<string, OpenState>();

  constructor(conversationsDir: string, options?: ShardedTranscriptStoreOptions) {
    this.conversationsDir = conversationsDir;
    this.maxShardBytes = options?.maxShardBytes ?? DEFAULT_MAX_SHARD_BYTES;
    this.now = options?.now ?? Date.now;
  }

  // ─── 路径 ───

  private transcriptDir(conversationId: string): string {
    return path.join(this.conversationsDir, toSafePathSegment(conversationId), TRANSCRIPT_DIR_NAME);
  }

  private file(conversationId: string, name: string): string {
    return path.join(this.transcriptDir(conversationId), name);
  }

  // ─── per-id 锁（FIFO 串行，跨 id 并发） ───

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(() => {}, () => {});
    this.locks.set(id, tail);
    tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return result;
  }

  // ─── 公开 API ───

  /** 建立会话的分片目录（幂等：已存在则只打开） */
  async init(conversationId: string): Promise<void> {
    await this.withLock(conversationId, async () => {
      await this.openInLock(conversationId, true);
    });
  }

  /** 读路径打开前的准备：旧测试格式在此一次性转换；会话不存在时无副作用 */
  async prepareRead(conversationId: string): Promise<void> {
    await this.withLock(conversationId, async () => {
      await this.openInLock(conversationId, false);
    });
  }

  /** 会话目录被删除（delete / 工作场景移除）后丢弃打开态缓存，同 id 重建时从磁盘重新打开 */
  async forget(conversationId: string): Promise<void> {
    await this.withLock(conversationId, async () => {
      this.opened.delete(conversationId);
    });
  }

  /** 对话是否有持久化存在：有根、有 v1 索引，或目录里有分片文件 */
  async exists(conversationId: string): Promise<boolean> {
    for (const name of [ROOT_FILE_NAME, TRANSCRIPT_INDEX_FILE_NAME]) {
      try {
        await fs.access(this.file(conversationId, name));
        return true;
      } catch {
        // 继续探测
      }
    }
    return await this.hasShardFiles(conversationId);
  }

  /**
   * 追加一个 run 的原始记录（local-turn 入口）。runIndex 由 store 分配并随结果带出。
   * expectedRunIndex 小于已发布水位时按该位置核对已发布记录（promote 重试的稳定身份）。
   */
  async appendRunRecord(
    conversationId: string,
    input: RunRecordInput,
    options: AppendRunOptions = {},
  ): Promise<AppendRunResult> {
    return await this.withLock(conversationId, async () => {
      const state = (await this.openInLock(conversationId, true))!;
      const expected = options.expectedRunIndex;
      const next = state.root.tail.nextRunIndex;
      const build = (runIndex: number): RunRecord => JSON.parse(JSON.stringify({
        type: "run",
        runIndex,
        timestamp: input.timestamp,
        messages: input.messages,
        usage: input.usage,
        source: input.source,
        advancement: input.advancement,
        perspectives: input.perspectives,
        postTurnControl: input.postTurnControl,
        worksceneContinuation: input.worksceneContinuation,
      })) as RunRecord;
      if (expected !== undefined) {
        if (!Number.isSafeInteger(expected) || expected < 0) throw new TypeError("Expected transcript run index is invalid");
        if (expected < next) {
          const located = await this.locateInLock(conversationId, state, expected);
          if (located.kind === "missing") throw new Error("Transcript run location is missing from its retained shard");
          if (located.kind === "located" && !isDeepStrictEqual(located.record, build(expected))) {
            throw new Error("Transcript run conflicts with the record already published at the expected position");
          }
          await this.confirmInLock(conversationId, state);
          return { runIndex: expected, shardId: seqId(located.seq), appended: false };
        }
        if (expected > next) throw new Error("Transcript run is not contiguous with the current projection");
      }
      const record = build(next);
      const seq = await this.appendInLock(conversationId, state, {
        kind: "run",
        record,
        source: { kind: "local", runIdSha256: ZERO_SHA256, assignmentSha256: ZERO_SHA256, digestSha256: ZERO_SHA256, commitRevision: 0 },
      });
      return { runIndex: next, shardId: seqId(seq), appended: true };
    });
  }

  /**
   * 将已提交的 run 幂等物化为 transcript 投影（owner 入口）。新提交（runIndex 等于已发布水位）
   * 不读任何历史；重驱只读定位元数据与该 run 自己的字节，核对记录与来源摘要。证据所在分片
   * 已撤可见时返回已投影（evidence: "retired"）；应在可见分片中却找不到时报定位缺失。
   */
  async appendCommittedRunRecord(
    conversationId: string,
    input: TranscriptRunRecord,
    source?: CommittedRunSource,
  ): Promise<AppendCommittedRunResult> {
    if (
      input.type !== "run" ||
      !isProtocolIdentifier(input.runId) ||
      !Number.isSafeInteger(input.runIndex) ||
      input.runIndex < 0
    ) {
      throw new TypeError("Committed transcript run identity is invalid");
    }
    // 比较的是持久化后的 JSON 合同（含省略的可选字段）
    const record: TranscriptRunRecord = JSON.parse(JSON.stringify(input));
    const digest = ownerSourceDigest(record.runId, source);
    return await this.withLock(conversationId, async () => {
      const state = (await this.openInLock(conversationId, true))!;
      const next = state.root.tail.nextRunIndex;
      if (record.runIndex < next) {
        const located = await this.locateInLock(conversationId, state, record.runIndex);
        if (located.kind === "retired") {
          await this.confirmInLock(conversationId, state);
          return { runIndex: record.runIndex, shardId: seqId(located.seq), appended: false, evidence: "retired" };
        }
        if (located.kind === "missing") {
          throw new Error("Committed transcript run location is missing from its retained shard");
        }
        // 来源摘要只在双方都带来源绑定时比较（旧测试格式转换来的位置没有来源）
        const storedHasSource = located.source.kind === "owner" && !located.source.assignmentSha256.equals(ZERO_SHA256);
        if (!isDeepStrictEqual(located.record, record) || (source && storedHasSource && !sourceDigestEquals(located.source, digest))) {
          throw new Error("Committed transcript run conflicts with an existing projection");
        }
        await this.confirmInLock(conversationId, state);
        return { runIndex: record.runIndex, shardId: seqId(located.seq), appended: false };
      }
      if (record.runIndex !== next) {
        throw new Error("Committed transcript run is not contiguous with the current projection");
      }
      const seq = await this.appendInLock(conversationId, state, { kind: "run", record, source: digest });
      return { runIndex: next, shardId: seqId(seq), appended: true };
    });
  }

  /** 追加清空事件：ClearRecord 与 clear 边界随同一次发布生效 */
  async appendClear(conversationId: string): Promise<void> {
    await this.withLock(conversationId, async () => {
      const state = (await this.openInLock(conversationId, true))!;
      await this.appendInLock(conversationId, state, {
        kind: "clear",
        record: { type: "clear", timestamp: new Date(this.now()).toISOString() },
      });
    });
  }

  /** 只读视图（不持锁）：一次读取以同一次取到的根为边界 */
  async readView(conversationId: string): Promise<TranscriptView | null> {
    return await readDirectoryView(this.transcriptDir(conversationId));
  }

  /** 读一片的有效记录行；limit 截到已发布前缀。文件不存在返回 null */
  async readShardLines(conversationId: string, ref: TranscriptShardRef): Promise<ShardRecordLine[] | null> {
    return await readShardLinesAt(this.transcriptDir(conversationId), ref);
  }

  /**
   * retention 一步：按序号从旧到新撤可见（判定“序号相邻后继的创建时刻 < cutoff”，遇到第一个
   * 不满足的就停），先发布根，再物理删除撤可见区间的分片与位置文件；遇占用停下，下次续做。
   */
  async retainShards(conversationId: string, cutoff: string): Promise<RetainShardsReport> {
    const report: RetainShardsReport = { retired: 0, deleted: 0, warnings: [] };
    const cutoffMs = Date.parse(cutoff);
    await this.withLock(conversationId, async () => {
      const state = await this.openInLock(conversationId, false);
      if (!state) return;
      await this.ensureReadyInLock(conversationId, state);
      const root = state.root;
      let from = root.visible.fromSeq;
      while (from - root.visible.fromSeq < RETENTION_STEP_SHARDS && from < root.active.seq) {
        const successor = await this.shardCreatedAtMs(conversationId, state, from + 1);
        if (successor === undefined || successor >= cutoffMs) break;
        from++;
      }
      if (from > root.visible.fromSeq) {
        const fromRunIndex = await this.shardFirstRunIndex(conversationId, state, from);
        await this.publishInLock(conversationId, state, {
          ...state.root,
          pub: state.root.pub + 1,
          visible: { ...state.root.visible, fromSeq: from, fromRunIndex },
        });
        report.retired = from - root.visible.fromSeq;
      }
      // 物理删除依据的是撤可见已耐久：根若未经本实例确认，先确认
      if (state.root.visible.deletedBelowSeq < state.root.visible.fromSeq) await this.confirmInLock(conversationId, state);
      let deleted = state.root.visible.deletedBelowSeq;
      while (deleted < state.root.visible.fromSeq && deleted - state.root.visible.deletedBelowSeq < RETENTION_STEP_SHARDS * 2) {
        try {
          await unlinkIfPresent(this.file(conversationId, shardFileName(deleted)));
          await unlinkIfPresent(this.file(conversationId, positionFileName(deleted)));
        } catch (error) {
          report.warnings.push(`${shardFileName(deleted)}: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
        deleted++;
      }
      if (deleted > state.root.visible.deletedBelowSeq) {
        await syncDirectory(this.transcriptDir(conversationId));
        report.deleted = deleted - state.root.visible.deletedBelowSeq;
        await this.publishInLock(conversationId, state, {
          ...state.root,
          pub: state.root.pub + 1,
          visible: { ...state.root.visible, deletedBelowSeq: deleted },
        });
      }
    });
    return report;
  }

  // ─── 打开 ───

  /**
   * 打开对话。根存在：读根，检查两处固定候选与意图区，有效意图交恢复 R，再校验活跃片大小
   * 等于已发布尾部。根不存在：目录为空时（create）新建；有 v1 索引则一次性转换；已有分片却既
   * 无根也无 v1 索引，失败关闭。
   */
  private async openInLock(conversationId: string, create: boolean): Promise<OpenState | null> {
    const cached = this.opened.get(conversationId);
    if (cached) {
      await this.ensureReadyInLock(conversationId, cached);
      return cached;
    }
    const dir = this.transcriptDir(conversationId);
    const file = await readRootFile(dir);
    let state: OpenState;
    if (!file) {
      if (await pathExists(path.join(dir, TRANSCRIPT_INDEX_FILE_NAME))) {
        state = await this.convertLegacyInLock(conversationId);
      } else if (await this.hasShardFiles(conversationId)) {
        throw new TranscriptDirectoryDamagedError("Transcript shards exist without a directory root");
      } else if (!create) {
        return null;
      } else {
        state = await this.initializeInLock(conversationId);
      }
    } else {
      const current = selectCurrentRoot(file);
      if (!current) throw new TranscriptDirectoryDamagedError("Both transcript directory root halves are invalid");
      state = { root: current.root, half: current.half, dirty: true, confirmedPub: 0 };
      await this.recoverInLock(conversationId, state, "later", file);
    }
    this.opened.set(conversationId, state);
    return state;
  }

  private async ensureReadyInLock(conversationId: string, state: OpenState): Promise<void> {
    if (!state.dirty) return;
    await this.recoverInLock(conversationId, state, "later");
  }

  /** 新会话：只发布根（首片文件随第一次追加创建）；用临时文件改名，根要么完整存在、要么不存在 */
  private async initializeInLock(conversationId: string): Promise<OpenState> {
    const dir = this.transcriptDir(conversationId);
    await ensureDurableDirectory(dir);
    const root: DirectoryRoot = {
      epoch: randomBytes(16),
      pub: 1,
      active: { seq: 1, createdAtMs: this.now(), firstRunIndex: 0, prevSealedSize: 0 },
      tail: { size: 0, nextRunIndex: 0 },
      clear: { generation: 0, boundaryRunIndex: 0 },
      visible: { fromSeq: 1, fromRunIndex: 0, deletedBelowSeq: 1 },
      strictFrom: { seq: 1, offset: 0 },
    };
    await this.writeNewRootFile(conversationId, root);
    return { root, half: 0, dirty: false, confirmedPub: root.pub };
  }

  private async writeNewRootFile(conversationId: string, root: DirectoryRoot): Promise<void> {
    const buf = Buffer.alloc(ROOT_FILE_BYTES);
    encodeRootHalf(root).copy(buf, 0);
    const target = this.file(conversationId, ROOT_FILE_NAME);
    const temp = `${target}.init`;
    await writeAt(temp, 0, buf, true);
    await fs.rename(temp, target);
    await syncDirectory(this.transcriptDir(conversationId));
  }

  private async hasShardFiles(conversationId: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(this.transcriptDir(conversationId));
      return entries.some((entry) => SHARD_FILE_PATTERN.test(entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  // ─── 追加三步 ───

  /** A1 意图 → A2 正文 → A3 发布；任一步失败，本次调用内恢复，按恢复结果返回或抛错 */
  private async appendInLock(conversationId: string, state: OpenState, op: WriteOp): Promise<number> {
    await this.ensureReadyInLock(conversationId, state);
    const root = state.root;
    const rollover = root.tail.size >= this.maxShardBytes;
    const seq = rollover ? root.active.seq + 1 : root.active.seq;
    const newShard = rollover || root.tail.size === 0;
    const createdAtMs = rollover ? this.now() : root.active.createdAtMs;
    const firstRunIndex = rollover ? root.tail.nextRunIndex : root.active.firstRunIndex;
    const headerBytes = newShard ? headerLine(conversationId, seq, createdAtMs, firstRunIndex) : Buffer.alloc(0);
    const lineBytes = Buffer.from(`${JSON.stringify(op.record)}\n`, "utf-8");
    const start = newShard ? 0 : root.tail.size;
    const lineOffset = start + headerBytes.length;
    const lineSha256 = sha256(lineBytes);
    const shardPath = this.file(conversationId, shardFileName(seq));
    const posPath = this.file(conversationId, positionFileName(seq));
    const position: PublishedRunPosition | undefined = op.kind === "run"
      ? { runIndex: op.record.runIndex, seq, offset: lineOffset, length: lineBytes.length, lineSha256, source: op.source }
      : undefined;
    try {
      // A1：run 写位置项（新片连同文件头），clear 写意图区（新片同时写位置文件头）
      const prevSealedSize = rollover ? root.tail.size : root.active.prevSealedSize;
      const posHeader = newShard
        ? encodePositionHeader({ epoch: root.epoch, seq, firstRunIndex, createdAtMs, ...(prevSealedSize !== undefined ? { prevSealedSize } : {}) })
        : undefined;
      if (op.kind === "run") {
        const entry = encodePositionEntry({ ...position!, epoch: root.epoch, forPub: root.pub + 1, newShard });
        const index = op.record.runIndex - firstRunIndex;
        if (posHeader) {
          await writeAt(posPath, 0, Buffer.concat([posHeader, index === 0 ? entry : Buffer.alloc(0)]), true);
          if (index !== 0) await writeAt(posPath, entryOffset(index), entry, false);
          await syncDirectory(this.transcriptDir(conversationId));
        } else {
          await writeAt(posPath, entryOffset(index), entry, false);
        }
      } else {
        if (posHeader) {
          await writeAt(posPath, 0, posHeader, true);
          await syncDirectory(this.transcriptDir(conversationId));
        }
        const intent: RootIntent = {
          kind: "clear",
          forPub: root.pub + 1,
          seq,
          offset: start,
          length: headerBytes.length + lineBytes.length,
          sha256: sha256(Buffer.concat([headerBytes, lineBytes])),
          ...(newShard ? { newShard: { createdAtMs, firstRunIndex } } : {}),
        };
        await writeAt(this.file(conversationId, ROOT_FILE_NAME), ROOT_INTENT_OFFSET, encodeIntent(root.epoch, intent), false);
      }
      // A2：正文
      await writeAt(shardPath, start, Buffer.concat([headerBytes, lineBytes]), newShard);
      if (newShard) await syncDirectory(this.transcriptDir(conversationId));
      // A3：发布
      await this.publishInLock(conversationId, state, publishedAfter(root, {
        seq,
        createdAtMs,
        firstRunIndex,
        size: lineOffset + lineBytes.length,
        ...(position ? { position } : {}),
        ...(op.kind === "clear" ? { clearAtMs: Date.parse(op.record.timestamp) } : {}),
      }));
      return seq;
    } catch (error) {
      state.dirty = true;
      let published: boolean;
      try {
        published = await this.recoverInLock(conversationId, state, "inline");
      } catch (recoveryError) {
        throw new TranscriptOutcomeUnknownError("Transcript append outcome is unknown after a failed recovery", {
          cause: recoveryError,
        });
      }
      if (published) return seq;
      throw error;
    }
  }

  /**
   * 写非当前的那一半并 fsync：提交点。写入或 fsync 失败时这一半可能已经可见却未耐久，
   * 记为待确认并标记 dirty：之后任何操作先恢复，确认它或判定它没有发生，不在旧缓存上继续写。
   */
  private async publishInLock(conversationId: string, state: OpenState, next: DirectoryRoot): Promise<void> {
    const target = nextHalfOffset(state.half);
    try {
      await writeAt(this.file(conversationId, ROOT_FILE_NAME), target, encodeRootHalf(next), false);
    } catch (error) {
      state.pending = next;
      state.dirty = true;
      throw error;
    }
    state.root = next;
    state.half = target === 0 ? 0 : 1;
    state.confirmedPub = next.pub;
  }

  /** 依据当前根作出确认之前：当前根若未经本实例确认耐久，把这一半原样重写并 fsync */
  private async confirmInLock(conversationId: string, state: OpenState): Promise<void> {
    if (state.confirmedPub === state.root.pub) return;
    await writeAt(this.file(conversationId, ROOT_FILE_NAME), state.half * ROOT_HALF_BYTES, encodeRootHalf(state.root), false);
    state.confirmedPub = state.root.pub;
  }

  // ─── 恢复 R ───

  /**
   * 恢复：从磁盘重读根。有待确认的发布时先处理它：已可见则原样重写并 fsync 后确认，未可见则判定
   * 没有发生；之后核对 run 意图（两处固定候选）与 clear 意图，按“未写 / 写了一半 / 写完整”处理，
   * 最后校验活跃片大小等于已发布尾部。返回本次调用的写入是否已发布（inline 时有意义）。
   *
   * 写完整的行或根半不能直接当作已耐久：发布或确认前把这些字节原样重写并 fsync。
   */
  private async recoverInLock(
    conversationId: string,
    state: OpenState,
    mode: RecoveryMode,
    preread?: Buffer,
  ): Promise<boolean> {
    const file = preread ?? await readRootFile(this.transcriptDir(conversationId));
    const current = file ? selectCurrentRoot(file) : undefined;
    if (!file || !current) throw new TranscriptDirectoryDamagedError("Transcript directory root is unreadable during recovery");
    state.root = current.root;
    state.half = current.half;
    let published = false;
    const pending = state.pending;
    if (pending) {
      if (current.root.pub === pending.pub) {
        const visible = file.subarray(current.half * ROOT_HALF_BYTES, (current.half + 1) * ROOT_HALF_BYTES);
        if (!visible.equals(encodeRootHalf(pending))) {
          throw new TranscriptDirectoryDamagedError("Transcript directory root differs from the unconfirmed publish");
        }
        await this.confirmInLock(conversationId, state);
        published = true;
      } else if (current.root.pub !== pending.pub - 1) {
        throw new TranscriptDirectoryDamagedError("Transcript directory root moved outside the unconfirmed publish");
      }
      state.pending = undefined;
    }
    if (!published) {
      const root = current.root;
      const candidates = [
        { seq: root.active.seq, index: root.tail.nextRunIndex - root.active.firstRunIndex },
        { seq: root.active.seq + 1, index: 0 },
      ];
      for (const candidate of candidates) {
        const entry = await this.readEntry(conversationId, candidate.seq, candidate.index, root);
        if (!isIntentEntry(entry, root)) continue;
        published = await this.recoverRunIntent(conversationId, state, entry, candidate.seq, mode);
        break;
      }
      const intent = decodeIntent(file.subarray(ROOT_INTENT_OFFSET, ROOT_INTENT_OFFSET + ROOT_HALF_BYTES), root);
      if (!published && intent) published = await this.recoverClearIntent(conversationId, state, intent);
    }
    await this.verifyTailInLock(conversationId, state);
    state.dirty = false;
    return published;
  }

  private async recoverRunIntent(
    conversationId: string,
    state: OpenState,
    entry: PositionEntry,
    seq: number,
    mode: RecoveryMode,
  ): Promise<boolean> {
    const root = state.root;
    const header = entry.newShard ? await this.readPositionHeader(conversationId, seq, root) : undefined;
    if (entry.newShard && !header) throw new TranscriptDirectoryDamagedError("Transcript position header is missing for a new shard intent");
    if (header && seq !== root.active.seq && header.prevSealedSize !== undefined && header.prevSealedSize !== root.tail.size) {
      throw new TranscriptDirectoryDamagedError("Transcript position header does not record the sealed size of its predecessor");
    }
    const start = entry.newShard ? 0 : root.tail.size;
    const prefix = header ? headerLine(conversationId, seq, header.createdAtMs, header.firstRunIndex) : Buffer.alloc(0);
    if (entry.offset !== start + prefix.length) throw new TranscriptDirectoryDamagedError("Transcript run intent does not continue the published tail");
    const shardPath = this.file(conversationId, shardFileName(seq));
    const end = entry.offset + entry.length;
    const size = await fileSize(shardPath);
    const abandon = async () => {
      await this.abandonWrite(shardPath, start, entry.newShard, size);
      await writeAt(this.file(conversationId, positionFileName(seq)), entryOffset(entry.runIndex - (header?.firstRunIndex ?? root.active.firstRunIndex)), Buffer.alloc(POSITION_RECORD_BYTES), false);
      return false;
    };
    if (size === undefined || size <= start) return await abandon();
    if (size < end) return await abandon();
    if (size > end) throw new TranscriptDirectoryDamagedError("Transcript shard has bytes beyond the run intent");
    const bytes = await readFileRange(shardPath, start, end - start);
    if (!bytes || bytes.length !== end - start || !bytes.subarray(0, prefix.length).equals(prefix) ||
        !sha256(bytes.subarray(prefix.length)).equals(entry.lineSha256)) {
      throw new TranscriptDirectoryDamagedError("Transcript shard bytes do not match the run intent");
    }
    if (mode === "later" && entry.source.kind === "local") return await abandon();
    await writeAt(shardPath, start, bytes, entry.newShard);
    if (entry.newShard) await syncDirectory(this.transcriptDir(conversationId));
    const firstRunIndex = header?.firstRunIndex ?? root.active.firstRunIndex;
    await writeAt(this.file(conversationId, positionFileName(seq)), entryOffset(entry.runIndex - firstRunIndex), encodePositionEntry(entry), false);
    await this.publishInLock(conversationId, state, publishedAfter(root, {
      seq,
      createdAtMs: header?.createdAtMs ?? root.active.createdAtMs,
      firstRunIndex,
      size: end,
      position: entry,
    }));
    return true;
  }

  private async recoverClearIntent(conversationId: string, state: OpenState, intent: RootIntent): Promise<boolean> {
    const root = state.root;
    const shardPath = this.file(conversationId, shardFileName(intent.seq));
    const end = intent.offset + intent.length;
    const size = await fileSize(shardPath);
    const abandon = async () => {
      await this.abandonWrite(shardPath, intent.offset, !!intent.newShard, size);
      await writeAt(this.file(conversationId, ROOT_FILE_NAME), ROOT_INTENT_OFFSET, Buffer.alloc(ROOT_HALF_BYTES), false);
      return false;
    };
    if (size === undefined || size <= intent.offset || size < end) return await abandon();
    if (size > end) throw new TranscriptDirectoryDamagedError("Transcript shard has bytes beyond the clear intent");
    const bytes = await readFileRange(shardPath, intent.offset, intent.length);
    if (!bytes || !sha256(bytes).equals(intent.sha256)) {
      throw new TranscriptDirectoryDamagedError("Transcript shard bytes do not match the clear intent");
    }
    const clear = JSON.parse(bytes.toString("utf-8").trimEnd().split("\n").at(-1)!) as ClearRecord;
    await writeAt(shardPath, intent.offset, bytes, !!intent.newShard);
    if (intent.newShard) await syncDirectory(this.transcriptDir(conversationId));
    await this.publishInLock(conversationId, state, publishedAfter(root, {
      seq: intent.seq,
      createdAtMs: intent.newShard?.createdAtMs ?? root.active.createdAtMs,
      firstRunIndex: intent.newShard?.firstRunIndex ?? root.active.firstRunIndex,
      size: end,
      clearAtMs: Date.parse(clear.timestamp),
    }));
    return true;
  }

  /** 放弃本意图的写入：截断回起点（新片直接删除），fsync */
  private async abandonWrite(shardPath: string, start: number, newShard: boolean, size: number | undefined): Promise<void> {
    if (size === undefined) return;
    if (newShard && start === 0) {
      await unlinkIfPresent(shardPath);
      await syncDirectory(path.dirname(shardPath));
      return;
    }
    if (size > start) {
      const handle = await fs.open(shardPath, "r+");
      try {
        await handle.truncate(start);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  private async verifyTailInLock(conversationId: string, state: OpenState): Promise<void> {
    const size = await fileSize(this.file(conversationId, shardFileName(state.root.active.seq)));
    if ((size ?? 0) === state.root.tail.size && (size !== undefined || state.root.tail.size === 0)) return;
    if (size === undefined) throw new TranscriptDirectoryDamagedError("Active transcript shard is missing");
    throw new TranscriptDirectoryDamagedError(
      size > state.root.tail.size
        ? "Active transcript shard has bytes not explained by any intent"
        : "Active transcript shard is shorter than its published tail",
    );
  }

  // ─── 重驱定位 ───

  /**
   * 按 runIndex 定位已发布的 run：撤可见区间直接判退役；最近一条走根里的精确位置；其他按
   * 位置文件头的 firstRunIndex 在可见区间二分，读一个位置项，再只读该 run 自己的字节。
   */
  private async locateInLock(conversationId: string, state: OpenState, runIndex: number): Promise<CommittedRunLocation> {
    const root = state.root;
    if (runIndex < root.visible.fromRunIndex) return { kind: "retired", seq: Math.max(1, root.visible.fromSeq - 1) };
    let position: PublishedRunPosition | undefined;
    if (root.last && root.last.runIndex === runIndex) {
      position = root.last;
    } else {
      let lo = root.visible.fromSeq, hi = root.active.seq, owner = -1, ownerFirst = 0;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const first = await this.shardFirstRunIndex(conversationId, state, mid);
        if (first <= runIndex) {
          owner = mid;
          ownerFirst = first;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (owner < 0) return { kind: "missing" };
      const entry = await this.readEntry(conversationId, owner, runIndex - ownerFirst, root);
      if (!isPublishedEntry(entry, root, runIndex)) return { kind: "missing" };
      position = entry;
    }
    const bytes = await readFileRange(this.file(conversationId, shardFileName(position.seq)), position.offset, position.length);
    if (!bytes || bytes.length !== position.length || !sha256(bytes).equals(position.lineSha256)) {
      throw new TranscriptDirectoryDamagedError("Published transcript run bytes do not match their position");
    }
    const record = JSON.parse(bytes.toString("utf-8")) as RunRecord | TranscriptRunRecord;
    if (record.type !== "run" || record.runIndex !== runIndex) {
      throw new TranscriptDirectoryDamagedError("Published transcript run position points to another record");
    }
    return { kind: "located", record, seq: position.seq, source: position.source };
  }

  private async shardFirstRunIndex(conversationId: string, state: OpenState, seq: number): Promise<number> {
    if (seq === state.root.active.seq) return state.root.active.firstRunIndex;
    const header = await this.readPositionHeader(conversationId, seq, state.root);
    if (!header) throw new TranscriptDirectoryDamagedError(`Transcript position header is missing for visible shard ${seqId(seq)}`);
    return header.firstRunIndex;
  }

  private async shardCreatedAtMs(conversationId: string, state: OpenState, seq: number): Promise<number | undefined> {
    if (seq === state.root.active.seq) return state.root.active.createdAtMs;
    return (await this.readPositionHeader(conversationId, seq, state.root))?.createdAtMs;
  }

  private async readPositionHeader(conversationId: string, seq: number, root: DirectoryRoot): Promise<PositionFileHeader | undefined> {
    const buf = await readFileRange(this.file(conversationId, positionFileName(seq)), 0, POSITION_RECORD_BYTES);
    return buf ? decodePositionHeader(buf, root.epoch, seq) : undefined;
  }

  private async readEntry(conversationId: string, seq: number, index: number, root: DirectoryRoot): Promise<PositionEntry | undefined> {
    if (index < 0) return undefined;
    const buf = await readFileRange(this.file(conversationId, positionFileName(seq)), entryOffset(index), POSITION_RECORD_BYTES);
    const entry = buf ? decodePositionEntry(buf, seq) : undefined;
    return entry && entry.epoch.equals(root.epoch) ? entry : undefined;
  }

  // ─── 旧测试格式一次性转换 ───

  /**
   * 早期本地测试资料（v1 index.json）一次性转换：逐片读取（线性一次），写各片位置文件与根，
   * 原件保留。v1 列出、文件却缺失的片若位于现存片之间，失败关闭（不推断、不隐藏）。旧活跃片
   * 尾部有撕裂行时，转换后换到新片再继续追加，原片保持原样。各片的现有长度记为封片长度；
   * 转换来的字节按旧语义容忍坏行，严格区从转换后的第一次写入开始。
   */
  private async convertLegacyInLock(conversationId: string): Promise<OpenState> {
    const dir = this.transcriptDir(conversationId);
    const index = JSON.parse(await fs.readFile(path.join(dir, TRANSCRIPT_INDEX_FILE_NAME), "utf-8")) as TranscriptIndex;
    if (index.version !== 1 || !Array.isArray(index.shards)) {
      throw new TranscriptDirectoryDamagedError("Legacy transcript index has an unknown shape");
    }
    const metas = [...index.shards]
      .map((meta) => ({ meta, seq: Number.parseInt(meta.id, 10) }))
      .filter((item) => Number.isSafeInteger(item.seq) && item.seq > 0)
      .sort((a, b) => a.seq - b.seq);
    const activeSeq = Number.parseInt(index.activeShardId, 10);
    const epoch = randomBytes(16);
    const present: { seq: number; createdAtMs: number; content: Buffer }[] = [];
    const missing: number[] = [];
    for (const { meta, seq } of metas) {
      const content = await readWhole(path.join(dir, shardFileName(seq)));
      if (content) present.push({ seq, createdAtMs: Date.parse(meta.createdAt) || this.now(), content });
      else missing.push(seq);
    }
    if (present.length === 0) {
      const state = await this.initializeInLock(conversationId);
      return state;
    }
    const lowest = present[0]!.seq;
    // 活跃片换片后尚未首次追加时本就不存在，不算缺片
    const interior = missing.filter((seq) => seq > lowest && seq !== activeSeq);
    if (interior.length > 0) {
      throw new TranscriptDirectoryDamagedError(`Legacy transcript is missing shards inside its retained range: ${interior.map(seqId).join(", ")}`);
    }
    let nextRunIndex = 0;
    let last: PublishedRunPosition | undefined;
    let clearGeneration = 0, clearBoundary = 0;
    let lastClearAtMs: number | undefined;
    let fromRunIndex = 0;
    let activeState: {
      seq: number; createdAtMs: number; firstRunIndex: number; size: number; content: Buffer; prevSealedSize?: number;
    } | undefined;
    for (const [i, shard] of present.entries()) {
      const firstRunIndex = firstRunIndexIn(shard.content) ?? nextRunIndex;
      const predecessor = present[i - 1];
      const prevSealedSize = predecessor && predecessor.seq === shard.seq - 1 ? predecessor.content.length : undefined;
      if (shard.seq === lowest) fromRunIndex = firstRunIndex;
      const entries: Buffer[] = [];
      for (const line of linesWithOffsets(shard.content)) {
        let parsed: ShardRecordLine;
        try {
          parsed = JSON.parse(line.text) as ShardRecordLine;
        } catch {
          continue;
        }
        if (parsed.type === "run") {
          const runId = (parsed as Partial<TranscriptRunRecord>).runId;
          const position: PublishedRunPosition = {
            runIndex: parsed.runIndex,
            seq: shard.seq,
            offset: line.offset,
            length: line.length,
            lineSha256: sha256(shard.content.subarray(line.offset, line.offset + line.length)),
            source: {
              kind: "legacy",
              runIdSha256: typeof runId === "string" ? sha256(runId) : ZERO_SHA256,
              assignmentSha256: ZERO_SHA256,
              digestSha256: ZERO_SHA256,
              commitRevision: 0,
            },
          };
          const slot = parsed.runIndex - firstRunIndex;
          entries[slot] = encodePositionEntry({ ...position, epoch, forPub: 1, newShard: false });
          last = position;
          nextRunIndex = parsed.runIndex + 1;
        } else if (parsed.type === "clear") {
          clearGeneration++;
          clearBoundary = nextRunIndex;
          lastClearAtMs = Date.parse(parsed.timestamp);
        }
      }
      const body = Buffer.alloc(POSITION_RECORD_BYTES * (entries.length + 1));
      encodePositionHeader({
        epoch,
        seq: shard.seq,
        firstRunIndex,
        createdAtMs: shard.createdAtMs,
        ...(prevSealedSize !== undefined ? { prevSealedSize } : {}),
      }).copy(body, 0);
      entries.forEach((entry, slot) => entry?.copy(body, entryOffset(slot)));
      await writeAt(path.join(dir, positionFileName(shard.seq)), 0, body, true);
      if (shard.seq === activeSeq) {
        activeState = {
          seq: shard.seq,
          createdAtMs: shard.createdAtMs,
          firstRunIndex,
          size: shard.content.length,
          content: shard.content,
          ...(prevSealedSize !== undefined ? { prevSealedSize } : {}),
        };
      }
    }
    const tornTail = !!activeState && activeState.size > 0 && activeState.content.at(-1) !== 0x0a;
    const newest = present.at(-1)!;
    const nextSeq = activeState ? activeState.seq + 1 : Math.max(activeSeq, newest.seq + 1);
    const active: { seq: number; createdAtMs: number; firstRunIndex: number; size: number; prevSealedSize?: number } =
      activeState && !tornTail
        ? activeState
        : {
          seq: nextSeq,
          createdAtMs: this.now(),
          firstRunIndex: nextRunIndex,
          size: 0,
          ...(nextSeq === newest.seq + 1 ? { prevSealedSize: newest.content.length } : {}),
        };
    const root: DirectoryRoot = {
      epoch,
      pub: 1,
      active: {
        seq: active.seq,
        createdAtMs: active.createdAtMs,
        firstRunIndex: active.firstRunIndex,
        ...(active.prevSealedSize !== undefined ? { prevSealedSize: active.prevSealedSize } : {}),
      },
      tail: { size: active.size, nextRunIndex },
      ...(last ? { last } : {}),
      clear: { generation: clearGeneration, boundaryRunIndex: clearBoundary, ...(lastClearAtMs !== undefined ? { lastClearAtMs } : {}) },
      visible: { fromSeq: lowest, fromRunIndex, deletedBelowSeq: lowest },
      strictFrom: { seq: active.seq, offset: active.size },
    };
    await syncDirectory(dir);
    await this.writeNewRootFile(conversationId, root);
    return { root, half: 0, dirty: false, confirmedPub: root.pub };
  }
}

// ─── 纯辅助 ───

function seqId(seq: number): string {
  return String(seq).padStart(6, "0");
}

function headerLine(conversationId: string, seq: number, createdAtMs: number, firstRunIndex: number): Buffer {
  const header: ShardHeader = {
    type: "header",
    version: SHARD_FORMAT_VERSION,
    conversationId,
    shardId: seqId(seq),
    createdAt: new Date(createdAtMs).toISOString(),
    firstRunIndex,
  };
  return Buffer.from(`${JSON.stringify(header)}\n`, "utf-8");
}

function ownerSourceDigest(runId: string, source: CommittedRunSource | undefined): RunSourceDigest {
  return {
    kind: "owner",
    runIdSha256: sha256(runId),
    assignmentSha256: source ? sha256(source.assignmentId) : ZERO_SHA256,
    digestSha256: source ? sha256(source.digest) : ZERO_SHA256,
    commitRevision: source?.commitRevision ?? 0,
  };
}

/**
 * 一次写入发布后的根：tail 前移到 size；有 run 时水位加一并替换 last；换片时切换 active，
 * 并记下前一片的封片长度。没有严格区起点的根（早期本地测试资料）从这次写入起进入严格区。
 */
function publishedAfter(
  root: DirectoryRoot,
  write: {
    readonly seq: number;
    readonly createdAtMs: number;
    readonly firstRunIndex: number;
    readonly size: number;
    readonly position?: PublishedRunPosition;
    readonly clearAtMs?: number;
  },
): DirectoryRoot {
  const next = write.position ? write.position.runIndex + 1 : root.tail.nextRunIndex;
  const prevSealedSize = write.seq === root.active.seq ? root.active.prevSealedSize : root.tail.size;
  return {
    ...root,
    pub: root.pub + 1,
    active: {
      seq: write.seq,
      createdAtMs: write.createdAtMs,
      firstRunIndex: write.firstRunIndex,
      ...(prevSealedSize !== undefined ? { prevSealedSize } : {}),
    },
    strictFrom: root.strictFrom ?? { seq: root.active.seq, offset: root.tail.size },
    tail: { size: write.size, nextRunIndex: next },
    ...(write.position ? {
      last: {
        runIndex: write.position.runIndex,
        seq: write.position.seq,
        offset: write.position.offset,
        length: write.position.length,
        lineSha256: write.position.lineSha256,
        source: write.position.source,
      },
    } : {}),
    clear: write.clearAtMs === undefined ? root.clear : {
      generation: root.clear.generation + 1,
      boundaryRunIndex: root.tail.nextRunIndex,
      lastClearAtMs: write.clearAtMs,
    },
  };
}

function firstRunIndexIn(content: Buffer): number | undefined {
  for (const line of linesWithOffsets(content)) {
    try {
      const parsed = JSON.parse(line.text) as ShardRecordLine;
      if (parsed.type === "run") return parsed.runIndex;
    } catch {
      // 坏行跳过
    }
  }
  return undefined;
}

/** 按字节偏移切出完整行（含行尾换行的长度）；末尾没有换行的残行不产出 */
function* linesWithOffsets(content: Buffer): Generator<{ offset: number; length: number; text: string }> {
  let start = 0;
  while (start < content.length) {
    const end = content.indexOf(0x0a, start);
    if (end < 0) return;
    if (end > start) yield { offset: start, length: end + 1 - start, text: content.subarray(start, end).toString("utf-8") };
    start = end + 1;
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readWhole(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
