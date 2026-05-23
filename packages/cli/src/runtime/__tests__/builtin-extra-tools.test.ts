/**
 * createBuiltinExtraToolsAssembly 集成测试
 *
 * 验证 assembly 装配契约：
 *   - 返回的 tools 数组包含 schedule + task_list
 *   - 同一 assembly 多次 assembleTools() 返回新 ToolDefinition 实例，但共享 service
 *   - task_list 工具与 assembly.taskListService 共享 cache（同一 conversationId 状态可见）
 *   - scheduler getter 在调用时 lazy 解析（支持装配期 scheduler 未就绪）
 */

import { describe, it, expect, vi } from "vitest";
import { Scheduler } from "@zhixing/core";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import { createMcpHub, type McpHub } from "@zhixing/mcp";
import { createBuiltinExtraToolsAssembly } from "../builtin-extra-tools.js";
import { InMemoryTaskListStore } from "../task-list-stores.js";
import type { IWorkModeController } from "../work-mode-controller.js";

// ─── 测试 fixture ───

function fakeScheduler(): Scheduler {
  return {} as Scheduler;
}

// 工厂仅在构造期 capture controller、call 体才用方法，故名集合断言用空桩足够。
const fakeController = {} as IWorkModeController;

describe("createBuiltinExtraToolsAssembly", () => {
  it("返回的 tools 数组包含 schedule + task_list", () => {
    const assembly = createBuiltinExtraToolsAssembly(new InMemoryTaskListStore(), createMcpHub([]));
    const tools = assembly.assembleTools({
      scheduler: () => fakeScheduler(),
    });

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["schedule", "task_list"].sort());
  });

  it("MCP 工具经 hub.catalog 物化注入 extraTools", () => {
    const fakeHub: McpHub = {
      connectAll: async () => {},
      catalog: () => [
        {
          server: { serverId: "demo", transport: "stdio" },
          tools: [{ name: "echo", inputSchema: { type: "object" } }],
        },
      ],
      callTool: async () => ({ content: "" }),
      dispose: async () => {},
    };
    const assembly = createBuiltinExtraToolsAssembly(
      new InMemoryTaskListStore(),
      fakeHub,
    );

    const tools = assembly.assembleTools({ scheduler: () => fakeScheduler() });
    expect(tools.map((t) => t.name)).toContain("mcp__demo__echo");
  });

  it("assembleTools 多次调用返回**新的** ToolDefinition 实例（runtime swap 友好）", () => {
    const assembly = createBuiltinExtraToolsAssembly(new InMemoryTaskListStore(), createMcpHub([]));

    const tools1 = assembly.assembleTools({ scheduler: () => fakeScheduler() });
    const tools2 = assembly.assembleTools({ scheduler: () => fakeScheduler() });

    expect(tools1).not.toBe(tools2);
    expect(tools1[0]).not.toBe(tools2[0]);
    expect(tools1[1]).not.toBe(tools2[1]);
  });

  it("多次 assembleTools 共享同一 TaskListService —— state 跨 runtime 持续", async () => {
    const assembly = createBuiltinExtraToolsAssembly(new InMemoryTaskListStore(), createMcpHub([]));

    // 第一次装配，工具 set 一些 state
    const tools1 = assembly.assembleTools({ scheduler: () => fakeScheduler() });
    const taskListTool1 = tools1.find((t) => t.name === "task_list")!;

    await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conv-1",
      },
      async () => {
        await taskListTool1.call(
          {
            items: [{ content: "first run task", status: "in_progress" }],
          },
          { workingDirectory: "/tmp" },
        );
      },
    );

    // 第二次装配（模拟 runtime reload swap）
    const tools2 = assembly.assembleTools({ scheduler: () => fakeScheduler() });
    const taskListTool2 = tools2.find((t) => t.name === "task_list")!;

    // 新工具实例仍能看到旧工具 set 的 state（共享 service.cache）
    expect(assembly.taskListService.getInProgressTasks("conv-1")).toHaveLength(1);
    expect(assembly.taskListService.getInProgressTasks("conv-1")[0]?.content).toBe(
      "first run task",
    );

    // 新工具 set 后旧路径也能看到（双向共享）
    await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conv-1",
      },
      async () => {
        await taskListTool2.call(
          {
            items: [{ content: "second run task", status: "completed" }],
          },
          { workingDirectory: "/tmp" },
        );
      },
    );

    expect(assembly.taskListService.getAllTasks("conv-1")).toHaveLength(1);
    expect(assembly.taskListService.getAllTasks("conv-1")[0]?.content).toBe(
      "second run task",
    );
  });

  it("task_list 工具走 ALS 取 conversationId —— runtime.run 入口 conversationId 注入透传", async () => {
    const assembly = createBuiltinExtraToolsAssembly(new InMemoryTaskListStore(), createMcpHub([]));
    const tools = assembly.assembleTools({ scheduler: () => fakeScheduler() });
    const taskListTool = tools.find((t) => t.name === "task_list")!;

    // ALS 上下文 conv-A
    await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conv-A",
      },
      async () => {
        await taskListTool.call(
          { items: [{ content: "A only", status: "pending" }] },
          { workingDirectory: "/tmp" },
        );
      },
    );

    // ALS 上下文 conv-B
    await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conv-B",
      },
      async () => {
        await taskListTool.call(
          { items: [{ content: "B only", status: "in_progress" }] },
          { workingDirectory: "/tmp" },
        );
      },
    );

    // 两个 conversation 各自独立的 state
    expect(assembly.taskListService.getAllTasks("conv-A")[0]?.content).toBe("A only");
    expect(assembly.taskListService.getAllTasks("conv-B")[0]?.content).toBe("B only");
    expect(assembly.taskListService.getInProgressTasks("conv-A")).toHaveLength(0);
    expect(assembly.taskListService.getInProgressTasks("conv-B")).toHaveLength(1);
  });

  it("无 ALS 上下文（ephemeral 路径）→ task_list 调用 isError 拒绝", async () => {
    const assembly = createBuiltinExtraToolsAssembly(new InMemoryTaskListStore(), createMcpHub([]));
    const tools = assembly.assembleTools({ scheduler: () => fakeScheduler() });
    const taskListTool = tools.find((t) => t.name === "task_list")!;

    // 不包 runContextStorage.run —— ALS 为空
    const result = await taskListTool.call(
      { items: [{ content: "ephemeral attempt", status: "pending" }] },
      { workingDirectory: "/tmp" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no conversation");
    expect(assembly.taskListService.getAllTasks("anything")).toEqual([]);
  });

  it("spec=main → 追加 main 组 workmode 工具，by-construction 不含 power-only", () => {
    const assembly = createBuiltinExtraToolsAssembly(new InMemoryTaskListStore(), createMcpHub([]));
    const names = assembly
      .assembleTools({
        scheduler: () => fakeScheduler(),
        spec: { kind: "main" },
        workModeController: () => fakeController,
      })
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      [
        "schedule",
        "task_list",
        "workmode_enter",
        "workscene_change_approve",
        "workscene_memory_query",
      ].sort(),
    );
    expect(names).not.toContain("workmode_exit");
  });

  it("spec=workscene → 仅追加 power-only workmode_exit，物理隔离 main-only 工具", () => {
    const assembly = createBuiltinExtraToolsAssembly(new InMemoryTaskListStore(), createMcpHub([]));
    const names = assembly
      .assembleTools({
        scheduler: () => fakeScheduler(),
        spec: { kind: "workscene" },
        workModeController: () => fakeController,
      })
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["schedule", "task_list", "workmode_exit"].sort());
    for (const mainOnly of [
      "workmode_enter",
      "workscene_change_approve",
      "workscene_memory_query",
    ]) {
      expect(names).not.toContain(mainOnly);
    }
  });

  it("无 workModeController（serve 等）→ 不追加任何 workmode 工具", () => {
    const assembly = createBuiltinExtraToolsAssembly(new InMemoryTaskListStore(), createMcpHub([]));
    const names = assembly
      .assembleTools({
        scheduler: () => fakeScheduler(),
        spec: { kind: "main" },
      })
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["schedule", "task_list"].sort());
  });

  it("scheduler getter 在工具 call 时 lazy 解析（装配期 scheduler 可未就绪）", () => {
    const assembly = createBuiltinExtraToolsAssembly(new InMemoryTaskListStore(), createMcpHub([]));
    let scheduler: Scheduler | null = null;
    const getter = vi.fn(() => {
      if (!scheduler) throw new Error("not ready");
      return scheduler;
    });

    // assembleTools 不应立即调 scheduler getter
    const tools = assembly.assembleTools({ scheduler: getter });
    expect(getter).not.toHaveBeenCalled();

    // 装配完之后 scheduler 才就绪 —— 工具 call 时才会真正调 getter
    scheduler = {} as Scheduler;
    expect(tools.some((t) => t.name === "schedule")).toBe(true);
  });
});
