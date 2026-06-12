/**
 * workscene.* RPC 方法 —— 工作场景的管理面与进出执行体。
 *
 * 方法：
 * - workscene.list / create / rename / delete：场景登记管理(注册表薄壳)
 * - workscene.enter：取 / 建场景当前对话,返回全域键——接入面据此切自己的
 *   当前对话指针;"模式"由 id 在后续 send 时纯函数派生,宿主无状态机
 * - workscene.exit：touch 场景(最近使用 / 未来退出纪要挂点)——切回 main
 *   是接入面指针行为,宿主无事务
 *
 * 不设 workscene.status:接入面当前在哪个场景是连接级 UI 态,宿主零知识。
 *
 * delete 守卫:场景有活跃会话(场景对话在 ManagedSession 名册且 busy /
 * 在场)时拒绝——物理删除会让进行中的记忆写入 / 持久化撞 ENOENT。
 */

import { isAbsolute } from "node:path";
import { WORKSCENE_CONVERSATION_PREFIX } from "@zhixing/core";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import type { WorksceneDirectory } from "../../runtime/workscene-directory.js";

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
}) {
  return {
    sceneId: scene.id,
    name: scene.name,
    workdir: scene.workdir,
    lastActiveAt: scene.lastActiveAt,
  };
}

export function buildWorksceneListMethod(): MethodEntry {
  return {
    name: "workscene.list",
    requiresAuth: true,
    async handler(_params, ctx) {
      const scenes = await requireWorkscenes(ctx.server).list();
      return { scenes: scenes.map(sceneSummary) };
    },
  };
}

export function buildWorksceneCreateMethod(): MethodEntry {
  return {
    name: "workscene.create",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as { name?: string; workdir?: unknown };
      if (typeof params.name !== "string" || params.name.trim().length === 0) {
        throw RpcErrors.invalidParams("workscene.create requires non-empty 'name'");
      }
      // workdir 落盘后会成为场景实例的 workspace(文件操作根)——非字符串
      // 必须在边界拒绝;且必须是绝对路径:远程调用方的"相对路径"与宿主
      // 进程 cwd 毫无关系,解析锚点不可预期,相对即错误输入。
      if (params.workdir !== undefined) {
        if (
          typeof params.workdir !== "string" ||
          params.workdir.trim().length === 0
        ) {
          throw RpcErrors.invalidParams(
            "workscene.create 'workdir' must be a non-empty string when provided",
          );
        }
        if (!isAbsolute(params.workdir)) {
          throw RpcErrors.invalidParams(
            "workscene.create 'workdir' must be an absolute path",
          );
        }
      }
      const scene = await requireWorkscenes(ctx.server).create({
        name: params.name.trim(),
        workdir: params.workdir as string | undefined,
      });
      return sceneSummary(scene);
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
      if (typeof params.name !== "string" || params.name.trim().length === 0) {
        throw RpcErrors.invalidParams("workscene.rename requires non-empty 'name'");
      }
      const renamed = await requireWorkscenes(ctx.server).rename(
        params.sceneId,
        params.name.trim(),
      );
      if (!renamed) {
        throw RpcErrors.notFound(`Workscene not found: ${params.sceneId}`);
      }
      return sceneSummary(renamed);
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
      // active 守卫:该场景的对话有活跃会话时拒绝——物理删除会让进行中的
      // 记忆写入 / task_list 持久化 / 退出纪要全撞 ENOENT
      const manager = ctx.server.conversations;
      const scenePrefix = `${WORKSCENE_CONVERSATION_PREFIX}${params.sceneId}:`;
      const hasActive = manager
        ?.list()
        .some((s) => s.conversationId.startsWith(scenePrefix));
      if (hasActive) {
        throw new RpcAppError(
          RPC_ERROR_CODES.BUSY,
          `Workscene "${params.sceneId}" has active conversations; exit them first`,
        );
      }
      if (!(await requireWorkscenes(ctx.server).remove(params.sceneId))) {
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
      const entered = await workscenes.enterConversation(params.sceneId);
      if (!entered) {
        throw RpcErrors.notFound(`Workscene not found: ${params.sceneId}`);
      }
      await workscenes.touch(params.sceneId).catch(() => {});
      return {
        conversationId: entered.conversationId,
        scene: sceneSummary(entered.scene),
      };
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
