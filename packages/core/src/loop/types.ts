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
import type { ContextManagerHook, ContextBudget } from "../context/types.js";
import type { CompactMarker, Turn } from "../transcript/types.js";

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
  /**
   * 上下文管理器。
   * 每轮工具执行后，Agent Loop 调用 onTurnComplete() 让上下文管理器
   * 检查预算并执行压缩。可选 — 不传则不做上下文管理。
   */
  contextManager?: ContextManagerHook;
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

// ─── Runtime 层 Run 返回值 ───

/**
 * 一次 AgentRuntime / SessionRuntime run() 的完整结果 —— 跨 cli/server 统一契约。
 *
 * 和 AgentResult 的区别：
 *   - AgentResult 是 agent-loop 内部的"终止原因"（completed / max_turns / aborted / error）
 *   - RunResult 是外层 runtime 一次 run() 的整体产出，**包装** AgentResult + 持久化单元
 *     + 本 run 压缩边界 + 诊断字段
 *
 * 设计（详见 research/design/drafts/transcript-retention.md §0.7.1 单向数据流）：
 *   run-agent 闭包订阅 compact_end → 组装 CompactMarker →
 *   RunResult { turn, compactBefore? } → 调用方 →
 *   TranscriptStore.commitTurn → canonical 回喂 state.messages
 *
 * 放在 core/loop 而非 cli 的原因：
 *   - cli 的 AgentRuntime 和 server 的 SessionRuntime 都要 return 此类型
 *   - 跨包共享契约必须在 core，否则两端类型漂移
 */
export interface RunResult {
  /** Agent loop 终止结果（原因 + usage + 可能的 error / completed message） */
  readonly agentResult: AgentResult;

  /**
   * 持久化单元 —— 本 run 完整的 user+assistant+toolCalls 记录。
   *
   * 由 `buildTurn()` 在 run 结束前组装。即使 abort / error 路径也会构造（assistant
   * 可能为空内容），保证调用方 commitTurn 的入参永远有 turn 可用。
   */
  readonly turn: Turn;

  /**
   * 本 run 期间累积的最后一次摘要型 compact 边界。
   *
   * 语义：`turnsCompacted` 是本 run 内**累积替代的文件 Turn 总数**
   * （多触发点累加，见 L1 累积算法）。commitTurn 按此值切分磁盘 turns
   * 保留末尾。
   *
   * 非摘要型压缩（ToolResultTrim / MessageDrop 等）不填此字段 ——
   * 它们不替代文件 Turn，只是内存 tier 级裁剪，不影响持久化边界。
   */
  readonly compactBefore?: CompactMarker;

  /**
   * 本 run yield 流重建的原始新消息增量（与 canonical 正交）。
   *
   * 用途：技能提议检测（扫 assistant 文本）、技能效果推断、诊断日志、
   * 非 REPL 单次运行的输出显示。
   *
   * 不用于状态同步（后者由 commitTurn 返回的 canonical 承担）。
   */
  readonly newMessages: Message[];

  /** 诊断：本 run 耗时（ms） */
  readonly durationMs: number;

  /** 诊断：本 run 工具完成次数（tool_end 事件数），供反思触发 */
  readonly toolEndCount: number;

  /** 诊断：本 run 注入的技能 id 列表，供效果推断 */
  readonly injectedSkillIds: string[];

  /**
   * 诊断：run 结束后的预算快照。
   *
   * 可选 —— 极端错误路径（如 pre-flight engine 抛错但 budget
   * 暂未算出）允许省略；正常路径应填充以便调用方做 UI 预算显示。
   */
  readonly budget?: ContextBudget;
}
