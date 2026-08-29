/**
 * cli builtin TurnContextProvider 装配 helper 测试
 *
 * 契约覆盖：
 *   - createCliTurnContextProviders 构造 frozen SchedulerProvider + TaskListProvider 集合
 *   - 装配顺序稳定（先 scheduler 后 task_list，与 turn-context 输出顺序对齐）
 *   - SchedulerProvider closure 通过 deps.getSchedulerStatus 取数
 *   - TaskListProvider closure 通过 ALS 取 conversationId + service.getAllTasks 取 items
 *   - ephemeral 路径（ALS 无 conversationId）下 task_list getItems 返空数组（自然降级）
 *   - EMPTY_TASK_STATUS_SUMMARY 常量结构正确
 */

import { describe, it, expect, vi } from "vitest";
import {
  SchedulerProvider,
  TaskListProvider,
  type TaskStatusSummary,
} from "@zhixing/core";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import { TaskListService } from "@zhixing/tools-builtin";
import { InMemoryTaskListStore } from "../task-list-stores.js";
import {
  EMPTY_TASK_STATUS_SUMMARY,
  createCliTurnContextProviders,
} from "../turn-context-providers.js";

// ─── EMPTY_TASK_STATUS_SUMMARY 常量 ───

describe("EMPTY_TASK_STATUS_SUMMARY", () => {
  it("符合 TaskStatusSummary 结构（三个空数组）", () => {
    expect(EMPTY_TASK_STATUS_SUMMARY).toEqual({
      active: [],
      recentlyCompleted: [],
      recentlyFailed: [],
    });
  });

  it("deep frozen —— 顶层对象 + 三个内层数组均不可变（防 footgun）", () => {
    expect(Object.isFrozen(EMPTY_TASK_STATUS_SUMMARY)).toBe(true);
    expect(Object.isFrozen(EMPTY_TASK_STATUS_SUMMARY.active)).toBe(true);
    expect(Object.isFrozen(EMPTY_TASK_STATUS_SUMMARY.recentlyCompleted)).toBe(true);
    expect(Object.isFrozen(EMPTY_TASK_STATUS_SUMMARY.recentlyFailed)).toBe(true);
  });

  it("mutate 尝试在严格模式下 throw", () => {
    // 测试文件是 ES module —— 默认 strict mode
    expect(() => {
      (EMPTY_TASK_STATUS_SUMMARY.active as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (EMPTY_TASK_STATUS_SUMMARY as unknown as Record<string, unknown>).newField = 1;
    }).toThrow();
  });
});

// ─── createCliTurnContextProviders 装配契约 ───

describe("createCliTurnContextProviders — 装配契约", () => {
  function makeDeps(overrides?: {
    getSchedulerStatus?: () => TaskStatusSummary;
    taskListService?: TaskListService;
  }) {
    return {
      getSchedulerStatus:
        overrides?.getSchedulerStatus ?? (() => EMPTY_TASK_STATUS_SUMMARY),
      taskListService:
        overrides?.taskListService ??
        new TaskListService(new InMemoryTaskListStore()),
    };
  }

  it("创建 frozen SchedulerProvider + TaskListProvider exact-set", () => {
    const providers = createCliTurnContextProviders(makeDeps());

    expect(Object.isFrozen(providers)).toBe(true);
    expect(providers).toHaveLength(2);
    expect(providers[0]).toBeInstanceOf(SchedulerProvider);
    expect(providers[1]).toBeInstanceOf(TaskListProvider);
  });

  it("装配顺序稳定（先 scheduler 后 task_list）", () => {
    const providers = createCliTurnContextProviders(makeDeps());

    expect(providers[0]?.id).toBe("scheduler");
    expect(providers[1]?.id).toBe("task-list");
  });

  it("SchedulerProvider closure 调 deps.getSchedulerStatus 取数", () => {
    const getSchedulerStatus = vi.fn(() => ({
      active: [{ name: "test-task", schedule: "cron 0 0 * * *" }],
      recentlyCompleted: [],
      recentlyFailed: [],
    }));
    const providers = createCliTurnContextProviders(makeDeps({ getSchedulerStatus }));

    const schedProvider = providers[0]!;
    // SchedulerProvider 通过 shouldInject 触发 getStatus 调用
    expect(schedProvider.shouldInject()).toBe(true);
    expect(getSchedulerStatus).toHaveBeenCalled();

    const section = schedProvider.render();
    expect(section.body).toContain("test-task");
  });

  it("TaskListProvider closure 通过 ALS 取 conversationId + service 取 items", async () => {
    const service = new TaskListService(new InMemoryTaskListStore());
    await service.set("conv-1", [
      { id: "t1", content: "持久会话任务", status: "in_progress" },
    ]);

    const providers = createCliTurnContextProviders(
      makeDeps({ taskListService: service }),
    );
    const taskListProvider = providers[1]!;

    // ALS 中含 conversationId → provider 看到 items
    await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conv-1",
      },
      async () => {
        expect(taskListProvider.shouldInject()).toBe(true);
        const section = taskListProvider.render();
        expect(section.body).toContain("[~] 持久会话任务");
      },
    );
  });

  it("TaskListProvider 在 ALS 无 conversationId 时返空数组 → shouldInject false", async () => {
    const service = new TaskListService(new InMemoryTaskListStore());
    // 预先 set 一份 state，验证 ALS 缺失时仍不读
    await service.set("conv-X", [
      { id: "t", content: "should not show", status: "pending" },
    ]);

    const providers = createCliTurnContextProviders(
      makeDeps({ taskListService: service }),
    );
    const taskListProvider = providers[1]!;

    // 不包 runContextStorage.run —— ALS 为空
    expect(taskListProvider.shouldInject()).toBe(false);

    // 即使 ALS 中有 lineage 但 conversationId 缺失也应返 false
    await runContextStorage.run(
      { bus: {} as never, lineage: "main" },
      async () => {
        expect(taskListProvider.shouldInject()).toBe(false);
      },
    );
  });

  it("TaskListProvider 在 ALS 含 conversationId 但 service cache miss → shouldInject false", async () => {
    const service = new TaskListService(new InMemoryTaskListStore());
    // 不 prime / 不 set —— cache 空

    const providers = createCliTurnContextProviders(
      makeDeps({ taskListService: service }),
    );
    const taskListProvider = providers[1]!;

    await runContextStorage.run(
      {
        bus: {} as never,
        lineage: "main",
        conversationId: "conv-never-set",
      },
      async () => {
        expect(taskListProvider.shouldInject()).toBe(false);
      },
    );
  });

  it("跨 conversation 隔离 —— 同一 service 不同 conversationId 看到不同 items", async () => {
    const service = new TaskListService(new InMemoryTaskListStore());
    await service.set("conv-A", [
      { id: "a", content: "A 的任务", status: "in_progress" },
    ]);
    await service.set("conv-B", [
      { id: "b", content: "B 的任务", status: "pending" },
    ]);

    const providers = createCliTurnContextProviders(
      makeDeps({ taskListService: service }),
    );
    const taskListProvider = providers[1]!;

    await runContextStorage.run(
      { bus: {} as never, lineage: "main", conversationId: "conv-A" },
      async () => {
        expect(taskListProvider.render().body).toContain("A 的任务");
        expect(taskListProvider.render().body).not.toContain("B 的任务");
      },
    );

    await runContextStorage.run(
      { bus: {} as never, lineage: "main", conversationId: "conv-B" },
      async () => {
        expect(taskListProvider.render().body).toContain("B 的任务");
        expect(taskListProvider.render().body).not.toContain("A 的任务");
      },
    );
  });

  it("每次发放创建独立 frozen sequence，不共享可变数组或 provider 实例", () => {
    const first = createCliTurnContextProviders(makeDeps());
    const second = createCliTurnContextProviders(makeDeps());

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[1]).not.toBe(second[1]);
    expect(() => {
      (first as unknown as unknown[]).push({});
    }).toThrow();
  });
});
