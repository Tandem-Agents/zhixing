/**
 * 消息工具配对断言 —— 段切换等消息改写的测试与诊断共用。
 *
 * 切段的覆盖单元（首部、已接受配对、运行步骤）见 segment/coverage.ts。
 */
import type { ContentBlock, Message, ToolUseBlock } from "../types/messages.js";

// ─── Tool pairing 断言 ───

/**
 * 断言 messages 中每个 tool_use 块都有对应的 tool_result 块（按 id 匹配）。
 *
 * 用于测试场景和运行时诊断 —— 确保段切换摘要不会破坏 tool 配对。
 * 配对要求：
 *   - 每个 assistant 消息中的 tool_use.id 必须在后续 user 消息的 tool_result 中出现
 *   - tool_result 可以在紧邻的下一条 user 消息，也可以在后续多条 user 消息中
 *
 * 失败时抛出 Error，消息包含所有未配对的 tool_use id。
 */
export function assertToolPairingIntact(messages: readonly Message[]): void {
  const pendingToolUseIds = new Set<string>();
  const seenResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (isToolUse(block)) {
          pendingToolUseIds.add(block.id);
        }
      }
    } else {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          seenResultIds.add(block.toolUseId);
          pendingToolUseIds.delete(block.toolUseId);
        }
      }
    }
  }

  if (pendingToolUseIds.size > 0) {
    const ids = [...pendingToolUseIds].join(", ");
    throw new Error(
      `Tool pairing broken: tool_use without matching tool_result (ids: ${ids})`,
    );
  }

  // 孤儿 tool_result（无对应 tool_use）也视为断裂 —— 通常意味着切分时把 tool_use 丢在了另一侧
  const orphanResults: string[] = [];
  for (const id of seenResultIds) {
    if (!hasToolUseWithId(messages, id)) {
      orphanResults.push(id);
    }
  }
  if (orphanResults.length > 0) {
    throw new Error(
      `Tool pairing broken: tool_result without matching tool_use (ids: ${orphanResults.join(", ")})`,
    );
  }
}

// ─── 内部辅助 ───

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

function hasToolUseWithId(messages: readonly Message[], id: string): boolean {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (isToolUse(block) && block.id === id) return true;
    }
  }
  return false;
}
