/**
 * Server Session 类型定义
 *
 * 设计原则：
 * - ServerSession 是抽象接口，不绑定具体 Agent 实现
 * - SessionFactory 由调用方（CLI 或测试）注入，Server 不依赖 @zhixing/cli
 * - 流式输出复用 core 的 AgentYield/AgentResult
 */

import type { AgentYield, AgentResult, Message } from "@zhixing/core";

export interface ServerSession {
  readonly sessionId: string;
  /**
   * 执行一轮对话，AsyncGenerator 流式 yield 事件 → return 最终结果。
   * 与 core 的 runAgentLoop 同语义，但持有内部消息历史。
   */
  run(text: string, abortSignal?: AbortSignal): AsyncGenerator<AgentYield, AgentResult>;
  /** 当前消息历史（只读拷贝） */
  getHistory(limit?: number): Message[];
  /** 终止当前执行（如果有） */
  abort(): void;
  /** 释放资源（Server 关闭时调用） */
  dispose(): void;
}

export interface SessionFactory {
  /** 创建新会话；sessionId 由 Registry 生成传入 */
  create(sessionId: string): Promise<ServerSession>;
}

export interface SessionInfo {
  sessionId: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  /** 是否正在执行 turn */
  busy: boolean;
}
