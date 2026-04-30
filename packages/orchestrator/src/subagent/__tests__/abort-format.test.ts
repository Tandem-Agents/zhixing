import { describe, expect, it } from "vitest";
import type { AbortReason } from "@zhixing/core";
import { formatAbortReasonForLLM } from "../abort-format.js";

describe("formatAbortReasonForLLM", () => {
  it("user-cancel → 'user cancelled the parent task'", () => {
    const reason: AbortReason = {
      kind: "user-cancel",
      source: "esc",
      pressedAt: 0,
    };
    expect(formatAbortReasonForLLM(reason)).toBe(
      "user cancelled the parent task",
    );
  });

  it("idle-timeout → 不暴露具体毫秒值 (避免主 LLM 读到无意义数字)", () => {
    const reason: AbortReason = {
      kind: "idle-timeout",
      timeoutMs: 90_000,
      chunksReceived: 5,
      elapsedSinceLastChunkMs: 91_500,
    };
    expect(formatAbortReasonForLLM(reason)).toBe(
      "sub-agent LLM stream idle for too long",
    );
  });

  it("parent-abort → 不展开 parentReason 链 (主 LLM 知道父被打断即可)", () => {
    const reason: AbortReason = { kind: "parent-abort", parentReason: null };
    expect(formatAbortReasonForLLM(reason)).toBe("parent agent was aborted");
  });

  it("external 带 origin → 'external abort: ${origin}'", () => {
    const reason: AbortReason = {
      kind: "external",
      origin: "scheduler-task-timeout",
    };
    expect(formatAbortReasonForLLM(reason)).toBe(
      "external abort: scheduler-task-timeout",
    );
  });

  it("external 缺 origin → 退化为 'external abort'", () => {
    const reason: AbortReason = { kind: "external" };
    expect(formatAbortReasonForLLM(reason)).toBe("external abort");
  });
});
