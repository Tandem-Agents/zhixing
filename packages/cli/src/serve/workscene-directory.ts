import { randomUUID } from "node:crypto";
import type {
  WorksceneAppliedResult,
  WorksceneDto,
  WorkspaceProbeRequest,
  WorkspaceProbeResult,
} from "@zhixing/core/contracts";
import type {
  WorksceneConversationStorageProjectionCleanupPort,
  WorksceneWorkspaceReference,
} from "@zhixing/core/workscene/application";
import type { ConversationManager } from "@zhixing/owner-kernel";
import type { WorksceneToolDirectory } from "./workscene-port.js";
import type { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type { AnchorWorksceneAuthorityProjection } from "./workscene-authority-projection.js";
import { WorksceneSessionOwner } from "./workscene-session-owner.js";
import type { WorksceneSceneStorageRemovalPort } from "./workscene-storage-removal.js";

export type AnchorWorksceneDirectory = WorksceneToolDirectory & {
  enterScene(
    sceneId: string,
    observerId: string,
    options?: { readonly recordActivity?: boolean; readonly requestId?: string },
  ): Promise<{ readonly conversationId: string; readonly scene: WorksceneDto } | null>;
  exitScene(
    sceneId: string,
    conversationId: string,
    observerId: string,
    requestId: string,
  ): Promise<void>;
  recover(): Promise<void>;
  list(): Promise<WorksceneDto[]>;
  create(options: {
    readonly name: string;
    readonly workspace?: WorksceneWorkspaceReference;
    readonly requestId: string;
  }): Promise<{ readonly scene: WorksceneDto; readonly workspaceWarning?: string }>;
  rename(
    sceneId: string,
    name: string,
    requestId: string,
  ): Promise<WorksceneDto | null>;
  setWorkdir(
    sceneId: string,
    workspace: WorksceneWorkspaceReference | null,
    requestId: string,
  ): Promise<
    { readonly scene: WorksceneDto; readonly workspaceWarning?: string } | null
  >;
  remove(sceneId: string, requestId: string): Promise<boolean>;
  recordActivity(
    sceneId: string,
    conversationId: string,
    at: string,
    requestId?: string,
  ): Promise<void>;
};

/** Finite topology-neutral remote probe demand owned by the Workscene binding. */
export interface WorksceneRemoteWorkspaceProbePort {
  probe(
    deviceId: string,
    request: WorkspaceProbeRequest,
  ): Promise<WorkspaceProbeResult>;
}

/**
 * Composes the one Workscene directory only after all three product
 * dependencies exist. No getter, optional fallback, or later backfill can make
 * the directory reachable in a partially assembled state.
 */
export function createWorksceneDirectory(deps: {
  readonly authority: AnchorWorksceneAuthorityProjection;
  readonly conversations: ConversationManager;
  readonly conversationAuthority: Pick<
    ConversationProtocolRuntime,
    "touchWorksceneSession" | "deleteWorksceneSession"
  >;
  readonly conversationStorageProjectionCleanup: WorksceneConversationStorageProjectionCleanupPort;
  readonly sceneStorageRemoval: WorksceneSceneStorageRemovalPort;
}): AnchorWorksceneDirectory {
  const sceneChains = new Map<string, Promise<unknown>>();
  const sessionOwner = new WorksceneSessionOwner({
    conversations: deps.conversations,
    conversationStorageProjectionCleanup:
      deps.conversationStorageProjectionCleanup,
    authority: deps.conversationAuthority,
    sceneStorageRemoval: deps.sceneStorageRemoval,
  });
  deps.authority.installCleanup((sceneId, conversationIds) =>
    sessionOwner.removeScene(sceneId, conversationIds),
  );

  function runSceneOperation<T>(
    sceneId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = sceneChains.get(sceneId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    sceneChains.set(sceneId, task);
    const cleanup = () => {
      if (sceneChains.get(sceneId) === task) sceneChains.delete(sceneId);
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  const directory: AnchorWorksceneDirectory = {
    recover: () => deps.authority.recover(),
    list: () => deps.authority.list(),
    get: (sceneId) => deps.authority.get(sceneId),
    create: (options) => deps.authority.create(options),
    rename: (sceneId, name, requestId) =>
      deps.authority.rename(sceneId, name, requestId),
    async setWorkdir(sceneId, workspace, requestId) {
      return runSceneOperation(sceneId, async () => {
        const workspaceWarning =
          await deps.authority.validateWorkspace(workspace);
        const current = await deps.authority.get(sceneId);
        if (!current) return null;
        const release = await sessionOwner.quiesce(sceneId);
        try {
          return await deps.authority.commitWorkspace(
            current,
            workspace,
            requestId,
            workspaceWarning,
          );
        } finally {
          release();
        }
      });
    },
    async remove(sceneId, requestId) {
      return runSceneOperation(sceneId, async () => {
        const current = await deps.authority.get(sceneId);
        if (!current) {
          const replay: WorksceneAppliedResult | null =
            await deps.authority.replay(requestId);
          if (!replay) return false;
          if (replay.kind !== "workscene-deleted" || replay.sceneId !== sceneId) {
            throw Object.assign(
              new Error("工作场景删除请求标识已被另一项操作使用"),
              { name: "WorksceneInputError", code: "WORKSCENE_INPUT" },
            );
          }
          return true;
        }
        const release = await sessionOwner.quiesce(sceneId);
        try {
          await deps.authority.commitRemove(current, requestId);
          return true;
        } finally {
          release();
        }
      });
    },
    recordActivity: (sceneId, conversationId, at, requestId) =>
      sessionOwner.record(
        sceneId,
        conversationId,
        requestId ?? `workscene-activity:${randomUUID()}`,
        at,
      ),
    async enterScene(sceneId, observerId, options) {
      return runSceneOperation(sceneId, async () => {
        const scene = await deps.authority.get(sceneId);
        if (!scene) return null;
        const conversationId = await sessionOwner.enter(sceneId, observerId, {
          recordActivity: options?.recordActivity,
          requestId: options?.requestId ?? `workscene-enter:${randomUUID()}`,
        });
        return {
          conversationId,
          scene: (await deps.authority.get(sceneId)) ?? scene,
        };
      });
    },
    exitScene: (sceneId, conversationId, observerId, requestId) =>
      sessionOwner.exit(
        sceneId,
        conversationId,
        observerId,
        requestId,
        new Date().toISOString(),
      ),
    workspaceCatalog: () => deps.authority.tools.workspaceCatalog(),
    selectWorkspace: (input) => deps.authority.tools.selectWorkspace(input),
  };
  return Object.freeze(directory);
}
