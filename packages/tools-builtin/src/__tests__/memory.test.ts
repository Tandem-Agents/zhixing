import { describe, it, expect, beforeEach } from "vitest";
import type {
  MemoryLogicalEntry,
  ToolDefinition,
  ToolExecutionContext,
} from "@zhixing/core";
import { createMemoryTool, type MemoryToolPort } from "../memory.js";

/**
 * Memory 工具集成测试
 *
 * 通过当前 MemoryToolPort 合同观察 memory 工具的 CRUD 调用与结果。
 * 工具不再拥有文件存储，生产耐久性由 assignment-bound authority port 负责。
 */

describe("Memory Tool (integration via MemoryToolPort)", () => {
  let store: ObservableMemoryPort;
  let tool: ToolDefinition;
  const ctx: ToolExecutionContext = { workingDirectory: "/tmp" };

  beforeEach(() => {
    store = new ObservableMemoryPort();
    tool = createMemoryTool(store);
  });

  it("save → load roundtrip", async () => {
    const saved = await tool.call({
      action: "save",
      category: "person",
      id: "test-person",
      meta: { name: "Alice", relation: "朋友" },
      content: "在 Google 工作",
    }, ctx);

    expect(saved.isError).not.toBe(true);
    expect(store.entry("person", "test-person")).toMatchObject({
      meta: { name: "Alice", relation: "朋友" },
      content: "在 Google 工作",
    });
    expect(store.operationIds).toEqual(["memory:save"]);
  });

  it("save → list → delete → list roundtrip", async () => {
    await tool.call({
      action: "save",
      category: "person",
      id: "test-person",
      meta: { name: "Test Person", tags: ["test"] },
      content: "步骤 1",
    }, ctx);

    const listed = await tool.call({ action: "list", category: "person" }, ctx);
    expect(listed.content).toContain("person memories (1)");
    expect(listed.content).toContain("Test Person [test] (test-person)");

    const deleted = await tool.call({
      action: "delete",
      category: "person",
      id: "test-person",
    }, ctx);
    expect(deleted.isError).not.toBe(true);

    const empty = await tool.call({ action: "list", category: "person" }, ctx);
    expect(empty.content).toBe("No person memories found");
    expect(store.operationIds).toEqual(["memory:save", "memory:delete"]);
  });

  it("search 跨类别", async () => {
    await tool.call({
      action: "save",
      category: "person",
      id: "alice",
      meta: { name: "Alice" },
      content: "likes TypeScript",
    }, ctx);
    store.seed({
      domain: "memory",
      scope: { kind: "personal" },
      id: "profile",
      meta: { name: "Bob" },
      content: "TypeScript expert",
      revision: 1,
      digest: `sha256:${"b".repeat(64)}`,
    });

    const results = await tool.call({ action: "search", query: "TypeScript" }, ctx);
    expect(results.content).toContain("Found 2 memories");
    expect(results.content).toContain("[person] Alice (alice)");
    expect(results.content).toContain("[profile] Bob (profile)");
  });

  it("update 覆盖已有内容", async () => {
    await tool.call({
      action: "save",
      category: "person",
      id: "evolving-person",
      meta: { name: "My Person", version: 1 },
      content: "Version 1 content",
    }, ctx);

    await tool.call({
      action: "update",
      category: "person",
      id: "evolving-person",
      meta: { name: "My Person (Updated)", version: 2 },
      content: "Version 2 content",
    }, ctx);

    expect(store.entry("person", "evolving-person")).toMatchObject({
      meta: { name: "My Person (Updated)", version: 2 },
      content: "Version 2 content",
      revision: 2,
    });
    expect(store.operationIds).toEqual(["memory:save", "memory:update"]);
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

class ObservableMemoryPort implements MemoryToolPort {
  readonly #entries = new Map<string, MemoryLogicalEntry>();
  readonly operationIds: string[] = [];

  async save(input: Parameters<MemoryToolPort["save"]>[0]): Promise<void> {
    const key = this.#key(input.category, input.id);
    const previous = this.#entries.get(key);
    this.operationIds.push(input.operationId);
    this.#entries.set(key, {
      domain: input.category === "profile" ? "memory" : "people",
      scope: { kind: "personal" },
      id: input.id,
      meta: input.meta,
      content: input.content,
      revision: (previous?.revision ?? 0) + 1,
      digest: `sha256:${"a".repeat(64)}`,
    });
  }

  async search(query: string): Promise<readonly MemoryLogicalEntry[]> {
    const needle = query.toLowerCase();
    return [...this.#entries.values()].filter((entry) =>
      JSON.stringify(entry).toLowerCase().includes(needle));
  }

  async list(category: Parameters<MemoryToolPort["list"]>[0]): Promise<readonly MemoryLogicalEntry[]> {
    const domain = category === "profile" ? "memory" : "people";
    return [...this.#entries.values()].filter((entry) => entry.domain === domain);
  }

  async delete(input: Parameters<MemoryToolPort["delete"]>[0]): Promise<boolean> {
    this.operationIds.push(input.operationId);
    return this.#entries.delete(this.#key(input.category, input.id));
  }

  seed(entry: MemoryLogicalEntry): void {
    const category = entry.domain === "memory" ? "profile" : "person";
    this.#entries.set(this.#key(category, entry.id), entry);
  }

  entry(category: "profile" | "person", id: string): MemoryLogicalEntry | undefined {
    return this.#entries.get(this.#key(category, id));
  }

  #key(category: "profile" | "person", id: string): string {
    return `${category}:${id}`;
  }
}
