/**
 * 智能体事件映射表
 *
 * 与 EventBus<AgentEventMap> 配合使用，定义智能体运行时的所有可观测事件。
 * 这是知行相比 OpenClaw/Claude Code 的核心差异之一 —— 一等公民的可观测性。
 *
 * 命名约定：`{模块}:{动作}`
 * - agent:   顶层生命周期
 * - llm:     LLM 调用
 * - tool:    工具执行
 * - context: 上下文管理
 * - error:   错误
 *
 * 扩展方式：向此类型添加新字段即可，EventBus 泛型会自动约束。
 *
 * 使用 type 而非 interface：
 * TypeScript 的 interface 没有隐式索引签名，无法满足 EventMap (Record<string, unknown>) 约束。
 * type 别名有隐式索引签名，与泛型约束配合更自然。
 * 扩展事件时直接修改此定义，或使用交叉类型 AgentEventMap & { ... }。
 */

import type { AgentErrorType } from "./errors.js";
import type { StreamEvent, StopReason, TokenUsage } from "./llm.js";
import type { CompactStrategyContribution } from "../context/types.js";

/**
 * Agent Loop 终止原因。
 * 与 LLM 的 StopReason 语义不同 —— StopReason 是单次 LLM 调用的停止原因，
 * AgentRunEndReason 是整个循环的终止原因。
 */
export type AgentRunEndReason = "completed" | "max_turns" | "aborted" | "error";

export type AgentEventMap = {
  // ─── Agent 生命周期 ───

  "agent:run_start": {
    prompt: string;
  };

  "agent:run_end": {
    reason: AgentRunEndReason;
    duration: number;
    usage: TokenUsage;
    error?: string;
  };

  // ─── LLM 调用 ───

  "llm:request_start": {
    model: string;
    messageCount: number;
    hasTools: boolean;
  };

  /** 流式事件透传，供 UI 层消费实现实时输出 */
  "llm:stream_event": StreamEvent;

  "llm:request_end": {
    model: string;
    duration: number;
    usage: TokenUsage;
    stopReason: StopReason;
  };

  // ─── 工具执行 ───

  "tool:call_start": {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };

  "tool:call_end": {
    id: string;
    name: string;
    duration: number;
    success: boolean;
    resultSize: number;
  };

  "tool:permission_request": {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };

  "tool:permission_result": {
    id: string;
    name: string;
    allowed: boolean;
  };

  // ─── 上下文管理 ───

  /**
   * 预算检查事件 —— 在 compact 事务前后各 fire 一次。
   *
   * phase:
   *   - "pre-compact": onTurnComplete 初始检查，订阅方据此判断是否需要压缩 UI 预警
   *   - "post-compact": strategies 循环结束后的状态，订阅方可用于指标对比；
   *     仅在实际进入 strategies 循环路径上 fire（早退的 normal/warning 场景不 fire）
   */
  "context:budget_check": {
    phase: "pre-compact" | "post-compact";
    currentTokens: number;
    effectiveWindow: number;
    usageRatio: number;
    status: "normal" | "warning" | "compact" | "critical";
  };

  /**
   * compact 事务开始锚点 —— 一次 compact 事务仅 fire 一次，不带 strategy 名。
   * UI 消费它显示"压缩中"spinner；事务结束时 compact_end 关闭 spinner。
   *
   * 事务化规则：仅在第一个 strategy.canApply 通过时 fire；
   * 如果所有 strategies canApply 都返回 false，compact_start 不 fire。
   */
  "context:compact_start": {
    tokensBefore: number;
  };

  /**
   * compact 事务结束 —— 一次 compact 事务仅 fire 一次，payload 汇总所有贡献。
   *
   * strategies[]: 本次事务内每个跑过的 strategy 的独立记录（按执行顺序）。
   * 汇总字段：
   *   summary     = strategies 中最后一个非空 summary（当前仅 LLMSummarize 产）
   *   turnsCompacted = 所有 strategy.turnsCompacted 求和（当前仅 LLMSummarize 一个值）
   *
   * 幂等保证：compact_start fire 过则必然有对应的 compact_end（try-finally 保护）。
   */
  "context:compact_end": {
    strategies: readonly CompactStrategyContribution[];
    summary?: string;
    turnsCompacted?: number;
    tokensBefore: number;
    tokensAfter: number;
  };

  "context:calibrate": {
    estimated: number;
    actual: number;
    newRatio: number;
  };

  // ─── 容错 / 重试 ───

  "retry:attempt": {
    errorType: AgentErrorType;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    willRetry: boolean;
  };

  "retry:exhausted": {
    errorType: AgentErrorType;
    totalAttempts: number;
    lastError: string;
  };

  "retry:success": {
    errorType: AgentErrorType;
    attemptsTaken: number;
    totalDelayMs: number;
  };

  // ─── 错误 ───

  "error:recoverable": {
    type: string;
    message: string;
    willRetry: boolean;
    attempt: number;
  };

  "error:fatal": {
    type: string;
    message: string;
  };
};
