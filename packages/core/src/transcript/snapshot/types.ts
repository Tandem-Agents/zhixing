/**
 * 派生摘要快照 —— 启动装填的摘要来源。
 *
 * 分层定位：快照是**纯派生缓存**——窗口折叠时由 owner 顺手落盘的结构化
 * 摘要副本，永不参与窗口或 transcript 的权威重建；全部删除系统照常运行
 * （仅启动连贯性降级为纯倒读）。每快照一个独立文件：owner 只写新文件、
 * 清理只删整文件，两端无共享可变写。
 */

import type { ParsedSummary } from "../../context/segment/types.js";

export interface SegmentSnapshotFile {
  version: 1;
  conversationId: string;
  /** 写入时刻 —— 老化 / 退役判据（清理按它判窗，不依赖文件系统时间戳） */
  createdAt: string;
  /**
   * 摘要覆盖的最后一个完整 run —— 启动装填的防重叠锚点：装填只取
   * 严格早于已装原文起点的快照，重叠宁缺毋滥。
   */
  coveredThroughRunIndex: number;
  /** 结构化三段摘要（facts / state / active）原样落盘 */
  structuredSummary: ParsedSummary;
  tokensBefore: number;
  tokensAfter: number;
}

/** 写入入参 —— version / conversationId / createdAt 由 store 写时定格 */
export interface SnapshotInput {
  readonly coveredThroughRunIndex: number;
  readonly structuredSummary: ParsedSummary;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export const SNAPSHOT_FILE_VERSION = 1;

/** 一次只读选取：以同一次取到的索引根为边界 */
export interface SnapshotSelection {
  /** 有已登记的可见快照（决定启动装填是否预留摘要额度）；登记存在不保证此刻正文一定可读 */
  readonly hasCandidates: boolean;
  /**
   * coverage < earliestLoadedRunIndex 中 createdAt 最大、且晚于 lastClearAt 的那一份。
   * 命中正文缺失或损坏时，按固定次数向更早的已登记项降级；仍不可用返回 null。
   */
  select(earliestLoadedRunIndex: number, lastClearAt: string | undefined): Promise<SegmentSnapshotFile | null>;
}

/** 保留期一步的结果 */
export interface RetainSnapshotsReport {
  deleted: number;
  warnings: string[];
}

/**
 * 新快照的覆盖边界没有超过已登记的最后一份，而它的 createdAt 更晚：正常写入路径上覆盖边界随
 * 创建顺序严格递增，出现这种形态说明折叠锚点不可信，不能当作普通的跳过。
 */
export class SnapshotAnchorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotAnchorInvariantError";
  }
}

/** 摘要索引不可用（根两半都无效、已登记项损坏、有索引分段却没有根）：写入方不写，修复由保留期维护完成 */
export class SnapshotIndexDamagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotIndexDamagedError";
  }
}
