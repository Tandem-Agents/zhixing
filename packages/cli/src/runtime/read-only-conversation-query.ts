import type { ConversationDirectoryStorage } from "@zhixing/core/conversation/application";
import { projectHistoryTail } from "./conversation-history-projection.js";

/** 排序与归档过滤仍由 storage 决定；展示方按返回顺序逐项读取。 */
export async function listReadOnlyConversations(
  storage: Pick<ConversationDirectoryStorage, "list">,
  maxConversations: number,
) {
  return (await storage.list()).slice(0, maxConversations);
}

/** 每个对话独立读取和投影，让后项等待/失败不阻塞前项展示。 */
export async function queryReadOnlyConversationHistory(
  storage: Pick<ConversationDirectoryStorage, "readHistory">,
  conversationId: string,
  maxRuns: number,
) {
  const runs = maxRuns <= 0 ? [] :
    (await storage.readHistory(conversationId, { limit: maxRuns })).runs.map(item => item.record);
  return { history: projectHistoryTail(runs, maxRuns), renderedRuns: runs.length };
}
