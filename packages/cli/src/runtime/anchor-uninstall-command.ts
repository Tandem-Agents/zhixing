import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  CoreHostConnection,
  defaultCoreHostConnectionDeps,
} from "./core-host-connection.js";
import {
  RpcManagementFacade,
  type AnchorUninstallPreflight,
  type AnchorUninstallState,
} from "./rpc-management-facade.js";
import {
  encodeRecoveryPackage,
  requireCurrentRecoveryPackage,
} from "@zhixing/mesh/recovery-package";
import { readRecoveryPackageFromTty } from "../serve/recovery-package-input.js";

export interface AnchorUninstallIO {
  readonly interactive: boolean;
  choosePath(preflight: AnchorUninstallPreflight): Promise<
    | { readonly path: "migration"; readonly targetName: string }
    | { readonly path: "recovery-backup" }
  >;
  confirm(message: string): Promise<boolean>;
  readRecoveryPackage(): Promise<string>;
}

export async function uninstallCurrentDevice(input: {
  readonly targetName?: string;
  readonly recoveryBackup?: boolean;
  readonly confirmed?: boolean;
}, io: AnchorUninstallIO = defaultUninstallIO()): Promise<void> {
  if (input.targetName && input.recoveryBackup) {
    throw new TypeError("只能选择另一台值班设备或恢复备份中的一种安全路径");
  }
  await withManagement(async (management) => {
    const preflight = await management.anchorUninstallPreflight();
    const path = await selectPath(preflight, input, io);
    await requireConfirmation(
      io,
      input.confirmed,
      path.path === "migration"
        ? `永久移除设备“${preflight.currentDeviceName}”。本机尚未转移的已接受工作会先安全收束，再把值班职责交给“${path.targetName}”；本机数据和设备身份随后永久删除，无法恢复。继续吗？`
        : `永久移除设备“${preflight.currentDeviceName}”。本机尚未转移的已接受工作会先安全收束，并只保留已验证的恢复备份；本机数据和设备身份随后永久删除，无法恢复。继续吗？`,
    );

    const operationId = createOpaqueId("uninstall");
    const requestId = createOpaqueId("request");
    const recoveryPackage = path.path === "recovery-backup"
      ? await io.readRecoveryPackage()
      : undefined;
    let state = path.path === "migration"
      ? await management.anchorUninstallBegin({
          path: "migration",
          requestId,
          operationId,
          transferId: createOpaqueId("transfer"),
          targetName: path.targetName,
        })
      : await management.anchorUninstallBegin({
          path: "recovery-backup",
          requestId,
          operationId,
          recoveryPackage: recoveryPackage!,
        });

    if (state.phase === "backup-verified") {
      await requireConfirmation(
        io,
        input.confirmed,
        "恢复备份已完成实际回读验证。卸载后只能依靠该备份重新接管，确认继续吗？",
      );
      state = await management.anchorUninstallContinue({
        operationId,
        confirmBackup: true,
        recoveryPackage: recoveryPackage!,
      });
    }
    renderUninstallState(state);
  });
}

export async function selectPath(
  preflight: AnchorUninstallPreflight,
  input: { readonly targetName?: string; readonly recoveryBackup?: boolean },
  io: AnchorUninstallIO,
): Promise<
  | { readonly path: "migration"; readonly targetName: string }
  | { readonly path: "recovery-backup" }
> {
  if (input.recoveryBackup) {
    if (!preflight.recoveryBackupReady) {
      throw new Error("当前没有已验证且可写的恢复备份");
    }
    return { path: "recovery-backup" };
  }
  const requested = input.targetName?.trim();
  if (requested) {
    const matches = preflight.migrationTargets.filter((candidate) =>
      candidate.ready && candidate.displayName === requested);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `没有名为“${requested}”且已就绪的接班设备`
        : `存在多个名为“${requested}”的设备，请先为设备设置唯一名称`);
    }
    return { path: "migration", targetName: requested };
  }
  if (!io.interactive) {
    throw new TypeError("非交互环境必须提供 --device <唯一名称> 或 --recovery-backup");
  }
  return io.choosePath(preflight);
}

export function renderUninstallState(state: AnchorUninstallState): void {
  const labels: Record<AnchorUninstallState["phase"], string> = {
    "choose-safe-path": "请先选择可用的接班设备或验证恢复备份",
    "moving-duty-device": "正在把值班职责交给另一台设备",
    "backup-verified": "恢复备份已验证，等待最终确认",
    "retiring-device": "正在完成永久卸载前的最终恢复备份",
    "ready-to-uninstall": "安全前提已完成，正在清退这台设备",
    uninstalled: "这台设备已永久卸载",
    cancelled: "永久卸载已取消",
  };
  console.log(labels[state.phase]);
}

function createOpaqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(10).toString("base64url")}`;
}

async function requireConfirmation(
  io: AnchorUninstallIO,
  confirmed: boolean | undefined,
  message: string,
): Promise<void> {
  if (confirmed === true) return;
  if (!io.interactive) throw new TypeError("非交互环境必须同时提供 --confirm");
  if (!await io.confirm(message)) throw new Error("操作已取消");
}

function defaultUninstallIO(): AnchorUninstallIO {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const question = async (prompt: string): Promise<string> => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await reader.question(prompt)).trim();
    } finally {
      reader.close();
    }
  };
  return {
    interactive,
    async choosePath(preflight) {
      const targets = preflight.migrationTargets.filter((candidate) => candidate.ready);
      console.log("请选择永久卸载前的安全路径：");
      targets.forEach((candidate, index) =>
        console.log(`${index + 1}. 把值班职责交给 ${candidate.displayName}`));
      if (preflight.recoveryBackupReady) {
        console.log(`${targets.length + 1}. 使用已验证的恢复备份`);
      }
      const selected = Number(await question("序号：")) - 1;
      if (selected >= 0 && selected < targets.length) {
        return { path: "migration", targetName: targets[selected]!.displayName };
      }
      if (preflight.recoveryBackupReady && selected === targets.length) {
        return { path: "recovery-backup" };
      }
      throw new TypeError("安全路径序号无效");
    },
    async confirm(message) {
      return (await question(`${message} 输入“确认”继续：`)) === "确认";
    },
    async readRecoveryPackage() {
      const decoded = requireCurrentRecoveryPackage(
        await readRecoveryPackageFromTty(),
      );
      return encodeRecoveryPackage(decoded.root);
    },
  };
}

async function withManagement<T>(
  operation: (management: RpcManagementFacade) => Promise<T>,
): Promise<T> {
  const coreHost = new CoreHostConnection(defaultCoreHostConnectionDeps());
  try {
    await coreHost.ensure();
    return await operation(new RpcManagementFacade(coreHost));
  } finally {
    await coreHost.dispose();
  }
}
