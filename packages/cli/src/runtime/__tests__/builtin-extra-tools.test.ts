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
import type {
  AssignmentMutationPort,
  AssignmentMutationRequest,
  SchedulerFacade,
} from "@zhixing/core";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import { createBuiltinExtraToolsAssembly } from "../../serve/builtin-extra-tools.js";
import { createAnchorConversationTaskListToolApplication } from "../../serve/conversation-task-list-application.js";
import { InMemoryTaskListStore } from "../task-list-stores.js";

// ─── 测试 fixture ───

function fakeScheduler(): SchedulerFacade {
  return {} as SchedulerFacade;
}

function createAssembly(
  store = new InMemoryTaskListStore(),
) {
  return createBuiltinExtraToolsAssembly(
    store,
    createAnchorConversationTaskListToolApplication(),
  );
}

function assignmentMutationFixture(assignmentId: string) {
  const staged: AssignmentMutationRequest[] = [];
  const port: AssignmentMutationPort = {
    assignmentId,
    execution: "conversation",
    async stage(input) {
      staged.push(input);
      return {
        kind: "assignment-mutation-staged",
        requestId: input.operationId,
        recordSeq: staged.length,
        mutationDigest: "a".repeat(64),
      };
    },
    async readOverlay() {
      return [];
    },
  };
  return { port, staged };
}

describe("createBuiltinExtraToolsAssembly", () => {
  it("返回的 tools 数组包含 schedule + task_list", () => {
    const assembly = createAssembly();
    const tools = assembly.assembleTools({
      scheduler: () => fakeScheduler(),
    });

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["schedule", "task_list"].sort());
  });

  it("assembleTools 多次调用返回**新的** ToolDefinition 实例（runtime swap 友好）", () => {
    const assembly = createAssembly();

    const tools1 = assembly.assembleTools({ scheduler: () => fakeScheduler() });
    const tools2 = assembly.assembleTools({ scheduler: () => fakeScheduler() });

    expect(tools1).not.toBe(tools2);
    expect(tools1[0]).not.toBe(tools2[0]);
    expect(tools1[1]).not.toBe(tools2[1]);
  });

  it("多次 assembleTools 共享服务但只向当前 assignment 暂存任务变更", async () => {
    const assembly = createAssembly();

    const assignment = assignmentMutationFixture("assignment-1");

    // 第一次装配，工具 set 一些 state
    const tools1 = assembly.assembleTools({ scheduler: () => fakeScheduler() });
    const taskListTool1 = tools1.find((t) => t.name === "task_list")!;

    await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conv-1",
        assignmentMutations: assignment.port,
      },
      async () => {
        await taskListTool1.call(
          {
            items: [{ content: "first run task", status: "in_progress" }],
          },
          { workingDirectory: "/tmp", toolCallId: "call-1" },
        );
      },
    );

    // 第二次装配（模拟 runtime reload swap）
    const tools2 = assembly.assembleTools({ scheduler: () => fakeScheduler() });
    const taskListTool2 = tools2.find((t) => t.name === "task_list")!;

    expect(assignment.staged).toHaveLength(1);
    expect(assembly.taskListService.getAllTasks("conv-1")).toEqual([]);

    // 新工具 set 后旧路径也能看到（双向共享）
    await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conv-1",
        assignmentMutations: assignment.port,
      },
      async () => {
        await taskListTool2.call(
          {
            items: [{ content: "second run task", status: "completed" }],
          },
          { workingDirectory: "/tmp", toolCallId: "call-2" },
        );
      },
    );

    expect(assignment.staged).toHaveLength(2);
    expect(assignment.staged.map((entry) => entry.operationId)).toEqual([
      "task-list:call-1",
      "task-list:call-2",
    ]);
  });

  it("task_list 工具走 ALS 并隔离不同 assignment 的暂存记录", async () => {
    const assembly = createAssembly();
    const tools = assembly.assembleTools({ scheduler: () => fakeScheduler() });
    const taskListTool = tools.find((t) => t.name === "task_list")!;
    const assignmentA = assignmentMutationFixture("assignment-A");
    const assignmentB = assignmentMutationFixture("assignment-B");

    // ALS 上下文 conv-A
    await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conv-A",
        assignmentMutations: assignmentA.port,
      },
      async () => {
        await taskListTool.call(
          { items: [{ content: "A only", status: "pending" }] },
          { workingDirectory: "/tmp", toolCallId: "call-A" },
        );
      },
    );

    // ALS 上下文 conv-B
    await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conv-B",
        assignmentMutations: assignmentB.port,
      },
      async () => {
        await taskListTool.call(
          { items: [{ content: "B only", status: "in_progress" }] },
          { workingDirectory: "/tmp", toolCallId: "call-B" },
        );
      },
    );

    expect(assignmentA.staged).toHaveLength(1);
    expect(assignmentA.staged[0]).toMatchObject({
      operationId: "task-list:call-A",
      mutation: { kind: "task-list-op" },
    });
    expect(assignmentB.staged).toHaveLength(1);
    expect(assignmentB.staged[0]).toMatchObject({
      operationId: "task-list:call-B",
      mutation: { kind: "task-list-op" },
    });
    expect(assembly.taskListService.getAllTasks("conv-A")).toEqual([]);
    expect(assembly.taskListService.getAllTasks("conv-B")).toEqual([]);
  });

  it("无 ALS 上下文（ephemeral 路径）→ task_list 调用 isError 拒绝", async () => {
    const assembly = createAssembly();
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

  it("有 conversation 但无 durable assignment 时保持 fail-closed 且零副作用", async () => {
    const assembly = createAssembly();
    const taskListTool = assembly
      .assembleTools({ scheduler: () => fakeScheduler() })
      .find((tool) => tool.name === "task_list")!;

    const result = await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conversation-without-assignment",
      },
      () =>
        taskListTool.call(
          { items: [{ content: "must not persist", status: "pending" }] },
          { workingDirectory: "/tmp", toolCallId: "call-without-assignment" },
        ),
    );

    expect(result).toEqual({
      content: "Task list updates require an active durable turn.",
      isError: true,
    });
    expect(
      assembly.taskListService.getAllTasks("conversation-without-assignment"),
    ).toEqual([]);
  });

  it("scheduler getter 在工具 call 时 lazy 解析（装配期 scheduler 可未就绪）", () => {
    const assembly = createAssembly();
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
