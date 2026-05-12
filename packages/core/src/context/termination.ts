/**
 * ContextManagerHook 终止归一化
 *
 * 为什么单独成模块：
 *   多个调用点（agent-loop 的 turn-end 钩子、orchestrator 装配的 pre-flight，
 *   未来 server 路径 / ephemeral turn 等）都需要把 `onTurnComplete()` 的 3 种终止
 *   场景归一化成判别联合，再映射到各自的结果 shape（AgentResult / RunResult / ...）。
 *   若每个调用点各写一份，就会出现以下问题：
 *     - "abort 优先于 context_overflow" 这种非显然的优先级规则容易被复制丢
 *     - engine/strategy 抛错时的 AgentError 包装容易被遗漏（事件契约断裂）
 *     - pathLabel 字符串在错误消息里出现 N 份，拼写或措辞分叉
 *
 * 本模块把"hook 调用 + 归一化判别"收敛到一处，调用方只负责"把 kind 映射到
 * 自己的结果类型"（通常是一个 switch 语句）。
 *
 * 判别联合设计：
 *   - "ok"       → 正常，调用方继续流程，读 output.modified / output.messages
 *   - "error"    → 终止，调用方拿 AgentError 构造自己的错误结果
 *   - "aborted"  → 终止，调用方构造 aborted 结果
 *
 *   throw 和 context_overflow 都归到 "error" kind —— 调用方只需 reason:"error"
 *   单一分支，内部 AgentError.type 区分（"unknown" vs "context_overflow"）供
 *   订阅方做差异化 UX。
 */

import { AgentError, toAgentError } from "../types/errors.js";
import type {
  ContextManagerHook,
  ContextManagerInput,
  ContextManagerOutput,
} from "./types.js";

// ─── 类型 ───

/**
 * ContextManagerHook 调用后的归一化终止态。
 *
 * 调用方按 kind 分派到自己的结果 shape，见 agent-loop / run-agent 的使用示例。
 */
export type ContextTermination =
  | { readonly kind: "ok"; readonly output: ContextManagerOutput }
  | { readonly kind: "error"; readonly error: AgentError }
  | { readonly kind: "aborted" };

// ─── 实现 ───

/**
 * 调用 ContextManagerHook.onTurnComplete，归一化为 ContextTermination。
 *
 * 归一化规则（按优先级）：
 *   1. `hook === undefined` → ok（modified:false，messages 原样返回）
 *      —— agent-loop 的 contextManager 是 optional 参数，缺失时继续流程
 *   2. hook 抛错 + abortSignal.aborted → aborted
 *      —— **abort 优先于任何错误**（和下面 #3 的 failed 路径对称）：
 *         内置 strategies（llm-summarize / memory-flush）都会 try-catch AbortError
 *         并静默返 compacted:false，走 #3 的 failed 路径；但未来第三方 strategy
 *         若忘了捕获，engine 会 rethrow。此时用户意图仍是 abort，不能归为
 *         provider_error/unknown —— 否则 transcript/UI 报错而非"用户中止"
 *   3. hook 抛错 + 非 abort → error（toAgentError 包装，保留原 type/cause）
 *   4. output.failed + abortSignal.aborted → aborted
 *      —— abort 优先于 context_overflow：长 session 里 abort 恰好发生在
 *         compact 期间时，strategy 对 abort 静默返 compacted:false，engine 按
 *         critical 返 failed:true；若不先查 abortSignal 会把用户意图归类为
 *         "上下文耗尽"，transcript/UI 全错位
 *   5. output.failed + 非 abort → error (context_overflow)
 *      —— 事务化后（含 critical force-apply）仍压不回 non-critical，非可恢复
 *   6. 正常 → ok（调用方按 output.modified / output.messages 继续）
 *
 * @param pathLabel 错误消息里的上下文标记，用于调用方诊断（如
 *   "pure-text return" / "tool loop" / "pre-flight"）。
 */
export async function resolveContextManager(
  hook: ContextManagerHook | undefined,
  input: ContextManagerInput,
  abortSignal: AbortSignal | undefined,
  pathLabel: string,
): Promise<ContextTermination> {
  if (!hook) {
    return {
      kind: "ok",
      output: { messages: [...input.messages], modified: false },
    };
  }

  let output: ContextManagerOutput;
  try {
    output = await hook.onTurnComplete(input);
  } catch (e) {
    // abort 优先于任何抛错 —— 见函数 docblock 规则 #2
    if (abortSignal?.aborted) {
      return { kind: "aborted" };
    }
    return { kind: "error", error: toAgentError(e) };
  }

  if (output.failed) {
    if (abortSignal?.aborted) {
      return { kind: "aborted" };
    }
    return {
      kind: "error",
      error: new AgentError(
        `Context exhausted: compact failed even in force-apply mode (${pathLabel} path)`,
        "context_overflow",
        false,
      ),
    };
  }

  return { kind: "ok", output };
}
