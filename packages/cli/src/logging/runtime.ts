import path from "node:path";
import {
  observeLogPhase,
  logFailureEvidence,
  type BindLogSource,
  type LogRecordPort,
  type LogResult,
  type LogSink,
} from "@zhixing/core/logging";
import { LocalLogStore } from "@zhixing/core/logging/storage";
import {
  createDeviceCapacityRuntime,
  type DeviceCapacityRuntime,
} from "../serve/device-capacity-runtime.js";
import { LogFilesProcess } from "./files-process.js";
import { observeBackgroundOutput, STDIO_LOG_SOURCE } from "./stdio.js";
import { createLogWriterProbe } from "./writers.js";
import { IsolatedLogStore, type LogStoreWorkerFactory } from "./store-process.js";
import type { StartupCheckResult } from "../startup.js";

import { createBootstrapLogging, takeEntryLogging } from "./bootstrap.js";
import { beginWriterDeclaration } from "./writer-admission.js";
export { RUNTIME_LOG_SOURCE } from "./runtime-source.js";

/** Bounded phase timing for the actual entry; no configuration or credential payload. */
export async function observeStartupPhase<T>(
  records: LogRecordPort | undefined,
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  return observeLogPhase(records, phase, operation);
}

/** Preserve the observed cause before entry drain, without copying configuration or credentials. */
export function recordRuntimeFailure(records: LogRecordPort | undefined, error: unknown, reason: string, attempt?: number): void {
  try { records?.record({ event: "failed", result: "failure", data: {
    reason, attempt, failure: logFailureEvidence(error),
  } }); } catch { /* Observation cannot replace the runtime's own failure. */ }
}

export function recordStartupFailure(records: LogRecordPort, result: Exclude<StartupCheckResult, { kind: "ready" }>): void {
  if (result.kind === "cancelled") return;
  records.record(() => ({ event: "failed", result: "failure", data: {
    reason: result.kind,
    error: "message" in result ? result.message : undefined,
    issues: result.kind === "semantic-error" ? result.issues.slice(0, 17).map(({ field, reason }) => ({ field, reason })) : undefined,
    missing: result.kind === "non-tty" ? result.missingLabels.slice(0, 33) : undefined,
  } }));
}

export function createLocalLogStore(home: string): {
  store: LocalLogStore;
  capacity: DeviceCapacityRuntime;
} {
  const capacity = createDeviceCapacityRuntime(path.resolve(home), {
    createDirectory: false,
  });
  const files = new LogFilesProcess(path.resolve(home));
  return {
    store: new LocalLogStore({
      files,
      capacity: capacity.arbiter,
      observeWriters: createLogWriterProbe(path.resolve(home), files),
    }),
    capacity,
  };
}

export type RuntimeLogContext = Pick<RuntimeLogging, "bind" | "capacity">;

export interface RuntimeLogging {
  readonly capacity: DeviceCapacityRuntime;
  readonly records: LogRecordPort;
  readonly bind: BindLogSource;
  finish(result: LogResult, reason: string, flushTimeoutMs?: number): Promise<void>;
}

/** The entry owns this lifetime, before preflight and until after business cleanup. */
export function beginRuntimeLogging(
  home: string,
  mode: string,
  warn?: (message: string) => void,
  createStoreWorker?: LogStoreWorkerFactory,
  sharedCapacity?: DeviceCapacityRuntime,
  options: { activityDriven?: boolean; requireCompleteClose?: boolean; createStore?: (capacity: DeviceCapacityRuntime) => LogSink } = {},
): RuntimeLogging {
  const capacity = sharedCapacity ?? createDeviceCapacityRuntime(path.resolve(home), { createDirectory: false, activityDriven: options.activityDriven === true });
  const local = options.createStore?.(capacity);
  const active = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = capacity.retainActivity();
    try { return await operation(); } finally { release(); }
  };
  const store: LogSink = local ? {
    beginClose: deadline => local.beginClose?.(deadline),
    initialize: () => active(() => local.initialize()),
    append: records => active(() => local.append(records)),
    maintain: () => active(() => local.maintain()),
    close: () => local.close(),
  } : new IsolatedLogStore(path.resolve(home), capacity.arbiter, createStoreWorker, capacity.retainActivity);
  const boot = takeEntryLogging() ?? createBootstrapLogging(mode);
  const { recorder, bind, records } = boot;
  void beginWriterDeclaration(home, (reason, failure) => records.record({ event: "writerDeclarationUnavailable", data: { reason, failure } }));
  boot.attach(store, (health) => {
      if (health.state === "ready") warn?.("运行日志已恢复写入；此前的等待或缺口可用 zz logs 查看。");
      else if (health.state === "degraded") {
        const reason = health.lastFailure === "writer-busy" ? "写入持续等待" : health.lastFailure === "resource-wait" ? "资源暂不可用"
          : health.lastFailure === "probe-unavailable" ? "设备资源探测未就绪"
          : health.lastFailure === "migration-blocked" ? "旧日志切换未完成" : "存储或采集受阻";
        warn?.(`运行日志已降级（${reason}），业务继续运行；可用 zz logs 查看。`);
      }
  });
  const stopOutput = mode === "managed" || mode === "on-demand"
    ? observeBackgroundOutput(bind(STDIO_LOG_SOURCE, { scope: "storage" }, [], { maxPerSecond: 32 }))
    : undefined;
  void recorder.start();
  let finishing: Promise<void> | undefined;
  return {
    capacity,
    records,
    bind,
    finish: (result, reason, flushTimeoutMs = 5000) => {
      if (!finishing) {
        stopOutput?.();
        records.record({ event: "stopped", result, data: { reason } });
        // Include the bounded OS writer proof in a short-lived entry's drain window.
        finishing = recorder.close(Math.max(0, flushTimeoutMs)).then(() => {
          const failure = recorder.health().lastFailure;
          if (options.requireCompleteClose &&
              (failure === "close-pending" || failure === "close-failed" || failure === "close-incomplete")) {
            throw new Error(`Runtime logging ${failure}`);
          }
        }).finally(() => {
          // Compatibility describes the live process, not its recorder. S can
          // finish its logger while it still owns N's drain: withdrawing S's
          // proof here makes N classify S as an unknown legacy writer and wait
          // for the very process that is waiting for N. The entry owns this
          // unref'ed declaration until process teardown (or its final cleanup).
          if (!sharedCapacity) capacity.close();
        });
      }
      return finishing;
    },
  };
}
