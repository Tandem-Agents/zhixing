/**
 * `buildCleanup` —— abort 退出时产协议清理数据(纯函数)。
 *
 * 设计原则:cleanup 模块只产语义化数据(partialAssistant Message +
 * placeholderToolResults 数组),不产 yield 序列。yield 序列需要 turnCount /
 * usage / 反查 tool name 等 agent-loop 持有的状态——cleanup 不应跨层依赖。
 *
 * 这一分层让:
 *   - cleanup 模块零状态依赖,纯函数易测
 *   - agent-loop 是 yield 序列的唯一组装者,trackMessages 通过现有的
 *     "tool_end + turn_complete → user message"协议自然包出合规 messages
 *   - 单一事实源,所有 placeholder 合成只在本模块出现一次
 *
 * 判别联合借鉴 `context/termination.ts` 的归一化模式:让调用方按 `kind`
 * 分派,无 partial / 无 unexecuted 时返回 `no-cleanup`,调用方零负担。
 */

import type { Message, ToolResultBlock, ToolUseBlock } from "../types/messages.js";
import { assemblePartialMessage } from "./assemble.js";
import type { AbortReason } from "./types.js";

export interface CleanupContext {
  /**
   * llm-call abort 路径返回的 partial 数据。仅承载 text + thinking,不含
   * tool_use(见 `assemblePartialMessage` 的代价说明)。abort 不在 LLM 流
   * 响应阶段时为 undefined。
   */
  readonly partial?: {
    readonly text: string;
    readonly thinking: string;
  };
  /**
   * tool-executor 返回的未执行 ToolUse(保留完整对象含 id + name + input)。
   * 由 cleanup 注入合成 tool_result placeholder 保证协议合规。
   * abort 不在工具执行阶段时为空数组或 undefined。
   */
  readonly unexecutedToolUses?: readonly ToolUseBlock[];
  /**
   * abort 原因。null 表示外部 signal 直接 aborted、未经本模块,placeholder
   * 文本走 "interrupted" 兜底。
   */
  readonly reason: AbortReason | null;
}

/**
 * 清理结果判别联合。
 *
 * - `no-cleanup`:无 partial、无 unexecuted → 调用方无需 yield 任何东西
 * - `data`:含 partialAssistant 与/或 placeholderToolResults → 调用方据此组装
 */
export type CleanupOutcome =
  | { readonly kind: "no-cleanup" }
  | {
      readonly kind: "data";
      /** partial assistant message(仅 text + thinking blocks);无内容时为 null */
      readonly partialAssistant: Message | null;
      /** 注入的 placeholder(按 unexecutedToolUses 顺序);空数组表示无需 yield tool_end */
      readonly placeholderToolResults: readonly ToolResultBlock[];
    };

export function buildCleanup(ctx: CleanupContext): CleanupOutcome {
  const partialAssistant = ctx.partial
    ? assemblePartialMessage(ctx.partial.text, ctx.partial.thinking)
    : null;

  const unexecuted = ctx.unexecutedToolUses ?? [];
  const placeholderToolResults: ToolResultBlock[] = unexecuted.map((tc) => ({
    type: "tool_result" as const,
    toolUseId: tc.id,
    content: `[Tool execution cancelled: ${formatReasonForToolResult(ctx.reason)}]`,
    isError: true,
  }));

  if (partialAssistant === null && placeholderToolResults.length === 0) {
    return { kind: "no-cleanup" };
  }

  return { kind: "data", partialAssistant, placeholderToolResults };
}

/**
 * 把 `AbortReason` 渲染成 tool_result placeholder 文本(LLM 可见)。
 * LLM 看到此文本后理解为"我之前请求过的某个工具被中断了"。
 *
 * switch 是穷尽的:加新 kind 时 TypeScript 会报缺 case。switch 后的 return 是
 * 防御性兜底,正常路径不会执行——它接住"运行时数据被污染"的场景:有人把非
 * AbortReason 的对象塞进 controller.abort(),`getAbortReason` 因 duck-typing 仅
 * 检查 `kind` 是 string 而放行,这里的 switch 不匹配任何 case。没有兜底的话,
 * 函数返回 undefined,调用方的 template literal 会渲染成 `[Tool execution
 * cancelled: undefined]` 给 LLM。
 */
export function formatReasonForToolResult(r: AbortReason | null): string {
  if (!r) return "interrupted";
  switch (r.kind) {
    case "user-cancel":
      return `user pressed ${r.source}`;
    case "idle-timeout":
      return `stream idle ${Math.floor(r.timeoutMs / 1000)}s, ${r.chunksReceived} chunks received`;
    case "parent-abort":
      return "parent aborted";
    case "external":
      return r.origin ?? "external signal";
  }
  return "interrupted";
}
