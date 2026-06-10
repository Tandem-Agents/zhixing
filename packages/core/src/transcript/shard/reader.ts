/**
 * 倒读原语 —— 持久化的唯一读取入口，服务两类消费者：
 *
 *   - 上下文层启动装填：按 token 预算停（消费方自断）
 *   - 各端 UI 历史渲染：按条数停，下一页以上页最早一条的位置作 `before`
 *     游标续读更早——游标无状态，远端投影与未来检索召回同用此口
 *
 * 清空边界在原语层生效：遇 ClearRecord 即终止，任何消费者都不可能读穿
 * 清空点（"清空"对一切读取生效；其前数据物理仍在，由时间窗清理收走）。
 *
 * 实现按分片整文件读入再反向迭代——单分片字节有界，无需流式。
 */

import type { ShardedTranscriptStore } from "./store.js";
import type { RunRecord, RunRecordRef } from "./types.js";

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
 * 遇 ClearRecord 即终止。索引 / 分片缺失时产出为空（读容错）。
 */
export async function* readRunsReverse(
  store: ShardedTranscriptStore,
  conversationId: string,
  options: ReadRunsReverseOptions = {},
): AsyncGenerator<RunRecordWithRef, void> {
  // 自愈版索引获取：索引缺失 / 损坏时从分片重建（分片文件在，会话就在），
  // 决不因索引层事故让完好的原文对读端失联；对话真不存在时产出为空。
  const index = await store.ensureReadableIndex(conversationId);
  if (!index) return;

  const before = options.before;
  // 游标定位：从游标所在分片开始（跳过其后的分片）；未传游标从最新分片开始
  let startShardPos = index.shards.length - 1;
  if (before) {
    const pos = index.shards.findIndex((s) => s.id === before.shardId);
    if (pos === -1) return; // 游标所指分片已被清理 → 更早内容已不存在
    startShardPos = pos;
  }

  for (let s = startShardPos; s >= 0; s--) {
    const meta = index.shards[s]!;
    const lines = await store.readShardLines(conversationId, meta);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.type === "clear") return; // 清空边界：到此为止
      if (line.type !== "run") continue;
      if (before && meta.id === before.shardId && line.runIndex >= before.runIndex) {
        continue; // 游标分片内跳过游标位置及其后的记录
      }
      yield { record: line, shardId: meta.id };
    }
  }
}

/**
 * 自最近清空事件以来的 run 数 —— 计数也是读路径，同守清空边界
 * （清空后对话列表显示 0 轮）。
 */
export async function countRuns(
  store: ShardedTranscriptStore,
  conversationId: string,
): Promise<number> {
  let count = 0;
  for await (const _ of readRunsReverse(store, conversationId)) {
    count++;
  }
  return count;
}
