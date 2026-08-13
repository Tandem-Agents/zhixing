import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { runStopCommand, type StopResult } from "../serve/stop.js";
import { defaultProgramRoot } from "./program-store.js";

export interface AppRemoveDeps {
  readonly programRoot?: string;
  readonly stop?: () => Promise<StopResult>;
  readonly handoff?: (executable: string, args: readonly string[]) => Promise<void>;
}

export async function removeApplication(deps: AppRemoveDeps = {}): Promise<void> {
  const programRoot = path.resolve(deps.programRoot ?? defaultProgramRoot());
  const executable = path.join(
    programRoot,
    "installer",
    process.platform === "win32" ? "remove-zhixing.exe" : "remove-zhixing",
  );
  const entry = await stat(executable).catch(() => undefined);
  if (!entry?.isFile()) throw new Error("正式安装器的应用移除入口不可用");
  const result = await (deps.stop ?? (() => runStopCommand({ respectBlockers: true })))();
  if (result.status === "error" || result.status === "refused") {
    throw new Error("当前工作尚未安全结束，未移除应用");
  }
  await (deps.handoff ?? defaultHandoff)(executable, [
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
