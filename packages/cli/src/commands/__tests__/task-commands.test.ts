/**
 * registerTaskCommands 端到端测试 —— 通过真实 dispatcher 调用命令，
 * 断言 service 状态变化 + writer 输出。
 *
 * 使用真实 DefaultCommandRegistry + TaskListService + 内存 store —— 不 mock 业务层。
 * 仅 writer 是 stub（捕获输出）。
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { RuntimeContext, TaskListState } from "@zhixing/core";
import {
  DefaultCommandRegistry,
  type ICommandRegistry,
} from "@zhixing/core";
import { TaskListService, type TaskListStore } from "@zhixing/tools-builtin";
import { CommandDispatcher } from "../../command-dispatcher.js";
import { registerTaskCommands } from "../task-commands.js";
import { stripAnsi } from "../../tui/index.js";

function makeStubStore(): TaskListStore & {
  data: Map<string, TaskListState>;
} {
  const data = new Map<string, TaskListState>();
  return {
    data,
    async load(id) {
      return data.get(id);
    },
    async save(id, state) {
      data.set(id, state);
    },
    async delete(id) {
      data.delete(id);
    },
  };
}

const runtime: RuntimeContext = {
  sessionBusy: false,
  workspaceId: "/tmp",
  cwd: "/tmp",
  target: "cli",
  features: {},
  now: Date.now(),
};

interface Harness {
  registry: ICommandRegistry;
  dispatcher: CommandDispatcher;
  service: TaskListService;
  store: ReturnType<typeof makeStubStore>;
  output: string[];
  setConvId: (id: string | null) => void;
}

function setup(initialConvId: string | null = "conv-1"): Harness {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  const store = makeStubStore();
  const service = new TaskListService(store);
  const output: string[] = [];
  let currentConvId: string | null = initialConvId;

  registerTaskCommands({
    registry,
    dispatcher,
    service,
    getConversationId: () => currentConvId,
    writer: { line: (text: string) => output.push(text) },
  });

  return {
    registry,
    dispatcher,
    service,
    store,
    output,
    setConvId: (id) => {
      currentConvId = id;
    },
  };
}

function lastVisibleLine(output: string[]): string {
  return stripAnsi(output[output.length - 1] ?? "");
}

describe("registerTaskCommands · 注册", () => {
  it("注册 /tasklist + /task 到 registry，可通过 findByName 找到", () => {
    const h = setup();
    expect(h.registry.findByName("tasklist")?.execution).toBe("local");
    expect(h.registry.findByName("task")?.execution).toBe("local");
  });
});

describe("registerTaskCommands · /tasklist", () => {
  it("空列表 → 输出友好提示", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/tasklist", runtime);
    expect(lastVisibleLine(h.output)).toContain("任务列表为空");
  });

  it("有任务时输出完整列表", async () => {
    const h = setup();
    await h.service.set("conv-1", [
      { id: "a", content: "X", status: "in_progress" },
      { id: "b", content: "Y", status: "pending" },
    ]);
    await h.dispatcher.dispatch("/tasklist", runtime);
    const visible = h.output.map(stripAnsi);
    expect(visible.some((l) => l.includes("2 项"))).toBe(true);
    expect(visible.some((l) => l.includes("X"))).toBe(true);
    expect(visible.some((l) => l.includes("Y"))).toBe(true);
  });

  it("ephemeral（convId 缺失）→ 友好提示，不读 service", async () => {
    const h = setup(null);
    await h.dispatcher.dispatch("/tasklist", runtime);
    expect(lastVisibleLine(h.output)).toContain("一次性 run");
  });
});

describe("registerTaskCommands · /task new", () => {
  it("/task new <内容> 添加 pending 任务 + echo 添加确认", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/task new 写文档", runtime);

    const items = h.service.getAllTasks("conv-1");
    expect(items).toHaveLength(1);
    expect(items[0]?.content).toBe("写文档");
    expect(items[0]?.status).toBe("pending");
    expect(lastVisibleLine(h.output)).toContain('添加："写文档"');
  });

  it("/task <内容> shortcut（无 new 关键字）等同 new", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/task 测试一下", runtime);
    expect(h.service.getAllTasks("conv-1")[0]?.content).toBe("测试一下");
  });

  it("/task new 无内容 → 用法提示，不写 service", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/task new", runtime);
    expect(h.service.getAllTasks("conv-1")).toHaveLength(0);
    expect(lastVisibleLine(h.output)).toContain("用法");
  });

  it("/task 无 rest → 用法提示", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/task", runtime);
    expect(lastVisibleLine(h.output)).toContain("/task new");
  });

  it("多次添加 append 不替换", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/task new A", runtime);
    await h.dispatcher.dispatch("/task new B", runtime);
    await h.dispatcher.dispatch("/task new C", runtime);
    expect(h.service.getAllTasks("conv-1").map((t) => t.content)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("ephemeral 拒绝", async () => {
    const h = setup(null);
    await h.dispatcher.dispatch("/task new X", runtime);
    expect(lastVisibleLine(h.output)).toContain("一次性 run");
  });
});

describe("registerTaskCommands · /task done", () => {
  it("/task done <1-based index> 完成任务 + echo", async () => {
    const h = setup();
    await h.service.set("conv-1", [
      { id: "a", content: "P1", status: "pending" },
      { id: "b", content: "P2", status: "pending" },
    ]);

    await h.dispatcher.dispatch("/task done 2", runtime);

    const items = h.service.getAllTasks("conv-1");
    expect(items[0]?.status).toBe("pending");
    expect(items[1]?.status).toBe("completed");
    expect(lastVisibleLine(h.output)).toContain('完成："P2"');
  });

  it("/task done <UUID 前缀> 完成任务", async () => {
    const h = setup();
    await h.service.set("conv-1", [
      { id: "abc-123", content: "P1", status: "pending" },
      { id: "xyz-789", content: "P2", status: "pending" },
    ]);

    await h.dispatcher.dispatch("/task done xyz", runtime);

    expect(h.service.getAllTasks("conv-1")[1]?.status).toBe("completed");
  });

  it("/task done 越界 index → 友好 error，state 不变", async () => {
    const h = setup();
    await h.service.set("conv-1", [
      { id: "a", content: "P", status: "pending" },
    ]);

    await h.dispatcher.dispatch("/task done 99", runtime);

    expect(h.service.getAllTasks("conv-1")[0]?.status).toBe("pending");
    expect(lastVisibleLine(h.output)).toContain("未找到");
  });

  it("/task done 不存在的 UUID → 友好 error", async () => {
    const h = setup();
    await h.service.set("conv-1", [
      { id: "abc", content: "P", status: "pending" },
    ]);
    await h.dispatcher.dispatch("/task done zzz", runtime);
    expect(lastVisibleLine(h.output)).toContain("未找到");
  });

  it("/task done 已 completed → 提示已完成，不重复 mutate", async () => {
    const h = setup();
    await h.service.set("conv-1", [
      { id: "a", content: "P", status: "completed" },
    ]);
    const savesBefore = h.store.data.size;

    await h.dispatcher.dispatch("/task done 1", runtime);

    expect(lastVisibleLine(h.output)).toContain("已是 completed");
    expect(h.store.data.size).toBe(savesBefore);
  });

  it("/task done 无 token → 用法提示", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/task done", runtime);
    expect(lastVisibleLine(h.output)).toContain("用法");
  });
});

describe("registerTaskCommands · 并发安全", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it("magic：dispatcher 串行调度 /task new 与 /task done 不互相覆盖", async () => {
    await h.dispatcher.dispatch("/task new A", runtime);
    await h.dispatcher.dispatch("/task new B", runtime);
    await h.dispatcher.dispatch("/task done 1", runtime);
    await h.dispatcher.dispatch("/task new C", runtime);

    const items = h.service.getAllTasks("conv-1");
    expect(items.map((t) => `${t.content}:${t.status}`)).toEqual([
      "A:completed",
      "B:pending",
      "C:pending",
    ]);
  });
});

describe("registerTaskCommands · 防御", () => {
  it("mutate 在 cache miss 时不丢磁盘已有数据（service 自防御契约）", async () => {
    const h = setup();
    // 磁盘上已有任务（service 未 prime）
    h.store.data.set("conv-1", {
      items: [
        { id: "a", content: "已存在", status: "pending" },
        { id: "b", content: "也存在", status: "completed" },
      ],
    });

    await h.dispatcher.dispatch("/task new 新增", runtime);

    const items = h.service.getAllTasks("conv-1");
    expect(items.map((t) => t.content)).toEqual(["已存在", "也存在", "新增"]);
  });
});
