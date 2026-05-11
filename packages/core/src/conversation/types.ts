/**
 * Conversation 持久层类型定义
 *
 * Conversation 是用户视角的对话身份，持久化在磁盘的 meta.json，
 * 与 SessionRuntime（内存运行态）和 Turn（单次执行）分层。
 */

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

  /**
   * LLM 自我组织的任务列表状态 —— 由 task_list 工具读写。
   *
   * 跨段切换保留不变（段切换不清空、不修改）；只受 LLM 主动 `task_list.set`
   * 或用户 `/task done` 改变。`/clear` 时清空。
   */
  taskListState?: TaskListState;

  /**
   * 段切换元数据 —— 累积段切换历史。
   *
   * transcript 中的 CompactMarker 是单 frontier（每次段切换覆盖前 marker，沿用
   * normalize 语义）；段历史累积只走这一条数据流。`/clear` 时清空。
   */
  segmentMetadata?: SegmentMetadata;
}

/** 对话的隔离作用域 */
export type ConversationScope =
  | { kind: "user" }
  | { kind: "project"; projectId: string; projectPath: string };

// ─── task_list 状态 ───

/** 任务项 —— task_list 工具的核心数据单元 */
export interface TaskItem {
  /** 任务唯一标识符（任务列表内稳定，由生成者保证）*/
  id: string;
  /** 任务描述文本 */
  content: string;
  /** 任务状态：未开始 / 进行中 / 已完成 */
  status: "pending" | "in_progress" | "completed";
}

/** task_list 持久化状态 —— Conversation.taskListState 字段类型 */
export interface TaskListState {
  /** 当前任务项列表（顺序保留 LLM 设置时的顺序） */
  items: readonly TaskItem[];
}

// ─── 段切换元数据 ───

/** 单次段切换的元数据 —— segmentMetadata.segments 数组的元素 */
export interface SegmentMeta {
  /** 段唯一标识符，与 CompactMarker.segmentId 关联 */
  segmentId: string;
  /** 段切换发生时刻（ISO timestamp） */
  timestamp: string;
  /** 压缩前的 token 计数 */
  tokensBefore: number;
  /** 压缩后的 token 计数（即摘要 + 缓冲带占用） */
  tokensAfter: number;
}

/** 段切换累积元数据 —— Conversation.segmentMetadata 字段类型 */
export interface SegmentMetadata {
  /** 当前活跃段 ID（最近一次段切换产生的段） */
  currentSegmentId: string;
  /** 历史段元数据（按时间顺序累积，最新在尾） */
  segments: readonly SegmentMeta[];
}

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
  /**
   * 清空视图层状态字段（taskListState + segmentMetadata）—— `/clear` 命令路径。
   *
   * 走与 writeMeta 同款的 atomic write + per-id lock，保并发安全；conversation
   * 不存在时 no-op（不抛错）。身份字段（id / name / scope / preferences 等）完全
   * 保留——`/clear` 是"重置对话内容到新起点"，不是删除对话身份。
   */
  clearViewLayerState(id: string): Promise<void>;
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
