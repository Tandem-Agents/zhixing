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

import type {
  ScheduledTask,
  SchedulerControlSource,
  TaskPatch,
  TaskSpec,
} from "@zhixing/core";
import { validateTaskDefinition } from "@zhixing/core/protocol";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import { requireRpcSurfacePrincipal } from "../surface-identity.js";

// ─── schedule.list ───

export function buildScheduleListMethod(): MethodEntry {
  return {
    name: "schedule.list",
    requiresAuth: true,
    handler(params, ctx): ScheduledTask[] {
      strictParams(params, [], "schedule.list");
      return requireScheduler(ctx.server).listTasks();
    },
  };
}

// ─── schedule.create ───

interface ScheduleCreateParams {
  requestId?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  priority?: ScheduledTask["priority"];
  schedule?: ScheduledTask["schedule"];
  action?: TaskSpec["action"];
  delivery?: ScheduledTask["delivery"];
}

export function buildScheduleCreateMethod(): MethodEntry {
  return {
    name: "schedule.create",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<ScheduledTask> {
      const params = strictParams<ScheduleCreateParams>(rawParams, [
        "requestId", "name", "description", "enabled", "priority",
        "schedule", "action", "delivery",
      ], "schedule.create");

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
      const spec = {
        name: params.name,
        ...(params.description !== undefined ? { description: params.description } : {}),
        enabled: params.enabled ?? true,
        priority: params.priority ?? "normal",
        schedule: params.schedule,
        action: params.action,
        ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
      };
      validateUserSpec(spec, "schedule.create");
      const operationId = requiredRequestId(params.requestId, "schedule.create");
      return scheduler.createTask(
        spec,
        operationId,
        scheduleControlSource(ctx, operationId),
      );
    },
  };
}

// ─── schedule.update ───

interface ScheduleUpdateParams {
  requestId?: string;
  id?: string;
  taskRevision?: number;
  patch?: TaskPatch;
}

export function buildScheduleUpdateMethod(): MethodEntry {
  return {
    name: "schedule.update",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<ScheduledTask> {
      const params = strictParams<ScheduleUpdateParams>(rawParams, [
        "requestId", "id", "taskRevision", "patch",
      ], "schedule.update");
      if (typeof params.id !== "string") {
        throw RpcErrors.invalidParams("schedule.update requires 'id'");
      }
      const taskRevision = requiredTaskRevision(params.taskRevision, "schedule.update");
      const patch = strictParams<NonNullable<ScheduleUpdateParams["patch"]>>(
        params.patch,
        ["name", "description", "enabled", "priority", "schedule", "action", "delivery"],
        "schedule.update patch",
      );
      const scheduler = requireScheduler(ctx.server);
      const operationId = requiredRequestId(params.requestId, "schedule.update");
      try {
        return await scheduler.updateTask(
          params.id,
          patch,
          operationId,
          taskRevision,
          scheduleControlSource(ctx, operationId),
        );
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
  requestId?: string;
  id?: string;
  taskRevision?: number;
}

export function buildScheduleDeleteMethod(): MethodEntry {
  return {
    name: "schedule.delete",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<void> {
      const params = strictParams<ScheduleDeleteParams>(rawParams, [
        "requestId", "id", "taskRevision",
      ], "schedule.delete");
      if (typeof params.id !== "string") {
        throw RpcErrors.invalidParams("schedule.delete requires 'id'");
      }
      const taskRevision = requiredTaskRevision(params.taskRevision, "schedule.delete");
      const scheduler = requireScheduler(ctx.server);
      const operationId = requiredRequestId(params.requestId, "schedule.delete");
      try {
        await scheduler.deleteTask(
          params.id,
          operationId,
          taskRevision,
          scheduleControlSource(ctx, operationId),
        );
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
  requestId?: string;
  id?: string;
}

export function buildScheduleRunMethod(): MethodEntry {
  return {
    name: "schedule.run",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = strictParams<ScheduleRunParams>(rawParams, [
        "requestId", "id",
      ], "schedule.run");
      if (typeof params.id !== "string") {
        throw RpcErrors.invalidParams("schedule.run requires 'id'");
      }
      const scheduler = requireScheduler(ctx.server);
      try {
        const operationId = requiredRequestId(params.requestId, "schedule.run");
        return await scheduler.runTask(
          params.id,
          operationId,
          scheduleControlSource(ctx, operationId),
        );
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Task not found")) {
          throw RpcErrors.notFound(err.message);
        }
        throw err;
      }
    },
  };
}

// ─── schedule.abortRun ───

interface ScheduleAbortRunParams {
  requestId?: string;
  runId?: string;
}

export function buildScheduleAbortRunMethod(): MethodEntry {
  return {
    name: "schedule.abortRun",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<{ aborted: boolean }> {
      const params = strictParams<ScheduleAbortRunParams>(rawParams, [
        "requestId", "runId",
      ], "schedule.abortRun");
      if (typeof params.runId !== "string") {
        throw RpcErrors.invalidParams("schedule.abortRun requires 'runId'");
      }
      const scheduler = requireScheduler(ctx.server);
      if (scheduler.abortRun) {
        const operationId = requiredRequestId(
          params.requestId,
          "schedule.abortRun",
        );
        return {
          aborted: await scheduler.abortRun(
            params.runId,
            operationId,
            scheduleControlSource(ctx, operationId),
          ),
        };
      }
      throw new RpcAppError(
        RPC_ERROR_CODES.INTERNAL_ERROR,
        "Scheduler cancellation is unavailable",
      );
    },
  };
}

function requestId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw RpcErrors.invalidParams("schedule requestId is invalid");
  }
  return value;
}

function requiredRequestId(value: string | undefined, method: string): string {
  const parsed = requestId(value);
  if (!parsed) {
    throw RpcErrors.invalidParams(`${method} requires a stable 'requestId'`);
  }
  return parsed;
}

function requiredTaskRevision(value: number | undefined, method: string): number {
  if (!Number.isSafeInteger(value) || value! <= 0) {
    throw RpcErrors.invalidParams(`${method} requires a positive 'taskRevision'`);
  }
  return value!;
}

function strictParams<T>(
  input: unknown,
  allowed: readonly string[],
  label: string,
): T {
  const value = input ?? {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw RpcErrors.invalidParams(`${label} params must be an object`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw RpcErrors.invalidParams(
      `${label} contains unsupported fields: ${unexpected.join(", ")}`,
    );
  }
  return value as T;
}

function validateUserSpec(
  spec: TaskSpec,
  label: string,
): void {
  try {
    validateTaskDefinition({
      taskId: "rpc-schedule-validation",
      taskRevision: 1,
      definition: { kind: "user", spec },
      state: spec.enabled ? "enabled" : "disabled",
    });
  } catch (error) {
    throw RpcErrors.invalidParams(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function scheduleControlSource(
  ctx: Parameters<MethodEntry["handler"]>[1],
  ingressId: string,
): SchedulerControlSource {
  let surfacePrincipal: string;
  try {
    surfacePrincipal = requireRpcSurfacePrincipal(ctx.connection);
  } catch (error) {
    throw RpcErrors.invalidParams(
      error instanceof Error ? error.message : "Stable RPC surface identity is required",
    );
  }
  const connectionId = String(ctx.connection.id);
  const principal = ctx.server.conversations?.durableControlPrincipal({
    surfacePrincipal,
    connectionId,
  });
  if (!principal) {
    throw RpcErrors.invalidParams(
      "Authenticated RPC operation requires a durable control principal",
    );
  }
  return {
    connectionId,
    ingress: {
      kind: "first-party",
      surfacePrincipal,
      deviceId: principal.deviceId,
      ingressId,
      receivedAt: new Date().toISOString(),
      turnOrigin: { channel: "rpc", triggeredBy: surfacePrincipal },
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
