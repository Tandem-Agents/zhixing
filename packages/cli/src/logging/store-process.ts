import { fork, type ChildProcess, type ForkOptions, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import type { DeviceCapacityArbiterPort, DeviceCapacityBudget, DeviceCapacityPermit, DeviceCapacityStepPermit } from "@zhixing/core/resources";
import { LogAppendIndeterminateError, LogStorageError, type LogAppendReceipt, type LogCapture, type LogSink, type LogStatus } from "@zhixing/core/logging";
import type { StoreOperation, StoreWorkerInput, StoreWorkerOutput } from "./store-worker-protocol.js";

/** One in-flight Store call, using the process's existing resource owner before taking any file lock. */
export class IsolatedLogStore implements LogSink {
  #worker: ChildProcess | undefined;
  #exit: Promise<void> | undefined;
  #closed = false;
  #id = 0;
  #pending: { id: number; operation: StoreOperation; resolve(value: LogStatus | LogAppendReceipt): void; reject(error: Error): void } | undefined;
  #admission: { id: number; abort: AbortController } | undefined;
  #lease: { id: number; permit: DeviceCapacityPermit; step: DeviceCapacityStepPermit; budget: DeviceCapacityBudget } | undefined;
  constructor(private readonly home: string, private readonly capacity: DeviceCapacityArbiterPort) {}
  initialize(): Promise<LogStatus> { return this.#call("initialize") as Promise<LogStatus>; }
  append(records: readonly LogCapture[]): Promise<LogAppendReceipt> { return this.#call("append", records); }
  maintain(): Promise<LogStatus> { return this.#call("maintain") as Promise<LogStatus>; }
  async close(): Promise<void> {
    this.#closed = true;
    this.#admission?.abort.abort();
    if (this.#worker) { this.#worker.ref(); this.#worker.channel?.ref(); this.#send({ kind: "close" }); await this.#exit; }
  }
  #call(operation: StoreOperation, records?: readonly LogCapture[]): Promise<LogStatus | LogAppendReceipt> {
    if (this.#closed) return Promise.reject(new LogStorageError("owner-unavailable", "日志写者已关闭"));
    if (this.#pending) return Promise.reject(new LogStorageError("writer-busy", "日志事务仍在执行"));
    if (!this.#worker) this.#start();
    this.#worker!.ref();
    this.#worker!.channel?.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending = { id, operation, resolve, reject };
      this.#send({ kind: "call", id, operation, ...(records ? { records } : {}) });
    });
  }
  #send(message: StoreWorkerInput): void {
    const worker = this.#worker;
    if (worker?.connected) worker.send(message, error => { if (error) worker.kill(); });
  }
  #start(): void {
    const built = new URL("./logging-store-worker.js", import.meta.url);
    const compiled = existsSync(built);
    // fork forwards this spawn option, although Node's ForkOptions omits it.
    const options: ForkOptions & Pick<SpawnOptions, "windowsHide"> = {
      execArgv: compiled ? [] : ["--import=tsx/esm"],
      // stdio redirection does not prevent a console when the Host has none.
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    };
    const worker = fork(compiled ? built : new URL("./store-worker.ts", import.meta.url), [this.home, String(process.pid)], options);
    this.#worker = worker;
    worker.on("message", (message: StoreWorkerOutput) => {
      if (worker !== this.#worker) return;
      if (message.kind === "acquire") { void this.#acquire(worker, message); return; }
      if (message.kind === "cancel") { if (this.#admission?.id === message.id) this.#admission.abort.abort(); return; }
      if (message.kind === "release") {
        try { this.#release(message.id, message.used); } catch { worker.kill(); }
        return;
      }
      const pending = this.#pending;
      if (!pending || pending.id !== message.id) return;
      this.#pending = undefined; worker.unref(); worker.channel?.unref();
      if (message.kind === "result") pending.resolve(message.value);
      else pending.reject(message.indeterminate ? new LogAppendIndeterminateError() : new LogStorageError(message.code, "日志事务未完成"));
    });
    worker.on("error", () => { /* exit owns cleanup and unknown-write classification. */ });
    this.#exit = new Promise(resolve => worker.once("close", () => {
      this.#admission?.abort.abort();
      if (this.#lease) {
        try { this.#release(this.#lease.id, this.#lease.budget.quantum); } catch { /* Failed owner is already fenced. */ }
      }
      const pending = this.#pending;
      this.#pending = undefined; this.#worker = undefined;
      pending?.reject(pending.operation === "append" ? new LogAppendIndeterminateError() : new LogStorageError("owner-unavailable", "日志写者已退出"));
      resolve();
    }));
    worker.unref(); worker.channel?.unref();
  }
  async #acquire(worker: ChildProcess, message: Extract<StoreWorkerOutput, { kind: "acquire" }>): Promise<void> {
    const abort = new AbortController();
    this.#admission = { id: message.id, abort };
    if (this.#closed) abort.abort();
    try {
      const result = await this.capacity.acquire(message.request, abort.signal);
      if (worker !== this.#worker) { if (result.kind === "granted") result.permit.release(); return; }
      if (result.kind !== "granted") { this.#send({ kind: "capacity", id: message.id, result }); return; }
      if (worker !== this.#worker || this.#closed) { result.permit.release(); this.#send({ kind: "capacity", id: message.id, result: { kind: "cancelled" } }); return; }
      const budget = message.request.atomic;
      const step = result.permit.tryBegin(budget);
      if (!step) { result.permit.release(); this.#send({ kind: "capacity", id: message.id, result: { kind: "backpressured", blockedBy: "slots", retryAfterMs: 100 } }); return; }
      this.#lease = { id: message.id, permit: result.permit, step, budget };
      this.#send({ kind: "capacity", id: message.id, result: { kind: "granted", budget } });
    } catch {
      if (worker === this.#worker) this.#send({ kind: "capacity", id: message.id, result: { kind: "backpressured", blockedBy: "probe-unavailable", retryAfterMs: 100 } });
    } finally { if (this.#admission?.abort === abort) this.#admission = undefined; }
  }
  #release(id: number, used: DeviceCapacityBudget["quantum"]): void {
    const lease = this.#lease;
    if (!lease || lease.id !== id) return;
    this.#lease = undefined;
    try { for (const key of ["readBytes", "writeBytes", "ioOperations"] as const) lease.step.claim(key, used[key]); }
    finally { lease.step.complete(); lease.permit.release(); }
  }
}
