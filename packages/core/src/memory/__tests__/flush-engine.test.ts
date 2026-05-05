import { describe, it, expect, beforeEach } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  MemoryFlushStrategy,
  parseExtractions,
  type FlushLLMFn,
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

function makeLLMFn(response: FlushExtraction[]): FlushLLMFn {
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
      { category: "skill", id: "docker-network", meta: { title: "Docker 网络调试" }, content: "步骤..." },
    ]);
    const result = parseExtractions(input);
    expect(result).toHaveLength(2);
    expect(result[0]!.category).toBe("profile");
    expect(result[1]!.category).toBe("skill");
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
      { category: "skill", content: "missing id" },
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

// ─── MemoryFlushStrategy ───

describe("MemoryFlushStrategy", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    const result = await createTempStore();
    store = result.store;
  });

  it("从消息中提取信息并保存到记忆", async () => {
    const extractions: FlushExtraction[] = [
      {
        category: "profile",
        id: "profile",
        meta: { name: "张三" },
        content: "深圳全栈开发者",
      },
      {
        category: "skill",
        id: "docker-network",
        meta: { title: "Docker 网络调试", tags: ["docker"], triggers: ["容器网络"] },
        content: "使用 bridge 模式解决容器通信",
      },
    ];

    const strategy = new MemoryFlushStrategy({
      callLLM: makeLLMFn(extractions),
      store,
    });

    const result = await strategy.apply({
      messages: SAMPLE_MESSAGES,
      budget: { contextWindow: 100000, effectiveWindow: 80000, currentTokens: 70000, usageRatio: 0.875, status: "compact" },
      currentTurn: 3,
    });

    // 不修改消息
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(SAMPLE_MESSAGES);

    // 验证保存结果
    expect(strategy.lastResult!.extracted).toBe(2);
    expect(strategy.lastResult!.saved).toBe(2);
    expect(strategy.lastResult!.errors).toHaveLength(0);

    // 验证文件确实被创建
    const profile = await store.load("profile", "profile");
    expect(profile).not.toBeNull();
    expect(profile!.meta.name).toBe("张三");

    const skill = await store.load("skill", "docker-network");
    expect(skill).not.toBeNull();
    expect(skill!.content).toContain("bridge");
  });

  it("journal 追加模式", async () => {
    // 先写入一条 journal
    await store.save({
      category: "journal",
      id: "2026-04-10",
      meta: { date: "2026-04-10" },
      content: "上午：讨论了架构设计",
    });

    const extractions: FlushExtraction[] = [
      {
        category: "journal",
        id: "2026-04-10",
        meta: { date: "2026-04-10" },
        content: "下午：调试了 Docker 网络问题",
      },
    ];

    const strategy = new MemoryFlushStrategy({
      callLLM: makeLLMFn(extractions),
      store,
    });

    await strategy.apply({
      messages: SAMPLE_MESSAGES,
      budget: { contextWindow: 100000, effectiveWindow: 80000, currentTokens: 70000, usageRatio: 0.875, status: "compact" },
      currentTurn: 3,
    });

    const journal = await store.load("journal", "2026-04-10");
    expect(journal!.content).toContain("上午");
    expect(journal!.content).toContain("下午");
    expect(journal!.content).toContain("---");
  });

  it("LLM 返回空数组时不保存", async () => {
    const strategy = new MemoryFlushStrategy({
      callLLM: async () => "[]",
      store,
    });

    await strategy.apply({
      messages: SAMPLE_MESSAGES,
      budget: { contextWindow: 100000, effectiveWindow: 80000, currentTokens: 70000, usageRatio: 0.875, status: "compact" },
      currentTurn: 3,
    });

    expect(strategy.lastResult!.extracted).toBe(0);
    expect(strategy.lastResult!.saved).toBe(0);
  });

  it("LLM 调用失败时静默降级", async () => {
    const strategy = new MemoryFlushStrategy({
      callLLM: async () => { throw new Error("API error"); },
      store,
    });

    const result = await strategy.apply({
      messages: SAMPLE_MESSAGES,
      budget: { contextWindow: 100000, effectiveWindow: 80000, currentTokens: 70000, usageRatio: 0.875, status: "compact" },
      currentTurn: 3,
    });

    // 不应阻塞压缩管线
    expect(result.compacted).toBe(false);
    expect(strategy.lastResult!.errors).toContain("flush failed");
  });

  it("消息不足时跳过", () => {
    const strategy = new MemoryFlushStrategy({
      callLLM: async () => "[]",
      store,
      minMessages: 6,
    });

    const canApply = strategy.canApply({
      messages: SAMPLE_MESSAGES.slice(0, 3),
      budget: { contextWindow: 100000, effectiveWindow: 80000, currentTokens: 70000, usageRatio: 0.875, status: "compact" },
      currentTurn: 1,
    });

    expect(canApply).toBe(false);
  });

  it("person 类型正确保存", async () => {
    const extractions: FlushExtraction[] = [
      {
        category: "person",
        id: "wife-xiaoli",
        meta: { name: "小丽", relation: "妻子" },
        content: "喜欢旅游和摄影",
      },
    ];

    const strategy = new MemoryFlushStrategy({
      callLLM: makeLLMFn(extractions),
      store,
    });

    await strategy.apply({
      messages: SAMPLE_MESSAGES,
      budget: { contextWindow: 100000, effectiveWindow: 80000, currentTokens: 70000, usageRatio: 0.875, status: "compact" },
      currentTurn: 3,
    });

    const person = await store.load("person", "wife-xiaoli");
    expect(person).not.toBeNull();
    expect(person!.meta.name).toBe("小丽");
    expect(person!.meta.relation).toBe("妻子");
  });

  it("priority 为 3（介于 L1 和 L2 之间）", () => {
    const strategy = new MemoryFlushStrategy({
      callLLM: async () => "[]",
      store,
    });
    expect(strategy.priority).toBe(3);
    expect(strategy.name).toBe("memory_flush");
  });
});
