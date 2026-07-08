import { describe, expect, it } from "vitest";
import type { Message } from "../../types/messages.js";
import type { ToolSpec } from "../../types/tools.js";
import type { ITokenEstimator } from "../types.js";
import { computeContextTokens, type TokenAnchor } from "../token-accounting.js";

function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function textOf(message: Message): string {
  const first = message.content[0];
  return first && first.type === "text" ? first.text : "";
}

const estimator: ITokenEstimator = {
  estimateMessage(message) {
    return textOf(message).length;
  },
  estimateMessages(messages) {
    return messages.reduce((sum, message) => sum + textOf(message).length, 0);
  },
  estimateText(text) {
    return text.length;
  },
  estimateTools(tools) {
    return tools.length * 100;
  },
  calibrate() {},
  calibrationFactor: 1,
};

const tool: ToolSpec = {
  name: "read",
  description: "read file",
  inputSchema: { type: "object", properties: {} },
};

describe("computeContextTokens", () => {
  it("fallback 按完整 provider 请求视图估算", () => {
    const total = computeContextTokens({
      estimator,
      systemPrompt: "sys",
      stateMessages: [userText("state-only")],
      providerMessages: [userText("prefix"), userText("state")],
      tools: [tool],
    });

    expect(total).toBe("sys".length + "prefix".length + "state".length + 100);
  });

  it("anchor 路径只估 stateMessages 新增后缀，不重复计算 provider prefix", () => {
    const anchor: TokenAnchor = {
      totalInputTokens: 1_000,
      baselineMessageCount: 1,
    };

    const total = computeContextTokens({
      estimator,
      systemPrompt: "sys-that-should-not-count",
      stateMessages: [userText("old"), userText("new")],
      providerMessages: [
        userText("very-large-prefix-that-must-not-be-counted"),
        userText("old"),
        userText("new"),
      ],
      tools: [tool],
      anchor,
    });

    expect(total).toBe(1_000 + "new".length);
  });

  it("state 谱系短于 anchor baseline 时降级到 fallback", () => {
    const anchor: TokenAnchor = {
      totalInputTokens: 1_000,
      baselineMessageCount: 3,
    };

    const total = computeContextTokens({
      estimator,
      systemPrompt: "s",
      stateMessages: [userText("rewritten")],
      providerMessages: [userText("prefix"), userText("rewritten")],
      tools: [],
      anchor,
    });

    expect(total).toBe("s".length + "prefix".length + "rewritten".length);
  });
});
