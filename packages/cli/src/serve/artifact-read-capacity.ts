import type { FileArtifactStoreOptions } from "@zhixing/core/authority";
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
        memoryReservationBytes: Math.min(Number.MAX_SAFE_INTEGER, ref.bytes + 4096),
        temporaryBytes: 0,
        slots: sharedSlot ? 0 : 1,
      },
      quantum: { readBytes: ref.bytes, writeBytes: 0, ioOperations: 1 },
    };
    const abort = workload
      ? AbortSignal.any([workload.abort, currentMaintenanceAbortSignal()])
      : currentMaintenanceAbortSignal();
    const admission = await arbiter.acquire({
      admissionId: deviceCapacityAdmissionId("artifact-read"),
      serviceClass: workload?.serviceClass ?? `storage-${currentMaintenanceUrgency()}`,
      atomic: bound,
      preferred: bound,
      // Never queue while holding another permit or an exclusion. The owner
      // receives the typed backpressure and can retry outside that boundary.
      maxWaitMs: owner || isHoldingMaintenanceExclusion() ? 0 : 5000,
    }, abort);
    if (admission.kind !== "granted") {
      throw workload
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
  };
}
