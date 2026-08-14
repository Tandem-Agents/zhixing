import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EMBEDDED_RELEASE_TRUST } from "./release-channel.js";
import { createReleaseVerifier } from "./release-verifier.js";
import { installProgramRelease } from "./installation-receipt.js";
import { ProgramStore, currentReleaseTarget, defaultProgramRoot } from "./program-store.js";
import { requestLocalUpgradeHandoff } from "./runtime.js";

const command = process.argv[2];
if (command === "install") {
  if (!EMBEDDED_RELEASE_TRUST) throw new Error("正式安装器未嵌入稳定发布信任");
  const root = path.resolve(optional("--program-root") ?? defaultProgramRoot());
  const manifestPath = path.resolve(required("--manifest"));
  const artifactPath = path.resolve(required("--artifact"));
  await installProgramRelease({
    store: new ProgramStore(root, currentReleaseTarget()),
    verifier: createReleaseVerifier(EMBEDDED_RELEASE_TRUST),
    manifestBytes: await readFile(manifestPath),
    artifactBytes: await readFile(artifactPath),
    handoffExisting: requestLocalUpgradeHandoff,
  });
} else if (command === "remove") {
  const root = path.resolve(required("--program-root"));
  if (!process.argv.includes("--preserve-user-data")) {
    throw new Error("应用移除必须显式保留全部用户数据");
  }
  scheduleProgramRootRemoval(root);
} else {
  throw new Error("program installer command is invalid");
}

function scheduleProgramRootRemoval(root: string): void {
  const child = process.platform === "win32"
    ? spawn("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Sleep -Seconds 1; Remove-Item -LiteralPath $env:ZHIXING_REMOVE_ROOT -Recurse -Force",
      ], {
        detached: true,
        env: { ...process.env, ZHIXING_REMOVE_ROOT: root },
        stdio: "ignore",
        windowsHide: true,
      })
    : spawn("sh", ["-c", "sleep 1; rm -rf -- \"$ZHIXING_REMOVE_ROOT\""], {
        detached: true,
        env: { ...process.env, ZHIXING_REMOVE_ROOT: root },
        stdio: "ignore",
      });
  child.unref();
}

function required(flag: string): string {
  const value = optional(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function optional(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}
