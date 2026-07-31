import path from "node:path";
import { getZhixingHome } from "@zhixing/core";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { createStdoutWriter } from "../screen/cli-writer.js";
import { setupAuthorityRuntime } from "../setup-delivery.js";
import { createDeviceCapacityRuntime } from "../serve/device-capacity-runtime.js";
import { executorIdForDevice } from "../serve/mesh-runtime-assembly.js";
import { LocalWorkspaceFacade } from "./local-workspace-facade.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "./workspace-reset-impact.js";

export { WORKSPACE_CATALOG_RESET_IMPACT };

export async function runWorkspaceCommand(
  operation: (workspace: LocalWorkspaceFacade) => Promise<unknown>,
): Promise<void> {
  const result = await withLocalWorkspaceFacade(operation);
  if (result !== undefined) {
    createStdoutWriter().line(JSON.stringify(result, null, 2));
  }
}

export async function withLocalWorkspaceFacade<T>(
  operation: (workspace: LocalWorkspaceFacade) => Promise<T>,
): Promise<T> {
  const zhixingHome = getZhixingHome();
  const capacity = createDeviceCapacityRuntime(
    path.join(zhixingHome, "runtime", "workspace-settings-capacity"),
  );
  const runtime = await setupAuthorityRuntime({
    zhixingHome,
    secretStore: createPlatformSecretStore({ homeDir: zhixingHome }),
    enableAnchor: false,
    enableLocalExecutor: true,
    deviceCapacity: capacity.arbiter,
    storageMaintenance: capacity.storage,
  });
  const admin = runtime.workspaceBindingAdmin;
  const recovery = runtime.workspaceBindingRecovery;
  if (!admin || !recovery) {
    await runtime.startupCleanup.run();
    throw new Error("本机工作区管理能力不可用");
  }
  try {
    return await operation(
      new LocalWorkspaceFacade({
        deviceId: runtime.deviceId,
        executorId: executorIdForDevice(runtime.deviceId),
        admin,
        recovery,
        resources: runtime.executorResourceGovernor,
      }),
    );
  } finally {
    await runtime.startupCleanup.run();
  }
}
