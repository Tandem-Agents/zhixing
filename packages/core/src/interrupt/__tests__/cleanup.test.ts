import { describe, expect, it } from "vitest";
import type { ToolUseBlock } from "../../types/messages.js";
import { buildCleanup, formatReasonForToolResult } from "../cleanup.js";
import type { AbortReason } from "../types.js";

function tu(id: string, name: string): ToolUseBlock {
  return { type: "tool_use", id, name, input: {} };
}

describe("buildCleanup", () => {
  it("CleanupContext 全空 → kind='no-cleanup'", () => {
    const o = buildCleanup({ reason: null });
    expect(o.kind).toBe("no-cleanup");
  });

  it("partial 全空 + unexecuted 空 → kind='no-cleanup'", () => {
    const o = buildCleanup({
      partial: { text: "", thinking: "" },
      unexecutedToolUses: [],
      reason: null,
    });
    expect(o.kind).toBe("no-cleanup");
  });

  it("仅 partial 有内容 → kind='data',partialAssistant 非 null,placeholder 空", () => {
    const o = buildCleanup({
      partial: { text: "writing...", thinking: "" },
      reason: { kind: "user-cancel", source: "esc", pressedAt: 1 },
    });
    expect(o.kind).toBe("data");
    if (o.kind === "data") {
      expect(o.partialAssistant).not.toBeNull();
      expect(o.placeholderToolResults).toEqual([]);
    }
  });

  it("仅 unexecutedToolUses 有 → partialAssistant null,placeholder 数量与顺序匹配", () => {
    const o = buildCleanup({
      unexecutedToolUses: [tu("a", "read"), tu("b", "edit"), tu("c", "bash")],
      reason: { kind: "user-cancel", source: "ctrl-c", pressedAt: 1 },
    });
    expect(o.kind).toBe("data");
    if (o.kind === "data") {
      expect(o.partialAssistant).toBeNull();
      expect(o.placeholderToolResults).toHaveLength(3);
      expect(o.placeholderToolResults.map((r) => r.toolUseId)).toEqual(["a", "b", "c"]);
      expect(o.placeholderToolResults.every((r) => r.isError === true)).toBe(true);
      expect(o.placeholderToolResults[0]!.content).toContain("user pressed ctrl-c");
    }
  });

  it("partial + unexecuted 都有 → 两者都填充", () => {
    const o = buildCleanup({
      partial: { text: "thinking out loud", thinking: "" },
      unexecutedToolUses: [tu("x", "read")],
      reason: { kind: "external", origin: "scheduler-timeout" },
    });
    expect(o.kind).toBe("data");
    if (o.kind === "data") {
      expect(o.partialAssistant).not.toBeNull();
      expect(o.placeholderToolResults).toHaveLength(1);
      expect(o.placeholderToolResults[0]!.content).toContain("scheduler-timeout");
    }
  });

  it("reason=null → placeholder 文本走 'interrupted' 兜底", () => {
    const o = buildCleanup({
      unexecutedToolUses: [tu("a", "read")],
      reason: null,
    });
    expect(o.kind).toBe("data");
    if (o.kind === "data") {
      expect(o.placeholderToolResults[0]!.content).toContain("interrupted");
    }
  });
});

describe("formatReasonForToolResult", () => {
  it("null → 'interrupted' 兜底", () => {
    expect(formatReasonForToolResult(null)).toBe("interrupted");
  });

  it("user-cancel(esc)→ 'user pressed esc'", () => {
    const r: AbortReason = { kind: "user-cancel", source: "esc", pressedAt: 1 };
    expect(formatReasonForToolResult(r)).toBe("user pressed esc");
  });

  it("user-cancel(ctrl-c)→ 'user pressed ctrl-c'", () => {
    const r: AbortReason = { kind: "user-cancel", source: "ctrl-c", pressedAt: 1 };
    expect(formatReasonForToolResult(r)).toBe("user pressed ctrl-c");
  });

  it("idle-timeout → 含 timeoutMs / chunksReceived", () => {
    const r: AbortReason = {
      kind: "idle-timeout",
      timeoutMs: 60_000,
      chunksReceived: 3,
      elapsedSinceLastChunkMs: 60_100,
    };
    expect(formatReasonForToolResult(r)).toBe("stream idle 60s, 3 chunks received");
  });

  it("parent-abort → 'parent aborted'", () => {
    const r: AbortReason = { kind: "parent-abort", parentReason: null };
    expect(formatReasonForToolResult(r)).toBe("parent aborted");
  });

  it("external 带 origin → 显示 origin", () => {
    const r: AbortReason = { kind: "external", origin: "scheduler-timeout" };
    expect(formatReasonForToolResult(r)).toBe("scheduler-timeout");
  });

  it("external 不带 origin → 'external signal'", () => {
    const r: AbortReason = { kind: "external" };
    expect(formatReasonForToolResult(r)).toBe("external signal");
  });

  it("污染的 kind(运行时数据被破坏)→ 兜底 'interrupted',不返回 undefined", () => {
    // 模拟有人 controller.abort({ kind: "what-is-this" })——getAbortReason 因
    // duck-typing 仅检查 kind 是 string 而放行,这里 switch 不匹配任何 case。
    // 没有兜底的话函数返回 undefined,模板字符串渲染成 "[Tool execution
    // cancelled: undefined]" 给 LLM。
    const polluted = { kind: "what-is-this" } as unknown as AbortReason;
    expect(formatReasonForToolResult(polluted)).toBe("interrupted");
  });
});
