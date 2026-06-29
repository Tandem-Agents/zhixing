import { describe, expect, it } from "vitest";

import { buildRunRecord } from "../run-record-builder.js";
import type { Message } from "../../types/messages.js";

describe("buildRunRecord", () => {
  it("keeps advancement metadata at run level and leaves protocol messages clean", () => {
    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "继续修复测试" }],
    };
    const assistantMessage: Message = {
      role: "assistant",
      content: [{ type: "text", text: "已修复" }],
    };

    const record = buildRunRecord({
      userMessage,
      newMessages: [assistantMessage],
      agentResult: {
        reason: "completed",
        message: assistantMessage,
        usage: { inputTokens: 1, outputTokens: 2 },
      },
      source: "advancement",
      advancement: {
        sessionId: "adv-1",
        proxyMessageId: "proxy-1",
        reviewId: "review-1",
        rubricFailureHandlingId: "fix-tests",
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(record.source).toBe("advancement");
    expect(record.advancement).toEqual({
      sessionId: "adv-1",
      proxyMessageId: "proxy-1",
      reviewId: "review-1",
      rubricFailureHandlingId: "fix-tests",
    });
    expect(record.messages).toEqual([userMessage, assistantMessage]);
    expect(record.messages[0]).not.toHaveProperty("advancement");
    expect(record.messages[1]).not.toHaveProperty("advancement");
  });
});
