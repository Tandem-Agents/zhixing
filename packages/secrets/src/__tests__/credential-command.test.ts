import { describe, expect, it } from "vitest";
import path from "node:path";
import { runCredentialCommand } from "../credential-command.js";

describe("isolated credential command", () => {
  it("returns binary input/output without changing the caller's buffer", async () => {
    const input = Buffer.from([0, 1, 2, 255]);
    const result = await runCredentialCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], input);
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual(input);
    expect(input).toEqual(Buffer.from([0, 1, 2, 255]));
    result.stdout.fill(0);
  });
  it("rejects launch failures and bounds command output", async () => {
    await expect(runCredentialCommand("zhixing-nonexistent-credential-command", [])).rejects.toThrow("could not start");
    await expect(runCredentialCommand(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(2*1024*1024))"])).rejects.toThrow("output exceeded limit");
  });
  it("terminates a timed-out child before finishing the worker", async () => {
    await expect(runCredentialCommand(process.execPath, ["-e", "setTimeout(()=>{},20000)"])).rejects.toThrow("timed out");
  }, 15_000);
  it.skipIf(process.platform !== "win32")("keeps caller timers responsive while Windows creates PowerShell", async () => {
    let previous = performance.now(), longest = 0, ticks = 0;
    const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - previous); previous = now; ticks++; }, 20);
    try {
      const command = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = await runCredentialCommand(command, ["-NoProfile", "-NonInteractive", "-Command", "Write-Output 'ready'"]);
      expect(result.code).toBe(0);
      expect(result.stdout.toString().trim()).toBe("ready");
      expect(ticks).toBeGreaterThan(0);
      expect(longest).toBeLessThan(1000);
    } finally { clearInterval(timer); }
  });
});
