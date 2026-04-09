/**
 * 会话持久化类型定义
 *
 * 设计原则（详见 research/design/specifications/session-persistence.md）：
 * - Turn 级粒度：一轮要么完整保存要么不保存，不留半成品
 * - Header 内联：JSONL 首行包含全部元数据，无需额外索引文件
 * - 判别联合：SessionRecord 通过 type 字段区分
 *
 * 对比 Claude Code：它用消息级粒度 + 独立 sessions-index.json（已知同步 bug）。
 * 对比 OpenClaw：它的 Session 管理分散在闭源 pi-coding-agent 中。
 */

import type { Message } from "../types/messages.js";

// ─── JSONL 记录类型 ───

/** JSONL 第一行：会话元数据 */
export interface SessionHeader {
  type: "header";
  /** 格式版本号，用于未来向前兼容 */
  version: number;
  sessionId: string;
  /** 用户可通过 --name 或 /name 设置的显示名 */
  name: string | null;
  projectPath: string;
  createdAt: string;
  model: string;
  provider: string;
}

/** JSONL 后续行：一轮完整对话（user → assistant + tools） */
export interface SessionTurn {
  type: "turn";
  turnIndex: number;
  timestamp: string;
  userMessage: Message;
  assistantMessage: Message;
  toolCalls?: ToolCallRecord[];
  usage?: SessionTokenUsage;
}

/** 工具调用的持久化表示（扁平化，不含 tool_use/tool_result 的嵌套结构） */
export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** JSONL 特殊行：上下文压缩边界标记 */
export interface SessionCompact {
  type: "compact";
  timestamp: string;
  summary: string;
  turnsCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
}

/** 所有可出现在 JSONL 中的记录类型 */
export type SessionRecord = SessionHeader | SessionTurn | SessionCompact;

// ─── Session Store 接口 ───

/** 会话列表项（从 header + 文件系统元数据派生） */
export interface SessionInfo {
  sessionId: string;
  name: string | null;
  createdAt: string;
  model: string;
  provider: string;
  lastAccessedAt: Date;
  turnCount: number;
}

/** 加载会话的返回结构 */
export interface LoadedSession {
  header: SessionHeader;
  messages: Message[];
  turnCount: number;
}

/** Session Store 公共接口 */
export interface ISessionStore {
  create(options: CreateSessionOptions): Promise<SessionHeader>;
  appendTurn(sessionId: string, turn: SessionTurn): Promise<void>;
  appendCompact(sessionId: string, compact: SessionCompact): Promise<void>;
  load(sessionId: string): Promise<LoadedSession>;
  list(): Promise<SessionInfo[]>;
  rename(sessionId: string, name: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface CreateSessionOptions {
  name?: string;
  model: string;
  provider: string;
}

// ─── 常量 ───

/** JSONL 格式版本 */
export const SESSION_FORMAT_VERSION = 1;
