/**
 * workscene.* RPC 方法 —— 工作场景的管理面与进出执行体。
 *
 * 方法：
 * - workscene.list / create / rename / delete / setWorkdir：场景管理面
 * - workscene.enter：取 / 建场景当前对话,返回全域键——接入面据此切自己的
 *   当前对话指针;"模式"由 id 在后续 send 时纯函数派生,宿主无状态机
 * - workscene.exit：touch 场景(最近使用 / 未来退出纪要挂点)——切回 main
 *   是接入面指针行为,宿主无事务
 *
 * 不设 workscene.status:接入面当前在哪个场景是连接级 UI 态,宿主零知识。
 *
 * 全部业务规则居于 Workscene Product API；RPC 仅处理 authenticated wire，
 * enter 成功后的 Advancement 恢复/读取是独立跨领域响应投影。
 */

import {
  WORKSCENE_MANAGEMENT_CREATE_COMMAND,
  WORKSCENE_MANAGEMENT_DELETE_COMMAND,
  WORKSCENE_MANAGEMENT_LIST_QUERY,
  WORKSCENE_MANAGEMENT_RENAME_COMMAND,
  WORKSCENE_MANAGEMENT_SET_WORKSPACE_COMMAND,
  WORKSCENE_ENTRY_ENTER_COMMAND,
  WORKSCENE_ENTRY_EXIT_COMMAND,
  WorksceneApplicationError,
} from "@zhixing/core/workscene/application";
import type {
  WorksceneEnterResult,
  WorksceneListResult,
} from "@zhixing/rpc/session-wire";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import { loadAdvancementState } from "./session.js";

function requireWorksceneApplication(server: ServerContext) {
  if (
    !server.productApi ||
    !server.productApi.supports(WORKSCENE_MANAGEMENT_LIST_QUERY) ||
    !server.productApi.supports(WORKSCENE_MANAGEMENT_CREATE_COMMAND) ||
    !server.productApi.supports(WORKSCENE_MANAGEMENT_RENAME_COMMAND) ||
    !server.productApi.supports(WORKSCENE_MANAGEMENT_SET_WORKSPACE_COMMAND) ||
    !server.productApi.supports(WORKSCENE_MANAGEMENT_DELETE_COMMAND) ||
    !server.productApi.supports(WORKSCENE_ENTRY_ENTER_COMMAND) ||
    !server.productApi.supports(WORKSCENE_ENTRY_EXIT_COMMAND)
  ) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "Workscene Product API not configured on server",
    );
  }
  return server.productApi;
}

function workspaceReference(
  value: unknown,
  label: string,
): { deviceId: string; bindingRef: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw RpcErrors.invalidParams(`${label} must be a workspace reference`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "deviceId" && key !== "bindingRef",
    ) ||
    typeof record.deviceId !== "string" ||
    !record.deviceId ||
    typeof record.bindingRef !== "string" ||
    !record.bindingRef
  ) {
    throw RpcErrors.invalidParams(
      `${label} requires only 'deviceId' and 'bindingRef'`,
    );
  }
  return { deviceId: record.deviceId, bindingRef: record.bindingRef };
}

function requestId(value: unknown, method: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw RpcErrors.invalidParams(`${method} requires 'requestId'`);
  }
  return value;
}

function requireOnlyFields(
  value: unknown,
  method: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw RpcErrors.invalidParams(`${method} params must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key))) {
    throw RpcErrors.invalidParams(`${method} params contain unknown fields`);
  }
  return record;
}

async function mapWorksceneErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (
      (err instanceof WorksceneApplicationError && err.kind === "invalid-input") ||
      hasErrorCode(err, "WORKSCENE_INPUT")
    ) {
      throw RpcErrors.invalidParams(err.message);
    }
    if (
      (err instanceof WorksceneApplicationError && err.kind === "not-found") ||
      hasErrorCode(err, "WORKSCENE_NOT_FOUND")
    ) {
      throw RpcErrors.notFound(err.message);
    }
    if (
      (err instanceof WorksceneApplicationError && err.kind === "busy") ||
      hasErrorCode(err, "WORKSCENE_BUSY")
    ) {
      throw RpcErrors.busy(err.message);
    }
    throw err;
  }
}

function hasErrorCode(err: unknown, code: string): err is Error {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as Error & { code?: unknown }).code === code
  );
}

export function buildWorksceneListMethod(): MethodEntry {
  return {
    name: "workscene.list",
    requiresAuth: true,
    async handler(_params, ctx): Promise<WorksceneListResult> {
      requireOnlyFields(_params ?? {}, "workscene.list", []);
      const result = await requireWorksceneApplication(ctx.server).query(
        WORKSCENE_MANAGEMENT_LIST_QUERY,
        { kind: "list" },
      );
      return {
        scenes: [...result.scenes],
      };
    },
  };
}

export function buildWorksceneCreateMethod(): MethodEntry {
  return {
    name: "workscene.create",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = requireOnlyFields(rawParams ?? {}, "workscene.create", [
        "name",
        "workspace",
        "requestId",
      ]);
      if (typeof params.name !== "string") {
        throw RpcErrors.invalidParams("workscene.create requires 'name'");
      }
      const name = params.name;
      const workspace =
        params.workspace === undefined
          ? undefined
          : workspaceReference(params.workspace, "workscene.create 'workspace'");
      const result = await mapWorksceneErrors(() =>
        requireWorksceneApplication(ctx.server).command(
          WORKSCENE_MANAGEMENT_CREATE_COMMAND,
          {
            kind: "create",
          name,
          ...(workspace ? { workspace } : {}),
          requestId: requestId(params.requestId, "workscene.create"),
          },
        ),
      );
      return result.result.scene;
    },
  };
}

export function buildWorksceneRenameMethod(): MethodEntry {
  return {
    name: "workscene.rename",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = requireOnlyFields(rawParams ?? {}, "workscene.rename", [
        "sceneId",
        "name",
        "requestId",
      ]);
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.rename requires 'sceneId'");
      }
      const sceneId = params.sceneId;
      if (typeof params.name !== "string") {
        throw RpcErrors.invalidParams("workscene.rename requires 'name'");
      }
      const name = params.name;
      const renamed = await mapWorksceneErrors(() =>
        requireWorksceneApplication(ctx.server).command(
          WORKSCENE_MANAGEMENT_RENAME_COMMAND,
          {
            kind: "rename",
            sceneId,
            name,
            requestId: requestId(params.requestId, "workscene.rename"),
          },
        ),
      );
      return renamed.result.scene;
    },
  };
}

export function buildWorksceneSetWorkdirMethod(): MethodEntry {
  return {
    name: "workscene.setWorkdir",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = requireOnlyFields(
        rawParams ?? {},
        "workscene.setWorkdir",
        ["sceneId", "workspace", "requestId"],
      );
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.setWorkdir requires 'sceneId'");
      }
      const sceneId = params.sceneId;
      if (!("workspace" in params)) {
        throw RpcErrors.invalidParams("workscene.setWorkdir requires 'workspace'");
      }
      const workspace =
        params.workspace === null
          ? null
          : workspaceReference(
              params.workspace,
              "workscene.setWorkdir 'workspace'",
            );
      const result = await mapWorksceneErrors(() =>
        requireWorksceneApplication(ctx.server).command(
          WORKSCENE_MANAGEMENT_SET_WORKSPACE_COMMAND,
          {
            kind: "set-workspace",
            sceneId,
            workspace,
            requestId: requestId(params.requestId, "workscene.setWorkdir"),
          },
        ),
      );
      return result.result.scene;
    },
  };
}

export function buildWorksceneDeleteMethod(): MethodEntry {
  return {
    name: "workscene.delete",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<void> {
      const params = requireOnlyFields(rawParams ?? {}, "workscene.delete", [
        "sceneId",
        "requestId",
      ]);
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.delete requires 'sceneId'");
      }
      const sceneId = params.sceneId;
      await mapWorksceneErrors(() =>
        requireWorksceneApplication(ctx.server).command(
          WORKSCENE_MANAGEMENT_DELETE_COMMAND,
          {
            kind: "delete",
            sceneId,
            requestId: requestId(params.requestId, "workscene.delete"),
          },
        ),
      );
    },
  };
}

export function buildWorksceneEnterMethod(): MethodEntry {
  return {
    name: "workscene.enter",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = requireOnlyFields(rawParams ?? {}, "workscene.enter", [
        "sceneId",
        "requestId",
      ]);
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.enter requires 'sceneId'");
      }
      const sceneId = params.sceneId;
      const dispatch = await mapWorksceneErrors(() =>
        requireWorksceneApplication(ctx.server).command(
          WORKSCENE_ENTRY_ENTER_COMMAND,
          {
            kind: "enter",
            sceneId,
            observerId: String(ctx.connection.id),
            requestId: requestId(params.requestId, "workscene.enter"),
          },
        ),
      );
      const entered = dispatch.result;
      // 场景对话与主对话走同一推进管线——进入场景即恢复停摆的推进并
      // 呈现推进状态，与 session.resume 同一「打开会话即浮现」裁决：
      // 入场事实已由领域服务登记 observer;恢复失败不撤销入场事实。
      let advancement: Awaited<ReturnType<typeof loadAdvancementState>> | undefined;
      try {
        await ctx.server.advancementRecovery?.recoverConversation(
          entered.conversationId,
        );
        advancement = await loadAdvancementState(ctx.server, entered.conversationId);
      } catch (err) {
        console.error("[workscene.enter] advancement recovery failed:", err);
      }
      return {
        conversationId: entered.conversationId,
        scene: entered.scene,
        ...(advancement ? { advancement } : {}),
      } satisfies WorksceneEnterResult;
    },
  };
}

export function buildWorksceneExitMethod(): MethodEntry {
  return {
    name: "workscene.exit",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<{ ok: true }> {
      const params = requireOnlyFields(rawParams ?? {}, "workscene.exit", [
        "sceneId",
        "conversationId",
        "requestId",
      ]);
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.exit requires 'sceneId'");
      }
      if (typeof params.conversationId !== "string") {
        throw RpcErrors.invalidParams("workscene.exit requires 'conversationId'");
      }
      const sceneId = params.sceneId;
      const conversationId = params.conversationId;
      const dispatch = await mapWorksceneErrors(() =>
        requireWorksceneApplication(ctx.server).command(
          WORKSCENE_ENTRY_EXIT_COMMAND,
          {
            kind: "exit",
            sceneId,
            conversationId,
            observerId: String(ctx.connection.id),
            requestId: requestId(params.requestId, "workscene.exit"),
          },
        ),
      );
      return { ok: dispatch.result.ok };
    },
  };
}
