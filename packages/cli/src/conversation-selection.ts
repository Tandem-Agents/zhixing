import { parseConversationId } from "@zhixing/core/conversation";

/** 主对话（用户作用域）判定：终端启动选择会话与宿主启动预读共用同一规则。 */
export function isMainConversationId(conversationId: string): boolean {
  return parseConversationId(conversationId).scope.kind === "user";
}
