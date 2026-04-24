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
 * 需归一化的 3 种情形：
 *   1. 多于 1 个 compact —— 老格式可能因多次自动 compact 累积多条 marker
 *   2. 有 compact 但存在 `turn.timestamp <= compact.timestamp` —— §1.3 bug 遗物
 *      （老 REPL 先 append turn 再 append compact，timestamp 反序）
 *   3. 无 compact —— 不需要归一化（干净的 append-only 流）
 *
 * 约定：无 compact 时返 false（即便多 turns 也是合法的线性流）。
 */
export function needsNormalize(loaded: {
  readonly turns: readonly Turn[];
  readonly compacts: readonly CompactMarker[];
}): boolean {
  if (loaded.compacts.length > 1) return true;
  if (loaded.compacts.length === 1) {
    const lastTime = new Date(loaded.compacts[0]!.timestamp).getTime();
    return loaded.turns.some(
      (t) => new Date(t.timestamp).getTime() <= lastTime,
    );
  }
  return false;
}

/**
 * 归一化：只保留最后 1 个 compact，丢弃 compact 之前（timestamp <=）的所有 turns。
 *
 * 返回新 `{turns, compacts}` 对象（不改原输入，纯函数）。调用方（store.load）
 * 拿结果重写文件 + 重建 canonical。
 *
 * **有意的数据丢失**：§1.3 bug 在老文件里产生 "turn.ts < compact.ts 但逻辑上
 * turn 是后续" 的矛盾，normalize 选择丢弃这类 turn —— 因为文件顺序已不可恢复，
 * 硬保留会产生二义性（canonical 里会有 summary + 之前的 turn + 之后的 turn 混排）。
 * 新 commitTurn 路径从此杜绝此问题。
 */
export function normalize(loaded: {
  readonly turns: readonly Turn[];
  readonly compacts: readonly CompactMarker[];
}): { turns: Turn[]; compacts: CompactMarker[] } {
  if (loaded.compacts.length === 0) {
    return { turns: [...loaded.turns], compacts: [] };
  }

  const last = loaded.compacts[loaded.compacts.length - 1]!;
  const lastTime = new Date(last.timestamp).getTime();
  const keptTurns = loaded.turns.filter(
    (t) => new Date(t.timestamp).getTime() > lastTime,
  );

  return {
    turns: keptTurns,
    compacts: [last],
  };
}
