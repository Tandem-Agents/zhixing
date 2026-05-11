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
import type { CompactStrategyContribution } from "../context/types.js";
import type { AbortReason } from "../interrupt/types.js";
import type { CompactMarker } from "../transcript/types.js";

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
   * - abort 发生在工具间隙、LLM 阶段、turn 边界、contextManager 阶段 → 0
   *
   * 用途:订阅方做 P95 SLO 监控用 `exitDelayMs - toolGraceMs` 隔离 loop 框架延迟与
   * 工具自身延迟,避免合规等待被误统计为框架性能问题。
   */
  readonly toolGraceMs: number;
}

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
     * 引用传递无序列化开销；订阅者按需序列化（如 dump 在 ZHIXING_RAW_DUMP=1 时）。
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
   * 预算检查事件 —— 在 compact 事务前后各 fire 一次。
   *
   * phase:
   *   - "pre-compact": onTurnComplete 初始检查，订阅方据此判断是否需要压缩 UI 预警
   *   - "post-compact": strategies 循环结束后的状态，订阅方可用于指标对比；
   *     仅在实际进入 strategies 循环路径上 fire（早退的 normal/warning 场景不 fire）
   */
  "context:budget_check": {
    phase: "pre-compact" | "post-compact";
    currentTokens: number;
    effectiveWindow: number;
    usageRatio: number;
    status: "normal" | "warning" | "compact" | "critical";
  };

  /**
   * compact 事务开始锚点 —— 一次 compact 事务仅 fire 一次，不带 strategy 名。
   * UI 消费它显示"压缩中"spinner；事务结束时 compact_end 关闭 spinner。
   *
   * 事务化规则：仅在第一个 strategy.canApply 通过时 fire；
   * 如果所有 strategies canApply 都返回 false，compact_start 不 fire。
   */
  "context:compact_start": {
    tokensBefore: number;
  };

  /**
   * compact 事务结束 —— 一次 compact 事务仅 fire 一次，payload 汇总所有贡献。
   *
   * strategies[]: 本次事务内每个跑过的 strategy 的独立记录（按执行顺序）。
   * 汇总字段：
   *   summary     = strategies 中最后一个非空 summary（当前仅 LLMSummarize 产）
   *   turnsCompacted = 所有 strategy.turnsCompacted 求和（当前仅 LLMSummarize 一个值）
   *
   * 幂等保证：compact_start fire 过则必然有对应的 compact_end（try-finally 保护）。
   */
  "context:compact_end": {
    strategies: readonly CompactStrategyContribution[];
    summary?: string;
    turnsCompacted?: number;
    tokensBefore: number;
    tokensAfter: number;
  };

  "context:calibrate": {
    estimated: number;
    actual: number;
    newRatio: number;
  };

  // ─── 段切换 ───
  //
  // 段切换是 attention-driven 的离散事件，与 context:* 的 budget-driven 兜底
  // 并列。SegmentManager 在 turn 边界评估当前 tokens 与 attention 阈值，
  // 决策"切段 / 推迟 / pass"。
  //
  // 事件流（仅 trigger 路径完整 fire 全套）：
  //   segment:evaluation        每次评估都 fire（含 pass / defer / trigger）
  //   segment:transition_start  仅 trigger 时
  //   segment:summarize_complete 压缩 LLM 完成（trigger 成功路径）
  //   segment:new_started        新段 messages 已组装并落盘（成功完成切段）
  //   segment:transition_failed  任一环节失败（含压缩 LLM 失败 / 持久化失败）

  /**
   * 评估完成，无论是否真切段。decision 字段反映决策结果。
   *
   * decision 形态结构兼容 `SegmentDecision` —— 故意 inline 而不是从段切换模块
   * 反向 import 类型，保 agent-events 作为底层 types 不依赖任何业务模块。
   * 模块内部传 SegmentDecision 给 emit 时 TypeScript 结构兼容性自动接受。
   */
  "segment:evaluation": {
    decision:
      | { kind: "pass"; reason: "below-optimal" | "no-conversation" }
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

  /** trigger 决策触发，进入压缩流程。 */
  "segment:transition_start": {
    conversationId: string;
    segmentId: string;
    reason: "optimal-exceeded" | "risk-exceeded";
    currentTokens: number;
  };

  /** 压缩 LLM call 完成并解析出有效摘要。 */
  "segment:summarize_complete": {
    segmentId: string;
    summaryTokens: number;
    latencyMs: number;
  };

  /**
   * 新段就绪 —— newSegmentMessages 已组装、CompactMarker 已生成、segmentMetadata
   * 已尝试写入。**transcript 的 marker 落盘不由 SegmentManager 直接做**，
   * 而是通过本事件携带 marker 流向 orchestrator 的累积器，由 run-agent 在
   * run 结束时通过 `commitTurn({ turn, compactBefore })` 单点原子写入。
   *
   * 这样段切换 marker 与本 turn 的 transcript 写入是同一原子事务，杜绝
   * "marker 已写但 turn 未写"或"内存切了但 transcript 没切"类的状态不一致；
   * 与 LLMSummarize 走 `context:compact_end` → accumulator → 单点 commit
   * 同模式，整个 run 内 transcript 写入收敛到唯一路径。
   */
  "segment:new_started": {
    segmentId: string;
    bufferTurns: number;
    tokensBefore: number;
    tokensAfter: number;
    /** 段切换 marker —— accumulator 收集后由 run-agent 单点写入 transcript */
    marker: CompactMarker;
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
   * 段切换失败 —— 压缩 LLM 失败 / 持久化失败 / 摘要全空 等任一环节失败。
   * 调用方降级为"不切"，继续按原 messages 跑下一轮；下次 turn 边界再评估。
   */
  "segment:transition_failed": {
    segmentId: string;
    error: string;
    /** true 表示压缩 LLM 重试已耗尽；false 表示其他失败（如持久化抛错）*/
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
};
