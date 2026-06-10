/**
 * Turn 构造器 —— 从 run 产物组装持久化 Turn 结构
 *
 * 职责：在 AgentRuntime.run() 结束前，从
 *   - 原始 userMessage（未注入增强的版本）
 *   - yield 流重建的 newMessages（含 assistant 与 tool_result）
 *   - agentResult（提供 usage / 终止原因）
 * 组装一个 Turn 对象，作为 RunResult.turn 返回给调用方，由后者走
 * TranscriptStore.commitTurn 落盘。
 *
 * 为什么是纯函数 + 独立模块：
 *   - 责任归属明确（设计文档 §0.7.8）—— 一个地方构造，避免 REPL/server 各自散落
 *   - pure：所有输入显式传入，时间戳可注入（测试时可固化）
 *   - 无副作用：只做结构转换，不调 store / eventBus / network
 *   - 可插拔：未来若 Turn 结构演进（如加 digest / raw payload），在此集中扩展
 */

import type { AgentResult } from "./types.js";
import type { Message, ToolResultBlock, ToolUseBlock } from "../types/messages.js";
import {
  emptyAssistantMessage,
  findLastAssistantMessage,
} from "../types/messages.js";
import type {
  CompactMarker,
  ToolCallRecord,
  Turn,
  TurnSource,
} from "../transcript/types.js";

// ─── 输入 ───

export interface BuildTurnInput {
  /**
   * 本 turn 序号，由调用方持有的 counter 提供。
   * REPL: `state.turnCounter`；server: `ManagedSession.turnCount`；ephemeral: 0。
   */
  readonly turnIndex: number;

  /**
   * 原始 user 消息（未经 <context> / turn-context 注入增强的版本）。
   *
   * 持久化的 userMessage 必须是用户真实输入，而不是带上下文注入的内部增强版。
   * AgentRuntime.run 在内部维护 `params.messages`（原始）/ `injectedMessages`
   * （注入后送 LLM）两份引用，调用方传入前者。
   */
  readonly userMessage: Message;

  /**
   * 本 run 的 yield 流重建出的新消息序列（与 canonical 正交，见 §0.7.9）。
   * 格式：`[assistant_msg_1, toolResult_user_msg_1?, assistant_msg_2?, ...]`
   */
  readonly newMessages: readonly Message[];

  /**
   * Agent loop 的终止结果。仅用于 `usage` 字段；终止原因不进 Turn（Turn
   * 是"发生了什么"的记录，reason 是运行时控制信号）。
   */
  readonly agentResult: AgentResult;

  /**
   * 触发源，落盘作 Turn.source。REPL 默认 "interactive"，定时任务 "scheduler"，
   * 外部 channel "channel"。由调用方传入；不提供时字段为 undefined。
   */
  readonly source?: TurnSource;

  /**
   * 时间戳，默认 `new Date().toISOString()`。
   * 测试 / 确定性构造（如 ephemeral promote 对齐时间）时可显式覆盖。
   */
  readonly timestamp?: string;
}

// ─── 入口 ───

/**
 * 从 run 产物组装 Turn。
 *
 * 契约：
 *   - `userMessage` 原样进 `Turn.userMessage`（调用方负责去除注入）
 *   - `assistantMessage` = newMessages 里最后一条 role="assistant" 的消息
 *     （pure-text turn → LLM 文本回复；tool-loop turn → 工具链结束后的总结 assistant）
 *   - 若无 assistant（abort / error / 罕见路径），塞一条空 assistant 作兜底 —— 保持
 *     Turn 结构完整，调用方不需特判。同时附 BUILD_TURN_EMPTY_ASSISTANT 备忘日志
 *     （commit 后可按需扩展成 event，当前静默兜底）
 *   - `toolCalls` = 扫描 newMessages 里所有 tool_use block，与 tool_result（按
 *     toolUseId）配对成 ToolCallRecord[]；无 tool 调用时字段为 undefined（而非 []）
 *     以保持 JSONL 紧凑
 *   - `usage` 从 agentResult.usage 取；always present（AgentResult 各分支均含 usage）
 *
 * 纯函数，可在任何层调用（AgentRuntime.run、测试、手动构造 ephemeral promote 前的
 * 回填等）。
 */
export function buildTurn(input: BuildTurnInput): Turn {
  const { turnIndex, userMessage, newMessages, agentResult, source } = input;
  const timestamp = input.timestamp ?? new Date().toISOString();

  // 取最后一条 assistant：tool-loop 场景 newMessages 有多条 assistant
  // （中间的还在发 tool_use），最后一条才是工具链结束后的总结回复。
  // 无 assistant（abort / error 在首次 LLM 完成前）→ 空 assistant 兜底，
  // 保持 Turn 结构完整，调用方不需特判。
  const assistantMessage =
    findLastAssistantMessage(newMessages) ?? emptyAssistantMessage();
  const toolCalls = extractToolCalls(newMessages);

  return {
    type: "turn",
    turnIndex,
    timestamp,
    userMessage,
    assistantMessage,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: agentResult.usage,
    source,
  };
}

// ─── 时序协调 helper ───

/**
 * 返回一个与 compact 严格有序的 ISO timestamp：
 *   - 无 compactBefore：`new Date().toISOString()`（标准现时）
 *   - 有 compactBefore：`max(现时, compactBefore.timestamp + 1ms)`
 *
 * 为什么需要：同一次提交里 turn 逻辑上发生在 compact 之后（先摘旧、后落新），
 * 但二者各自取 `new Date()`（毫秒粒度），极端场景（pre-flight compact 立即
 * abort / 超快 turn）可能同毫秒甚至反序。本 helper 保证 turn.timestamp 严格
 * 晚于 marker —— 让落盘记录的时间线与事件真实顺序一致，供展示、诊断与按时间
 * 排序的消费方直接信赖。归一化判定不依赖时间戳（按文件物理顺序判），数据
 * 存留不受此影响——这是纯粹的时间线卫生。buildTurn 保持纯 —— 时序协调是
 * run 层知识。
 *
 * 跨包共享：cli 的 run-agent、server 的 adapter、测试都应通过此函数构造 timestamp。
 */
export function resolveTurnTimestamp(compactBefore?: CompactMarker): string {
  const now = Date.now();
  if (!compactBefore) return new Date(now).toISOString();
  const compactMs = Date.parse(compactBefore.timestamp);
  // compact.timestamp 非法（Date.parse 返 NaN）也退化到现时 —— 防御输入不合规
  if (Number.isNaN(compactMs)) return new Date(now).toISOString();
  return new Date(Math.max(now, compactMs + 1)).toISOString();
}

// ─── 内部辅助 ───

/**
 * 提取 tool_use / tool_result 配对成 ToolCallRecord[]。
 *
 * 算法：
 *   1. 一次遍历建 toolUseId → ToolResultBlock 索引（tool_result 出现在后续 user 消息里）
 *   2. 再遍历按 tool_use 发生顺序构造 ToolCallRecord，查索引拿 result
 *
 * Orphan 处理：tool_use 找不到对应 result（abort / 错误路径中途被打断）
 *   → ToolCallRecord.result = ""，isError 为 undefined；记录留下但表示"执行未完成"
 *   此约定和 `rebuildCanonicalMessages` 里的孤儿 tool_use 跳过规则正交：
 *     - transcript 层保留记录作审计（谁发起了这个 tool_use）
 *     - LLM 视角下 rebuild 时由 canonical 层处理（不塞无 result 的 tool_use 给 LLM）
 *
 * 顺序保证：ToolCallRecord 按 tool_use 在消息流中的出现顺序排列；
 * Turn.toolCalls[i] 的下标和"第 i 次工具调用"对齐，诊断 / 反思可直接按下标引用。
 */
function extractToolCalls(messages: readonly Message[]): ToolCallRecord[] {
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
        records.push(buildRecord(block, resultsById.get(block.id)));
      }
    }
  }
  return records;
}

function buildRecord(
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
