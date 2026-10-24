/**
 * 时间窗保留清理 —— 持久层自带的独立维护能力。
 *
 * 定性：纯物理层清理，不碰语义、绝不打开分片正文。调度器的 system task 只是
 * 薄触发壳（到点调用、转执行摘要），全部清理算法内聚在持久层。
 *
 * 分片：经该 scope 的唯一写者 store 实例执行（与追加共用同一把锁）。按序号从旧到新
 * 判定“序号相邻后继的创建时刻 < cutoff”（封笔时刻也出窗，片内数据才真正超期），
 * 遇到第一个不满足的就停；先发布根撤可见，再物理删除，遇占用停下、下轮续做。
 * 永不删活跃分片；只剩一个分片时不删。
 *
 * 快照：经该 scope 的唯一写者 SnapshotStore 实例执行，lastClearAt 取自转录的只读视图。
 * 判据：删 iff 自身 createdAt 超期 && !(最新快照 && 未退役)。退役 = createdAt 严格早于
 * lastClearAt（清空使更早快照退出在用），退役只摘掉"在用豁免"、不提前删——老化一律按快照
 * 自身 createdAt 同窗判。已登记快照按 createdAt 递增，要删的是前缀：先撤可见，再删除、可续做。
 *
 * 语义边界：保留窗内的归档才是「唯一真相源 + 可检索召回」；真删意味着
 * 放弃窗外数据的真相源地位与召回可能，检索召回的范围 = 保留窗内。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fromSafePathSegment } from "../paths.js";
import { readDirectoryView } from "./shard/directory-view.js";
import { ShardedTranscriptStore, TRANSCRIPT_DIR_NAME } from "./shard/store.js";
import { SnapshotStore } from "./snapshot/store.js";

/** 默认保留窗（天）—— 窗内数据是唯一真相源，窗外由本清理收走 */
export const DEFAULT_RETENTION_DAYS = 27;

export interface RetentionSweepOptions {
  /**
   * 对话根目录集合（每根下一级子目录 = 一个对话）。scope 拓扑（用户域 /
   * 各工作场景域）是调用方的知识——持久层只清理给定的根，不懂域结构。
   */
  readonly roots: readonly string[];
  /** 保留窗天数，默认 27 */
  readonly retentionDays?: number;
  /** 时钟注入（测试锚定），默认当前时刻 */
  readonly now?: Date;
  /**
   * 每个根对应的唯一写者 store 实例。生产必须传入，使清理与追加共用同一把锁；
   * 缺省时为该根新建实例（仅测试）。
   */
  readonly transcriptStoreFor?: (root: string) => ShardedTranscriptStore;
  /** 每个根对应的唯一写者快照 store 实例，与快照登记共用同一把锁；缺省时为该根新建实例（仅测试） */
  readonly snapshotStoreFor?: (root: string) => SnapshotStore;
}

export interface RetentionSweepReport {
  /** 实际扫描的对话目录数（含无 transcript 的目录） */
  conversationsScanned: number;
  shardsDeleted: number;
  snapshotsDeleted: number;
  /** 单点异常聚合（损坏索引 / 删除失败等）—— 不拖垮整轮，供运维观测 */
  warnings: string[];
}

/**
 * 执行一轮保留清理。对每个根下的每个对话：删超期非活跃分片（守三铁律）、
 * 删超期且不在用的快照。单对话失败仅记 warning 跳过，不影响其余对话。
 */
export async function runRetentionSweep(
  options: RetentionSweepOptions,
): Promise<RetentionSweepReport> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  // ISO 字符串同构同序：createdAt < cutoff 即超期，无需逐条解析 Date
  const cutoff = new Date(
    now.getTime() - retentionDays * 86_400_000,
  ).toISOString();

  const report: RetentionSweepReport = {
    conversationsScanned: 0,
    shardsDeleted: 0,
    snapshotsDeleted: 0,
    warnings: [],
  };

  for (const root of options.roots) {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue; // 根不存在（如尚无任何工作场景）——合法空域
    }
    const store = options.transcriptStoreFor?.(root) ?? new ShardedTranscriptStore(root);
    const snapshots = options.snapshotStoreFor?.(root) ?? new SnapshotStore(root);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convDir = path.join(root, entry.name);
      report.conversationsScanned++;
      try {
        await sweepConversation(store, snapshots, convDir, fromSafePathSegment(entry.name), cutoff, report);
      } catch (e) {
        report.warnings.push(`${convDir}: ${errorText(e)}`);
      }
    }
  }
  return report;
}

async function sweepConversation(
  store: ShardedTranscriptStore,
  snapshots: SnapshotStore,
  convDir: string,
  conversationId: string,
  cutoff: string,
  report: RetentionSweepReport,
): Promise<void> {
  const transcriptDir = path.join(convDir, TRANSCRIPT_DIR_NAME);
  const view = await readDirectoryView(transcriptDir);
  if (view) {
    const shards = await store.retainShards(conversationId, cutoff);
    report.shardsDeleted += shards.deleted;
    for (const warning of shards.warnings) report.warnings.push(`${convDir}: ${warning}`);
  }
  const retained = await snapshots.retainSnapshots(conversationId, cutoff, view?.lastClearAt);
  report.snapshotsDeleted += retained.deleted;
  for (const warning of retained.warnings) report.warnings.push(`${convDir}: ${warning}`);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
