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

import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import { WorksceneBusyError } from "../../runtime/conversation-manager.js";
import {
  WorksceneInputError,
  type WorksceneDirectory,
} from "../../runtime/workscene-directory.js";
import type {
  WorksceneEnterResult,
  WorksceneListResult,
  WorksceneSummary,
} from "../session-wire.js";
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

function sceneSummary(scene: {
  id: string;
  name: string;
  workdir?: string;
  lastActiveAt?: string;
}, workdirWarning?: string): WorksceneSummary {
  const summary: WorksceneSummary = {
    sceneId: scene.id,
    name: scene.name,
    workdir: scene.workdir,
    lastActiveAt: scene.lastActiveAt,
  };
  if (workdirWarning) summary.workdirWarning = workdirWarning;
  return summary;
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
      const scenes = await requireWorkscenes(ctx.server).list();
      return { scenes: scenes.map((scene) => sceneSummary(scene)) };
    },
  };
}

export function buildWorksceneCreateMethod(): MethodEntry {
  return {
    name: "workscene.create",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as { name?: string; workdir?: unknown };
      if (typeof params.name !== "string") {
        throw RpcErrors.invalidParams("workscene.create requires 'name'");
      }
      const name = params.name;
      if (params.workdir !== undefined) {
        if (typeof params.workdir !== "string") {
          throw RpcErrors.invalidParams(
            "workscene.create 'workdir' must be a string when provided",
          );
        }
      }
      const workdir = params.workdir as string | undefined;
      const result = await mapWorksceneErrors(() =>
        requireWorkscenes(ctx.server).create({
          name,
          workdir,
        }),
      );
      return sceneSummary(result.scene, result.workdirWarning);
    },
  };
}

export function buildWorksceneRenameMethod(): MethodEntry {
  return {
    name: "workscene.rename",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as { sceneId?: string; name?: string };
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.rename requires 'sceneId'");
      }
      const sceneId = params.sceneId;
      if (typeof params.name !== "string") {
        throw RpcErrors.invalidParams("workscene.rename requires 'name'");
      }
      const name = params.name;
      const renamed = await mapWorksceneErrors(() =>
        requireWorkscenes(ctx.server).rename(sceneId, name),
      );
      if (!renamed) {
        throw RpcErrors.notFound(`Workscene not found: ${sceneId}`);
      }
      return sceneSummary(renamed);
    },
  };
}

export function buildWorksceneSetWorkdirMethod(): MethodEntry {
  return {
    name: "workscene.setWorkdir",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as {
        sceneId?: string;
        workdir?: unknown;
      };
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.setWorkdir requires 'sceneId'");
      }
      if (!("workdir" in params)) {
        throw RpcErrors.invalidParams("workscene.setWorkdir requires 'workdir'");
      }
      if (params.workdir !== null && typeof params.workdir !== "string") {
        throw RpcErrors.invalidParams(
          "workscene.setWorkdir 'workdir' must be a string or null",
        );
      }
      const result = await mapWorksceneErrors(() =>
        requireWorkscenes(ctx.server).setWorkdir(
          params.sceneId!,
          params.workdir as string | null,
        ),
      );
      if (!result) {
        throw RpcErrors.notFound(`Workscene not found: ${params.sceneId}`);
      }
      return sceneSummary(result.scene, result.workdirWarning);
    },
  };
}

export function buildWorksceneDeleteMethod(): MethodEntry {
  return {
    name: "workscene.delete",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<void> {
      const params = (rawParams ?? {}) as { sceneId?: string };
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.delete requires 'sceneId'");
      }
      const removed = await mapWorksceneErrors(() =>
        requireWorkscenes(ctx.server).remove(params.sceneId!),
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
      const params = (rawParams ?? {}) as { sceneId?: string };
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.enter requires 'sceneId'");
      }
      const workscenes = requireWorkscenes(ctx.server);
      const entered = await mapWorksceneErrors(() =>
        workscenes.enterScene(params.sceneId!, String(ctx.connection.id)),
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
        scene: sceneSummary(entered.scene),
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
      const params = (rawParams ?? {}) as { sceneId?: string };
      if (typeof params.sceneId !== "string") {
        throw RpcErrors.invalidParams("workscene.exit requires 'sceneId'");
      }
      await requireWorkscenes(ctx.server).touch(params.sceneId).catch(() => {});
      return { ok: true };
    },
  };
}
