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
import {
  SCHEDULE_MANAGEMENT_CREATE_COMMAND,
  SCHEDULE_MANAGEMENT_DELETE_COMMAND,
  SCHEDULE_MANAGEMENT_LIST_QUERY,
  SCHEDULE_MANAGEMENT_UPDATE_COMMAND,
  SCHEDULE_MANUAL_ABORT_COMMAND,
  SCHEDULE_MANUAL_RUN_COMMAND,
  ScheduleManagementApplicationError,
  type ScheduleManagementOperation,
} from "@zhixing/core/scheduler/application";
import type { ProductApiDispatcher } from "@zhixing/core/product-api";
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
    async handler(params, ctx): Promise<readonly ScheduledTask[]> {
      strictParams(params, [], "schedule.list");
      return (await requireScheduleManagement(ctx.server).query(
        SCHEDULE_MANAGEMENT_LIST_QUERY,
        { kind: "list" },
      )).tasks;
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

      const draft = {
        name: params.name,
        ...(params.description !== undefined ? { description: params.description } : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.priority !== undefined ? { priority: params.priority } : {}),
        schedule: params.schedule,
        action: params.action,
        ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
      };
      const operationId = requiredRequestId(params.requestId, "schedule.create");
      try {
        const result = await requireScheduleManagement(ctx.server).command(
          SCHEDULE_MANAGEMENT_CREATE_COMMAND,
          {
            kind: "create",
            draft,
            operation: scheduleManagementOperation(ctx, operationId),
          },
        );
        return result.result.task;
      } catch (error) {
        throw mapScheduleManagementError(error, "schedule.create");
      }
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
      const operationId = requiredRequestId(params.requestId, "schedule.update");
      try {
        const result = await requireScheduleManagement(ctx.server).command(
          SCHEDULE_MANAGEMENT_UPDATE_COMMAND,
          {
            kind: "update",
            taskId: params.id,
            patch,
            operation: scheduleManagementOperation(ctx, operationId, taskRevision),
          },
        );
        return result.result.task;
      } catch (error) {
        throw mapScheduleManagementError(error, "schedule.update");
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
      const operationId = requiredRequestId(params.requestId, "schedule.delete");
      try {
        await requireScheduleManagement(ctx.server).command(
          SCHEDULE_MANAGEMENT_DELETE_COMMAND,
          {
            kind: "delete",
            taskId: params.id,
            operation: scheduleManagementOperation(ctx, operationId, taskRevision),
          },
        );
      } catch (error) {
        throw mapScheduleManagementError(error, "schedule.delete");
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
      try {
        const operationId = requiredRequestId(params.requestId, "schedule.run");
        const result = await requireScheduleManagement(ctx.server).command(
          SCHEDULE_MANUAL_RUN_COMMAND,
          {
            kind: "run",
            taskId: params.id,
            operation: scheduleManagementOperation(ctx, operationId),
          },
        );
        return result.result.result;
      } catch (err) {
        throw mapScheduleManagementError(err, "schedule.run");
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
      try {
        const operationId = requiredRequestId(
          params.requestId,
          "schedule.abortRun",
        );
        const result = await requireScheduleManagement(ctx.server).command(
          SCHEDULE_MANUAL_ABORT_COMMAND,
          {
            kind: "abort-run",
            runId: params.runId,
            operation: scheduleManagementOperation(ctx, operationId),
          },
        );
        return {
          aborted: result.result.aborted,
        };
      } catch (error) {
        throw mapScheduleManagementError(error, "schedule.abortRun");
      }
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

function scheduleManagementOperation(
  ctx: Parameters<MethodEntry["handler"]>[1],
  operationId: string,
  expectedRevision?: number,
): ScheduleManagementOperation {
  const source = scheduleControlSource(ctx, operationId);
  return {
    operationId,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    surface: {
      surfacePrincipal: source.ingress.surfacePrincipal,
      connectionId: source.connectionId,
      deviceId: source.ingress.deviceId,
      ingressId: source.ingress.ingressId,
      receivedAt: source.ingress.receivedAt,
    },
  };
}

function mapScheduleManagementError(error: unknown, method: string): unknown {
  if (!(error instanceof ScheduleManagementApplicationError)) return error;
  switch (error.code) {
    case "not-found":
      return RpcErrors.notFound(error.message);
    case "system-task":
      return error;
    case "invalid-command":
      return method === "schedule.create"
        ? RpcErrors.invalidParams(`${method} is invalid: ${error.message}`)
        : error;
    case "conflict":
      // Migration preserves the pre-existing generic RPC conversion for
      // optimistic conflicts; the domain classification remains internal.
      return error;
  }
}

// ─── 工具 ───

function requireScheduleManagement(server: ServerContext): ProductApiDispatcher {
  if (
    !server.productApi ||
    !server.productApi.supports(SCHEDULE_MANAGEMENT_LIST_QUERY) ||
    !server.productApi.supports(SCHEDULE_MANAGEMENT_CREATE_COMMAND) ||
    !server.productApi.supports(SCHEDULE_MANAGEMENT_UPDATE_COMMAND) ||
    !server.productApi.supports(SCHEDULE_MANAGEMENT_DELETE_COMMAND) ||
    !server.productApi.supports(SCHEDULE_MANUAL_RUN_COMMAND) ||
    !server.productApi.supports(SCHEDULE_MANUAL_ABORT_COMMAND)
  ) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "Schedule management application not configured on server",
    );
  }
  return server.productApi;
}
