import { stat } from "node:fs/promises";
import path from "node:path";
import { getZhixingHome } from "@zhixing/core";
import { loadConfig } from "@zhixing/providers";
import { FileBackupTargetConfiguration } from "../serve/backup-target-config.js";
import {
  buildManagedHostPublicStatus,
  buildOfflineStatusReport,
  type StatusDeps,
} from "../serve/status.js";

export interface DoctorReport {
  readonly code: "healthy" | "setup-required" | "local-runtime-needs-attention" | "local-state-unreadable";
  readonly message: string;
  readonly action?: string;
}

export interface DoctorDeps {
  readonly homeDir?: string;
  readonly statusDeps?: StatusDeps;
  readonly configExists?: () => Promise<boolean>;
  readonly inspectConfig?: () => void;
  readonly inspectBackup?: () => Promise<void>;
  readonly inspectManaged?: () => Promise<{ readonly state: string; readonly action?: string }>;
}

export async function inspectLocalHealth(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const homeDir = path.resolve(deps.homeDir ?? getZhixingHome());
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
    await (deps.inspectBackup ?? (async () => {
      await new FileBackupTargetConfiguration(homeDir).load();
    }))();
    const managed = await (deps.inspectManaged ?? (async () => {
      const process = await buildOfflineStatusReport(deps.statusDeps);
      return buildManagedHostPublicStatus(process);
    }))();
    if (managed.state === "needs-attention") {
      return {
        code: "local-runtime-needs-attention",
        message: "本机运行状态需要处理",
        action: managed.action ?? "运行 zz 恢复托管",
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
