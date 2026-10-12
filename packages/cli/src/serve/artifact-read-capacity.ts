import { durableProjectionReadBudget, type FileArtifactStoreOptions, type FileAuthorityCommitLogOptions } from "@zhixing/core/authority";
import {
  claimDeviceCapacity,
  currentDeviceCapacityStep,
  currentMaintenanceAbortSignal,
  currentMaintenanceUrgency,
  deviceCapacityAdmissionId,
  DeviceCapacityAdmissionError,
  isHoldingMaintenanceExclusion,
  StorageMaintenanceAdmissionError,
  withDeviceCapacityStep,
  type DeviceCapacityArbiterPort,
  type DeviceCapacityBudget,
} from "@zhixing/core/resources";

/** Physical caller reads share the Host arbiter and the caller's execution slot. */
export function artifactReadCapacity(
  arbiter: DeviceCapacityArbiterPort | undefined,
): FileArtifactStoreOptions["runReadStep"] {
  if (!arbiter) return undefined;
  return async (ref, operation) => {
    return readWithCapacity(arbiter, {
      memoryReservationBytes: Math.min(Number.MAX_SAFE_INTEGER, ref.bytes + 4096),
      readBytes: ref.bytes, ioOperations: 1,
    }, "artifact-read", false, operation);
  };
}

/** Actual bounded projection I/O leaves; in-memory lookups need no I/O permit. */
export function projectionReadCapacity(
  arbiter: DeviceCapacityArbiterPort | undefined,
): FileAuthorityCommitLogOptions["runProjectionReadStep"] {
  if (!arbiter) return undefined;
  return (step, operation) => readWithCapacity(arbiter, durableProjectionReadBudget(step),
    "projection-read", true, operation);
}

async function readWithCapacity<T>(
  arbiter: DeviceCapacityArbiterPort,
  budget: { memoryReservationBytes: number; readBytes: number; ioOperations: number },
  prefix: "artifact-read" | "projection-read",
  retryFromAuthority: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = currentDeviceCapacityStep();
  // A physical plan already owns its reads. Workloads with an explicit I/O
  // plan do too; only occupancy-only workloads need an incremental leaf.
  if (owner?.kind === "physical" || (owner?.kind === "workload" &&
    Object.values(owner.bound.quantum).some((value) => value !== 0))) {
    return operation();
  }
  const workload = owner?.kind === "workload" ? owner : undefined;
  const sharedSlot = workload?.arbiter === arbiter && workload.bound.occupancy.slots > 0;
  const bound: DeviceCapacityBudget = {
    occupancy: {
      memoryReservationBytes: budget.memoryReservationBytes,
      temporaryBytes: 0,
      slots: sharedSlot ? 0 : 1,
    },
    quantum: { readBytes: budget.readBytes, writeBytes: 0, ioOperations: budget.ioOperations },
  };
  const abort = workload
    ? AbortSignal.any([workload.abort, currentMaintenanceAbortSignal()])
    : currentMaintenanceAbortSignal();
  const admission = await arbiter.acquire({
    admissionId: deviceCapacityAdmissionId(prefix),
    serviceClass: workload?.serviceClass ?? `storage-${currentMaintenanceUrgency()}`,
    atomic: bound,
    preferred: bound,
    // Never queue while holding another permit or an exclusion. The owner
    // receives the typed backpressure and can retry outside that boundary.
    maxWaitMs: owner || isHoldingMaintenanceExclusion() ? 0 : 5000,
  }, abort);
  if (admission.kind !== "granted") {
    throw workload && !retryFromAuthority
      ? new DeviceCapacityAdmissionError(admission)
      : new StorageMaintenanceAdmissionError(admission);
  }
  try {
    return await withDeviceCapacityStep(admission.permit, bound, async () => {
      if (abort.aborted) throw new DeviceCapacityAdmissionError({ kind: "cancelled" });
      claimDeviceCapacity("memoryReservationBytes", bound.occupancy.memoryReservationBytes);
      return operation();
    });
  } finally {
    admission.permit.release();
  }
}
