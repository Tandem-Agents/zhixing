import { describe, it, expect, beforeEach } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  MemoryFlusher,
  parseExtractions,
  type FlushExtraction,
} from "../flush-engine.js";
import { MemoryStore } from "../memory-store.js";
import type { Message } from "../../types/messages.js";

// ─── 辅助 ───

function msg(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

const SAMPLE_MESSAGES: Message[] = [
  msg("user", "帮我调试 Docker 网络问题，容器间无法通信"),
  msg("assistant", "好的，让我检查网络配置..."),
  msg("user", "发现问题了，需要用 bridge 模式"),
  msg("assistant", "确认 bridge 模式解决了容器通信问题。步骤：1. docker network create... 2. docker run --network..."),
  msg("user", "对了，我叫张三，在深圳做全栈开发"),
  msg("assistant", "好的张三，已了解你的信息。"),
];

function makeLLMFn(
  response: FlushExtraction[],
): (messages: readonly unknown[]) => Promise<string> {
  return async () => JSON.stringify(response);
}

async function createTempStore(): Promise<{ store: MemoryStore }> {
  return { store: new MemoryStore(await createTempDir("flush")) };
}

// ─── parseExtractions ───

describe("parseExtractions", () => {
  it("解析有效的 JSON 数组", () => {
    const input = JSON.stringify([
      { category: "profile", id: "profile", meta: { name: "张三" }, content: "全栈开发者" },
      { category: "person", id: "wife-xiaoli", meta: { name: "小丽" }, content: "妻子" },
    ]);
    const result = parseExtractions(input);
    expect(result).toHaveLength(2);
    expect(result[0]!.category).toBe("profile");
    expect(result[1]!.category).toBe("person");
  });

  it("处理 markdown 代码块包裹", () => {
    const input = '```json\n[{"category":"journal","id":"2026-04-10","meta":{},"content":"调试了 Docker"}]\n```';
    const result = parseExtractions(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("journal");
  });

  it("无效 JSON 返回空数组", () => {
    expect(parseExtractions("not json")).toEqual([]);
  });

  it("空数组字符串返回空数组", () => {
    expect(parseExtractions("[]")).toEqual([]);
  });

  it("过滤无效条目（缺少必需字段）", () => {
    const input = JSON.stringify([
      { category: "profile", id: "profile", content: "valid" },
      { category: "invalid-cat", id: "x", content: "bad category" },
      { category: "person", content: "missing id" },
      { id: "y", content: "missing category" },
    ]);
    const result = parseExtractions(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("profile");
  });

  it("meta 缺失时默认为空对象", () => {
    const input = JSON.stringify([
      { category: "journal", id: "2026-04-10", content: "some entry" },
    ]);
    const result = parseExtractions(input);
    expect(result[0]!.meta).toEqual({});
  });
});

// ─── MemoryFlusher（提取核心，触发形态无关）───

describe("MemoryFlusher", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    const result = await createTempStore();
    store = result.store;
  });

  it("从消息中提取信息并分流保存（profile / person）", async () => {
    const extractions: FlushExtraction[] = [
      {
        category: "profile",
        id: "profile",
        meta: { name: "张三" },
        content: "深圳全栈开发者",
      },
      {
        category: "person",
        id: "wife-xiaoli",
        meta: { name: "小丽", relation: "wife" },
        content: "妻子，喜欢爬山",
      },
    ];
    const flusher = new MemoryFlusher({ callLLM: makeLLMFn(extractions), store });

    const result = await flusher.flush(SAMPLE_MESSAGES);

    expect(result.extracted).toBe(2);
    expect(result.saved).toBe(2);
    expect(result.errors).toHaveLength(0);

    const profile = await store.load("profile", "profile");
    expect(profile!.meta.name).toBe("张三");
    const person = await store.load("person", "wife-xiaoli");
    expect(person!.content).toContain("爬山");
  });

  it("journal 追加模式", async () => {
    await store.save({
      category: "journal",
      id: "2026-04-10",
      meta: { date: "2026-04-10" },
      content: "上午：讨论了架构设计",
    });
    const flusher = new MemoryFlusher({
      callLLM: makeLLMFn([
        {
          category: "journal",
          id: "2026-04-10",
          meta: { date: "2026-04-10" },
          content: "下午：调试了 Docker 网络问题",
        },
      ]),
      store,
    });

    await flusher.flush(SAMPLE_MESSAGES);

    const journal = await store.load("journal", "2026-04-10");
    expect(journal!.content).toContain("上午");
    expect(journal!.content).toContain("下午");
    expect(journal!.content).toContain("---");
  });

  it("LLM 返回空数组 → 零保存零错误", async () => {
    const flusher = new MemoryFlusher({ callLLM: async () => "[]", store });
    const result = await flusher.flush(SAMPLE_MESSAGES);
    expect(result).toEqual({ extracted: 0, saved: 0, errors: [] });
  });

  it("LLM 调用抛错 → flush 抛出（容错归调用方：段切换 hook 失败降级 warning）", async () => {
    const flusher = new MemoryFlusher({
      callLLM: async () => {
        throw new Error("provider down");
      },
      store,
    });
    await expect(flusher.flush(SAMPLE_MESSAGES)).rejects.toThrow("provider down");
  });

  it("单条保存失败不阻断其余（errors 逐条收集）", async () => {
    const failing = {
      save: async (entry: { category: string }) => {
        if (entry.category === "person") throw new Error("disk full");
      },
      load: async () => null,
    } as unknown as MemoryStore;
    const flusher = new MemoryFlusher({
      callLLM: makeLLMFn([
        { category: "profile", id: "profile", meta: {}, content: "a" },
        { category: "person", id: "p-1", meta: {}, content: "b" },
      ]),
      store: failing,
    });

    const result = await flusher.flush(SAMPLE_MESSAGES);

    expect(result.extracted).toBe(2);
    expect(result.saved).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("person/p-1");
  });
});
