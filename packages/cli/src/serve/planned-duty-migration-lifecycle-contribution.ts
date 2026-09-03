import type { AuthorityCheckpointOwnerPort } from "@zhixing/mesh/checkpoint-owner";
import type { InstalledAuthorityGenerationReceipt } from "../setup-delivery.js";
import type {
  InstalledAuthorityGeneration,
  PlannedAnchorTransferLifecycle,
} from "./planned-anchor-transfer.js";

type RecoveryCheckpointOwner = Pick<AuthorityCheckpointOwnerPort, "force" | "status">;

export type PlannedDutyMigrationCheckpointContribution =
  | Readonly<{
      kind: "available";
      owner: RecoveryCheckpointOwner;
    }>
  | Readonly<{
      kind: "unavailable";
      reason: "recovery-backup-unavailable";
    }>;

export interface PlannedAnchorPostInstallConsumers {
  readonly rebindAuthorityGeneration: (
    generation: InstalledAuthorityGeneration,
  ) => Promise<InstalledAuthorityGenerationReceipt>;
  readonly recoverScheduler: (
    obligations: readonly { readonly kind: "assignment" | "intent"; readonly id: string }[],
  ) => Promise<readonly { readonly kind: "assignment" | "intent"; readonly id: string }[]>;
  readonly recoverConversation: (
    obligations: readonly {
      readonly kind: "interaction" | "confirmation" | "final";
      readonly id: string;
    }[],
  ) => Promise<readonly {
    readonly kind: "interaction" | "confirmation" | "final";
    readonly id: string;
  }[]>;
  readonly recoverDelivery: (
    obligations: readonly { readonly kind: "delivery"; readonly id: string }[],
  ) => Promise<readonly { readonly kind: "delivery"; readonly id: string }[]>;
  readonly openCurrentOwnerSurfaces: () => Promise<void>;
}

export interface PlannedDutyMigrationAnchorLifecycleContribution {
  readonly kind: "anchor";
  readonly checkpoint: PlannedDutyMigrationCheckpointContribution;
  readonly transfer: PlannedAnchorTransferLifecycle;
  readonly postInstall: PlannedAnchorPostInstallConsumers;
}

export interface PlannedDutyMigrationAbsentLifecycleContribution {
  readonly kind: "absent";
  readonly role: "executor-only";
}

export type PlannedDutyMigrationLifecycleContribution =
  | PlannedDutyMigrationAnchorLifecycleContribution
  | PlannedDutyMigrationAbsentLifecycleContribution;

const ANCHOR_KEYS = Object.freeze(["checkpoint", "kind", "postInstall", "transfer"] as const);
const ABSENT_KEYS = Object.freeze(["kind", "role"] as const);
const CHECKPOINT_AVAILABLE_KEYS = Object.freeze(["kind", "owner"] as const);
const CHECKPOINT_UNAVAILABLE_KEYS = Object.freeze(["kind", "reason"] as const);
const TRANSFER_KEYS = Object.freeze([
  "drainAccepted",
  "resumeAfterAbort",
  "stopAccepting",
] as const);
const POST_INSTALL_KEYS = Object.freeze([
  "openCurrentOwnerSurfaces",
  "rebindAuthorityGeneration",
  "recoverConversation",
  "recoverDelivery",
  "recoverScheduler",
] as const);

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} must provide its exact finite contract`);
  }
}

function assertFunctions(
  value: object,
  keys: readonly string[],
  label: string,
): void {
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] !== "function") {
      throw new TypeError(`${label} effect is invalid: ${key}`);
    }
  }
}

/**
 * Freezes the one role-selected planned-duty lifecycle before Mesh recovery or
 * control services can become reachable.
 */
export function definePlannedDutyMigrationLifecycleContribution(
  input: PlannedDutyMigrationLifecycleContribution,
): PlannedDutyMigrationLifecycleContribution {
  if (!input || typeof input !== "object") {
    throw new TypeError("Planned-duty migration lifecycle contribution is required");
  }
  if (input.kind === "absent") {
    assertExactKeys(input, ABSENT_KEYS, "Absent planned-duty migration contribution");
    if (input.role !== "executor-only") {
      throw new TypeError("Planned-duty migration absent profile is invalid");
    }
    return Object.freeze({ kind: "absent", role: input.role });
  }
  if (input.kind !== "anchor") {
    throw new TypeError("Planned-duty migration lifecycle role is invalid");
  }
  assertExactKeys(input, ANCHOR_KEYS, "Anchor planned-duty migration contribution");
  const checkpoint = input.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new TypeError("Planned-duty migration checkpoint contribution is required");
  }
  const frozenCheckpoint = checkpoint.kind === "available"
    ? (() => {
        assertExactKeys(
          checkpoint,
          CHECKPOINT_AVAILABLE_KEYS,
          "Available recovery-checkpoint contribution",
        );
        assertFunctions(checkpoint.owner, ["force", "status"], "Recovery-checkpoint owner");
        return Object.freeze({ kind: "available" as const, owner: checkpoint.owner });
      })()
    : (() => {
        if (
          checkpoint.kind !== "unavailable" ||
          checkpoint.reason !== "recovery-backup-unavailable"
        ) {
          throw new TypeError("Planned-duty migration checkpoint profile is invalid");
        }
        assertExactKeys(
          checkpoint,
          CHECKPOINT_UNAVAILABLE_KEYS,
          "Unavailable recovery-checkpoint contribution",
        );
        return Object.freeze({
          kind: "unavailable" as const,
          reason: checkpoint.reason,
        });
      })();
  assertExactKeys(input.transfer, TRANSFER_KEYS, "Planned-duty transfer lifecycle");
  assertFunctions(input.transfer, TRANSFER_KEYS, "Planned-duty transfer lifecycle");
  assertExactKeys(input.postInstall, POST_INSTALL_KEYS, "Planned-duty post-install consumers");
  assertFunctions(input.postInstall, POST_INSTALL_KEYS, "Planned-duty post-install consumers");
  return Object.freeze({
    kind: "anchor",
    checkpoint: frozenCheckpoint,
    transfer: Object.freeze({ ...input.transfer }),
    postInstall: Object.freeze({ ...input.postInstall }),
  });
}

export const EXECUTOR_ONLY_PLANNED_DUTY_MIGRATION_LIFECYCLE =
  definePlannedDutyMigrationLifecycleContribution({
    kind: "absent",
    role: "executor-only",
  });
