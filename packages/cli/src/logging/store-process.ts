import { fork, type ForkOptions, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import type { EventEmitter } from "node:events";
import type { DeviceCapacityArbiterPort, DeviceCapacityBudget, DeviceCapacityPermit, DeviceCapacityStepPermit } from "@zhixing/core/resources";
import { LogAppendIndeterminateError, LogStorageError, logFailureEvidence, type LogFailureEvidence, type LogAppendReceipt, type LogCapture, type LogSink, type LogStatus } from "@zhixing/core/logging";
import type { StoreOperation, StoreWorkerInput, StoreWorkerOutput } from "./store-worker-protocol.js";

export type LogStoreWorker = EventEmitter & {
  readonly connected: boolean;
  send(message: StoreWorkerInput, callback: (error?: Error | null) => void): unknown;
  kill(): unknown; ref(): unknown; unref(): unknown;
  readonly channel?: { ref(): void; unref(): void } | null;
};
export type LogStoreWorkerFactory = () => { readonly worker: LogStoreWorker; readonly ready: Promise<void> };
// Eight records per existing Recorder batch, each <=256 KiB plus <=1 MiB
// detail, fit below the existing maximum 16 MiB logging queue.
export const LOG_STORE_FRAME_BYTES = 16 * 1024 * 1024 + 64 * 1024;

/** One in-flight Store call, using the process's existing resource owner before taking any file lock. */
export class IsolatedLogStore implements LogSink {
  #worker: LogStoreWorker | undefined;
  #ready: Promise<void> = Promise.resolve();
  #exit: Promise<void> | undefined;
  #closed = false;
  #failure: LogFailureEvidence | undefined;
  #id = 0;
  #pending: { id: number; operation: StoreOperation; resolve(value: LogStatus | LogAppendReceipt): void; reject(error: Error): void } | undefined;
  #admission: { id: number; abort: AbortController } | undefined;
  #lease: { id: number; permit: DeviceCapacityPermit; step: DeviceCapacityStepPermit; budget: DeviceCapacityBudget } | undefined;
  constructor(private readonly home: string, private readonly capacity: DeviceCapacityArbiterPort, private readonly createWorker?: LogStoreWorkerFactory, private readonly retainCapacityActivity?: () => () => void) {}
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
    const releaseActivity = this.retainCapacityActivity?.();
    try { if (!this.#worker) this.#start(); }
    catch (error) { releaseActivity?.(); return Promise.reject(error); }
    this.#worker!.ref();
    this.#worker!.channel?.ref();
    return new Promise<LogStatus | LogAppendReceipt>((resolve, reject) => {
      const id = ++this.#id;
      this.#pending = { id, operation, resolve, reject };
      this.#send({ kind: "call", id, operation, ...(records ? { records } : {}) });
    }).finally(() => releaseActivity?.());
  }
  #send(message: StoreWorkerInput): void {
    const worker = this.#worker;
    if (!worker) return;
    const send = () => { if (worker === this.#worker && worker.connected) worker.send(message, error => { if (error) { this.#failure ??= logFailureEvidence(error); worker.kill(); } }); };
    if (worker.connected) send();
    else void this.#ready.then(send).catch(error => { this.#failure ??= logFailureEvidence(error); worker.kill(); });
  }
  #start(): void {
    this.#failure = undefined;
    const built = new URL("./logging-store-worker.js", import.meta.url);
    const compiled = existsSync(built);
    // fork forwards this spawn option, although Node's ForkOptions omits it.
    const options: ForkOptions & Pick<SpawnOptions, "windowsHide"> = {
      execArgv: compiled ? [] : ["--import=tsx/esm"],
      // stdio redirection does not prevent a console when the Host has none.
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    };
    const supplied = this.createWorker?.();
    const worker = supplied?.worker ?? fork(compiled ? built : new URL("./store-worker.ts", import.meta.url), [this.home, String(process.pid)], options);
    this.#ready = supplied?.ready ?? Promise.resolve();
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
      else pending.reject(message.indeterminate ? new LogAppendIndeterminateError(message.evidence) : new LogStorageError(message.code, "日志事务未完成", message.evidence));
    });
    worker.on("error", error => { this.#failure ??= logFailureEvidence(error); /* close still fences the owner before rejecting. */ });
    this.#exit = new Promise((resolve, reject) => {
      worker.once('completion-unknown', (error: Error) => {
        this.#closed = true; this.#admission?.abort.abort();
        const pending = this.#pending; this.#pending = undefined;
        // No close proof: keep the acquired capacity lease charged.
        pending?.reject(error); reject(error);
      });
      worker.once("close", (code, signal) => {
      this.#admission?.abort.abort();
      if (this.#lease) {
        try { this.#release(this.#lease.id, this.#lease.budget.quantum); } catch { /* Failed owner is already fenced. */ }
      }
      const pending = this.#pending;
      this.#pending = undefined; this.#worker = undefined;
      const evidence = { ...(this.#failure ?? { category: "process", code: "store-worker-exited" }), operation: `store.${pending?.operation ?? "close"}`, ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}) };
      pending?.reject(pending.operation === "append" ? new LogAppendIndeterminateError(evidence) : new LogStorageError("owner-unavailable", "日志写者已退出", evidence));
      resolve();
      });
    });
    void this.#exit.catch(() => {});
    worker.unref(); worker.channel?.unref();
  }
  async #acquire(worker: LogStoreWorker, message: Extract<StoreWorkerOutput, { kind: "acquire" }>): Promise<void> {
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
