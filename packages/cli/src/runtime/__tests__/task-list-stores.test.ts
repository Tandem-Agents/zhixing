/**
 * task-list-stores 测试 —— TaskListStore 接口的两种 cli 端实现。
 *
 * 覆盖契约：
 *   - ConversationRepoTaskListStore：与 ConversationRepository 集成，per-id lock +
 *     atomic write 路径；conversation 不存在时 save 必须 throw（不静默 no-op）
 *   - InMemoryTaskListStore：进程内 Map 持有，简单 CRUD
 *   - 两种 store 都满足 TaskListStore 接口的幂等 delete + load undefined 协议
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConversationRepository,
  type ConversationScope,
} from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import {
  ConversationRepoTaskListStore,
  InMemoryTaskListStore,
  TaskListPersistenceError,
} from "../task-list-stores.js";

// ─── 环境 fixture ───

let tmpDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmpDir = await createTempDir("task-list-stores");
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = tmpDir;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = originalHome;
});

const USER_SCOPE: ConversationScope = { kind: "user" };

// ─── ConversationRepoTaskListStore ───

describe("ConversationRepoTaskListStore", () => {
  it("load 已存在 conversation 的 taskListState", async () => {
    const repo = new ConversationRepository(USER_SCOPE);
    const conv = await repo.create({ name: "test" });
    await repo.updateTaskListState(conv.id, {
      items: [{ id: "t1", content: "x", status: "pending" }],
    });

    const store = new ConversationRepoTaskListStore(repo);
    const loaded = await store.load(conv.id);

    expect(loaded?.items).toHaveLength(1);
    expect(loaded?.items[0]?.id).toBe("t1");
  });

  it("load 不存在的 conversation 返回 undefined", async () => {
    const repo = new ConversationRepository(USER_SCOPE);
    const store = new ConversationRepoTaskListStore(repo);

    const loaded = await store.load("never-existed");
    expect(loaded).toBeUndefined();
  });

  it("load conversation 存在但无 taskListState → 返回 undefined", async () => {
    const repo = new ConversationRepository(USER_SCOPE);
    const conv = await repo.create({ name: "no-state" });

    const store = new ConversationRepoTaskListStore(repo);
    const loaded = await store.load(conv.id);
    expect(loaded).toBeUndefined();
  });

  it("save 写入后 load 拉到（round-trip）", async () => {
    const repo = new ConversationRepository(USER_SCOPE);
    const conv = await repo.create({ name: "rw" });
    const store = new ConversationRepoTaskListStore(repo);

    await store.save(conv.id, {
      items: [{ id: "a", content: "task A", status: "in_progress" }],
    });
    const loaded = await store.load(conv.id);

    expect(loaded?.items[0]?.content).toBe("task A");
    expect(loaded?.items[0]?.status).toBe("in_progress");
  });

  it("save 到不存在 conversation → throw TaskListPersistenceError（不静默 no-op）", async () => {
    const repo = new ConversationRepository(USER_SCOPE);
    const store = new ConversationRepoTaskListStore(repo);

    await expect(
      store.save("never-existed", {
        items: [{ id: "x", content: "y", status: "pending" }],
      }),
    ).rejects.toThrow(TaskListPersistenceError);
  });

  it("delete 写入 undefined 字段（meta 字段被移除）", async () => {
    const repo = new ConversationRepository(USER_SCOPE);
    const conv = await repo.create({ name: "del" });
    const store = new ConversationRepoTaskListStore(repo);

    await store.save(conv.id, {
      items: [{ id: "x", content: "y", status: "pending" }],
    });
    await store.delete(conv.id);

    const loaded = await store.load(conv.id);
    expect(loaded).toBeUndefined();
  });

  it("delete 对不存在的 conversation 幂等 no-op", async () => {
    const repo = new ConversationRepository(USER_SCOPE);
    const store = new ConversationRepoTaskListStore(repo);

    await expect(store.delete("never-existed")).resolves.toBeUndefined();
  });
});

// ─── InMemoryTaskListStore ───

describe("InMemoryTaskListStore", () => {
  it("load 不存在的 conversationId 返回 undefined", async () => {
    const store = new InMemoryTaskListStore();
    expect(await store.load("conv-1")).toBeUndefined();
  });

  it("save 后 load 拉到（round-trip）", async () => {
    const store = new InMemoryTaskListStore();
    await store.save("conv-1", {
      items: [{ id: "x", content: "y", status: "pending" }],
    });
    const loaded = await store.load("conv-1");
    expect(loaded?.items[0]?.id).toBe("x");
  });

  it("save 同一 id 覆盖前值", async () => {
    const store = new InMemoryTaskListStore();
    await store.save("conv-1", {
      items: [{ id: "old", content: "old", status: "pending" }],
    });
    await store.save("conv-1", {
      items: [{ id: "new", content: "new", status: "in_progress" }],
    });
    const loaded = await store.load("conv-1");
    expect(loaded?.items).toHaveLength(1);
    expect(loaded?.items[0]?.id).toBe("new");
  });

  it("跨 conversation 隔离", async () => {
    const store = new InMemoryTaskListStore();
    await store.save("a", { items: [{ id: "a", content: "A", status: "pending" }] });
    await store.save("b", { items: [{ id: "b", content: "B", status: "in_progress" }] });

    expect((await store.load("a"))?.items[0]?.id).toBe("a");
    expect((await store.load("b"))?.items[0]?.id).toBe("b");
  });

  it("delete 移除 id 后 load 返回 undefined", async () => {
    const store = new InMemoryTaskListStore();
    await store.save("conv-1", {
      items: [{ id: "x", content: "y", status: "pending" }],
    });
    await store.delete("conv-1");

    expect(await store.load("conv-1")).toBeUndefined();
  });

  it("delete 对不存在的 id 幂等 no-op", async () => {
    const store = new InMemoryTaskListStore();
    await expect(store.delete("never")).resolves.toBeUndefined();
  });
});
