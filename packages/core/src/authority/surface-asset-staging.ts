import type { ArtifactRef } from "../contracts/index.js";
import type {
  ArtifactReceiveProgress,
  IdentifiedPhysicalStepRunner,
} from "./assignment-artifacts.js";
import type {
  ArtifactReferenceCursor,
  PhysicalStorageStepRunner,
} from "./interfaces.js";

/** Finite upload capabilities required by the Surface asset coordinator. */
export interface SurfaceAssetUploadStagingPort {
  readonly progress: (ref: ArtifactRef) => Promise<ArtifactReceiveProgress>;
  readonly append: (
    ref: ArtifactRef,
    offset: number,
    bytes: Uint8Array,
  ) => Promise<ArtifactReceiveProgress>;
  readonly discard: (
    ref: ArtifactRef,
    runPhysicalStep?: PhysicalStorageStepRunner,
  ) => Promise<boolean>;
}

/** Finite partial-file recovery capabilities required by lifecycle rebuild. */
export interface SurfaceAssetTemporaryRecoveryPort {
  readonly progress: (
    ref: ArtifactRef,
    runPhysicalStep?: IdentifiedPhysicalStepRunner,
  ) => Promise<ArtifactReceiveProgress>;
  readonly openPartialReferenceCursor: (
    runPhysicalStep?: PhysicalStorageStepRunner,
  ) => ArtifactReferenceCursor;
}

export interface SurfaceAssetTemporaryPresenceEntry {
  readonly ref: ArtifactRef;
  readonly scopeIdentity: string;
}

export interface SurfaceAssetTemporaryPresenceCursor {
  next(limit: number): Promise<{
    readonly entries: readonly SurfaceAssetTemporaryPresenceEntry[];
    readonly done: boolean;
  }>;
  close(): Promise<void>;
}

/** Finite durable-presence capabilities required by lifecycle accounting. */
export interface SurfaceAssetTemporaryPresencePort {
  readonly mark: (ref: ArtifactRef, scopeIdentity: string) => Promise<void>;
  readonly has: (ref: ArtifactRef) => Promise<boolean>;
  readonly removeScopes: (
    ref: ArtifactRef,
    scopeIdentities: readonly string[],
  ) => Promise<void>;
  readonly remove: (
    ref: ArtifactRef,
    scopeIdentity?: string,
  ) => Promise<void>;
  readonly openReconciliationCursor: () => SurfaceAssetTemporaryPresenceCursor;
  readonly hasLegacyMigration: (ref: ArtifactRef) => Promise<boolean>;
  readonly beginLegacyMigration: (ref: ArtifactRef) => Promise<void>;
  readonly finishLegacyMigration: (ref: ArtifactRef) => Promise<void>;
}

export interface SurfaceAssetStagingPorts {
  readonly upload: SurfaceAssetUploadStagingPort;
  readonly recovery: SurfaceAssetTemporaryRecoveryPort;
  readonly presence: SurfaceAssetTemporaryPresencePort;
}

/**
 * Projects physical staging mechanisms into the three demand-owned roles.
 * Wrappers deliberately hide every additional receiver/store capability.
 */
export function projectSurfaceAssetStagingPorts(
  receiver: SurfaceAssetUploadStagingPort & SurfaceAssetTemporaryRecoveryPort,
  presence: SurfaceAssetTemporaryPresencePort,
): SurfaceAssetStagingPorts {
  assertReceiver(receiver);
  assertPresence(presence);
  return Object.freeze({
    upload: Object.freeze({
      progress: (ref: ArtifactRef) => receiver.progress(ref),
      append: (ref: ArtifactRef, offset: number, bytes: Uint8Array) =>
        receiver.append(ref, offset, bytes),
      discard: (
        ref: ArtifactRef,
        runPhysicalStep?: PhysicalStorageStepRunner,
      ) => receiver.discard(ref, runPhysicalStep),
    }),
    recovery: Object.freeze({
      progress: (
        ref: ArtifactRef,
        runPhysicalStep?: IdentifiedPhysicalStepRunner,
      ) => receiver.progress(ref, runPhysicalStep),
      openPartialReferenceCursor: (
        runPhysicalStep?: PhysicalStorageStepRunner,
      ) => receiver.openPartialReferenceCursor(runPhysicalStep),
    }),
    presence: Object.freeze({
      mark: (ref: ArtifactRef, scopeIdentity: string) =>
        presence.mark(ref, scopeIdentity),
      has: (ref: ArtifactRef) => presence.has(ref),
      removeScopes: (ref: ArtifactRef, scopeIdentities: readonly string[]) =>
        presence.removeScopes(ref, scopeIdentities),
      remove: (ref: ArtifactRef, scopeIdentity?: string) =>
        presence.remove(ref, scopeIdentity),
      openReconciliationCursor: () => presence.openReconciliationCursor(),
      hasLegacyMigration: (ref: ArtifactRef) =>
        presence.hasLegacyMigration(ref),
      beginLegacyMigration: (ref: ArtifactRef) =>
        presence.beginLegacyMigration(ref),
      finishLegacyMigration: (ref: ArtifactRef) =>
        presence.finishLegacyMigration(ref),
    }),
  });
}

function assertReceiver(
  receiver: SurfaceAssetUploadStagingPort & SurfaceAssetTemporaryRecoveryPort,
): void {
  for (const capability of [
    "progress",
    "append",
    "discard",
    "openPartialReferenceCursor",
  ] as const) {
    if (typeof receiver[capability] !== "function") {
      throw new TypeError(`Surface asset staging receiver lacks ${capability}`);
    }
  }
}

function assertPresence(presence: SurfaceAssetTemporaryPresencePort): void {
  for (const capability of [
    "mark",
    "has",
    "removeScopes",
    "remove",
    "openReconciliationCursor",
    "hasLegacyMigration",
    "beginLegacyMigration",
    "finishLegacyMigration",
  ] as const) {
    if (typeof presence[capability] !== "function") {
      throw new TypeError(`Surface asset staging presence lacks ${capability}`);
    }
  }
}
