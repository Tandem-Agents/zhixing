import {
  createDefaultDeviceCapacityPolicy,
  createNodeDeviceCapacityProbe,
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
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

export function createDeviceCapacityRuntime(
  temporaryRoot: string,
  options: { createDirectory?: boolean } = {},
) {
  if (options.createDirectory !== false) mkdirSync(temporaryRoot, { recursive: true });
  const stopped = new AbortController();
  const filesystem = asyncFilesystemPressure(temporaryRoot);
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
      const started = Date.now();
      await filesystem.prepare(request.maxWaitMs, signal);
      return underlying.acquire(
        { ...request, maxWaitMs: Math.max(0, request.maxWaitMs - (Date.now() - started)) },
        signal,
      );
    },
  };
  const storage = new DefaultStorageMaintenanceGovernor({
    capacity: arbiter,
  });
  return {
    arbiter,
    storage,
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
function asyncFilesystemPressure(root: string) {
  const maxAgeMs = 250, refreshMs = 100;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sampled: { bavail: number; bsize: number } | undefined,
    sampledAt = 0;
  let flight: Promise<void> | undefined;
  const fresh = (): boolean => !closed && sampled !== undefined && performance.now() - sampledAt < maxAgeMs;
  const schedule = (): void => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = undefined; void refresh(); }, refreshMs);
    timer.unref();
  };
  const refresh = (): Promise<void> =>
    closed ? Promise.resolve() : (flight ??= (async () => {
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
  // Probe progress belongs to this runtime's lifetime, not to a rejected leaf
  // request. Slow recovery prefixes must not repeatedly outlive a one-shot sample.
  void refresh();
  return {
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
