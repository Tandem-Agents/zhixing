import type { ConversationDirectoryStorage } from "@zhixing/core/conversation/application";
import { projectHistoryTail } from "./conversation-history-projection.js";

/** 排序与归档过滤仍由 storage 决定；展示方按返回顺序逐项读取。 */
export async function listReadOnlyConversations(
  storage: Pick<ConversationDirectoryStorage, "list"> & Partial<Pick<ConversationDirectoryStorage, 'listPage'>>,
  maxConversations: number,
) {
  if (storage.listPage) {
    const records: Array<Awaited<ReturnType<ConversationDirectoryStorage['list']>>[number]> = [];
    let after: import('@zhixing/core/conversation/application').ConversationDirectoryCursor | undefined;
    while (records.length < maxConversations) {
      const page = await storage.listPage({ limit: Math.min(100, maxConversations - records.length), after });
      records.push(...page.records); if (!page.next) break; after = page.next;
    }
    return records;
  }
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
