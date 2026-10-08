import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LogWriterObservation } from "@zhixing/core/logging/storage";
import { logFailureEvidence } from "@zhixing/core/logging";
import type { NodeProcessInventory } from "@zhixing/mesh/filesystem";
import { isProductLogWriter } from "./writer-classification.js";
import { LOG_WRITE_PROTOCOL, writerEndpoint, writerRootKey } from "./writer-admission.js";

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
  const failure = inventory.failure;
  return { complete: complete && self !== undefined, self, candidates,
    ...(failure && ["inventory-limit", "identity-unavailable", "arguments-unavailable"].includes(failure.reason) ? {
      failure: { category: "writer-admission", operation: "writers.inventory", code: failure.reason,
        ...(Number.isSafeInteger(failure.pid) && failure.pid! > 0 ? { writerPids: [failure.pid!] } : {}),
      },
    } : {}),
  };
}

export interface LogWriterProcessObserver {
  observeNodeProcesses(): Promise<NodeProcessInventory>;
  readLocalProcessDeclaration(endpoint: string, pid: number): Promise<string>;
}
export type LogWriterCommandRunner = (command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<string>;

/** Inventory and peer verification are one dependency; callers cannot omit half of admission. */
export function createLogWriterProbe(home: string, processes: LogWriterProcessObserver, ownerPid = process.pid, runCommand: LogWriterCommandRunner = execute): (signal?: AbortSignal) => Promise<LogWriterObservation> {
  let cached: LogWriterObservation | undefined;
  let cachedUntil = 0;
  const admitted = new Set<string>();
  const elsewhere = new Set<string>();
  return async (signal) => {
    signal?.throwIfAborted();
    if (cached && performance.now() < cachedUntil) return cached;
    const at = Date.now();
    try {
      let result = process.platform === "win32" ? classifyWindowsWriters(await processes.observeNodeProcesses(), home, ownerPid) : await isolatedPosix(home, signal, ownerPid, runCommand);
      if (process.platform === "win32" && result.complete) {
        const live = new Set(result.candidates.map(item => `${item.pid}:${item.birth}`));
        for (const key of admitted) if (!live.has(key)) admitted.delete(key);
        for (const key of elsewhere) if (!live.has(key)) elsewhere.delete(key);
        // Finite probe work; unproven candidates remain conservative and retry next observation.
        let checked = 0;
        const proofs = new Map<string, string>();
        for (const candidate of result.candidates) {
          const key = `${candidate.pid}:${candidate.birth}`;
          if (candidate.pid === ownerPid || admitted.has(key) || elsewhere.has(key) || checked++ >= 8) continue;
          try {
            const text = await processes.readLocalProcessDeclaration(writerEndpoint(candidate.pid), candidate.pid);
            const value = text.length <= 512 ? JSON.parse(text) : undefined;
            if (value?.protocol === LOG_WRITE_PROTOCOL && value.pid === candidate.pid && /^[a-f0-9]{64}$/u.test(value.root)) {
              proofs.set(key, value.root);
            }
          } catch { /* Only a live peer proof can establish compatibility. */ }
        }
        if (proofs.size) {
          // The OS peer proves PID, while the second inventory binds that proof to
          // the same incarnation. A reused PID must never inherit a cached proof.
          result = classifyWindowsWriters(await processes.observeNodeProcesses(), home, ownerPid);
          if (result.complete) for (const candidate of result.candidates) {
            const key = `${candidate.pid}:${candidate.birth}`, root = proofs.get(key);
            if (root === writerRootKey(home)) admitted.add(key);
            else if (root !== undefined) elsewhere.add(key);
          }
        }
        result = { ...result, candidates: result.candidates.filter(item => !elsewhere.has(`${item.pid}:${item.birth}`)), compatible: result.candidates.filter(item => admitted.has(`${item.pid}:${item.birth}`)) };
      }
      signal?.throwIfAborted();
      cached = { ...result, at };
    } catch (error) { cached = { complete: false, at, candidates: [], failure: logFailureEvidence(error) }; }
    // Cache established compatibility, never a transient inability to prove it.
    // A worker may exit or publish its declaration immediately after inventory;
    // retaining that negative snapshot can consume an entire short entry drain.
    const proven = cached.complete && (process.platform !== 'win32' || cached.candidates.every(candidate =>
      candidate.pid === ownerPid || cached!.compatible?.some(peer => peer.pid === candidate.pid && peer.birth === candidate.birth)));
    cachedUntil = performance.now() + (proven ? 1000 : 0);
    return cached;
  };
}
function execute(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { signal, windowsHide: true, timeout: 2500, maxBuffer: 256 * 1024, encoding: "utf8", env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function isolatedPosix(home: string, signal: AbortSignal | undefined, ownerPid: number, runCommand: LogWriterCommandRunner): Promise<Omit<LogWriterObservation, "at">> {
  const built = fileURLToPath(new URL("./logging-writers-worker.js", import.meta.url));
  const args = existsSync(built) ? [built] : ["--import=tsx/esm", fileURLToPath(new URL("./logging-writers-worker.ts", import.meta.url))];
  return JSON.parse(await runCommand(process.execPath, [...args, home, String(ownerPid)], process.env, signal));
}
