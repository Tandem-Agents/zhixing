/**
 * 记忆提取的段切换挂载契约 —— afterSummarize 收被摘段原文调提取核心；
 * 过小的被摘段不值得花一次提取 LLM 调用。
 */

import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../types/messages.js";
import type { MemoryFlusher } from "../flush-engine.js";
import { createMemoryFlushHook } from "../segment-flush-hook.js";

function msgs(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: [{ type: "text" as const, text: `m${i}` }],
  }));
}

function ctxOf(messages: Message[], abortSignal?: AbortSignal) {
  return {
    conversationId: "conv-1",
    segmentId: "seg-1",
    tokensBefore: 1000,
    messages,
    abortSignal,
  };
}

describe("createMemoryFlushHook", () => {
  it("afterSummarize：被摘段原文 + 中断信号透传给提取核心", async () => {
    const flush = vi.fn(async () => ({ extracted: 1, saved: 1, errors: [] }));
    const hook = createMemoryFlushHook({
      flusher: { flush } as unknown as MemoryFlusher,
    });
    const messages = msgs(8);
    const signal = new AbortController().signal;

    await hook.afterSummarize!(ctxOf(messages, signal), {
      facts: "f",
      state: "s",
      active: "a",
    });

    expect(flush).toHaveBeenCalledWith(messages, { abortSignal: signal });
  });

  it("被摘段过小（< minMessages）→ 不花提取调用", async () => {
    const flush = vi.fn(async () => ({ extracted: 0, saved: 0, errors: [] }));
    const hook = createMemoryFlushHook({
      flusher: { flush } as unknown as MemoryFlusher,
    });

    await hook.afterSummarize!(ctxOf(msgs(4)), { facts: "", state: "", active: "" });

    expect(flush).not.toHaveBeenCalled();
  });

  it("minMessages 可配置", async () => {
    const flush = vi.fn(async () => ({ extracted: 0, saved: 0, errors: [] }));
    const hook = createMemoryFlushHook({
      flusher: { flush } as unknown as MemoryFlusher,
      minMessages: 2,
    });

    await hook.afterSummarize!(ctxOf(msgs(2)), { facts: "", state: "", active: "" });

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
