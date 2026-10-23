import {
  createDefaultDeviceCapacityPolicy,
  createNodeDeviceCapacityProbe,
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
  ForegroundActivity,
  type DeviceCapacityBudget,
  type DeviceCapacityClass,
  type DeviceCapacityArbiterPort,
} from "@zhixing/core/resources";
import type { AgentRuntimeCapacityBinding } from "@zhixing/orchestrator/runtime";
import { mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";

const MIB = 1024 * 1024;

const WORKLOAD_ATOMIC: DeviceCapacityBudget = {
  occupancy: {
    memoryReservationBytes: 32 * MIB,
    temporaryBytes: 0,
    slots: 1,
  },
  quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 },
};

const WORKLOAD_PREFERRED: DeviceCapacityBudget = {
  occupancy: {
    memoryReservationBytes: 128 * MIB,
    temporaryBytes: 0,
    slots: 1,
  },
  quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 },
};

/** 前台最近一次活动之后多久仍算活跃：在此之前后台维护（升级后的会话迁移及其段整理）不推进。 */
export const FOREGROUND_QUIET_MS = 500;

export function createDeviceCapacityRuntime(
  temporaryRoot: string,
  options: { createDirectory?: boolean; activityDriven?: boolean } = {},
) {
  if (options.createDirectory !== false) mkdirSync(temporaryRoot, { recursive: true });
  const stopped = new AbortController();
  const filesystem = asyncFilesystemPressure(temporaryRoot, options.activityDriven === true);
  const underlying = new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    probe: createNodeDeviceCapacityProbe(
      temporaryRoot,
      { readFilesystem: filesystem.read },
    ),
  });
  const arbiter: DeviceCapacityArbiterPort = {
    snapshot: () => underlying.snapshot(),
    acquire: async (request, abort) => {
      const signal = AbortSignal.any([abort, stopped.signal]);
      if (signal.aborted) return { kind: "cancelled" };
      const releaseActivity = filesystem.retainActivity();
      const started = performance.now();
      let granted = false;
      try {
        await filesystem.prepare(request.maxWaitMs, signal);
        const result = await underlying.acquire(
          { ...request, maxWaitMs: Math.max(0, request.maxWaitMs - Math.ceil(performance.now() - started)) }, signal,
        );
        if (result.kind !== 'granted') return result;
        granted = true;
        const permit = result.permit;
        return { kind: 'granted', permit: {
          granted: permit.granted, tryBegin: bound => permit.tryBegin(bound),
          release: () => { try { permit.release(); } finally { releaseActivity(); } },
        } };
      } finally { if (!granted) releaseActivity(); }
    },
  };
  const foreground = new ForegroundActivity();
  const storage = new DefaultStorageMaintenanceGovernor({
    capacity: arbiter,
  });
  return {
    arbiter,
    storage,
    // 宿主前台活动（请求在途、运行进行中、向接入面推送）：后台维护据此让路。
    foreground,
    // Owners with a recovery prefix retain sampling across that prefix and
    // all its leaf admissions. This does not reserve capacity or extend TTL.
    retainActivity: filesystem.retainActivity,
    close(): void {
      stopped.abort();
      filesystem.close();
    },
    workload(
      serviceClass: Extract<DeviceCapacityClass, `workload-${string}`>,
    ): AgentRuntimeCapacityBinding {
      return {
        arbiter,
        serviceClass,
        atomic: WORKLOAD_ATOMIC,
        preferred: WORKLOAD_PREFERRED,
        maxWaitMs: 5_000,
      };
    },
  };
}

export type DeviceCapacityRuntime = ReturnType<typeof createDeviceCapacityRuntime>;

/** A single asynchronous disk sample feeds the existing synchronous arbiter contract. */
function asyncFilesystemPressure(root: string, activityDriven: boolean) {
  const maxAgeMs = 250, refreshMs = 100;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sampled: { bavail: number; bsize: number } | undefined,
    sampledAt = 0;
  let flight: Promise<void> | undefined;
  let refreshStartedAt = 0;
  let activities = 0;
  const fresh = (): boolean => !closed && sampled !== undefined && performance.now() - sampledAt < maxAgeMs;
  const schedule = (): void => {
    if (closed || timer || (activityDriven && activities === 0)) return;
    // Cadence is measured from probe start, not completion. Otherwise a valid
    // 200 ms sample plus the 100 ms interval necessarily exceeds the 250 ms
    // freshness bound and repeatedly rejects zero-wait control reads.
    timer = setTimeout(() => { timer = undefined; void refresh(); },
      Math.max(0, refreshMs - (performance.now() - refreshStartedAt)));
    timer.unref();
  };
  const refresh = (): Promise<void> =>
    closed ? Promise.resolve() : (flight ??= (async () => {
      refreshStartedAt = performance.now();
      let current = path.resolve(root);
      for (;;) {
        try {
          const value = await statfs(current);
          if (closed) return;
          sampled = value;
          sampledAt = performance.now();
          return;
        } catch (error) {
          if (closed) return;
          const parent = path.dirname(current);
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
          current = parent;
        }
      }
    })().catch(() => { sampled = undefined; }).finally(() => {
      flight = undefined;
      schedule();
    }));
  if (!activityDriven) void refresh();
  return {
    retainActivity: (): (() => void) => {
      if (closed) return () => {};
      activities++;
      if (!fresh()) void refresh(); else schedule();
      let released = false;
      return () => {
        if (released) return; released = true; activities--;
        if (activityDriven && activities === 0) { clearTimeout(timer); timer = undefined; }
      };
    },
    close: (): void => { closed = true; clearTimeout(timer); timer = undefined; sampled = undefined; },
    read: () => {
      if (!fresh()) {
        void refresh();
        throw Error("设备磁盘探测尚未就绪");
      }
      return sampled!;
    },
    prepare: async (maxWaitMs: number, abort: AbortSignal): Promise<void> => {
      if (fresh() || abort.aborted || closed) return;
      const pending = refresh();
      if (maxWaitMs === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined, cancelled: (() => void) | undefined;
      try {
        await Promise.race([
          pending,
          new Promise<void>((resolve) => {
            cancelled = () => resolve();
            abort.addEventListener("abort", cancelled, { once: true });
            timer = setTimeout(resolve, Math.min(250, maxWaitMs));
            if (abort.aborted) resolve();
          }),
        ]);
      } finally {
        clearTimeout(timer);
        if (cancelled) abort.removeEventListener("abort", cancelled);
      }
    },
  };
}
