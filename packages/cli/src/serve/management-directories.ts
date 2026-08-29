/**
 * Server-owned 管理目录的持久层实现 —— 仅剩 trust 域。
 *
 * trust:每次操作新建 PermissionStore 实例(惰性载盘)——目录无状态,确认链路
 * 沉淀的新规则随读即见;撤销落盘后对新建 runtime 实例生效(活跃实例的内存
 * 副本随实例换代刷新,最终一致)。
 *
 * Skill Catalog 管理已由 @zhixing/core 的 Skill 应用服务拥有。
 */

import {
  PermissionStore,
  parseConversationId,
  type PermissionContextId,
  type PermissionRule,
} from "@zhixing/core";
import {
  resolveWorkspace,
  resolveWorkspaceSessionType,
  type WorkspaceSessionType,
  type ZhixingConfig,
} from "@zhixing/providers";
import type { TrustDirectory } from "@zhixing/server";

export function createTrustDirectory(deps: {
  config: ZhixingConfig;
  sessionType?: WorkspaceSessionType;
}): TrustDirectory {
  /**
   * 对话语境 → 权限上下文。与 runtime 装配同源派生:场景对话 → scene 上下文;
   * main 对话 → resolveWorkspace(与 createAgentRuntime 同函数同输入)有路径
   * 即 workspace 上下文(稳定 hash),无则 main——保证管理面与运行时实例的
   * pipeline.getContextId() 视角一致。
   */
  const contextFor = (conversationId?: string): PermissionContextId => {
    if (conversationId) {
      const { scope } = parseConversationId(conversationId);
      if (scope.kind === "workscene") {
        return { kind: "scene", sceneId: scope.sceneId };
      }
    }
    const sessionType = deps.sessionType ?? resolveWorkspaceSessionType();
    const workspace = resolveWorkspace(deps.config, { sessionType });
    return workspace.path
      ? {
          kind: "workspace",
          hash: PermissionStore.workspaceHashFromPath(workspace.path),
        }
      : { kind: "main" };
  };

  return {
    async list(conversationId): Promise<PermissionRule[]> {
      const store = new PermissionStore();
      // 用户可管规则 = 语境内全部规则排除 builtin(对齐 listUserTrustRules
      // 语义)。session 规则活在各实例内存、新建 store 自然不含。
      return store
        .list(contextFor(conversationId))
        .filter((rule) => rule.scope !== "builtin");
    },

    async revoke(ruleId, conversationId): Promise<boolean> {
      const store = new PermissionStore();
      // 载入与 list 同语境——列得到的才撤得到
      store.list(contextFor(conversationId));
      return store.revoke(ruleId);
    },
  };
}
