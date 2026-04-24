/**
 * L1 压缩策略：ToolResult 截断
 *
 * 优先级最高（P0），零成本 — 不需要 LLM 调用。
 *
 * 原理：旧轮次的 tool_result 内容（文件内容、grep 结果等）通常不再被引用，
 * 但它们消耗大量 token。截断旧 tool_result 可以在不影响对话连贯性的前提下
 * 显著降低 token 占用。
 *
 * 策略：
 * - 从消息末尾向前数，超过 staleTurnThreshold 轮次的 tool_result 被截断
 * - 保留每个 tool_result 的前 keepChars 字符作为摘要提示
 * - 添加 "[已截断，原始 X 字符]" 后缀
 * - 已截断的 tool_result（包含截断标记的）不再重复截断
 *
 * 对比 Claude Code 的 snip：它有一个全局 tool output budget(10K)，
 * 我们的策略更精细 — 按轮次年龄递进截断，近期结果保持完整。
 */

import type { ContentBlock, Message, ToolResultBlock } from "../../types/messages.js";
import { calculateMessageTurns } from "../message-turns.js";
import type { CompactionContext, CompactionResult, CompactionStrategy } from "../types.js";

// ─── 配置 ───

export interface ToolResultTrimConfig {
  /**
   * 距离当前轮超过此值的 tool_result 才被截断。
   * 默认 4 — 保留最近 4 轮完整，旧轮截断。
   */
  staleTurnThreshold: number;

  /**
   * 截断后保留的前缀字符数。
   * 默认 200 — 足以保留文件开头或 grep 匹配的关键上下文。
   */
  keepChars: number;
}

const DEFAULT_CONFIG: ToolResultTrimConfig = {
  staleTurnThreshold: 4,
  keepChars: 200,
};

const TRUNCATION_MARKER = "[已截断，原始 ";
const TRUNCATION_SUFFIX = " 字符]";

// ─── 截断逻辑 ───

function isTruncated(content: string): boolean {
  return content.includes(TRUNCATION_MARKER);
}

function truncateContent(content: string, keepChars: number): string {
  if (content.length <= keepChars) return content;
  if (isTruncated(content)) return content;

  const preview = content.slice(0, keepChars);
  return `${preview}\n${TRUNCATION_MARKER}${content.length}${TRUNCATION_SUFFIX}`;
}

function trimToolResultBlock(
  block: ToolResultBlock,
  keepChars: number,
): ToolResultBlock {
  const trimmedContent = truncateContent(block.content, keepChars);
  if (trimmedContent === block.content) return block;

  return { ...block, content: trimmedContent };
}

/**
 * 对消息中的 tool_result 块进行截断。
 * 返回新消息（如果有变化）或原消息引用（无变化时）。
 */
function trimMessageToolResults(
  message: Message,
  keepChars: number,
): Message {
  let changed = false;
  const newContent: ContentBlock[] = message.content.map((block) => {
    if (block.type !== "tool_result") return block;

    const trimmed = trimToolResultBlock(block, keepChars);
    if (trimmed !== block) changed = true;
    return trimmed;
  });

  return changed ? { ...message, content: newContent } : message;
}

// ─── 策略实现 ───

export class ToolResultTrimStrategy implements CompactionStrategy {
  readonly name = "tool_result_trim";
  readonly priority = 0;
  readonly requiresLLM = false;
  private config: ToolResultTrimConfig;

  constructor(config: Partial<ToolResultTrimConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  canApply(context: CompactionContext): boolean {
    const { messages } = context;
    const turns = calculateMessageTurns(messages);
    const maxTurn = turns[turns.length - 1] ?? 0;
    const staleThreshold = maxTurn - this.config.staleTurnThreshold;

    if (staleThreshold <= 0) return false;

    for (let i = 0; i < messages.length; i++) {
      if (turns[i]! > staleThreshold) continue;
      const msg = messages[i]!;
      for (const block of msg.content) {
        if (
          block.type === "tool_result" &&
          block.content.length > this.config.keepChars &&
          !isTruncated(block.content)
        ) {
          return true;
        }
      }
    }

    return false;
  }

  async apply(context: CompactionContext): Promise<CompactionResult> {
    const { messages } = context;
    const turns = calculateMessageTurns(messages);
    const maxTurn = turns[turns.length - 1] ?? 0;
    const staleThreshold = maxTurn - this.config.staleTurnThreshold;

    const newMessages: Message[] = messages.map((msg, i) => {
      if (turns[i]! > staleThreshold) return msg as Message;
      return trimMessageToolResults(msg as Message, this.config.keepChars);
    });

    const hasChanges = newMessages.some((msg, i) => msg !== messages[i]);

    return {
      messages: newMessages,
      tokensBefore: 0,
      tokensAfter: 0,
      compacted: hasChanges,
    };
  }
}

export function createToolResultTrimStrategy(
  config?: Partial<ToolResultTrimConfig>,
): ToolResultTrimStrategy {
  return new ToolResultTrimStrategy(config);
}
