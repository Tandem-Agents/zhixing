import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { logFailureEvidence, type LogFailureEvidence } from "@zhixing/core/logging";

type DeclarationFailure = (reason: string, failure?: LogFailureEvidence) => void;
export type LogWriterDeclaration = { ready: Promise<void>; close(): Promise<void> };
export type LogWriterDeclarationFactory = (root: string, protocol: number) => LogWriterDeclaration;

export const LOG_WRITE_PROTOCOL = 2;
let entryDeclaration: { root: string; value: ReturnType<typeof declareLogWriter> } | undefined;
export function beginWriterDeclaration(home: string, unavailable?: DeclarationFailure, create?: LogWriterDeclarationFactory) {
  const root = writerRootKey(home);
  if (entryDeclaration?.root !== root) { void entryDeclaration?.value.close(); entryDeclaration = { root, value: declareLogWriter(home, unavailable, create) }; }
  return entryDeclaration.value.ready;
}
export function writerRootKey(home: string): string {
  const root = path.resolve(home);
  return createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
}
export function writerEndpoint(pid: number): string {
  const name = `zhixing-log-v${LOG_WRITE_PROTOCOL}-${pid}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `\0${name}`;
}

/** Memory-only declaration. Store still owns resource admission, registration and disk exclusion. */
export function declareLogWriter(home: string, unavailable?: DeclarationFailure, create?: LogWriterDeclarationFactory): LogWriterDeclaration {
  const notify: DeclarationFailure = (reason, failure) => { try { unavailable?.(reason, failure); } catch { /* Observation must not block fallback admission. */ } };
  // Darwin has no abstract local sockets; retain conservative registration there.
  if (process.platform !== "win32" && process.platform !== "linux") return { ready: Promise.resolve(), async close() {} };
  if (create) {
    try { return create(writerRootKey(home), LOG_WRITE_PROTOCOL); }
    catch (error) { notify("declaration-create-failed", logFailureEvidence(error)); return { ready: Promise.resolve(), async close() {} }; }
  }
  const built = new URL("./logging-admission-worker.js", import.meta.url), compiled = existsSync(built);
  // The declaration must answer even while the application thread parses heavy modules.
  // One bounded isolate, no log data, file writes, credentials, or additional process.
  let worker: Worker;
  try { worker = new Worker(compiled ? built : new URL("./writer-admission-worker.ts", import.meta.url), {
    execArgv: compiled ? [] : ["--import=tsx/esm"],
    workerData: { endpoint: writerEndpoint(process.pid), protocol: LOG_WRITE_PROTOCOL, root: writerRootKey(home), pid: process.pid },
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 2, stackSizeMb: 1 },
  }); } catch (error) { notify("worker-create-failed", logFailureEvidence(error)); return { ready: Promise.resolve(), async close() {} }; }
  let closing = false;
  let settled = false;
  const ready = new Promise<void>(resolve => {
    const settle = () => { if (!settled) { settled = true; clearTimeout(timer); worker.unref(); resolve(); } };
    const fail: DeclarationFailure = (reason, failure) => { if (!closing) notify(reason, failure); settle(); };
    const timer = setTimeout(() => fail("declaration-timeout"), 500);
    worker.once("message", value => value === "ready" ? settle() : fail("endpoint-unavailable", logFailureEvidence(Object.assign(Error("Declaration endpoint unavailable"), { code: value?.code }))));
    worker.on("error", error => fail("worker-failed", logFailureEvidence(error)));
    worker.once("exit", code => { if (!closing) fail("worker-exited", { category: "process", exitCode: code }); });
  });
  return { ready, async close() { closing = true; await worker.terminate(); } };
}
