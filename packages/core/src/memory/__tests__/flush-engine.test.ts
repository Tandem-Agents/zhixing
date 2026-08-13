import { describe, expect, it, vi } from "vitest";
import {
  MemoryFlusher,
  parseExtractions,
  type FlushExtraction,
} from "../flush-engine.js";
import type { Message } from "../../types/messages.js";

function msg(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

const SAMPLE_MESSAGES: Message[] = [
  msg("user", "帮我调试 Docker 网络问题，容器间无法通信"),
  msg("assistant", "好的，让我检查网络配置..."),
  msg("user", "发现问题了，需要用 bridge 模式"),
  msg("assistant", "确认 bridge 模式解决了容器通信问题。"),
  msg("user", "对了，我叫张三，在深圳做全栈开发"),
  msg("assistant", "好的张三，已了解你的信息。"),
];

function makeLLMFn(response: FlushExtraction[]): () => Promise<string> {
  return async () => JSON.stringify(response);
}

describe("parseExtractions", () => {
  it("解析严格的 profile、person 与 journal 身份", () => {
    const result = parseExtractions(JSON.stringify([
      { category: "profile", id: "profile", meta: { name: "张三" }, content: "全栈开发者" },
      { category: "person", id: "wife-xiaoli", meta: { name: "小丽" }, content: "妻子" },
      { category: "journal", id: "2026-04-10", meta: {}, content: "调试了 Docker" },
      { category: "profile", id: "main", content: "wrong profile identity" },
      { category: "person", id: "小丽", content: "unsafe person id" },
      { category: "journal", id: "2025-02-29", content: "invalid day" },
    ]));

    expect(result.map(({ category, id }) => ({ category, id }))).toEqual([
      { category: "profile", id: "profile" },
      { category: "person", id: "wife-xiaoli" },
      { category: "journal", id: "2026-04-10" },
    ]);
  });

  it("接受 JSON 代码块、补空 meta 并拒绝空白 journal", () => {
    expect(parseExtractions(
      '```json\n[{"category":"journal","id":"2026-04-10","content":"some entry"}]\n```',
    )).toEqual([{
      category: "journal",
      id: "2026-04-10",
      meta: {},
      content: "some entry",
    }]);
    expect(parseExtractions(JSON.stringify([
      { category: "journal", id: "2026-04-10", content: " \n\t " },
    ]))).toEqual([]);
    expect(parseExtractions("not json")).toEqual([]);
  });
});

describe("MemoryFlusher", () => {
  it("只把规范提取交给 staged authority writer，并生成稳定逐条 operationId", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const flusher = new MemoryFlusher({
      callLLM: makeLLMFn([
        { category: "profile", id: "profile", meta: {}, content: "a" },
        { category: "journal", id: "2026-08-04", meta: {}, content: "b" },
      ]),
      write,
    });

    await expect(flusher.flush(SAMPLE_MESSAGES, {
      operationId: "segment-memory:segment-7",
    })).resolves.toEqual({ extracted: 2, saved: 2, errors: [] });
    expect(write).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ category: "profile", id: "profile" }),
      "segment-memory:segment-7:0",
    );
    expect(write).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ category: "journal", id: "2026-08-04" }),
      "segment-memory:segment-7:1",
    );
  });

  it("LLM 空结果零写，LLM 失败由调用方处理", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    await expect(new MemoryFlusher({
      callLLM: async () => "[]",
      write,
    }).flush(SAMPLE_MESSAGES)).resolves.toEqual({ extracted: 0, saved: 0, errors: [] });
    expect(write).not.toHaveBeenCalled();

    await expect(new MemoryFlusher({
      callLLM: async () => { throw new Error("provider down"); },
      write,
    }).flush(SAMPLE_MESSAGES)).rejects.toThrow("provider down");
  });

  it("单条 authority 写失败不阻断其余提取", async () => {
    const write = vi.fn(async (entry: FlushExtraction) => {
      if (entry.category === "person") throw new Error("authority unavailable");
    });
    const flusher = new MemoryFlusher({
      callLLM: makeLLMFn([
        { category: "profile", id: "profile", meta: {}, content: "a" },
        { category: "person", id: "p-1", meta: {}, content: "b" },
      ]),
      write,
    });

    const result = await flusher.flush(SAMPLE_MESSAGES);
    expect(result.extracted).toBe(2);
    expect(result.saved).toBe(1);
    expect(result.errors).toEqual([expect.stringContaining("person/p-1")]);
  });
});
