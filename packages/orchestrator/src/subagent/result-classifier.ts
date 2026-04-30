/**
 * 子 agent 结果分类与文本提取 (internal)
 *
 * runChildAgent 用这组纯函数把:
 *   - SubAgentLoopResult (loop 透传的 reason: completed / max_turns / aborted / error)
 *   - 父侧 catch 到的异常 (loop 自身基础设施崩才有)
 * 折叠成 ChildAgentResult.status 三态:`"completed" | "failed" | "aborted"`
 *
 * 设计取舍:
 *   - 三态而非四态:max_turns / error 都视为 "failed"(主 LLM 一致看到失败即重试 / 改方案);
 *     具体 type 走 ChildAgentResult.error.type 字符串,不在 status 里再分一级
 *   - 文本提取与分类拆开:任一函数可独立测试;extract* 走纯 messages 形态,无副作用
 *   - completed 时 partial 不抓:语义上 finalAssistantText 已是完整答案;
 *     failed/aborted 才考虑 partial,且优先用最后一条 assistant 文本
 */

import type { AgentResult, Message, TextBlock } from "@zhixing/core";

export type ChildResultKind = "completed" | "failed" | "aborted";

/**
 * classifyResult 入参的最小结构 —— 只读 reason 字段。
 *
 * 这样 classifier 不耦合 SubAgentLoopResult 完整定义(避免循环 / 反向依赖),
 * 调用方传 SubAgentLoopResult 仍可隐式满足该结构(structural typing)。
 */
export interface ClassifiableLoopResult {
  reason: AgentResult["reason"];
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
 *   2. loop 自身的 reason 字段映射:
 *      - aborted   → aborted
 *      - error     → failed
 *      - max_turns → failed (用 budgetExceeded 同步辨识)
 *      - completed → completed
 *   3. 兜底 failed (理论不可达,防御编码)
 */
export function classifyResult(
  loopResult: ClassifiableLoopResult | null,
  caughtError: unknown,
): ChildResultKind {
  if (caughtError !== null && caughtError !== undefined) return "failed";
  if (!loopResult) return "failed";
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
