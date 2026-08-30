import type { WorkspaceAdministrationDurableInfrastructureFailure } from "@zhixing/core/environment/workspace-administration";
import { WorkspaceBindingCancelledError } from "@zhixing/core/environment";
import {
  DeviceCapacityAdmissionError,
  StorageMaintenanceAdmissionError,
  StorageMaintenanceCancelledError,
} from "@zhixing/core/resources";
import {
  ExecutorResourceAdmissionExpiredError,
  ExecutorResourceAdmissionPendingError,
  ExecutorResourceBackpressureError,
} from "@zhixing/executor";

/**
 * Projects concrete Correctness failures into the domain-owned lifecycle
 * decision boundary without exposing Executor, storage, or Node error types.
 */
export function observeLocalWorkspaceDurableInfrastructureFailure(
  error: unknown,
): WorkspaceAdministrationDurableInfrastructureFailure {
  const retryAfterMs = retryDelayFrom(error);
  return Object.freeze({
    code: stableErrorCode(error),
    message:
      error instanceof Error
        ? error.message
        : "Local workspace operation failed",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function retryDelayFrom(error: unknown): number | undefined {
  if (
    error instanceof ExecutorResourceBackpressureError ||
    error instanceof ExecutorResourceAdmissionPendingError ||
    error instanceof ExecutorResourceAdmissionExpiredError ||
    error instanceof WorkspaceBindingCancelledError ||
    error instanceof StorageMaintenanceCancelledError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return 0;
  }
  if (error instanceof DeviceCapacityAdmissionError) {
    return "retryAfterMs" in error.admission &&
      typeof error.admission.retryAfterMs === "number"
      ? error.admission.retryAfterMs
      : 0;
  }
  if (error instanceof StorageMaintenanceAdmissionError) {
    return "retryAfterMs" in error.admission &&
      typeof error.admission.retryAfterMs === "number"
      ? error.admission.retryAfterMs
      : 0;
  }
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "EAGAIN" ||
      code === "EBUSY" ||
      code === "EINTR" ||
      code === "EMFILE" ||
      code === "ENFILE" ||
      code === "ENOSPC" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET"
    ) {
      return 0;
    }
  }
  return undefined;
}

function stableErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  ) {
    return (error as { readonly code: string }).code;
  }
  if (error instanceof WorkspaceBindingCancelledError) {
    return "WORKSPACE_BINDING_CANCELLED";
  }
  if (error instanceof DeviceCapacityAdmissionError) {
    return "DEVICE_CAPACITY_NOT_ADMITTED";
  }
  if (error instanceof StorageMaintenanceAdmissionError) {
    return "STORAGE_MAINTENANCE_NOT_ADMITTED";
  }
  if (error instanceof StorageMaintenanceCancelledError) {
    return "STORAGE_MAINTENANCE_CANCELLED";
  }
  if (error instanceof ExecutorResourceBackpressureError) {
    return "EXECUTOR_RESOURCE_BACKPRESSURE";
  }
  if (error instanceof ExecutorResourceAdmissionPendingError) {
    return "EXECUTOR_RESOURCE_ADMISSION_PENDING";
  }
  if (error instanceof ExecutorResourceAdmissionExpiredError) {
    return "EXECUTOR_RESOURCE_ADMISSION_EXPIRED";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "LOCAL_WORKSPACE_OPERATION_CANCELLED";
  }
  return "LOCAL_WORKSPACE_OPERATION_FAILED";
}
