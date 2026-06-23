/**
 * trackMessages 单元测试 —— yields → messages 累积规则。
 *
 * 主 agent run 与子 agent dispatch 共用此 helper,任何回归都会同时影响两条路径。
 */

import { describe, expect, it } from "vitest";
import { trackMessages } from "../track-messages.js";
import type { AgentYield, Message, ToolResultBlock } from "@zhixing/core";

function fresh(): { newMessages: Message[]; pending: ToolResultBlock[] } {
  return { newMessages: [], pending: [] };
}

describe("trackMessages", () => {
  it("assistant_message 整条 push 到 newMessages", () => {
    const { newMessages, pending } = fresh();
    const event: AgentYield = {
      type: "assistant_message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
    };
    trackMessages(event, newMessages, pending);
    expect(newMessages).toHaveLength(1);
    expect(newMessages[0].role).toBe("assistant");
    expect(pending).toHaveLength(0);
  });

  it("tool_end 进入 pendingToolResults,turn_complete 时打包 push", () => {
    const { newMessages, pending } = fresh();

    trackMessages(
      {
        type: "tool_end",
        id: "t1",
        result: { content: "ok", isError: false },
      } as AgentYield,
      newMessages,
      pending,
    );
    trackMessages(
      {
        type: "tool_end",
        id: "t2",
        result: { content: "fail", isError: true },
      } as AgentYield,
      newMessages,
      pending,
    );

    expect(newMessages).toHaveLength(0);
    expect(pending).toHaveLength(2);

    trackMessages(
      { type: "turn_complete" } as AgentYield,
      newMessages,
      pending,
    );

    expect(newMessages).toHaveLength(1);
    expect(newMessages[0].role).toBe("user");
    const blocks = newMessages[0].content as ToolResultBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].toolUseId).toBe("t1");
    expect(blocks[1].toolUseId).toBe("t2");
    expect(blocks[1].isError).toBe(true);
    // pending 已清空
    expect(pending).toHaveLength(0);
  });

  it("tool_end 的 presentation 不进入 transcript", () => {
    const { newMessages, pending } = fresh();

    trackMessages(
      {
        type: "tool_end",
        id: "edit-1",
        name: "edit",
        duration: 12,
        result: {
          content: "Replaced text",
          presentation: {
            kind: "file-diff",
            path: "a.ts",
            operation: "modified",
            changeStats: { kind: "exact", addedLines: 1, removedLines: 1 },
            hunks: [],
          },
        },
      },
      newMessages,
      pending,
    );
    trackMessages(
      {
        type: "turn_complete",
        turnCount: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      newMessages,
      pending,
    );

    const blocks = newMessages[0]?.content as ToolResultBlock[];
    expect(blocks[0]).toEqual({
      type: "tool_result",
      toolUseId: "edit-1",
      content: "Replaced text",
      isError: undefined,
    });
    expect(JSON.stringify(blocks)).not.toContain("file-diff");
  });

  it("tool_end 的 grep presentation 不进入 transcript", () => {
    const { newMessages, pending } = fresh();

    trackMessages(
      {
        type: "tool_end",
        id: "grep-1",
        name: "grep",
        duration: 8,
        result: {
          content: "Found 1 matching line in 1 file",
          presentation: {
            kind: "grep-results",
            query: {
              pattern: "\\bfoo\\b",
              searchPath: "src",
              outputMode: "content",
              regexDialect: "line-regexp",
              caseSensitivity: "sensitive",
              contextLines: 0,
            },
            files: [
              {
                displayPath: "src/app.ts",
                matches: [
                  {
                    line: 3,
                    text: { text: "const foo = 1;", truncated: false },
                    contextBefore: [],
                    contextAfter: [],
                  },
                ],
              },
            ],
            matchedFileCount: 1,
            matchedLineCount: 1,
            truncated: false,
            diagnostics: {
              executor: "node",
              capabilityMode: "fallback",
            },
          },
        },
      },
      newMessages,
      pending,
    );
    trackMessages(
      {
        type: "turn_complete",
        turnCount: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      newMessages,
      pending,
    );

    const blocks = newMessages[0]?.content as ToolResultBlock[];
    expect(blocks[0]).toEqual({
      type: "tool_result",
      toolUseId: "grep-1",
      content: "Found 1 matching line in 1 file",
      isError: undefined,
    });
    expect(JSON.stringify(blocks)).not.toContain("grep-results");
  });

  it("turn_complete 时 pending 为空 → 不 push 空 user 消息", () => {
    const { newMessages, pending } = fresh();
    trackMessages(
      { type: "turn_complete" } as AgentYield,
      newMessages,
      pending,
    );
    expect(newMessages).toHaveLength(0);
  });

  it("交替 assistant_message + tool_end + turn_complete 多轮累积", () => {
    const { newMessages, pending } = fresh();

    // 第 1 轮:assistant + 1 tool
    trackMessages(
      {
        type: "assistant_message",
        message: { role: "assistant", content: [{ type: "text", text: "round1" }] },
      } as AgentYield,
      newMessages,
      pending,
    );
    trackMessages(
      { type: "tool_end", id: "t1", result: { content: "r1", isError: false } } as AgentYield,
      newMessages,
      pending,
    );
    trackMessages({ type: "turn_complete" } as AgentYield, newMessages, pending);

    // 第 2 轮:assistant final
    trackMessages(
      {
        type: "assistant_message",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      } as AgentYield,
      newMessages,
      pending,
    );

    expect(newMessages).toHaveLength(3); // assistant1 + tool_result_msg + assistant2
    expect(newMessages[0].role).toBe("assistant");
    expect(newMessages[1].role).toBe("user");
    expect(newMessages[2].role).toBe("assistant");
  });
});
