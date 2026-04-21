/**
 * Schedule 工具 — AI 可调用的定时任务管理
 *
 * 让 AI 能够为用户创建、查看、修改、删除和手动触发定时任务。
 * 用户用自然语言描述需求，AI 将其转化为 schedule 工具调用。
 *
 * 示例对话：
 * - "每天早上 8 点提醒我喝水" → create, cron "0 8 * * *"
 * - "每 30 分钟检查一下邮件" → create, interval 1800000
 * - "明天下午 3 点提醒我开会" → create, once "2026-04-17T15:00:00"
 * - "看看我有哪些定时任务" → list
 * - "删掉喝水提醒" → delete (by name match)
 *
 * 设计要点：
 * - Scheduler 实例通过闭包注入（不是全局变量）
 * - needsPermission: false — 任务管理不涉及文件系统或外部操作
 * - isReadOnly: false — create/update/delete 会修改持久化状态
 */

import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@zhixing/core";
import type { Scheduler, ScheduledTask, TaskSchedule, TaskPriority } from "@zhixing/core";

/**
 * 创建 schedule 工具。
 *
 * 接受 Scheduler 实例或惰性 getter。惰性模式用于解决
 * CLI 中 session/scheduler 的循环初始化依赖：
 * tool 在 session 创建时注入，scheduler 在 session 之后创建。
 */
export interface ScheduleToolOrigin {
  channelId: string;
  to: string;
}

export function createScheduleTool(
  schedulerOrGetter: Scheduler | (() => Scheduler),
  getOrigin?: () => ScheduleToolOrigin | null,
): ToolDefinition {
  const getScheduler = typeof schedulerOrGetter === "function" && !("createTask" in schedulerOrGetter)
    ? schedulerOrGetter as () => Scheduler
    : () => schedulerOrGetter as Scheduler;
  return {
    name: "schedule",
    description:
      "Manage scheduled tasks. Use this to create, list, update, delete, or manually run tasks. " +
      "Tasks can execute agent prompts on a schedule (once, interval, or cron). " +
      "Examples: daily reminders, periodic checks, one-time future tasks. " +
      "Use 'create' to set up a new task, 'list' to see all tasks, 'run' to execute immediately, " +
      "'update' to modify, 'delete' to remove. " +
      "For cron expressions: '0 8 * * *' = daily 8am, '*/30 * * * *' = every 30 min, '0 9 * * 1' = Mon 9am.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "update", "delete", "run"],
          description: "The action to perform",
        },
        // ─── create 参数 ───
        name: {
          type: "string",
          description: "Task name (required for create)",
        },
        description: {
          type: "string",
          description: "Task description (optional)",
        },
        prompt: {
          type: "string",
          description:
            "The prompt to execute when the task fires (required for create). " +
            "Write a self-contained instruction that produces the desired output directly. " +
            "Good: '向用户发送提醒：时间到了，该开会了！' Bad: '提醒用户开会'",
        },
        schedule_kind: {
          type: "string",
          enum: ["once", "interval", "cron"],
          description:
            "Schedule type: once (single future time, e.g. 'remind me in 5 seconds'), " +
            "interval (repeating, minimum 60s, e.g. 'check every 30 min'), " +
            "cron (cron expression, e.g. 'daily at 8am'). " +
            "IMPORTANT: Use 'once' for one-time reminders/delays, NOT 'interval'.",
        },
        schedule_at: {
          type: "string",
          description: "ISO 8601 datetime for 'once' schedule (e.g. '2026-04-17T15:00:00+08:00')",
        },
        schedule_every_ms: {
          type: "number",
          description: "Interval in milliseconds for 'interval' schedule. Minimum 60000 (60s). Example: 1800000 for 30 min",
        },
        schedule_cron: {
          type: "string",
          description: "Cron expression for 'cron' schedule (e.g. '0 8 * * *' for daily 8am)",
        },
        schedule_tz: {
          type: "string",
          description: "Timezone for cron schedule (e.g. 'Asia/Shanghai'). Default: system timezone",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent"],
          description: "Task priority. Default: normal",
        },
        // ─── update/delete/run 参数 ───
        id: {
          type: "string",
          description: "Task ID (required for update, delete, run)",
        },
        // ─── update 参数 ───
        enabled: {
          type: "boolean",
          description: "Enable or disable a task (for update)",
        },
      },
      required: ["action"],
    },

    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: false,

    async call(input, context): Promise<ToolResult> {
      const action = input.action as string;
      console.log(`[tool:schedule] action=${action}${input.name ? ` name="${input.name}"` : ""}${input.schedule_kind ? ` kind=${input.schedule_kind}` : ""}`);

      try {
        const scheduler = getScheduler();
        switch (action) {
          case "create":
            return await handleCreate(scheduler, input, getOrigin, context);
          case "list":
            return handleList(scheduler);
          case "update":
            return await handleUpdate(scheduler, input);
          case "delete":
            return await handleDelete(scheduler, input);
          case "run":
            return await handleRun(scheduler, input);
          default:
            return { content: `Unknown action: ${action}`, isError: true };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `Error: ${message}`, isError: true };
      }
    },
  };
}

// ─── Action Handlers ───

async function handleCreate(
  scheduler: Scheduler,
  input: Record<string, unknown>,
  getOrigin?: () => ScheduleToolOrigin | null,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  const name = input.name as string;
  const prompt = input.prompt as string;
  const scheduleKind = input.schedule_kind as string;

  if (!name) return { content: "Missing required parameter: name", isError: true };
  if (!prompt) return { content: "Missing required parameter: prompt", isError: true };
  if (!scheduleKind) return { content: "Missing required parameter: schedule_kind", isError: true };

  const schedule = buildSchedule(scheduleKind, input);
  if (!schedule) {
    return { content: `Invalid schedule: missing parameters for kind '${scheduleKind}'`, isError: true };
  }

  const origin = getOrigin?.() ?? undefined;

  // 先落地 task（原子操作）——失败不 commit，避免"用户看到已创建但实际未落地"
  const task = await scheduler.createTask({
    name,
    description: (input.description as string) ?? undefined,
    enabled: true,
    priority: (input.priority as TaskPriority) ?? "normal",
    schedule,
    action: { kind: "agent-turn", prompt },
    origin,
  });

  // Tool-authored commitment（ADR-007 Phase 2）：
  // - 如果上下文提供了 commitToUser（channel 场景），直接向用户发出简短 commitment
  //   并在 ToolResult 标记 committedToUser=true，由系统提示约束 LLM 不再叙述
  // - 无 commitToUser（REPL / 定时任务 ephemeral turn）时降级为原叙述路径
  // - commit 失败（抛异常 或 adapter 返回 success=false）时同样降级为 LLM 叙述，
  //   避免"LLM 不叙述 + commitment 未到达"导致用户完全感知不到任务创建
  if (context?.commitToUser) {
    try {
      const res = await context.commitToUser({ text: buildCommitmentText(task) });
      if (res.success) {
        return {
          content: formatTask(task, "Task created successfully"),
          committedToUser: true,
        };
      }
      console.warn(
        `[tool:schedule] commitToUser returned success=false, fallback to LLM narration: ${
          res.error ?? "(no error)"
        }`,
      );
    } catch (err) {
      console.warn(
        `[tool:schedule] commitToUser threw, fallback to LLM narration: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    content: formatTask(task, "Task created successfully"),
  };
}

/** 为 commit 消息构造简短文本——用户第一眼就能读懂"什么时候会发生什么" */
function buildCommitmentText(task: ScheduledTask): string {
  switch (task.schedule.kind) {
    case "once":
      return `⏰ 已安排「${task.name}」：${formatOnceTime(task.schedule.at)}`;
    case "interval":
      return `⏰ 已安排循环任务「${task.name}」：每 ${humanDuration(task.schedule.everyMs)}`;
    case "cron":
      return `⏰ 已安排定时任务「${task.name}」：cron "${task.schedule.expr}"${
        task.schedule.tz ? ` (${task.schedule.tz})` : ""
      }`;
  }
}

/** ISO 时间格式化为"2026-04-21 09:57:27"（省略时区，用户看本地时间更自然） */
function formatOnceTime(isoAt: string): string {
  const d = new Date(isoAt);
  if (isNaN(d.getTime())) return isoAt;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function handleList(scheduler: Scheduler): ToolResult {
  const tasks = scheduler.listTasks();

  if (tasks.length === 0) {
    return { content: "No scheduled tasks." };
  }

  const lines = tasks.map((t) => formatTaskBrief(t));
  return { content: `${tasks.length} task(s):\n\n${lines.join("\n\n")}` };
}

async function handleUpdate(
  scheduler: Scheduler,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  if (!id) return { content: "Missing required parameter: id", isError: true };

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.enabled !== undefined) patch.enabled = input.enabled;

  if (input.schedule_kind) {
    const schedule = buildSchedule(input.schedule_kind as string, input);
    if (schedule) patch.schedule = schedule;
  }

  const task = await scheduler.updateTask(id, patch);
  return { content: formatTask(task, "Task updated successfully") };
}

async function handleDelete(
  scheduler: Scheduler,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  if (!id) return { content: "Missing required parameter: id", isError: true };

  await scheduler.deleteTask(id);
  return { content: `Task ${id} deleted.` };
}

async function handleRun(
  scheduler: Scheduler,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  if (!id) return { content: "Missing required parameter: id", isError: true };

  const result = await scheduler.runTask(id);
  return {
    content: `Task executed: ${result.status}\nDuration: ${result.durationMs}ms${result.output ? `\nOutput: ${result.output}` : ""}${result.error ? `\nError: ${result.error}` : ""}`,
  };
}

// ─── Helpers ───

function buildSchedule(
  kind: string,
  input: Record<string, unknown>,
): TaskSchedule | null {
  switch (kind) {
    case "once": {
      const at = input.schedule_at as string;
      if (!at) return null;
      return { kind: "once", at };
    }
    case "interval": {
      const everyMs = input.schedule_every_ms as number;
      if (!everyMs || everyMs <= 0) return null;
      if (everyMs < 60_000) return null;
      return { kind: "interval", everyMs };
    }
    case "cron": {
      const expr = input.schedule_cron as string;
      if (!expr) return null;
      return { kind: "cron", expr, tz: (input.schedule_tz as string) ?? undefined };
    }
    default:
      return null;
  }
}

function formatTask(task: ScheduledTask, header: string): string {
  const lines = [
    header,
    `  ID: ${task.id}`,
    `  Name: ${task.name}`,
    `  Schedule: ${formatSchedule(task.schedule)}`,
    `  Priority: ${task.priority}`,
    `  Enabled: ${task.enabled}`,
    `  Next run: ${task.state.nextRunAt ?? "N/A"}`,
  ];
  if (task.description) lines.push(`  Description: ${task.description}`);
  return lines.join("\n");
}

function formatTaskBrief(task: ScheduledTask): string {
  const status = task.enabled ? "✓" : "✗";
  const lastRun = task.state.lastRunAt
    ? `last: ${task.state.lastStatus ?? "?"} at ${task.state.lastRunAt}`
    : "never run";
  return `[${status}] ${task.name} (${task.id})\n    ${formatSchedule(task.schedule)} | ${task.priority} | ${lastRun}\n    Next: ${task.state.nextRunAt ?? "N/A"}`;
}

function formatSchedule(schedule: TaskSchedule): string {
  switch (schedule.kind) {
    case "once":
      return `once at ${schedule.at}`;
    case "interval":
      return `every ${humanDuration(schedule.everyMs)}`;
    case "cron":
      return `cron "${schedule.expr}"${schedule.tz ? ` (${schedule.tz})` : ""}`;
    default:
      return "unknown";
  }
}

function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  return `${Math.round(ms / 3_600_000)}h`;
}
