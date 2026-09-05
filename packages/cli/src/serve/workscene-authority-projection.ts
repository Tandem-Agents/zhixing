import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import type {
  AuthorityCallContext,
  GlobalControlCallContext,
  ImmediateRootResourceLease,
  WorksceneDto,
  WorkspaceProbeRequest,
  WorkspaceProbeResult,
} from "@zhixing/core/contracts";
import { environmentControlSubject } from "@zhixing/core/protocol";
import type {
  WorksceneRuntimeProjectionReadPort,
  WorksceneWorkspaceReference,
} from "@zhixing/core/workscene/application";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import type { WorksceneToolDirectory } from "./workscene-port.js";
import type { WorksceneRemoteWorkspaceProbePort } from "./workscene-directory.js";

const CONTROL_BUDGET = { maxCalls: 8 };

export interface AnchorWorksceneAuthorityProjection {
  readonly runtime: WorksceneRuntimeProjectionReadPort;
  readonly tools: WorksceneToolDirectory;
  recover(): Promise<void>;
  replay(requestId: string): ReturnType<AuthorityRuntimeStack["replayWorksceneMutation"]>;
  installCleanup(
    cleanup: (sceneId: string, conversationIds: readonly string[]) => Promise<void>,
  ): void;
  list(): Promise<WorksceneDto[]>;
  get(sceneId: string): Promise<WorksceneDto | null>;
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
  validateWorkspace(
    workspace: WorksceneWorkspaceReference | null,
  ): Promise<string | undefined>;
  commitWorkspace(
    current: WorksceneDto,
    workspace: WorksceneWorkspaceReference | null,
    requestId: string,
    workspaceWarning?: string,
  ): Promise<{ readonly scene: WorksceneDto; readonly workspaceWarning?: string }>;
  commitRemove(current: WorksceneDto, requestId: string): Promise<void>;
  resolveWorkspaceRoot(
    sceneId: string,
    workspace: WorksceneWorkspaceReference,
  ): Promise<string>;
  prepareWorkspaceRoot(sceneId: string, absolutePath: string): Promise<void>;
}

/**
 * The single Authority-backed Workscene projection for an Anchor generation.
 * It is created only after the Authority stack is complete and never locates a
 * later dependency. Conversation ownership is deliberately composed beside it.
 */
export function createAnchorWorksceneAuthorityProjection(input: {
  readonly authority: AuthorityRuntimeStack;
  readonly remoteWorkspaceProbe: WorksceneRemoteWorkspaceProbePort;
}): AnchorWorksceneAuthorityProjection {
  const authority = input.authority;
  const globalState = authority.globalState;
  if (!globalState) {
    throw new Error("Workscene global state is unavailable");
  }

  const context = (
    requestId: string,
    expectedRevision?: number,
  ): GlobalControlCallContext => ({
    principal: { kind: "host", component: "workscene-directory" },
    requestId,
    authority: { domain: "global", anchorEpoch: authority.anchorEpoch },
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  });

  const inputError = (message: string): Error =>
    Object.assign(new Error(message), {
      name: "WorksceneInputError",
      code: "WORKSCENE_INPUT",
    });

  const get = async (sceneId: string): Promise<WorksceneDto | null> => {
    const result = await globalState.read(
      { kind: "workscene-get", sceneId },
      context(`workscene-read:${sceneId}:${randomUUID()}`),
    );
    if (result.kind !== "workscene-get") {
      throw new Error("Workscene global state returned another domain");
    }
    return result.scene;
  };

  const withEnvironmentLease = async <T>(
    workId: string,
    executorId: string,
    operation: (
      lease: ImmediateRootResourceLease,
      callContext: AuthorityCallContext,
    ) => Promise<T>,
  ): Promise<T> => {
    const callContext: AuthorityCallContext = {
      principal: { kind: "host", component: "resource-governor" },
      requestId: workId,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const lease = await authority.resourceGovernor.acquireRoot(
      { kind: "control", id: workId, attempt: 1 },
      CONTROL_BUDGET,
      { admissionClass: "interactive", entry: "environment-control" },
      callContext,
      { executorId },
    );
    let failed = true;
    try {
      const result = await operation(lease, callContext);
      failed = false;
      return result;
    } finally {
      try {
        await authority.resourceGovernor.settle(lease, callContext);
      } finally {
        await authority.resourceGovernor.release(lease, callContext).catch((error) => {
          if (!failed) throw error;
        });
      }
    }
  };

  const probeWorkspace = async (
    workspace: WorksceneWorkspaceReference,
  ): Promise<WorkspaceProbeResult> => {
    const requestId = environmentControlSubject(
      workspace.deviceId,
      workspace.bindingRef,
      randomUUID(),
    );
    const targets = authority
      .workspaceCatalog()
      .filter(
        (candidate) =>
          candidate.deviceId === workspace.deviceId &&
          candidate.bindingRef === workspace.bindingRef,
      );
    if (targets.length !== 1) {
      throw inputError("目标工作区的认证执行器快照不可用或不唯一");
    }
    const expectedExecutorId = targets[0]!.executorId;
    return withEnvironmentLease(requestId, expectedExecutorId, async (resourceLease) => {
      const owner = authority.environmentProbeOwner;
      if (!owner) throw new Error("Environment probe owner is unavailable");
      const request: WorkspaceProbeRequest = owner.issue({
        requestId,
        deviceId: workspace.deviceId,
        bindingRef: workspace.bindingRef,
        executorId: expectedExecutorId,
        resourceLease,
      });
      let result: WorkspaceProbeResult;
      if (workspace.deviceId === authority.deviceId) {
        if (!authority.workspaceProbe) {
          throw new Error("Local workspace probe handler is unavailable");
        }
        result = await authority.workspaceProbe.probe(request);
      } else {
        result = await input.remoteWorkspaceProbe.probe(workspace.deviceId, request);
      }
      return owner.accept(request, result, expectedExecutorId);
    });
  };

  const validateWorkspace = async (
    workspace: WorksceneWorkspaceReference | undefined,
  ): Promise<string | undefined> => {
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
  };

  const workspaceCatalog = async () =>
    authority.workspaceCatalog().map((workspace) => ({
      deviceId: workspace.deviceId,
      deviceName: workspace.deviceName,
      bindingRef: workspace.bindingRef,
      workspaceBindingRevision: workspace.workspaceBindingRevision,
      workspaceName: workspace.displayName,
    }));

  const selectWorkspace: WorksceneToolDirectory["selectWorkspace"] = async (selection) => {
    const matches = authority.workspaceCatalog().filter(
      (workspace) =>
        workspace.deviceName === selection.deviceName &&
        workspace.displayName === selection.workspaceName,
    );
    return matches.length === 1
      ? {
          deviceId: matches[0]!.deviceId,
          bindingRef: matches[0]!.bindingRef,
        }
      : null;
  };

  const runtime = Object.freeze({ get });
  const tools = Object.freeze({ get, workspaceCatalog, selectWorkspace });

  const projection: AnchorWorksceneAuthorityProjection = {
    runtime,
    tools,
    recover: () => authority.recoverWorksceneState(),
    replay: (requestId) => authority.replayWorksceneMutation(requestId),
    installCleanup: (cleanup) => authority.installWorksceneCleanup(cleanup),
    async list() {
      const result = await globalState.read(
        { kind: "workscene-list" },
        context(`workscene-list:${randomUUID()}`),
      );
      if (result.kind !== "workscene-list") {
        throw new Error("Workscene global state returned another domain");
      }
      return result.scenes;
    },
    get,
    async create(options) {
      const workspaceWarning = await validateWorkspace(options.workspace);
      const result = await globalState.mutate(
        {
          kind: "workscene-create",
          name: options.name,
          ...(options.workspace ? { workspace: options.workspace } : {}),
        },
        context(options.requestId),
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
      const current = await get(sceneId);
      if (!current) return null;
      const result = await globalState.mutate(
        {
          kind: "workscene-rename",
          sceneId,
          name,
          expectedRevision: current.revision,
        },
        context(requestId, current.revision),
      );
      return result.kind === "workscene-applied" ? result.scene : null;
    },
    validateWorkspace: (workspace) => validateWorkspace(workspace ?? undefined),
    async commitWorkspace(current, workspace, requestId, workspaceWarning) {
      const result = await globalState.mutate(
        {
          kind: "workscene-set-workdir",
          sceneId: current.id,
          workspace,
          expectedRevision: current.revision,
        },
        context(requestId, current.revision),
      );
      if (result.kind !== "workscene-applied") {
        throw new Error("Workscene workspace update returned deletion result");
      }
      return {
        scene: result.scene,
        ...(workspaceWarning ? { workspaceWarning } : {}),
      };
    },
    async commitRemove(current, requestId) {
      const result = await globalState.mutate(
        {
          kind: "workscene-delete",
          sceneId: current.id,
          expectedRevision: current.revision,
        },
        context(requestId, current.revision),
      );
      if (result.kind !== "workscene-deleted") {
        throw new Error("Workscene delete returned an applied result");
      }
    },
    async resolveWorkspaceRoot(sceneId, workspace) {
      if (!authority.environment || workspace.deviceId !== authority.deviceId) {
        throw new Error(`工作场景 "${sceneId}" 的工作区不属于当前 executor`);
      }
      const resolved = await authority.environment.resolveWorkspace(workspace.bindingRef);
      return resolved.absolutePath;
    },
    async prepareWorkspaceRoot(sceneId, absolutePath) {
      if (!authority.environment) {
        throw new Error(`工作场景 "${sceneId}" 的工作区不属于当前 executor`);
      }
      const probe = await authority.environment.probePath(absolutePath);
      if (probe === "missing") {
        await fsp.mkdir(absolutePath, { recursive: true });
      } else if (probe !== "directory") {
        throw new Error(`工作场景 "${sceneId}" 的工作区不可用于执行: ${probe}`);
      }
    },
  };
  return Object.freeze(projection);
}
