import { expect, it } from "vitest";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createTempDir } from "@zhixing/test-utils";
import { createLocalLogStore } from "./runtime.js";

// Test the Windows console, not just the spawn option or redirected output.
const consoleProbe = String.raw`
param([int]$OwnerPid, [int]$WorkerPid)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleProbe {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")] public static extern bool FreeConsole();
 [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
[void][ConsoleProbe]::FreeConsole()
$results = foreach ($target in @($OwnerPid, $WorkerPid)) {
 $attached = [ConsoleProbe]::AttachConsole([uint32]$target)
 $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
 try {
  if (!$attached -and $errorCode -ne 6) { throw "Console probe failed: $errorCode" }
  [pscustomobject]@{ pid=$target; attached=$attached; visible=($attached -and [ConsoleProbe]::IsWindowVisible([ConsoleProbe]::GetConsoleWindow())) }
 } finally { if ($attached) { [void][ConsoleProbe]::FreeConsole() } }
}
$results | ConvertTo-Json -Compress
`;

it.skipIf(process.platform !== "win32")("keeps initial and recovered log writers invisible under a consoleless Host", async () => {
  const home = await createTempDir("background-log-console");
  const child = fork(new URL("./__tests__/background-store-fixture.ts", import.meta.url), [home], {
    execArgv: ["--import=tsx/esm"], detached: true, windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", data => { stderr = (stderr + data).slice(-2048); });
  const exited = once(child, "close");
  const probe = async (worker: number) => {
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `& { ${consoleProbe} } ${child.pid!} ${worker}`,
    ], { windowsHide: true, timeout: 10_000 });
    return JSON.parse(stdout) as { pid: number; attached: boolean; visible: boolean }[];
  };
  try {
    const [first] = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
    expect(first, stderr).toMatchObject({ kind: "ready", health: { state: "ready", queued: 0, lost: 0, unconfirmed: 0 } });
    expect(await probe(first.worker)).toEqual([
      { pid: child.pid, attached: false, visible: false },
      { pid: first.worker, attached: true, visible: false },
    ]);
    const recovered = once(child, "message", { signal: AbortSignal.timeout(15_000) });
    child.send("recover");
    const [next] = await recovered;
    expect(next, stderr).toMatchObject({ kind: "ready", health: { state: "ready", queued: 0, lost: 0, unconfirmed: 0 } });
    expect(next.worker).not.toBe(first.worker);
    expect(() => process.kill(first.worker, 0)).toThrow();
    expect(await probe(next.worker)).toEqual([
      { pid: child.pid, attached: false, visible: false },
      { pid: next.worker, attached: true, visible: false },
    ]);
    child.send("close");
    expect((await exited)[0], stderr).toBe(0);
    expect(() => process.kill(next.worker, 0)).toThrow();
    const reader = createLocalLogStore(home);
    try { await reader.store.read(async snapshot => { expect(snapshot.upper).toBeGreaterThanOrEqual(2); }); }
    finally { await reader.store.close(); reader.capacity.close(); }
  } finally {
    if (child.connected) child.send("close");
    const timeout = setTimeout(() => child.kill(), 6000);
    await exited;
    clearTimeout(timeout);
  }
}, 45_000);
