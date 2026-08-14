import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { runStopCommand, type StopResult } from "../serve/stop.js";
import { prepareProgramRemovalManagedService } from "../serve/managed-service-runtime.js";
import { defaultProgramRoot } from "./program-store.js";

export interface AppRemoveDeps {
  readonly programRoot?: string;
  readonly stop?: () => Promise<StopResult>;
  readonly prepareManagedRemoval?: () => Promise<() => Promise<void>>;
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
  const unregisterFuture = await (
    deps.prepareManagedRemoval ?? (() => prepareProgramRemovalManagedService())
  )();
  const result = await (deps.stop ?? (() => runStopCommand({ respectBlockers: true })))();
  if (result.status === "error" || result.status === "refused") {
    throw new Error("当前工作尚未安全结束，未移除应用");
  }
  await unregisterFuture();
  await (deps.handoff ?? defaultHandoff)(executable, [
    installer,
    "remove",
    "--program-root",
    programRoot,
    "--preserve-user-data",
  ]);
}

async function defaultHandoff(executable: string, args: readonly string[]): Promise<void> {
  const child = spawn(executable, [...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
