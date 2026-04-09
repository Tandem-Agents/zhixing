/**
 * L2 压缩策略：早期消息丢弃
 *
 * 优先级 P1，零成本 — 不需要 LLM 调用。
 *
 * 策略：
 * - 保留第一条 user 消息（原始意图，不可丢弃）
 * - 保留最近 keepRecentTurns 轮完整对话
 * - 中间的消息全部丢弃
 * - 插入一条占位消息 "[前 X 轮对话已省略]"
 *
 * 对比 Claude Code：它有 microcompact + context collapse 两个层级。
 * 我们用单一策略实现，更简洁。
 * 如果 L1 (ToolResult 截断) 不够，L2 直接丢弃。
 */

import type { Message } from "../../types/messages.js";
import { userMessage as makeUserMessage } from "../../types/messages.js";
import type { CompactionContext, CompactionResult, CompactionStrategy } from "../types.js";

// ─── 配置 ───

export interface MessageDropConfig {
  /**
   * 保留最近多少轮完整对话。
   * 默认 6 — 给 LLM 足够的短期记忆理解当前任务。
   */
  keepRecentTurns: number;
}

const DEFAULT_CONFIG: MessageDropConfig = {
  keepRecentTurns: 6,
};

// ─── 策略实现 ───

export class MessageDropStrategy implements CompactionStrategy {
  readonly name = "message_drop";
  readonly priority = 5;
  readonly requiresLLM = false;
  private config: MessageDropConfig;

  constructor(config: Partial<MessageDropConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  canApply(context: CompactionContext): boolean {
    const { messages } = context;
    // 需要有足够多的消息才值得丢弃
    const keepMessages = this.config.keepRecentTurns * 2 + 1;
    return messages.length > keepMessages + 2;
  }

  async apply(context: CompactionContext): Promise<CompactionResult> {
    const { messages } = context;
    const { keepRecentTurns } = this.config;

    // 从末尾向前，保留 keepRecentTurns 轮的消息
    // 一轮 = assistant + user(tool_result)，从末尾数 assistant 消息
    const keepFromIndex = findKeepBoundary(
      messages,
      keepRecentTurns,
    );

    // 至少保留第一条消息 + 占位 + 最近消息
    if (keepFromIndex <= 1) {
      return {
        messages: messages as Message[],
        tokensBefore: 0,
        tokensAfter: 0,
        compacted: false,
      };
    }

    const droppedTurns = countAssistantMessages(messages, 1, keepFromIndex);
    const firstMessage = messages[0] as Message;
    const recentMessages = messages.slice(keepFromIndex) as Message[];

    const placeholder = makeUserMessage(
      `[前 ${droppedTurns} 轮对话已省略，保留了最近 ${keepRecentTurns} 轮]`,
    );

    const newMessages = [firstMessage, placeholder, ...recentMessages];

    return {
      messages: newMessages,
      tokensBefore: 0,
      tokensAfter: 0,
      compacted: true,
    };
  }
}

/**
 * 从消息末尾向前找，返回需要保留的起始索引。
 * 保留最后 keepTurns 轮的所有消息。
 */
function findKeepBoundary(
  messages: readonly Message[],
  keepTurns: number,
): number {
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      assistantCount++;
      if (assistantCount >= keepTurns) {
        return i;
      }
    }
  }
  // 不够 keepTurns 轮 — 返回 1（跳过第一条消息后开始）
  return 1;
}

function countAssistantMessages(
  messages: readonly Message[],
  from: number,
  to: number,
): number {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (messages[i]!.role === "assistant") count++;
  }
  return count;
}

export function createMessageDropStrategy(
  config?: Partial<MessageDropConfig>,
): MessageDropStrategy {
  return new MessageDropStrategy(config);
}
