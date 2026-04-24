import { describe, expect, it } from "vitest";
import type { Message, ToolUseBlock, ToolResultBlock } from "../../types/messages.js";
import {
  assistantMessage,
  toolResultMessage,
  userMessage,
} from "../../types/messages.js";
import {
  assertToolPairingIntact,
  calculateMessageTurns,
  splitMessagesPairAware,
} from "../message-turns.js";

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

// ─── calculateMessageTurns ───

describe("calculateMessageTurns", () => {
  it("空数组返回空数组", () => {
    expect(calculateMessageTurns([])).toEqual([]);
  });

  it("只有 user 消息时 turn 号全为 0", () => {
    const messages = [userMessage("a"), userMessage("b")];
    expect(calculateMessageTurns(messages)).toEqual([0, 0]);
  });

  it("标准单轮对话：user(0) → assistant(1)", () => {
    const messages = [userMessage("q"), assistantMessage("a")];
    expect(calculateMessageTurns(messages)).toEqual([0, 1]);
  });

  it("tool 循环：tool_result user 继承前一 assistant 的 turn", () => {
    const messages = [
      userMessage("run tool"),
      toolUseMsg("t1", "read"),
      toolResultMsg("t1"),
      assistantMessage("done"),
    ];
    // user(0), assistant(1), tool_result user(1), assistant(2)
    expect(calculateMessageTurns(messages)).toEqual([0, 1, 1, 2]);
  });

  it("多轮对话：每个 assistant 递增 turn 号", () => {
    const messages = [
      userMessage("q1"),
      assistantMessage("a1"),
      userMessage("q2"),
      assistantMessage("a2"),
      userMessage("q3"),
      assistantMessage("a3"),
    ];
    expect(calculateMessageTurns(messages)).toEqual([0, 1, 1, 2, 2, 3]);
  });
});

// ─── splitMessagesPairAware ───

describe("splitMessagesPairAware", () => {
  it("空消息两侧都为空", () => {
    const { toSummarize, toPreserve } = splitMessagesPairAware([], 3);
    expect(toSummarize).toEqual([]);
    expect(toPreserve).toEqual([]);
  });

  it("preserveRecentTurns = 0 时全部压缩", () => {
    const messages = [userMessage("a"), assistantMessage("b")];
    const { toSummarize, toPreserve } = splitMessagesPairAware(messages, 0);
    expect(toSummarize).toEqual(messages);
    expect(toPreserve).toEqual([]);
  });

  it("只有 user 消息（maxTurn = 0）时全部保留", () => {
    const messages = [userMessage("a"), userMessage("b")];
    const { toSummarize, toPreserve } = splitMessagesPairAware(messages, 3);
    expect(toSummarize).toEqual([]);
    expect(toPreserve).toEqual(messages);
  });

  it("preserveRecentTurns 覆盖所有 turn 时仅 turn 0 归入 toSummarize", () => {
    // user(0), assistant(1), user(1)[q2], assistant(2)
    const messages = [
      userMessage("q1"),
      assistantMessage("a1"),
      userMessage("q2"),
      assistantMessage("a2"),
    ];
    // maxTurn = 2, preserveRecent = 5 → firstPreserved = max(1, 2-5+1) = 1
    // turn 0 只有 messages[0]，从 messages[1] 开始保留
    const { toSummarize, toPreserve } = splitMessagesPairAware(messages, 5);
    expect(toSummarize).toEqual([messages[0]]);
    expect(toPreserve).toEqual(messages.slice(1));
  });

  it("基本切分：保留最后 1 个 turn", () => {
    // user(0), assistant(1), user(1), assistant(2), user(2), assistant(3)
    const messages = [
      userMessage("q1"),
      assistantMessage("a1"),
      userMessage("q2"),
      assistantMessage("a2"),
      userMessage("q3"),
      assistantMessage("a3"),
    ];
    // maxTurn = 3, preserveRecent = 1 → firstPreserved = 3
    // 第一个 turn >= 3 的 index 是 5（assistant a3）
    // 但 messages[4] = user(q3) 是 turn 2，所以不保留
    const { toSummarize, toPreserve } = splitMessagesPairAware(messages, 1);
    expect(toSummarize).toEqual(messages.slice(0, 5));
    expect(toPreserve).toEqual([messages[5]]);
  });

  it("tool 循环内部不会被切开（关键场景）", () => {
    // 模拟：普通轮 + tool 循环轮 + 普通轮
    const messages: Message[] = [
      userMessage("q1"),
      assistantMessage("a1"),
      // turn 2: tool 循环
      userMessage("use tool"),
      toolUseMsg("t1", "read"),
      toolResultMsg("t1", "file contents"),
      assistantMessage("tool done"),
      // turn 3+: 下一轮
      userMessage("q3"),
      assistantMessage("a3"),
    ];
    // turns = [0, 1, 1, 2, 2, 3, 3, 4]
    // preserveRecent = 2 → firstPreserved = 3
    // 第一个 turn >= 3 是 index 5（assistant tool done）
    const { toSummarize, toPreserve } = splitMessagesPairAware(messages, 2);

    // toPreserve 从 index 5 开始
    expect(toPreserve).toEqual(messages.slice(5));
    expect(toSummarize).toEqual(messages.slice(0, 5));

    // 两侧各自 tool pairing 完整
    expect(() => assertToolPairingIntact(toSummarize)).not.toThrow();
    expect(() => assertToolPairingIntact(toPreserve)).not.toThrow();
  });

  it("切分点正好在 tool_use (assistant) 与 tool_result (user) 之间时不切开 pair", () => {
    // 如果只按消息数硬切，preserveCount=2 会把 tool_use 留在左侧、tool_result 留在右侧
    // 验证 pair-aware 逻辑向后推到 turn 边界
    const messages: Message[] = [
      userMessage("q1"),
      assistantMessage("a1"),
      userMessage("use tool"),
      toolUseMsg("t1", "read"),       // turn 2
      toolResultMsg("t1", "contents"),  // turn 2
      assistantMessage("done"),         // turn 3
    ];
    // turns = [0, 1, 1, 2, 2, 3]
    // preserveRecent = 1 → firstPreserved = 3
    // 第一个 turn >= 3 是 index 5
    const { toSummarize, toPreserve } = splitMessagesPairAware(messages, 1);
    expect(toSummarize).toEqual(messages.slice(0, 5));  // 含完整的 tool pair
    expect(toPreserve).toEqual([messages[5]]);
    expect(() => assertToolPairingIntact(toSummarize)).not.toThrow();
    expect(() => assertToolPairingIntact(toPreserve)).not.toThrow();
  });

  it("连续多轮 tool 循环的切分", () => {
    const messages: Message[] = [
      userMessage("start"),                 // turn 0
      toolUseMsg("t1", "a"),                // turn 1
      toolResultMsg("t1"),                  // turn 1
      toolUseMsg("t2", "b"),                // turn 2
      toolResultMsg("t2"),                  // turn 2
      toolUseMsg("t3", "c"),                // turn 3
      toolResultMsg("t3"),                  // turn 3
      assistantMessage("all done"),         // turn 4
    ];
    // turns = [0, 1, 1, 2, 2, 3, 3, 4]
    // preserveRecent = 2 → firstPreserved = 3
    // 第一个 turn >= 3 是 index 5
    const { toSummarize, toPreserve } = splitMessagesPairAware(messages, 2);
    expect(toSummarize).toEqual(messages.slice(0, 5));
    expect(toPreserve).toEqual(messages.slice(5));
    expect(() => assertToolPairingIntact(toSummarize)).not.toThrow();
    expect(() => assertToolPairingIntact(toPreserve)).not.toThrow();
  });

  it("返回数组与原数组独立（不共享引用）", () => {
    const messages = [userMessage("a"), assistantMessage("b")];
    const { toSummarize, toPreserve } = splitMessagesPairAware(messages, 0);
    expect(toSummarize).not.toBe(messages);
    expect(Array.isArray(toPreserve)).toBe(true);
  });
});

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
