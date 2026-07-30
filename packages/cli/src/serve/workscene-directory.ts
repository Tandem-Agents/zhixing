import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  ConversationRepository,
  getWorkSceneDir,
  normalizeSceneName,
  parseConversationId,
  WorksceneActivityProjection,
  WORKSCENE_CONVERSATION_PREFIX,
  worksceneConversationId,
  type AnchorWorksceneRegistry,
} from "@zhixing/core";
import type {
  AuthorityCallContext,
  ImmediateRootResourceLease,
  LocalWorkspaceBinding,
  WorksceneDto,
  WorkspaceProbeResult,
} from "@zhixing/core/contracts";
import { localEnvironmentControlSubject } from "@zhixing/core/environment";
import { environmentControlSubject } from "@zhixing/core/protocol";
import type {
  WorksceneDirectory,
  WorksceneWriteResult,
} from "@zhixing/server";
import type { WorksceneToolDirectory } from "@zhixing/runtime-host";
import type { ConversationManager } from "@zhixing/owner-kernel";
import {
  runStorageMaintenanceStep,
  runInMaintenanceContext,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
  type StorageMaintenanceUrgency,
} from "@zhixing/core/resources";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import {
  readLocalWorkspaceTransfer,
  removeLocalWorkspaceTransfer,
} from "../runtime/local-workspace-transfer.js";

const CONTROL_BUDGET = { maxCalls: 8 };

export interface LocalWorkspaceDirectory {
  recover(): Promise<void>;
  authorizeLocalWorkspaceTransfer(
    token: string,
  ): Promise<LocalWorkspaceBinding & { deviceId: string }>;
}

export function createWorksceneDirectory(deps: {
  authority: () => AuthorityRuntimeStack | undefined;
  conversations?: () => ConversationManager | null;
  probeRemote?: (
    deviceId: string,
    request: Parameters<
      NonNullable<AuthorityRuntimeStack["workspaceProbe"]>["probe"]
    >[0],
  ) => Promise<WorkspaceProbeResult>;
  activityProjection?: WorksceneActivityProjection;
  activityProjectionRoot?: string;
  storageMaintenance?: StorageMaintenanceGovernorPort;
  removeSceneDirectory?: (sceneId: string) => Promise<void>;
}): WorksceneDirectory & WorksceneToolDirectory & LocalWorkspaceDirectory {
  const sceneChains = new Map<string, Promise<unknown>>();
  let deletionRecovery: Promise<void> | undefined;
  const activityProjection =
    deps.activityProjection ??
    (deps.activityProjectionRoot
      ? new WorksceneActivityProjection({
          rootDir: deps.activityProjectionRoot,
          storageMaintenance: deps.storageMaintenance,
        })
      : undefined);

  const authority = (): AuthorityRuntimeStack => {
    const current = deps.authority();
    if (!current) throw new Error("Workscene authority is not ready");
    return current;
  };
  const registry = (): AnchorWorksceneRegistry => {
    const current = authority().worksceneRegistry;
    if (!current) throw new Error("Anchor workscene registry is unavailable");
    return current;
  };
  const inputError = (message: string): Error =>
    Object.assign(new Error(message), {
      name: "WorksceneInputError",
      code: "WORKSCENE_INPUT",
    });
  const normalizeName = (name: string): string => {
    try {
      return normalizeSceneName(name);
    } catch (error) {
      throw inputError(
        error instanceof Error ? error.message : "工作场景名称无效",
      );
    }
  };
  const busyError = (message: string): Error =>
    Object.assign(new Error(message), {
      name: "WorksceneBusyError",
      code: "WORKSCENE_BUSY",
    });
  const sceneConversationPrefix = (sceneId: string): string =>
    `${WORKSCENE_CONVERSATION_PREFIX}${sceneId}:`;

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

  async function projectDeletion(pending: {
    sceneId: string;
    deletionRevision: number;
  }): Promise<void> {
    await runStorageMaintenanceStep(
      deps.storageMaintenance,
      storageMaintenanceRequest(
        "workscene-cleanup",
        pending.sceneId,
        { deletionRevision: pending.deletionRevision },
        { obligation: "committed" },
      ),
      () =>
        deps.removeSceneDirectory
          ? deps.removeSceneDirectory(pending.sceneId)
          : rm(getWorkSceneDir(pending.sceneId), {
              recursive: true,
              force: true,
            }),
    );
    await registry().confirmDeletionProjected(
      pending.sceneId,
      pending.deletionRevision,
    );
  }

  async function recoverPendingDeletions(
    urgency: StorageMaintenanceUrgency,
  ): Promise<void> {
    if (!deps.authority()?.worksceneRegistry) return;
    if (deletionRecovery) return deletionRecovery;
    const recovery = runInMaintenanceContext(urgency, async () => {
      const pending = await registry().pendingDeletions();
      for (const deletion of pending) {
        await runSceneOperation(deletion.sceneId, () =>
          projectDeletion(deletion),
        );
      }
    });
    deletionRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (deletionRecovery === recovery) deletionRecovery = undefined;
    }
  }

  function triggerDeletionRecovery(): void {
    void recoverPendingDeletions("recovery").catch(() => {});
  }

  async function quiesceScene(sceneId: string): Promise<() => void> {
    const manager = deps.conversations?.();
    return manager
      ? manager.quiescePrefix(sceneConversationPrefix(sceneId))
      : () => {};
  }

  async function refreshActivity(
    scenes: readonly WorksceneDto[],
  ): Promise<void> {
    if (!activityProjection) return;
    await activityProjection.synchronize(
      await Promise.all(
        scenes.map(async (scene) => {
          const sessions = await new ConversationRepository({
            kind: "workscene",
            sceneId: scene.id,
          }).list({ includeArchived: true });
          return {
            sceneId: scene.id,
            sessions: sessions.map(({ id, lastActiveAt }) => ({
              conversationId: id,
              lastActiveAt,
            })),
          };
        }),
      ),
    );
  }

  async function withProjectedActivity(
    scene: WorksceneDto,
  ): Promise<WorksceneDto> {
    if (!activityProjection) return scene;
    const projected = await activityProjection.get(scene.id);
    return projected && Date.parse(projected) > Date.parse(scene.lastActiveAt)
      ? { ...scene, lastActiveAt: projected }
      : scene;
  }

  async function withEnvironmentLease<T>(
    workId: string,
    executorId: string,
    operation: (
      lease: ImmediateRootResourceLease,
      context: AuthorityCallContext,
    ) => Promise<T>,
  ): Promise<T> {
    const runtime = authority();
    const context: AuthorityCallContext = {
      principal: { kind: "host", component: "resource-governor" },
      requestId: workId,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const lease = await runtime.resourceGovernor.acquireRoot(
      { kind: "control", id: workId, attempt: 1 },
      CONTROL_BUDGET,
      { admissionClass: "interactive", entry: "environment-control" },
      context,
      { executorId },
    );
    let failed = true;
    try {
      const result = await operation(lease, context);
      failed = false;
      return result;
    } finally {
      try {
        await runtime.resourceGovernor.settle(lease, context);
      } finally {
        await runtime.resourceGovernor.release(lease, context).catch((error) => {
          if (!failed) throw error;
        });
      }
    }
  }

  async function probeWorkspace(
    workspace: { deviceId: string; bindingRef: string },
  ): Promise<WorkspaceProbeResult> {
    const runtime = authority();
    const requestId = environmentControlSubject(
      workspace.deviceId,
      workspace.bindingRef,
      randomUUID(),
    );
    const targets = runtime
      .workspaceCatalog()
      .filter(
        (candidate) =>
          candidate.deviceId === workspace.deviceId &&
          candidate.bindingRef === workspace.bindingRef,
      );
    if (targets.length !== 1) {
      throw inputError(
        "目标工作区的认证执行器快照不可用或不唯一",
      );
    }
    const expectedExecutorId = targets[0]!.executorId;
    return withEnvironmentLease(
      requestId,
      expectedExecutorId,
      async (resourceLease) => {
        const owner = runtime.environmentProbeOwner;
        if (!owner) throw new Error("Environment probe owner is unavailable");
        const request = owner.issue({
          requestId,
          deviceId: workspace.deviceId,
          bindingRef: workspace.bindingRef,
          executorId: expectedExecutorId,
          resourceLease,
        });
        let result: WorkspaceProbeResult;
        if (workspace.deviceId === runtime.deviceId) {
          if (!runtime.workspaceProbe) {
            throw new Error("Local workspace probe handler is unavailable");
          }
          result = await runtime.workspaceProbe.probe(request);
        } else {
          if (!deps.probeRemote) {
            throw inputError("目标设备当前不可达，无法确认工作区状态");
          }
          result = await deps.probeRemote(workspace.deviceId, request);
        }
        return owner.accept(request, result, expectedExecutorId);
      },
    );
  }

  async function validateWorkspace(
    workspace: { deviceId: string; bindingRef: string } | undefined,
  ): Promise<string | undefined> {
    if (!workspace) return undefined;
    const result = await probeWorkspace(workspace);
    switch (result.probe) {
      case "directory":
        return undefined;
      case "missing":
        return "工作区当前不存在，下次进入将自动创建";
      case "non_directory":
        throw inputError("工作区目标已存在但不是目录");
      case "inaccessible":
        throw inputError("工作区当前不可访问");
      case "error":
        throw inputError("工作区状态无法确认");
    }
  }

  return {
    async recover() {
      await recoverPendingDeletions("recovery");
    },

    async list() {
      triggerDeletionRecovery();
      const scenes = await registry().list();
      await refreshActivity(scenes).catch(() => {});
      const projected = await Promise.all(
        scenes.map((scene) =>
          withProjectedActivity(scene).catch(() => scene),
        ),
      );
      return projected.sort(
        (left, right) =>
          Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt) ||
          left.id.localeCompare(right.id, "en-US"),
      );
    },

    async get(sceneId) {
      triggerDeletionRecovery();
      const scene = await registry().get(sceneId);
      if (!scene) return null;
      await refreshActivity(await registry().list()).catch(() => {});
      return withProjectedActivity(scene).catch(() => scene);
    },

    async create(options): Promise<WorksceneWriteResult> {
      triggerDeletionRecovery();
      const name = normalizeName(options.name);
      const workspaceWarning = await validateWorkspace(options.workspace);
      const result = await registry().apply(
        {
          kind: "workscene-create",
          name,
          ...(options.workspace ? { workspace: options.workspace } : {}),
        },
        { requestId: options.requestId },
      );
      if (result.kind !== "workscene-applied") {
        throw new Error("Workscene create returned a deletion result");
      }
      return {
        scene: result.scene,
        ...(workspaceWarning ? { workspaceWarning } : {}),
      };
    },

    async rename(sceneId, name, requestId) {
      triggerDeletionRecovery();
      const current = await registry().get(sceneId);
      if (!current) return null;
      const result = await registry().apply(
        {
          kind: "workscene-rename",
          sceneId,
          name: normalizeName(name),
          expectedRevision: current.revision,
        },
        { requestId },
      );
      return result.kind === "workscene-applied" ? result.scene : null;
    },

    async setWorkdir(sceneId, workspace, requestId) {
      triggerDeletionRecovery();
      return runSceneOperation(sceneId, async () => {
        const workspaceWarning = await validateWorkspace(workspace ?? undefined);
        const current = await registry().get(sceneId);
        if (!current) return null;
        const release = await quiesceScene(sceneId);
        try {
          const result = await registry().apply(
            {
              kind: "workscene-set-workdir",
              sceneId,
              workspace,
              expectedRevision: current.revision,
            },
            { requestId },
          );
          if (result.kind !== "workscene-applied") {
            throw new Error("Workscene workspace update returned deletion result");
          }
          return {
            scene: result.scene,
            ...(workspaceWarning ? { workspaceWarning } : {}),
          };
        } finally {
          release();
        }
      });
    },

    async remove(sceneId, requestId) {
      return runSceneOperation(sceneId, async () => {
        const replay = await registry().replay(requestId);
        if (replay) {
          if (
            replay.kind !== "workscene-deleted" ||
            replay.sceneId !== sceneId
          ) {
            throw new Error(
              "Workscene request identity was reused with another mutation",
            );
          }
          const pending = (await registry().pendingDeletions()).find(
            (candidate) => candidate.sceneId === sceneId,
          );
          if (pending) {
            await runInMaintenanceContext("foreground", () =>
              projectDeletion(pending),
            );
          }
          return true;
        }
        const pending = (await registry().pendingDeletions()).find(
          (candidate) => candidate.sceneId === sceneId,
        );
        if (pending) {
          await runInMaintenanceContext("foreground", () =>
            projectDeletion(pending),
          );
          return true;
        }
        const current = await registry().get(sceneId);
        if (!current) return false;
        const release = await quiesceScene(sceneId);
        try {
          const result = await registry().apply(
            {
              kind: "workscene-delete",
              sceneId,
              expectedRevision: current.revision,
            },
            { requestId },
          );
          if (result.kind !== "workscene-deleted") {
            throw new Error("Workscene delete returned an applied result");
          }
          await runInMaintenanceContext("foreground", () =>
            projectDeletion({
              sceneId,
              deletionRevision: result.revision,
            }),
          );
          return true;
        } finally {
          release();
        }
      });
    },

    async recordActivity(sceneId, conversationId) {
      triggerDeletionRecovery();
      const parsed = parseConversationId(conversationId);
      if (parsed.scope.kind !== "workscene" || parsed.scope.sceneId !== sceneId) {
        throw inputError("会话不属于指定工作场景");
      }
      const repo = new ConversationRepository(parsed.scope);
      await repo.touch(parsed.localId);
      void registry()
        .list()
        .then(refreshActivity)
        .catch(() => {});
    },

    async enterScene(sceneId, observerId, options) {
      triggerDeletionRecovery();
      return runSceneOperation(sceneId, async () => {
        const scene = await registry().get(sceneId);
        if (!scene) return null;
        const repo = new ConversationRepository({ kind: "workscene", sceneId });
        const local = (await repo.list())[0] ?? (await repo.create({}));
        const conversationId = worksceneConversationId(sceneId, local.id);
        const manager = deps.conversations?.();
        if (
          manager &&
          !manager.addObserver(conversationId, observerId, {
            allowInactive: true,
          })
        ) {
          throw busyError(
            `Workscene ${sceneId} is being changed; try again later`,
          );
        }
        if (options?.recordActivity !== false) {
          await repo.touch(local.id).catch(() => {});
          void registry()
            .list()
            .then(refreshActivity)
            .catch(() => {});
        }
        return {
          conversationId,
          scene: await withProjectedActivity(scene).catch(() => scene),
        };
      });
    },

    async workspaceCatalog() {
      return authority().workspaceCatalog().map((workspace) => ({
        deviceId: workspace.deviceId,
        deviceName: workspace.deviceName,
        bindingRef: workspace.bindingRef,
        workspaceName: workspace.displayName,
      }));
    },

    async selectWorkspace(input) {
      const matches = authority()
        .workspaceCatalog()
        .filter(
          (workspace) =>
            workspace.deviceName === input.deviceName &&
            workspace.displayName === input.workspaceName,
        );
      return matches.length === 1
        ? {
            deviceId: matches[0]!.deviceId,
            bindingRef: matches[0]!.bindingRef,
          }
        : null;
    },

    async authorizeLocalWorkspaceTransfer(token) {
      const input = await readLocalWorkspaceTransfer(token);
      const runtime = authority();
      const admin = runtime.workspaceBindingAdmin;
      if (!admin) throw new Error("Local workspace administration is unavailable");
      const requestId = localEnvironmentControlSubject(
        runtime.deviceId,
        input.requestId,
      );
      const binding = await withEnvironmentLease(
        requestId,
        runtime.executorId,
        (lease) =>
          admin.create(
            {
              displayName: input.displayName,
              absolutePath: input.absolutePath,
            },
            {
              requestId,
              lease,
              abort: new AbortController().signal,
            },
          ),
      );
      await removeLocalWorkspaceTransfer(token);
      return { ...binding, deviceId: runtime.deviceId };
    },
  };
}
