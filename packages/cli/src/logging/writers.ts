import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LogWriterObservation } from "@zhixing/core/logging/storage";
import type { NodeProcessInventory } from "@zhixing/mesh/filesystem";
import { isProductLogWriter } from "./writer-classification.js";

export function classifyWindowsWriters(inventory: NodeProcessInventory, home: string, pid = process.pid): Omit<LogWriterObservation, "at"> {
  const candidates: { pid: number; birth: string }[] = [];
  let self: { pid: number; birth: string } | undefined;
  let complete = inventory.complete && inventory.entries.length <= 256;
  for (const row of inventory.entries.slice(0, 256)) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !/^[0-9]{1,32}$/u.test(row.birth)) { complete = false; continue; }
    const identity = { pid: row.pid, birth: row.birth };
    if (row.pid === pid) { self = identity; candidates.push(identity); continue; }
    if (!row.argv || row.argv.length > 1024) { complete = false; continue; }
    if (isProductLogWriter(row.argv, home, true)) candidates.push(identity);
  }
  return { complete: complete && self !== undefined, self, candidates };
}

/** No raw command line or environment leaves the finite platform observation. */
export function createLogWriterProbe(home: string, observeWindows?: () => Promise<NodeProcessInventory>): (signal?: AbortSignal) => Promise<LogWriterObservation> {
  let cached: LogWriterObservation | undefined;
  let cachedUntil = 0;
  return async (signal) => {
    signal?.throwIfAborted();
    if (cached && performance.now() < cachedUntil) return cached;
    const at = Date.now();
    try {
      if (process.platform === "win32" && !observeWindows) throw Error("Owned Windows process observer required");
      const result = process.platform === "win32" ? classifyWindowsWriters(await observeWindows!(), home) : await isolatedPosix(home, signal);
      signal?.throwIfAborted();
      cached = { ...result, at };
    } catch { cached = { complete: false, at, candidates: [] }; }
    cachedUntil = performance.now() + 1000;
    return cached;
  };
}
function execute(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { signal, windowsHide: true, timeout: 2500, maxBuffer: 256 * 1024, encoding: "utf8", env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function isolatedPosix(home: string, signal?: AbortSignal): Promise<Omit<LogWriterObservation, "at">> {
  const built = fileURLToPath(new URL("./logging-writers-worker.js", import.meta.url));
  const args = existsSync(built) ? [built] : ["--import=tsx/esm", fileURLToPath(new URL("./logging-writers-worker.ts", import.meta.url))];
  return JSON.parse(await execute(process.execPath, [...args, home, String(process.pid)], process.env, signal));
}
