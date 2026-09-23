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
  const filesystem =
    options.createDirectory === false ? asyncFilesystemPressure(temporaryRoot) : undefined;
  const underlying = new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    probe: createNodeDeviceCapacityProbe(
      temporaryRoot,
      filesystem ? { readFilesystem: filesystem.read } : {},
    ),
  });
  const arbiter: DeviceCapacityArbiterPort = filesystem
    ? {
        snapshot: () => underlying.snapshot(),
        acquire: async (request, abort) => {
          const started = Date.now();
          await filesystem.prepare(request.maxWaitMs, abort);
          return underlying.acquire(
            { ...request, maxWaitMs: Math.max(0, request.maxWaitMs - (Date.now() - started)) },
            abort,
          );
        },
      }
    : underlying;
  const storage = new DefaultStorageMaintenanceGovernor({
    capacity: arbiter,
  });
  return {
    arbiter,
    storage,
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
  let sampled: { bavail: number; bsize: number } | undefined,
    sampledAt = 0;
  let flight: Promise<void> | undefined;
  const fresh = (): boolean => sampled !== undefined && Date.now() - sampledAt < 250;
  const refresh = (): Promise<void> =>
    (flight ??= (async () => {
      let current = path.resolve(root);
      for (;;) {
        try {
          sampled = await statfs(current);
          sampledAt = Date.now();
          return;
        } catch (error) {
          const parent = path.dirname(current);
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
          current = parent;
        }
      }
    })().finally(() => {
      flight = undefined;
    }));
  return {
    read: () => {
      if (!fresh()) {
        void refresh().catch(() => undefined);
        throw Error("设备磁盘探测尚未就绪");
      }
      return sampled!;
    },
    prepare: async (maxWaitMs: number, abort: AbortSignal): Promise<void> => {
      if (fresh() || abort.aborted) return;
      const pending = refresh().catch(() => undefined);
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
