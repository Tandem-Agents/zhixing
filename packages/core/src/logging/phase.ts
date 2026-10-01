import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LogRecordPort, LogRef, LogSource } from "./contracts.js";
import { LOG_FAILURE_FIELDS, logFailureEvidence } from "./failure.js";

const context = new AsyncLocalStorage<{ refs: readonly LogRef[]; active: boolean }>();
const fields = { phase: "text", durationMs: "number", waitFor: "text", queueMs: "number", count: "number", bytes: "number",
  processCpuUserMs: "number", processCpuSystemMs: "number", loopDelayMs: "number", failure: { fields: LOG_FAILURE_FIELDS } } as const;
export const LOG_PHASE_EVENTS: LogSource["events"] = {
  phaseStarted: { message: "运行阶段已进入", level: "info", tier: "critical", fields },
  phaseProgress: { message: "运行阶段仍在推进或等待", level: "info", tier: "critical", fields },
  phaseFinished: { message: "运行阶段已结束", level: "info", tier: "critical", fields },
};
export function currentLogPhaseRefs(): readonly LogRef[] { const value = context.getStore(); return value?.active ? value.refs : []; }

/** Observation only: never changes cancellation, errors or business scheduling. */
export function beginLogPhase(records: LogRecordPort | undefined, phase: string,
  options: { waitFor?: string; refs?: readonly LogRef[] } = {}) {
  const ref: LogRef = { kind: "phase", id: randomUUID() };
  const parent = currentLogPhaseRefs().findLast(item => item.kind === "phase");
  const refs = [ref, ...(parent ? [{ kind: "parentPhase", id: parent.id }] : []), ...(options.refs ?? [])];
  const start = performance.now(), cpu = process.cpuUsage();
  let expected = start + 5000;
  const record = (event: string, data: Record<string, unknown>, result?: "success" | "failure" | "cancelled") => {
    try { records?.record({ event, refs, data: { phase, waitFor: options.waitFor, ...data }, ...(result ? { result } : {}) }); }
    catch { /* A foreign observation port cannot fail the observed operation. */ }
  };
  record("phaseStarted", {});
  const timer = setInterval(() => {
    const now = performance.now();
    record("phaseProgress", { durationMs: Math.round(now - start), loopDelayMs: Math.max(0, Math.round(now - expected)) });
    expected = now + 5000;
  }, 5000);
  timer.unref();
  const duration = () => { const usage = process.cpuUsage(cpu); return { durationMs: Math.round(performance.now() - start), processCpuUserMs: usage.user / 1000, processCpuSystemMs: usage.system / 1000 }; };
  const scope = { refs, active: true };
  return {
    run<T>(work: () => Promise<T>): Promise<T> { return context.run(scope, work); },
    finish(error?: unknown): void {
      if (!scope.active) return;
      scope.active = false; clearInterval(timer);
      const failed = arguments.length > 0;
      let cancelled = false;
      try { cancelled = error instanceof Error && error.name === "AbortError"; } catch { /* A hostile error cannot replace the observed failure. */ }
      record("phaseFinished", { ...duration(), ...(failed ? { failure: logFailureEvidence(error) } : {}) },
        !failed ? "success" : cancelled ? "cancelled" : "failure");
    },
  };
}

export async function observeLogPhase<T>(records: LogRecordPort | undefined, phase: string, work: () => Promise<T>, options: { waitFor?: string; refs?: readonly LogRef[] } = {}): Promise<T> {
  if (!records) return work();
  const observation = beginLogPhase(records, phase, options);
  try { const value = await observation.run(work); observation.finish(); return value; }
  catch (error) { observation.finish(error); throw error; }
}
