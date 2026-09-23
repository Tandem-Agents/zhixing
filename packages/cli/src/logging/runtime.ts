import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  LogRecorder,
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

export const RUNTIME_LOG_SOURCE: LogSource = {
  id: "runtime",
  version: 1,
  events: {
    started: {
      message: "运行入口已开始",
      level: "info",
      tier: "critical",
      fields: { mode: "text" },
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
  },
};

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
    }),
    capacity,
  };
}

export interface RuntimeLogging {
  readonly capacity: DeviceCapacityRuntime;
  readonly records: LogRecordPort;
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
  const bound = recorder.bind(RUNTIME_LOG_SOURCE, { scope: "storage" });
  const operation = { kind: "operation", id: randomUUID() };
  const records: LogRecordPort = {
    record: (draft) => bound.record({ ...draft, refs: [operation] }),
  };
  records.record({ event: "started", data: { mode } });
  void recorder.start();
  let finishing: Promise<void> | undefined;
  return {
    capacity,
    records,
    finish: (result, reason) => {
      if (!finishing) {
        records.record({ event: "stopped", result, data: { reason } });
        finishing = recorder.close();
      }
      return finishing;
    },
  };
}
