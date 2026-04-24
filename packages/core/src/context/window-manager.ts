/**
 * WindowManager — 消息窗口管理 + Pinning + 级联淘汰
 *
 * 规格引用：context-architecture.md §3.3 (WindowManager) + §6 (Eviction)
 *
 * 设计原则：
 * - 纯函数：无状态，输入 → 输出
 * - Pin 保护：pinned 消息永远不被淘汰
 * - 级联淘汰：Tier 降级 → Turn 淘汰 → LLM 压缩（由 engine 兜底）
 * - 预算驱动：窗口大小是 budget 的函数，不是固定值
 *
 * 流程：
 * 1. 始终应用 TierCompressor（预防性，每轮运行）
 * 2. 检查预算：如果 ≤ compact → 返回
 * 3. 淘汰最老的非 pinned turns 直到预算回到安全区间
 * 4. 返回结果（如果仍超标，engine 触发 LLM 压缩兜底）
 */

import type { Message } from "../types/messages.js";
import type { TierThresholds } from "./context-profile.js";
import type { ITokenEstimator } from "./types.js";
import { applyTierCompression, type TierStats } from "./tier-compressor.js";
import { calculateMessageTurns } from "./message-turns.js";
import { buildDroppedTurnsMessage } from "./system-meta.js";

// ─── 常量 ───

export const MIN_RETAIN_TURNS = 2;

// ─── 配置 ───

export interface WindowConfig {
  /** Tier 压缩阈值（null = 不做 tier 压缩，如 lookup） */
  readonly tierThresholds: TierThresholds | null;
  /** Token 估算器 */
  readonly estimator: ITokenEstimator;
  /** 有效窗口 token 数 */
  readonly effectiveWindow: number;
  /** compact 阈值比例（如 0.80） */
  readonly compactRatio: number;
  /** 判断消息是否被 pin（基于原始索引） */
  readonly isPinned: (index: number) => boolean;
}

// ─── 输出 ───

export interface WindowResult {
  readonly messages: Message[];
  readonly modified: boolean;
  readonly evictedTurnCount: number;
  readonly tierStats: TierStats | null;
}

// ─── 默认 Pin 策略 ───

/**
 * 默认 pin 策略：仅 pin 第一条 user 消息（原始意图锚点）。
 *
 * 后续 Step 7+ 会扩展为支持 task ledger 和 phase plan pinning。
 */
export function defaultIsPinned(index: number): boolean {
  return index === 0;
}

// ─── 主入口 ───

/**
 * 管理消息窗口：tier 压缩 + 预算检查 + pin-aware 淘汰。
 *
 * 返回经过压缩和淘汰的消息列表。
 * 如果返回后仍超过 critical 阈值，由 engine 触发 LLM 压缩兜底。
 */
export function manageWindow(
  messages: readonly Message[],
  config: WindowConfig,
): WindowResult {
  let result: Message[] = messages as Message[];
  let modified = false;
  let tierStats: TierStats | null = null;

  // ── Step 1: Tier 压缩（预防性，始终运行） ──
  if (config.tierThresholds) {
    const tierResult = applyTierCompression(result, config.tierThresholds);
    tierStats = tierResult.stats;
    if (tierResult.stats.charsSaved > 0) {
      result = tierResult.messages;
      modified = true;
    }
  }

  // ── Step 2: 预算检查 ──
  const compactLimit = config.effectiveWindow * config.compactRatio;
  const currentTokens = config.estimator.estimateMessages(result);
  if (currentTokens <= compactLimit) {
    return { messages: result, modified, evictedTurnCount: 0, tierStats };
  }

  // ── Step 3: Pin-aware turn 淘汰 ──
  const eviction = evictOldestTurns(result, config.isPinned, {
    estimator: config.estimator,
    targetTokens: compactLimit,
  });

  if (eviction.evictedCount > 0) {
    result = eviction.messages;
    modified = true;
  }

  return {
    messages: result,
    modified,
    evictedTurnCount: eviction.evictedCount,
    tierStats,
  };
}

// ─── Turn 淘汰 ───

interface EvictionConfig {
  readonly estimator: ITokenEstimator;
  readonly targetTokens: number;
}

interface EvictionResult {
  readonly messages: Message[];
  readonly evictedCount: number;
}

/**
 * 从最老的 turn 开始淘汰非 pinned 消息，直到总 token 降到 targetTokens 以下。
 *
 * 保留规则：
 * - pinned 消息永远保留
 * - 至少保留最近 MIN_RETAIN_TURNS 轮
 * - 淘汰点插入占位消息
 */
function evictOldestTurns(
  messages: readonly Message[],
  isPinned: (index: number) => boolean,
  config: EvictionConfig,
): EvictionResult {
  const turns = calculateMessageTurns(messages);
  const maxTurn = turns[turns.length - 1] ?? 0;

  // 按 turn 分组：Map<turnNumber, originalIndices[]>
  const turnGroups = new Map<number, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const t = turns[i]!;
    const group = turnGroups.get(t);
    if (group) group.push(i);
    else turnGroups.set(t, [i]);
  }

  // 找出可淘汰的 turn（从最老到最新）
  const evictable: number[] = [];
  for (const [turnNum, indices] of turnGroups) {
    // 保留最近 MIN_RETAIN_TURNS
    if (maxTurn - turnNum < MIN_RETAIN_TURNS) continue;
    // 如果 turn 中任一消息被 pin，跳过整个 turn
    if (indices.some((idx) => isPinned(idx))) continue;
    evictable.push(turnNum);
  }
  evictable.sort((a, b) => a - b);

  if (evictable.length === 0) {
    return { messages: messages as Message[], evictedCount: 0 };
  }

  // 贪心淘汰：从最老开始，每淘汰一个 turn 重新估算
  const evictedSet = new Set<number>();
  let currentTokens = config.estimator.estimateMessages(messages);

  for (const turnNum of evictable) {
    if (currentTokens <= config.targetTokens) break;

    const indices = turnGroups.get(turnNum)!;
    const turnMessages = indices.map((i) => messages[i]!);
    const turnTokens = config.estimator.estimateMessages(turnMessages);

    evictedSet.add(turnNum);
    currentTokens -= turnTokens;
  }

  if (evictedSet.size === 0) {
    return { messages: messages as Message[], evictedCount: 0 };
  }

  // 重建消息数组：保留非淘汰消息，在首个淘汰点插入占位
  const kept: Message[] = [];
  let placeholderInserted = false;

  for (let i = 0; i < messages.length; i++) {
    const t = turns[i]!;
    if (evictedSet.has(t)) {
      if (!placeholderInserted) {
        // 占位符统一走 system-meta：kind="dropped-turns" count="N"
        kept.push(buildDroppedTurnsMessage(evictedSet.size));
        placeholderInserted = true;
      }
      continue;
    }
    kept.push(messages[i] as Message);
  }

  return { messages: kept, evictedCount: evictedSet.size };
}
