import { describe, expect, it } from "vitest";
import type { ITokenEstimator } from "../../types.js";
import { assistantMessage, userMessage } from "../../../types/messages.js";
import { createAttentionWindow } from "../attention-window.js";
import { snapshotAttentionWindowV1 } from "../snapshot.js";

const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");

function estimator(tokensPerMessage: number): Pick<ITokenEstimator, "estimateMessages"> {
  return {
    estimateMessages: (messages) => messages.length * tokensPerMessage,
  };
}

describe("snapshotAttentionWindowV1", () => {
  it("full_or_fail 捕获完整窗口并冻结快照", () => {
    const window = createAttentionWindow();
    window.acceptRun({
      runMessages: [userMessage("需求背景"), assistantMessage("已有结论")],
    });

    const result = snapshotAttentionWindowV1(window, {
      strategy: "full_or_fail",
      maxTokens: 20,
      estimator: estimator(10),
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toEqual({
      source: "attention_window",
      strategy: "full_or_fail",
      messages: [userMessage("需求背景"), assistantMessage("已有结论")],
      estimatedTokens: 20,
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.messages)).toBe(true);
    expect(Object.isFrozen(result.snapshot.messages[0])).toBe(true);
    expect(Object.isFrozen(result.snapshot.messages[0]!.content)).toBe(true);
  });

  it("full_or_fail 超过预算直接失败,不截断", () => {
    const window = createAttentionWindow();
    window.acceptRun({
      runMessages: [userMessage("很长的背景"), assistantMessage("很长的回复")],
    });

    const result = snapshotAttentionWindowV1(window, {
      strategy: "full_or_fail",
      maxTokens: 10,
      estimator: estimator(8),
      now: fixedNow,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "context_snapshot_too_large",
        message: "attention window exceeds context snapshot token budget",
        estimatedTokens: 16,
        maxTokens: 10,
      },
    });
  });

  it("tail 只保留预算内的最近消息并显式标记策略", () => {
    const window = createAttentionWindow();
    window.acceptRun({
      runMessages: [userMessage("u1"), assistantMessage("a1")],
    });
    window.acceptRun({
      runMessages: [userMessage("u2"), assistantMessage("a2")],
    });

    const result = snapshotAttentionWindowV1(window, {
      strategy: "tail",
      maxTokens: 20,
      estimator: estimator(10),
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.strategy).toBe("tail");
    expect(result.snapshot.estimatedTokens).toBe(20);
    expect(result.snapshot.messages).toEqual([
      userMessage("u2"),
      assistantMessage("a2"),
    ]);
  });

  it("快照与原窗口消息对象脱钩", () => {
    const original = userMessage("原始内容");
    const window = createAttentionWindow({
      bootstrap: [original, assistantMessage("收到")],
    });

    const result = snapshotAttentionWindowV1(window, {
      strategy: "full_or_fail",
      maxTokens: 20,
      estimator: estimator(10),
      now: fixedNow,
    });
    original.content[0] = { type: "text", text: "被外部改写" };

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.messages[0]).toEqual(userMessage("原始内容"));
  });

  it("非法预算失败,不产出快照", () => {
    const result = snapshotAttentionWindowV1(createAttentionWindow(), {
      strategy: "tail",
      maxTokens: 0,
      estimator: estimator(10),
      now: fixedNow,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_context_snapshot_budget",
        message: "context snapshot maxTokens must be a positive integer",
        maxTokens: 0,
      },
    });
  });
});
