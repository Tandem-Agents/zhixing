/**
 * Owner Runtime 类型定义
 *
 * 设计原则：
 * - SessionRuntime 是抽象接口，不绑定具体 Agent 实现
 * - RuntimeFactory 由调用方注入，owner-kernel 不依赖具体运行体实现
 * - 流式输出复用 core 的 AgentYield/AgentResult
 */

import type {
  AbortReason,
  AgentEventMap,
  AgentYield,
  ContextBudget,
  DurableToolExecutionAuthorizer,
  EventBus,
  IConfirmationBroker,
  Message,
  OrchestrationContextSnapshotV1,
  OrchestrationExecutableV1,
  OrchestrationRunResultV1,
  PermissionContextId,
  PermissionRule,
  RiskLevel,
  RunResult,
  RunRecordAdvancementMetadata,
  SecurityRule,
  TextCallLLMResult,
  TurnContext,
  TurnSource,
  WindowCompact,
} from "@zhixing/core";
import type {
  AssignmentGlobalQueryPort,
  AssignmentMutationPort,
  ContentAssetRef,
  ModelCallResourceMeter,
} from "@zhixing/core/contracts";
import type { ScheduleMutationStager } from "@zhixing/core";

// TurnContext 的唯一定义在 @zhixing/core（types/tools.ts）——此处只做 re-export，
// 方便 owner-kernel 及其下游从统一入口获取。
export type { TurnContext };

/** SessionRuntime.run 的 per-turn 选项 */
export interface RunTurnOptions {
  abortSignal?: AbortSignal;
  turnContext?: TurnContext;
  /** Authenticated stable surface identity; transport connection ids are not identities. */
  surfacePrincipal?: string;
  /** Durable content assets bound to this input control request. */
  attachments?: readonly ContentAssetRef[];
  /**
   * 本 turn 序号（进生命周期钩子上下文供观测）—— 由调用方维护的 counter 提供。
   *
   * owner 路径由 `ManagedSession.turnCount` 提供；
   * 可选 —— 未传时 adapter 默认 0（legacy / 测试路径）。
   */
  turnIndex?: number;
  /**
   * 触发源，落盘为 run record 的 source 字段（"interactive" / "scheduler" / "channel"）。
   * 渠道入站消息路径默认为 "channel"。
   */
  source?: TurnSource;
  /**
   * 推进侧代理 turn 的 run 级元数据。它只落 RunRecord，不进入模型消息。
   */
  advancement?: RunRecordAdvancementMetadata;
  /** Closed runtime-event projection consumed by durable stream producers. */
  onProtocolEvent?: (
    event: import("@zhixing/core").SessionEventProjection,
    meta: { readonly lineage?: string },
  ) => void | Promise<void>;
  toolSideEffectObserver?: import("@zhixing/core").ToolSideEffectObserver;
  /** Fail-closed durable authority check invoked immediately before each tool call. */
  authorizeToolExecution?: DurableToolExecutionAuthorizer;
  /** Durable per-provider-call resource accounting for this assigned run. */
  modelCallResourceMeter?: ModelCallResourceMeter;
  /** Assignment-local schedule writes; absent on trusted control surfaces. */
  stageScheduleMutation?: ScheduleMutationStager;
  /** Unified assignment-local staged write/overlay inherited by descendants. */
  assignmentMutations?: AssignmentMutationPort;
  /** Read-only global authority facade bound to this assignment. */
  globalQuery?: AssignmentGlobalQueryPort;
  /** Stable issue time of the durable assignment. */
  assignmentIssuedAt?: string;
}

export type RuntimeDisposeReason =
  | "session-dispose"
  | "workmode-exit"
  | "reload-replace"
  | "assignment-dispose"
  | "assembly-rollback";

export interface SessionRuntime {
  readonly sessionId: string;
  /**
   * 执行一轮对话——纯执行体:输入消息由调用方构造(窗口事实 + 本轮用户消息),
   * runtime 不持有任何会话状态。AsyncGenerator 流式 yield 事件 → return
   * `RunResult`(含 `runRecord`、`windowCompact?`、`newMessages` + 诊断字段),
   * 调用方据此走 recordTurn 单一持久化入口。
   *
   * 注意力窗口与接受协议的唯一权威在 ConversationManager(ManagedSession 持
   * 窗口);失败路径窗口不动,run 输入瞬态构造、无需回滚。
   */
  run(
    messages: readonly Message[],
    options?: RunTurnOptions,
  ): AsyncGenerator<AgentYield, RunResult>;
  /**
   * 终止当前 in-flight turn(若有)。
   *
   * 返回 true 表示真的打断了一个正在跑的 turn,false 表示 idle/已 abort 等无操作场景。
   * 调用方据此判断要不要在自己这边 emit 反馈——in-flight 路径下反馈走主模块 cleanup
   * 单源,不在 caller 处再 emit。
   *
   * `reason` 携带类型化中断原因,沿 `controller.signal` 透传到 agent-loop / LLM /
   * 工具 / channel 渲染层。缺省时填 `external{ origin: "session-runtime-abort" }`,
   * 渲染层走通用兜底文案。
   *
   * 幂等:重复调用 / 已 aborted 时立即返 false,不覆盖原 reason(first-wins)。
   */
  abort(reason?: AbortReason): boolean;
  /**
   * 释放资源（宿主关闭 / 会话驱逐时调用）。
   *
   * async：实现透传底层运行体的末窗 onWindowClose（收尾 / flush 须可等待、失败须
   * 可被销毁调用方捕获），排除 fire-and-forget。调用方应 await。
   */
  dispose(reason?: RuntimeDisposeReason): Promise<void>;
  /**
   * 确认交互 broker —— 可选。
   *
   * `@zhixing/cli` 的 `AgentRuntime` 天然实现（broker 作为 readonly public 字段暴露）；
   * 其它 SessionRuntime 实现（如测试 stub）可以不提供，此时 ConfirmationHub 不接入。
   *
   * 远程确认通道通过 Hub 聚合 per-runtime broker。
   */
  readonly confirmationBroker?: IConfirmationBroker;

  /**
   * 读取并清空 run 外 lifecycle 诊断。run 内诊断走 per-run eventBus；run 外窗口换代
   * / dispose 无 run bus，由运行体暂存后交给 owner 投影。
   */
  drainLifecycleDiagnostics?(): readonly AgentEventMap["lifecycle:warning"][];

  // ─── 会话命令执行体所需的运行体能力(可选——adapter 透传底层运行体) ───
  //
  // 以下成员服务 run 外的会话命令(清空 / 手动压缩 / 切换对话)与 turn 后维护
  // (例如自动命名)。测试 stub / 不支持的实现可缺省,方法层对
  // 缺失能力 fail-fast 报"运行体不支持"。

  /**
   * 手动触发上下文压缩——返回窗口重构指令(windowCompact),由调用方
   * (ConversationManager)应用到注意力窗口并写派生快照;运行体自身不触窗口。
   */
  forceCompact?(
    messages: Message[],
    turnCount: number,
  ): Promise<RuntimeCompactOutcome>;
  /** 触发全部已注册组件重置对话级状态(/clear 执行体的内存侧)。 */
  resetConversationState?(): Promise<void>;
  /**
   * run 外注意力窗口换代(清空 / 切换 / 手动压缩后)——旧窗 onWindowClose →
   * 新窗 onWindowOpen,更新实例权威 prompt。
   */
  onAttentionWindowChange?(reason: "clear" | "resume" | "compact"): Promise<void>;
  /**
   * 简易单发 LLM 文本调用(无对话历史)——turn 后维护（例如自动命名）的
   * 推理通道。light 档为辅助任务默认。
   */
  callText?(
    prompt: string,
    role?: "main" | "light",
    opts?: SessionRuntimeTextCallOptions,
  ): Promise<string>;
  callTextWithUsage?(
    prompt: string,
    role?: "main" | "light",
    opts?: SessionRuntimeTextCallOptions,
  ): Promise<TextCallLLMResult>;
  /**
   * 执行已校验的编排定义。具体装配归运行体实现方，owner 只按抽象能力调用。
   */
  runOrchestrationV1?(
    params: SessionRuntimeOrchestrationV1Params,
  ): Promise<OrchestrationRunResultV1>;
  /**
   * 估算当前窗口下一次 provider 请求的上下文预算(接入面 /usage /context 的数据面)。
   * 运行体自行补齐 committed system prompt / message prefix / tools。
   */
  estimateConversationRequestBudget?(messages: readonly Message[]): ContextBudget;
  /** 纯消息 token 估算，供 snapshot / perspectives 等消息子集裁剪使用。 */
  estimateMessagesTokens?(messages: readonly Message[]): number;
  /**
   * 查询当前消息列表里的子 agent 用量拆分(/usage 的补充数据面)。
   *
   * 解析规则归运行体实现方：owner 不理解 Task 工具的文本 trailer 协议，
   * 只组合运行体给出的结构化结果，避免接入面或 owner 反向解析工具私有格式。
   */
  subAgentUsages?(messages: readonly Message[]): readonly RuntimeSubAgentUsageEntry[];
  /** 查询运行体当前安全状态(/security 的宿主数据面)。 */
  securitySnapshot?(): RuntimeSecuritySnapshot;
  /** Complete immutable permission input for a newly issued durable assignment. */
  executionPermissionRules?(): readonly PermissionRule[];
  /** Exact non-secret dependencies of this immutable assembled runtime. */
  executionProfile?(): import("@zhixing/core").RuntimeExecutionProfile;
  /** Token 估算器校准因子(1.0 = 未校准)——用量展示的辅助信息。 */
  readonly calibrationFactor?: number;
}

/** assignment 域共享的模型调用计量序列——同一 run 树全部外调共用 usageId 空间 */
export interface SessionRuntimeModelCallMetering {
  readonly meter: ModelCallResourceMeter;
  readonly nextCallIndex: () => number;
}

/** 单发文本调用选项——metering 存在时调用计入所属 assignment 的资源租约 */
export interface SessionRuntimeTextCallOptions {
  readonly abortSignal?: AbortSignal;
  readonly modelCallMetering?: SessionRuntimeModelCallMetering;
}

export interface SessionRuntimeOrchestrationV1Params {
  readonly executable: OrchestrationExecutableV1;
  readonly runInput?: unknown;
  readonly contextSnapshot?: OrchestrationContextSnapshotV1;
  readonly abortSignal?: AbortSignal;
  readonly eventBus: EventBus<AgentEventMap>;
  readonly parentLineage?: string;
  readonly authorizeToolExecution?: NonNullable<RunTurnOptions["authorizeToolExecution"]>;
  readonly modelCallMetering?: SessionRuntimeModelCallMetering;
}

/** /security 的运行体只读快照——事实源仍在 SecurityPipeline,owner 只透结构。 */
export interface RuntimeSecuritySnapshot {
  readonly contextId: PermissionContextId;
  readonly workspacePath: string | null;
  readonly permissionRules: readonly PermissionRule[];
  readonly builtinRules: readonly SecurityRule[];
  readonly rateLimits: readonly { key: string; used: number; limit: number }[];
  readonly confirmations: readonly {
    key: string;
    count: number;
    highestRisk: RiskLevel;
  }[];
}

/** /usage 的子 agent/Task 拆分项。解析由运行体实现方提供，owner 只透传结构。 */
export interface RuntimeSubAgentUsageEntry {
  /** Task 工具调用顺序索引(1-based,按消息中出现顺序)。 */
  readonly index: number;
  /** Task 工具入参 description；缺失时为空串。 */
  readonly description: string;
  /** 子 agent 总 token(input + output,不含 cache 维度)。 */
  readonly tokens: number;
  /** 子工具调用数，成功、失败和中止三态都有。 */
  readonly toolUses: number;
  /** 子 dispatch 持续时间(ms)。 */
  readonly durationMs?: number;
  /** 子 agent id 前缀，供审计追踪。 */
  readonly subId?: string;
  readonly status: "succeeded" | "failed" | "aborted";
}

/**
 * forceCompact 的结构形产物——与运行体实现方(orchestrator)的返回结构兼容,
 * owner-kernel 不依赖 orchestrator 故以结构声明。windowCompact 缺省 = 本次无可压缩
 * 内容 / 摘要失败未达风险线,窗口不应折叠。
 */
export interface RuntimeCompactOutcome {
  modified: boolean;
  windowCompact?: WindowCompact;
  /** 应急地板降级信息——摘要 LLM 失败、以机械保尾截断完成时携带 */
  emergencyFloor?: { droppedTurns: number; error: string };
}

/**
 * 会话历史的装填产物 —— loadHistory 回调的返回形态。
 *
 * bootstrap 是启动装填对（摘要快照 + 预算化倒读的最近原文渲染成的窗口起始
 * 条目），由 owner 侧装填器构建；null = 有过会话但无可装内容（如刚清空）。
 * turnCount 为自最近清空以来的 run 数（turnIndex 计数的初值）。
 */
export interface ConversationBootstrap {
  readonly bootstrap: readonly [Message, Message] | null;
  readonly turnCount: number;
}

export interface RuntimeFactory {
  /**
   * 创建新运行时——纯执行体发放。会话历史装填(启动装填对 → 窗口起始条目)
   * 归 ConversationManager,工厂不感知。
   */
  create(
    sessionId: string,
    environment?: {
      /** Executor-local path obtained only after the frozen binding is revalidated. */
      readonly workspaceRoot: string | null;
    },
  ): Promise<SessionRuntime>;
}

/** @deprecated 使用 ManagedSessionInfo (from conversation-manager) 代替 */
export type { ManagedSessionInfo } from "./conversation-manager.js";

/**
 * `ConversationManager.abort` 的双维度返回值。
 *
 * - `abortedInFlight`:是否真的打断了一个正在跑的 turn。in-flight 维度,接
 *   `SessionRuntime.abort` 的结果。
 * - `cancelledPending`:从该 session 的 pending queue 清掉的任务数,且各 task.cancel
 *   hook 已被调一次。
 *
 * 用户视角"正在处理"包含两类(已发未跑的 pending 也是用户期待 abort 的目标),单
 * boolean 无法区分"取消了什么"会让 UX 反馈含糊。两个维度组合让调用方决定反馈:
 *   - `abortedInFlight === true`: 不在 cancel ack 处反馈(让 cleanup 路径产出唯一反馈,
 *     反馈单源原则)
 *   - `abortedInFlight === false && cancelledPending > 0`: 反馈"已取消队列中 N 条"
 *   - 两者都假: 反馈"当前没有正在处理的任务"
 */
export interface AbortResult {
  readonly abortedInFlight: boolean;
  readonly cancelledPending: number;
}
