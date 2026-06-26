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
import type { Message } from "./messages.js";
import type { ToolSpec } from "./tools.js";
import type { AbortReason } from "../interrupt/types.js";
import type { WindowCompact } from "../context/window/types.js";
import type { SecurityEventMap } from "../security/types.js";

/**
 * Agent Loop 终止原因。
 * 与 LLM 的 StopReason 语义不同 —— StopReason 是单次 LLM 调用的停止原因，
 * AgentRunEndReason 是整个循环的终止原因。
 */
export type AgentRunEndReason = "completed" | "max_turns" | "aborted" | "error";

/**
 * 看门狗预警事件 —— stream chunk 间隔超过 `warnThresholdRatio * idleTimeoutMs`
 * 时由看门狗内部 emit。kind 用 "idle-timeout-warn" 而非 "idle-timeout",和
 * abort 触发后的 IdleTimeoutReason.kind 区分,避免订阅方误以为已经 abort。
 *
 * 仅本规格的看门狗(后续里程碑)产出;早期里程碑里类型已定义但 emit 路径暂缺。
 */
export interface InterruptWarnEvent {
  readonly kind: "idle-timeout-warn";
  /** 距上次 chunk 经过时间(ms) */
  readonly elapsedMs: number;
  /** 即将触发的 idle timeout 阈值(ms) */
  readonly timeoutMs: number;
  /** 触发预警时已收到的 chunk 数 */
  readonly chunksReceived: number;
}

/**
 * 中断触发事件 —— 由 emitRunEnd 在 abort 路径上唯一调一次,严格在 agent:run_end 之前发出。
 *
 * 设计要点:
 * - 单点发射:所有 abort 退出分支只调 emitRunEnd,fired 收敛于此,顺序自动正确、新增分支零负担
 * - exitDelayMs 直接从 AgentResult.exitDelayMs 透传,订阅方零依赖 RunResult 即可监控延迟
 * - reason 可为 null 表示外部裸 abort()(无类型化 reason),不强行编造默认 kind
 * - interruptedTurnIndex 与 turn_complete.turnCount 严格区分:前者是"被中断 turn 0-indexed",
 *   后者是"已完成 turn 数 1-indexed"
 */
export interface InterruptFiredEvent {
  /**
   * 类型化中断原因。外部裸 abort() / 非本模块识别的 reason 为 null,
   * 下游做"未知中断源"分支处理。
   */
  readonly reason: AbortReason | null;
  /**
   * 被中断的 turn 序号(0-indexed),等于 abort 触发瞬间的 state.turnCount。
   * 与 turn_complete.turnCount(已完成 turn 数,1-indexed)语义不同。
   */
  readonly interruptedTurnIndex: number;
  /**
   * abort 触发到 emit run_end 之间的总延迟(ms)。本字段是"总延迟",**包含工具自身 abort 等待消耗**。
   * 监控 P95 ≤ 200ms 的 loop 框架 SLO 时,应使用 `loopFrameworkDelay = exitDelayMs - toolGraceMs`,
   * 隔离 grace 类工具(如 Bash 1s SIGTERM grace)的合规等待,避免误判 SLO 违反。
   *
   * 未记录 abortFiredAt 时(防御分支未生效)为 undefined;正常路径恒有值。
   */
  readonly exitDelayMs?: number;
  /**
   * abort 触发瞬间正在执行的工具的 abort 等待消耗(ms)。
   * - abort 发生在工具 await 期间(响应抛 AbortError 或正常 return partial)→ > 0
   * - abort 发生在工具间隙、LLM 阶段、turn 边界 → 0
   *
   * 用途:订阅方做 P95 SLO 监控用 `exitDelayMs - toolGraceMs` 隔离 loop 框架延迟与
   * 工具自身延迟,避免合规等待被误统计为框架性能问题。
   */
  readonly toolGraceMs: number;
}

/**
 * 工作模式切换意图 —— 由 workmode 工具在用户拍板后 emit，accumulator
 * last-wins 收集，run() 带出到 RunResult.pendingModeSwitch。仅意图，不含
 * 执行（切换由 REPL 主回路 turn 边界单一事务消费此意图后执行）。
 *
 * enter / exit 按构造不会同 turn 共存（main-only vs power-only 工具，一 turn
 * 一 runtime）；同 turn 多次 enter 取最后一次（对应用户最后拍板的 sceneId）。
 */
export type WorkModeSwitchIntent =
  | { kind: "enter"; sceneId: string }
  | { kind: "exit" };

export interface OrchestrationEventIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type OrchestrationRunEventStatus = "completed" | "failed" | "aborted";

export type AgentEventMap = {
  // ─── Agent 生命周期 ───

  "agent:run_start": {
    prompt: string;
  };

  "agent:run_end": {
    reason: AgentRunEndReason;
    duration: number;
    usage: TokenUsage;
    /** 错误消息（仅 reason="error" 时有值），用于日志展示 */
    error?: string;
    /**
     * 错误分类（仅 reason="error" 时有值），来自 AgentError.type。
     * 订阅方可据此做差异化处理，例如：
     *   - "context_overflow" → UI 建议用户 /clear
     *   - "rate_limit" → 告警但不终止 session
     *   - "auth" → 弹出 provider 配置向导
     * 不要从 error 消息字符串里 substring 匹配，那不稳定。
     */
    errorType?: AgentErrorType;
  };

  // ─── LLM 调用 ───

  "llm:request_start": {
    model: string;
    messageCount: number;
    hasTools: boolean;
    /**
     * 提交给 LLM 的完整 system prompt——可观测性诊断用。订阅者可据此 dump
     * 真实送出的 system 内容，便于排查"提示词与预期不符"类问题。摘要字段
     * （model / messageCount / hasTools）保留供 status-bar 等订阅者读取。
     */
    systemPrompt?: string;
    /**
     * 提交给 LLM 的完整 messages 历史（含 user / assistant / tool 全部 ContentBlock）。
     * 引用传递无序列化开销；订阅者按需序列化（如 cli `--log` 启用时 dump 到文件）。
     */
    messages: readonly Message[];
    /**
     * 提交给 LLM 的完整 tool specs（含 name / description / input_schema）。空数组表示无工具。
     */
    tools: readonly ToolSpec[];
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
   * 上下文 token 快照 —— 每个 turn 结束时由 turn-end 钩子 emit 一次。
   *
   * 与 llm:request_end.usage 严格区分：
   *   - llm:request_end.usage = 单次 LLM API 调用的真实输入/输出消耗（流量）
   *   - context:tokens_snapshot.totalTokens = 当前上下文窗口的估算占用（占用快照）
   *     = estimator(systemPrompt) + estimator(messages) + estimator(tools)
   *     反映"下次 LLM 调用将携带多少 tokens"
   *
   * 与 segment:evaluation.currentTokens 的区别：
   *   - segment:evaluation 仅在 SegmentManager 装配时 emit，是评估副产物
   *   - context:tokens_snapshot 由 turn-end 钩子直接 emit，不依赖 SegmentManager 装配，
   *     是上下文占用的一等公民观测信号；订阅方（UI 指示器 / 诊断面板）应订阅此事件
   *
   * Emit 时机：turn-end 钩子在 segmentManager 切段处理后，
   * 对最终 messages 估算后 emit；反映"下次 LLM 将看到的"快照而非 turn 开始时的快照。
   *
   * 静默语义：当 turn-end 钩子缺失 tokenEstimator 或 eventBus 任一依赖时不 emit，
   * 订阅方应能容忍事件不到达（UI 显示空 / 占位）。
   */
  "context:tokens_snapshot": {
    /** estimator 估算的当前上下文占用 token 数 —— system + messages + tools */
    totalTokens: number;
    /** 本 turn 序号（已 +1，反映"已完成"语义） */
    turnCount: number;
  };

  // ─── 段切换 ───
  //
  // 段切换是 attention-driven 的离散事件，也是系统唯一的窗口压缩机制。
  // SegmentManager 在 turn 边界评估当前 tokens 与 attention 阈值，
  // 决策"切段 / 推迟 / pass"。
  //
  // 事件流（仅 trigger 路径完整 fire 全套；终态事件互斥，每次评估至多一个）：
  //   segment:evaluation         每次评估都 fire（含 pass / defer / trigger）
  //   segment:transition_start   仅 trigger 时
  //   segment:summarize_complete 压缩 LLM 完成（trigger 成功路径）
  //   segment:new_started        新段 messages 已组装（正常摘要 / 地板降级均发，终态完成）
  //   segment:emergency_floor    地板降级标记（伴随 new_started，携摘要失败根因）
  //   segment:transition_failed  终态失败：本轮切换没发生（LLM 失败未进地板 / hook 中止）
  //   segment:hook_failed / segment:metadata_persist_failed
  //                              旁路 warning（hook 异常 / 段元数据写入失败），
  //                              除 beforeSummarize 中止外不影响切段主流程

  /**
   * 评估完成，无论是否真切段。decision 字段反映决策结果。
   *
   * decision 形态结构兼容 `SegmentDecision` —— 故意 inline 而不是从段切换模块
   * 反向 import 类型，保 agent-events 作为底层 types 不依赖任何业务模块。
   * 模块内部传 SegmentDecision 给 emit 时 TypeScript 结构兼容性自动接受。
   */
  "segment:evaluation": {
    decision:
      | { kind: "pass"; reason: "below-optimal" }
      | {
          kind: "defer";
          reason: "in-progress-task";
          currentTokens: number;
          threshold: number;
        }
      | {
          kind: "trigger";
          reason: "optimal-exceeded" | "risk-exceeded";
          currentTokens: number;
          threshold: number;
        };
    currentTokens: number;
  };

  /** trigger 决策触发，进入压缩流程。ephemeral 运行体无对话身份 → conversationId 缺省。 */
  "segment:transition_start": {
    conversationId?: string;
    segmentId: string;
    reason: "optimal-exceeded" | "risk-exceeded";
    currentTokens: number;
  };

  /**
   * 应急地板生效：风险阈值已破且摘要 LLM 失败 → 机械保尾截断（无 LLM、
   * 不落盘）。注意力层自己的最后兜底，防 run 失控撑爆物理窗口。
   *
   * 事件即终态：地板兜底成功属于"段切换以降级方式完成"——发本事件 +
   * segment:new_started，**不发 transition_failed**（后者保留给"本轮切换
   * 没发生"的终态失败）。消费方据此渲染降级警示，无需跨事件对账。
   */
  "segment:emergency_floor": {
    segmentId: string;
    /** 摘要 LLM 失败的根因 —— 为什么走到机械截断 */
    error: string;
    droppedTurns: number;
    tokensBefore: number;
    tokensAfter: number;
  };

  /** 压缩 LLM call 完成并解析出有效摘要。 */
  "segment:summarize_complete": {
    segmentId: string;
    summaryTokens: number;
    latencyMs: number;
  };

  /**
   * 新段就绪 —— newSegmentMessages 已组装、窗口重构指令已生成、segmentMetadata
   * 已尝试写入。**marker 不落 transcript** —— 本事件携带 marker 流向 orchestrator
   * 的累积器、随 RunResult 带出，由会话层在接受协议中折叠注意力窗口
   * （压缩是窗口的视图操作，原文持久化 append-only 不参与）。
   *
   * 这样段切换的窗口折叠与本 turn 的接受是同一时点完成，杜绝
   * "内存切了但接受的窗口没切"类的状态不一致；
   * 与折叠指令经 accumulator 单点交付
   * 同模式，整个 run 内 transcript 写入收敛到唯一路径。
   */
  "segment:new_started": {
    segmentId: string;
    bufferTurns: number;
    tokensBefore: number;
    tokensAfter: number;
    /** 窗口重构指令 —— accumulator 收集后随 RunResult 带出，会话层折叠窗口 */
    windowCompact: WindowCompact;
  };

  /**
   * Hook 抛错事件 —— 与 transition_failed 区分语义：
   *   - transition_failed：段切换整体失败（压缩 LLM / 解析失败 等 LLM 视图未生成的情形）
   *   - hook_failed：用户注册的 hook 实现抛错，可能影响也可能不影响主流程
   *
   * 字段 `abortedTransition`：
   *   - true：beforeSummarize 抛错，主流程中止（还没花 LLM 钱，安全回滚）
   *   - false：afterSummarize / beforeNewSegmentStart 抛错，主流程继续
   *     （压缩 LLM 已完成，不让 hook 错误浪费已花费的成本）
   */
  "segment:hook_failed": {
    segmentId: string;
    hookPhase:
      | "beforeSummarize"
      | "afterSummarize"
      | "beforeNewSegmentStart";
    error: string;
    abortedTransition: boolean;
  };

  /**
   * segmentMetadata 持久化失败 —— warning 性质事件，**段切换主流程仍成功**。
   *
   * 与 transition_failed 严格区分：
   *   - transition_failed：段切换整体失败（无 marker 流出、无 newSegmentMessages），
   *     调用方应降级为"不切"继续按原 messages 运行
   *   - metadata_persist_failed：marker 已通过 segment:new_started 事件正常流出，
   *     newSegmentMessages 已组装并返回；本事件仅表示段历史观测元数据（用于
   *     未来段历史浏览 UI / 可观测性面板）未能落盘，不影响 LLM 视图正确性
   *
   * 调用方契约：
   *   - 段历史 UI / 观测面板订阅本事件用于诊断报警
   *   - 主对话流转**不**因本事件改变行为（段切换已成功，turn 继续推进）
   *   - 一致性保障：下次成功 appendSegmentMeta 会把当前段一并写入吗？**不会** ——
   *     单次失败造成该段元数据永久缺失，但 transcript marker 完整保留，
   *     LLM 视图与段历史观测的解耦保证了 LLM 行为不退化
   */
  "segment:metadata_persist_failed": {
    segmentId: string;
    error: string;
  };

  /**
   * 段切换终态失败 —— 本轮切换没发生（压缩 LLM 失败且未进应急地板 /
   * beforeSummarize hook 中止 / 摘要全空 等）。调用方降级为"不切"，
   * 继续按原 messages 跑下一轮；下次 turn 边界再评估。
   *
   * 事件即终态：应急地板兜底成功的路径**不发本事件**（属于"以降级方式
   * 完成"，走 emergency_floor + new_started）——同一次评估终态事件互斥。
   */
  "segment:transition_failed": {
    segmentId: string;
    error: string;
    /** true 表示压缩 LLM 重试已耗尽；false 表示未到 LLM 阶段的失败（beforeSummarize hook 中止）*/
    retriesExhausted: boolean;
  };

  // ─── 中断 ───
  //
  // emit 协议:
  // - interrupt:warn 由看门狗内部 emit(后续里程碑接入)
  // - interrupt:fired 由 emitRunEnd 在 abort 退出路径上唯一调一次,严格在 agent:run_end 之前
  // - abort listener 内只做同步操作(记 abortFiredAt),不调用 emit——避免 fire-and-forget 时序错乱
  // - 任何调用 abortWithReason 的方(看门狗 / KeyboardSource / SignalSource / 父 agent fork)都不自行 emit fired
  // - agent-loop 启动前的 abort(pre-flight 路径)不 emit 任何 interrupt / run_end 事件——
  //   pre-flight 失败语义是"本次 run 未真启动",订阅方观察到的事件流应保持完整缺失

  "interrupt:warn": InterruptWarnEvent;
  "interrupt:fired": InterruptFiredEvent;

  // ─── 编排 ───

  "orchestration:validation_failed": {
    definitionId?: string;
    issues: readonly OrchestrationEventIssue[];
  };

  "orchestration:run_start": {
    runId: string;
    definitionId: string;
    nodeCount: number;
    maxParallel: number;
  };

  "orchestration:node_start": {
    runId: string;
    definitionId: string;
    nodeId: string;
    nodeKind: "agent";
  };

  "orchestration:node_end": {
    runId: string;
    definitionId: string;
    nodeId: string;
    status: OrchestrationRunEventStatus | "skipped";
    durationMs: number;
    usage?: TokenUsage;
    error?: string;
    errorType?: AgentErrorType;
  };

  "orchestration:run_end": {
    runId: string;
    definitionId: string;
    status: OrchestrationRunEventStatus;
    durationMs: number;
    usage?: TokenUsage;
    error?: string;
    errorType?: AgentErrorType;
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

  // ─── 工作模式 ───

  /**
   * 工作模式切换意图请求 —— workmode 工具在用户确认后 emit（main 的
   * workmode_enter / power 的 workmode_exit）。仅产生意图，不执行切换；
   * accumulator last-wins 收集后由 run() 带出 RunResult.pendingModeSwitch，
   * REPL 主回路 turn 边界单一事务消费。命令触发路径不经此事件（直接调
   * 切换事务）。
   */
  "workmode:switch_requested": WorkModeSwitchIntent;

  // ─── 运行体生命周期钩子（run 内） ───
  //
  // 注意力窗口 / run 边界的注册式钩子（onWindowOpen / onBeforeRun / onAfterRun /
  // onWindowClose）由运行体（orchestrator）触发。仅 **run 内** 的两类信号进
  // AgentEventMap —— 它们经 per-run eventBus 流向 cli/serve 渲染订阅，是失败安全
  // 网；首窗（装配期抛错）/ 末窗（销毁调用方 warn）的 run 外信号不在此（无 per-run
  // bus）。不押 logDiagnostic（cli 交互模式被静默）。

  /**
   * 钩子实现抛错 —— onBeforeRun / onAfterRun / run 内窗口换代（onWindowClose /
   * onWindowOpen）任一订阅者抛错。失败不阻塞主对话：emit 此事件 + 用当前 prompt
   * 继续。渲染方据 hookId / phase 给用户一条可见告警，避免内置 skill 重建每窗
   * 静默失败、索引永久陈旧却无人知。
   */
  "lifecycle:hook_failed": {
    /** 抛错订阅者的标识（AgentRuntimeLifecycle.id） */
    hookId: string;
    phase: "onWindowOpen" | "onBeforeRun" | "onAfterRun" | "onWindowClose";
    error: string;
  };

  /**
   * 注意力窗口边界重建后 system prompt 真换（byte-equal 比较不同才 emit）——
   * 内置 skill 索引重建是首个来源。renderer 可静默或轻提示。
   */
  "lifecycle:prompt_rebuilt": {
    reason: "segment-transition" | "compact";
  };
} & SecurityEventMap;
