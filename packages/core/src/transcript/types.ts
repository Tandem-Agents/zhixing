/**
 * Transcript 持久化的跨模块基础类型。
 *
 * 持久化本体（索引 / 分片 / 记录行 / 倒读原语）见 shard/ 子模块——本文件
 * 只留与协议消息派生相关、被多包共享的基础类型。
 */

// ─── 触发源 ───

/** 触发源标识 —— 落盘为 run record 的 source 字段 */
export type TurnSource = "interactive" | "scheduler" | "channel";

// ─── 工具调用的派生表示 ───

/**
 * 工具调用的扁平化表示（审计 / 渲染用）——`deriveToolCalls` 从 run record
 * 的完整协议消息序列派生，**不落盘**（messages 是唯一权威内容字段，本类型
 * 是它的只读投影）。
 */
export interface ToolCallRecord {
  /** tool_use 协议层 id —— 同 run 内 tool_use ↔ tool_result 配对锚点 */
  id?: string;
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}
