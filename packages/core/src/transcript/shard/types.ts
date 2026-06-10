/**
 * 分片化 transcript 的类型定义。
 *
 * 分层原则：持久化只存读**原始对话信息**——append-only、永不因上下文 / 模型
 * 尺寸删数据；"渲染摘要、拼装窗口"等构建 LLM 视图的活归上下文层。分片内
 * 没有也永远不会有任何压缩边界 / 窗口派生状态。
 */

import type { Message } from "../../types/messages.js";
import type { TokenUsage } from "../../types/llm.js";
import type { TurnSource } from "../types.js";

// ─── 分片索引 ───

/**
 * 分片索引 —— owner（写入方）唯一可写，整文件原子重写（tmp + rename）。
 *
 * `createdAt` 取索引记录值、不依赖文件系统时间戳（Windows birthtime 不可靠、
 * 跨平台不一致）——这是清理判据稳定的前提。垃圾回收对索引**只读**、对分片
 * 文件只删：从根上消除跨进程并发写索引的冲突。
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
}

// ─── 分片记录行 ───

/** 每分片首行 —— 身份信息单一归属 conversation meta，header 只锚定自身 */
export interface ShardHeader {
  type: "header";
  version: 1;
  conversationId: string;
  shardId: string;
  createdAt: string;
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
}

/**
 * 清空事件 —— "清空"是事实流里的一个事件、不是销毁：一切读路径（倒读 /
 * 计数 / 未来检索召回）以最近一条 ClearRecord 为硬边界，其前的数据物理仍在、
 * 由时间窗清理自然收走。
 */
export interface ClearRecord {
  type: "clear";
  timestamp: string;
}

export type ShardRecordLine = ShardHeader | RunRecord | ClearRecord;

// ─── 出入参 ───

/** appendRunRecord 的入参 —— runIndex 由 store 分配，调用方不传 */
export interface RunRecordInput {
  timestamp: string;
  messages: Message[];
  usage?: TokenUsage;
  source?: TurnSource;
}

/** appendRunRecord 的结果 —— 供调用方做派生缓存的覆盖锚点等 */
export interface AppendRunResult {
  runIndex: number;
  shardId: string;
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
