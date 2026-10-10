import { randomUUID } from "node:crypto";
import { LogRecorder, type BindLogSource, type LogSink, type LogStatus, type LogAppendReceipt, type LogCapture, type LogHealth } from "@zhixing/core/logging";
import { RUNTIME_LOG_SOURCE } from "./runtime-source.js";
import { ZHIXING_CLI_VERSION } from "../version.js";

/** The same recorder/queue survives bootstrap; no temporary file or second capture path. */
class DeferredSink implements LogSink {
  #deadline = Infinity;
  beginClose(deadline: number): void { this.#deadline = Math.min(this.#deadline, deadline); this.#target?.beginClose?.(this.#deadline); }
  #target: LogSink | undefined;
  #resolve!: (target: LogSink) => void;
  readonly #ready = new Promise<LogSink>(resolve => { this.#resolve = resolve; });
  attach(target: LogSink): void {
    if (this.#target) throw Error("日志存储重复接续");
    this.#target = target;
    if (Number.isFinite(this.#deadline)) target.beginClose?.(this.#deadline);
    this.#resolve(target);
  }
  async initialize(): Promise<LogStatus> { return (await this.#ready).initialize(); }
  async append(records: readonly LogCapture[]): Promise<LogAppendReceipt> { return (await this.#ready).append(records); }
  async maintain(): Promise<LogStatus> { return (await this.#ready).maintain(); }
  async close(): Promise<void> { await this.#target?.close(); }
}

export function createBootstrapLogging(mode: string) {
  const sink = new DeferredSink();
  let onHealth: ((health: LogHealth) => void) | undefined;
  const recorder = new LogRecorder(sink, { onHealth: health => onHealth?.(health) });
  const operation = { kind: "operation", id: randomUUID() };
  const handoff = process.env.ZHIXING_LOG_HANDOFF;
  delete process.env.ZHIXING_LOG_HANDOFF;
  const refs = [operation, ...(/^[a-f0-9-]{36}$/u.test(handoff ?? "") ? [{ kind: "handoff", id: handoff! }] : [])];
  const bind: BindLogSource = (source, access, related = [], admission) => recorder.bind(source, access, [...refs, ...related], admission);
  const records = bind(RUNTIME_LOG_SOURCE, { scope: "storage" });
  records.record({ event: "started", data: { mode, implementation: ZHIXING_CLI_VERSION, pid: process.pid, sinceProcessStartMs: Math.round(process.uptime() * 1000) } });
  return { recorder, bind, records, attach(target: LogSink, notify: typeof onHealth) { onHealth = notify; sink.attach(target); } };
}
let entry: ReturnType<typeof createBootstrapLogging> | undefined;
export function beginEntryLogging(mode: string) { return entry ??= createBootstrapLogging(mode); }
export function peekEntryLogging() { return entry; }
export function takeEntryLogging() { const current = entry; entry = undefined; return current; }
