/**
 * 时间窗保留清理 —— 持久层自带的独立维护能力。
 *
 * 定性：纯物理层清理，只看索引元数据（分片以封笔时刻判窗 + 是否活跃、
 * 快照以自身 createdAt 判窗 + 在用/退役），不碰语义、绝不打开分片正文。
 * 调度器的 system task 只是薄触发壳（到点调用、转执行摘要），全部清理
 * 算法内聚在此——持久层的维护逻辑不泄漏到调度层。
 *
 * 与写入方（owner）的并发契约：
 *   - 索引由 owner 唯一写；本模块对索引**严格只读**、对文件只删——从根上
 *     消除跨进程并发写索引的冲突（清理跑在常驻进程、cli 写在 cli 进程）。
 *     刻意不复用 store 的自愈读路径（ensureReadableIndex 会重建索引 = 写）：
 *     索引读不出就跳过本对话，自愈归 owner。
 *   - 删除后索引里短暂的死记录由读取容错吸收（readShardLines 对缺失文件
 *     视为空分片）；删被占用文件失败（Windows 锁定语义）→ 跳过、下轮再来。
 *   - 幂等：重复执行无新副作用（已删文件 ENOENT 静默跳过）。
 *
 * 分片三条铁律：永不删活跃分片；对话只剩一个分片（必然活跃）即使超期也
 * 不删；真删、不入垃圾桶。
 *
 * 快照单一判据：删 iff 自身 createdAt 超期 && !(最新快照 && 未退役)。
 * 退役 = createdAt 严格早于 lastClearAt（清空使更早快照退出在用），退役只
 * 摘掉"在用豁免"、不提前删——老化一律按快照自身 createdAt 同窗判。
 *
 * 语义边界：保留窗内的归档才是「唯一真相源 + 可检索召回」；真删意味着
 * 放弃窗外数据的真相源地位与召回可能，检索召回的范围 = 保留窗内。
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  TRANSCRIPT_DIR_NAME,
  TRANSCRIPT_INDEX_FILE_NAME,
} from "./shard/store.js";
import { TRANSCRIPT_INDEX_VERSION, type TranscriptIndex } from "./shard/types.js";
import { SNAPSHOTS_DIR_NAME } from "./snapshot/store.js";
import { SNAPSHOT_FILE_VERSION } from "./snapshot/types.js";

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
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convDir = path.join(root, entry.name);
      report.conversationsScanned++;
      try {
        await sweepConversation(convDir, cutoff, report);
      } catch (e) {
        report.warnings.push(`${convDir}: ${errorText(e)}`);
      }
    }
  }
  return report;
}

async function sweepConversation(
  convDir: string,
  cutoff: string,
  report: RetentionSweepReport,
): Promise<void> {
  const index = await readIndexReadonly(convDir, report);
  if (index) {
    await sweepShards(convDir, index, cutoff, report);
  }
  await sweepSnapshots(convDir, index?.lastClearAt, cutoff, report);
}

/**
 * 严格只读的索引读取：缺失（尚无写入 / 非对话目录）静默返 null；存在但
 * 损坏 → warning + null（自愈归 owner 写路径，清理绝不重建索引）。
 */
async function readIndexReadonly(
  convDir: string,
  report: RetentionSweepReport,
): Promise<TranscriptIndex | null> {
  const indexFile = path.join(
    convDir,
    TRANSCRIPT_DIR_NAME,
    TRANSCRIPT_INDEX_FILE_NAME,
  );
  let raw: string;
  try {
    raw = await fs.readFile(indexFile, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as TranscriptIndex;
    if (
      parsed.version === TRANSCRIPT_INDEX_VERSION &&
      Array.isArray(parsed.shards)
    ) {
      return parsed;
    }
    report.warnings.push(`${indexFile}: unrecognized index shape`);
  } catch (e) {
    report.warnings.push(`${indexFile}: ${errorText(e)}`);
  }
  return null;
}

async function sweepShards(
  convDir: string,
  index: TranscriptIndex,
  cutoff: string,
  report: RetentionSweepReport,
): Promise<void> {
  // 铁律：只剩一个分片（必然活跃）即使标记异常 / 超期也不删
  if (index.shards.length <= 1) return;
  // 按序号数值排序找后继——不依赖索引数组顺序（未来 owner 惰性剔除死记录
  // 等操作不该破坏判据），且数值序免疫零填充位宽的字典序边角
  const ordered = [...index.shards].sort(
    (a, b) => Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10),
  );
  for (let i = 0; i < ordered.length; i++) {
    const meta = ordered[i]!;
    if (meta.isActive) continue; // 铁律：永不删活跃分片
    // 片龄 ≠ 数据龄（rollover 按大小触发，一片可能跨数月仍在写）：片内最晚
    // 数据的上界 = 后继片的 createdAt（rollover 登记新片的时刻即本片封笔
    // 时刻，索引里天然记录）。只有封笔时刻也出窗，片内一切数据才真正超期
    // ——保留窗承诺以数据时刻为准，不以文件创建时刻为准。
    const successor = ordered[i + 1];
    if (!successor) continue; // 非活跃片无后继是异常态，保守不删
    if (successor.createdAt >= cutoff) continue; // 封笔仍在窗内 → 保留
    const file = path.join(convDir, TRANSCRIPT_DIR_NAME, meta.file);
    if (await deleteFileIdempotent(file, report)) {
      report.shardsDeleted++;
    }
  }
}

async function sweepSnapshots(
  convDir: string,
  lastClearAt: string | undefined,
  cutoff: string,
  report: RetentionSweepReport,
): Promise<void> {
  const snapDir = path.join(convDir, SNAPSHOTS_DIR_NAME);
  let entries: string[];
  try {
    entries = await fs.readdir(snapDir);
  } catch {
    return; // 无快照目录——从未切过段的对话
  }

  // 先读出全部可判定项（createdAt 可取），再定"最新"——损坏文件不参与
  // 判定也不删（删除判据必须基于 createdAt，读不出就不动它）
  const candidates: { file: string; createdAt: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(snapDir, entry);
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as {
        version?: number;
        createdAt?: unknown;
      };
      if (
        parsed.version === SNAPSHOT_FILE_VERSION &&
        typeof parsed.createdAt === "string"
      ) {
        candidates.push({ file, createdAt: parsed.createdAt });
      }
    } catch {
      // 坏文件不动：无 createdAt 判据，宁留勿删（派生缓存，无害）
    }
  }
  if (candidates.length === 0) return;

  const latestCreatedAt = candidates.reduce(
    (max, c) => (c.createdAt > max ? c.createdAt : max),
    candidates[0]!.createdAt,
  );

  for (const c of candidates) {
    if (c.createdAt >= cutoff) continue; // 窗内保留（退役不提前删）
    const retired =
      lastClearAt !== undefined && c.createdAt < lastClearAt;
    const inUse = c.createdAt === latestCreatedAt && !retired;
    if (inUse) continue; // 在用快照视同活跃，永不删
    if (await deleteFileIdempotent(c.file, report)) {
      report.snapshotsDeleted++;
    }
  }
}

/** 真删单文件：已不存在 → 幂等跳过；占用 / 权限失败 → warning、下轮再来 */
async function deleteFileIdempotent(
  file: string,
  report: RetentionSweepReport,
): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      report.warnings.push(`${file}: ${errorText(e)}`);
    }
    return false;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
