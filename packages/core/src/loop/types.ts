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
import type {
  ChatRequest,
  LLMProvider,
  LLMRoles,
  StopReason,
  StreamEvent,
  TokenUsage,
} from "../types/llm.js";
import type { Message, ToolResultBlock, ToolUseBlock } from "../types/messages.js";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../types/tools.js";
import type {
  ContextBudget,
  ContextManagerHook,
  ITokenEstimator,
} from "../context/types.js";
import type { ContextCompiler } from "../context/compiler/index.js";
import type { TurnContextInjector } from "../context/turn-context.js";
import type { CompactMarker, Turn } from "../transcript/types.js";
import type { AbortReason, WatchdogPolicy } from "../interrupt/types.js";

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
  /**
   * 父 agent 的 abort signal —— 子 agent 路径用,父 abort → 子 agent loop 的 controller
   * 自动 abort with `{ kind: "parent-abort" }` (含 parentReason 链路),子 abort 不影响父。
   *
   * 接 AbortSignal 而非 AbortController:
   * - 与"signal 跨边界传递、controller 仅在创建/触发处持有"命名约定一致
   * - 避免给子 agent 调用方"主动 abort 父"的越权能力(子需要 abort 自己时用自己的 controller)
   *
   * 与 abortSignal 的区别:abortSignal 是外部多源 signal (scheduler timeout / 外部 SDK 等),
   * 触发时走 external reason;parentSignal 触发时走 parent-abort reason,诊断时可区分中断来源。
   * 两者可同时传入 (子 agent 同时受父和外部 scheduler 限时,任一触发都让子 abort)。
   *
   * 缺省时(REPL / 顶层 agent / 单次 runOnce 等无父场景)创建独立 controller。
   */
  parentSignal?: AbortSignal;
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
  /**
   * 会话级 LLM 角色集合。注入到每个工具调用的 ToolExecutionContext.llm，
   * 供工具在 I/O 边界使用 secondary 角色做信息净化（如 WebFetch distill）。
   *
   * 可选——单测 / 极简自动化路径可不传，consumer 必须显式分支处理 !ctx.llm。
   * 见 research/design/specifications/secondary-llm-capability.md §三。
   */
  llmRoles?: LLMRoles;
  /**
   * stream 看门狗策略 —— 控制 LLM 流 chunk 间隔的 idle-timer 行为。
   *
   * 缺省 (`undefined`) 时本层**不** fallback 到默认值 —— 默认 fallback 由调用边界
   * (cli/src/run-agent.ts) 单点注入,保证用户通过 RunParams 显式传入的 policy
   * (包括 `createWatchdogPolicy({ idleTimeoutMs: 0 })` 显式禁用 idle-timer) 一路透传
   * 到看门狗, 不被 agent-loop 二次默认覆盖。
   *
   * 缺省时下游 wrapStreamWithWatchdog 用模块层默认值 DEFAULT_WATCHDOG_POLICY
   * (60s idle, 50% warn) —— 单测路径可省略, 生产路径由 run-agent.ts 显式注入。
   */
  watchdog?: WatchdogPolicy;
  /**
   * 视图层渲染器 —— 每次 LLM call 之前对 messages / tools 做语义编排。
   *
   * 缺省时不做任何编排，messages / tools 直接送 LLM（向后兼容）。
   * 注册了 stage 时按 stage 链顺序串行渲染，输出送给 streamLLMCall。
   */
  contextCompiler?: ContextCompiler;
  /**
   * Per-turn 动态上下文注入器 —— 每次 LLM call 之前把 `<turn-context>` 块
   * 注入到最新 user message。
   *
   * 缺省时不注入。注册时由 caller 在外部完成 provider 注册（如 TimeProvider /
   * SchedulerProvider 等），agent-loop 仅按调用约定每次 LLM call 之前调一次 inject。
   *
   * 与 contextCompiler 顺序：先 compile，再 inject——保证 turn-context 块基于
   * 编排后的 messages 注入到正确位置。
   */
  turnContextInjector?: TurnContextInjector;
  /**
   * Token 估算器 —— 仅用于 per-LLM-call 校准。
   *
   * 缺省时不做任何校准（向后兼容）。注册时 agent-loop 在每次成功的 LLM call 后用
   * `estimateMessages(messagesForLLM)` ↔ `llmResult.usage.inputTokens` 校准，让系数
   * 与 LLM 实际处理的 size（compile + inject 后的 rendered messages）对账，而不是
   * 与数据层 state.messages 对账（后者会因视图层锚化、turn-context 注入产生系统性偏差）。
   *
   * 校准发生在 abort / error 路径之前的成功分支，inputTokens > 0 时才生效。
   */
  tokenEstimator?: ITokenEstimator;
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
  | {
      readonly reason: "max_turns";
      /**
       * 触发上限的具体 turn 数 (来自 AgentLoopParams.maxTurns 或默认 100)。
       * 让 result 自描述, 调用方 (REPL renderSummary 等) 显示 "max turns reached (N)"
       * 时直接读, 无需重复传 maxTurns 参数 / 维持单一事实源。
       */
      readonly maxTurns: number;
      readonly usage: TokenUsage;
    }
  | {
      readonly reason: "aborted";
      readonly usage: TokenUsage;
      /**
       * 类型化中断原因。外部裸 abort()(无 reason 或非本模块识别的 reason)留 undefined,
       * 下游做"未知中断源"分支处理(REPL renderSummary 兜底文案)。
       * 仅出现在 reason="aborted" 分支——max_turns / completed / error 不携带,避免
       * 调用方误以为它们也能读 abortReason。
       */
      readonly abortReason?: AbortReason;
      /**
       * abort 触发到 emit run_end 之间的延迟(ms)。abort listener 注册前已 aborted 的
       * 防御分支未生效时为 undefined。订阅方做 P95 SLO 监控应使用
       * `loopFrameworkDelay = exitDelayMs - toolGraceMs`(后者来自 InterruptFiredEvent)
       * 隔离工具自身 abort 等待消耗。
       */
      readonly exitDelayMs?: number;
    }
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

/**
 * LLM 调用结果 —— 判别联合区分"正常完成"与"被 abort 中断"两种语义。
 *
 * - aborted=false: 正常路径 (含 provider error)，携带完整 message + stopReason；error 字段
 *   仅在 SDK 抛错或 provider error event 时填充，与 abort 严格分离
 * - aborted=true: 被中断路径，**只**携带 partial (text + thinking)，不含 message / stopReason /
 *   error。partial 必须由 cleanup 模块用 assemblePartialMessage 处理后再 yield assistant_message
 *   (含 [interrupted] 标记)，确保 transcript 协议合规
 *
 * 调用方 (agent-loop) 必须先 narrow `result.aborted` 再访问字段。
 */
export type LLMCallResult = LLMCallSuccess | LLMCallAborted;

export interface LLMCallSuccess {
  readonly aborted: false;
  readonly message: Message;
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  /**
   * 流出错 (provider error event / SDK 抛非 abort 错误)。abort 路径不进此 variant，
   * 不会与 abort 语义混淆。
   */
  readonly error?: AgentError;
}

export interface LLMCallAborted {
  readonly aborted: true;
  /**
   * abort 触发瞬间已累积的部分内容。仅承载 text + thinking，**不含** pendingToolCalls
   * (未完成的 tool_use 不能放进 message —— 协议要求每个 tool_use 必有配对 tool_result，
   * partial 中残缺的 tool_use 会让下一轮 LLM 调用报 400)。
   */
  readonly partial: { readonly text: string; readonly thinking: string };
  /**
   * abort 触发瞬间的 token 用量 —— LLM 实际处理的 tokens (可能为 emptyUsage 如果 abort
   * 在 message_end 事件之前触发)。usage 必须如实返回供订阅方统计消耗。
   */
  readonly usage: TokenUsage;
}

// ─── 工具执行结果 ───

/**
 * 工具批量执行结果 —— 判别"完整执行"与"被 abort 部分执行"两种状态。
 *
 * abort 在 tool 循环触发时:
 *   - 已完成的 tool_results 进 completedResults (LLM 在下一轮看到这些工具已执行,
 *     不重发 tool_use 避免幂等性破坏)
 *   - 未执行的 tool_use 进 unexecutedToolUses (按原顺序,完整对象含 id/name/input),
 *     由 cleanup 模块注入合成 tool_result placeholder 保证 messages 协议合规
 *   - abortedDuringToolAt 反映"abort 发生在工具 await 期间"的退出时刻,供 agent-loop
 *     计算 toolGraceMs (workSelectivity SLO 监控隔离 loop 框架延迟与工具自身延迟)
 */
export interface ExecuteToolCallsResult {
  readonly completedResults: readonly ToolResultBlock[];
  /**
   * abort 时未执行的 tool_use (按 LLM 输入顺序保留)。空数组表示所有工具完整执行。
   * 由 cleanup 模块注入合成 placeholder, tool-executor 不自己合成 (单一事实源)。
   */
  readonly unexecutedToolUses: readonly ToolUseBlock[];
  /**
   * abort 触发瞬间正在执行的工具的退出时刻 (`performance.now()` 值)。
   * - abort 发生在工具 await 期间 (无论工具响应 abort 抛 AbortError 还是正常 return) → 有值
   * - abort 发生在工具间隙 (循环顶 guard 触发) → undefined
   * - 非 abort 退出 → undefined
   */
  readonly abortedDuringToolAt?: number;
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
   * 非摘要型压缩（MessageDrop 等）不填此字段 ——
   * 它们不替代文件 Turn，只做内存级裁剪，不影响持久化边界。
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
