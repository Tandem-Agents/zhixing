import {
  currentMaintenanceAbortSignal, currentMaintenanceUrgency, isHoldingMaintenanceExclusion,
  maintenanceRetryDelayMs, runWithMaintenanceUrgency, StorageMaintenanceCancelledError,
} from "@zhixing/core/resources";
import { awaitAuthorityPreparation } from "@zhixing/core/authority";

/** One stable control identity, one finite recovery window, and no wait inside a serial owner. */
export async function retryControlAdmission<T>(
  operation: () => Promise<T>,
  recover: () => Promise<void>,
  signal?: AbortSignal,
): Promise<T> {
  const parent = currentMaintenanceAbortSignal();
  const external = signal ? AbortSignal.any([parent, signal]) : parent;
  const deadline = new AbortController();
  const abort = AbortSignal.any([external, deadline.signal]);
  const urgency = currentMaintenanceUrgency();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPressure: unknown;
  let recovering = false;
  try {
    for (;;) {
      if (external.aborted) throw new StorageMaintenanceCancelledError();
      if (deadline.signal.aborted) throw lastPressure;
      try {
        return await runWithMaintenanceUrgency(() => urgency, abort, async () => {
          if (recovering) {
            await recover();
            recovering = false;
          }
          if (external.aborted) throw new StorageMaintenanceCancelledError();
          if (deadline.signal.aborted) throw lastPressure;
          return operation();
        });
      } catch (error) {
        if (external.aborted) throw new StorageMaintenanceCancelledError();
        if (deadline.signal.aborted) throw lastPressure ?? error;
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion()) throw error;
        if (await awaitAuthorityPreparation(error)) continue;
        lastPressure = error;
        timer ??= setTimeout(() => deadline.abort(), 5_000);
        recovering = true;
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(wait); abort.removeEventListener("abort", finish); resolve(); };
          const wait = setTimeout(finish, Math.max(1, Math.min(delay, 250)));
          abort.addEventListener("abort", finish, { once: true });
          if (abort.aborted) finish();
        });
      }
    }
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * 模型用量预留/结算：同一 usageId 在资源权威内幂等，可重试背压在运行层有限退避后重试；
 * 容量缺口、取消与内容不符照原样上抛。调用处不持锁与许可。
 */
export function retryResourceUsage<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return retryControlAdmission(operation, async () => {}, signal);
}
