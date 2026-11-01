import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LogRecordPort, LogRef, LogSource } from "./contracts.js";
import { LOG_FAILURE_FIELDS, logFailureEvidence } from "./failure.js";

const context = new AsyncLocalStorage<{ refs: readonly LogRef[]; active: boolean }>();
const fields = { phase: "text", durationMs: "number", waitFor: "text", queueMs: "number", count: "number", bytes: "number",
  processCpuUserMs: "number", processCpuSystemMs: "number", loopDelayMs: "number", caller: "text", failure: { fields: LOG_FAILURE_FIELDS } } as const;
export const LOG_PHASE_EVENTS: LogSource["events"] = {
  phaseStarted: { message: "运行阶段已进入", level: "info", tier: "critical", fields },
  phaseProgress: { message: "运行阶段仍在推进或等待", level: "info", tier: "critical", fields },
  phaseFinished: { message: "运行阶段已结束", level: "info", tier: "critical", fields },
};
export function currentLogPhaseRefs(): readonly LogRef[] { const value = context.getStore(); return value?.active ? value.refs : []; }

/** 在任何调用者阶段之外运行：转交后台续跑的工作不记在发起它的前台阶段名下（只观测）。 */
export function runOutsideLogPhase<T>(work: () => Promise<T>): Promise<T> { return context.run({ refs: [], active: false }, work); }

/** 阶段已结束、续跑仍在这个上下文里运行时，返回该阶段为 originPhase（只观测，区分合法续跑与无来源工作）。 */
export function currentLogPhaseOriginRefs(): readonly LogRef[] {
  const value = context.getStore();
  if (!value || value.active) return [];
  const phase = value.refs.find(ref => ref.kind === "phase");
  return phase ? [{ kind: "originPhase", id: phase.id }] : [];
}

// 发起方的固定标签随异步上下文下传，只供存储工作汇总按发起方归组；与阶段上下文分开，阶段结束不清它，也不进记录器的阶段合并
const attribution = new AsyncLocalStorage<readonly LogRef[]>();
export function currentLogAttributionRefs(): readonly LogRef[] { return attribution.getStore() ?? []; }

/**
 * 以固定标签（有限集合，例如产品接口动作名）运行一段工作（只观测，不改返回值、错误与取消）。
 * trigger 为真时把进入前的发起方标签与当前活动阶段记为 trigger／triggerPhase，用于转交后台续跑的入口。
 */
export function runWithLogAttribution<T>(caller: string, work: () => Promise<T>, options: { trigger?: boolean } = {}): Promise<T> {
  const refs: LogRef[] = [{ kind: "caller", id: caller }];
  if (options.trigger) {
    const previous = currentLogAttributionRefs().find(ref => ref.kind === "caller");
    const phase = currentLogPhaseRefs().find(ref => ref.kind === "phase");
    if (previous) refs.push({ kind: "trigger", id: previous.id });
    if (phase) refs.push({ kind: "triggerPhase", id: phase.id });
  }
  return attribution.run(refs, work);
}

/** Observation only: never changes cancellation, errors or business scheduling. caller 是调用方给出的固定标签（共享入口区分发起方）。 */
export function beginLogPhase(records: LogRecordPort | undefined, phase: string,
  options: { waitFor?: string; refs?: readonly LogRef[]; caller?: string } = {}) {
  const ref: LogRef = { kind: "phase", id: randomUUID() };
  const parent = currentLogPhaseRefs().findLast(item => item.kind === "phase");
  const refs = [ref, ...(parent ? [{ kind: "parentPhase", id: parent.id }] : []), ...(options.refs ?? [])];
  const start = performance.now(), cpu = process.cpuUsage();
  let expected = start + 5000;
  const record = (event: string, data: Record<string, unknown>, result?: "success" | "failure" | "cancelled") => {
    try { records?.record({ event, refs, data: { phase, waitFor: options.waitFor, ...data }, ...(result ? { result } : {}) }); }
    catch { /* A foreign observation port cannot fail the observed operation. */ }
  };
  record("phaseStarted", options.caller ? { caller: options.caller } : {});
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

export async function observeLogPhase<T>(records: LogRecordPort | undefined, phase: string, work: () => Promise<T>, options: { waitFor?: string; refs?: readonly LogRef[]; caller?: string } = {}): Promise<T> {
  if (!records) return work();
  const observation = beginLogPhase(records, phase, options);
  try { const value = await observation.run(work); observation.finish(); return value; }
  catch (error) { observation.finish(error); throw error; }
}
