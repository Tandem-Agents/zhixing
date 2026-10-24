/**
 * 分片化 transcript 的类型定义。
 *
 * 分层原则：持久化只存读**原始对话信息**——append-only、永不因上下文 / 模型
 * 尺寸删数据；"渲染摘要、拼装窗口"等构建 LLM 视图的活归上下文层。分片内
 * 没有也永远不会有任何压缩边界 / 窗口派生状态。
 */

import type { Message } from "../../types/messages.js";
import type { TokenUsage } from "../../types/llm.js";
import type { PostTurnControlOutcome } from "../../types/agent-events.js";
import type { TurnOrigin } from "../../types/tools.js";
import type {
  RunRecordAdvancementMetadata,
  RunRecordPerspectivesMetadata,
  TurnSource,
} from "../types.js";

// ─── 分片索引 ───

/**
 * 早期本地测试资料的 v1 索引（整文件 `index.json`）。当前格式由 `root.bin` 与各片 `.pos`
 * 表达；v1 只在首次打开时一次性转换，原件保留不改。
 */
export interface TranscriptIndex {
  version: 1;
  conversationId: string;
  /** 恰指向一个 isActive:true 的分片 */
  activeShardId: string;
  /**
   * 最近一次清空事件的时刻 —— 派生缓存（摘要快照）退役判据的元数据投影。
   * 读边界以分片内 ClearRecord 为权威；本字段供清理路径只读元数据即可判退役。
   */
  lastClearAt?: string;
  shards: TranscriptShardMeta[];
}

export interface TranscriptShardMeta {
  /** 零填充递增序号，如 "000001" —— 同时是文件名主干 */
  id: string;
  /** 相对 transcript/ 目录的文件名 */
  file: string;
  /** ISO 时刻，取写入时值 —— 时间窗清理的唯一判据 */
  createdAt: string;
  isActive: boolean;
  firstRunIndex?: number;
}

// ─── 分片记录行 ───

/** 每分片首行 —— 身份信息单一归属 conversation meta，header 只锚定自身 */
export interface ShardHeader {
  type: "header";
  version: 1;
  conversationId: string;
  shardId: string;
  createdAt: string;
  /** 本片首个 run 的 runIndex（换片时的 nextRunIndex）；旧读者只校验必需字段，容忍此字段 */
  firstRunIndex?: number;
}

/**
 * 一个 run 的完整协议消息序列 —— 唯一权威内容字段。
 *
 * `messages` = [用户原文 user, ...本 run 全部 assistant 与 tool_result 消息]。
 * 不落任何派生冗余（最终回复 / 工具调用索引都是 messages 的投影，读侧
 * 纯函数派生）；`messages[0]` 恒为用户原文、全序列不含任何注入。
 */
export interface RunRecord {
  type: "run";
  /** 对话内单调递增、跨分片连续 —— 唯一 assigner 是 store（append 时分配） */
  runIndex: number;
  timestamp: string;
  messages: Message[];
  usage?: TokenUsage;
  source?: TurnSource;
  advancement?: RunRecordAdvancementMetadata;
  perspectives?: RunRecordPerspectivesMetadata;
  /** 已确认的轮次后交接提议；随原运行提交，不能仅留在接入面的通知中。 */
  postTurnControl?: PostTurnControlOutcome;
  /** 由准入来源提供，最终结果回源不依赖实时帧是否到达。 */
  worksceneContinuation?: TurnOrigin["worksceneContinuation"];
}

/** 跨执行边界提交的 run 记录，以 runId 提供不依赖存储序号的稳定身份。 */
export type TranscriptRunRecord = RunRecord & { runId: string };

/**
 * 清空事件 —— "清空"是事实流里的一个事件、不是销毁：一切读路径（倒读 /
 * 计数 / 未来检索召回）以最近一条 ClearRecord 为硬边界，其前的数据物理仍在、
 * 由时间窗清理自然收走。
 */
export interface ClearRecord {
  type: "clear";
  timestamp: string;
}

export type ShardRecordLine = ShardHeader | RunRecord | TranscriptRunRecord | ClearRecord;

// ─── 出入参 ───

/** appendRunRecord 的入参 —— runIndex 由 store 分配，调用方不传 */
export interface RunRecordInput {
  timestamp: string;
  messages: Message[];
  usage?: TokenUsage;
  source?: TurnSource;
  advancement?: RunRecordAdvancementMetadata;
  perspectives?: RunRecordPerspectivesMetadata;
  postTurnControl?: PostTurnControlOutcome;
  worksceneContinuation?: TurnOrigin["worksceneContinuation"];
}

/** appendRunRecord 的结果 —— 供调用方做派生缓存的覆盖锚点等 */
export interface AppendRunResult {
  runIndex: number;
  shardId: string;
  /** false：expectedRunIndex 指向的位置已发布同一记录，本次未追加 */
  appended?: boolean;
}

/** appendRunRecord 的选项 */
export interface AppendRunOptions {
  /**
   * 调用方认定的本条位置（如 promote 队首的 provisionalRunIndex）。小于已发布水位时按该位置
   * 核对已发布记录：相同返回 appended: false，不同报冲突；身份来自位置，正文只用于核对。
   */
  readonly expectedRunIndex?: number;
}

/** owner 物化的来源绑定，复用已提交事实的身份字段 */
export interface CommittedRunSource {
  readonly assignmentId: string;
  readonly commitRevision: number;
  readonly digest: string;
}

/** 只读视图：一次读取以同一次取到的根为边界，只读已发布前缀 */
export interface TranscriptView {
  readonly pub: number;
  readonly activeSeq: number;
  /** 活跃片的已发布字节数；读活跃片只读到这里 */
  readonly tailSize: number;
  /** 已发布水位；旧测试格式的只读派生视图中未知 */
  readonly nextRunIndex?: number;
  /** 可见下界：序号小于它的片已撤可见 */
  readonly fromSeq: number;
  readonly fromRunIndex: number;
  readonly clearBoundaryRunIndex?: number;
  readonly lastClearAt?: string;
  /** 活跃片之前那一片的封片字节数；更早的封存片的封片长度记在其后继片的位置文件头里 */
  readonly prevSealedSize?: number;
  /** 严格区起点：其后的已发布字节不可解析即为损坏；之前的字节来自旧测试格式转换，按容忍处理 */
  readonly strictFrom?: { readonly seq: number; readonly offset: number };
}

/**
 * 读取一片。带视图时只读该视图下的已发布范围（活跃片到 tailSize，封存片到封片长度），
 * 文件短于已发布范围、或严格区内有不可解析的行，都按损坏报告；不带视图时读整个文件，坏行跳过。
 */
export interface TranscriptShardRef {
  readonly seq: number;
  readonly view?: TranscriptView;
}

/** 写入在恢复后仍无法确认是否耐久发布：调用方不得按“确定失败”处理 */
export class TranscriptOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptOutcomeUnknownError";
  }
}

/** 目录状态与已发布事实不符（根两半都无效、有分片却无根、未经意图解释的字节等）：失败关闭 */
export class TranscriptDirectoryDamagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptDirectoryDamagedError";
  }
}

/** 只读者遇到根正在被连续发布、有界重读仍未收敛：可重试，不是损坏 */
export class TranscriptViewBusyError extends Error {
  constructor() {
    super("Transcript directory root is being published; retry the read");
    this.name = "TranscriptViewBusyError";
  }
}

/** AuthorityCommitLog 派生投影的追加结果；重复 runId 只返回既有位置。 */
export interface AppendCommittedRunResult extends AppendRunResult {
  appended: boolean;
  /**
   * "retired"：该 run 已投影，但其分片已被保留期清理，无法再核对载荷；shardId 为
   * 定位落点的已删分片。缺省表示已逐条核对（或刚追加）。
   */
  evidence?: "retired";
}

/** 倒读原语的游标 —— 无状态分页：传上一页最早一条的位置，从它之前继续 */
export interface RunRecordRef {
  shardId: string;
  runIndex: number;
}

export const TRANSCRIPT_INDEX_VERSION = 1;
export const SHARD_FORMAT_VERSION = 1;

/** 单分片字节上限默认值 —— 判断时机而非硬切：超限后下一个新 run 进新分片 */
export const DEFAULT_MAX_SHARD_BYTES = 7 * 1024 * 1024;
