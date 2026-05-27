/**
 * AISecuritySteward 单元测试
 *
 * 用 mock LLMRole（产出预设 text_delta 流）验证三态裁决、JSON 容错解析、
 * 以及 LLM 不可用 / 输出非法时的 fail-safe（needs-confirm，绝不误放）。
 */

import { describe, expect, it } from "vitest";

import type { LLMRole, StreamEvent } from "@zhixing/core";
import { AISecuritySteward, type StewardInput } from "../ai-steward.js";

const INPUT: StewardInput = {
  userIntent: "调研 X 并整理笔记",
  operation: { tool: "write", resolvedPaths: ["/proj/notes.md"] },
  trustLevel: "scene",
};

function stewardWith(chat: LLMRole["chat"]): AISecuritySteward {
  const llm = { provider: {}, model: "mock", chat } as unknown as LLMRole;
  return new AISecuritySteward(llm);
}

function emitting(text: string): LLMRole["chat"] {
  return async function* () {
    yield { type: "text_delta", text } as StreamEvent;
  };
}

describe("AISecuritySteward", () => {
  it("safe 裁决 → safe", async () => {
    const v = await stewardWith(
      emitting('{"decision":"safe","reason":"意图对齐","confidence":0.9}'),
    ).review(INPUT);
    expect(v.decision).toBe("safe");
  });

  it("escalate 裁决 → escalate", async () => {
    const v = await stewardWith(
      emitting('{"decision":"escalate","reason":"识破高危","confidence":0.8}'),
    ).review(INPUT);
    expect(v.decision).toBe("escalate");
  });

  it("needs-confirm 裁决 → needs-confirm", async () => {
    const v = await stewardWith(
      emitting('{"decision":"needs-confirm","reason":"不确定","confidence":0.5}'),
    ).review(INPUT);
    expect(v.decision).toBe("needs-confirm");
  });

  it("JSON 包裹在前后文字中也能解析", async () => {
    const v = await stewardWith(
      emitting('判断如下：\n{"decision":"safe","reason":"ok","confidence":0.9}\n以上。'),
    ).review(INPUT);
    expect(v.decision).toBe("safe");
  });

  it("输出无 JSON → fail-safe needs-confirm", async () => {
    const v = await stewardWith(emitting("这不是 JSON")).review(INPUT);
    expect(v.decision).toBe("needs-confirm");
    expect(v.confidence).toBe(0);
  });

  it("无效 decision 值 → fail-safe needs-confirm", async () => {
    const v = await stewardWith(
      emitting('{"decision":"yes","reason":"x"}'),
    ).review(INPUT);
    expect(v.decision).toBe("needs-confirm");
  });

  it("LLM 调用抛错 → fail-safe needs-confirm", async () => {
    const chat: LLMRole["chat"] = async function* () {
      throw new Error("llm down");
    };
    const v = await stewardWith(chat).review(INPUT);
    expect(v.decision).toBe("needs-confirm");
  });
});
