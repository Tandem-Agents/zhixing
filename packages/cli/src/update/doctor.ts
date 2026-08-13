import {
  assertDurableSchemaInventory,
  type ProgramUpdateAction,
  type ProgramUpdateReceipt,
} from "@zhixing/core/protocol";
import {
  buildManagedHostPublicStatus,
  buildOfflineStatusReport,
  type ManagedHostPublicStatus,
  type StatusDeps,
} from "../serve/status.js";
import { FileBackupTargetConfiguration } from "../serve/backup-target-config.js";
import { getZhixingHome } from "@zhixing/core";
import { projectProgramUpdate } from "./update-controller.js";
import { EMBEDDED_RELEASE_TRUST } from "./release-channel.js";
import { createReleaseVerifier } from "./release-verifier.js";
import { ProgramStore } from "./program-store.js";

export interface ProgramDoctorReport {
  readonly code: string;
  readonly message: string;
  readonly release?: string;
  readonly action?: ProgramUpdateAction;
}

export interface ProgramDoctorDeps {
  readonly store?: ProgramStore;
  readonly statusDeps?: StatusDeps;
  readonly managedStatus?: (report: Awaited<ReturnType<typeof buildOfflineStatusReport>>) => Promise<ManagedHostPublicStatus>;
  readonly checkpointConfiguration?: () => Promise<"configured" | "not-configured">;
  readonly releaseTrust?: typeof EMBEDDED_RELEASE_TRUST;
}

export async function inspectProgramHealth(deps: ProgramDoctorDeps = {}): Promise<ProgramDoctorReport> {
  const store = deps.store ?? new ProgramStore();
  try {
    const pointer = await store.loadPointer();
    const receipt = await store.loadReceipt();
    const update = projectProgramUpdate(receipt);
    if (update.visible && update.action) {
      return {
        code: update.code ?? "update-needs-attention",
        message: update.message ?? "更新需要你处理",
        ...(update.release ? { release: update.release } : {}),
        action: update.action,
      };
    }
    const releaseProblem = await inspectInstalledRelease(store, pointer, receipt, deps.releaseTrust);
    if (releaseProblem) return releaseProblem;
    const status = await buildOfflineStatusReport(deps.statusDeps);
    const managed = await (deps.managedStatus ?? ((report) => buildManagedHostPublicStatus(report)))(status);
    if (managed.state === "needs-attention") {
      return {
        code: "local-runtime-needs-attention",
        message: managed.action ?? "本机运行状态需要处理",
        action: "contact-support",
      };
    }
    await (deps.checkpointConfiguration ?? defaultCheckpointConfiguration)();
    if (update.visible) {
      return {
        code: `update-${update.state ?? "active"}`,
        message: update.message ?? "正在处理更新",
        ...(update.release ? { release: update.release } : {}),
      };
    }
    return { code: "healthy", message: "知行状态正常" };
  } catch {
    return {
      code: "local-state-unreadable",
      message: "本机状态无法安全确认",
      action: "contact-support",
    };
  }
}

async function inspectInstalledRelease(
  store: ProgramStore,
  pointer: Awaited<ReturnType<ProgramStore["loadPointer"]>>,
  receipt: ProgramUpdateReceipt | undefined,
  configuredTrust: typeof EMBEDDED_RELEASE_TRUST,
): Promise<ProgramDoctorReport | undefined> {
  if (!pointer) {
    return {
      code: "program-not-installed",
      message: "知行应用尚未完整安装",
      action: "contact-support",
    };
  }
  const trust = configuredTrust ?? EMBEDDED_RELEASE_TRUST;
  if (!trust) {
    return {
      code: "release-trust-unavailable",
      message: "当前安装无法安全确认",
      action: "contact-support",
    };
  }
  const verifier = createReleaseVerifier(trust);
  const current = await store.loadCurrentManifest(verifier);
  if (!current || current.digest !== pointer.current.manifestDigest) {
    return recoveryProblem(pointer.previous !== undefined, pointer.current.releaseVersion);
  }
  assertDurableSchemaInventory(current.manifest.durableSchemas);
  if (
    receipt && receipt.phase !== "handed-off" &&
    receipt.currentManifestDigest !== current.digest
  ) {
    return recoveryProblem(pointer.previous !== undefined, current.manifest.releaseVersion);
  }
  if (
    receipt?.candidateManifestDigest &&
    (receipt.phase === "staged" || receipt.phase === "handed-off")
  ) {
    try {
      const staged = await store.loadStagedManifest(receipt.candidateManifestDigest, verifier);
      assertDurableSchemaInventory(staged.manifest.durableSchemas);
    } catch {
      return {
        code: "update-stage-invalid",
        message: "已下载的更新无法安全使用，仍在使用原版本",
        release: current.manifest.releaseVersion,
        action: "retry-update",
      };
    }
  }
  return undefined;
}

function recoveryProblem(hasPrevious: boolean, release: string): ProgramDoctorReport {
  return {
    code: "installed-release-invalid",
    message: hasPrevious ? "当前版本无法安全确认" : "当前安装无法安全确认",
    release,
    action: hasPrevious ? "restore-previous" : "contact-support",
  };
}

async function defaultCheckpointConfiguration(): Promise<"configured" | "not-configured"> {
  const configured = await new FileBackupTargetConfiguration(getZhixingHome()).load();
  return configured ? "configured" : "not-configured";
}

export function printProgramDoctorReport(
  report: ProgramDoctorReport,
  output: Pick<Console, "log"> = console,
): void {
  output.log(report.message);
  if (report.release) output.log(`版本：${report.release}`);
  if (report.code !== "healthy") output.log(`问题码：${report.code}`);
  if (report.action === "retry-update") output.log("下一步：运行 zz update 重试");
  if (report.action === "restore-previous") output.log("下一步：运行 zz update --restore-previous");
  if (report.action === "contact-support") output.log("下一步：联系支持并提供问题码");
}
