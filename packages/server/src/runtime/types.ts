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
  AgentResult,
  Message,
  TurnContext,
} from "@zhixing/core";

// TurnContext 的唯一定义在 @zhixing/core（types/tools.ts）——此处只做 re-export，
// 方便 server 层和其下游直接从 @zhixing/server 拿到。
export type { TurnContext };

/** SessionRuntime.run 的 per-turn 选项 */
export interface RunTurnOptions {
  abortSignal?: AbortSignal;
  turnContext?: TurnContext;
}

export interface SessionRuntime {
  readonly sessionId: string;
  /**
   * 执行一轮对话，AsyncGenerator 流式 yield 事件 → return 最终结果。
   * 与 core 的 runAgentLoop 同语义，但持有内部消息历史。
   *
   * 第二参数兼容两种形式（ADR-007 Phase 2）：
   * - `AbortSignal`（legacy）
   * - `RunTurnOptions`（含 abortSignal + turnContext）
   */
  run(
    text: string,
    abortSignalOrOptions?: AbortSignal | RunTurnOptions,
  ): AsyncGenerator<AgentYield, AgentResult>;
  /** 当前消息历史（只读拷贝） */
  getHistory(limit?: number): Message[];
  /** 终止当前执行（如果有） */
  abort(): void;
  /** 释放资源（Server 关闭时调用） */
  dispose(): void;
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
