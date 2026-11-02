import { stat } from "node:fs/promises";
import path from "node:path";
import { getZhixingHome } from "@zhixing/core/paths";
import { loadConfig } from "@zhixing/providers";
import type { BackupTargetConfigurationRepository } from "../serve/backup-target-config.js";
import { createBackupTargetConfigurationInfrastructure } from "../serve/backup-target-config-infrastructure.js";
import {
  buildManagedHostPublicStatus,
  readOfflineStatusSnapshot,
  type StatusDeps,
} from "../serve/status.js";
import { projectMeshCompatibilityHealth } from "../serve/mesh-compatibility-state.js";
import { formatVersionMaintenanceAction } from "./version-maintenance-action.js";

export interface DoctorReport {
  readonly code:
    | "healthy"
    | "setup-required"
    | "local-runtime-needs-attention"
    | "local-state-unreadable"
    | "device-maintenance-required"
    | "connection-state-unreadable"
    | "backup-setup-incomplete";
  readonly message: string;
  readonly action?: string;
}

/** 本机信任里的恢复根状态：no-trust 表示还没有建链（单机），不涉及恢复根。 */
export type LocalRecoveryRootState = "established" | "missing" | "no-trust";

export interface DoctorDeps {
  readonly homeDir: string;
  readonly backupTargets: BackupTargetConfigurationRepository;
  readonly statusDeps?: StatusDeps;
  readonly configExists?: () => Promise<boolean>;
  readonly inspectConfig?: () => void;
  readonly inspectManaged?: () => Promise<{ readonly state: string; readonly action?: string }>;
  readonly inspectRecoveryRoot?: () => Promise<LocalRecoveryRootState>;
}

export function inspectDefaultLocalHealth(): Promise<DoctorReport> {
  const homeDir = path.resolve(getZhixingHome());
  return inspectLocalHealth({
    homeDir,
    backupTargets: createBackupTargetConfigurationInfrastructure(homeDir),
  });
}

export async function inspectLocalHealth(deps: DoctorDeps): Promise<DoctorReport> {
  const homeDir = path.resolve(deps.homeDir);
  try {
    const configExists = await (deps.configExists ?? (() => fileExists(path.join(homeDir, "config.jsonc"))))();
    if (!configExists) {
      return {
        code: "setup-required",
        message: "知行尚未完成首次设置",
        action: "运行 zz 完成设置",
      };
    }
    (deps.inspectConfig ?? (() => { loadConfig({ homeDir, noAutoCreate: true }); }))();
    const backupTargets = await deps.backupTargets.load();
    const local = await readOfflineStatusSnapshot(deps.statusDeps);
    const managed = await (deps.inspectManaged ?? (async () => {
      return buildManagedHostPublicStatus(local.report);
    }))();
    if (managed.state === "needs-attention") {
      return {
        code: "local-runtime-needs-attention",
        message: "本机运行状态需要处理",
        action: managed.action ?? "运行 zz 恢复托管",
      };
    }
    if (local.report.status === "running" && local.lock) {
      const compatibility = projectMeshCompatibilityHealth(local.lock, local.state);
      if (compatibility.kind === "unknown") {
        return {
          code: "connection-state-unreadable",
          message: "设备连接状态无法安全确认",
          action: "重启知行后再次运行 zz doctor",
        };
      }
      if (compatibility.kind === "local-older") {
        return {
          code: "device-maintenance-required",
          message: "这台设备需要更新后才能恢复完整协作",
          action: formatVersionMaintenanceAction({ kind: "local-device" }),
        };
      }
      if (compatibility.kind === "peers-older") {
        const [firstDisplayName, ...remainingDisplayNames] = compatibility.peerDisplayNames;
        if (firstDisplayName === undefined) {
          throw new TypeError("维护目标设备不能为空");
        }
        return {
          code: "device-maintenance-required",
          message: "部分设备需要更新后才能恢复完整协作",
          action: formatVersionMaintenanceAction({
            kind: "peer-devices",
            displayNames: [firstDisplayName, ...remainingDisplayNames],
          }),
        };
      }
    }
    // 已选定备份目标、恢复根却没建立：上次设置没走完。普通对话不受影响，但不能当作备份已就绪
    if (backupTargets &&
        await (deps.inspectRecoveryRoot ?? (() => readLocalRecoveryRoot(homeDir)))() === "missing") {
      const current = backupTargets.bindings.find((binding) => binding.targetId === backupTargets.currentTargetId);
      return {
        code: "backup-setup-incomplete",
        message: "恢复备份设置未完成，恢复根尚未建立，还没有可恢复的副本",
        action: current?.kind === "directory"
          ? `在完整交互终端运行 zz backup setup --directory "${current.directory}"，按提示保存并回读恢复包`
          : "在完整交互终端重新运行 zz backup setup 选择原来的备份目标，按提示保存并回读恢复包",
      };
    }
    return { code: "healthy", message: "知行本机状态正常" };
  } catch {
    return {
      code: "local-state-unreadable",
      message: "本机状态无法安全确认",
      action: "运行 zz doctor 重试；若仍失败，请修复本机配置或凭据",
    };
  }
}

export function printDoctorReport(
  report: DoctorReport,
  output: Pick<Console, "log"> = console,
): void {
  output.log(report.message);
  if (report.code !== "healthy") output.log(`问题码：${report.code}`);
  if (report.action) output.log(`下一步：${report.action}`);
}

/** 只读取当前信任的恢复根状态；不解锁秘密存储、不创建权威文件。 */
async function readLocalRecoveryRoot(homeDir: string): Promise<LocalRecoveryRootState> {
  const { FileMeshBootstrapStore } = await import("../serve/mesh-bootstrap-store.js");
  const store = await FileMeshBootstrapStore.open(homeDir, undefined, { readOnly: true });
  try {
    const trust = await store.loadCurrentTrust();
    if (!trust) return "no-trust";
    // 只有两把公钥都缺才是“从未建根”；只剩一把是不一致，由启动引导校验拒绝，不在这里当成设置未完成
    return !trust.recoveryRootPublicKey && !trust.recoveryBackupPublicKey ? "missing" : "established";
  } finally {
    await store.stopStorageMaintenance();
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
