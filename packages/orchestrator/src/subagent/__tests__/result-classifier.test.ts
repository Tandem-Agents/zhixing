import { describe, expect, it } from "vitest";
import type { Message } from "@zhixing/core";
import {
  classifyResult,
  extractFinalAssistantText,
  extractPartialText,
} from "../result-classifier.js";

// ─── 测试辅助 ───

function assistantText(...texts: string[]): Message {
  return {
    role: "assistant",
    content: texts.map((t) => ({ type: "text" as const, text: t })),
  };
}

function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolCall(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

// ─── extractFinalAssistantText ───

describe("extractFinalAssistantText", () => {
  it("只一条 assistant text → 取该文本", () => {
    expect(extractFinalAssistantText([assistantText("hello")])).toBe("hello");
  });

  it("多条 assistant 取最后一条", () => {
    expect(
      extractFinalAssistantText([
        assistantText("first"),
        userText("u"),
        assistantText("second"),
      ]),
    ).toBe("second");
  });

  it("最后一条是 tool_use 没 text → 返回空串 (text 块过滤掉所有非 text)", () => {
    expect(
      extractFinalAssistantText([assistantText("ignored"), toolCall("t1", "read")]),
    ).toBe("");
  });

  it("最后 assistant 含多 text 块 → 用 \\n\\n 拼接", () => {
    expect(extractFinalAssistantText([assistantText("a", "b", "c")])).toBe(
      "a\n\nb\n\nc",
    );
  });

  it("没有 assistant message → 返回空串", () => {
    expect(extractFinalAssistantText([userText("just user")])).toBe("");
  });

  it("空消息列表 → 返回空串", () => {
    expect(extractFinalAssistantText([])).toBe("");
  });
});

// ─── extractPartialText ───

describe("extractPartialText", () => {
  it("拼所有 assistant text 块,跨多条 message,用 \\n\\n 分隔", () => {
    expect(
      extractPartialText([
        assistantText("part-1"),
        userText("u1"),
        assistantText("part-2", "part-3"),
        toolCall("t1", "read"),
      ]),
    ).toBe("part-1\n\npart-2\n\npart-3");
  });

  it("没有 assistant text → 返回空串", () => {
    expect(
      extractPartialText([userText("u"), toolCall("t1", "read")]),
    ).toBe("");
  });

  it("空消息列表 → 返回空串", () => {
    expect(extractPartialText([])).toBe("");
  });
});

// ─── classifyResult ───

describe("classifyResult", () => {
  it("caughtError 非空 → failed (loop 基础设施崩兜底)", () => {
    expect(
      classifyResult({ reason: "completed" }, new Error("infra crash")),
    ).toBe("failed");
  });

  it("loopResult 为 null → failed (理论不可达防御)", () => {
    expect(classifyResult(null, null)).toBe("failed");
  });

  it("reason='completed' 且无错 → completed", () => {
    expect(classifyResult({ reason: "completed" }, null)).toBe("completed");
  });

  it("reason='aborted' → aborted (parent abort / wallclock / idle 都走 loop 内部 reason)", () => {
    expect(classifyResult({ reason: "aborted" }, null)).toBe("aborted");
  });

  it("reason='error' → failed", () => {
    expect(classifyResult({ reason: "error" }, null)).toBe("failed");
  });

  it("reason='max_turns' → failed", () => {
    expect(classifyResult({ reason: "max_turns" }, null)).toBe("failed");
  });
});
