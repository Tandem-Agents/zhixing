/**
 * Run record 构造器 —— 从 run 产物组装持久化输入，及其读侧派生 helpers。
 *
 * 职责：在 AgentRuntime.run() 结束前，从
 *   - 原始 userMessage（未经任何注入增强的版本）
 *   - yield 流重建的 newMessages（含 assistant 与 tool_result）
 *   - agentResult（提供 usage）
 * 组装一个 RunRecordInput —— 本 run 的**完整协议消息序列**作为唯一权威内容
 * 字段（messages = [用户原文, ...newMessages]），不落任何派生冗余；runIndex
 * 由持久化层在追加时分配，构造器不经手。
 *
 * 读侧派生（消费方需要"最终回复 / 工具调用清单"时用，纯函数零成本）：
 *   - userMessageOf：messages[0] 恒为用户原文
 *   - finalAssistantMessageOf：末条 assistant；无（run 在首次 LLM 完成前
 *     中断 / 出错）则空 assistant 兜底，调用方不需特判
 *   - deriveToolCalls：扫描 tool_use / tool_result 配对成扁平审计清单
 *
 * 纯函数 + 独立模块：所有输入显式传入、时间戳可注入（测试固化）、无副作用。
 */

import type { AgentResult } from "./types.js";
import type {
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from "../types/messages.js";
import {
  emptyAssistantMessage,
  findLastAssistantMessage,
} from "../types/messages.js";
import type { RunRecordInput } from "../transcript/shard/types.js";
import type {
  RunRecordAdvancementMetadata,
  ToolCallRecord,
  TurnSource,
} from "../transcript/types.js";

// ─── 构造 ───

export interface BuildRunRecordInput {
  /**
   * 原始 user 消息（未经任何注入增强的版本）。
   *
   * 持久化的 messages[0] 必须是用户真实输入——run 输入由会话层瞬态构造
   * （[...窗口, 用户消息]），调用方传入的正是那条未改写的用户消息。
   */
  readonly userMessage: Message;

  /**
   * 本 run 的 yield 流重建出的新消息序列。
   * 格式：`[assistant_msg_1, toolResult_user_msg_1?, assistant_msg_2?, ...]`
   * —— 输出侧重建，turn-context 等输入侧注入不在其中，序列天然干净。
   */
  readonly newMessages: readonly Message[];

  /** Agent loop 终止结果，仅取 usage（终止原因是运行时控制信号，不进记录） */
  readonly agentResult: AgentResult;

  /** 触发源，由调用方传入并落盘为 run 级元数据 */
  readonly source?: TurnSource;

  /** 推进侧代理 run 的产品层元数据；不进入 Message role/content */
  readonly advancement?: RunRecordAdvancementMetadata;

  /** 时间戳，默认现时；测试 / 确定性构造时可显式覆盖 */
  readonly timestamp?: string;
}

/** 组装本 run 的持久化输入 —— 完整协议序列 [用户原文, ...newMessages] */
export function buildRunRecord(input: BuildRunRecordInput): RunRecordInput {
  return {
    timestamp: input.timestamp ?? new Date().toISOString(),
    messages: [input.userMessage, ...input.newMessages],
    usage: input.agentResult.usage,
    source: input.source,
    advancement: input.advancement,
  };
}

// ─── 读侧派生 ───

/** 用户原文 —— 完整协议序列的首条（持久化契约保证） */
export function userMessageOf(messages: readonly Message[]): Message {
  const first = messages[0];
  if (!first) {
    throw new Error("userMessageOf: 空消息序列——run record 至少含用户消息");
  }
  return first;
}

/**
 * 最终回复 —— 末条 assistant；tool-loop 场景中间有多条 assistant（还在发
 * tool_use），最后一条才是工具链结束后的总结。无 assistant（abort / error
 * 在首次 LLM 完成前）→ 空 assistant 兜底，保持配对结构完整。
 */
export function finalAssistantMessageOf(messages: readonly Message[]): Message {
  return findLastAssistantMessage(messages) ?? emptyAssistantMessage();
}

/**
 * 从协议序列派生扁平工具调用清单（审计 / 渲染用）。
 *
 * 算法：先建 toolUseId → tool_result 索引，再按 tool_use 出现顺序配对。
 * Orphan（tool_use 无对应 result——中途被打断）→ result=""、isError 缺省，
 * 记录保留作审计（谁发起了这个调用）。
 */
export function deriveToolCalls(
  messages: readonly Message[],
): ToolCallRecord[] {
  const resultsById = new Map<string, ToolResultBlock>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        resultsById.set(block.toolUseId, block);
      }
    }
  }

  const records: ToolCallRecord[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        records.push(buildToolCallRecord(block, resultsById.get(block.id)));
      }
    }
  }
  return records;
}

function buildToolCallRecord(
  use: ToolUseBlock,
  result: ToolResultBlock | undefined,
): ToolCallRecord {
  return {
    id: use.id,
    name: use.name,
    input: use.input,
    result: result?.content ?? "",
    isError: result?.isError,
  };
}
