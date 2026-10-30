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
import { diskPressure, type DiskSamplerStarter } from "./disk-pressure-sampler.js";

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
  options: { createDirectory?: boolean; activityDriven?: boolean; diskSampler?: DiskSamplerStarter } = {},
) {
  if (options.createDirectory !== false) mkdirSync(temporaryRoot, { recursive: true });
  const stopped = new AbortController();
  const filesystem = diskPressure(temporaryRoot, options.activityDriven === true, options.diskSampler);
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
        // 磁盘样本只决定临时空间这一维：原子与首选都不要临时空间的请求不等样本（缺样本只让这一维未知，
        // 这类请求的准入结论不变）；要临时空间的照旧等新鲜样本
        if (request.atomic.occupancy.temporaryBytes > 0 || request.preferred.occupancy.temporaryBytes > 0) {
          await filesystem.prepare(request.maxWaitMs, signal);
        }
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

