/**
 * Server Runtime 类型定义
 *
 * 设计原则：
 * - SessionRuntime 是抽象接口，不绑定具体 Agent 实现
 * - RuntimeFactory 由调用方（CLI 或测试）注入，Server 不依赖 @zhixing/cli
 * - 流式输出复用 core 的 AgentYield/AgentResult
 */

import type {
  AgentYield,
  IConfirmationBroker,
  Message,
  RunResult,
  TurnContext,
  TurnSource,
} from "@zhixing/core";

// TurnContext 的唯一定义在 @zhixing/core（types/tools.ts）——此处只做 re-export，
// 方便 server 层和其下游直接从 @zhixing/server 拿到。
export type { TurnContext };

/** SessionRuntime.run 的 per-turn 选项 */
export interface RunTurnOptions {
  abortSignal?: AbortSignal;
  turnContext?: TurnContext;
  /**
   * 本 turn 序号（落盘为 Turn.turnIndex）—— 由调用方维护的 counter 提供。
   *
   * 对齐 server 路径由 `ManagedSession.turnCount` 提供；
   * 可选 —— 未传时 adapter 默认 0（legacy / 测试路径）。
   */
  turnIndex?: number;
  /**
   * 触发源，落盘为 Turn.source（"interactive" / "scheduler" / "channel"）。
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
   * （含 `turn`、`compactBefore?`、`newMessages` + 诊断字段）。
   * 调用方（InboundRouter / session.ts RPC / 测试）据此走 commitTurn 单一持久化入口。
   *
   * 第二参数兼容两种形式（ADR-007 Phase 2）：
   * - `AbortSignal`（legacy）
   * - `RunTurnOptions`（含 abortSignal + turnContext + turnIndex + source）
   */
  run(
    text: string,
    abortSignalOrOptions?: AbortSignal | RunTurnOptions,
  ): AsyncGenerator<AgentYield, RunResult>;
  /** 当前消息历史（只读拷贝） */
  getHistory(limit?: number): Message[];
  /**
   * 用 canonical messages 覆盖内部 state（单向数据流）。
   *
   * 调用时机：ConversationManager.recordTurn 成功后拿到 commitTurn 返回的 canonical，
   *   通过此方法回喂到 SessionRuntime —— 内存与磁盘严格一致，下次 run 直接用最新 state。
   *
   * 契约：canonical 是包含 compactBefore summary pair + post-compact turns 的完整序列，
   *   直接替换 SessionRuntime 内部 messages 即可（不是 append）。
   */
  updateMessages(canonical: Message[]): void;
  /** 终止当前执行（如果有） */
  abort(): void;
  /** 释放资源（Server 关闭时调用） */
  dispose(): void;
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
  /** 创建新运行时；sessionId 由 Registry 生成传入，可选注入历史消息用于恢复对话 */
  create(sessionId: string, initialMessages?: Message[]): Promise<SessionRuntime>;
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
