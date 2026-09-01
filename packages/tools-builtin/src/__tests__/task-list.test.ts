/**
 * task_list 工具 + TaskListService 单元测试
 *
 * 三层契约覆盖：
 *   - TaskListStore 接口契约（mock 实现）
 *   - TaskListService 业务逻辑（per-conversation cache、原子 set、cache 生命周期）
 *   - 工具行为（ephemeral 拒绝、输入校验、持久化失败 isError）
 */

import { describe, it, expect } from "vitest";
import type { TaskListState } from "@zhixing/core";
import {
  ConversationTaskListToolApplicationService,
  type ConversationTaskListToolStagePort,
} from "@zhixing/core/conversation/application";
import {
  createTaskListTool,
  TaskListService,
  type TaskListStore,
} from "../task-list.js";

// ─── 内存 store fixture ───

interface StubStore extends TaskListStore {
  saveCalls: { id: string; state: TaskListState }[];
  loadCalls: string[];
  deleteCalls: string[];
  data: Map<string, TaskListState>;
  /** 设置下一次 save 调用 throw 的错误 */
  primeSaveFailure: (err: Error) => void;
}

function createStubStore(): StubStore {
  const data = new Map<string, TaskListState>();
  const saveCalls: StubStore["saveCalls"] = [];
  const loadCalls: string[] = [];
  const deleteCalls: string[] = [];
  let pendingError: Error | null = null;

  return {
    data,
    saveCalls,
    loadCalls,
    deleteCalls,
    primeSaveFailure(err) {
      pendingError = err;
    },
    async load(id) {
      loadCalls.push(id);
      return data.get(id);
    },
    async save(id, state) {
      saveCalls.push({ id, state });
      if (pendingError) {
        const err = pendingError;
        pendingError = null;
        throw err;
      }
      data.set(id, state);
    },
    async delete(id) {
      deleteCalls.push(id);
      data.delete(id);
    },
  };
}

function createToolFixture(
  getConversationId: () => string | undefined,
  stage: ConversationTaskListToolStagePort["stage"] = async () => {},
) {
  return createTaskListTool(
    getConversationId,
    new ConversationTaskListToolApplicationService({ stage }),
  );
}

// ─── TaskListService 同步查询 ───

describe("TaskListService — 同步查询", () => {
  it("初始 cache 空 —— getCached 返回 null，getInProgressTasks 返回空数组", () => {
    const service = new TaskListService(createStubStore());
    expect(service.getCached("conv-1")).toBeNull();
    expect(service.getInProgressTasks("conv-1")).toEqual([]);
    expect(service.getAllTasks("conv-1")).toEqual([]);
  });

  it("prime 后 cache 命中 —— getCached 返回 state", async () => {
    const store = createStubStore();
    store.data.set("conv-1", {
      items: [{ id: "t1", content: "x", status: "pending" }],
    });
    const service = new TaskListService(store);

    await service.prime("conv-1");
    expect(service.getCached("conv-1")?.items).toHaveLength(1);
  });

  it("getInProgressTasks 过滤 in_progress 状态", async () => {
    const store = createStubStore();
    store.data.set("conv-1", {
      items: [
        { id: "a", content: "p", status: "pending" },
        { id: "b", content: "i1", status: "in_progress" },
        { id: "c", content: "c", status: "completed" },
        { id: "d", content: "i2", status: "in_progress" },
      ],
    });
    const service = new TaskListService(store);
    await service.prime("conv-1");

    const inProgress = service.getInProgressTasks("conv-1");
    expect(inProgress).toHaveLength(2);
    expect(inProgress.map((t) => t.id)).toEqual(["b", "d"]);
  });
});

// ─── TaskListService cache 生命周期 ───

describe("TaskListService — cache 生命周期", () => {
  it("prime 已 cache 时跳过 load（避免重复 I/O）", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    await service.prime("conv-1");
    await service.prime("conv-1");
    await service.prime("conv-1");

    expect(store.loadCalls).toEqual(["conv-1"]);
  });

  it("clear 后 prime 重新 load（cache 已驱逐）", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    await service.prime("conv-1");
    service.clear("conv-1");
    await service.prime("conv-1");

    expect(store.loadCalls).toEqual(["conv-1", "conv-1"]);
  });

  it("prime 加载失败退化为空列表（不抛错）", async () => {
    const failingStore: TaskListStore = {
      load: async () => {
        throw new Error("disk error");
      },
      save: async () => {},
      delete: async () => {},
    };
    const service = new TaskListService(failingStore);

    await expect(service.prime("conv-1")).resolves.not.toThrow();
    expect(service.getCached("conv-1")).toEqual({ items: [] });
  });

  it("clear 仅清 cache，不调 store.delete", () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    service["cache"].set("conv-1", { items: [{ id: "x", content: "y", status: "pending" }] });

    service.clear("conv-1");

    expect(service.getCached("conv-1")).toBeNull();
    expect(store.deleteCalls).toEqual([]);
  });
});

// ─── TaskListService 原子 set ───

describe("TaskListService — 原子 set", () => {
  it("set 成功：cache + store 同步更新", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    await service.set("conv-1", [{ id: "a", content: "x", status: "pending" }]);

    expect(service.getCached("conv-1")?.items).toHaveLength(1);
    expect(store.data.get("conv-1")?.items).toHaveLength(1);
    expect(store.saveCalls).toHaveLength(1);
  });

  it("set 失败：cache 不动（无 split-brain）", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    // 先成功 set 一次
    await service.set("conv-1", [{ id: "a", content: "first", status: "pending" }]);
    const before = service.getCached("conv-1");

    // 第二次 set 失败 —— store.save throw，cache 不应被修改
    store.primeSaveFailure(new Error("disk full"));
    await expect(
      service.set("conv-1", [{ id: "b", content: "second", status: "in_progress" }]),
    ).rejects.toThrow("disk full");

    // cache 保持失败前状态 —— 与磁盘一致（都是 "first"）
    expect(service.getCached("conv-1")).toEqual(before);
    expect(service.getCached("conv-1")?.items[0]?.content).toBe("first");
  });

  it("set 首次失败：cache 仍为 null（不留半态）", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    store.primeSaveFailure(new Error("disk full"));
    await expect(
      service.set("conv-1", [{ id: "a", content: "x", status: "pending" }]),
    ).rejects.toThrow();

    // store.save 失败 —— cache 从未被写入
    expect(service.getCached("conv-1")).toBeNull();
  });

  it("跨 conversation 隔离 —— 同时 set 两个不同 convId，cache 各自独立", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    await service.set("conv-A", [{ id: "a1", content: "A 任务", status: "pending" }]);
    await service.set("conv-B", [{ id: "b1", content: "B 任务", status: "in_progress" }]);

    expect(service.getCached("conv-A")?.items[0]?.content).toBe("A 任务");
    expect(service.getCached("conv-B")?.items[0]?.content).toBe("B 任务");
    expect(service.getInProgressTasks("conv-A")).toHaveLength(0);
    expect(service.getInProgressTasks("conv-B")).toHaveLength(1);
  });
});

// ─── 工具行为：ephemeral 拒绝 ───

describe("task_list 工具 — ephemeral 拒绝（修复 Bug-1）", () => {
  it("getConversationId 返回 undefined → isError + 不调 store.save", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    const tool = createToolFixture(() => undefined);

    const result = await tool.call(
      { items: [{ content: "should be rejected", status: "pending" }] },
      { workingDirectory: "/tmp" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no conversation");
    expect(store.saveCalls).toEqual([]);
  });

  it("ephemeral 路径调用不污染任何 conversation 的 cache", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    // 主对话先建立 cache
    await service.set("main", [{ id: "main-task", content: "用户任务", status: "in_progress" }]);
    const before = service.getCached("main");

    // 模拟"定时任务路径"调用（无 conversationId）
    const tool = createToolFixture(() => undefined);
    await tool.call(
      { items: [{ content: "定时任务", status: "pending" }] },
      { workingDirectory: "/tmp" },
    );

    // 主对话 cache 完全不变
    expect(service.getCached("main")).toEqual(before);
    expect(service.getInProgressTasks("main")).toHaveLength(1);
    expect(service.getInProgressTasks("main")[0]?.content).toBe("用户任务");
  });
});

describe("task_list 工具 — assignment staged 边界", () => {
  function fixture() {
    const staged: Parameters<ConversationTaskListToolStagePort["stage"]>[0][] = [];
    const stage: ConversationTaskListToolStagePort["stage"] = async (input) => {
      staged.push(input);
    };
    return { staged, stage };
  }

  it("run 内 set 只追加 task-list-op，commit 前不改 store/cache", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    const { staged, stage } = fixture();
    const tool = createToolFixture(() => "conv-1", stage);

    const result = await tool.call(
      { items: [{ content: "finish work", status: "in_progress" }] },
      { workingDirectory: "/tmp", toolCallId: "call-1" },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("current turn completes successfully");
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      operationId: "task-list:call-1",
      taskList: { items: [{ content: "finish work" }] },
    });
    expect(store.saveCalls).toEqual([]);
    expect(service.getCached("conv-1")).toBeNull();
  });

  it("同一 durable toolCall 重放生成全等任务身份与 operationId", async () => {
    const { staged, stage } = fixture();
    const tool = createToolFixture(() => "conv-1", stage);
    const input = { items: [{ content: "stable", status: "pending" }] };

    await tool.call(input, { workingDirectory: "/tmp", toolCallId: "call-stable" });
    await tool.call(input, { workingDirectory: "/tmp", toolCallId: "call-stable" });

    expect(staged[1]).toEqual(staged[0]);
  });

  it("无 active assignment 时 fail-closed，不降级直写", async () => {
    const store = createStubStore();
    const tool = createToolFixture(
      () => "conv-1",
      async () => {
        throw new Error("Task list updates require an active durable turn.");
      },
    );
    const result = await tool.call(
      { items: [{ content: "blocked", status: "pending" }] },
      { workingDirectory: "/tmp", toolCallId: "call-blocked" },
    );
    expect(result.isError).toBe(true);
    expect(store.saveCalls).toEqual([]);
  });
});

// ─── 工具行为：输入校验 ───

describe("task_list 工具 — 输入校验", () => {
  it("items 非数组 → isError", async () => {
    const tool = createToolFixture(() => "conv-1");
    const result = await tool.call({ items: "nope" }, { workingDirectory: "/tmp" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("items");
  });

  it("item 缺 content → isError", async () => {
    const tool = createToolFixture(() => "conv-1");
    const result = await tool.call(
      { items: [{ status: "pending" }] },
      { workingDirectory: "/tmp" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("content");
  });

  it("status 非法 → isError", async () => {
    const tool = createToolFixture(() => "conv-1");
    const result = await tool.call(
      { items: [{ content: "x", status: "bogus" }] },
      { workingDirectory: "/tmp" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("status");
  });
});

// ─── 工具行为：领域应用边界 ───

describe("task_list 工具 — 领域应用边界", () => {
  it("缺省 id 由 durable operation 稳定派生，显式 id 保留", async () => {
    const staged: Parameters<ConversationTaskListToolStagePort["stage"]>[0][] = [];
    const tool = createToolFixture(
      () => "conv-1",
      async (input) => staged.push(input),
    );

    await tool.call(
      {
        items: [
          { content: "auto", status: "pending" },
          { id: "stable", content: "explicit", status: "pending" },
        ],
      },
      { workingDirectory: "/tmp", toolCallId: "stable-call" },
    );

    expect(staged[0]?.taskList.items[0]?.id).toMatch(/^task-/u);
    expect(staged[0]?.taskList.items[1]?.id).toBe("stable");
  });

  it("staging 失败可观察且不会回退到 TaskListStore", async () => {
    const store = createStubStore();
    const tool = createToolFixture(
      () => "conv-1",
      async () => {
        throw new Error("stage failed");
      },
    );
    const result = await tool.call(
      { items: [{ content: "blocked", status: "pending" }] },
      { workingDirectory: "/tmp", toolCallId: "blocked" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("stage failed");
    expect(store.saveCalls).toEqual([]);
  });
});

// ─── 工具属性 ───

describe("task_list 工具 — 工具定义", () => {
  it("工具 name + 标志字段", () => {
    const tool = createToolFixture(() => "conv-1");

    expect(tool.name).toBe("task_list");
    expect(tool.needsPermission).toBe(false);
    expect(tool.isReadOnly).toBe(false);
    expect(tool.isParallelSafe).toBe(false);
  });

  it("description 明确 ephemeral 不可用", () => {
    const tool = createToolFixture(() => "conv-1");
    expect(tool.description).toContain("persistent conversation");
    expect(tool.description.toLowerCase()).toMatch(
      /unavailable|one-shot|scheduled/,
    );
  });
});

// ─── TaskListService mutate ───

describe("TaskListService — mutate", () => {
  it("mutate 基本：读 cache → 应用 mutator → set 写磁盘 + cache", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    await service.prime("conv-1");
    await service.set("conv-1", [
      { id: "a", content: "old", status: "pending" },
    ]);

    await service.mutate("conv-1", (curr) => [
      ...curr,
      { id: "b", content: "new", status: "pending" },
    ]);

    expect(service.getAllTasks("conv-1")).toHaveLength(2);
    expect(store.data.get("conv-1")?.items).toHaveLength(2);
  });

  it("mutate 自动 prime —— cache miss 时不会用空数组覆盖磁盘数据", async () => {
    const store = createStubStore();
    store.data.set("conv-1", {
      items: [
        { id: "a", content: "exists-on-disk", status: "pending" },
        { id: "b", content: "also-on-disk", status: "completed" },
      ],
    });
    const service = new TaskListService(store);
    // 故意不调 prime —— 模拟 cli 装配遗漏

    await service.mutate("conv-1", (curr) => [
      ...curr,
      { id: "c", content: "added", status: "pending" },
    ]);

    // 关键：磁盘上原有的 a / b 不丢失，新增 c
    expect(service.getAllTasks("conv-1")).toHaveLength(3);
    expect(store.data.get("conv-1")?.items.map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("mutate 失败：mutator 抛错直接上抛，cache 不动", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    await service.set("conv-1", [
      { id: "a", content: "stable", status: "pending" },
    ]);
    const before = service.getCached("conv-1");

    await expect(
      service.mutate("conv-1", () => {
        throw new Error("mutator boom");
      }),
    ).rejects.toThrow("mutator boom");

    expect(service.getCached("conv-1")).toEqual(before);
  });

  it("mutate 失败：store.save 抛错直接上抛，cache 不动", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    await service.set("conv-1", [
      { id: "a", content: "stable", status: "pending" },
    ]);
    const before = service.getCached("conv-1");

    store.primeSaveFailure(new Error("disk full"));
    await expect(
      service.mutate("conv-1", (curr) => [
        ...curr,
        { id: "b", content: "x", status: "pending" },
      ]),
    ).rejects.toThrow("disk full");

    expect(service.getCached("conv-1")).toEqual(before);
  });
});

// ─── TaskListService subscribe ───

describe("TaskListService — subscribe", () => {
  it("set 成功后触发 emit（携带新 state）", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    const events: { conversationId: string; state: TaskListState | null }[] = [];
    service.subscribe((e) => events.push(e));

    await service.set("conv-1", [
      { id: "a", content: "x", status: "pending" },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.conversationId).toBe("conv-1");
    expect(events[0]?.state?.items[0]?.content).toBe("x");
  });

  it("clear 触发 emit({state: null})", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    await service.set("conv-1", [
      { id: "a", content: "x", status: "pending" },
    ]);
    const events: { conversationId: string; state: TaskListState | null }[] = [];
    service.subscribe((e) => events.push(e));

    service.clear("conv-1");

    expect(events).toHaveLength(1);
    expect(events[0]?.conversationId).toBe("conv-1");
    expect(events[0]?.state).toBeNull();
  });

  it("set 失败不触发 emit（订阅者永远看持久化后真相）", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    const events: unknown[] = [];
    service.subscribe((e) => events.push(e));

    store.primeSaveFailure(new Error("disk full"));
    await expect(
      service.set("conv-1", [
        { id: "a", content: "x", status: "pending" },
      ]),
    ).rejects.toThrow();

    expect(events).toEqual([]);
  });

  it("多订阅者隔离：一个抛错不影响其他订阅者收到事件", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    const okEvents: unknown[] = [];
    service.subscribe(() => {
      throw new Error("listener boom");
    });
    service.subscribe((e) => okEvents.push(e));

    await service.set("conv-1", [
      { id: "a", content: "x", status: "pending" },
    ]);

    expect(okEvents).toHaveLength(1);
  });

  it("unsubscribe 后不再收到事件", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    const events: unknown[] = [];
    const unsubscribe = service.subscribe((e) => events.push(e));

    await service.set("conv-1", [
      { id: "a", content: "x", status: "pending" },
    ]);
    unsubscribe();
    await service.set("conv-1", [
      { id: "b", content: "y", status: "pending" },
    ]);

    expect(events).toHaveLength(1);
  });

  it("unsubscribe 幂等 —— 重复调用不抛错", async () => {
    const service = new TaskListService(createStubStore());
    const unsubscribe = service.subscribe(() => {});

    expect(() => {
      unsubscribe();
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });
});
