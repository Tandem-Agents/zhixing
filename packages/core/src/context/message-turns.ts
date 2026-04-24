/**
 * Message Turns — "turn 在消息数组中的视图" 抽象层
 *
 * 这个模块是多个策略（ToolResultTrim / MessageDrop / LLMSummarize /
 * WindowManager / TierCompressor）共享的 turn 视图单一事实源。
 *
 * 概念：
 *   一个 turn = assistant 消息 + 其后续的 tool_result user 消息。
 *   turn 号从 0 开始（turn 0 只含开头的 user），每遇到一个 assistant 递增。
 *
 * 不放在 strategies/ 子目录下 —— 这是跨策略的抽象，不是任何单个策略的私有实现。
 */
import type { ContentBlock, Message, ToolUseBlock } from "../types/messages.js";

// ─── Turn 号计算 ───

/**
 * 计算每条消息所在的 turn 号。
 *
 * 一个 turn = assistant 消息 + 其后续 tool_result user 消息（如果有）。
 * 返回长度与 messages 相同的数组，值越大表示越新。
 *
 * 规则：
 *   - turn 号从 0 开始
 *   - 每遇到一个 assistant 消息，turn 号 +1
 *   - user 消息继承前一条消息的 turn 号（若无前序则为 0）
 *
 * 示例（括号内为 turn 号）：
 *   user(0), assistant(1), user(1)[tool_result], assistant(2), user(2)
 *   └─ turn 1 ─┘                    └─ turn 2 ─┘
 */
export function calculateMessageTurns(messages: readonly Message[]): number[] {
  const turns: number[] = new Array(messages.length);
  let currentTurn = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant") {
      currentTurn++;
    }
    turns[i] = currentTurn;
  }

  return turns;
}

// ─── Pair-aware 切分 ───

export interface SplitResult {
  /** 待压缩/丢弃的前段消息（按 turn 边界切分，tool pair 完整） */
  readonly toSummarize: Message[];
  /** 保留的后段消息（最近 N 个完整 turn） */
  readonly toPreserve: Message[];
}

/**
 * 按保留的 turn 数切分消息，保证 tool_use / tool_result 对不被切开。
 *
 * 算法：
 *   1. 计算每条消息的 turn 号
 *   2. 确定要保留的最早 turn 号 = max(1, maxTurn - preserveRecentTurns + 1)
 *   3. 找到该 turn 在 messages 中的起点，从这里切分
 *
 * 因为切分点永远在 turn 边界上，而 tool_use (assistant) 与其 tool_result (user)
 * 天然在同一个 turn 内（按 turn 号定义），所以 pair 不会被劈开。
 *
 * 边界情况：
 *   - preserveRecentTurns <= 0：全部压缩，toPreserve = []
 *   - messages 为空：两侧都为空
 *   - preserveRecentTurns >= maxTurn：仅开头的 turn 0（若存在）归入 toSummarize
 *   - 整体消息数 <= preserveRecentTurns 覆盖范围：toSummarize 可能为空
 *
 * 上层策略需自行检查 toSummarize 是否够长再决定压缩（如 LLMSummarize 要求 >= 2 才有摘要价值）。
 */
export function splitMessagesPairAware(
  messages: readonly Message[],
  preserveRecentTurns: number,
): SplitResult {
  if (messages.length === 0) {
    return { toSummarize: [], toPreserve: [] };
  }
  if (preserveRecentTurns <= 0) {
    return { toSummarize: [...messages] as Message[], toPreserve: [] };
  }

  const turns = calculateMessageTurns(messages);
  const maxTurn = turns[turns.length - 1] ?? 0;

  // 若 maxTurn === 0，说明整段只有 user（无 assistant），没有 turn 可保留
  if (maxTurn === 0) {
    return { toSummarize: [], toPreserve: [...messages] as Message[] };
  }

  // 要保留的最早 turn 号（包含）
  const firstPreservedTurn = Math.max(1, maxTurn - preserveRecentTurns + 1);

  // 找 firstPreservedTurn 的起点 —— 第一个 turn >= firstPreservedTurn 的 index
  let splitPoint = messages.length;
  for (let i = 0; i < messages.length; i++) {
    if (turns[i]! >= firstPreservedTurn) {
      splitPoint = i;
      break;
    }
  }

  return {
    toSummarize: messages.slice(0, splitPoint) as Message[],
    toPreserve: messages.slice(splitPoint) as Message[],
  };
}

// ─── Tool pairing 断言 ───

/**
 * 断言 messages 中每个 tool_use 块都有对应的 tool_result 块（按 id 匹配）。
 *
 * 用于测试场景和运行时诊断 —— 确保 compact 策略不会破坏 tool 配对。
 * 配对要求：
 *   - 每个 assistant 消息中的 tool_use.id 必须在后续 user 消息的 tool_result 中出现
 *   - tool_result 可以在紧邻的下一条 user 消息，也可以在后续多条 user 消息中
 *
 * 失败时抛出 Error，消息包含所有未配对的 tool_use id。
 */
export function assertToolPairingIntact(messages: readonly Message[]): void {
  const pendingToolUseIds = new Set<string>();
  const seenResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (isToolUse(block)) {
          pendingToolUseIds.add(block.id);
        }
      }
    } else {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          seenResultIds.add(block.toolUseId);
          pendingToolUseIds.delete(block.toolUseId);
        }
      }
    }
  }

  if (pendingToolUseIds.size > 0) {
    const ids = [...pendingToolUseIds].join(", ");
    throw new Error(
      `Tool pairing broken: tool_use without matching tool_result (ids: ${ids})`,
    );
  }

  // 孤儿 tool_result（无对应 tool_use）也视为断裂 —— 通常意味着切分时把 tool_use 丢在了另一侧
  const orphanResults: string[] = [];
  for (const id of seenResultIds) {
    if (!hasToolUseWithId(messages, id)) {
      orphanResults.push(id);
    }
  }
  if (orphanResults.length > 0) {
    throw new Error(
      `Tool pairing broken: tool_result without matching tool_use (ids: ${orphanResults.join(", ")})`,
    );
  }
}

// ─── 内部辅助 ───

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

function hasToolUseWithId(messages: readonly Message[], id: string): boolean {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (isToolUse(block) && block.id === id) return true;
    }
  }
  return false;
}
