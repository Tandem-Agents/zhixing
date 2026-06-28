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
import { isInternal } from "@zhixing/core";
import type {
  DeliveryTarget,
  SchedulerFacade,
  ScheduledTask,
  TaskSchedule,
  TaskPriority,
} from "@zhixing/core";

const SCHEDULE_SYSTEM_PROMPT_HINTS: readonly string[] = [
  "- Use `schedule` to create, list, update, delete, or run scheduled tasks",
  "- For reminders, periodic checks, or timed notifications, translate the user's timing into once / interval / cron parameters",
  "- For cron expressions, default timezone to Asia/Shanghai unless the user specifies otherwise",
  "- Confirm the schedule with the user before creating it",
];

// 架构演化记：
//   ADR-007 Phase 2 引入了 `commitToUser` API + COMMITMENT_SIGNAL，让工具在
//   创建完 task 后主动发一条确认消息，配合系统提示抑制 LLM 叙述——用来防止
//   "LLM 叙述晚于 task fire"的顺序倒转。
//
//   Phase 3 的 Outbox Turn Slot 上线后，顺序由结构性 slot 阻塞保证（task fire
//   必等 turn 完成才发），Phase 2 的 commitment 机制失去核心价值：
//     - 保顺序的职责已被 Phase 3 接管
//     - 抑制 LLM 叙述依赖模型合规（小模型常失效），反而引入冗余消息
//     - 用户 UX：commit "⏰ 已安排..." + LLM "好的，5 秒后见" + task "时间到了"
//       三条消息里前两条语义重复
//
//   所以 schedule 工具在 ADR-007 完整落地后不再主动调 commitToUser——回归
//   "工具返回 ToolResult，LLM 根据结果自然叙述，Phase 3 slot 保证 task fire
//   排在 LLM 回复之后"的干净路径。用户收到 2 条消息：LLM 回复 + task fire。
//
//   `commitToUser` / `committedToUser` / `COMMITMENT_SIGNAL` 依然保留——
//   作为可选增强预留给未来需要"工具即时确认"的场景（如耗时工具的阶段性反馈）。

/**
 * 创建 schedule 工具。
 *
 * 接受 Scheduler 实例或惰性 getter。惰性模式用于解决
 * CLI 中 session/scheduler 的循环初始化依赖：
 * tool 在 session 创建时注入，scheduler 在 session 之后创建。
 */
export type ScheduleToolOrigin = DeliveryTarget;

export function createScheduleTool(
  getFacade: () => SchedulerFacade,
  getOrigin?: () => ScheduleToolOrigin | null,
): ToolDefinition {
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
    // 定时任务是知行应用本地状态：写本地数据、无外部副作用 →
    // 经 app-state 边界判 internal（自动放行）。
    boundaries: [{ boundaryType: "app-state", access: "write", dynamic: false }],
    systemPromptHints: SCHEDULE_SYSTEM_PROMPT_HINTS,

    async call(input, context): Promise<ToolResult> {
      const action = input.action as string;
      console.log(`[tool:schedule] action=${action}${input.name ? ` name="${input.name}"` : ""}${input.schedule_kind ? ` kind=${input.schedule_kind}` : ""}`);

      try {
        const facade = getFacade();
        switch (action) {
          case "create":
            return await handleCreate(facade, input, getOrigin, context);
          case "list":
            return await handleList(facade);
          case "update":
            return await handleUpdate(facade, input);
          case "delete":
            return await handleDelete(facade, input);
          case "run":
            return await handleRun(facade, input);
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
  facade: SchedulerFacade,
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

  // 若本次工具调用发生在 channel turn 内，把 turnId 捕获到 task 上——
  // 任务 fire 后其投递 entry 会以 createdInTurn 派生 afterSlot，确保回复先于 task fire。
  // REPL/ephemeral 上下文无 turnId，createdInTurn 保持 undefined。
  const createdInTurn = context?.turnId;

  const task = await facade.create({
    name,
    description: (input.description as string) ?? undefined,
    enabled: true,
    priority: (input.priority as TaskPriority) ?? "normal",
    schedule,
    action: { kind: "agent-turn", prompt },
    origin,
    ...(createdInTurn !== undefined && { createdInTurn }),
  });

  // ADR-007 Phase 3 之后不再主动调 commitToUser——详见文件顶部的演化记。
  // LLM 根据此 ToolResult 自然叙述"任务已创建"，Phase 3 slot 保证 task fire
  // 排在该叙述之后送达，用户体验：LLM 回复 + task fire = 2 条语义不重复的消息。
  return {
    content: formatTask(task, "Task created successfully"),
  };
}

async function handleList(facade: SchedulerFacade): Promise<ToolResult> {
  // 只列外部（用户）任务——内部系统维护任务不进用户视图。
  const tasks = (await facade.list()).filter((t) => !isInternal(t));

  if (tasks.length === 0) {
    return { content: "No scheduled tasks." };
  }

  const lines = tasks.map((t) => formatTaskBrief(t));
  return { content: `${tasks.length} task(s):\n\n${lines.join("\n\n")}` };
}

async function handleUpdate(
  facade: SchedulerFacade,
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

  const task = await facade.update(id, patch);
  return { content: formatTask(task, "Task updated successfully") };
}

async function handleDelete(
  facade: SchedulerFacade,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  if (!id) return { content: "Missing required parameter: id", isError: true };

  await facade.delete(id);
  return { content: `Task ${id} deleted.` };
}

async function handleRun(
  facade: SchedulerFacade,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  if (!id) return { content: "Missing required parameter: id", isError: true };

  const result = await facade.run(id);
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
