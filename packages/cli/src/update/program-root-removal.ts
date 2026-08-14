import { spawn, type ChildProcess } from "node:child_process";

export async function scheduleProgramRootRemoval(
  root: string,
  spawnHelper: (root: string) => ChildProcess = spawnPlatformRemovalHelper,
): Promise<void> {
  const child = spawnHelper(root);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

function spawnPlatformRemovalHelper(root: string): ChildProcess {
  return process.platform === "win32"
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
}
