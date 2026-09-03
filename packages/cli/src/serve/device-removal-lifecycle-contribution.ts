import type {
  DeviceLifecycleEvidenceRef,
  ExecutorRemovalLifecycleIdentity,
} from "@zhixing/core/protocol";

export interface DeviceRemovalAcceptedWorkItem {
  readonly owner:
    | "conversation"
    | "intent"
    | "final"
    | "assignment"
    | "remote"
    | "channel"
    | "scheduler"
    | "delivery"
    | "lease"
    | "permit";
  readonly id: string;
  readonly revision: string;
}

export const DEVICE_REMOVAL_LIFECYCLE_EFFECTS = Object.freeze([
  "closeAdmission",
  "captureAcceptedWork",
  "settleAcceptedWork",
  "releaseAdmission",
  "cleanup",
  "finalizeDeviceKey",
  "onRemoved",
] as const);

/**
 * Host-owned, topology-neutral lifecycle contribution required by the local
 * device-removal target before any Mesh ingress can become reachable.
 */
export interface DeviceRemovalLifecycleContribution {
  readonly closeAdmission: (operationId: string) => Promise<void>;
  readonly captureAcceptedWork: (
    operationId: string,
  ) => Promise<readonly DeviceRemovalAcceptedWorkItem[]>;
  readonly settleAcceptedWork: (input: {
    readonly operationId: string;
    readonly mode: "transfer" | "destroy";
    readonly ownerItems: readonly DeviceRemovalAcceptedWorkItem[];
  }) => Promise<void>;
  readonly releaseAdmission: (operationId: string) => Promise<void>;
  readonly cleanup: (
    operationId: string,
  ) => Promise<readonly DeviceLifecycleEvidenceRef[]>;
  readonly finalizeDeviceKey: (
    operationId: string,
    identity: ExecutorRemovalLifecycleIdentity,
  ) => Promise<readonly DeviceLifecycleEvidenceRef[]>;
  readonly onRemoved: (operationId: string) => void | Promise<void>;
}

/** Runtime fail-closed boundary for JavaScript and structurally cast callers. */
export function defineDeviceRemovalLifecycleContribution(
  input: DeviceRemovalLifecycleContribution,
): DeviceRemovalLifecycleContribution {
  if (!input || typeof input !== "object") {
    throw new TypeError("Device removal lifecycle contribution is required");
  }
  const keys = Object.keys(input).sort();
  const expected = [...DEVICE_REMOVAL_LIFECYCLE_EFFECTS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("Device removal lifecycle contribution must provide the exact effect set");
  }
  for (const effect of DEVICE_REMOVAL_LIFECYCLE_EFFECTS) {
    if (typeof input[effect] !== "function") {
      throw new TypeError(`Device removal lifecycle effect is invalid: ${effect}`);
    }
  }
  return Object.freeze({ ...input });
}
