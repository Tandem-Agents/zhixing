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
  /**
   * Prompt cache 命中的输入 token 数（被缓存复用、计费打折的那部分）。
   *
   * Provider 方言归一字段：
   *   - Anthropic: cache_read_input_tokens
   *   - OpenAI / MiniMax / 大多数 OpenAI 兼容: prompt_tokens_details.cached_tokens
   *   - DeepSeek: prompt_cache_hit_tokens
   * 字段缺失或值为 0 时不填（undefined），与 mergeUsage 的 truthy 合并语义一致。
   */
  cacheReadTokens?: number;
  /**
   * 本次请求新写入缓存的输入 token 数（计费按 cache write 倍率）。
   *
   * 仅 Anthropic 显式 cache_control 协议返回此维度（cache_creation_input_tokens）。
   * OpenAI 兼容协议下 vendor 多为服务端自动缓存，无显式 write 维度，留 undefined。
   */
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

/**
 * Model 自身的元信息——budget 信息 + 能力声明。
 *
 * 不含 provider id：ModelInfo 总是嵌套在 LLMProvider.models[] 内，provider 归属
 * 由结构隐含；在 ModelInfo 里再带一份是反范式冗余。consumer 需要 provider id
 * 时通过 LLMProvider.id 获取。
 *
 * supports* 字段是 model-level capability 声明（与 ProviderQuirks 的 provider-level
 * 行为差异不同维度）。运行时协议透传不依赖此声明 —— openai-compatible adapter 走
 * 协议级处理（字段缺失自动跳过），不读取 capability。这些字段为上层场景提供 UI
 * 语义信号：model picker / 思考能力标签 / 选择面板高亮等。可选字段，不强制声明。
 */
export interface ModelInfo {
  /** 模型标识符，如 'claude-sonnet-4-20250514' */
  id: string;
  /** 显示名称 */
  name: string;
  /** 上下文窗口大小（token 数） */
  contextWindow: number;
  /** 最大输出 token 数 */
  maxOutputTokens: number;
  /**
   * 是否支持 thinking 模式（extended thinking / reasoning trace / 思考输出）。
   * UI 语义信号；运行时 reasoning_content 透传不依赖此字段（协议级处理）。
   */
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

  /**
   * Provider 实例上 declared 的 model catalog（已知模型元信息列表）。
   *
   * 语义：catalog 是"这个实例上元信息已知的 model"，不是"实例只能跑这些 model"——
   * `chat({ model })` 接受任何字符串，catalog 之外的 model 也能正常请求 LLM。
   * catalog 的唯一用途是给上下文工程的 budget 解析（resolveModelInfo）提供数据。
   *
   * 不同 provider 类型的典型形态：
   *   - 绑定型 provider（如 anthropic）：catalog 列出已知 claude-* 模型
   *   - 网关型 provider（如 OpenAI 兼容、聚合站、私有部署）：通常返回 []，
   *     一个实例承载海量 model，无法预先列举
   *
   * 不变量：catalog 不得包含占位条目（id="unknown" 等）；缺失就返回 []。
   * Budget 兜底由 resolveModelInfo 的 protocolDefaults / CONSERVATIVE_FALLBACK 承担。
   */
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

// ─── LLM 角色（会话级 capability） ───

/**
 * 单个 LLM 角色实例：Provider 实例 + 绑定的 model + 便捷调用方法。
 *
 * 角色绑定使 consumer 不必重复传 model；caller 也可绕过 chat() 直接调
 * provider.chat({ ..., model })，但推荐通过 LLMRole 减少跨 consumer 的
 * "忘传 model"错误。
 */
export interface LLMRole {
  readonly provider: LLMProvider;
  readonly model: string;
  chat(
    request: Omit<ChatRequest, "model">,
  ): AsyncGenerator<StreamEvent, void, undefined>;
  countTokens?(messages: Message[]): Promise<number>;
}

/**
 * 会话级可用的 LLM 角色集合。
 *
 * 不变量：
 * 1. LLMRoles 一旦构造，main 与 secondary 都必定可调用——用户没显式配
 *    llm.secondary 时，secondary 自动用 main 实例 + main.model 兜底（隔离价值
 *    仍保留，仅放弃任务专门化/cost 优化）。这不是降级，是合理的未配置默认；
 *    工厂层不预设任何 vendor 默认（见 providers/create-provider.ts 与
 *    secondary-llm-capability.md ADR-SLLM-004）。
 * 2. roles.main.{provider,model} 反映会话**实际使用的** effective state——含
 *    任何 CLI override（如 --provider / --model）。consumer 读到的就是
 *    runtime 实际跑的 provider+model。
 * 3. ToolExecutionContext.llm 字段是 optional——入口正常注入，单测/自动化
 *    路径可能不注入。consumer 必须显式分支处理 !ctx.llm。
 *
 * Provider 实例复用：当 secondary 与 main 用同一 provider id 时共享 LLMProvider
 * 实例（连接池/限速/cache 共用）。这是优化不是契约——consumer 不应用 ===
 * 比较 provider 实例。
 */
export interface LLMRoles {
  main: LLMRole;
  secondary: LLMRole;
}
