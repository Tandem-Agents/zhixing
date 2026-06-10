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
  /** 用户可通过 REPL 内 `/name` / `/new <name>` 命令设置的显示名 */
  name: string | null;
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
  /**
   * tool_use 协议层 id —— 同 turn 内 tool_use ↔ tool_result 配对锚点。
   *
   * 字段引入前的 transcript 文件中此字段缺失（undefined），新写入的 record
   * 一定含有 id（buildRecord 强制写入）。consumers 在按 id 反查时对老文件
   * record.id=undefined 自然返 not found —— 与"已 compact 不可达"语义对等，
   * 不需要派生伪 id。
   */
  id?: string;
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

/**
 * JSONL 特殊行：上下文压缩边界标记。
 *
 * 两种来源产生 marker，填法契约不同：
 *
 *   1. 段切换路径（段式上下文管理触顶整段压缩）：必填 `segmentId` +
 *      `structuredSummary` + `summary`；`summary` 是 `structuredSummary` 三段
 *      拼接成的平文本副本（保下游兼容）。
 *
 *   2. 数据层兜底路径（budget critical 触发 LLMSummarize 直接摘 raw）：只填
 *      `summary` 平文本；`segmentId` / `structuredSummary` 缺省。
 *
 * 消费方读 marker 时优先用 `structuredSummary` 重建结构化视图；不存在时降级
 * 用 `summary` 平文本。这保证两条产生路径的 marker 在下游消费时的语义一致性。
 *
 * transcript 中 marker 是**单 frontier**（每次写入覆盖前 marker）—— 沿用现有
 * normalize 语义；段切换的历史元数据累积走 `Conversation.segmentMetadata`（不
 * 在 transcript 中数组化），两条数据流职责分离。
 */
export interface CompactMarker {
  type: "compact";
  timestamp: string;
  /** 平文本摘要 —— 必填，两种产生路径都填 */
  summary: string;
  turnsCompacted: number;
  tokensBefore: number;
  tokensAfter: number;

  /** 段切换路径必填：段唯一标识，与 Conversation.segmentMetadata.segments 关联 */
  segmentId?: string;
  /** 段切换路径必填：结构化摘要三段 */
  structuredSummary?: {
    /** 讨论过的事实、事件、决策（结论性陈述，不展开过程）*/
    facts: string;
    /** 当前进行中的任务、未完成事项、用户期望 */
    state: string;
    /** 后续协作必须知道的具体信息：文件路径、变量名、技术决策、用户偏好等 */
    active: string;
  };
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
 * TranscriptStore 公共接口 — 原子事务内容日志
 *
 * 职责边界（ADR-CM-015）：
 * - 只负责内容的写入和读取
 * - 没有 list / rename / delete / findLatest — 这些是身份操作，属于 ConversationRepository
 *
 * 原子化（ADR-TR-2, ADR-TR-7）：
 * - `commitTurn` 是**唯一主入口**，覆盖 append turn / 带 compact 截断 / 手动 /compact
 *   三种形态；原子写保证 compact 和 turn 不再被分两次操作写入（根治 §1.3 timestamp 顺序 bug）
 * - 返回 canonical `Message[]`，调用方一次拿到 state 权威视图，无须自行 rebuild
 *
 * Per-transcript 串行化（ADR-TR-8）：
 * - 对同一 id 的所有写操作（含 load 触发的 normalize 重写）**串行化**
 * - 跨 id 完全并发
 */
export interface ITranscriptStore {
  init(conversationId: string, options: InitTranscriptOptions): Promise<void>;

  /**
   * 唯一原子写入入口 —— 覆盖 append / 带 compact 截断 / 手动 /compact 三种形态。
   *
   * 语义表（按 payload 字段）：
   * | payload | 行为 | 文件形态变化 |
   * |---------|------|-------------|
   * | `{turn}` | append 新 turn | `header + [compact?] + ...turns + turn` |
   * | `{turn, compactBefore}` | 原子重写，按 turnsCompacted 切分保留末尾 + 追加新 turn | `header + compactBefore + retainedTurns + turn` |
   * | `{compactBefore}`（手动 /compact） | 原子重写，按 turnsCompacted 切分保留末尾 | `header + compactBefore + retainedTurns` |
   * | `{}` | 非法 | throw `commitTurn requires at least turn or compactBefore` |
   *
   * 返回 canonical `Message[]`：当前调用方（REPL / server）不再消费——内存状态由
   * 注意力窗口经接受协议自行前进，不从持久化回喂；/clear 路径经 compactAll 的
   * 返回值重建窗口仍依赖 canonical 形态。签名保留为 API 现状，store 重写时收敛。
   */
  commitTurn(
    conversationId: string,
    payload: { turn?: Turn; compactBefore?: CompactMarker },
  ): Promise<Message[]>;

  /**
   * Legacy 薄别名。内部委托 `commitTurn({turn})`，保留为向后兼容入口。
   * 新代码请直接用 `commitTurn`。
   */
  appendTurn(conversationId: string, turn: Turn): Promise<void>;

  /**
   * Legacy 薄别名。内部委托 `commitTurn({compactBefore})`，返回 canonical。
   * REPL 手动 /compact 使用；新代码也可直接用 `commitTurn({compactBefore})`。
   */
  appendCompact(
    conversationId: string,
    compact: CompactMarker,
  ): Promise<Message[]>;

  /**
   * 全量压缩当前对话——折叠所有 turns 为一条 compact marker，原子重写 transcript。
   *
   * 与 `commitTurn({ compactBefore })` 共享底层写入路径，差异在 `turnsCompacted` 由
   * store 在 lock 内计算 = 当前磁盘 turns 数（race-free），caller 不需先 load 再算。
   *
   * 用途：用户主动"清空对话历史"语义（cli `/clear`）。压缩后 canonical =
   * `[summaryMsg, ackMsg]` 两条 system-meta，LLM 视角"对话已清空"——下次 LLM
   * 调用不会重新看到任何老 turn。磁盘文件原子重写为 `header + [marker]`，老 turns
   * 不再可恢复（与自动 compact 路径行为一致）。
   *
   * `summary` 由 caller 提供——会经 `buildCompactSummaryPair` 包成 LLM 可见的
   * summaryPair 起首。"用户主动"场景传简短 placeholder（如"(用户已清空对话历史)"）即可，
   * 不需要 LLM 总结。
   */
  compactAll(
    conversationId: string,
    summary: string,
  ): Promise<Message[]>;

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
