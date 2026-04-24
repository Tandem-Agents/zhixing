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
import {
  calculateMessageTurns,
  splitMessagesPairAware,
} from "../message-turns.js";
import { buildDroppedTurnsMessage } from "../system-meta.js";
import type { CompactionContext, CompactionResult, CompactionStrategy } from "../types.js";

// ─── 配置 ───

export interface MessageDropConfig {
  /**
   * 保留最近多少轮完整对话。
   * 默认 6 — 给 LLM 足够的短期记忆理解当前任务。
   */
  keepRecentTurns: number;
  /**
   * 预算 usage 超过此比例时停止应用（让给 LLMSummarize）。默认 0.9。
   *
   * 设计目的：
   *   L2 (MessageDrop) 是"免费粗暴截断"，会物理丢失语义信息；
   *   L3 (LLMSummarize) 是"昂贵但保留语义"的 summary。
   *   预算越接近上限越需要 summary 保留核心信息，因此到 9x% 时应该让 L3 接手。
   *
   * 此值应与 `LLMSummarizeConfig.triggerRatio` 对齐（默认双方都是 0.9）
   * 形成互斥分区 —— MessageDrop 占 (compact 阈值, 0.9)，LLMSummarize 占 [0.9, ∞)。
   */
  budgetCeilingRatio: number;
}

const DEFAULT_CONFIG: MessageDropConfig = {
  keepRecentTurns: 6,
  budgetCeilingRatio: 0.9,
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
    const { messages, budget } = context;
    // 预算前置：超过上限让给 LLMSummarize（避免丢失 9x% 场景的语义信息）
    if (budget.usageRatio >= this.config.budgetCeilingRatio) return false;
    // 需要有足够多的消息才值得丢弃
    const keepMessages = this.config.keepRecentTurns * 2 + 1;
    return messages.length > keepMessages + 2;
  }

  async apply(context: CompactionContext): Promise<CompactionResult> {
    const { messages } = context;
    const { keepRecentTurns } = this.config;

    // 按 turn 数切分（pair-aware），tool_use/tool_result 对不会被劈开
    const { toSummarize, toPreserve } = splitMessagesPairAware(
      messages,
      keepRecentTurns,
    );

    // toSummarize.length <= 1 说明前段最多只有意图锚（turn 0 的首条 user），
    // 压缩后 [firstMessage, placeholder(count=0), ...toPreserve] 无实际压缩
    // 效果，等同于原逻辑的 keepFromIndex <= 1。
    if (toSummarize.length <= 1) {
      return {
        messages: messages as Message[],
        tokensBefore: 0,
        tokensAfter: 0,
        compacted: false,
      };
    }

    const firstMessage = messages[0] as Message;

    // 丢弃的 turn 数 = toSummarize 中 distinct turn 号的最大值
    // （turn 0 是首条 user 意图锚，turn 1..maxSummarized 是被丢弃的完整 turn）
    const toSummarizeTurns = calculateMessageTurns(toSummarize);
    const droppedTurnCount =
      toSummarizeTurns[toSummarizeTurns.length - 1] ?? 0;

    // 占位符统一走 system-meta：kind="dropped-turns" count="N"
    const placeholder = buildDroppedTurnsMessage(droppedTurnCount);

    const newMessages = [firstMessage, placeholder, ...toPreserve];

    return {
      messages: newMessages,
      tokensBefore: 0,
      tokensAfter: 0,
      compacted: true,
    };
  }
}

export function createMessageDropStrategy(
  config?: Partial<MessageDropConfig>,
): MessageDropStrategy {
  return new MessageDropStrategy(config);
}
