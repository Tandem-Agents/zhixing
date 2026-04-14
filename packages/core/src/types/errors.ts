/**
 * 错误类型系统
 *
 * 设计原则：
 * - 分类优先：每个错误携带类型标签，编排层据此决定恢复策略
 * - 可恢复性显式声明：不靠 instanceof 猜测，直接标注 recoverable
 * - 与 LLM 错误对齐：类型覆盖 Anthropic/OpenAI 常见错误场景
 *
 * 对比 OpenClaw：它在外层循环里用大量 if/else 判断错误类型。
 * 我们用结构化的错误类型，让恢复逻辑更清晰。
 */

/**
 * 错误类型枚举。
 * 编排层根据此分类决定恢复策略（重试、Failover、中止等）。
 */
export type AgentErrorType =
  /** API 速率限制（429） */
  | "rate_limit"
  /** 请求超时 */
  | "timeout"
  /** 网络连接失败 */
  | "network"
  /** 上下文窗口溢出（413 / prompt_too_long） */
  | "context_overflow"
  /** 认证失败（401 / 403） */
  | "auth"
  /** 请求参数无效（400） */
  | "invalid_request"
  /** LLM Provider 返回的其他错误（500 等） */
  | "provider_error"
  /** 工具执行失败 */
  | "tool_error"
  /** 用户主动中止 */
  | "aborted"
  /** 未归类的错误 */
  | "unknown";

/**
 * 智能体错误。
 * 所有从 Agent 核心抛出的错误都应该是此类型或其子类。
 */
export class AgentError extends Error {
  override readonly name = "AgentError";

  constructor(
    message: string,
    /** 错误分类，用于决定恢复策略 */
    readonly type: AgentErrorType,
    /** 此错误是否可以通过重试/Failover 恢复 */
    readonly recoverable: boolean,
    /** 原始错误（如果是从其他错误转换而来） */
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** 判断一个未知错误是否为 AgentError */
export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}

/** 将任意错误包装为 AgentError（如果已经是则直接返回） */
export function toAgentError(error: unknown): AgentError {
  if (isAgentError(error)) return error;

  const message =
    error instanceof Error ? error.message : String(error);

  return new AgentError(message, "unknown", false, error);
}

// ─── 用户面向错误 ───

/**
 * 用户面向错误标记——携带该标记的 error 其 message 已经是可以直接展示给
 * 用户（和 LLM）的文本，不应再被包上 "Tool execution failed: " 等技术前缀。
 *
 * 典型场景：
 *   - `SecurityBlockError`（用户主动拒绝工具调用）：message 形如
 *     `"用户拒绝此操作。反馈：不要用 rm"`，应原样作为 tool_result 回送给模型，
 *     让模型据此调整行为。
 *   - `PlanModeRejectionError`（计划模式用户否决）：同理。
 *
 * 设计决策：
 *   - **接口而非类**：core 不引入新的错误继承树，cli 等上层只需在自己的
 *     错误类上加一行 `readonly userFacing = true as const` 即可。
 *   - **type guard 而非 instanceof**：避免 core 依赖 cli。
 */
export interface UserFacingError extends Error {
  readonly userFacing: true;
}

/**
 * 判断一个错误是否为用户面向错误。
 * tool-executor 用它决定是否给 error message 加前缀。
 */
export function isUserFacingError(error: unknown): error is UserFacingError {
  return (
    error instanceof Error &&
    (error as Error & { userFacing?: unknown }).userFacing === true
  );
}
