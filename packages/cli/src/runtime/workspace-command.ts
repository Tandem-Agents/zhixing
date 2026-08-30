import path from "node:path";
import { getZhixingHome } from "@zhixing/core";
import { protocolDigest } from "@zhixing/core/protocol";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { createStdoutWriter } from "../screen/cli-writer.js";
import { setupAuthorityRuntime } from "../setup-delivery.js";
import { createDeviceCapacityRuntime } from "../serve/device-capacity-runtime.js";
import { executorIdForDevice } from "../serve/mesh-runtime-assembly.js";
import { prepareMeshRuntimeBootstrap } from "../serve/mesh-runtime-bootstrap.js";
import { runStartupCheck } from "../startup.js";
import { createMcpHub } from "@zhixing/mcp";
import { parseServerSpecs } from "./mcp-config.js";
import { resolveSystemProtectedSecretPaths } from "../security/secret-boundary.js";
import { createExecutorReadinessSource } from "../serve/executor-readiness.js";
import {
  createLocalWorkspaceClient,
  CompletedLocalWorkspaceOperationError,
  localWorkspaceHostIsReachable,
  RecoveredLocalWorkspaceOperationsError,
  type LocalWorkspaceConsumptionCredential,
  type LocalWorkspaceManagementHost,
  type LocalWorkspaceClient,
} from "./local-workspace-management-host.js";
import {
  acquireExecutorLocalWorkspaceOwner,
  defineLocalWorkspaceAssemblyIdentity,
  createExecutorLocalWorkspaceHost,
} from "./local-workspace-bootstrap.js";
import {
  CoreHostConnection,
  defaultCoreHostConnectionDeps,
} from "./core-host-connection.js";
import { RpcWorksceneFacade } from "./rpc-workscene-facade.js";
import {
  validateWorkspaceControlAuthorization,
  workspaceAdministrationOperationTarget,
  type WorkspaceAdministrationDurableOperationRecord,
  type WorkspaceAdministrationView,
  type WorkspaceControlAuthorization,
} from "@zhixing/core/environment/workspace-administration";
import type {
  WorksceneSummary,
} from "@zhixing/rpc";

export function worksceneCreateRequestIdForLocalWorkspace(
  credential: LocalWorkspaceConsumptionCredential,
): string {
  return `workscene-create:${protocolDigest(
    "LocalWorkspaceConsumptionCredential",
    1,
    credential,
  )}`;
}

export interface LocalWorkspaceRecoveryNotice {
  readonly operationId: string;
  readonly operation: WorkspaceAdministrationDurableOperationRecord["input"]["kind"];
  readonly target: string;
  readonly outcome: "succeeded" | "failed";
  readonly credential: LocalWorkspaceConsumptionCredential;
  readonly controlWorkspace?: {
    readonly deviceId: string;
    readonly bindingRef: string;
  };
  readonly error?: { readonly code: string; readonly message: string };
}

interface LocalWorkspaceDelivery<T, R> {
  readonly result: (
    value: T,
    credential: LocalWorkspaceConsumptionCredential | undefined,
  ) => Promise<R>;
  readonly recovered: (
    operations: readonly LocalWorkspaceRecoveryNotice[],
  ) => Promise<void>;
  readonly failure: (
    error: CompletedLocalWorkspaceOperationError,
    credential: LocalWorkspaceConsumptionCredential,
  ) => Promise<void>;
}

export async function runWorkspaceCommand(
  operation: (workspace: LocalWorkspaceClient) => Promise<unknown>,
): Promise<void> {
  const writer = createStdoutWriter();
  await withLocalWorkspaceClient(operation, {
    result: async (result) => {
      if (result !== undefined) writer.line(JSON.stringify(result, null, 2));
    },
    recovered: async (operations) => {
      if (operations.some(({ controlWorkspace }) => controlWorkspace)) {
        throw new Error(
          "检测到尚未完成工作场景创建的本机工作区授权，请先启动交互终端完成恢复",
        );
      }
      writer.line(JSON.stringify({ recoveredOperations: operations }, null, 2));
    },
    failure: (error) => renderLocalWorkspaceFailure(error, writer),
  });
}

/**
 * Public first-party automation entry for the same local authorization plus
 * workscene-create transaction used by the interactive assistant.
 */
export async function runWorkspaceSceneCreateCommand(
  sceneName: string,
  absolutePath: string,
): Promise<void> {
  const writer = createStdoutWriter();
  const coreHost = new CoreHostConnection(defaultCoreHostConnectionDeps());
  try {
    await coreHost.ensure();
    const workscenes = new RpcWorksceneFacade(coreHost);
    const created = await withLocalWorkspaceClient(
      async (workspace) => ({
        authorization: await workspace.authorizeForControl(
          sceneName,
          absolutePath,
        ),
        workspace,
      }),
      {
        result: async ({ authorization, workspace }, credential) => {
          if (!credential) {
            throw new Error("本机工作区授权缺少可恢复的消费凭据");
          }
          return createWorksceneAndReadWorkspaceView(
            workscenes,
            workspace,
            sceneName,
            authorization,
            credential,
          );
        },
        recovered: async (operations) => {
          for (const operation of operations) {
            if (!operation.controlWorkspace) continue;
            await createWorksceneFromLocalWorkspaceAuthorization(
              workscenes,
              operation.target,
              operation.controlWorkspace,
              operation.credential,
            );
          }
        },
        failure: (error) => renderLocalWorkspaceFailure(error, writer),
      },
    );
    writer.line(
      JSON.stringify({
        sceneId: created.scene.sceneId,
        deviceId: created.authorization.deviceId,
        bindingRef: created.authorization.bindingRef,
        workspaceBindingRevision: created.workspace.workspaceBindingRevision,
      }),
    );
  } finally {
    await coreHost.dispose();
  }
}

export function createWorksceneFromLocalWorkspaceAuthorization(
  workscenes: Pick<RpcWorksceneFacade, "create">,
  sceneName: string,
  authorization: WorkspaceControlAuthorization,
  credential: LocalWorkspaceConsumptionCredential,
): Promise<WorksceneSummary> {
  return workscenes.create(
    sceneName,
    {
      deviceId: authorization.deviceId,
      bindingRef: authorization.bindingRef,
    },
    worksceneCreateRequestIdForLocalWorkspace(credential),
  );
}

export async function createWorksceneAndReadWorkspaceView(
  workscenes: Pick<RpcWorksceneFacade, "create">,
  workspace: Pick<LocalWorkspaceClient, "viewByName">,
  sceneName: string,
  authorization: WorkspaceControlAuthorization,
  credential: LocalWorkspaceConsumptionCredential,
): Promise<{
  readonly scene: WorksceneSummary;
  readonly authorization: WorkspaceControlAuthorization;
  readonly workspace: WorkspaceAdministrationView;
}> {
  const scene = await createWorksceneFromLocalWorkspaceAuthorization(
    workscenes,
    sceneName,
    authorization,
    credential,
  );
  return {
    scene,
    authorization,
    workspace: await workspace.viewByName(sceneName),
  };
}

export async function withLocalWorkspaceClient<T, R = T>(
  operation: (workspace: LocalWorkspaceClient) => Promise<T>,
  delivery: LocalWorkspaceDelivery<T, R>,
): Promise<R> {
  const zhixingHome = getZhixingHome();
  const existing = createLocalWorkspaceClient(zhixingHome);
  if (await localWorkspaceHostIsReachable(zhixingHome)) {
    return useLocalWorkspaceClient(existing, operation, delivery);
  }

  let runtime: Awaited<ReturnType<typeof setupAuthorityRuntime>> | undefined;
  let mesh: Awaited<ReturnType<typeof prepareMeshRuntimeBootstrap>> | undefined;
  let host: LocalWorkspaceManagementHost | undefined;
  let mcpHub: ReturnType<typeof createMcpHub> | undefined;
  let owner: Awaited<ReturnType<typeof acquireExecutorLocalWorkspaceOwner>>;
  try {
    const secretStore = createPlatformSecretStore({ homeDir: zhixingHome });
    const startup = await runStartupCheck({
      homeDir: zhixingHome,
      mode: "host",
      secretStore,
    });
    if (startup.kind !== "ready") {
      throw new Error("当前配置不足以启动本机工作区管理能力");
    }
    const capacity = createDeviceCapacityRuntime(
      path.join(zhixingHome, "distributed-runtime", "capacity"),
    );
    mesh = await prepareMeshRuntimeBootstrap({
      zhixingHome,
      secretStore,
      storageMaintenance: capacity.storage,
      ...(startup.config.mesh ? { configuration: startup.config.mesh } : {}),
    });
    if (!mesh.roles.includes("executor")) {
      throw new Error("当前设备未启用 executor 角色，本机工作区管理能力不可用");
    }
    try {
      owner = await acquireExecutorLocalWorkspaceOwner(zhixingHome, mesh.roles);
    } catch {
      const raced = createLocalWorkspaceClient(zhixingHome);
      if (await localWorkspaceHostIsReachable(zhixingHome)) {
        return useLocalWorkspaceClient(raced, operation, delivery);
      }
      throw new Error("本机工作区管理 owner 正在运行但不可达，请稍后重试");
    }
    const [{ ExecutorRuntimeSubstrate }, { DurableConversationInteractionObserver }] =
      await Promise.all([
        import("../serve/executor-role-runtime.js"),
        import("../serve/durable-conversation-interactions.js"),
      ]);
    mcpHub = createMcpHub(
      parseServerSpecs(startup.config.mcp, startup.credentials.mcp),
      { networkProxy: startup.config.network?.proxy },
    );
    await mcpHub.connectAll();
    const runtimeSubstrate = new ExecutorRuntimeSubstrate({
      config: startup.config,
      credentials: startup.credentials.providers
        ? { providers: startup.credentials.providers }
        : {},
      mcpHub,
      systemProtectedPaths: resolveSystemProtectedSecretPaths(),
      interactions: new DurableConversationInteractionObserver(),
      artifactStore: () => {
        if (!runtime) throw new Error("Executor artifact store is not ready");
        return runtime.artifacts;
      },
      deviceCapacity: {
        interactive: capacity.workload("workload-interactive"),
        scheduler: capacity.workload("workload-scheduler"),
        orchestration: capacity.workload("workload-orchestration"),
      },
    });
    runtime = await setupAuthorityRuntime({
      zhixingHome,
      secretStore,
      deviceKey: mesh.deviceKey,
      trustedIdentities: mesh.trustedIdentities,
      authorizedDeviceIds: mesh.authorizedDeviceIds,
      executorId: executorIdForDevice(mesh.deviceKey.deviceId),
      configurationSnapshot: {
        config: startup.config,
        executableVersion: (await import("../version.js")).ZHIXING_CLI_VERSION,
      },
      executorReadiness: createExecutorReadinessSource({
        runtime: runtimeSubstrate,
        credentials: startup.credentials,
        credentialGeneration: startup.credentialGeneration,
      }),
      enableAnchor: false,
      enableLocalExecutor: true,
      storageMaintenance: capacity.storage,
      deviceCapacity: capacity.arbiter,
    });
    const admin = runtime.workspaceBindingAdmin;
    const recovery = runtime.workspaceBindingRecovery;
    if (!admin || !recovery) throw new Error("本机工作区管理能力不可用");
    host = createExecutorLocalWorkspaceHost({
      identity: defineLocalWorkspaceAssemblyIdentity(mesh.roles, owner),
      host: {
        zhixingHome,
        management: {
          deviceId: runtime.deviceId,
          executorId: executorIdForDevice(runtime.deviceId),
          admin,
          recovery,
          resources: runtime.executorResourceGovernor,
        },
        storageMaintenance: capacity.storage,
      },
    });
    if (!host) throw new Error("本机工作区管理能力不可用");
    await host.start();
    return await useLocalWorkspaceClient(
      createLocalWorkspaceClient(zhixingHome),
      operation,
      delivery,
    );
  } finally {
    await host?.close().catch(() => undefined);
    await runtime?.startupCleanup.run().catch(() => undefined);
    await mcpHub?.dispose().catch(() => undefined);
    await mesh?.bootstrapStore.stopStorageMaintenance();
    await owner?.release();
  }
}

export async function useLocalWorkspaceClient<T, R>(
  client: LocalWorkspaceClient,
  operation: (workspace: LocalWorkspaceClient) => Promise<T>,
  delivery: LocalWorkspaceDelivery<T, R>,
): Promise<R> {
  for (;;) {
    try {
      const result = await operation(client);
      const delivered = await delivery.result(
        result,
        client.consumptionCredential(),
      );
      await client.confirmDelivered();
      return delivered;
    } catch (error) {
      if (error instanceof CompletedLocalWorkspaceOperationError) {
        const credential = client.consumptionCredential();
        if (!credential) {
          throw new Error(
            "Completed local workspace failure has no recoverable consumption credential",
            { cause: error },
          );
        }
        await delivery.failure(error, credential);
        await client.confirmDelivered();
        error.markDeliveryConfirmed();
        throw error;
      }
      if (!(error instanceof RecoveredLocalWorkspaceOperationsError)) throw error;
      await delivery.recovered(
        error.operations.map((operation) =>
          recoveryNoticeOf(error.outboxId, operation)),
      );
      await client.confirmDelivered();
    }
  }
}

async function renderLocalWorkspaceFailure(
  error: CompletedLocalWorkspaceOperationError,
  writer: ReturnType<typeof createStdoutWriter>,
): Promise<void> {
  const { renderError } = await import("../render.js");
  renderError(error, writer);
}

function recoveryNoticeOf(
  outboxId: string,
  operation: WorkspaceAdministrationDurableOperationRecord,
): LocalWorkspaceRecoveryNotice {
  const result = operation.result as
    | {
        readonly ok?: unknown;
        readonly error?: { readonly code?: unknown; readonly message?: unknown };
      }
    | undefined;
  const failed = result?.ok === false;
  const error = result?.error;
  const controlWorkspace = controlWorkspaceResult(operation);
  return {
    operationId: operation.operationId,
    operation: operation.input.kind,
    target: workspaceAdministrationOperationTarget(operation.input),
    outcome: failed ? "failed" : "succeeded",
    credential: {
      outboxId,
      localSeq: operation.localSeq,
      operationId: operation.operationId,
      inputDigest: operation.inputDigest,
      resultDigest: operation.resultDigest!,
    },
    ...(controlWorkspace ? { controlWorkspace } : {}),
    ...(failed && typeof error?.code === "string" && typeof error.message === "string"
      ? { error: { code: error.code, message: error.message } }
      : {}),
  };
}

function controlWorkspaceResult(
  operation: WorkspaceAdministrationDurableOperationRecord,
): WorkspaceControlAuthorization | undefined {
  if (
    operation.input.kind !== "create" ||
    operation.input.purpose !== "control"
  ) return undefined;
  const result = operation.result as
    | { readonly ok?: unknown; readonly value?: unknown }
    | undefined;
  if (
    result?.ok !== true ||
    !result.value ||
    typeof result.value !== "object" ||
    Array.isArray(result.value)
  ) return undefined;
  return validateWorkspaceControlAuthorization(result.value);
}
