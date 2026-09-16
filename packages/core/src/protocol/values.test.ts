import { describe, expect, it } from "vitest";
import { validateMessage } from "./values.js";

describe("消息来源协议", () => {
  const message = { role: "user", content: [{ type: "text", text: "正文不附加来源前缀" }] };
  const identity = { id: "message-1", source: { kind: "conversation", conversationId: "source-a" } };

  it("兼容无来源的已有消息，并保留逐条来源", () => {
    expect(validateMessage(message)).toEqual(message);
    for (const source of [identity.source, { kind: "user" }]) {
      const identified = { ...message, inputIdentity: { ...identity, source } };
      expect(validateMessage(JSON.parse(JSON.stringify(identified)))).toEqual(identified);
    }
  });

  it("不允许将 assistant 或工具结果伪装为用户输入", () => {
    expect(() => validateMessage({ ...message, role: "assistant", inputIdentity: identity })).toThrow();
    expect(() => validateMessage({ ...message, content: [{ type: "tool_result", toolUseId: "tool-1", content: "ok" }], inputIdentity: identity })).toThrow();
  });

  it.each([
    { id: "", source: identity.source },
    { ...identity, source: { kind: "conversation" } },
    { ...identity, source: { kind: "user", conversationId: "source-a" } },
    { ...identity, source: { kind: "other" } },
    { ...identity, unregistered: true },
  ])("拒绝缺失或开放的来源合同：%j", (inputIdentity) => {
    expect(() => validateMessage({ ...message, inputIdentity })).toThrow();
  });
});
