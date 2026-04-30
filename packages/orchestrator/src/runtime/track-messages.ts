/**
 * 从 agent-loop 的 yield 事件流增量重建对话历史。
 *
 * 主 agent run() 与子 agent dispatch 共用此 helper —— 同一份累积逻辑既保证
 * REPL transcript 与子 agent tool_result 拥有相同的"yields → messages"语义,
 * 又避免双份实现导致的漂移。
 *
 * 累积规则:
 *   - assistant_message:整条 push 进 newMessages
 *   - tool_end:把工具结果先攒进 pendingToolResults
 *   - turn_complete:把 pendingToolResults 打包成 user role 消息再 push,清空 buffer
 *
 * pendingToolResults 由调用方传入的可变数组持有 —— 跨多次 trackMessages 调用
 * 共享同一 buffer,直到下一个 turn_complete 触发刷新。
 */

import type { AgentYield, Message, ToolResultBlock } from "@zhixing/core";

export function trackMessages(
  event: AgentYield,
  newMessages: Message[],
  pendingToolResults: ToolResultBlock[],
): void {
  switch (event.type) {
    case "assistant_message":
      newMessages.push(event.message);
      break;

    case "tool_end":
      pendingToolResults.push({
        type: "tool_result",
        toolUseId: event.id,
        content: event.result.content,
        isError: event.result.isError,
      });
      break;

    case "turn_complete":
      if (pendingToolResults.length > 0) {
        newMessages.push({
          role: "user",
          content: [...pendingToolResults],
        });
        pendingToolResults.length = 0;
      }
      break;
  }
}
