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
