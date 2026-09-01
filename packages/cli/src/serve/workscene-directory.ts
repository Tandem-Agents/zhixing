import { randomUUID } from "node:crypto";
import type {
  AuthorityCallContext,
  GlobalControlCallContext,
  GlobalStatePort,
  ImmediateRootResourceLease,
  WorksceneAppliedResult,
  WorksceneDto,
  WorkspaceProbeResult,
} from "@zhixing/core/contracts";
import { environmentControlSubject } from "@zhixing/core/protocol";
import type { WorksceneToolDirectory } from "./workscene-port.js";
import type { ConversationManager } from "@zhixing/owner-kernel";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import type { WorksceneConversationStorageProjectionCleanupPort } from "@zhixing/core/workscene/application";
import { WorksceneSessionOwner } from "./workscene-session-owner.js";
import type { WorksceneSceneStorageRemovalPort } from "./workscene-storage-removal.js";

const CONTROL_BUDGET = { maxCalls: 8 };

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
    readonly workspace?: { deviceId: string; bindingRef: string };
    readonly requestId: string;
  }): Promise<{ readonly scene: WorksceneDto; readonly workspaceWarning?: string }>;
  rename(
    sceneId: string,
    name: string,
    requestId: string,
  ): Promise<WorksceneDto | null>;
  setWorkdir(
    sceneId: string,
    workspace: { deviceId: string; bindingRef: string } | null,
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
  conversationStorageProjectionCleanup: WorksceneConversationStorageProjectionCleanupPort;
  recoverWorksceneState: () => Promise<void>;
  replayWorksceneMutation: (
    requestId: string,
  ) => Promise<WorksceneAppliedResult | null>;
  sceneStorageRemoval: WorksceneSceneStorageRemovalPort;
  probeRemote?: (
    deviceId: string,
    request: Parameters<
      NonNullable<AuthorityRuntimeStack["workspaceProbe"]>["probe"]
    >[0],
  ) => Promise<WorkspaceProbeResult>;
}): AnchorWorksceneDirectory {
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
      conversationStorageProjectionCleanup:
        deps.conversationStorageProjectionCleanup,
      authority: deps.conversationAuthority,
      sceneStorageRemoval: deps.sceneStorageRemoval,
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
      await deps.recoverWorksceneState();
    },

    async list() {
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
      return readScene(sceneId);
    },

    async create(options) {
      const workspaceWarning = await validateWorkspace(options.workspace);
      const result = await globalState().mutate(
        {
          kind: "workscene-create",
          name: options.name,
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
      const current = await readScene(sceneId);
      if (!current) return null;
      const result = await globalState().mutate(
        {
          kind: "workscene-rename",
          sceneId,
          name,
          expectedRevision: current.revision,
        },
        worksceneContext(requestId, current.revision),
      );
      return result.kind === "workscene-applied" ? result.scene : null;
    },

    async setWorkdir(sceneId, workspace, requestId) {
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
          const replay = await deps.replayWorksceneMutation(requestId);
          if (!replay) return false;
          if (
            replay.kind !== "workscene-deleted" ||
            replay.sceneId !== sceneId
          ) {
            throw inputError(
              "工作场景删除请求标识已被另一项操作使用",
            );
          }
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
      await owner().record(
        sceneId,
        conversationId,
        requestId ?? `workscene-activity:${randomUUID()}`,
        at,
      );
    },

    async enterScene(sceneId, observerId, options) {
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

    async exitScene(sceneId, conversationId, observerId, requestId) {
      await owner().exit(
        sceneId,
        conversationId,
        observerId,
        requestId,
        new Date().toISOString(),
      );
    },

    async workspaceCatalog() {
      return authority().workspaceCatalog().map((workspace) => ({
        deviceId: workspace.deviceId,
        deviceName: workspace.deviceName,
        bindingRef: workspace.bindingRef,
        workspaceBindingRevision: workspace.workspaceBindingRevision,
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

  };
}
