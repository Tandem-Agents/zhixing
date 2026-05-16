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
  /**
   * Vendor 原样上报的"主输入"计数 —— **跨 provider 语义不一致**:
   *   - OpenAI 兼容族（prompt_tokens）：已含 cache 命中部分，即等于全量输入
   *   - Anthropic（input_tokens）：仅"未命中的新输入"，cache 命中部分单列在
   *     cacheReadTokens / cacheWriteTokens，**不含**在本字段
   *
   * 需要"模型本次实际处理的全量输入"时一律用 {@link getTotalInputTokens}，
   * 不要直接读本字段 —— 否则在 Anthropic 上会系统性低估。anchor / estimator
   * 校准等既有消费方按 vendor 原值消费（语义稳定，本次改造刻意不动）。
   */
  inputTokens: number;
  outputTokens: number;
  /**
   * 模型本次请求实际处理的**全量输入** token（fresh + cache-read + cache-write），
   * provider 无关的规范口径。
   *
   * 由 adapter 边界负责填写，且**仅在 vendor 的 inputTokens ≠ 全量时才需显式设置**
   * （目前只有 Anthropic：input_tokens 排除了 cache）。OpenAI 兼容族 prompt_tokens
   * 本就是全量，可不设 —— {@link getTotalInputTokens} 的 fallback（`?? inputTokens`）
   * 自然得到正确值。契约不变量见 getTotalInputTokens 与 usage-conformance 测试。
   */
  totalInputTokens?: number;
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

/**
 * 规范口径的"本次全量输入" token —— 单一语义权威。
 *
 * = `totalInputTokens`（adapter 显式归一时）`?? inputTokens`（vendor 原值已是
 * 全量，如 OpenAI 兼容族；或 emptyUsage / 非 adapter 构造的兜底）。
 *
 * 想要"模型实际看了多少输入"的消费方（状态区流量、计费、累计）用本函数；
 * 想要 vendor 原始锚点的消费方（anchor / estimator 校准）继续直接读 inputTokens
 * —— 两条路径刻意分离，互不影响。
 *
 * 不变量：返回值 ≥ inputTokens，且 ≥ (cacheReadTokens ?? 0)+(cacheWriteTokens ?? 0)。
 */
export function getTotalInputTokens(usage: TokenUsage): number {
  return usage.totalInputTokens ?? usage.inputTokens;
}

/** 合并两个 TokenUsage（累加） */
export function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    // 规范全量输入按 canonical 口径累加（各侧经 getTotalInputTokens 归一后相加），
    // 与 inputTokens 累加正交 —— 既有读 inputTokens 的消费方逐字节不变。
    totalInputTokens: getTotalInputTokens(a) + getTotalInputTokens(b),
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
 *   message_start →
 *     (thinking_block_start → thinking_delta* → thinking_block_end)?
 *     → (text_delta | tool_call_*)*
 *     → message_end
 *
 * Block 边界事件设计:
 *   - tool_call_start/end:并行多 tool 调用,事件用 id 字段配对
 *   - thinking_block_start/end:单一 thinking 块/message,无 id 配对需求
 *     (anthropic 协议 thinking 块每 message 最多 1 个;openai-compatible reasoning_content
 *     是连续单一逻辑块)
 *
 * 异常路径约定:
 *   - catch err → yield error event + return,**不** emit 任何未关闭的 block_end
 *     (与 tool_call_end 同模式);消费方在 error / dispose 时自行 cleanup 悬挂状态
 */
export type StreamEvent =
  | StreamMessageStart
  | StreamTextDelta
  | StreamThinkingBlockStart
  | StreamThinkingDelta
  | StreamThinkingBlockEnd
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

/**
 * Thinking 块开始 —— 与 StreamToolCallStart 对称的显式边界事件。
 *
 * 消费方据此知道"thinking 流即将开始"(开 segment / 准备 UI / 累积 buffer 等),
 * 不需要从 thinking_delta 首次出现自行推断,避免边界状态隐式化。
 *
 * thinking 块在 anthropic 协议下 message 内最多一个;openai-compatible 路径下
 * reasoning_content 也是连续单一逻辑块。因此不需要 id 字段配对
 * (与 tool_call_start 多并行场景不同)。
 */
export interface StreamThinkingBlockStart {
  type: "thinking_block_start";
}

export interface StreamThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}

/**
 * Thinking 块结束 —— 与 StreamToolCallEnd 对称的显式边界事件。
 *
 * 消费方据此 commit/close 与 thinking 关联的资源(segment / buffer / UI 段等)。
 * 异常路径(catch err)不 emit 本事件,消费方需在 error event / dispose 时自行
 * cleanup 悬挂状态,与 tool_call_end 异常路径约定一致。
 */
export interface StreamThinkingBlockEnd {
  type: "thinking_block_end";
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
 * 三角色（角色集单一事实源 = `@zhixing/providers` 的 ROLE_SPECS 注册表，
 * 本接口键与注册表 id 一一对应；新增角色 = 注册表加一行 + 本接口加一字段）：
 *   - main ：必填，主对话循环 / 用户可见输出
 *   - light：选填，后台杂活（上下文压缩 / WebFetch 蒸馏 / 工具结果摘要 /
 *            子 agent 返回压缩 / 入站分类）
 *   - power：选填，重活槽（编程等高难任务），模型档位由用户决定；当前仅
 *            基础设施就位，消费者按需接入（不预绑任何调用点）
 *
 * 不变量：
 * 1. LLMRoles 一旦构造，main / light / power 都必定可调用——用户没显式配
 *    某辅助角色（light / power）时，该角色自动用 main 实例 + main.model 兜底
 *    （隔离价值仍保留，仅放弃任务专门化/cost 优化）。这不是降级，是合理的
 *    未配置默认；工厂层不预设任何 vendor 默认（见 providers/create-provider.ts
 *    与 secondary-llm-capability.md ADR-SLLM-004）。
 * 2. roles.main.{provider,model} 反映会话**实际使用的** effective state——含
 *    任何 CLI override（如 --provider / --model）。consumer 读到的就是
 *    runtime 实际跑的 provider+model。
 * 3. ToolExecutionContext.llm 字段是 optional——入口正常注入，单测/自动化
 *    路径可能不注入。consumer 必须显式分支处理 !ctx.llm。
 *
 * Provider 实例复用：辅助角色与 main 用同一 provider id 时共享 LLMProvider
 * 实例（连接池/限速/cache 共用）。这是优化不是契约——consumer 不应用 ===
 * 比较 provider 实例。
 */
export interface LLMRoles {
  main: LLMRole;
  light: LLMRole;
  power: LLMRole;
}
