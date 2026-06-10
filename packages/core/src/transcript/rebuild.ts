/**
 * Canonical 消息重建 + 文件归一化
 *
 * 职责：把 `{turns, compacts}` 的元数据转换为 LLM 可消费的 `Message[]` 序列；
 * 并提供老格式文件的归一化算法（lazy migrate），使落盘文件永远满足
 * "header + [compact?] + post-compact turns" 的单一不变量。
 *
 * 设计文档：
 *   - §0.7.1 单向数据流：canonical 经 commitTurn 返回，调用方 state.messages = canonical
 *   - §5 文件格式不变量：归一化后至多 1 个 compact，紧跟 header
 *   - ADR-TR-5 Lazy 迁移：老文件首次 load 同步归一化重写
 *
 * 为什么单独成模块：
 *   - rebuildCanonicalMessages 同时被 store.commitTurn（写完后返 canonical）、
 *     server/ConversationManager（ephemeral 内存重建）、调用方直接使用
 *   - 归一化算法（normalize / needsNormalize）纯函数，独立测试
 *   - 解耦 store 的 I/O 关注点与 canonical 的语义关注点
 */

import type { Message } from "../types/messages.js";
import { buildCompactSummaryPair } from "../context/system-meta.js";
import type { CompactMarker, Turn } from "./types.js";

// ─── Canonical 重建 ───

/**
 * 把 `{turns, compacts}` 展开为 LLM 可消费的 canonical `Message[]`。
 *
 * 契约（调用方须保证输入已归一化）：
 *   - `compacts.length <= 1`
 *   - 若 `compacts.length === 1`，所有 `turns[i].timestamp > compacts[0].timestamp`
 *
 * 输出结构：
 *   - 有 compact：`[summaryPair(summary), ...turns展开]` —— summaryPair 走 system-meta
 *     `kind="compact-summary"` + `kind="ack"` 双消息，与 `LLMSummarize.buildCompactedMessages`
 *     和 `stripSummaryPlaceholderPair` 的识别规则严格对齐（§5 N10）
 *   - 无 compact：`[...turns展开]`
 *
 * 此函数纯，可在任何层调用：
 *   - store.commitTurn 写完后返值
 *   - ConversationManager.recordTurn ephemeral 分支内存 canonical
 *   - 测试 fixture 验证
 */
export function rebuildCanonicalMessages(
  turns: readonly Turn[],
  compacts: readonly CompactMarker[],
): Message[] {
  const messages: Message[] = [];

  if (compacts.length > 0) {
    // 归一化后总是唯一；多 compact 是老格式残留，由 normalize 处理
    const last = compacts[compacts.length - 1]!;
    const [summaryMsg, ackMsg] = buildCompactSummaryPair(last.summary);
    messages.push(summaryMsg, ackMsg);
  }

  for (const turn of turns) {
    messages.push(turn.userMessage, turn.assistantMessage);
  }

  return messages;
}

// ─── 归一化（lazy migrate） ───

/**
 * 判断文件加载结果是否需要归一化重写。
 *
 * 判定是**纯物理顺序**的：
 *   1. 多于 1 个 compact —— 老格式可能因多次自动 compact 累积多条 marker
 *   2. 有 turn 行出现在最后一个 compact 行**之前**（`turnsBeforeLastCompact > 0`）
 *      —— 历史 bug 遗留的"先 append turn 再 append compact"形态；健康文件由
 *      原子重写产生，compact 永远紧跟 header、计数恒为 0
 *   3. 无 compact —— 不需要归一化（干净的 append-only 流）
 *
 * 为什么不按时间戳判：compact 保留的近期 turns 时间戳**天然早于** marker
 * （marker 记压缩发生时刻、retained 是更早的提交），时间戳判定会把刚保留的
 * turns 当病文件误删——按文件物理顺序判才与写入算法的真实形态对齐。
 */
export function needsNormalize(loaded: {
  readonly compacts: readonly CompactMarker[];
  readonly turnsBeforeLastCompact: number;
}): boolean {
  if (loaded.compacts.length > 1) return true;
  if (loaded.compacts.length === 1) {
    return loaded.turnsBeforeLastCompact > 0;
  }
  return false;
}

/**
 * 归一化：只保留最后 1 个 compact，丢弃文件顺序在它**之前**的所有 turns。
 *
 * 返回新对象（不改原输入，纯函数）；`turnsBeforeLastCompact` 归零，满足
 * "归一化结果再判 needsNormalize 必为 false" 的不变量。调用方（store.load）
 * 拿结果重写文件 + 重建 canonical。
 *
 * **有意的数据丢失**：位于最后 compact 之前的 turn 行是历史 bug 遗留形态，
 * 其内容已被该 compact 的摘要语义覆盖，硬保留会产生二义性（canonical 里
 * summary 与被摘内容混排）。原子重写路径不会产生此形态。
 */
export function normalize(loaded: {
  readonly turns: readonly Turn[];
  readonly compacts: readonly CompactMarker[];
  readonly turnsBeforeLastCompact: number;
}): { turns: Turn[]; compacts: CompactMarker[]; turnsBeforeLastCompact: 0 } {
  if (loaded.compacts.length === 0) {
    return { turns: [...loaded.turns], compacts: [], turnsBeforeLastCompact: 0 };
  }

  const last = loaded.compacts[loaded.compacts.length - 1]!;
  const keptTurns = loaded.turns.slice(loaded.turnsBeforeLastCompact);

  return {
    turns: keptTurns,
    compacts: [last],
    turnsBeforeLastCompact: 0,
  };
}
