/** 现有 Conversation 历史的只读投影；无 ANSI、屏幕或第二套存储。 */
import { extractText, type Message } from "@zhixing/core/types";
import type { RunRecord } from "@zhixing/core/transcript";
import type { ConversationMessageStatus } from "@zhixing/core/conversation/application";
import { formatToolResult } from "../tool-card-format.js";

/** 默认渲染的最近 run 数 —— 尾巴要短：唤起上下文即可，不是回放全史 */
export const DEFAULT_TAIL_RUNS = 3;

export interface HistoryTailEntry {
  /** 用户原文（折叠为单行） */
  userText: string;
  /** 最终回复文本（折叠为单行）；run 无 assistant 文本（中断等）时缺省 */
  assistantText?: string;
  /** 推进侧代理 run——首行不是用户说的话，渲染必须带来源标记。 */
  fromAdvancement?: boolean;
  /** 多视角评议 run——最终回复来自发散收敛流程，启动尾巴需显式标记。 */
  perspectiveCount?: number;
  sourceConversationId?: string;
  inputs?: readonly { text: string; sourceConversationId?: string; status?: string }[];
  sent?: readonly string[];
}

export interface HistoryTail {
  /** 时间正序的尾巴条目；空 = 无历史（新对话 / 刚清空） */
  entries: HistoryTailEntry[];
  /** 最近一条 run 的时刻（ISO）—— 标题相对时间锚的来源 */
  latestAt?: string;
  outsideInputs?: readonly ConversationMessageStatus[];
  outsideInputsTruncated?: boolean;
}

/**
 * 把倒序(新→旧)的 run 记录投影为尾巴(条目时间正序)。
 * 数据来自宿主的 session.history 倒读分页(读通道唯一,清空边界在宿主
 * 倒读原语层生效——/clear 后空页,尾巴自然不渲染)。
 */
export function projectHistoryTail(
  runsNewestFirst: readonly RunRecord[],
  maxRuns: number = DEFAULT_TAIL_RUNS,
): HistoryTail {
  const recent = runsNewestFirst.slice(0, maxRuns);
  if (recent.length === 0) return { entries: [] };
  const latestAt = recent[0]!.timestamp;
  return { entries: [...recent].reverse().map(projectEntry), latestAt };
}

function projectEntry(record: RunRecord): HistoryTailEntry {
  const userText = collapseToLine(extractText(record.messages[0]!));
  const lastAssistant = findLastAssistantText(record.messages);
  const source = record.messages[0]?.inputIdentity?.source;
  const appended = record.messages.slice(1).filter(message => message.inputIdentity);
  const calls = record.messages.flatMap(message => message.content).filter(block => block.type === "tool_use" && block.name === "conversation" && block.input.action === "send");
  const results = record.messages.flatMap(message => message.content).filter(block => block.type === "tool_result");
  return {
    userText,
    ...(source?.kind === "conversation" ? { sourceConversationId: source.conversationId } : {}),
    ...(appended.length ? { inputs: appended.map(message => ({ text: collapseToLine(extractText(message)), ...(message.inputIdentity?.source.kind === "conversation" ? { sourceConversationId: message.inputIdentity.source.conversationId } : {}) })) } : {}),
    ...(calls.length ? { sent: calls.map(call => {
      if (call.type !== "tool_use") throw new Error("Expected communication tool call");
      const result = results.find(block => block.toolUseId === call.id);
      return `→ 对话 ${call.input.conversationId} · ${result ? formatToolResult("conversation", { content: result.content, ...(result.isError ? { isError: true } : {}) }, 0) : "未取得接纳回执"}`;
    }) } : {}),
    ...(lastAssistant !== undefined ? { assistantText: lastAssistant } : {}),
    ...(record.source === "advancement" ? { fromAdvancement: true } : {}),
    ...(record.perspectives?.perspectiveCount
      ? { perspectiveCount: record.perspectives.perspectiveCount }
      : {}),
  };
}

function findLastAssistantText(
  messages: readonly Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const text = collapseToLine(extractText(msg));
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** 多行/多空白折叠为单行 —— 尾巴每条一行，换行语义让位于扫读密度 */
export function collapseToLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
