/**
 * 子 agent 结果分类与文本提取 (internal)
 *
 * runChildAgent 用这组纯函数把:
 *   - SubAgentLoopResult (loop 透传的 reason: completed / max_turns / aborted / error
 *     + 软上限触发种类 budgetExceededKind: max_turns / max_tokens / wall_clock)
 *   - 父侧 catch 到的异常 (loop 自身基础设施崩才有)
 * 折叠成 ChildAgentResult.status 三态:`"completed" | "failed" | "aborted"`
 *
 * 设计取舍:
 *   - 三态而非四态:三类 budget 触发 + error 都视为 "failed"(主 LLM 一致看到失败即重试 /
 *     改方案);具体 type 走 ChildAgentResult.error.type 字符串,不在 status 里再分一级
 *   - 软上限优先 reason:budgetExceededKind 存在即 failed,与具体 reason 字段无关
 *     (max_tokens / wall_clock 实现机制走 abort 通道,reason="aborted",但语义上是
 *     "钱袋耗尽 / 时间到",归 failed 而非 aborted —— spec §7.3 明确"软上限触发 = failed")
 *   - 文本提取与分类拆开:任一函数可独立测试;extract* 走纯 messages 形态,无副作用
 *   - completed 时 partial 不抓:语义上 finalAssistantText 已是完整答案;
 *     failed/aborted 才考虑 partial,且优先用最后一条 assistant 文本
 */

import type { AgentResult, Message, TextBlock } from "@zhixing/core";
import type { BudgetExceededKind } from "./budget.js";

export type ChildResultKind = "completed" | "failed" | "aborted";

/**
 * classifyResult 入参的最小结构 —— 只读 reason / budgetExceededKind 字段。
 *
 * 这样 classifier 不耦合 SubAgentLoopResult 完整定义(避免循环 / 反向依赖),
 * 调用方传 SubAgentLoopResult 仍可隐式满足该结构(structural typing)。
 */
export interface ClassifiableLoopResult {
  reason: AgentResult["reason"];
  budgetExceededKind?: BudgetExceededKind;
}

/** 取最后一条 assistant message 的所有 text 块拼接;无 text 块返回 "" */
export function extractFinalAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") {
      return message.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n\n");
    }
  }
  return "";
}

/** 拼接所有 assistant message 的 text 块 (failed/aborted 用) */
export function extractPartialText(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) =>
      m.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text),
    )
    .join("\n\n");
}

/**
 * 三态分类。
 *
 * 优先级:
 *   1. caughtError 存在(loop 基础设施崩) → failed (parent abort 走 loop 内部 reason="aborted",
 *      不会走 catch)
 *   2. budgetExceededKind 存在(三类软上限触发) → failed —— 优先于 reason,
 *      因为 max_tokens / wall_clock 实现走 abort 通道(reason="aborted"),但语义是
 *      "资源耗尽"应折 failed 而非 aborted(spec §7.3:软上限触发 = failed)
 *   3. loop 自身的 reason 字段映射:
 *      - aborted   → aborted (真正的中断:parent-abort / idle-timeout / user-cancel)
 *      - error     → failed
 *      - max_turns → failed (兜底,正常情况下已被 budgetExceededKind 优先分支命中)
 *      - completed → completed
 */
export function classifyResult(
  loopResult: ClassifiableLoopResult | null,
  caughtError: unknown,
): ChildResultKind {
  if (caughtError !== null && caughtError !== undefined) return "failed";
  if (!loopResult) return "failed";
  if (loopResult.budgetExceededKind) return "failed";
  switch (loopResult.reason) {
    case "aborted":
      return "aborted";
    case "completed":
      return "completed";
    case "error":
    case "max_turns":
      return "failed";
  }
}
