import { randomUUID } from "node:crypto";
import {
  normalizeSceneName,
} from "@zhixing/core";
import type {
  AuthorityCallContext,
  GlobalControlCallContext,
  GlobalStatePort,
  ImmediateRootResourceLease,
  LocalWorkspaceBinding,
  WorksceneDto,
  WorkspaceProbeResult,
} from "@zhixing/core/contracts";
import { localEnvironmentControlSubject } from "@zhixing/core/environment";
import { environmentControlSubject } from "@zhixing/core/protocol";
import {
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import type {
  WorksceneDirectory,
  WorksceneWriteResult,
} from "@zhixing/server";
import type { WorksceneToolDirectory } from "@zhixing/runtime-host";
import type { ConversationManager } from "@zhixing/owner-kernel";
import type { ConversationDirectory } from "@zhixing/server";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import {
  readLocalWorkspaceTransfer,
  removeLocalWorkspaceTransfer,
} from "../runtime/local-workspace-transfer.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "../runtime/workspace-reset-impact.js";
import { WorksceneSessionOwner } from "./workscene-session-owner.js";

const CONTROL_BUDGET = { maxCalls: 8 };
export { WORKSPACE_CATALOG_RESET_IMPACT };

export interface LocalWorkspaceDirectory {
  recover(): Promise<void>;
  authorizeLocalWorkspaceTransfer(
    token: string,
  ): Promise<LocalWorkspaceBinding & { deviceId: string }>;
  localWorkspaceStatus(): Promise<{
    state: "healthy" | "degraded";
    catalogGeneration: string;
    reason?: string;
    resetImpact?: string;
  }>;
  listLocalWorkspaces(): Promise<LocalWorkspaceBinding[]>;
  createLocalWorkspace(
    input: { displayName: string; absolutePath: string; requestId: string },
  ): Promise<LocalWorkspaceBinding>;
  renameLocalWorkspace(
    input: {
      bindingRef: string;
      displayName: string;
      expectedRevision: number;
      requestId: string;
    },
  ): Promise<LocalWorkspaceBinding>;
  repathLocalWorkspace(
    input: {
      bindingRef: string;
      absolutePath: string;
      expectedRevision: number;
      requestId: string;
    },
  ): Promise<LocalWorkspaceBinding>;
  repathLocalWorkspaceTransfer(input: {
    bindingRef: string;
    expectedRevision: number;
    transferToken: string;
  }): Promise<LocalWorkspaceBinding>;
  removeLocalWorkspace(input: {
    bindingRef: string;
    expectedRevision: number;
    requestId: string;
  }): Promise<void>;
  resetLocalWorkspaceCatalog(input: {
    expectedCatalogGeneration: string;
    requestId: string;
    confirmationToken: string;
    confirmationIssuedAt: string;
    confirmedImpact: string;
  }): Promise<import("@zhixing/core/contracts").WorkspaceBindingResetReceipt>;
}

export function createWorksceneDirectory(deps: {
  authority: () => AuthorityRuntimeStack | undefined;
  conversations?: () => ConversationManager | null;
  conversationAuthority: () =>
    | {
        touchWorksceneSession(input: {
          conversationId: string;
          sceneId: string;
          requestId: string;
          at: string;
        }): Promise<{ readonly revision: number; readonly at: string }>;
        deleteWorksceneSession(input: {
          conversationId: string;
          sceneId: string;
          requestId: string;
          at: string;
        }): Promise<
          { readonly revision: number; readonly at: string } | undefined
        >;
      }
    | undefined;
  conversationDirectory: ConversationDirectory;
  storageMaintenance?: StorageMaintenanceGovernorPort;
  probeRemote?: (
    deviceId: string,
    request: Parameters<
      NonNullable<AuthorityRuntimeStack["workspaceProbe"]>["probe"]
    >[0],
  ) => Promise<WorkspaceProbeResult>;
}): WorksceneDirectory & WorksceneToolDirectory & LocalWorkspaceDirectory {
  const sceneChains = new Map<string, Promise<unknown>>();
  let sessionOwner: WorksceneSessionOwner | undefined;

  const authority = (): AuthorityRuntimeStack => {
    const current = deps.authority();
    if (!current) throw new Error("Workscene authority is not ready");
    return current;
  };
  const globalState = (): GlobalStatePort => {
    const current = authority().globalState;
    if (!current) throw new Error("Workscene global state is unavailable");
    return current;
  };
  const owner = (): WorksceneSessionOwner => {
    if (sessionOwner) return sessionOwner;
    const runtime = authority();
    sessionOwner = new WorksceneSessionOwner({
      conversations: () => deps.conversations?.() ?? null,
      directory: deps.conversationDirectory,
      authority: deps.conversationAuthority,
      runCleanupStep: (resourceIdentity, operation) =>
        runStorageMaintenanceStep(
          deps.storageMaintenance,
          storageMaintenanceRequest(
            "workscene-cleanup",
            resourceIdentity,
            {},
            { obligation: "committed" },
          ),
          operation,
        ),
    });
    runtime.installWorksceneCleanup((sceneId, conversationIds) =>
      sessionOwner!.removeScene(sceneId, conversationIds),
    );
    return sessionOwner;
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

  function triggerDeletionRecovery(): void {
    void authority().worksceneGlobalState?.recoverPendingDeletions().catch(() => {});
  }

  async function quiesceScene(sceneId: string): Promise<() => void> {
    return owner().quiesce(sceneId);
  }

  function worksceneContext(
    requestId: string,
    expectedRevision?: number,
  ): GlobalControlCallContext {
    return {
      principal: { kind: "host", component: "workscene-directory" },
      requestId,
      authority: { domain: "global", anchorEpoch: authority().anchorEpoch },
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    };
  }

  async function readScene(sceneId: string): Promise<WorksceneDto | null> {
    const result = await globalState().read(
      { kind: "workscene-get", sceneId },
      worksceneContext(`workscene-read:${sceneId}:${randomUUID()}`),
    );
    if (result.kind !== "workscene-get") {
      throw new Error("Workscene global state returned another domain");
    }
    return result.scene;
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

  async function withLocalWorkspaceAdmin<T>(
    requestId: string,
    operation: (
      admin: NonNullable<AuthorityRuntimeStack["workspaceBindingAdmin"]>,
      control: {
        requestId: string;
        lease: ImmediateRootResourceLease;
        abort: AbortSignal;
      },
    ) => Promise<T>,
  ): Promise<T> {
    const runtime = authority();
    const admin = runtime.workspaceBindingAdmin;
    if (!admin) {
      throw new Error("Local workspace administration is unavailable");
    }
    const subject = localEnvironmentControlSubject(
      runtime.deviceId,
      requestId,
    );
    return withEnvironmentLease(subject, runtime.executorId, (lease) =>
      operation(admin, {
        requestId: subject,
        lease,
        abort: new AbortController().signal,
      }),
    );
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
      owner();
      await authority().worksceneGlobalState?.recoverPendingDeletions();
    },

    async list() {
      triggerDeletionRecovery();
      const result = await globalState().read(
        { kind: "workscene-list" },
        worksceneContext(`workscene-list:${randomUUID()}`),
      );
      if (result.kind !== "workscene-list") {
        throw new Error("Workscene global state returned another domain");
      }
      return result.scenes;
    },

    async get(sceneId) {
      triggerDeletionRecovery();
      return readScene(sceneId);
    },

    async create(options): Promise<WorksceneWriteResult> {
      triggerDeletionRecovery();
      const name = normalizeName(options.name);
      const workspaceWarning = await validateWorkspace(options.workspace);
      const result = await globalState().mutate(
        {
          kind: "workscene-create",
          name,
          ...(options.workspace ? { workspace: options.workspace } : {}),
        },
        worksceneContext(options.requestId),
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
      const current = await readScene(sceneId);
      if (!current) return null;
      const result = await globalState().mutate(
        {
          kind: "workscene-rename",
          sceneId,
          name: normalizeName(name),
          expectedRevision: current.revision,
        },
        worksceneContext(requestId, current.revision),
      );
      return result.kind === "workscene-applied" ? result.scene : null;
    },

    async setWorkdir(sceneId, workspace, requestId) {
      triggerDeletionRecovery();
      return runSceneOperation(sceneId, async () => {
        const workspaceWarning = await validateWorkspace(workspace ?? undefined);
        const current = await readScene(sceneId);
        if (!current) return null;
        const release = await quiesceScene(sceneId);
        try {
          const result = await globalState().mutate(
            {
              kind: "workscene-set-workdir",
              sceneId,
              workspace,
              expectedRevision: current.revision,
            },
            worksceneContext(requestId, current.revision),
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
        const current = await readScene(sceneId);
        if (!current) {
          const replay =
            await authority().worksceneGlobalState?.replayMutation(requestId);
          if (!replay) return false;
          if (
            replay.kind !== "workscene-deleted" ||
            replay.sceneId !== sceneId
          ) {
            throw inputError(
              "工作场景删除请求标识已被另一项操作使用",
            );
          }
          await authority().worksceneGlobalState?.recoverPendingDeletions();
          return true;
        }
        const release = await quiesceScene(sceneId);
        try {
          const result = await globalState().mutate(
            {
              kind: "workscene-delete",
              sceneId,
              expectedRevision: current.revision,
            },
            worksceneContext(requestId, current.revision),
          );
          if (result.kind !== "workscene-deleted") {
            throw new Error("Workscene delete returned an applied result");
          }
          return true;
        } finally {
          release();
        }
      });
    },

    async recordActivity(sceneId, conversationId, at, requestId) {
      triggerDeletionRecovery();
      await owner().record(
        sceneId,
        conversationId,
        requestId ?? `workscene-activity:${randomUUID()}`,
        at,
      );
    },

    async enterScene(sceneId, observerId, options) {
      triggerDeletionRecovery();
      return runSceneOperation(sceneId, async () => {
        const scene = await readScene(sceneId);
        if (!scene) return null;
        const conversationId = await owner().enter(
          sceneId,
          observerId,
          {
            recordActivity: options?.recordActivity,
            requestId:
              options?.requestId ?? `workscene-enter:${randomUUID()}`,
          },
        );
        return {
          conversationId,
          scene: (await readScene(sceneId)) ?? scene,
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

    async localWorkspaceStatus() {
      const recovery = authority().workspaceBindingRecovery;
      if (!recovery) {
        throw new Error("Local workspace recovery is unavailable");
      }
      const status = await recovery.status();
      return {
        ...status,
        ...(status.state === "degraded"
          ? { resetImpact: WORKSPACE_CATALOG_RESET_IMPACT }
          : {}),
      };
    },

    async listLocalWorkspaces() {
      return withLocalWorkspaceAdmin(
        `workspace-list:${randomUUID()}`,
        (admin, control) => admin.list(control),
      );
    },

    async createLocalWorkspace(input) {
      return withLocalWorkspaceAdmin(input.requestId, (admin, control) =>
        admin.create(
          {
            displayName: input.displayName,
            absolutePath: input.absolutePath,
          },
          control,
        ),
      );
    },

    async renameLocalWorkspace(input) {
      return withLocalWorkspaceAdmin(input.requestId, (admin, control) =>
        admin.update(
          input.bindingRef,
          { displayName: input.displayName },
          input.expectedRevision,
          control,
        ),
      );
    },

    async repathLocalWorkspace(input) {
      return withLocalWorkspaceAdmin(input.requestId, (admin, control) =>
        admin.update(
          input.bindingRef,
          { absolutePath: input.absolutePath },
          input.expectedRevision,
          control,
        ),
      );
    },

    async repathLocalWorkspaceTransfer(input) {
      const transfer = await readLocalWorkspaceTransfer(input.transferToken);
      try {
        return await withLocalWorkspaceAdmin(
          transfer.requestId,
          (admin, control) =>
            admin.update(
              input.bindingRef,
              { absolutePath: transfer.absolutePath },
              input.expectedRevision,
              control,
            ),
        );
      } finally {
        await removeLocalWorkspaceTransfer(input.transferToken).catch(() => {});
      }
    },

    async removeLocalWorkspace(input) {
      return withLocalWorkspaceAdmin(input.requestId, (admin, control) =>
        admin.remove(
          input.bindingRef,
          input.expectedRevision,
          control,
        ),
      );
    },

    async resetLocalWorkspaceCatalog(input) {
      if (input.confirmedImpact !== WORKSPACE_CATALOG_RESET_IMPACT) {
        throw inputError("恢复确认内容与实际影响不一致");
      }
      const runtime = authority();
      const recovery = runtime.workspaceBindingRecovery;
      if (!recovery) {
        throw new Error("Local workspace recovery is unavailable");
      }
      const subject = localEnvironmentControlSubject(
        runtime.deviceId,
        input.requestId,
      );
      await withEnvironmentLease(
        subject,
        runtime.executorId,
        async (lease) => {
          await recovery.beginReset(
            {
              expectedCatalogGeneration:
                input.expectedCatalogGeneration,
            },
            {
              requestId: subject,
              lease,
              abort: new AbortController().signal,
              confirmation: {
                kind: "workspace-binding-reset",
                token: input.confirmationToken,
                requestId: subject,
                catalogGeneration: input.expectedCatalogGeneration,
                issuedAt: input.confirmationIssuedAt,
              },
            },
          );
        },
      );
      return recovery.completeReset(
        subject,
        new AbortController().signal,
      );
    },
  };
}
