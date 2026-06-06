/**
 * schedule 工具 — create 行为测试（ADR-007 Phase 3 之后）
 *
 * 架构演化：Phase 2 时 schedule 主动调 commitToUser 抑制 LLM 叙述。
 * Phase 3 上线后，slot 结构性保证顺序，commitment 机制变为冗余——
 * schedule 不再主动 commit，由 LLM 根据 ToolResult 自然叙述。
 *
 * 覆盖：
 * 1. create 成功 → 返回 formatTask 内容，不设 committedToUser
 * 2. 即使 ctx.commitToUser 存在也不被调用（架构决策保证，防退化）
 * 3. P3c：ctx.turnId 捕获到 task.createdInTurn
 */

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import {
  createEventBus,
  JsonTaskStore,
  Scheduler,
  LocalSchedulerFacade,
  type SchedulerEventMap,
  type SchedulerFacade,
  type ToolExecutionContext,
} from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import { createScheduleTool } from "../schedule.js";

// ─── 测试工具 ───

async function withScheduler<T>(
  fn: (scheduler: Scheduler, facade: SchedulerFacade, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await createTempDir("sched");
  const eventBus = createEventBus<SchedulerEventMap>();
  const scheduler = new Scheduler({
    store: new JsonTaskStore(join(dir, "tasks.json")),
    eventBus,
    runAgentTurn: async () => ({ status: "ok", durationMs: 0 }),
    systemHandlers: new Map(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  });
  await scheduler.start();
  const facade = new LocalSchedulerFacade(scheduler, eventBus);
  try {
    return await fn(scheduler, facade, dir);
  } finally {
    await scheduler.stop();
  }
}

function baseContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    workingDirectory: "/tmp",
    ...overrides,
  };
}

function onceInput(overrides?: Record<string, unknown>) {
  return {
    action: "create",
    name: "test-reminder",
    prompt: "提醒我喝水",
    schedule_kind: "once",
    schedule_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

// ─── 核心测试 ───

describe("schedule tool — create behavior (post ADR-007 Phase 3)", () => {
  it("create 成功 → 返回 formatTask 内容，不设 committedToUser", async () => {
    await withScheduler(async (scheduler, facade) => {
      const tool = createScheduleTool(() => facade);
      const result = await tool.call(onceInput(), baseContext());

      expect(result.isError).toBeFalsy();
      expect(result.committedToUser).toBeUndefined();
      expect(result.content).toContain("Task created successfully");
    });
  });

  it("架构回归：即使 ctx.commitToUser 存在，schedule 也不调用它", async () => {
    // Phase 3 slot 已结构性保证 task fire 排在 LLM 回复之后——commitment 冗余。
    // 本测试防止未来误加 commit 调用回归（再次引入重复消息）。
    await withScheduler(async (scheduler, facade) => {
      const commitToUser = vi.fn(async () => ({ success: true, retryable: false }));
      const tool = createScheduleTool(() => facade);
      const result = await tool.call(
        onceInput({ name: "晨间会议" }),
        baseContext({ commitToUser }),
      );

      expect(result.isError).toBeFalsy();
      expect(result.committedToUser).toBeUndefined();
      expect(commitToUser).not.toHaveBeenCalled();
      // content 走正常叙述路径，LLM 据此告知用户
      expect(result.content).toContain("Task created successfully");
      expect(result.content).toContain("晨间会议");
    });
  });

  it("create 参数不全 → 返回 isError，不创建 task", async () => {
    await withScheduler(async (scheduler, facade) => {
      const tool = createScheduleTool(() => facade);
      const result = await tool.call(
        { action: "create", name: "bad" /* 缺少 prompt/schedule_kind */ },
        baseContext(),
      );

      expect(result.isError).toBe(true);
      expect(scheduler.listTasks()).toHaveLength(0);
    });
  });

  // ─── P3c: createdInTurn 捕获（ADR-007 Phase 3） ───

  it("P3c: ctx.turnId 存在 → task.createdInTurn 被设为该值", async () => {
    await withScheduler(async (scheduler, facade) => {
      const tool = createScheduleTool(() => facade);
      const result = await tool.call(
        onceInput({ name: "t-with-turn" }),
        baseContext({ turnId: "turn_abc" }),
      );

      expect(result.isError).toBeFalsy();
      const tasks = scheduler.listTasks();
      const created = tasks.find((t) => t.name === "t-with-turn");
      expect(created).toBeDefined();
      expect(created?.createdInTurn).toBe("turn_abc");
    });
  });

  it("P3c: 无 ctx.turnId（REPL/ephemeral）→ task.createdInTurn undefined", async () => {
    await withScheduler(async (scheduler, facade) => {
      const tool = createScheduleTool(() => facade);
      const result = await tool.call(
        onceInput({ name: "t-no-turn" }),
        baseContext(),
      );

      expect(result.isError).toBeFalsy();
      const tasks = scheduler.listTasks();
      const created = tasks.find((t) => t.name === "t-no-turn");
      expect(created?.createdInTurn).toBeUndefined();
    });
  });

  // ─── origin 透传（channel 任务投递回源链） ───
  // daemon 内会话执行面经 LocalSchedulerFacade 创建任务时，getOrigin 提供的来源会话
  // （飞书等 channel）须落到 task.origin —— task fire 后据此自动投递回创建它的会话。
  // 与 createdInTurn 对称：两者都只在 channel 会话产生、REPL/ephemeral 为 undefined。

  it("getOrigin 提供 origin → task.origin 落库（channel 投递回源关键路径）", async () => {
    await withScheduler(async (scheduler, facade) => {
      const origin = { channelId: "feishu", to: "ou_xxx" };
      const tool = createScheduleTool(
        () => facade,
        () => origin,
      );
      const result = await tool.call(
        onceInput({ name: "t-with-origin" }),
        baseContext(),
      );

      expect(result.isError).toBeFalsy();
      const created = scheduler
        .listTasks()
        .find((t) => t.name === "t-with-origin");
      expect(created?.origin).toEqual(origin);
    });
  });

  it("无 getOrigin（REPL/ephemeral）→ task.origin undefined", async () => {
    await withScheduler(async (scheduler, facade) => {
      const tool = createScheduleTool(() => facade);
      const result = await tool.call(
        onceInput({ name: "t-no-origin" }),
        baseContext(),
      );

      expect(result.isError).toBeFalsy();
      const created = scheduler
        .listTasks()
        .find((t) => t.name === "t-no-origin");
      expect(created?.origin).toBeUndefined();
    });
  });
});
