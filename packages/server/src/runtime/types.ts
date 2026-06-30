/**
 * Server Runtime 类型定义
 *
 * 设计原则：
 * - SessionRuntime 是抽象接口，不绑定具体 Agent 实现
 * - RuntimeFactory 由调用方（CLI 或测试）注入，Server 不依赖 @zhixing/cli
 * - 流式输出复用 core 的 AgentYield/AgentResult
 */

import type {
  AbortReason,
  AgentYield,
  ContextBudget,
  IConfirmationBroker,
  Message,
  PermissionContextId,
  PermissionRule,
  RiskLevel,
  RunResult,
  RunRecordAdvancementMetadata,
  SecurityRule,
  TurnContext,
  TurnSource,
  WindowCompact,
} from "@zhixing/core";

// TurnContext 的唯一定义在 @zhixing/core（types/tools.ts）——此处只做 re-export，
// 方便 server 层和其下游直接从 @zhixing/server 拿到。
export type { TurnContext };

/** SessionRuntime.run 的 per-turn 选项 */
export interface RunTurnOptions {
  abortSignal?: AbortSignal;
  turnContext?: TurnContext;
  /**
   * 本 turn 序号（进生命周期钩子上下文供观测）—— 由调用方维护的 counter 提供。
   *
   * 对齐 server 路径由 `ManagedSession.turnCount` 提供；
   * 可选 —— 未传时 adapter 默认 0（legacy / 测试路径）。
   */
  turnIndex?: number;
  /**
   * 触发源，落盘为 run record 的 source 字段（"interactive" / "scheduler" / "channel"）。
   * server 入站消息路径（InboundRouter）默认为 "channel"。
   */
  source?: TurnSource;
  /**
   * 推进侧代理 turn 的 run 级元数据。它只落 RunRecord，不进入模型消息。
   */
  advancement?: RunRecordAdvancementMetadata;
}

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
   * 释放资源（Server 关闭 / 会话驱逐时调用）。
   *
   * async：实现透传底层运行体的末窗 onWindowClose（收尾 / flush 须可等待、失败须
   * 可被销毁调用方捕获），排除 fire-and-forget。调用方应 await。
   */
  dispose(): Promise<void>;
  /**
   * 确认交互 broker —— 可选。
   *
   * `@zhixing/cli` 的 `AgentRuntime` 天然实现（broker 作为 readonly public 字段暴露）；
   * 其它 SessionRuntime 实现（如测试 stub）可以不提供，此时 ConfirmationHub 不接入。
   *
   * 参见 remote-confirmation-execution.md §3.2（Hub 聚合 per-runtime broker）。
   */
  readonly confirmationBroker?: IConfirmationBroker;

  // ─── 会话命令执行体所需的运行体能力(可选——adapter 透传底层运行体) ───
  //
  // 以下成员服务 run 外的会话命令(清空 / 手动压缩 / 切换对话)与 turn 后维护
  // (自动命名 / journal 凝练)。测试 stub / 不支持的实现可缺省,方法层对
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
   * 简易单发 LLM 文本调用(无对话历史)——turn 后维护(自动命名 / journal
   * 凝练)的推理通道。light 档为辅助任务默认。
   */
  callText?(prompt: string, role?: "main" | "light"): Promise<string>;
  /** 查询给定消息列表的上下文预算(接入面 /usage /context 的数据面)。 */
  checkBudget?(messages: readonly Message[]): ContextBudget;
  /**
   * 查询当前消息列表里的子 agent 用量拆分(/usage 的补充数据面)。
   *
   * 解析规则归运行体实现方：server 不理解 Task 工具的文本 trailer 协议，
   * 只组合运行体给出的结构化结果，避免接入面或 server 反向解析工具私有格式。
   */
  subAgentUsages?(messages: readonly Message[]): readonly RuntimeSubAgentUsageEntry[];
  /** 查询运行体当前安全状态(/security 的宿主数据面)。 */
  securitySnapshot?(): RuntimeSecuritySnapshot;
  /** Token 估算器校准因子(1.0 = 未校准)——用量展示的辅助信息。 */
  readonly calibrationFactor?: number;
}

/** /security 的运行体只读快照——事实源仍在 SecurityPipeline,server 只透结构。 */
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

/** /usage 的子 agent/Task 拆分项。解析由运行体实现方提供，server 只透传结构。 */
export interface RuntimeSubAgentUsageEntry {
  /** Task 工具调用顺序索引(1-based,按消息中出现顺序)。 */
  readonly index: number;
  /** Task 工具入参 description；缺失时为空串。 */
  readonly description: string;
  /** 子 agent 总 token(input + output,不含 cache 维度)。 */
  readonly tokens: number;
  /** 成功路径的子工具调用数；failed/aborted 可缺省。 */
  readonly toolUses?: number;
  /** 子 dispatch 持续时间(ms)。 */
  readonly durationMs?: number;
  /** 子 agent id 前缀，供审计追踪。 */
  readonly subId?: string;
  readonly status: "succeeded" | "failed" | "aborted";
}

/**
 * forceCompact 的结构形产物——与运行体实现方(orchestrator)的返回结构兼容,
 * server 不依赖 orchestrator 故以结构声明。windowCompact 缺省 = 本次无可压缩
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
  create(sessionId: string): Promise<SessionRuntime>;
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
