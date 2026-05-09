import { describe, expect, it } from "vitest";
import type { Message } from "../../../types/messages.js";
import { CapabilityState } from "../state.js";
import {
  HOT_RETENTION_TURNS,
  collectRecentToolUses,
  rebuildCapabilityFromHistory,
} from "../index.js";

// ─── 测试辅助 ───

function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantWithTools(...toolUses: Array<{ id: string; name: string }>): Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "..." },
      ...toolUses.map((u) => ({
        type: "tool_use" as const,
        id: u.id,
        name: u.name,
        input: {},
      })),
    ],
  };
}

function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResultMsg(toolUseId: string, content: string): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", toolUseId, content }],
  };
}

// ─── collectRecentToolUses ───

describe("collectRecentToolUses", () => {
  it("空 messages → 空数组", () => {
    expect(collectRecentToolUses([])).toEqual([]);
  });

  it("纯文本对话 → 空数组（无 tool_use）", () => {
    const messages: Message[] = [
      userText("你好"),
      assistantText("你好！"),
      userText("再见"),
      assistantText("再见！"),
    ];
    expect(collectRecentToolUses(messages)).toEqual([]);
  });

  it("单个 assistant 多 tool_use → 全收集", () => {
    const messages: Message[] = [
      userText("查代码"),
      assistantWithTools(
        { id: "u1", name: "read" },
        { id: "u2", name: "grep" },
        { id: "u3", name: "glob" },
      ),
      toolResultMsg("u1", "..."),
      toolResultMsg("u2", "..."),
      toolResultMsg("u3", "..."),
    ];
    // 倒序首次出现的稳定顺序
    expect(collectRecentToolUses(messages)).toEqual(["read", "grep", "glob"]);
  });

  it("多轮 tool_use 在限定轮内 → 全收集 + 去重", () => {
    const messages: Message[] = [
      userText("Q1"),
      assistantWithTools({ id: "u1", name: "read" }),
      toolResultMsg("u1", "..."),
      assistantText("先看了 README"),
      userText("Q2"),
      assistantWithTools(
        { id: "u2", name: "read" },
        { id: "u3", name: "edit" },
      ),
      toolResultMsg("u2", "..."),
      toolResultMsg("u3", "..."),
    ];
    // 2 个含 tool_use 的 assistant，全收集，read 去重
    const tools = collectRecentToolUses(messages);
    expect(tools.sort()).toEqual(["edit", "read"]);
  });

  it("超出 retentionTurns → 仅最近 N 个 assistant 内的工具", () => {
    const messages: Message[] = [];
    // 构造 10 个含 tool_use 的 assistant message（用不同工具区分）
    const toolNames = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    for (let i = 0; i < toolNames.length; i++) {
      messages.push(userText(`Q${i}`));
      messages.push(
        assistantWithTools({ id: `u${i}`, name: toolNames[i]! }),
      );
      messages.push(toolResultMsg(`u${i}`, "..."));
    }

    const tools = collectRecentToolUses(messages, 3);
    // 最近 3 个 assistant 是 j / i / h（倒序首次出现）
    expect(tools).toEqual(["j", "i", "h"]);
  });

  it("纯文本 assistant 不计入 retentionTurns 计数", () => {
    const messages: Message[] = [
      userText("Q1"),
      assistantWithTools({ id: "u1", name: "early" }),
      toolResultMsg("u1", "..."),
      // 中间夹大量纯文本对话
      userText("Q2"),
      assistantText("纯文本回复"),
      userText("Q3"),
      assistantText("再次纯文本"),
      userText("Q4"),
      assistantText("第三次"),
      userText("Q5"),
      assistantWithTools({ id: "u2", name: "late" }),
    ];
    // retentionTurns=2 仍能找到两个含 tool_use 的 assistant：late, early
    expect(collectRecentToolUses(messages, 2).sort()).toEqual(["early", "late"]);
  });

  it("默认 retentionTurns = HOT_RETENTION_TURNS", () => {
    const messages: Message[] = [];
    for (let i = 0; i < HOT_RETENTION_TURNS + 5; i++) {
      messages.push(userText(`Q${i}`));
      messages.push(
        assistantWithTools({ id: `u${i}`, name: `t${i}` }),
      );
    }
    const tools = collectRecentToolUses(messages); // 默认 retention
    expect(tools).toHaveLength(HOT_RETENTION_TURNS);
  });
});

// ─── rebuildCapabilityFromHistory ───

describe("rebuildCapabilityFromHistory", () => {
  it("空 state + 空 messages → 无变化", () => {
    const state = new CapabilityState();
    rebuildCapabilityFromHistory(state, []);
    expect(state.toolsAt("hot")).toEqual([]);
  });

  it("已注册 discoverable 工具 + 历史命中 → 升级 hot", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.initialize("memory", "always");
    state.initialize("write", "discoverable");

    const messages: Message[] = [
      userText("Q"),
      assistantWithTools(
        { id: "u1", name: "read" },
        { id: "u2", name: "write" },
      ),
      toolResultMsg("u1", "..."),
      toolResultMsg("u2", "..."),
    ];
    rebuildCapabilityFromHistory(state, messages);

    expect(state.layerOf("read")).toBe("hot");
    expect(state.layerOf("write")).toBe("hot");
    expect(state.layerOf("memory")).toBe("always"); // 不变
  });

  it("未注册的工具自动 no-op（rebuild 不抛错）", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");

    const messages: Message[] = [
      assistantWithTools(
        { id: "u1", name: "read" },
        { id: "u2", name: "stranger" }, // 未注册
      ),
    ];
    rebuildCapabilityFromHistory(state, messages);

    expect(state.layerOf("read")).toBe("hot");
    expect(state.layerOf("stranger")).toBeUndefined();
  });

  it("cold 工具不被 rebuild 升级（保持 cold）", () => {
    const state = new CapabilityState();
    state.initialize("legacy", "cold");
    const messages: Message[] = [
      assistantWithTools({ id: "u1", name: "legacy" }),
    ];
    rebuildCapabilityFromHistory(state, messages);
    expect(state.layerOf("legacy")).toBe("cold");
  });

  it("rebuild 之后 currentTurn 不变（不模拟过去时间流逝）", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    expect(state.turn).toBe(0);

    const messages: Message[] = [
      assistantWithTools({ id: "u1", name: "read" }),
    ];
    rebuildCapabilityFromHistory(state, messages);

    expect(state.turn).toBe(0); // 未推进
    expect(state.layerOf("read")).toBe("hot");
  });

  it("rebuild 之后 LRU 倒计时归零 —— 工具继续 hot 直到不被使用 retention+ 轮", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");

    const messages: Message[] = [
      assistantWithTools({ id: "u1", name: "read" }),
    ];
    rebuildCapabilityFromHistory(state, messages);
    expect(state.layerOf("read")).toBe("hot");

    // 推进 retention 轮（不再使用 read）
    for (let i = 0; i < HOT_RETENTION_TURNS; i++) {
      state.advanceTurn();
    }
    // 边界（distance == retention）不降级
    expect(state.layerOf("read")).toBe("hot");

    // 再推 1 轮 → 降级
    state.advanceTurn();
    expect(state.layerOf("read")).toBe("discoverable");
  });

  it("超出 retentionTurns 的旧工具不被 rebuild（仅最近 N 个 assistant）", () => {
    const state = new CapabilityState();
    state.initialize("ancient", "discoverable");
    state.initialize("recent", "discoverable");

    const messages: Message[] = [
      // ancient 在最早的 assistant 中
      assistantWithTools({ id: "u-old", name: "ancient" }),
      // 之后填充足够多 assistant 把 ancient 挤出 retention 窗口
    ];
    for (let i = 0; i < HOT_RETENTION_TURNS + 1; i++) {
      messages.push(
        assistantWithTools({ id: `u${i}`, name: "recent" }),
      );
    }

    rebuildCapabilityFromHistory(state, messages);

    expect(state.layerOf("ancient")).toBe("discoverable"); // 太旧不被升级
    expect(state.layerOf("recent")).toBe("hot");
  });
});
