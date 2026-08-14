import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { runStopCommand, type StopResult } from "../serve/stop.js";
import { prepareProgramRemovalManagedService } from "../serve/managed-service-runtime.js";
import type { ProgramRemovalManagedServiceHandle } from "../serve/managed-service-runtime.js";
import { defaultProgramRoot } from "./program-store.js";

export interface AppRemoveDeps {
  readonly programRoot?: string;
  readonly stop?: () => Promise<StopResult>;
  readonly prepareManagedRemoval?: () => Promise<ProgramRemovalManagedServiceHandle>;
  readonly handoff?: (executable: string, args: readonly string[]) => Promise<void>;
}

export async function removeApplication(deps: AppRemoveDeps = {}): Promise<void> {
  const programRoot = path.resolve(deps.programRoot ?? defaultProgramRoot());
  const executable = path.join(
    programRoot,
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const installer = path.join(programRoot, "installer", "program-installer.js");
  const [runtimeEntry, installerEntry] = await Promise.all([
    stat(executable).catch(() => undefined),
    stat(installer).catch(() => undefined),
  ]);
  if (!runtimeEntry?.isFile() || !installerEntry?.isFile()) {
    throw new Error("正式安装器的应用移除入口不可用");
  }
  const managedService = await (
    deps.prepareManagedRemoval ?? (() => prepareProgramRemovalManagedService())
  )();
  let committed = false;
  try {
    const result = await (deps.stop ?? (() => runStopCommand({ respectBlockers: true })))();
    if (result.status === "error" || result.status === "refused") {
      throw new Error("当前工作尚未安全结束，未移除应用");
    }
    await managedService.commit();
    committed = true;
    await (deps.handoff ?? handoffProgramRemoval)(executable, [
      installer,
      "remove",
      "--program-root",
      programRoot,
      "--preserve-user-data",
    ]);
  } catch (error) {
    if (!committed) {
      try {
        await managedService.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "应用未移除，但自动启动状态无法安全恢复；请修复托管服务后重试",
        );
      }
    }
    throw error;
  }
}

export async function handoffProgramRemoval(
  executable: string,
  args: readonly string[],
): Promise<void> {
  const child = spawn(executable, [...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error("应用未完全移除，请重试"));
    };
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0 && signal === null) {
        resolve();
        return;
      }
      reject(new Error("应用未完全移除，请重试"));
    });
  });
}
