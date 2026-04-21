/**
 * schedule 工具 — commit-on-create 行为测试（ADR-007 Phase 2）
 *
 * 覆盖三条路径：
 * 1. 有 commitToUser（channel 场景）→ commit 发送 + committedToUser=true
 * 2. 无 commitToUser（REPL / ephemeral）→ 原叙述路径，无 committedToUser
 * 3. commit 抛异常 → 降级为叙述路径，task 已落地不影响
 */

import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createEventBus,
  JsonTaskStore,
  Scheduler,
  type SchedulerEventMap,
  type ToolExecutionContext,
  type OutboundContent,
} from "@zhixing/core";
import { createScheduleTool } from "../schedule.js";

// ─── 测试工具 ───

async function withScheduler<T>(
  fn: (scheduler: Scheduler, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sched-test-"));
  const scheduler = new Scheduler({
    store: new JsonTaskStore(join(dir, "tasks.json")),
    eventBus: createEventBus<SchedulerEventMap>(),
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
  try {
    return await fn(scheduler, dir);
  } finally {
    await scheduler.stop();
    await rm(dir, { recursive: true, force: true });
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

describe("schedule tool — commit-on-create (ADR-007 Phase 2)", () => {
  it("ctx.commitToUser 存在 → 调用 + 结果含 committedToUser=true", async () => {
    await withScheduler(async (scheduler) => {
      const commits: OutboundContent[] = [];
      const commitToUser = vi.fn(async (content: OutboundContent) => {
        commits.push(content);
        return { success: true, retryable: false };
      });

      const tool = createScheduleTool(scheduler);
      const result = await tool.call(
        onceInput({ name: "晨间会议" }),
        baseContext({ commitToUser }),
      );

      expect(result.isError).toBeFalsy();
      expect(result.committedToUser).toBe(true);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.text).toContain("⏰");
      expect(commits[0]!.text).toContain("晨间会议");
    });
  });

  it("无 ctx.commitToUser（REPL / ephemeral）→ 不触发 commit，无 committedToUser 标记", async () => {
    await withScheduler(async (scheduler) => {
      const tool = createScheduleTool(scheduler);
      const result = await tool.call(onceInput(), baseContext());

      expect(result.isError).toBeFalsy();
      expect(result.committedToUser).toBeUndefined();
      // content 走原路径（formatTask 输出）
      expect(result.content).toContain("Task created successfully");
    });
  });

  it("commitToUser 抛异常 → 降级到原叙述路径，不抛给 LLM", async () => {
    await withScheduler(async (scheduler) => {
      const commitToUser = vi.fn(async () => {
        throw new Error("outbox down");
      });

      const tool = createScheduleTool(scheduler);
      const result = await tool.call(
        onceInput(),
        baseContext({ commitToUser }),
      );

      expect(result.isError).toBeFalsy();
      expect(result.committedToUser).toBeUndefined();
      expect(result.content).toContain("Task created successfully");
      expect(commitToUser).toHaveBeenCalledOnce();
    });
  });

  it("commitToUser 返回 success=false（adapter 报失败）→ 降级到叙述路径，不设 committedToUser", async () => {
    // 回归：避免"LLM 不叙述 + commit 未到达" → 用户完全感知不到任务创建
    await withScheduler(async (scheduler) => {
      const commitToUser = vi.fn(async () => ({
        success: false,
        retryable: true,
        error: "rate limited",
      }));

      const tool = createScheduleTool(scheduler);
      const result = await tool.call(
        onceInput(),
        baseContext({ commitToUser }),
      );

      expect(result.isError).toBeFalsy();
      expect(result.committedToUser).toBeUndefined();
      // content 走叙述路径，LLM 有内容可以告诉用户
      expect(result.content).toContain("Task created successfully");
      expect(commitToUser).toHaveBeenCalledOnce();
    });
  });

  it("commitment 文本覆盖 once / interval / cron 三种 schedule", async () => {
    await withScheduler(async (scheduler) => {
      const texts: string[] = [];
      const commitToUser = async (c: OutboundContent) => {
        texts.push(c.text);
        return { success: true, retryable: false };
      };
      const tool = createScheduleTool(scheduler);

      await tool.call(
        onceInput({ name: "once-task" }),
        baseContext({ commitToUser }),
      );
      await tool.call(
        {
          action: "create",
          name: "interval-task",
          prompt: "check",
          schedule_kind: "interval",
          schedule_every_ms: 3_600_000, // 1 小时（>= 60s 最小间隔）
        },
        baseContext({ commitToUser }),
      );
      await tool.call(
        {
          action: "create",
          name: "cron-task",
          prompt: "daily",
          schedule_kind: "cron",
          schedule_cron: "0 8 * * *",
        },
        baseContext({ commitToUser }),
      );

      expect(texts).toHaveLength(3);
      expect(texts[0]).toMatch(/once-task/);
      expect(texts[1]).toMatch(/interval-task.*每/);
      expect(texts[2]).toMatch(/cron-task.*0 8 \* \* \*/);
    });
  });

  it("create 失败时不触发 commit（用户不会收到误导）", async () => {
    await withScheduler(async (scheduler) => {
      const commitToUser = vi.fn(async () => ({
        success: true,
        retryable: false,
      }));

      const tool = createScheduleTool(scheduler);
      const result = await tool.call(
        { action: "create", name: "bad" /* 缺少 prompt/schedule_kind */ },
        baseContext({ commitToUser }),
      );

      expect(result.isError).toBe(true);
      expect(commitToUser).not.toHaveBeenCalled();
    });
  });

  it("commitToUser 签名接受 meta 参数（AgentLoop 层通过此传 toolName）", async () => {
    // 契约测试：工具本身不会 meta，但上游 AgentLoop wrapper 会注入 toolName。
    // 此测试确保 TurnContext.commitToUser 的第二参数协议生效——传入时不报错、不影响工具。
    await withScheduler(async (scheduler) => {
      const metas: Array<{ toolName?: string } | undefined> = [];
      const commitToUser = vi.fn(
        async (_content, meta?: { toolName?: string }) => {
          metas.push(meta);
          return { success: true, retryable: false };
        },
      );

      const tool = createScheduleTool(scheduler);
      // 直接调用模拟已被 wrapper 包过的 commitToUser（wrapper 会在此处自动填 toolName）
      const wrappedCommit = (content: { text: string }) =>
        commitToUser(content, { toolName: tool.name });
      const result = await tool.call(
        onceInput(),
        baseContext({ commitToUser: wrappedCommit }),
      );

      expect(result.committedToUser).toBe(true);
      expect(metas).toHaveLength(1);
      expect(metas[0]).toEqual({ toolName: "schedule" });
    });
  });
});
