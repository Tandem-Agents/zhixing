/**
 * 事实锚生成器接口
 *
 * 每个工具实现一个 AnchorGenerator，从 tool_use.input + tool_result 元信息
 * 提炼简短结构化文本（事实锚），替代历史 tool_result 的完整 raw 内容。
 *
 * 设计原则：
 * - 主要从 tool_use.input 提炼（输入参数永不变，不受 tier-compressor 字符截断影响）
 * - 辅以 tool_result.isError 等不变量
 * - 不解析 content 内部结构（格式可能变化）
 * - 失败可返 null，由 AnchorRegistry 走通用 fallback 锚
 *
 * **准确性边界（spec §11.3 已记录）**：
 *   当前 generator 若从 `toolResult.content` 推断 metadata（如 split("\n") 算行数 /
 *   content.length 算 chars），在数据层 tier-compressor 截断后（T2: 2000 chars /
 *   T3: 500 chars / T4: skeleton）行数与 chars 都是**截断后的值**，不是 tool 执行
 *   时的真实值。innovation §6.3 "100% 准确硬事实"承诺仅在 T1 范围（distance ≤ 2）
 *   内成立；T2 退化为部分精确，T3+ 退化为弱锚。
 *
 *   彻底修法（非 Phase 0 范围）：扩展 ToolResult 协议在执行时记录原始 metadata
 *   （原行数 / 原 size），generator 消费 metadata 而非 content。当前实现接受
 *   此局限，spec §11 已列入风险表。
 */

import type {
  ToolResultBlock,
  ToolUseBlock,
} from "../../../types/messages.js";

export interface AnchorGenerator {
  /** 工具名（与 ToolDefinition.name 严格匹配） */
  readonly toolName: string;

  /**
   * 从 tool_use 与 tool_result 生成事实锚字符串。
   *
   * 返回 null 表示输入参数缺失关键字段（如 path / command 等），
   * AnchorRegistry 走通用 fallback。
   */
  generate(toolUse: ToolUseBlock, toolResult: ToolResultBlock): string | null;
}
