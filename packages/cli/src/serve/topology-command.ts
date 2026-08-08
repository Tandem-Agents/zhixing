import type { ServeOptions } from "./command.js";
import { getZhixingHome } from "@zhixing/core";
import { createPlatformSecretStore } from "@zhixing/secrets";
import chalk from "chalk";
import { createStdoutWriter, type CliWriter } from "../screen/index.js";
import {
  runStartupCheck,
  type StartupCheckResult,
} from "../startup.js";
import { prepareMeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import {
  DEFAULT_LOCAL_ROLE_CONFIGURATION,
  runConfiguredServeTopology,
  type ServeRoleConfiguration,
} from "./role-topology.js";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";
import { runRecoveryRootEstablishmentTopology } from "./recovery-root-establishment-runtime.js";
import {
  acquireExecutorLocalWorkspaceOwner,
  defineLocalWorkspaceAssemblyIdentity,
} from "../runtime/local-workspace-bootstrap.js";

export {
  DEFAULT_LOCAL_ROLE_CONFIGURATION,
};
export type { ServeRoleConfiguration };
export type { ServeOptions };

export async function runServeCommand(
  options: ServeOptions,
  writer: CliWriter = createStdoutWriter(),
): Promise<void> {
  const zhixingHome = getZhixingHome();
  const secretStore = createPlatformSecretStore({ homeDir: zhixingHome });
  const startup = await runStartupCheck({
    homeDir: zhixingHome,
    mode: "host",
    secretStore,
  });
  if (startup.kind !== "ready") {
    renderStartupFailure(startup, writer);
    process.exit(startup.kind === "cancelled" ? 0 : 2);
    return;
  }
  const deviceCapacity = createDeviceCapacityRuntime(`${zhixingHome}/distributed-runtime/capacity`);
  let mesh: Awaited<ReturnType<typeof prepareMeshRuntimeBootstrap>> | undefined;
  let localWorkspaceOwner: Awaited<ReturnType<typeof acquireExecutorLocalWorkspaceOwner>> | undefined;
  try {
    mesh = await prepareMeshRuntimeBootstrap({
      zhixingHome,
      secretStore,
      storageMaintenance: deviceCapacity.storage,
      ...(startup.config.mesh ? { configuration: startup.config.mesh } : {}),
    });
    if (
      mesh.mode === "trusted-home" &&
      !mesh.trust.recoveryRootPublicKey &&
      !mesh.trust.recoveryBackupPublicKey
    ) {
      writer.line(chalk.dim("恢复根尚未建立；仅启动已配对设备的恢复副本通道。"));
      await runRecoveryRootEstablishmentTopology({
        zhixingHome,
        mesh,
        secretStore,
        storageMaintenance: deviceCapacity.storage,
      });
      mesh.bootstrapStore.stopStorageMaintenance();
      mesh = await prepareMeshRuntimeBootstrap({
        zhixingHome,
        secretStore,
        storageMaintenance: deviceCapacity.storage,
        ...(startup.config.mesh ? { configuration: startup.config.mesh } : {}),
      });
      if (
        mesh.mode !== "trusted-home" ||
        !mesh.trust.recoveryRootPublicKey ||
        !mesh.trust.recoveryBackupPublicKey
      ) throw new Error("恢复根激活后未形成可运行的耐久信任状态");
    }
    localWorkspaceOwner = await acquireExecutorLocalWorkspaceOwner(
      zhixingHome,
      mesh.roles,
    );
    await runConfiguredServeTopology(
      { roles: mesh.roles },
      {
        anchorHost: () => import("./anchor-role.js"),
        executorHost: () => import("./executor-role.js"),
        executor: () => import("@zhixing/executor"),
      },
      options,
      {
        mesh,
        deviceCapacity,
        secretStore,
        startup,
        localWorkspaceIdentity: defineLocalWorkspaceAssemblyIdentity(
          mesh.roles,
          localWorkspaceOwner,
        ),
      },
    );
  } finally {
    mesh?.bootstrapStore.stopStorageMaintenance();
    await localWorkspaceOwner?.release();
  }
}

function renderStartupFailure(
  result: Exclude<StartupCheckResult, { readonly kind: "ready" }>,
  writer: CliWriter,
): void {
  if (result.kind === "schema-error") {
    writer.line(chalk.red(`[配置错误] ${result.message}`));
    writer.line(chalk.dim(`请修复或删除文件后重试：${result.filePath}`));
  } else if (result.kind === "secret-store-error") {
    writer.line(chalk.red(`[秘密存储不可用] ${result.message}`));
    writer.line(chalk.dim(`设备本地目录：${result.filePath}`));
  } else if (result.kind === "semantic-error") {
    writer.line(chalk.red(
      `[配置错误] ${result.filePath} 含 ${result.issues.length} 处配置问题：`,
    ));
    writer.line("");
    for (const [index, issue] of result.issues.entries()) {
      writer.line(chalk.yellow(`${index + 1}. 字段：${issue.field}`));
      writer.line(chalk.dim(`   原因：${issue.reason}`));
      writer.line(chalk.dim(`   修复：${issue.fix}`));
      writer.line("");
    }
    writer.line(chalk.dim("修复后重启 server。"));
  } else if (result.kind === "non-tty") {
    writer.line(chalk.red("Server 缺少必要配置，且当前环境非交互终端。"));
    writer.line(chalk.dim("请先在交互终端运行 `zhixing` 完成基础配置。缺失项："));
    for (const label of result.missingLabels) {
      writer.line(chalk.dim(`  - ${label}`));
    }
  } else {
    writer.line(chalk.dim("已取消配置。"));
  }
}
