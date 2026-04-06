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

import type { StreamEvent, StopReason, TokenUsage } from "./llm.js";

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

  "context:compact_start": {
    strategy: string;
    tokensBefore: number;
  };

  "context:compact_end": {
    strategy: string;
    tokensBefore: number;
    tokensAfter: number;
    success: boolean;
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
