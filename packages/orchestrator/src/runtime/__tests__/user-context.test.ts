import { describe, it, expect } from "vitest";
import { userMessage, assistantMessage, type Message } from "@zhixing/core";
import { prependContextBlock } from "../user-context.js";

const firstText = (m: Message): string =>
  (m.content.find((b) => b.type === "text") as { text: string } | undefined)
    ?.text ?? "";

describe("prependContextBlock", () => {
  it("无贡献时原样返回（浅拷贝、不改原数组）", () => {
    const messages = [userMessage("hello")];
    const result = prependContextBlock(messages, []);
    expect(result).toEqual(messages);
    expect(result).not.toBe(messages);
  });

  it("贡献全为空白时不注入", () => {
    const messages = [userMessage("hello")];
    const result = prependContextBlock(messages, ["", "   ", "\n"]);
    expect(result).toEqual(messages);
  });

  it("单条贡献注入 <context> 块、前缀到用户原文", () => {
    const result = prependContextBlock([userMessage("hello")], ["项目背景"]);
    expect(firstText(result[0]!)).toBe("<context>\n项目背景\n</context>\n\nhello");
  });

  it("多条贡献拼进同一个 <context> 块（空行分隔）", () => {
    const result = prependContextBlock([userMessage("hi")], ["A", "B"]);
    expect(firstText(result[0]!)).toBe("<context>\nA\n\nB\n</context>\n\nhi");
  });

  it("注入最后一条 user message，不是首条", () => {
    const messages: Message[] = [
      userMessage("first"),
      assistantMessage("reply"),
      userMessage("second"),
    ];
    const result = prependContextBlock(messages, ["ctx"]);
    expect(firstText(result[0]!)).toBe("first");
    expect(firstText(result[2]!)).toBe("<context>\nctx\n</context>\n\nsecond");
  });

  it("贡献内容会被 trim", () => {
    const result = prependContextBlock([userMessage("x")], ["  padded  "]);
    expect(firstText(result[0]!)).toBe("<context>\npadded\n</context>\n\nx");
  });

  it("没有 user message 时原样返回", () => {
    const messages = [assistantMessage("only assistant")];
    expect(prependContextBlock(messages, ["ctx"])).toEqual(messages);
  });

  it("不修改原消息对象", () => {
    const messages = [userMessage("hello")];
    prependContextBlock(messages, ["ctx"]);
    expect(firstText(messages[0]!)).toBe("hello");
  });

  it("user message 无 text block 时单独注入 block", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "x" } }],
      },
    ];
    const result = prependContextBlock(messages, ["ctx"]);
    expect(firstText(result[0]!)).toBe("<context>\nctx\n</context>");
  });
});
