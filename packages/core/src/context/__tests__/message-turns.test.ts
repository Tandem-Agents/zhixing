import { describe, expect, it } from "vitest";
import type { Message, ToolUseBlock, ToolResultBlock } from "../../types/messages.js";
import {
  assistantMessage,
  toolResultMessage,
  userMessage,
} from "../../types/messages.js";
import { assertToolPairingIntact } from "../message-turns.js";

// ─── Fixtures ───

function toolUseMsg(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `调用 ${name}` },
      { type: "tool_use", id, name, input: {} } satisfies ToolUseBlock,
    ],
  };
}

function toolResultMsg(id: string, content = "ok"): Message {
  return toolResultMessage([
    { type: "tool_result", toolUseId: id, content } satisfies ToolResultBlock,
  ]);
}

// ─── assertToolPairingIntact ───

describe("assertToolPairingIntact", () => {
  it("空消息通过", () => {
    expect(() => assertToolPairingIntact([])).not.toThrow();
  });

  it("无 tool 调用的纯对话通过", () => {
    const messages = [
      userMessage("q"),
      assistantMessage("a"),
      userMessage("q2"),
      assistantMessage("a2"),
    ];
    expect(() => assertToolPairingIntact(messages)).not.toThrow();
  });

  it("tool_use 配对 tool_result 通过", () => {
    const messages = [
      userMessage("run"),
      toolUseMsg("t1", "read"),
      toolResultMsg("t1"),
      assistantMessage("done"),
    ];
    expect(() => assertToolPairingIntact(messages)).not.toThrow();
  });

  it("tool_use 缺少对应 tool_result 时抛错", () => {
    const messages = [
      userMessage("run"),
      toolUseMsg("t1", "read"),
      assistantMessage("no result"),
    ];
    expect(() => assertToolPairingIntact(messages)).toThrow(/t1/);
  });

  it("tool_result 缺少对应 tool_use 时抛错（孤儿）", () => {
    const messages = [
      userMessage("run"),
      toolResultMsg("orphan"),
      assistantMessage("ok"),
    ];
    expect(() => assertToolPairingIntact(messages)).toThrow(/orphan/);
  });

  it("多 tool_use 部分未配对时报出所有 id", () => {
    const messages: Message[] = [
      userMessage("run"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "a", input: {} },
          { type: "tool_use", id: "t2", name: "b", input: {} },
        ],
      },
      toolResultMsg("t1"),
    ];
    try {
      assertToolPairingIntact(messages);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg).toContain("t2");
      expect(msg).not.toContain("t1");
    }
  });
});
