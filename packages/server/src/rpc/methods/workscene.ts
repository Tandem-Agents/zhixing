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
 * 业务规则居于 WorksceneDirectory:名称 / workdir 校验、运行态静默、
 * enter 原子化与删除守卫均不在 RPC handler 内复写。
 */

import { WorksceneBusyError } from "@zhixing/owner-kernel/conversation-manager";
import type {
  WorksceneEnterResult,
  WorksceneListResult,
  WorksceneSummary,
} from "@zhixing/rpc/session-wire";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import {
  WorksceneInputError,
  type WorksceneDirectory,
} from "../../runtime/workscene-directory.js";
import { loadAdvancementState } from "./session.js";

function requireWorkscenes(server: ServerContext): WorksceneDirectory {
  if (!server.workscenes) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "WorksceneDirectory not configured on server",
    );
  }
  return server.workscenes;
}

async function sceneSummary(
  directory: WorksceneDirectory,
  scene: {
    id: string;
    revision: number;
    name: string;
    workspace?: { deviceId: string; bindingRef: string };
    lastActiveAt?: string;
  },
  workspaceWarning?: string,
): Promise<WorksceneSummary> {
  const workspaceMetadata = scene.workspace
    ? (await directory.workspaceCatalog?.())?.find(
        (candidate) =>
          candidate.deviceId === scene.workspace!.deviceId &&
          candidate.bindingRef === scene.workspace!.bindingRef,
      )
    : undefined;
  const summary: WorksceneSummary = {
    sceneId: scene.id,
    revision: scene.revision,
    name: scene.name,
    ...(scene.workspace
      ? {
          workspace: {
            ...scene.workspace,
            ...(workspaceMetadata
              ? {
                  deviceName: workspaceMetadata.deviceName,
                  workspaceName: workspaceMetadata.workspaceName,
                }
              : {}),
          },
        }
      : {}),
    lastActiveAt: scene.lastActiveAt,
  };
  if (workspaceWarning) summary.workspaceWarning = workspaceWarning;
  return summary;
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

function localTransferToken(value: unknown, method: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(value)
  ) {
    throw RpcErrors.invalidParams(`${method} requires a valid local transfer token`);
  }
  return value;
}

async function mapWorksceneErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorksceneInputError || hasErrorCode(err, "WORKSCENE_INPUT")) {
      throw RpcErrors.invalidParams(err.message);
    }
    if (err instanceof WorksceneBusyError || hasErrorCode(err, "WORKSCENE_BUSY")) {
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
      const scenes = await requireWorkscenes(ctx.server).list();
      const directory = requireWorkscenes(ctx.server);
      return {
        scenes: await Promise.all(
          scenes.map((scene) => sceneSummary(directory, scene)),
        ),
      };
    },
  };
}

export function buildWorksceneAuthorizeLocalWorkspaceMethod(): MethodEntry {
  return {
    name: "workscene.authorizeLocalWorkspace",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = requireOnlyFields(
        rawParams ?? {},
        "workscene.authorizeLocalWorkspace",
        ["transferToken"],
      );
      const directory = requireWorkscenes(ctx.server);
      if (!directory.authorizeLocalWorkspaceTransfer) {
        throw RpcErrors.notFound("Local workspace authorization is unavailable");
      }
      const binding = await directory.authorizeLocalWorkspaceTransfer(
        localTransferToken(
          params.transferToken,
          "workscene.authorizeLocalWorkspace",
        ),
      );
      return {
        deviceId: binding.deviceId,
        bindingRef: binding.bindingRef,
        displayName: binding.displayName,
        workspaceBindingRevision: binding.workspaceBindingRevision,
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
        requireWorkscenes(ctx.server).create({
          name,
          ...(workspace ? { workspace } : {}),
          requestId: requestId(params.requestId, "workscene.create"),
        }),
      );
      return sceneSummary(
        requireWorkscenes(ctx.server),
        result.scene,
        result.workspaceWarning,
      );
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
        requireWorkscenes(ctx.server).rename(
          sceneId,
          name,
          requestId(params.requestId, "workscene.rename"),
        ),
      );
      if (!renamed) {
        throw RpcErrors.notFound(`Workscene not found: ${sceneId}`);
      }
      return sceneSummary(requireWorkscenes(ctx.server), renamed);
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
        requireWorkscenes(ctx.server).setWorkdir(
          sceneId,
          workspace,
          requestId(params.requestId, "workscene.setWorkdir"),
        ),
      );
      if (!result) {
        throw RpcErrors.notFound(`Workscene not found: ${params.sceneId}`);
      }
      return sceneSummary(
        requireWorkscenes(ctx.server),
        result.scene,
        result.workspaceWarning,
      );
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
      const removed = await mapWorksceneErrors(() =>
        requireWorkscenes(ctx.server).remove(
          sceneId,
          requestId(params.requestId, "workscene.delete"),
        ),
      );
      if (!removed) {
        throw RpcErrors.notFound(`Workscene not found: ${params.sceneId}`);
      }
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
      ]);
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.enter requires 'sceneId'");
      }
      const sceneId = params.sceneId;
      const workscenes = requireWorkscenes(ctx.server);
      const entered = await mapWorksceneErrors(() =>
        workscenes.enterScene(sceneId, String(ctx.connection.id)),
      );
      if (!entered) {
        throw RpcErrors.notFound(`Workscene not found: ${params.sceneId}`);
      }
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
        scene: await sceneSummary(workscenes, entered.scene),
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
      ]);
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.exit requires 'sceneId'");
      }
      if (typeof params.conversationId !== "string") {
        throw RpcErrors.invalidParams("workscene.exit requires 'conversationId'");
      }
      await requireWorkscenes(ctx.server)
        .recordActivity(
          params.sceneId,
          params.conversationId,
          new Date().toISOString(),
        )
        .catch(() => {});
      return { ok: true };
    },
  };
}
