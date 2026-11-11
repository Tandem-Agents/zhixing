import type { RuntimeLogContext } from "../logging/runtime.js";
import { AUTHORITY_LOG_SOURCE } from "@zhixing-ai/core/authority";
import { CONFIGURATION_LOG_SOURCE } from "@zhixing-ai/providers";
import { MCP_LOG_SOURCE } from "./mcp-runtime-adapter.js";
import { createKernelLogFactory } from "@zhixing-ai/orchestrator/runtime";
import path from "node:path";
import { getZhixingHome } from "@zhixing-ai/core/paths";
import { protocolDigest } from "@zhixing-ai/core/protocol";
import { createPlatformSecretStore } from "@zhixing-ai/secrets";
import { createStdoutWriter } from "../screen/cli-writer.js";
import { setupAuthorityRuntime } from "../setup-delivery.js";
import { createDeviceCapacityRuntime } from "../serve/device-capacity-runtime.js";
import { executorIdForDevice } from "../serve/mesh-runtime-assembly.js";
import { prepareMeshRuntimeBootstrap } from "../serve/mesh-runtime-bootstrap.js";
import { createPlannedAnchorTransferStagingInfrastructure } from "../serve/planned-anchor-transfer-staging-infrastructure.js";
import { createDisasterRecoveryStagingInfrastructure } from "../serve/disaster-recovery-staging-infrastructure.js";
import { runStartupCheck } from "../startup.js";
import { parseServerSpecs } from "./mcp-config.js";
import { createHostMcpRuntime } from "./mcp-runtime-adapter.js";
import type { HostMcpRuntimePorts } from "./mcp-runtime-ports.js";
import { projectRuntimeConfiguration } from "./runtime-configuration-projections.js";
import { resolveSystemProtectedSecretPaths } from "../security/secret-boundary.js";
import { createHostKernelToolImplementation } from "./kernel-tool-implementation.js";
import { createPermissionStorageInfrastructure } from "../serve/permission-storage-infrastructure.js";
import { createExecutorReadinessSource } from "../serve/executor-readiness.js";
import {
  createLocalWorkspaceClient,
  localWorkspaceHostIsReachable,
  LocalWorkspaceHostNotWritableError,
  type LocalWorkspaceManagementHost,
  type LocalWorkspaceClient,
  type LocalWorkspaceCatalogStatus,
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
  CompletedWorkspaceAdministrationOperationError,
  RecoveredWorkspaceAdministrationOperationsError,
  type WorkspaceAdministrationConsumptionCredential,
  type WorkspaceAdministrationDurableOperationRecord,
  type WorkspaceAdministrationView,
  type WorkspaceControlAuthorization,
} from "@zhixing-ai/core/environment/workspace-administration";
import type {
  WorksceneSummary,
} from "@zhixing-ai/rpc";

export function worksceneCreateRequestIdForLocalWorkspace(
  credential: WorkspaceAdministrationConsumptionCredential,
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
  readonly credential: WorkspaceAdministrationConsumptionCredential;
  readonly controlWorkspace?: {
    readonly deviceId: string;
    readonly bindingRef: string;
  };
  readonly error?: { readonly code: string; readonly message: string };
}

interface LocalWorkspaceDelivery<T, R> {
  readonly result: (
    value: T,
    credential: WorkspaceAdministrationConsumptionCredential | undefined,
  ) => Promise<R>;
  readonly recovered: (
    operations: readonly LocalWorkspaceRecoveryNotice[],
  ) => Promise<void>;
  readonly failure: (
    error: CompletedWorkspaceAdministrationOperationError,
    credential: WorkspaceAdministrationConsumptionCredential,
  ) => Promise<void>;
}

/**
 * 本机工作区命令：结果按各操作给出的说明输出（面向用户的中文结果）；没给说明的操作保留原样结构化输出。
 * 内部诊断码换成用户能照着做的说明，诊断原文仍在日志与内部链路里。
 */
export async function runWorkspaceCommand<T>(
  operation: (workspace: LocalWorkspaceClient) => Promise<T>,
  logging?: RuntimeLogContext,
  describe?: (result: T) => readonly string[],
): Promise<void> {
  const zhixingHome = getZhixingHome();
  const writer = createStdoutWriter();
  try {
    await withLocalWorkspaceClient(operation, {
      result: async (result) => {
        if (result === undefined) return;
        writer.line(describe ? describe(result).join("\n") : JSON.stringify(result, null, 2));
      },
      recovered: async (operations) => {
        if (operations.some(({ controlWorkspace }) => controlWorkspace)) {
          throw new Error(
            "检测到尚未完成工作场景创建的本机工作区授权，请先启动交互终端完成恢复",
          );
        }
        // 呈现并确认后本命令会接着执行，不需要用户重跑
        writer.line(describeRecoveredOperations(operations).join("\n"));
      },
      failure: (error) => renderLocalWorkspaceFailure(error, writer),
    }, zhixingHome, logging);
  } catch (error) {
    // 已经渲染并确认投递的失败原样抛出：入口据此不再重复显示
    if (error instanceof Error && (error as { deliveryConfirmed?: unknown }).deliveryConfirmed === true) throw error;
    throw localWorkspaceUserError(error);
  }
}

const RECOVERED_OPERATION_LABEL: Record<LocalWorkspaceRecoveryNotice["operation"], string> = {
  create: "授权工作区",
  rename: "改名",
  repath: "改目录",
  remove: "移除工作区",
  reset: "重置工作区目录",
};

/** 上次中断、这次补完的操作逐条说明：做了什么、对象、结果。 */
export function describeRecoveredOperations(
  operations: readonly LocalWorkspaceRecoveryNotice[],
): readonly string[] {
  return [
    `已补完上次中断的 ${operations.length} 个本机工作区操作：`,
    ...operations.map((operation) =>
      `  ${RECOVERED_OPERATION_LABEL[operation.operation]}「${operation.target}」：${
        operation.outcome === "succeeded"
          ? "成功"
          : `未完成（${operation.error
            ? localWorkspaceCodeText(operation.error.code)?.replace(/。$/u, "") ?? operation.error.message
            : "原因未记录"}）`
      }`),
  ];
}

const LIFECYCLE_PROGRESS: Record<string, string> = {
  LOCAL_WORKSPACE_RECOVERING: "正在打开操作记录",
  LOCAL_WORKSPACE_RECOVERING_COMMITTED: "正在补做已确认的操作，超过了等待上限",
  LOCAL_WORKSPACE_COMMITTED_DRAIN: "正在执行已确认的操作，超过了等待上限",
};

/** 本机工作区诊断码 → 用户说明；不认识的码保留原错误。 */
export function localWorkspaceUserError(error: unknown): unknown {
  if (error instanceof LocalWorkspaceHostNotWritableError) {
    const which = error.localSeq === undefined ? "上次的操作" : `上次的第 ${error.localSeq} 号操作`;
    // 生命周期自己的恢复码说明进度；其余是恢复途中遇到的具体基础设施原因，原样带上
    const reason = LIFECYCLE_PROGRESS[error.code] ?? `${error.message}，诊断码 ${error.code}`;
    const text = error.hostState === "degraded"
      ? `本机工作区${which}无法自动完成：${error.message}（诊断码 ${error.code}）。`
      : error.hostState === "recovering"
        ? `本机工作区${which}还没完成（${reason}）；再次运行会接着完成它。`
        : "本机工作区管理正在关闭；请重新运行命令。";
    return Object.assign(new Error(text, { cause: error }), { code: error.code });
  }
  const raw = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  const code = typeof raw === "string" ? raw : undefined;
  const text = code === undefined ? undefined : localWorkspaceCodeText(code);
  if (!text) return error;
  return Object.assign(new Error(text, { cause: error }), { code });
}

const LOCAL_WORKSPACE_PENDING_CODES = new Set([
  "LOCAL_WORKSPACE_RECOVERING",
  "LOCAL_WORKSPACE_RECOVERING_COMMITTED",
  "LOCAL_WORKSPACE_COMMITTED_DRAIN",
  "LOCAL_WORKSPACE_DRAINING",
  "LOCAL_WORKSPACE_HOST_NOT_READY",
]);

const LOCAL_WORKSPACE_CODE_TEXT: Record<string, string> = {
  LOCAL_WORKSPACE_NOT_FOUND: "没有找到这个工作区；可用 zz workspace list 查看已授权的工作区。",
  LOCAL_WORKSPACE_NAME_CONFLICT: "本机有不止一个同名工作区，无法确定要操作哪一个。",
  LOCAL_WORKSPACE_NAME_IN_USE: "已有同名工作区，请换一个名称。",
  WORKSPACE_BINDING_REVISION: "工作区记录已变化；请先运行 zz workspace list 查看最新修订号再重试。",
  LOCAL_WORKSPACE_CATALOG_CHANGED: "工作区目录世代已经变化；请运行 zz workspace status 查看当前目录世代，需要时重新预览。",
  LOCAL_WORKSPACE_CATALOG_HEALTHY: "本机工作区目录正常，无需也不能重置。",
  // 重置的冲突都发生在确认之后：目录状态在预览与确认之间变了，这份确认凭据不再适用
  WORKSPACE_CATALOG_CONFLICT: "工作区目录状态已经变化，这份重置确认不再适用；请运行 zz workspace status 查看当前状态，需要时重新预览。",
};

/** 本机工作区诊断码对应的用户说明；不认识的码返回 undefined，由调用方保留原文。 */
function localWorkspaceCodeText(code: string): string | undefined {
  return LOCAL_WORKSPACE_PENDING_CODES.has(code)
    ? "本机工作区正在完成上次的操作，请稍后重试。"
    : LOCAL_WORKSPACE_CODE_TEXT[code];
}

/** 各 workspace 子命令的结果说明。修订号与目录世代是后续命令要用的参数，随结果给出。 */
export const describeWorkspaceResult = {
  status: (status: LocalWorkspaceCatalogStatus): readonly string[] => [
    `本机工作区目录：${status.state === "healthy" ? "正常" : status.state}`,
    `目录世代：${status.catalogGeneration}（灾难恢复重置时用 --generation 指定）`,
  ],
  list: (views: readonly WorkspaceAdministrationView[]): readonly string[] => views.length === 0
    ? ["还没有已授权的本机工作区。可用 zz workspace create <名称> <路径> 授权。"]
    : [...views.map((view) => `${view.name}  ${view.path}  （修订 ${view.revision}）`), "改名、改目录、移除时用 --revision 指定对应修订号。"],
  created: (view: WorkspaceAdministrationView): readonly string[] => [`已授权工作区「${view.name}」：${view.path}（修订 ${view.revision}）`],
  renamed: (view: WorkspaceAdministrationView): readonly string[] => [`已改名为「${view.name}」（修订 ${view.revision}）`],
  repathed: (view: WorkspaceAdministrationView): readonly string[] => [`已把「${view.name}」的目录改为 ${view.path}（修订 ${view.revision}）`],
  removed: (name: string): readonly string[] => [`已移除工作区「${name}」的授权。`],
};

/**
 * Public first-party automation entry for the same local authorization plus
 * workscene-create transaction used by the interactive assistant.
 */
export async function runWorkspaceSceneCreateCommand(
  sceneName: string,
  absolutePath: string,
  logging?: RuntimeLogContext,
): Promise<void> {
  const writer = createStdoutWriter();
  const zhixingHome = getZhixingHome();
  const coreHost = new CoreHostConnection(defaultCoreHostConnectionDeps(zhixingHome));
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
      zhixingHome,
      logging,
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
  credential: WorkspaceAdministrationConsumptionCredential,
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
  credential: WorkspaceAdministrationConsumptionCredential,
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
  zhixingHome: string,
  logging?: RuntimeLogContext,
): Promise<R> {
  const existing = createLocalWorkspaceClient(zhixingHome);
  if (await localWorkspaceHostIsReachable(zhixingHome)) {
    return useLocalWorkspaceClient(existing, operation, delivery);
  }

  let runtime: Awaited<ReturnType<typeof setupAuthorityRuntime>> | undefined;
  let mesh: Awaited<ReturnType<typeof prepareMeshRuntimeBootstrap>> | undefined;
  let host: LocalWorkspaceManagementHost | undefined;
  let mcpRuntime: HostMcpRuntimePorts | undefined;
  let disasterRecoveryStaging: ReturnType<
    typeof createDisasterRecoveryStagingInfrastructure
  > | undefined;
  let owner: Awaited<ReturnType<typeof acquireExecutorLocalWorkspaceOwner>>;
  let ownedCapacity: ReturnType<typeof createDeviceCapacityRuntime> | undefined;
  try {
    const secretStore = createPlatformSecretStore({ homeDir: zhixingHome });
    const startup = await runStartupCheck({
      homeDir: zhixingHome,
      mode: "host",
      records: logging?.bind(CONFIGURATION_LOG_SOURCE, { scope: "storage" }),
      secretStore,
    });
    if (startup.kind !== "ready") {
      throw new Error("当前配置不足以启动本机工作区管理能力");
    }
    const configuration = projectRuntimeConfiguration(
      startup.runtimeConfiguration,
    );
    const capacity = logging?.capacity ?? (ownedCapacity = createDeviceCapacityRuntime(
      path.join(zhixingHome, "distributed-runtime", "capacity"),
    ));
    disasterRecoveryStaging = createDisasterRecoveryStagingInfrastructure({
      records: logging?.bind(AUTHORITY_LOG_SOURCE, { scope: "storage" }),
      zhixingHome,
      storageMaintenance: capacity.storage,
    });
    mesh = await prepareMeshRuntimeBootstrap({
      records: logging?.bind(AUTHORITY_LOG_SOURCE, { scope: "storage" }),
      zhixingHome,
      secretStore,
      storageMaintenance: capacity.storage,
      // 本进程先在这里打开 home 的权威日志：读取准入随首次打开定下，必须与随后装配运行时用同一个仲裁器
      deviceCapacity: capacity.arbiter,
      plannedAnchorTransferStaging: createPlannedAnchorTransferStagingInfrastructure({
        records: logging?.bind(AUTHORITY_LOG_SOURCE, { scope: "storage" }),
        zhixingHome,
        storageMaintenance: capacity.storage,
      }),
      disasterRecoveryStaging,
      ...(configuration.topology.mesh
        ? { configuration: configuration.topology.mesh }
        : {}),
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
    mcpRuntime = createHostMcpRuntime(
      parseServerSpecs(
        configuration.mcp.mcp,
        startup.mcpCredentials.mcp,
      ),
      { networkProxy: configuration.mcp.network?.proxy, records: logging?.bind(MCP_LOG_SOURCE, { scope: "storage" }) },
    );
    await mcpRuntime.lifecycle.connect();
    const runtimeSubstrate = new ExecutorRuntimeSubstrate({
      createLogRecords: logging ? createKernelLogFactory(logging.bind, MCP_LOG_SOURCE) : undefined,
      zhixingHome,
      modelConfiguration: configuration.model,
      kernelEnvironmentConfiguration: configuration.kernelEnvironment,
      credentials: startup.providerCredentials,
      createToolImplementation: createHostKernelToolImplementation,
      permissionStorage:
        createPermissionStorageInfrastructure({ zhixingHome }).runtime,
      mcpTools: mcpRuntime.tools,
      systemProtectedPaths: resolveSystemProtectedSecretPaths(zhixingHome),
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
      records: logging?.bind(AUTHORITY_LOG_SOURCE, { scope: "storage" }),
      zhixingHome,
      secretStore,
      deviceKey: mesh.deviceKey,
      trustedIdentities: mesh.trustedIdentities,
      authorizedDeviceIds: mesh.authorizedDeviceIds,
      executorId: executorIdForDevice(mesh.deviceKey.deviceId),
      configurationSnapshot: {
        config: configuration.authority,
        executableVersion: (await import("../version.js")).ZHIXING_CLI_VERSION,
      },
      executorReadiness: createExecutorReadinessSource({
        runtime: runtimeSubstrate,
        credentials: startup.credentialExposureCredentials,
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
    try {
      await host?.close().catch(() => undefined);
      await runtime?.startupCleanup.run().catch(() => undefined);
      await mcpRuntime?.lifecycle.close().catch(() => undefined);
      await mesh?.bootstrapStore.stopStorageMaintenance();
      await disasterRecoveryStaging?.close();
      await owner?.release();
    } finally { ownedCapacity?.close(); }
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
      if (error instanceof CompletedWorkspaceAdministrationOperationError) {
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
      if (!(error instanceof RecoveredWorkspaceAdministrationOperationsError)) throw error;
      await delivery.recovered(
        error.operations.map((operation) =>
          recoveryNoticeOf(error.outboxId, operation)),
      );
      await client.confirmDelivered();
    }
  }
}

async function renderLocalWorkspaceFailure(
  error: CompletedWorkspaceAdministrationOperationError,
  writer: ReturnType<typeof createStdoutWriter>,
): Promise<void> {
  const { renderError } = await import("../render.js");
  const localized = localWorkspaceUserError(error);
  renderError(localized instanceof Error ? localized : error, writer);
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
