/**
 * 倒读原语 —— 持久化的唯一读取入口，服务两类消费者：
 *
 *   - 上下文层启动装填：按 token 预算停（消费方自断）
 *   - 各端 UI 历史渲染：按条数停，下一页以上页最早一条的位置作 `before`
 *     游标续读更早——游标无状态，远端投影与未来检索召回同用此口
 *
 * 清空边界在原语层生效：遇 ClearRecord 即终止，runIndex 早于视图里的 clear 边界的 run 也不产出，
 * 所以清空之前取得的旧游标同样读不穿清空点（"清空"对一切读取生效；其前数据物理仍在，
 * 由时间窗清理收走）。
 *
 * 一次读取先取视图，只读已发布范围：从视图的活跃片（读到 tailSize 为止）按序号往回走，
 * 不小于可见下界 fromSeq 的片才读；前驱 = seq − 1，不列目录。
 */

import path from "node:path";
import { toSafePathSegment } from "../../paths.js";
import { readDirectoryView, readShardLinesAt } from "./directory-view.js";
import {
  TranscriptDirectoryDamagedError,
  type RunRecord,
  type RunRecordRef,
  type ShardRecordLine,
  type TranscriptShardRef,
  type TranscriptView,
} from "./types.js";

export interface TranscriptReadSource {
  readView(conversationId: string): Promise<TranscriptView | null>;
  /** 文件不存在返回 null */
  readShardLines(conversationId: string, ref: TranscriptShardRef): Promise<ShardRecordLine[] | null>;
}

export interface ReadRunsReverseOptions {
  /** 无状态分页游标：从该位置**之前**继续产出（不含该位置自身） */
  readonly before?: RunRecordRef;
}

export interface RunRecordWithRef {
  readonly record: RunRecord;
  readonly shardId: string;
}

/**
 * 从活跃分片尾部（或 before 游标处）向前逐条产出 run record，跨分片续读，
 * 遇 ClearRecord 即终止。对话不存在时产出为空。
 */
export async function* readRunsReverse(
  store: TranscriptReadSource,
  conversationId: string,
  options: ReadRunsReverseOptions = {},
): AsyncGenerator<RunRecordWithRef, void> {
  const view = await store.readView(conversationId);
  if (!view) return;

  const before = options.before;
  let seq = view.activeSeq;
  if (before) {
    const cursorSeq = Number.parseInt(before.shardId, 10);
    if (!Number.isSafeInteger(cursorSeq) || cursorSeq > view.activeSeq) return;
    if (cursorSeq < view.fromSeq) return; // 游标所指分片已撤可见 → 更早内容已不存在
    seq = cursorSeq;
  }

  const boundary = view.clearBoundaryRunIndex;
  for (; seq >= view.fromSeq; seq--) {
    const shardId = String(seq).padStart(6, "0");
    const lines = await store.readShardLines(conversationId, { seq, view });
    if (lines === null) {
      // 撤可见与物理删除之间的视图过期：新视图已不含该片即到此为止，否则是损坏
      const fresh = await store.readView(conversationId);
      if (fresh && seq < fresh.fromSeq) return;
      if (seq === view.activeSeq && view.tailSize === 0) continue;
      throw new TranscriptDirectoryDamagedError(`Visible transcript shard ${shardId} is missing`);
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.type === "clear") return; // 清空边界：到此为止
      if (line.type !== "run") continue;
      if (boundary !== undefined && line.runIndex < boundary) return; // 清空边界之前：游标早于清空时也到此为止
      if (before && shardId === before.shardId && line.runIndex >= before.runIndex) {
        continue; // 游标分片内跳过游标位置及其后的记录
      }
      yield { record: line, shardId };
    }
  }
}

/**
 * 自最近清空事件以来的 run 数 —— 计数也是读路径，同守清空边界
 * （清空后对话列表显示 0 轮）。视图带已发布水位时 O(1)，否则逐条计数。
 */
export async function countRuns(
  store: TranscriptReadSource,
  conversationId: string,
): Promise<number> {
  const view = await store.readView(conversationId);
  if (!view) return 0;
  const counted = countRunsInView(view);
  if (counted !== undefined) return counted;
  let count = 0;
  for await (const _ of readRunsReverse(store, conversationId)) count++;
  return count;
}

/**
 * 由一次取到的视图直接算出自最近清空以来的可见 run 数：已发布水位减去 clear 边界与可见下界中
 * 较大的那个。旧测试格式的只读派生视图没有水位，返回 undefined。
 */
export function countRunsInView(view: TranscriptView): number | undefined {
  if (view.nextRunIndex === undefined || view.clearBoundaryRunIndex === undefined) return undefined;
  return Math.max(0, view.nextRunIndex - Math.max(view.clearBoundaryRunIndex, view.fromRunIndex));
}

/**
 * 构造只读 transcript 源，供宿主不可用的降级读面使用：只读不写，不构造 Store 实例。
 */
export function createReadOnlyTranscriptSource(conversationsDir: string): TranscriptReadSource {
  const transcriptDir = (conversationId: string) =>
    path.join(conversationsDir, toSafePathSegment(conversationId), "transcript");
  return {
    readView: (conversationId) => readDirectoryView(transcriptDir(conversationId)),
    readShardLines: (conversationId, ref) => readShardLinesAt(transcriptDir(conversationId), ref),
  };
}
