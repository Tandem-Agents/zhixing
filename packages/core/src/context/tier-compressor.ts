/**
 * TierCompressor（分级压缩器） — 四级 tool_result 渐进压缩
 *
 * 规格引用：context-architecture.md §3.4 / §7
 *
 * 设计原则：
 * - 按 turn distance 分级：近期完整保留，远期渐进压缩
 * - Profile 参数化：T1/T2/T3 阈值由 ContextProfile.tierThresholds 决定
 * - 每轮预防性运行：不等预算超标，始终保持 tool_result 在合适 tier
 * - 幂等：重复运行不会重复截断
 * - Tier 4 保留骨架：tool_use 结构不变，结果可通过 recall_history 恢复
 *
 * 四级定义：
 * Tier 1 (≤T1)  — 完整保留
 * Tier 2 (≤T2)  — 截断至 2000 字符 + 恢复提示
 * Tier 3 (≤T3)  — 截断至 500 字符 + 恢复提示
 * Tier 4 (>T3)  — 仅骨架 "[tool=X bytes=N, recallable]"
 */

import type { ContentBlock, Message, ToolResultBlock } from "../types/messages.js";
import type { TierThresholds } from "./context-profile.js";
import { calculateMessageTurns } from "./message-turns.js";

// ─── 常量 ───

export type TierLevel = 1 | 2 | 3 | 4;

export const TIER2_MAX_CHARS = 2000;
export const TIER3_MAX_CHARS = 500;

// ─── 统计 ───

export interface TierStats {
  readonly tier1Count: number;
  readonly tier2Count: number;
  readonly tier3Count: number;
  readonly tier4Count: number;
  readonly charsSaved: number;
}

function emptyStats(): TierStats {
  return { tier1Count: 0, tier2Count: 0, tier3Count: 0, tier4Count: 0, charsSaved: 0 };
}

// ─── Tier 判定 ───

export function determineTier(
  turnDistance: number,
  thresholds: TierThresholds,
): TierLevel {
  if (turnDistance <= thresholds.T1) return 1;
  if (turnDistance <= thresholds.T2) return 2;
  if (turnDistance <= thresholds.T3) return 3;
  return 4;
}

// ─── 主入口 ───

/**
 * 对消息列表中所有 tool_result 按 turn distance 应用四级压缩。
 *
 * 每轮都应调用（预防性），不仅在预算超标时。
 * 幂等：已处于目标 tier 的内容不会被重复截断。
 */
export function applyTierCompression(
  messages: readonly Message[],
  thresholds: TierThresholds,
): { messages: Message[]; stats: TierStats } {
  const turns = calculateMessageTurns(messages);
  const maxTurn = turns[turns.length - 1] ?? 0;
  const stats = { ...emptyStats() };
  let anyModified = false;

  const newMessages: Message[] = messages.map((msg, idx) => {
    if (msg.role !== "user") return msg as Message;

    const hasToolResult = msg.content.some((b) => b.type === "tool_result");
    if (!hasToolResult) return msg as Message;

    const msgTurn = turns[idx]!;
    const distance = maxTurn - msgTurn;
    const tier = determineTier(distance, thresholds);

    if (tier === 1) {
      countToolResults(msg.content, stats, 1);
      return msg as Message;
    }

    let msgModified = false;
    const newContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;

      const toolName = findToolName(messages, idx, block.toolUseId);
      const result = compressToolResult(block, tier, toolName, stats);

      if (result !== block) msgModified = true;
      return result;
    });

    if (msgModified) {
      anyModified = true;
      return { ...msg, content: newContent } as Message;
    }
    return msg as Message;
  });

  return {
    messages: anyModified ? newMessages : (messages as Message[]),
    stats,
  };
}

// ─── 压缩逻辑 ───

const SKELETON_PATTERN = /^\[tool=\S+ bytes=\d+, recallable\]$/;

function compressToolResult(
  block: ToolResultBlock,
  tier: TierLevel,
  toolName: string,
  stats: { tier1Count: number; tier2Count: number; tier3Count: number; tier4Count: number; charsSaved: number },
): ToolResultBlock {
  const content = block.content;
  const originalLength = extractOriginalLength(content) ?? content.length;

  switch (tier) {
    case 2: {
      stats.tier2Count++;
      if (content.length <= TIER2_MAX_CHARS) return block;
      if (isSkeleton(content)) return block;
      if (isAlreadyAtTier(content, TIER2_MAX_CHARS)) return block;
      const trimmed = `${content.slice(0, TIER2_MAX_CHARS)}\n[已截断至 ${TIER2_MAX_CHARS} 字符，原始 ${originalLength} 字符，可通过 recall_history 恢复]`;
      stats.charsSaved += content.length - trimmed.length;
      return { ...block, content: trimmed };
    }

    case 3: {
      stats.tier3Count++;
      if (content.length <= TIER3_MAX_CHARS) return block;
      if (isSkeleton(content)) return block;
      if (isAlreadyAtTier(content, TIER3_MAX_CHARS)) return block;
      const trimmed = `${content.slice(0, TIER3_MAX_CHARS)}\n[截断至 ${TIER3_MAX_CHARS} 字符，原始 ${originalLength} 字符，可通过 recall_history 恢复]`;
      stats.charsSaved += content.length - trimmed.length;
      return { ...block, content: trimmed };
    }

    case 4: {
      stats.tier4Count++;
      if (isSkeleton(content)) return block;
      const skeleton = `[tool=${toolName} bytes=${originalLength}, recallable]`;
      stats.charsSaved += content.length - skeleton.length;
      return { ...block, content: skeleton };
    }

    default:
      return block;
  }
}

function isSkeleton(content: string): boolean {
  return SKELETON_PATTERN.test(content);
}

function isAlreadyAtTier(content: string, maxChars: number): boolean {
  return content.includes(`截断至 ${maxChars} 字符`) || content.includes(`已截断至 ${maxChars} 字符`);
}

function extractOriginalLength(content: string): number | null {
  const match = content.match(/原始 (\d+) 字符/);
  return match ? parseInt(match[1]!, 10) : null;
}

function countToolResults(
  content: readonly ContentBlock[],
  stats: { tier1Count: number },
  _tier: 1,
): void {
  for (const block of content) {
    if (block.type === "tool_result") stats.tier1Count++;
  }
}

/**
 * 从 tool_result 的 toolUseId 反查对应的 tool_use 名称。
 *
 * 向前搜索最近的 assistant 消息中匹配的 tool_use block。
 */
function findToolName(
  messages: readonly Message[],
  toolResultMsgIdx: number,
  toolUseId: string,
): string {
  for (let i = toolResultMsgIdx - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id === toolUseId) {
        return block.name;
      }
    }
    break;
  }
  return "unknown";
}
