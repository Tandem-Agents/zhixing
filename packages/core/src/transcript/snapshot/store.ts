/**
 * SnapshotStore —— 派生摘要快照的读写件。
 *
 * 目录形态：`<conversationsDir>/<conversationId>/snapshots/`
 *   <createdAt-ISO-safe>.json    每份快照一个文件：只写新文件、清理只删整文件
 *   index.bin / entries-*.bin    摘要索引（见 snapshot-index.ts）：启动选取只读固定大小的根、
 *                                在定长项上二分、再读命中的一份正文，不列目录
 *
 * 写入方按会话 FIFO 锁串行：先写第 count 项作为登记意图，再经由意图确定的临时落点写快照文件并
 * 改名，最后发布根。任一步失败，本次调用内重读根收束：已发布即已登记，否则删掉残留、清零意图；
 * 删除失败时意图保留，下一次操作先续做。不缓存打开态，每次操作都从盘上读根。
 *
 * 读容错：快照是纯派生缓存，缺失的代价只是启动连贯性降级。启动只经只读选取视图：不持锁、不等
 * 写者、不写盘，索引缺失或损坏、命中正文读不出时按固定次数降级为不带摘要。一次性转换、索引修复
 * 等随历史增长的工作只在维护入口（保留期）里做；维护进行中，登记直接跳过而不排队等待。
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { replaceFile } from "../../persistence/atomic-file.js";
import { ensureDurableDirectory, syncDirectory } from "../../persistence/durable-directory.js";
import { readFileRange, writeAt } from "../../persistence/positional-io.js";
import type { ParsedSummary } from "../../context/segment/types.js";
import { toSafePathSegment } from "../../paths.js";
import {
  ENTRY_BYTES,
  INDEX_FILE_BYTES,
  INDEX_FILE_NAME,
  INDEX_HALF_BYTES,
  SEGMENT_SLOTS,
  decodeIndexEntry,
  encodeIndexEntry,
  encodeIndexHalf,
  isIntentEntry,
  isRegisteredEntry,
  isSegmentFileName,
  offsetInSegment,
  segmentFileName,
  segmentOf,
  selectIndexRoot,
  snapshotFileName,
  snapshotTempFileName,
  type SnapshotIndexEntry,
  type SnapshotIndexRoot,
} from "./snapshot-index.js";
import {
  SNAPSHOT_FILE_VERSION,
  SnapshotAnchorInvariantError,
  SnapshotIndexDamagedError,
  type RetainSnapshotsReport,
  type SegmentSnapshotFile,
  type SnapshotInput,
  type SnapshotSelection,
} from "./types.js";

/** 快照子目录名 —— 物理布局的单一来源（清理路径同源消费） */
export const SNAPSHOTS_DIR_NAME = "snapshots";

export interface SnapshotStoreOptions {
  /** 平台 DI，保留与既有构造参数兼容（改名由 replaceFile 统一处理） */
  readonly platform?: NodeJS.Platform;
  /** 时钟 DI（毫秒），测试锚定快照的 createdAt */
  readonly now?: () => number;
}

/** 只读者遇到根两半都无效（正好被两次连续发布夹住）时的有界重读次数 */
const READ_ATTEMPTS = 3;
/** 命中正文缺失或损坏时，至多尝试的已登记项数（含命中项） */
const SELECT_ATTEMPTS = 3;
/** 保留期每步至多删除的快照文件数 */
const RETENTION_STEP_FILES = 64;

type IndexState =
  | { readonly kind: "absent" }
  /** 没有根、只有快照文件：早期本地测试资料，等维护入口转换 */
  | { readonly kind: "legacy" }
  | { readonly kind: "damaged" }
  | { readonly kind: "ok"; readonly root: SnapshotIndexRoot; readonly half: 0 | 1 };

const EMPTY_SELECTION: SnapshotSelection = Object.freeze({
  hasCandidates: false,
  select: async () => null,
});

export class SnapshotStore {
  private readonly conversationsDir: string;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<void>>();
  /** 已排队或进行中的维护操作数：大于 0 时登记跳过，不排在可能随历史增长的维护之后 */
  private readonly maintaining = new Map<string, number>();

  constructor(conversationsDir: string, options?: SnapshotStoreOptions) {
    this.conversationsDir = conversationsDir;
    this.now = options?.now ?? Date.now;
  }

  private snapshotsDir(conversationId: string): string {
    return path.join(
      this.conversationsDir,
      toSafePathSegment(conversationId),
      SNAPSHOTS_DIR_NAME,
    );
  }

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

  /** 维护入口（启动读取不调用）：早期本地测试资料一次性转换为索引，并收束未完成的登记 */
  async prepare(conversationId: string): Promise<void> {
    await this.maintain(conversationId, async () => {
      await this.prepareInLock(conversationId, "maintain");
    });
  }

  private async maintain<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    this.maintaining.set(conversationId, (this.maintaining.get(conversationId) ?? 0) + 1);
    try {
      return await this.withLock(conversationId, fn);
    } finally {
      const left = (this.maintaining.get(conversationId) ?? 1) - 1;
      if (left > 0) this.maintaining.set(conversationId, left);
      else this.maintaining.delete(conversationId);
    }
  }

  /**
   * 登记一份新快照，createdAt 在写入时定格。已登记集合在 createdAt 与 coverage 两维都严格递增：
   *   - 覆盖边界没有超过已登记的最后一份：锚点不变量异常，抛出 SnapshotAnchorInvariantError；
   *   - 墙钟回拨或同一毫秒（createdAt 不晚于最后一份）：新项被已登记的较新、覆盖更小的那份支配，
   *     且不能覆盖已有正文，不写，返回 undefined。
   * 维护已排队或进行中、或早期本地测试资料尚未由维护转换时，也不写，返回 undefined。
   */
  async write(
    conversationId: string,
    input: SnapshotInput,
  ): Promise<SegmentSnapshotFile | undefined> {
    const coverage = input.coveredThroughRunIndex;
    if (!Number.isSafeInteger(coverage) || coverage < 0) throw new TypeError("Snapshot coverage is invalid");
    if (this.maintaining.has(conversationId)) return undefined;
    return await this.withLock(conversationId, async () => {
      const dir = this.snapshotsDir(conversationId);
      const state = await this.prepareInLock(conversationId, "write");
      if (state.kind === "legacy") return undefined;
      if (state.kind !== "ok") throw new SnapshotIndexDamagedError("Snapshot index is unavailable; repair runs in retention maintenance");
      const root = state.root;
      // 文件仍可能在盘上的最后一项（含已撤可见、尚未删除的）：新名字必须晚于它
      const last = root.count > root.deletedBelowSlot ? await this.mustRead(dir, root, root.count - 1) : undefined;
      const createdAtMs = this.now();
      if (last) {
        if (coverage <= last.coverage) {
          throw new SnapshotAnchorInvariantError(
            `Snapshot coverage ${coverage} does not advance beyond the registered coverage ${last.coverage}`,
          );
        }
        if (createdAtMs <= last.createdAtMs) return undefined;
      }
      const snapshot: SegmentSnapshotFile = {
        version: SNAPSHOT_FILE_VERSION,
        conversationId,
        createdAt: new Date(createdAtMs).toISOString(),
        coveredThroughRunIndex: coverage,
        structuredSummary: input.structuredSummary,
        tokensBefore: input.tokensBefore,
        tokensAfter: input.tokensAfter,
      };
      const slot = root.count;
      try {
        await this.writeEntry(dir, slot, encodeIndexEntry({ epoch: root.epoch, slot, forPub: root.pub + 1, createdAtMs, coverage }));
        const temp = path.join(dir, snapshotTempFileName(createdAtMs));
        await writeAt(temp, 0, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf-8"), true);
        await replaceFile(temp, path.join(dir, snapshotFileName(createdAtMs)));
        await syncDirectory(dir);
        await this.publish(dir, state, { ...root, pub: root.pub + 1, count: slot + 1 });
        return snapshot;
      } catch (error) {
        const after = await this.readIndex(dir);
        if (after.kind === "ok" && after.root.count > slot) return snapshot;
        if (after.kind === "ok") await this.recoverInLock(dir, after);
        throw error;
      }
    });
  }

  /**
   * 一次只读选取（不持锁、不写盘）：以同一次取到的根为边界。索引缺失或损坏时没有候选，
   * 读取出错一律降级为不带摘要。
   */
  async openSelection(conversationId: string): Promise<SnapshotSelection> {
    const dir = this.snapshotsDir(conversationId);
    let state: IndexState = { kind: "damaged" };
    try {
      for (let attempt = 0; attempt < READ_ATTEMPTS && state.kind === "damaged"; attempt++) {
        if (attempt > 0) await new Promise<void>((resolve) => setImmediate(resolve));
        state = await this.readIndex(dir);
      }
    } catch {
      return EMPTY_SELECTION;
    }
    if (state.kind !== "ok") return EMPTY_SELECTION;
    const root = state.root;
    return {
      hasCandidates: root.count > root.fromSlot,
      select: async (earliestLoadedRunIndex, lastClearAt) => {
        try {
          return await this.selectIn(conversationId, dir, root, earliestLoadedRunIndex, lastClearAt);
        } catch {
          return null;
        }
      },
    };
  }

  /** 列出可见的已登记快照，按 createdAt 降序：诊断与测试用，读量随快照数增长，不在启动路径上 */
  async list(conversationId: string): Promise<SegmentSnapshotFile[]> {
    const dir = this.snapshotsDir(conversationId);
    const state = await this.readIndex(dir);
    if (state.kind !== "ok") return [];
    const snapshots: SegmentSnapshotFile[] = [];
    for (let slot = state.root.fromSlot; slot < state.root.count; slot++) {
      const entry = await this.readRegistered(dir, state.root, slot);
      const snapshot = entry ? await this.readSnapshotFile(dir, conversationId, entry) : undefined;
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots.reverse();
  }

  /**
   * 保留期一步：判据与早期实现相同——createdAt < cutoff 的删除，最新且未被清空退役的一份永远保留。
   * 已登记集合按 createdAt 递增，要删的恰好是前缀：先发布撤可见，再按续做位置删除文件，最后整段
   * 回收定长项；每步有界，遇占用停下、下次续做。索引损坏时在这里修复。
   */
  async retainSnapshots(conversationId: string, cutoff: string, lastClearAt: string | undefined): Promise<RetainSnapshotsReport> {
    const report: RetainSnapshotsReport = { deleted: 0, warnings: [] };
    await this.maintain(conversationId, async () => {
      const dir = this.snapshotsDir(conversationId);
      let state = await this.prepareInLock(conversationId, "maintain");
      if (state.kind === "absent" || state.kind === "legacy") return;
      if (state.kind === "ok" && !(await this.lastReadable(dir, state.root))) state = { kind: "damaged" };
      if (state.kind === "damaged") {
        report.warnings.push(`${dir}: snapshot index is damaged; rebuilt from snapshot files`);
        state = await this.repairInLock(conversationId, dir);
      }
      if (state.kind !== "ok") return;
      try {
        await this.retainInLock(dir, state, Date.parse(cutoff), lastClearAt === undefined ? undefined : Date.parse(lastClearAt), report);
      } catch (error) {
        if (!(error instanceof SnapshotIndexDamagedError)) throw error;
        report.warnings.push(`${dir}: ${error.message}; rebuilt from snapshot files`);
        await this.repairInLock(conversationId, dir);
      }
    });
    return report;
  }

  // ─── 打开与恢复 ───

  private async readIndex(dir: string): Promise<IndexState> {
    const file = await readFileRange(path.join(dir, INDEX_FILE_NAME), 0, INDEX_FILE_BYTES);
    if (!file) return { kind: "absent" };
    const current = selectIndexRoot(file);
    return current ? { kind: "ok", root: current.root, half: current.half } : { kind: "damaged" };
  }

  /**
   * 写者打开：有根时收束未完成的登记（有界：只看第 count 项）。没有根时区分三种情况——目录里有
   * 索引分段却没有根，是当前索引丢失（返回损坏，交保留期修复）；只有快照文件，是早期本地测试资料
   * （只在维护模式下一次性转换，登记模式返回 legacy）；什么都没有，是还没写过快照的会话（登记
   * 模式新建空索引）。
   */
  private async prepareInLock(conversationId: string, mode: "write" | "maintain"): Promise<IndexState> {
    const dir = this.snapshotsDir(conversationId);
    const state = await this.readIndex(dir);
    if (state.kind === "ok") {
      await this.recoverInLock(dir, state);
      return state;
    }
    if (state.kind === "damaged") return state;
    const names = await listDirectory(dir);
    if (names.some(isSegmentFileName)) return { kind: "damaged" };
    const legacy = names.filter((name) => name.endsWith(".json"));
    if (legacy.length > 0) return mode === "maintain" ? await this.convertInLock(conversationId, dir, legacy) : { kind: "legacy" };
    if (mode === "maintain") return state;
    await ensureDurableDirectory(dir);
    return await this.writeNewIndex(dir, emptyRoot());
  }

  /** 第 count 项是有效登记意图：删掉它的临时落点与目标文件，再清零意图（删除失败时意图保留） */
  private async recoverInLock(dir: string, state: Extract<IndexState, { kind: "ok" }>): Promise<void> {
    const root = state.root;
    const entry = await this.readEntryAt(dir, root, root.count);
    if (!isIntentEntry(entry, root)) return;
    await unlinkIfPresent(path.join(dir, snapshotTempFileName(entry.createdAtMs)));
    await unlinkIfPresent(path.join(dir, snapshotFileName(entry.createdAtMs)));
    await syncDirectory(dir);
    await this.writeEntry(dir, root.count, Buffer.alloc(ENTRY_BYTES));
  }

  /** 写非当前的那一半并 fsync：提交点。返回发布后的状态 */
  private async publish(
    dir: string,
    state: Extract<IndexState, { kind: "ok" }>,
    next: SnapshotIndexRoot,
  ): Promise<Extract<IndexState, { kind: "ok" }>> {
    const target = state.half === 0 ? 1 : 0;
    await writeAt(path.join(dir, INDEX_FILE_NAME), target * INDEX_HALF_BYTES, encodeIndexHalf(next), false);
    return { kind: "ok", root: next, half: target };
  }

  /** 新建整份根（临时文件改名）：根要么完整存在、要么不存在 */
  private async writeNewIndex(dir: string, root: SnapshotIndexRoot): Promise<Extract<IndexState, { kind: "ok" }>> {
    const buf = Buffer.alloc(INDEX_FILE_BYTES);
    encodeIndexHalf(root).copy(buf, 0);
    const target = path.join(dir, INDEX_FILE_NAME);
    const temp = `${target}.init`;
    await writeAt(temp, 0, buf, true);
    await replaceFile(temp, target);
    await syncDirectory(dir);
    return { kind: "ok", root, half: 0 };
  }

  // ─── 定长项 ───

  /** 段内首项新建段文件（此前该段没有已登记项）；其余项原位写入 */
  private async writeEntry(dir: string, slot: number, bytes: Buffer): Promise<void> {
    const create = slot % SEGMENT_SLOTS === 0;
    await writeAt(path.join(dir, segmentFileName(segmentOf(slot))), offsetInSegment(slot), bytes, create);
    if (create) await syncDirectory(dir);
  }

  private async readEntryAt(dir: string, root: SnapshotIndexRoot, slot: number): Promise<SnapshotIndexEntry | undefined> {
    const buf = await readFileRange(path.join(dir, segmentFileName(segmentOf(slot))), offsetInSegment(slot), ENTRY_BYTES);
    return buf ? decodeIndexEntry(buf, root.epoch, slot) : undefined;
  }

  private async readRegistered(dir: string, root: SnapshotIndexRoot, slot: number): Promise<SnapshotIndexEntry | undefined> {
    const entry = await this.readEntryAt(dir, root, slot);
    return isRegisteredEntry(entry, root) ? entry : undefined;
  }

  private async mustRead(dir: string, root: SnapshotIndexRoot, slot: number): Promise<SnapshotIndexEntry> {
    const entry = await this.readRegistered(dir, root, slot);
    if (!entry) throw new SnapshotIndexDamagedError(`Registered snapshot entry ${slot} is unreadable`);
    return entry;
  }

  private async lastReadable(dir: string, root: SnapshotIndexRoot): Promise<boolean> {
    return root.count <= root.deletedBelowSlot || !!(await this.readRegistered(dir, root, root.count - 1));
  }

  // ─── 选取 ───

  private async selectIn(
    conversationId: string,
    dir: string,
    root: SnapshotIndexRoot,
    earliestLoadedRunIndex: number,
    lastClearAt: string | undefined,
  ): Promise<SegmentSnapshotFile | null> {
    let lo = root.fromSlot, hi = root.count - 1;
    let found: SnapshotIndexEntry | undefined;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const entry = await this.readRegistered(dir, root, mid);
      if (!entry) return null;
      if (entry.coverage < earliestLoadedRunIndex) {
        found = entry;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const clearMs = lastClearAt === undefined ? undefined : Date.parse(lastClearAt);
    let entry = found;
    for (let attempt = 0; entry && attempt < SELECT_ATTEMPTS; attempt++) {
      // createdAt 随 slot 递增：这一项已退役，更早的也都退役
      if (clearMs !== undefined && entry.createdAtMs <= clearMs) return null;
      const snapshot = await this.readSnapshotFile(dir, conversationId, entry);
      if (snapshot) return snapshot;
      entry = entry.slot > root.fromSlot ? await this.readRegistered(dir, root, entry.slot - 1) : undefined;
    }
    return null;
  }

  /** 读命中的正文并核对它与登记项一致；缺失、损坏或不一致返回 undefined */
  private async readSnapshotFile(
    dir: string,
    conversationId: string,
    entry: SnapshotIndexEntry,
  ): Promise<SegmentSnapshotFile | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, snapshotFileName(entry.createdAtMs)), "utf-8")) as SegmentSnapshotFile;
      return parsed.version === SNAPSHOT_FILE_VERSION &&
        parsed.conversationId === conversationId &&
        parsed.createdAt === new Date(entry.createdAtMs).toISOString() &&
        parsed.coveredThroughRunIndex === entry.coverage &&
        isRenderableSummary(parsed.structuredSummary)
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }

  // ─── 保留期 ───

  private async retainInLock(
    dir: string,
    initial: Extract<IndexState, { kind: "ok" }>,
    cutoffMs: number,
    clearMs: number | undefined,
    report: RetainSnapshotsReport,
  ): Promise<void> {
    let state = initial;
    let root = state.root;
    // 1. 撤可见：createdAt < cutoff 的前缀；最新且未被清空退役的一份永远保留
    let lo = root.fromSlot, hi = root.count;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await this.mustRead(dir, root, mid)).createdAtMs < cutoffMs) lo = mid + 1;
      else hi = mid;
    }
    let from = lo;
    if (from === root.count && root.count > root.fromSlot) {
      const latest = await this.mustRead(dir, root, root.count - 1);
      const retired = clearMs !== undefined && latest.createdAtMs < clearMs;
      if (!retired) from = root.count - 1;
    }
    if (from > root.fromSlot) {
      state = await this.publish(dir, state, { ...root, pub: root.pub + 1, fromSlot: from });
      root = state.root;
    }
    // 2. 物理删除撤可见区间的快照文件，从续做位置开始
    let deleted = root.deletedBelowSlot;
    const end = Math.min(root.fromSlot, deleted + RETENTION_STEP_FILES);
    while (deleted < end) {
      const entry = await this.mustRead(dir, root, deleted);
      try {
        if (await unlinkIfPresent(path.join(dir, snapshotFileName(entry.createdAtMs)))) report.deleted++;
      } catch (error) {
        report.warnings.push(`${path.join(dir, snapshotFileName(entry.createdAtMs))}: ${errorText(error)}`);
        break;
      }
      deleted++;
    }
    if (deleted > root.deletedBelowSlot) {
      await syncDirectory(dir);
      state = await this.publish(dir, state, { ...root, pub: root.pub + 1, deletedBelowSlot: deleted });
      root = state.root;
    }
    // 3. 整段回收：段内全部项的文件都已删除
    let floor = root.segmentFloor;
    const segmentEnd = Math.floor(root.deletedBelowSlot / SEGMENT_SLOTS);
    while (floor < segmentEnd) {
      try {
        await unlinkIfPresent(path.join(dir, segmentFileName(floor)));
      } catch (error) {
        report.warnings.push(`${path.join(dir, segmentFileName(floor))}: ${errorText(error)}`);
        break;
      }
      floor++;
    }
    if (floor > root.segmentFloor) {
      await syncDirectory(dir);
      await this.publish(dir, state, { ...root, pub: root.pub + 1, segmentFloor: floor });
    }
  }

  // ─── 转换与修复 ───

  /**
   * 由快照文件建立索引（早期本地测试资料的一次性转换，也是索引损坏后的修复）：读一次全部文件，
   * 核对字段与会话身份，按 createdAt 排序后用单调栈求支配链——较新且覆盖不大于旧项的一份支配旧项，
   * 被支配的此后不可能被选中。链上两维严格递增；不在链上的文件原样保留。
   */
  private async convertInLock(
    conversationId: string,
    dir: string,
    names: readonly string[],
  ): Promise<Extract<IndexState, { kind: "ok" }>> {
    const candidates: { createdAtMs: number; coverage: number }[] = [];
    for (const name of names) {
      let parsed: Partial<SegmentSnapshotFile>;
      try {
        parsed = JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")) as Partial<SegmentSnapshotFile>;
      } catch {
        continue;
      }
      const createdAtMs = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : Number.NaN;
      if (
        parsed.version !== SNAPSHOT_FILE_VERSION ||
        parsed.conversationId !== conversationId ||
        !Number.isSafeInteger(createdAtMs) || createdAtMs < 0 ||
        new Date(createdAtMs).toISOString() !== parsed.createdAt ||
        snapshotFileName(createdAtMs) !== name ||
        !Number.isSafeInteger(parsed.coveredThroughRunIndex) || parsed.coveredThroughRunIndex! < 0 ||
        !isRenderableSummary(parsed.structuredSummary)
      ) {
        continue;
      }
      candidates.push({ createdAtMs, coverage: parsed.coveredThroughRunIndex! });
    }
    candidates.sort((a, b) => a.createdAtMs - b.createdAtMs);
    const chain: typeof candidates = [];
    for (const candidate of candidates) {
      while (chain.length > 0 && chain.at(-1)!.coverage >= candidate.coverage) chain.pop();
      chain.push(candidate);
    }
    const epoch = randomBytes(16);
    await ensureDurableDirectory(dir);
    for (let segment = 0; segment * SEGMENT_SLOTS < chain.length; segment++) {
      const part = chain.slice(segment * SEGMENT_SLOTS, (segment + 1) * SEGMENT_SLOTS);
      const buf = Buffer.alloc(part.length * ENTRY_BYTES);
      part.forEach((item, i) => {
        encodeIndexEntry({ epoch, slot: segment * SEGMENT_SLOTS + i, forPub: 1, ...item }).copy(buf, i * ENTRY_BYTES);
      });
      await writeAt(path.join(dir, segmentFileName(segment)), 0, buf, true);
    }
    await syncDirectory(dir);
    return await this.writeNewIndex(dir, { ...emptyRoot(), epoch, count: chain.length });
  }

  /** 修复（只在保留期维护中）：删掉现有索引文件与登记残留，再由快照文件重建 */
  private async repairInLock(conversationId: string, dir: string): Promise<IndexState> {
    const names = await listDirectory(dir);
    for (const name of names) {
      if (name === INDEX_FILE_NAME || name === `${INDEX_FILE_NAME}.init` || isSegmentFileName(name) || name.endsWith(".json.tmp")) {
        await unlinkIfPresent(path.join(dir, name));
      }
    }
    await syncDirectory(dir);
    return await this.convertInLock(conversationId, dir, names.filter((name) => name.endsWith(".json")));
  }
}

// ─── 纯辅助 ───

/** 启动装填渲染消费的正文结构：对象，facts / state / active 都是字符串。命中与转换共用 */
function isRenderableSummary(value: unknown): value is ParsedSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return typeof summary.facts === "string" && typeof summary.state === "string" && typeof summary.active === "string";
}

function emptyRoot(): SnapshotIndexRoot {
  return { epoch: randomBytes(16), pub: 1, count: 0, fromSlot: 0, deletedBelowSlot: 0, segmentFloor: 0 };
}

async function listDirectory(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** 删除文件；返回删除前是否存在 */
async function unlinkIfPresent(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
