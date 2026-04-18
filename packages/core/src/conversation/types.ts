/**
 * Conversation 持久层类型定义
 *
 * 对应 conversation-model.md §3.1 — Conversation 是用户视角的对话身份，
 * 持久化在磁盘，与 SessionRuntime（内存运行态）和 Turn（单次执行）分层。
 */

import type { ScenarioHint } from "../context/context-profile.js";

// ─── 核心类型 ───

/** 用户视角的对话身份（持久化在磁盘的 meta.json） */
export interface Conversation {
  /** 用户可读的稳定 ID，创建后不可改；slug 格式 */
  id: string;
  /** 用户给的显示名，可重命名 */
  name: string;
  createdAt: string;
  /** 最近一次 turn 完成时刻 */
  lastActiveAt: string;
  /** 默认对话标记，不可删除 */
  isDefault: boolean;
  /** 归档：从默认列表隐藏，但物理数据保留 */
  archived: boolean;
  /** 偏好的 model（首次对话时确定，可被显式覆盖） */
  preferredModel?: string;
  /** 偏好的 provider */
  preferredProvider?: string;
  /** 隔离作用域 */
  scope: ConversationScope;
  /** 场景 hint：Turn 1 分类后 Sticky 持久，单调升级 */
  currentHint?: ScenarioHint;
}

/** 对话的隔离作用域 */
export type ConversationScope =
  | { kind: "user" }
  | { kind: "project"; projectId: string; projectPath: string };

// ─── Repository 接口 ───

/** ConversationRepository 公共接口 — Conversation 身份的磁盘 CRUD (meta.json) */
export interface IConversationRepository {
  list(opts?: { includeArchived?: boolean }): Promise<Conversation[]>;
  get(id: string): Promise<Conversation | null>;
  create(opts: CreateConversationOptions): Promise<Conversation>;
  rename(id: string, name: string): Promise<Conversation>;
  archive(id: string, archived: boolean): Promise<Conversation>;
  delete(id: string): Promise<void>;
  ensureDefault(): Promise<Conversation>;
  findLatest(): Promise<string | null>;
  touch(id: string): Promise<void>;
}

export interface CreateConversationOptions {
  name?: string;
  preferredModel?: string;
  preferredProvider?: string;
  scope?: ConversationScope;
}

// ─── 常量 ───

export const DEFAULT_CONVERSATION_ID = "default";
export const DEFAULT_CONVERSATION_NAME = "默认对话";
