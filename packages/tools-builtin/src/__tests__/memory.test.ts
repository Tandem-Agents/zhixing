import { describe, it, expect, beforeEach } from "vitest";
import type { ToolDefinition, ToolExecutionContext } from "@zhixing/core";
import { MemoryStore } from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import { createMemoryTool, type MemoryToolPort } from "../memory.js";

/**
 * Memory 工具集成测试
 *
 * 直接测试 MemoryStore 的 CRUD 操作，模拟 memory 工具的行为。
 * 使用真实临时目录，验证端到端的文件读写。
 */

describe("Memory Tool (integration via MemoryStore)", () => {
  let tmpDir: string;
  let store: MemoryStore;
  const ctx: ToolExecutionContext = { workingDirectory: "/tmp" };

  beforeEach(async () => {
    tmpDir = await createTempDir("memory-tool");
    store = new MemoryStore(tmpDir);
  });

  it("save → load roundtrip", async () => {
    await store.save({
      category: "person",
      id: "test-person",
      meta: { name: "Alice", relation: "朋友" },
      content: "在 Google 工作",
    });

    const entry = await store.load("person", "test-person");
    expect(entry).not.toBeNull();
    expect(entry!.meta.name).toBe("Alice");
    expect(entry!.content).toBe("在 Google 工作");
  });

  it("save → list → delete → list roundtrip", async () => {
    await store.save({
      category: "person",
      id: "test-person",
      meta: { name: "Test Person", tags: ["test"] },
      content: "步骤 1",
    });

    let entries = await store.list("person");
    expect(entries).toHaveLength(1);

    await store.delete("person", "test-person");

    entries = await store.list("person");
    expect(entries).toHaveLength(0);
  });

  it("search 跨类别", async () => {
    await store.save({
      category: "person",
      id: "alice",
      meta: { name: "Alice" },
      content: "likes TypeScript",
    });
    await store.save({
      category: "person",
      id: "bob",
      meta: { name: "Bob" },
      content: "TypeScript expert",
    });

    const results = await store.search("TypeScript");
    expect(results).toHaveLength(2);
  });

  it("update 覆盖已有内容", async () => {
    await store.save({
      category: "person",
      id: "evolving-person",
      meta: { name: "My Person", version: 1 },
      content: "Version 1 content",
    });

    await store.save({
      category: "person",
      id: "evolving-person",
      meta: { name: "My Person (Updated)", version: 2 },
      content: "Version 2 content",
    });

    const entry = await store.load("person", "evolving-person");
    expect(entry!.meta.version).toBe(2);
    expect(entry!.content).toBe("Version 2 content");
  });
});

describe("Memory Tool canonical product boundary", () => {
  const ctx: ToolExecutionContext = { workingDirectory: "/tmp" };

  it("rejects a non-canonical person id before calling the producer port", async () => {
    let writes = 0;
    const tool = createMemoryTool(fakePort({
      save: async () => {
        writes++;
      },
    }));

    const result = await tool.call({
      action: "save",
      category: "person",
      id: "小丽",
      meta: { name: "小丽", relation: "friend" },
      content: "friend",
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("safe lowercase slug");
    expect(writes).toBe(0);
  });

  it("renders canonical domain-backed search results as product categories", async () => {
    const tool = createMemoryTool(fakePort({
      search: async () => [{
        domain: "people",
        scope: { kind: "personal" },
        id: "wife-xiaoli",
        meta: { name: "小丽" },
        content: "family",
        revision: 1,
        digest: `sha256:${"a".repeat(64)}`,
      }],
    }));

    const result = await tool.call({ action: "search", query: "小丽" }, ctx);

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("[person]");
    expect(result.content).not.toContain("[undefined]");
  });
});

function fakePort(overrides: Partial<MemoryToolPort>): MemoryToolPort {
  return {
    save: async () => {},
    search: async () => [],
    list: async () => [],
    delete: async () => false,
    ...overrides,
  };
}
