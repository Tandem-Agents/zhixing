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
  IConfirmationBroker,
  Message,
  RunRecord,
  RunResult,
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
}

export interface SessionRuntime {
  readonly sessionId: string;
  /**
   * 执行一轮对话，AsyncGenerator 流式 yield 事件 → return `RunResult`。
   *
   * **契约变更**：return 值从 `AgentResult` 升级为 `RunResult`
   * （含 `runRecord`、`windowCompact?`、`newMessages` + 诊断字段）。
   * 调用方（InboundRouter / session.ts RPC / 测试）据此走 recordTurn 单一持久化入口。
   *
   * 第二参数兼容两种形式（ADR-007 Phase 2）：
   * - `AbortSignal`（legacy）
   * - `RunTurnOptions`（含 abortSignal + turnContext + turnIndex + source）
   */
  run(
    text: string,
    abortSignalOrOptions?: AbortSignal | RunTurnOptions,
  ): AsyncGenerator<AgentYield, RunResult>;
  /** 当前注意力窗口内容（只读拷贝）—— RPC 历史查询与 messageCount 的数据源 */
  getHistory(limit?: number): Message[];
  /**
   * 接受一个 run —— 注意力窗口前进的唯一入口。
   *
   * 调用时机：ConversationManager.recordTurn 在持久化成功（persistent）或
   *   pending 入列成功（ephemeral）之后调用——"先持久化、后入窗"的接受协议。
   *   失败路径不调用：窗口停在原基底，下轮重试，无需任何回滚。
   *
   * 语义：实现方先应用 windowCompact（若有，折叠被摘配对），再从 runMessages
   *   派生本 run 的蒸馏对追加入窗。run 输入由 run(text) 瞬态构造
   *   （[...窗口, 用户消息]），用户消息在 accept 之前不进入任何状态。
   *
   * `runIndex`：持久化路径携带 store 分配的序号（折叠覆盖锚点随配对落进窗口）；
   *   ephemeral 路径携带 provisional 序号（= pending 队列序号，promote FIFO
   *   flush 到全新 transcript 时与 store 分配一致，promote 内对账校验）。
   */
  acceptRun(input: {
    runMessages: readonly Message[];
    runIndex?: number;
    windowCompact?: WindowCompact;
  }): void;
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
}

export interface RuntimeFactory {
  /** 创建新运行时；sessionId 由调用方传入，可选注入历史 run records 用于恢复对话 */
  create(sessionId: string, initialRecords?: RunRecord[]): Promise<SessionRuntime>;
}

export interface RuntimeInfo {
  sessionId: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  /** 是否正在执行 turn */
  busy: boolean;
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
