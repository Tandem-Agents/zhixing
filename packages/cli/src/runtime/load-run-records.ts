/**
 * 全量装载一个对话的 run records —— **过渡期桥**，预算化启动装填落地后随
 * restoreAttentionWindowFromRecords 一并删除（届时启动改为"摘要快照 +
 * 预算化倒读"装填，不再全量读取）。
 *
 * 倒读原语天然守清空边界（遇 clear 即止）、跨分片续读；这里收集到头后
 * 反转为时间正序，供窗口重建与 turn 计数消费。
 */

import {
  readRunsReverse,
  type RunRecord,
  type ShardedTranscriptStore,
} from "@zhixing/core";

export async function loadRunRecords(
  store: ShardedTranscriptStore,
  conversationId: string,
): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for await (const { record } of readRunsReverse(store, conversationId)) {
    records.push(record);
  }
  return records.reverse();
}
