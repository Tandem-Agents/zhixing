/**
 * LLM Provider 抽象层类型定义
 *
 * 设计原则：
 * - 薄抽象：只统一三件事 — 调用接口、流式响应、Token 计数
 * - 不做缓存、重试、Failover — 那是编排层的职责
 * - Provider 实现负责将内部类型与厂商 SDK 类型互转
 * - AsyncGenerator 作为流式接口：天然支持背压、取消、组合
 *
 * 对比 OpenClaw 的 Pi-ai：它封装了计费和模型注册。
 * 我们的抽象更薄 — Provider 只管 LLM 通信，其他职责上移。
 */

import type { Message } from "./messages.js";
import type { ToolSpec } from "./tools.js";

// ─── 停止原因 ───

export type StopReason =
  /** 模型正常结束输出 */
  | "end_turn"
  /** 模型请求执行工具（对话应继续） */
  | "tool_use"
  /** 达到最大输出 token 数 */
  | "max_tokens"
  /** 命中停止序列 */
  | "stop_sequence";

// ─── Token 统计 ───

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt caching：缓存命中的输入 token 数 */
  cacheReadTokens?: number;
  /** Anthropic prompt caching：写入缓存的输入 token 数 */
  cacheWriteTokens?: number;
}

/** 创建空的 TokenUsage */
export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

/** 合并两个 TokenUsage（累加） */
export function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens:
      a.cacheReadTokens || b.cacheReadTokens
        ? (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
        : undefined,
    cacheWriteTokens:
      a.cacheWriteTokens || b.cacheWriteTokens
        ? (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
        : undefined,
  };
}

// ─── 模型信息 ───

export interface ModelInfo {
  /** 模型标识符，如 'claude-sonnet-4-20250514' */
  id: string;
  /** 显示名称 */
  name: string;
  /** 提供商标识，如 'anthropic'、'openai' */
  provider: string;
  /** 上下文窗口大小（token 数） */
  contextWindow: number;
  /** 最大输出 token 数 */
  maxOutputTokens: number;
  /** 是否支持 extended thinking */
  supportsThinking?: boolean;
  /** 是否支持图片输入 */
  supportsImages?: boolean;
  /** 是否支持工具调用 */
  supportsTools?: boolean;
}

// ─── 对话请求 ───

export interface ChatRequest {
  /** 使用的模型 ID */
  model: string;
  /** 系统提示（独立于对话消息，由上下文引擎组装） */
  systemPrompt?: string;
  /** 对话消息列表 */
  messages: Message[];
  /** 可用工具声明 */
  tools?: ToolSpec[];
  /** 最大输出 token 数（覆盖模型默认值） */
  maxTokens?: number;
  /** 温度（0-1） */
  temperature?: number;
  /** 停止序列 */
  stopSequences?: string[];
  /** 中止信号 */
  abortSignal?: AbortSignal;
}

// ─── 流式事件（判别联合） ───

/**
 * LLM 流式响应事件。
 *
 * Provider 实现将厂商特定的流事件统一转换为这些类型。
 * 使用判别联合，消费方可通过 switch(event.type) 做穷尽匹配。
 *
 * 事件时序：
 *   message_start → (text_delta | thinking_delta | tool_call_*)* → message_end
 */
export type StreamEvent =
  | StreamMessageStart
  | StreamTextDelta
  | StreamThinkingDelta
  | StreamToolCallStart
  | StreamToolCallDelta
  | StreamToolCallEnd
  | StreamMessageEnd
  | StreamError;

export interface StreamMessageStart {
  type: "message_start";
  messageId?: string;
}

export interface StreamTextDelta {
  type: "text_delta";
  text: string;
}

export interface StreamThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}

export interface StreamToolCallStart {
  type: "tool_call_start";
  id: string;
  name: string;
}

/** 工具调用参数的增量片段（流式 JSON 拼接） */
export interface StreamToolCallDelta {
  type: "tool_call_delta";
  id: string;
  argsFragment: string;
}

export interface StreamToolCallEnd {
  type: "tool_call_end";
  id: string;
}

export interface StreamMessageEnd {
  type: "message_end";
  stopReason: StopReason;
  usage: TokenUsage;
}

export interface StreamError {
  type: "error";
  error: Error;
}

// ─── LLM Provider 接口 ───

export interface LLMProvider {
  /** 提供商标识符，如 'anthropic'、'openai' */
  readonly id: string;

  /** 此 Provider 支持的模型列表 */
  readonly models: readonly ModelInfo[];

  /**
   * 发起流式对话请求。
   * 返回 AsyncGenerator，逐个产出 StreamEvent。
   *
   * 为什么用 AsyncGenerator 而不是 EventEmitter / ReadableStream：
   * - 天然背压：消费者 next() 才推进
   * - 可组合：yield* 组合子生成器
   * - 可取消：通过 AbortSignal 或 generator.return()
   * - 类型安全：每个 yield 都有明确类型
   */
  chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined>;

  /**
   * 估算消息列表的 token 数量。
   * 并非所有 Provider 都支持精确计数。
   */
  countTokens?(messages: Message[], model: string): Promise<number>;
}
