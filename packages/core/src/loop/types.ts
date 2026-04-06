/**
 * Agent Loop 类型定义
 *
 * 设计原则：
 * - 不可变状态：每次迭代重建 LoopState，借鉴 Claude Code 的不可变转换模式
 * - 判别联合终止原因：AgentResult 穷尽枚举循环停止的所有理由
 * - AsyncGenerator 语义：yield AgentYield 给消费者，return AgentResult 作为最终结果
 * - 依赖注入：AgentLoopDeps 允许测试时替换 LLM 调用和工具执行
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import type { AgentError } from "../types/errors.js";
import type { ChatRequest, LLMProvider, StopReason, StreamEvent, TokenUsage } from "../types/llm.js";
import type { Message } from "../types/messages.js";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../types/tools.js";

// ─── Agent Loop 参数 ───

export interface AgentLoopParams {
  /** LLM Provider 实例 */
  provider: LLMProvider;
  /** 使用的模型 ID */
  model: string;
  /** 可用工具列表 */
  tools?: ToolDefinition[];
  /** 系统提示 */
  systemPrompt?: string;
  /** 初始消息（至少包含一条 user 消息） */
  messages: Message[];
  /** 最大 LLM↔工具交互轮次，达到后终止。默认 100 */
  maxTurns?: number;
  /** 工具执行的工作目录。默认 process.cwd() */
  workingDirectory?: string;
  /** 中止信号 */
  abortSignal?: AbortSignal;
  /** 事件总线（可观测性） */
  eventBus?: IEventBus<AgentEventMap>;
  /** 覆盖默认依赖（用于测试） */
  deps?: Partial<AgentLoopDeps>;
}

// ─── 依赖注入 ───

export interface AgentLoopDeps {
  /**
   * 发起 LLM 流式调用。默认实现委托给 provider.chat()。
   * 替换此函数可拦截/修改 LLM 请求（如日志、缓存、降级）。
   */
  callLLM: (request: ChatRequest) => AsyncGenerator<StreamEvent, void, undefined>;
  /**
   * 执行单个工具。默认实现委托给 tool.call()。
   * 替换此函数可拦截工具执行（如权限检查、沙箱、审计）。
   */
  executeTool: (
    tool: ToolDefinition,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<ToolResult>;
}

// ─── 循环状态（不可变） ───

export interface LoopState {
  readonly messages: readonly Message[];
  readonly turnCount: number;
  readonly totalUsage: TokenUsage;
  readonly transition?: { readonly reason: ContinueReason };
}

// ─── 终止结果（判别联合） ───

export type AgentResult =
  | { readonly reason: "completed"; readonly message: Message; readonly usage: TokenUsage }
  | { readonly reason: "max_turns"; readonly usage: TokenUsage }
  | { readonly reason: "aborted"; readonly usage: TokenUsage }
  | { readonly reason: "error"; readonly error: AgentError; readonly usage: TokenUsage };

// ─── 继续原因 ───

export type ContinueReason = "tool_use";

// ─── 消费者可见的 yield 事件 ───

export type AgentYield =
  /** LLM 输出的文本增量（实时流式） */
  | { readonly type: "text_delta"; readonly text: string }
  /** LLM 的思考过程增量（如 Claude extended thinking） */
  | { readonly type: "thinking_delta"; readonly thinking: string }
  /** LLM 响应完成后的完整 assistant 消息（用于持久化/日志） */
  | { readonly type: "assistant_message"; readonly message: Message }
  /** 工具开始执行 */
  | { readonly type: "tool_start"; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  /** 工具执行完成 */
  | { readonly type: "tool_end"; readonly id: string; readonly name: string; readonly result: ToolResult; readonly duration: number }
  /** 一轮 LLM↔工具交互完成 */
  | { readonly type: "turn_complete"; readonly turnCount: number; readonly usage: TokenUsage };

// ─── 内部类型：LLM 调用结果 ───

export interface LLMCallResult {
  readonly message: Message;
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  readonly error?: AgentError;
}
