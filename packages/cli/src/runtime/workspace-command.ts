import path from "node:path";
import { getZhixingHome } from "@zhixing/core";
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
  LocalWorkspaceManagementHost,
  createLocalWorkspaceManagementHost,
  createLocalWorkspaceClient,
  localWorkspaceHostIsReachable,
  type LocalWorkspaceClient,
} from "./local-workspace-management-host.js";
import { acquireLocalWorkspaceOwner } from "./local-workspace-owner.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "./workspace-reset-impact.js";

export { WORKSPACE_CATALOG_RESET_IMPACT };

export async function runWorkspaceCommand(
  operation: (workspace: LocalWorkspaceClient) => Promise<unknown>,
): Promise<void> {
  const result = await withLocalWorkspaceFacade(operation);
  if (result !== undefined) createStdoutWriter().line(JSON.stringify(result, null, 2));
}

export async function withLocalWorkspaceFacade<T>(
  operation: (workspace: LocalWorkspaceClient) => Promise<T>,
): Promise<T> {
  const zhixingHome = getZhixingHome();
  const existing = createLocalWorkspaceClient(zhixingHome);
  if (await localWorkspaceHostIsReachable(zhixingHome)) return operation(existing);

  let owner;
  try {
    owner = await acquireLocalWorkspaceOwner(zhixingHome);
  } catch {
    throw new Error("本机工作区管理 owner 正在运行但不可达，请稍后重试");
  }

  let runtime: Awaited<ReturnType<typeof setupAuthorityRuntime>> | undefined;
  let mesh: Awaited<ReturnType<typeof prepareMeshRuntimeBootstrap>> | undefined;
  let host: LocalWorkspaceManagementHost | undefined;
  let mcpHub: ReturnType<typeof createMcpHub> | undefined;
  try {
    const raced = createLocalWorkspaceClient(zhixingHome);
    if (await localWorkspaceHostIsReachable(zhixingHome)) return operation(raced);

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
      deviceCapacity: {
        interactive: capacity.workload("workload-interactive"),
        scheduler: capacity.workload("workload-scheduler"),
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
    host = createLocalWorkspaceManagementHost({
      lease: owner,
      zhixingHome,
      facade: {
        deviceId: runtime.deviceId,
        executorId: executorIdForDevice(runtime.deviceId),
        admin,
        recovery,
        resources: runtime.executorResourceGovernor,
      },
      storageMaintenance: capacity.storage,
    });
    await host.start();
    return await operation(createLocalWorkspaceClient(zhixingHome));
  } finally {
    await host?.close().catch(() => undefined);
    await runtime?.startupCleanup.run().catch(() => undefined);
    await mcpHub?.dispose().catch(() => undefined);
    mesh?.bootstrapStore.stopStorageMaintenance();
    await owner.release();
  }
}
