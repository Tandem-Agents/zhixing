import type { Conversation, RunRecordRef, RunRecordWithRef } from "@zhixing/core";

export interface AdvancementRunsPage {
  readonly runs: readonly RunRecordWithRef[];
  readonly hasMore: boolean;
}

/** 推进恢复只读取盘上会话事实，不拥有目录写入与拓扑装配。 */
export interface AdvancementConversationDirectory {
  list(): Promise<readonly Conversation[]>;
  exists(conversationId: string): Promise<boolean>;
  readRunsReverse(
    conversationId: string,
    options: { readonly limit: number; readonly before?: RunRecordRef },
  ): Promise<AdvancementRunsPage>;
}
