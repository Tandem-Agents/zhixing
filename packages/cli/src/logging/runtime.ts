import { randomUUID } from "node:crypto";
import { ZHIXING_CLI_VERSION } from "../version.js";
import path from "node:path";
import {
  LogRecorder,
  type BindLogSource,
  type LogRecordPort,
  type LogResult,
  type LogSource,
} from "@zhixing/core/logging";
import { LocalLogStore } from "@zhixing/core/logging/storage";
import {
  createDeviceCapacityRuntime,
  type DeviceCapacityRuntime,
} from "../serve/device-capacity-runtime.js";
import { LogFilesProcess } from "./files-process.js";
import { observeBackgroundOutput, STDIO_LOG_SOURCE } from "./stdio.js";
import { createLogWriterProbe } from "./writers.js";
import type { StartupCheckResult } from "../startup.js";

export const RUNTIME_LOG_SOURCE: LogSource = {
  id: "runtime",
  version: 1,
  events: {
    started: {
      message: "运行入口已开始",
      level: "info",
      tier: "critical",
      fields: { mode: "text", implementation: "text" },
    },
    hostStarted: {
      message: "宿主开始装配",
      level: "info",
      tier: "critical",
      fields: {},
    },
    hostStopped: {
      message: "宿主运行与资源清理已结束",
      level: "info",
      tier: "critical",
      fields: { cleanupFailures: "number" },
    },
    stopped: {
      message: "运行入口已结束",
      level: "info",
      tier: "critical",
      fields: { reason: "text" },
    },
    hostConnected: { message: "前台已连接宿主", level: "info", tier: "critical", fields: { attempt: "number" } },
    failed: { message: "运行入口发生错误", level: "error", tier: "critical", fields: {
      reason: "text", error: "text", attempt: "number",
      issues: { items: { fields: { field: "text", reason: "text" } }, maxItems: 16 },
      missing: { items: "text", maxItems: 32 },
    } },
  },
};

/** Preserve the observed cause before entry drain, without copying configuration or credentials. */
export function recordRuntimeFailure(records: LogRecordPort | undefined, error: unknown, reason: string, attempt?: number): void {
  records?.record(() => ({ event: "failed", result: "failure", data: {
    reason, attempt, error: error instanceof Error ? error.message : typeof error === "string" ? error : "运行入口抛出非标准错误",
  } }));
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
  return {
    store: new LocalLogStore({
      files: new LogFilesProcess(path.resolve(home)),
      capacity: capacity.arbiter,
      observeWriters: createLogWriterProbe(path.resolve(home)),
    }),
    capacity,
  };
}

export type RuntimeLogContext = Pick<RuntimeLogging, "bind" | "capacity">;

export interface RuntimeLogging {
  readonly capacity: DeviceCapacityRuntime;
  readonly records: LogRecordPort;
  readonly bind: BindLogSource;
  finish(result: LogResult, reason: string): Promise<void>;
}

/** The entry owns this lifetime, before preflight and until after business cleanup. */
export function beginRuntimeLogging(
  home: string,
  mode: string,
  warn?: (message: string) => void,
): RuntimeLogging {
  const { store, capacity } = createLocalLogStore(home);
  const recorder = new LogRecorder(store, {
    onHealth: () => warn?.("运行日志暂不可用，业务继续运行；稍后可用 zz logs 查看。"),
  });
  const operation = { kind: "operation", id: randomUUID() };
  const bind: BindLogSource = (source, access, refs = [], admission) => recorder.bind(source, access, [operation, ...refs], admission);
  const records = bind(RUNTIME_LOG_SOURCE, { scope: "storage" });
  const stopOutput = mode === "managed" || mode === "on-demand"
    ? observeBackgroundOutput(bind(STDIO_LOG_SOURCE, { scope: "storage" }, [], { maxPerSecond: 32 }))
    : undefined;
  records.record({ event: "started", data: { mode, implementation: ZHIXING_CLI_VERSION } });
  void recorder.start();
  let finishing: Promise<void> | undefined;
  return {
    capacity,
    records,
    bind,
    finish: (result, reason) => {
      if (!finishing) {
        stopOutput?.();
        records.record({ event: "stopped", result, data: { reason } });
        // Include the bounded OS writer proof in a short-lived entry's drain window.
        finishing = recorder.close(5000);
      }
      return finishing;
    },
  };
}
