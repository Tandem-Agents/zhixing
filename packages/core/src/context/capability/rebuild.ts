/**
 * 从已恢复对话的历史 messages 重建 capability state 的 hot 集合。
 *
 * 触发场景：
 *   conversation meta 缺 capabilityState 字段（首次启用 capability 机制 / 老
 *   conversation 升级路径）。装配方先 initialize 所有工具到默认 layer，再调本
 *   函数把"最近 N 个含 tool_use 的 assistant message"涉及的工具升级到 hot，
 *   保证用户重启 cli 后仍能继续之前的工作流而不必每个工具重新走自动升级路径。
 *
 * 算法：倒序扫 messages，找最近 retentionTurns 个含 tool_use 的 assistant
 *   message；这些 message 内的所有 tool_use.name 都进 hot 集合（去重）。
 *   纯文本 assistant 不计入轮数 —— 它们是 LLM 思考 / 总结，与工具激活无关。
 *
 * 副作用：在传入的 state 上调 recordToolUse（讨论了 always / cold / 未注册
 *   语义自动正确：always 仅刷 lastUseTurn 不变层；cold / 未注册 no-op）。
 *
 * 注意：本函数不调 advanceTurn —— 不模拟"过去 N 轮"的时间流逝，rebuild 后的
 *   state.currentTurn 仍是初始值（通常 0），lastUseTurn 也是初始 currentTurn；
 *   下一次 advanceTurn 才让 LRU 距离开始累积。这是预期行为：恢复对话被视为
 *   "从现在重新开始计时"，hot 集保留但 LRU 倒计时归零。
 */

import type { Message } from "../../types/messages.js";
import type { CapabilityState } from "./state.js";
import { HOT_RETENTION_TURNS } from "./types.js";

export function rebuildCapabilityFromHistory(
  state: CapabilityState,
  messages: readonly Message[],
  retentionTurns: number = HOT_RETENTION_TURNS,
): void {
  const recentTools = collectRecentToolUses(messages, retentionTurns);
  for (const name of recentTools) {
    state.recordToolUse(name);
  }
}

/**
 * 倒序扫 messages，收集最近 retentionTurns 个含 tool_use 的 assistant message
 * 涉及的工具名（去重，按倒序首次出现保持稳定顺序）。
 *
 * 暴露为独立函数便于消费方按需查询（诊断 / 自定义预热策略），不必都走 rebuild
 * 这个 mutate 入口。
 */
export function collectRecentToolUses(
  messages: readonly Message[],
  retentionTurns: number = HOT_RETENTION_TURNS,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  let assistantsCounted = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (assistantsCounted >= retentionTurns) break;
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;

    let hasToolUse = false;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      hasToolUse = true;
      if (!seen.has(block.name)) {
        seen.add(block.name);
        ordered.push(block.name);
      }
    }

    if (hasToolUse) assistantsCounted += 1;
  }

  return ordered;
}
