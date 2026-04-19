/**
 * Transcript 持久化类型定义
 *
 * 设计原则：
 * - Turn 级粒度：一轮要么完整保存要么不保存，不留半成品
 * - Header 内联：JSONL 首行包含全部元数据，无需额外索引文件
 * - 判别联合：TranscriptRecord 通过 type 字段区分
 */

import type { Message } from "../types/messages.js";
import type { TokenUsage } from "../types/llm.js";

// ─── JSONL 记录类型 ───

/** JSONL 第一行：转录元数据 */
export interface TranscriptHeader {
  type: "header";
  /** 格式版本号，用于未来向前兼容 */
  version: number;
  /** 所属 Conversation ID */
  conversationId: string;
  /** 用户可通过 --name 或 /name 设置的显示名 */
  name: string | null;
  projectPath: string;
  createdAt: string;
  model: string;
  provider: string;
}

/** 触发源标识 */
export type TurnSource = "interactive" | "scheduler" | "channel";

/** JSONL 后续行：一轮完整对话（user → assistant + tools） */
export interface Turn {
  type: "turn";
  turnIndex: number;
  timestamp: string;
  userMessage: Message;
  assistantMessage: Message;
  toolCalls?: ToolCallRecord[];
  usage?: TokenUsage;
  source?: TurnSource;
}

/** 工具调用的持久化表示（扁平化，不含 tool_use/tool_result 的嵌套结构） */
export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

/** JSONL 特殊行：上下文压缩边界标记 */
export interface CompactMarker {
  type: "compact";
  timestamp: string;
  summary: string;
  turnsCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
}

/** 所有可出现在 JSONL 中的记录类型 */
export type TranscriptRecord = TranscriptHeader | Turn | CompactMarker;

// ─── Transcript Store 接口 ───

/** 加载转录的返回结构 */
export interface LoadedTranscript {
  header: TranscriptHeader;
  messages: Message[];
  turnCount: number;
}

/**
 * TranscriptStore 公共接口 — append-only 内容日志
 *
 * 职责边界（ADR-CM-015）：
 * - 只负责内容的写入和读取
 * - 没有 list / rename / delete / findLatest — 这些是身份操作，属于 ConversationRepository
 */
export interface ITranscriptStore {
  init(conversationId: string, options: InitTranscriptOptions): Promise<void>;
  appendTurn(conversationId: string, turn: Turn): Promise<void>;
  appendCompact(conversationId: string, compact: CompactMarker): Promise<void>;
  load(conversationId: string): Promise<LoadedTranscript>;
  countTurns(conversationId: string): Promise<number>;
  exists(conversationId: string): Promise<boolean>;
}

export interface InitTranscriptOptions {
  model: string;
  provider: string;
}

// ─── 常量 ───

/** JSONL 格式版本 */
export const TRANSCRIPT_FORMAT_VERSION = 1;
