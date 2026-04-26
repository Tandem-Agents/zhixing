import type { StreamEvent } from "@zhixing/core";
import { describe, expect, it } from "vitest";
import { DISTILL_SYSTEM_PROMPT, buildDistillPrompt, collectStream } from "../distill.js";

async function* makeStream(events: StreamEvent[]): AsyncGenerator<StreamEvent, void, undefined> {
  for (const e of events) {
    yield e;
  }
}

describe("DISTILL_SYSTEM_PROMPT", () => {
  it("非空且包含关键约束词", () => {
    expect(DISTILL_SYSTEM_PROMPT).toBeTruthy();
    expect(DISTILL_SYSTEM_PROMPT).toContain("concise");
    expect(DISTILL_SYSTEM_PROMPT).toContain("Markdown");
    expect(DISTILL_SYSTEM_PROMPT).toMatch(/not invent/i);
  });
});

describe("buildDistillPrompt", () => {
  it("拼接顺序: prompt → 分隔 → URL → content", () => {
    const result = buildDistillPrompt("https://x.com/", "raw text", "What is X?");
    expect(result).toBe("What is X?\n\n---\nSource URL: https://x.com/\n\nContent:\nraw text");
  });

  it("prompt 在最前(让模型先看用户意图)", () => {
    const result = buildDistillPrompt("https://x.com/", "C", "P");
    expect(result.indexOf("P")).toBe(0);
    expect(result.indexOf("P")).toBeLessThan(result.indexOf("Source URL"));
    expect(result.indexOf("Source URL")).toBeLessThan(result.indexOf("C"));
  });

  it("超长 content 不被截断(截断责任在 caller)", () => {
    const big = "x".repeat(100_000);
    const result = buildDistillPrompt("https://x.com/", big, "P");
    expect(result).toContain(big);
  });
});

describe("collectStream", () => {
  it("累积 text_delta", async () => {
    const text = await collectStream(
      makeStream([
        { type: "message_start" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
      ]),
    );
    expect(text).toBe("Hello world");
  });

  it("忽略 thinking_delta", async () => {
    const text = await collectStream(
      makeStream([
        { type: "thinking_delta", thinking: "internal thought" },
        { type: "text_delta", text: "answer" },
      ]),
    );
    expect(text).toBe("answer");
    expect(text).not.toContain("internal thought");
  });

  it("忽略 tool_call_* 事件", async () => {
    const text = await collectStream(
      makeStream([
        { type: "tool_call_start", id: "1", name: "x" },
        { type: "tool_call_delta", id: "1", argsFragment: '{"a":1}' },
        { type: "tool_call_end", id: "1" },
        { type: "text_delta", text: "result" },
      ]),
    );
    expect(text).toBe("result");
  });

  it("空 stream 返回空字符串", async () => {
    expect(await collectStream(makeStream([]))).toBe("");
  });

  it("仅 text_delta 也工作", async () => {
    const text = await collectStream(
      makeStream([{ type: "text_delta", text: "only text" }]),
    );
    expect(text).toBe("only text");
  });
});
