/**
 * schedule.* RPC 方法
 *
 * 暴露 Scheduler 的 CRUD + 手动触发能力：
 * - schedule.list   → ScheduledTask[]
 * - schedule.create → ScheduledTask
 * - schedule.update → ScheduledTask
 * - schedule.delete → void
 * - schedule.run    → AgentTurnResult
 *
 * 推送事件由 wireSchedulerEventBridge 单独负责（订阅 scheduler EventBus → notify 所有连接）。
 */

import type { ScheduledTask } from "@zhixing/core";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";

// ─── schedule.list ───

export function buildScheduleListMethod(): MethodEntry {
  return {
    name: "schedule.list",
    requiresAuth: true,
    handler(_params, ctx): ScheduledTask[] {
      return requireScheduler(ctx.server).listTasks();
    },
  };
}

// ─── schedule.create ───

interface ScheduleCreateParams {
  name?: string;
  description?: string;
  enabled?: boolean;
  priority?: ScheduledTask["priority"];
  schedule?: ScheduledTask["schedule"];
  action?: ScheduledTask["action"];
  delivery?: ScheduledTask["delivery"];
}

export function buildScheduleCreateMethod(): MethodEntry {
  return {
    name: "schedule.create",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<ScheduledTask> {
      const params = (rawParams ?? {}) as ScheduleCreateParams;

      if (typeof params.name !== "string" || params.name.length === 0) {
        throw RpcErrors.invalidParams("schedule.create requires 'name'");
      }
      if (!params.schedule) {
        throw RpcErrors.invalidParams("schedule.create requires 'schedule'");
      }
      if (!params.action) {
        throw RpcErrors.invalidParams("schedule.create requires 'action'");
      }

      const scheduler = requireScheduler(ctx.server);
      return scheduler.createTask({
        name: params.name,
        description: params.description,
        enabled: params.enabled ?? true,
        priority: params.priority ?? "normal",
        schedule: params.schedule,
        action: params.action,
        delivery: params.delivery,
      });
    },
  };
}

// ─── schedule.update ───

interface ScheduleUpdateParams {
  id?: string;
  patch?: Partial<
    Pick<
      ScheduledTask,
      "name" | "description" | "enabled" | "priority" | "schedule" | "action" | "delivery"
    >
  >;
}

export function buildScheduleUpdateMethod(): MethodEntry {
  return {
    name: "schedule.update",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<ScheduledTask> {
      const params = (rawParams ?? {}) as ScheduleUpdateParams;
      if (typeof params.id !== "string") {
        throw RpcErrors.invalidParams("schedule.update requires 'id'");
      }
      const scheduler = requireScheduler(ctx.server);
      try {
        return await scheduler.updateTask(params.id, params.patch ?? {});
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Task not found")) {
          throw RpcErrors.notFound(err.message);
        }
        throw err;
      }
    },
  };
}

// ─── schedule.delete ───

interface ScheduleDeleteParams {
  id?: string;
}

export function buildScheduleDeleteMethod(): MethodEntry {
  return {
    name: "schedule.delete",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<void> {
      const params = (rawParams ?? {}) as ScheduleDeleteParams;
      if (typeof params.id !== "string") {
        throw RpcErrors.invalidParams("schedule.delete requires 'id'");
      }
      const scheduler = requireScheduler(ctx.server);
      try {
        await scheduler.deleteTask(params.id);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Task not found")) {
          throw RpcErrors.notFound(err.message);
        }
        // "Cannot delete system task: xxx" 转为 INVALID_PARAMS
        if (err instanceof Error && err.message.startsWith("Cannot delete system task")) {
          throw RpcErrors.invalidParams(err.message);
        }
        throw err;
      }
    },
  };
}

// ─── schedule.run ───

interface ScheduleRunParams {
  id?: string;
}

export function buildScheduleRunMethod(): MethodEntry {
  return {
    name: "schedule.run",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as ScheduleRunParams;
      if (typeof params.id !== "string") {
        throw RpcErrors.invalidParams("schedule.run requires 'id'");
      }
      const scheduler = requireScheduler(ctx.server);
      try {
        return await scheduler.runTask(params.id);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Task not found")) {
          throw RpcErrors.notFound(err.message);
        }
        throw err;
      }
    },
  };
}

// ─── 工具 ───

function requireScheduler(server: ServerContext) {
  if (!server.scheduler) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "Scheduler not configured on server",
    );
  }
  return server.scheduler;
}
