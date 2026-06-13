/**
 * 管理面目录的持久层实现 —— trust / skill / memory 三域,注入给 @zhixing/server。
 *
 * trust:每次操作新建 PermissionStore 实例(惰性载盘)——目录无状态,确认链路
 * 沉淀的新规则随读即见;撤销落盘后对新建 runtime 实例生效(活跃实例的内存
 * 副本随实例换代刷新,最终一致)。
 *
 * skill:包装注入的 skillStore 单实例(与全部 runtime 共享锁域,setState /
 * archive 的结构版本递增对一切消费者一致)。
 */

import {
  JournalStore,
  PeopleStore,
  PermissionStore,
  parseConversationId,
  type PermissionContextId,
  type PermissionRule,
  type SkillStore,
} from "@zhixing/core";
import { resolveWorkspace, type ZhixingConfig } from "@zhixing/providers";
import type {
  MemoryDirectory,
  SkillDirectory,
  TrustDirectory,
} from "@zhixing/server";

export function createTrustDirectory(deps: {
  config: ZhixingConfig;
  cliWorkspace?: string;
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
    const workspace = resolveWorkspace(deps.config, {
      cliWorkspace: deps.cliWorkspace,
    });
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

export function createSkillDirectory(deps: {
  skillStore: SkillStore;
}): SkillDirectory {
  const { skillStore } = deps;
  return {
    list() {
      return skillStore.listForManagement();
    },
    async setState(id, patch): Promise<boolean> {
      try {
        await skillStore.setState(id, patch);
        return true;
      } catch {
        // store 对不存在的技能 throw——目录契约用 false 表达"不存在"
        return false;
      }
    },
    async archive(id): Promise<boolean> {
      try {
        await skillStore.archive(id);
        return true;
      } catch {
        return false;
      }
    },
    structuralVersion() {
      // store 版本按全局粒度递增(不区分 mode),任一 mode 投影变更都不漏检
      return skillStore.version("main");
    },
  };
}

export function createMemoryDirectory(): MemoryDirectory {
  return {
    async journalStats() {
      const plan = await new JournalStore().scan();
      return {
        stats: plan.stats,
        condense: plan.condensePlan
          ? {
              months: plan.condensePlan.months.length,
              files: plan.condensePlan.months.reduce(
                (sum: number, m: { files: string[] }) => sum + m.files.length,
                0,
              ),
            }
          : null,
        expiredCount: plan.expiredFiles.length,
      };
    },
    peopleList() {
      return new PeopleStore().listAll();
    },
  };
}
