/**
 * ToolResultAnchorStage — view-layer 视图层语义锚化
 *
 * 在每次 LLM call 之前对 messages 中的历史 tool_result 应用事实锚（anchor）：
 * - Focus（最近一条 assistant message 中所有 tool_use 的 tool_result）：保 raw 完整不动
 * - Anchor（其他更早的 tool_result）：替换为 AnchorRegistry 输出的简短结构化文本
 *
 * Focus 取"最近一条 assistant 中所有 tool_use ids 的集合"而非单一 id，
 * 因为协议支持 parallel tool_use（一次 assistant 同时发多个 tool_use 块），
 * 这一批 tool_result 在下一 LLM call 是 LLM 第一次消化它们的同一个时刻 ——
 * 必须整批保 raw 才能兑现"Focus 期不削弱信息"的设计核心（innovation §4.2 / §6.5）。
 * 单 id Focus 会让并行批次的非末尾 tool_result 在第一次曝光就只剩 anchor。
 *
 * 与数据层 manageWindow.applyTierCompression 各司其职：
 * - 数据层 tier-compressor 负责 state.messages 体积管理（lossy 字符截断）
 * - 视图层 ToolResultAnchorStage 负责 LLM 视图认知质量（structured semantic anchor）
 *
 * Stage 是纯函数式：不修改输入 messages，返回同结构新数组（已替换处用新对象）。
 * <system-meta> 系统消息（CompactMarker / dropped-turns 等）透传不动 —— 它们是
 * 协议层占位，不是 tool_result。
 */

import type {
  ContentBlock,
  Message,
  ToolUseBlock,
} from "../../../types/messages.js";
import { detectSystemMetaKind } from "../../system-meta.js";
import type { AnchorRegistry } from "../anchors/registry.js";
import type { RenderContext, Stage, StageOutput } from "../types.js";

export class ToolResultAnchorStage implements Stage {
  readonly id = "tool-result-anchor";

  constructor(private readonly registry: AnchorRegistry) {}

  render(ctx: RenderContext): StageOutput {
    // Focus = 最近一条 assistant message 中所有 tool_use 的 ids 集合
    // （它们对应的 tool_result 整批保 raw 不锚化）
    const focusToolUseIds = findFocusToolUseIds(ctx.messages);

    // 索引：toolUseId → 对应 ToolUseBlock，用于跨 message 配对查找
    const toolUseIndex = buildToolUseIndex(ctx.messages);

    let stageModified = false;
    const renderedMessages = ctx.messages.map((msg) => {
      // tool_result 仅出现在 user message 中
      if (msg.role !== "user") return msg;
      // <system-meta> 透传 —— 协议层占位，不参与锚化
      if (detectSystemMetaKind(msg) !== null) return msg;

      let msgChanged = false;
      const newContent: ContentBlock[] = msg.content.map((block) => {
        if (block.type !== "tool_result") return block;
        // Focus tool_result 保 raw 完整（含 parallel tool_use 整批）
        if (focusToolUseIds.has(block.toolUseId)) return block;
        // 找配对 tool_use；找不到（异常历史）保留原样
        const toolUse = toolUseIndex.get(block.toolUseId);
        if (!toolUse) return block;
        const anchorText = this.registry.generate(toolUse, block);
        // 已是 anchor 形态（如内容已经等于将要生成的 anchor）跳过创建新对象
        if (anchorText === block.content) return block;
        msgChanged = true;
        return { ...block, content: anchorText };
      });

      if (!msgChanged) return msg;
      stageModified = true;
      return { ...msg, content: newContent };
    });

    // 无变更时引用透传，下游不需要重新比对
    return {
      messages: stageModified ? renderedMessages : ctx.messages,
      tools: ctx.tools,
    };
  }
}

/**
 * 倒序找最近一条带 tool_use 的 assistant message，返回该 message 中所有
 * tool_use 块的 ids 集合（同批 parallel tool_use 在 LLM 下一 call 是同时
 * 第一次消化的，必须整批 Focus 保 raw）。
 *
 * 空集合表示当前 messages 中没有 tool_use（首轮 / 纯文本回复路径）。
 */
function findFocusToolUseIds(messages: readonly Message[]): ReadonlySet<string> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const ids = new Set<string>();
    for (const block of msg.content) {
      if (block.type === "tool_use") ids.add(block.id);
    }
    if (ids.size > 0) return ids;
    // 此 assistant 没有 tool_use（纯文本），继续向前找
  }
  return new Set();
}

/**
 * 扫整个 messages 建立 toolUseId → ToolUseBlock 索引。
 *
 * 锚化每个 tool_result 时需要找配对 tool_use 的 input 参数；同一 messages 多个
 * tool_result 共享同一索引避免 O(n²) 扫描。
 */
function buildToolUseIndex(
  messages: readonly Message[],
): Map<string, ToolUseBlock> {
  const index = new Map<string, ToolUseBlock>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") index.set(block.id, block);
    }
  }
  return index;
}
