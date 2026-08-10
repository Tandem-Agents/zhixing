/**
 * 管理面目录的持久层实现 —— trust / skill / memory 三域,注入给 @zhixing/server。
 *
 * trust:每次操作新建 PermissionStore 实例(惰性载盘)——目录无状态,确认链路
 * 沉淀的新规则随读即见;撤销落盘后对新建 runtime 实例生效(活跃实例的内存
 * 副本随实例换代刷新,最终一致)。
 *
 * skill/memory:只经 GlobalStatePort 的 path-free query/control 合同读写。
 */

import {
  PermissionStore,
  parseConversationId,
  type PermissionContextId,
  type PermissionRule,
} from "@zhixing/core";
import { randomUUID } from "node:crypto";
import type { GlobalStatePort } from "@zhixing/core/contracts";
import type { JournalMaintenance } from "./journal-maintenance.js";
import {
  resolveWorkspace,
  resolveWorkspaceSessionType,
  type WorkspaceSessionType,
  type ZhixingConfig,
} from "@zhixing/providers";
import type {
  MemoryDirectory,
  SkillDirectory,
  TrustDirectory,
} from "@zhixing/server";

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

export function createSkillDirectory(deps: {
  globalState: GlobalStatePort | (() => GlobalStatePort);
  anchorEpoch: number | (() => number);
}): SkillDirectory {
  let structuralVersion = 0;
  const globalState = () =>
    typeof deps.globalState === "function" ? deps.globalState() : deps.globalState;
  const anchorEpoch = () =>
    typeof deps.anchorEpoch === "function" ? deps.anchorEpoch() : deps.anchorEpoch;
  const context = (requestId: string) => ({
    principal: { kind: "host" as const, component: "skill-management" },
    requestId,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    authority: { domain: "global" as const, anchorEpoch: anchorEpoch() },
  });
  const readCatalog = async () => {
    const result = await globalState().read(
      { kind: "skill-catalog", includeDisabled: true },
      context(`skill-list:${randomUUID()}`),
    );
    if (result.kind !== "skill-catalog") {
      throw new Error("Skill catalog returned another result type");
    }
    structuralVersion = result.catalogRevision;
    return result.entries;
  };
  const readEntry = async (id: string) => {
    const result = await globalState().read(
      { kind: "skill-get", skillId: id },
      context(`skill-get:${randomUUID()}`),
    );
    if (result.kind !== "skill-get") {
      throw new Error("Skill lookup returned another result type");
    }
    structuralVersion = result.catalogRevision;
    return result.entry;
  };
  return {
    list() {
      return readCatalog();
    },
    async setState(id, patch): Promise<boolean> {
      const current = await readEntry(id);
      if (!current) return false;
      const statePatch = patch.mode !== undefined
        ? { mode: patch.mode, ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}), ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}) }
        : patch.pinned !== undefined
          ? { pinned: patch.pinned, ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}) }
          : { disabled: patch.disabled! };
      await globalState().mutate(
        {
          kind: "skill-set-state",
          skillId: id,
          patch: statePatch,
          expectedRevision: current.revision,
        },
        context(`skill-state:${randomUUID()}`),
      );
      await readCatalog();
      return true;
    },
    async archive(id): Promise<boolean> {
      const current = await readEntry(id);
      if (!current) return false;
      await globalState().mutate(
        {
          kind: "skill-archive",
          skillId: id,
          expectedRevision: current.revision,
        },
        context(`skill-archive:${randomUUID()}`),
      );
      await readCatalog();
      return true;
    },
    structuralVersion() {
      return structuralVersion;
    },
  };
}

export function createMemoryDirectory(deps: {
  globalState: () => GlobalStatePort | undefined;
  anchorEpoch: () => number | undefined;
  journal: JournalMaintenance;
}): MemoryDirectory {
  const authority = (): { globalState: GlobalStatePort; anchorEpoch: number } => {
    const globalState = deps.globalState();
    const anchorEpoch = deps.anchorEpoch();
    if (!globalState || !Number.isSafeInteger(anchorEpoch) || anchorEpoch! <= 0) {
      throw new Error("Anchor memory authority is not ready");
    }
    return { globalState, anchorEpoch: anchorEpoch! };
  };
  const list = async (
    domain: "memory" | "journal" | "people",
  ) => {
    const current = authority();
    const result = await current.globalState.read(
      domain === "memory"
        ? {
            kind: "memory-list",
            scope: { kind: "personal" },
            domain,
            category: "profile",
          }
        : { kind: "memory-list", scope: { kind: "personal" }, domain },
      {
        principal: { kind: "host", component: "memory-management" },
        requestId: `memory-management:${randomUUID()}`,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        authority: { domain: "global", anchorEpoch: current.anchorEpoch },
      },
    );
    if (result.kind !== "memory-list") {
      throw new TypeError("Memory authority returned another result type");
    }
    return result.entries;
  };
  return {
    async profileGet() {
      const profiles = (await list("memory"))
        .filter((entry) => entry.id === "profile");
      if (profiles.length > 1) {
        throw new TypeError("Memory authority returned duplicate profiles");
      }
      return profiles[0] ?? null;
    },
    async journalStats() {
      const plan = await deps.journal.scan();
      return {
        stats: plan.stats,
        condense: plan.condense.length > 0
          ? {
              months: plan.condense.length,
              files: plan.condense.reduce(
                (sum, month) => sum + month.sources.length,
                0,
              ),
            }
          : null,
        expiredCount: plan.expired.length,
        maintenance: await deps.journal.latestNotice(),
      };
    },
    peopleList() {
      return list("people");
    },
  };
}
