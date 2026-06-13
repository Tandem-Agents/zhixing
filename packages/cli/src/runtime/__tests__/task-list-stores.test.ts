/**
 * task-list-stores 测试 —— TaskListStore 接口的 cli 端实现。
 *
 * 覆盖契约：
 *   - ConversationRepoTaskListStore：与 ConversationRepository 集成，per-id lock +
 *     atomic write 路径；conversation 不存在时 save 必须 throw（不静默 no-op）
 *   - RoutedConversationRepoTaskListStore：全域 conversationId → scope repo + localId
 *     路由，host 侧 user / workscene task_list 均持久化到 conversation meta
 *   - InMemoryTaskListStore：进程内 Map 持有，简单 CRUD
 *   - 三种 store 都满足 TaskListStore 接口的幂等 delete + load undefined 协议
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConversationRepository,
  parseConversationId,
  type ConversationScope,
  worksceneConversationId,
} from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import {
  ConversationRepoTaskListStore,
  InMemoryTaskListStore,
  RoutedConversationRepoTaskListStore,
  TaskListPersistenceError,
  type ConversationRepoTaskListRoute,
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
const state = (id: string, content = id) => ({
  items: [{ id, content, status: "pending" as const }],
});

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

// ─── RoutedConversationRepoTaskListStore ───

describe("RoutedConversationRepoTaskListStore", () => {
  function createRoute(
    userRepo: ConversationRepository,
    sceneRepos = new Map<string, ConversationRepository>(),
  ): (conversationId: string) => ConversationRepoTaskListRoute {
    return (conversationId) => {
      const { scope, localId } = parseConversationId(conversationId);
      if (scope.kind === "workscene") {
        let repo = sceneRepos.get(scope.sceneId);
        if (!repo) {
          repo = new ConversationRepository(scope);
          sceneRepos.set(scope.sceneId, repo);
        }
        return { repo, localId };
      }
      return { repo: userRepo, localId };
    };
  }

  it("user 全域 id 按原 id 持久化到 user repo", async () => {
    const userRepo = new ConversationRepository(USER_SCOPE);
    const conv = await userRepo.create({ name: "user-task" });
    const store = new RoutedConversationRepoTaskListStore(createRoute(userRepo));

    await store.save(conv.id, state("u1", "user task"));

    const loaded = await store.load(conv.id);
    expect(loaded?.items[0]?.content).toBe("user task");
    expect((await userRepo.get(conv.id))?.taskListState?.items[0]?.id).toBe("u1");
  });

  it("workscene 全域 id 路由到场景 scope repo 的 localId,并可跨 store 实例读回", async () => {
    const userRepo = new ConversationRepository(USER_SCOPE);
    const sceneScope: ConversationScope = { kind: "workscene", sceneId: "scene-a" };
    const sceneRepo = new ConversationRepository(sceneScope);
    const conv = await sceneRepo.create({ name: "scene-task" });
    const globalId = worksceneConversationId(sceneScope.sceneId, conv.id);
    const firstSceneRepos = new Map([[sceneScope.sceneId, sceneRepo]]);
    const store = new RoutedConversationRepoTaskListStore(
      createRoute(userRepo, firstSceneRepos),
    );

    await store.save(globalId, state("s1", "scene task"));

    expect((await sceneRepo.get(conv.id))?.taskListState?.items[0]?.id).toBe("s1");

    const freshStore = new RoutedConversationRepoTaskListStore(
      createRoute(new ConversationRepository(USER_SCOPE)),
    );
    const reloaded = await freshStore.load(globalId);
    expect(reloaded?.items[0]?.content).toBe("scene task");
  });

  it("save 到缺失的 routed conversation → throw 且保留全域 id", async () => {
    const userRepo = new ConversationRepository(USER_SCOPE);
    const store = new RoutedConversationRepoTaskListStore(createRoute(userRepo));
    const globalId = worksceneConversationId("scene-missing", "never-existed");

    await expect(store.save(globalId, state("x"))).rejects.toMatchObject({
      name: "TaskListPersistenceError",
      conversationId: globalId,
    });
  });

  it("delete 对缺失的 routed conversation 幂等 no-op", async () => {
    const userRepo = new ConversationRepository(USER_SCOPE);
    const store = new RoutedConversationRepoTaskListStore(createRoute(userRepo));

    await expect(
      store.delete(worksceneConversationId("scene-missing", "never-existed")),
    ).resolves.toBeUndefined();
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
