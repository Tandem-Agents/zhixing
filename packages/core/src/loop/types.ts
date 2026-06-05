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
import type {
  AgentEventMap,
  WorkModeSwitchIntent,
} from "../types/agent-events.js";
import type { AgentError } from "../types/errors.js";
import type {
  ChatRequest,
  LLMProvider,
  LLMRoles,
  ResolvedRoleThinking,
  StopReason,
  StreamEvent,
  ThinkingConfig,
  TokenUsage,
} from "../types/llm.js";
import type { Message, ToolResultBlock, ToolUseBlock } from "../types/messages.js";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../types/tools.js";
import type {
  ContextBudget,
  ContextManagerHook,
  ITokenEstimator,
} from "../context/types.js";
import type { SegmentManager } from "../context/segment/segment-manager.js";
import type { TurnContextInjector } from "../context/turn-context.js";
import type { CompactMarker, Turn } from "../transcript/types.js";
import type { AbortReason, WatchdogPolicy } from "../interrupt/types.js";

// ─── 注意力窗口换代 ───

/** 注意力窗口换代的触发原因 —— 段切换 / budget 压缩。 */
export type WindowChangeReason = "segment-transition" | "compact";

/**
 * 注意力窗口换代回调契约 —— run 内上下文重构后由 agent-loop 调用。
 * 装配方实现它(触发窗口生命周期钩子 + 重建 per-run 局部 prompt);agent-loop 只
 * 负责在重构改完 messages 后、下个 LLM call 之前调一次。
 */
export interface WindowLifecycle {
  onChange(reason: WindowChangeReason): Promise<void>;
}

// ─── Agent Loop 参数 ───

export interface AgentLoopParams {
  /** LLM Provider 实例 */
  provider: LLMProvider;
  /** 使用的模型 ID */
  model: string;
  /**
   * 该次运行所用 role 的思考控制 —— 装配期按主对话实际 role 注入，
   * 透传到每次 LLM call 的 ChatRequest。缺省 = 不发送思考参数。
   */
  thinking?: ThinkingConfig;
  /** 可用工具列表 */
  tools?: ToolDefinition[];
  /**
   * 系统提示(固定值)。与 getSystemPrompt 二选一(同传时 getSystemPrompt 优先)。
   * sub-agent / 单测等不在 run 内重建 system prompt 的路径传此固定串。
   */
  systemPrompt?: string;
  /**
   * 系统提示的现取函数 —— 每个 LLM call 前调一次取当前值。主对话路径传此函数
   * (绑 per-run 局部 prompt),让注意力窗口边界重建后的 system prompt 在下个 call
   * 生效。缺省时回退到固定 systemPrompt。
   */
  getSystemPrompt?: () => string;
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
   * 上下文管理器 —— budget-driven 兜底（按上下文窗口百分比触发压缩）。
   *
   * 每个 turn 结束时由 turn-end 钩子调用 onTurnComplete() 检查预算并按需压缩。
   * 可选 —— 不传则不做 budget 兜底。
   *
   * 与 segmentManager（attention-driven 主路径）在 turn-end 钩子内并列调用，
   * budget 兜底先于 attention 切段，详见 loop/turn-end.ts。
   */
  contextManager?: ContextManagerHook;
  /**
   * 会话级 LLM 角色集合。注入到每个工具调用的 ToolExecutionContext.llm，
   * 供工具在 I/O 边界使用 light 角色做信息净化（如 WebFetch distill）。
   *
   * 可选——单测 / 极简自动化路径可不传，consumer 必须显式分支处理 !ctx.llm。
   * 见 research/design/specifications/secondary-llm-capability.md §三。
   */
  llmRoles?: LLMRoles;
  /**
   * 各角色装配期已解析的思考控制 —— 与 llmRoles 平行、同路径注入到
   * ToolExecutionContext.roleThinking，让工具在 I/O 边界调对应角色时遵循
   * 用户思考配置。可选——缺省时工具不发思考参数（安全兜底）。
   */
  roleThinking?: ResolvedRoleThinking;
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
   * Per-turn 动态上下文注入器 —— 每次 LLM call 之前把 `<turn-context>` 块
   * 注入到最新 user message。
   *
   * 缺省时不注入。注册时由 caller 在外部完成 provider 注册（如 TimeProvider /
   * SchedulerProvider 等），agent-loop 仅按调用约定每次 LLM call 之前调一次 inject。
   */
  turnContextInjector?: TurnContextInjector;
  /**
   * Token 估算器 —— 仅用于 per-LLM-call 校准。
   *
   * 缺省时不做任何校准（向后兼容）。注册时 agent-loop 在每次成功的 LLM call 后用
   * `estimateMessages(messagesForLLM)` ↔ `llmResult.usage.inputTokens` 校准，让系数
   * 与 LLM 实际处理的 size（turn-context 注入后的 messages）对账，而不是
   * 与数据层 state.messages 对账（后者会因 turn-context 注入产生系统性偏差）。
   *
   * 校准发生在 abort / error 路径之前的成功分支，inputTokens > 0 时才生效。
   */
  tokenEstimator?: ITokenEstimator;
  /**
   * Attention-driven 段切换管理器 —— attention 阈值触发主路径。
   *
   * 缺省时不做段切换。注入后由 turn-end 钩子在每个 turn 结束时调用一次
   * `segmentManager.evaluate`（contextManager budget 兜底之后）；返回
   * modified=true 时用 `newSegmentMessages` 替换 caller 传入的 messages。
   *
   * 段切换失败绝不阻塞 turn（拿原 messages 继续）；budget 兜底机制
   * （contextManager）继续承担"上下文真不够时压缩"职责。
   *
   * 详见 loop/turn-end.ts。
   */
  segmentManager?: SegmentManager;
  /**
   * 当前对话 ID —— 段切换路径需要用它读 task_list 状态、写 segmentMetadata。
   *
   * 缺省（ephemeral 路径：定时任务 / --print）→ 段切换静默 pass，不持久化、
   * 不读 task_list，与 task_list 工具层 / TaskListProvider 同语义降级。
   *
   * 当 segmentManager 注入但 conversationId 缺失时，evaluate 内部会返回
   * decision.kind="pass", reason="no-conversation"，不会污染段切换观测。
   */
  conversationId?: string;
  /**
   * 注意力窗口换代回调 —— agent-loop 在 run 内上下文重构(段切换 / 压缩)改完
   * messages 后、下个 LLM call 之前调一次。装配方(orchestrator)注入,内部据此触发
   * 窗口生命周期钩子并重建 per-run 局部 prompt。缺省时不触发(no-op)。
   */
  windowLifecycle?: WindowLifecycle;
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

/**
 * Token 估算锚点 —— 用 API 真值替代部分字符估算的"已发送 token 真值锚"。
 *
 * ─── 是什么 ───
 *
 * 每次成功 LLM call 后，API 返回 `usage.inputTokens` = LLM 实际处理的总 token
 * 真值（含 system + messages + tools）。agent-loop 把这个真值与当时的
 * `state.messages.length` 配对存为 anchor —— 这是"那一刻 LLM 看到这么多 messages
 * 时真实耗了 X 个 token"的钉子。
 *
 * 下次需要估算"当前上下文有多少 token"时（如 context-tokens snapshot），消费方可
 * 用 anchor 把"已发送部分"按真值锚定，仅对"自 anchor 以来新增的 messages 后缀"
 * 做字符估算。这是业界推测 Claude Code 用的策略 —— 已发送 100% 真值 + 增量字符估算。
 *
 * ─── 与 estimator.calibrate 的关系 ───
 *
 * estimator EMA 校准是"全局 factor 收敛"，对整段 messages 做整体缩放；anchor
 * 是"已确认部分用真值"，两者正交：
 *   - estimator factor 校准对**未锚定**的纯字符估算路径（fallback / SegmentManager
 *     等其他消费者）持续生效
 *   - anchor 路径仅在 turn-end ③ 步消费，把"已发送部分"从 factor × 字符估算
 *     升级为真值锚定
 *
 * ─── 失效语义（自然降级，无需主动 invalidate）───
 *
 * anchor 是"messages[0..baselineMessageCount] 等于 LLM 看到的那批"的不变量
 * 假设。若后续 contextManager 压缩 / SegmentManager 切段让 messages 缩到比
 * baselineMessageCount 还短或前缀变了，消费方应**自动降级到字符估算**（用
 * `messages.length < baselineMessageCount` 判定 + fallback）。
 *
 * 不需要 invalidate：下一次 LLM call 成功又会基于新 messages.length 写新 anchor，
 * 自然刷新。这是用户明确的设计取舍（"段切段失效就失效，下一轮就正常"）。
 *
 * ─── 边界条件 ───
 *
 * `inputTokens` 含本次 LLM call 注入的 turn-context block 字节（~100-300 token，
 * 时间 / 任务状态等）。消费方计算 `anchor.inputTokens + estimateMessages(delta)`
 * 时，物理上重复计了下一次注入的 turn-context（量级 < 5%），属于可接受残余偏差，
 * 不做"减去注入字节"的精细修正（YAGNI）。
 */
export interface TokenAnchor {
  /** API 真值 —— LLM 那一刻处理的总 input token 数（含 system + messages + tools） */
  readonly inputTokens: number;
  /**
   * Anchor 写入时的 `state.messages.length` —— 那一刻 LLM 看到的 messages 数。
   *
   * 消费方契约：把 messages 视为 anchor 时刻的延伸，仅当
   * `messages.length >= baselineMessageCount` 时才能用 anchor + delta 路径
   * （此时 `messages.slice(baselineMessageCount)` 是自 anchor 以来的新增后缀）；
   * 否则降级到全量字符估算。
   *
   * 注：turn-context inject 不改 messages 数组长度（仅给最后一条 user message
   * 加 content block），所以 LLM 视角的 length === state.messages.length。
   */
  readonly baselineMessageCount: number;
}

export interface LoopState {
  readonly messages: readonly Message[];
  readonly turnCount: number;
  readonly totalUsage: TokenUsage;
  readonly transition?: { readonly reason: ContinueReason };
  /**
   * 最近一次成功 LLM call 写入的 token 真值锚点 —— 见 {@link TokenAnchor}。
   *
   * 首次 LLM call 之前为 undefined；之后每次成功 call 都用 `{ ...state, anchor }`
   * 刷新（仅 abort / error / inputTokens=0 路径跳过，因为这些样本不可靠）。
   */
  readonly anchor?: TokenAnchor;
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
  /**
   * LLM thinking 块开始 —— 与 StreamThinkingBlockStart 对称的 AgentYield 边界事件。
   * 消费方(cli output-renderer 等)据此开 thinking 显示区(segment / 状态机),
   * 不再从首个 thinking_delta 推断。透传链路:adapter emit → llm-call 透传 →
   * agent-loop 透传 → 消费方。
   */
  | { readonly type: "thinking_block_start" }
  /** LLM 的思考过程增量（如 Claude extended thinking） */
  | { readonly type: "thinking_delta"; readonly thinking: string }
  /**
   * LLM thinking 块结束 —— 与 StreamThinkingBlockEnd 对称的 AgentYield 边界事件。
   * 消费方据此 commit/close thinking 资源(与 thinking_block_start 配对)。
   */
  | { readonly type: "thinking_block_end" }
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
   * 用途：诊断日志、非 REPL 单次运行的输出显示。
   *
   * 不用于状态同步（后者由 commitTurn 返回的 canonical 承担）。
   */
  readonly newMessages: Message[];

  /** 诊断：本 run 耗时（ms） */
  readonly durationMs: number;

  /**
   * 诊断：run 结束后的预算快照。
   *
   * 可选 —— 极端错误路径（如 pre-flight engine 抛错但 budget
   * 暂未算出）允许省略；正常路径应填充以便调用方做 UI 预算显示。
   */
  readonly budget?: ContextBudget;

  /**
   * 本 run 内产生的工作模式切换意图（turn 内 emit、RunResult 带出，与
   * compactBefore 同构）。accumulator last-wins 收集；
   * 无 emit 时 undefined。仅意图 —— 切换由 REPL 主回路 turn 边界单一事务
   * 消费执行，本字段不触发任何切换。
   */
  readonly pendingModeSwitch?: WorkModeSwitchIntent;
}
