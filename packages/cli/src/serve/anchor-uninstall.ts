import type {
  CredentialExposureRecord,
  HomeTrustEvent,
  HomeTrustRecord,
} from "@zhixing/core/contracts";
import {
  DeviceLifecycleJournal,
  type FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import {
  createSignedDeviceLifecycleAbort,
  emptyDeviceLifecycleProjection,
  protocolDigest,
  reduceDeviceLifecycleProjection,
  validateDeviceLifecycleRecord,
  type AnchorUninstallLifecycleIdentity,
  type DeviceLifecycleEvidenceRef,
  type DeviceLifecycleOperation,
  type DeviceLifecycleProjection,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { AuthorityCheckpointOwnerPort } from "@zhixing/mesh/checkpoint-owner";
import type { CheckpointPackage } from "@zhixing/mesh/checkpoint";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { projectCredentialExposures } from "@zhixing/mesh/credential-exposure";
import { replayTrustChain } from "@zhixing/mesh/trust-chain";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

interface UninstallProjection {
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly exposures: readonly CredentialExposureRecord[];
  readonly lifecycle: DeviceLifecycleProjection;
}

export interface AnchorUninstallPublicState {
  readonly phase:
    | "choose-safe-path"
    | "moving-duty-device"
    | "backup-verified"
    | "retiring-device"
    | "ready-to-uninstall"
    | "uninstalled"
    | "cancelled";
  readonly nextAction?: "choose-device" | "confirm-backup" | "continue";
}

export interface AnchorUninstallPreflight {
  readonly migrationTargets: readonly {
    readonly displayName: string;
    readonly ready: boolean;
  }[];
  readonly recoveryBackupReady: boolean;
}

export class AnchorUninstallCoordinator {
  readonly #journal: DeviceLifecycleJournal;

  constructor(private readonly options: {
    readonly log: FileAuthorityCommitLog;
    readonly store: FileMeshBootstrapStore;
    readonly currentDeviceId: string;
    readonly issuerKey: DeviceKey;
    readonly verifier: ProtocolSignatureVerifier;
    readonly anchorEpoch: () => number;
    readonly migrationTargets: () => Promise<readonly {
      readonly deviceId: string;
      readonly displayName: string;
      readonly ready: boolean;
    }[]>;
    readonly commitMigration: (input: {
      readonly requestId: string;
      readonly transferId: string;
      readonly targetDeviceId: string;
    }) => Promise<void>;
    readonly verifyMigration: (targetDeviceId: string) => Promise<void>;
    readonly retireMigratedDevice: (operationId: string) => Promise<void>;
    readonly checkpointOwner?: AuthorityCheckpointOwnerPort;
    readonly closeAdmission: () => Promise<void>;
    readonly releaseAdmission: () => void | Promise<void>;
    readonly cleanupRecovery: (
      operationId: string,
    ) => Promise<readonly DeviceLifecycleEvidenceRef[]>;
    readonly onRetired: (operationId: string) => void | Promise<void>;
    readonly now?: () => string;
  }) {
    this.#journal = new DeviceLifecycleJournal(options.log, options.verifier);
  }

  async preflight(): Promise<AnchorUninstallPreflight> {
    await this.#assertCurrentAuthority();
    const active = await this.#journal.active();
    if (active.some((operation) => operation.identity.kind === "executor-removal")) {
      throw new Error("Finish the current device removal before uninstalling this device");
    }
    const migrationTargets = await this.options.migrationTargets();
    const backup = this.options.checkpointOwner
      ? await this.options.checkpointOwner.status()
      : { state: "not-configured" as const, fullBackupReady: false };
    return Object.freeze({
      migrationTargets: Object.freeze(migrationTargets.map(({ displayName, ready }) => ({
        displayName,
        ready,
      }))),
      recoveryBackupReady:
        backup.state === "recoverable" &&
        backup.fullBackupReady &&
        !!backup.checkpointId &&
        !!backup.targetId &&
        backup.upToLsn !== undefined,
    });
  }

  async beginMigration(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly transferId: string;
    readonly targetName: string;
  }): Promise<AnchorUninstallPublicState> {
    await this.preflight();
    const matches = (await this.options.migrationTargets()).filter((candidate) =>
      candidate.ready && candidate.displayName === input.targetName);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? "No ready duty device has that name"
        : "More than one ready duty device has that name");
    }
    const trust = await this.#assertCurrentAuthority();
    const identity = Object.freeze({
      v: 1,
      kind: "anchor-uninstall",
      requestId: input.requestId,
      operationId: input.operationId,
      homeId: trust.homeId,
      currentDeviceId: this.options.currentDeviceId,
      anchorEpoch: this.options.anchorEpoch(),
      trustHeadDigest: trust.chainHead.eventDigest,
      path: Object.freeze({
        kind: "migration" as const,
        targetDeviceId: matches[0]!.deviceId,
        transferId: input.transferId,
      }),
    }) satisfies AnchorUninstallLifecycleIdentity;
    await this.#journal.accept(identity);
    return this.#driveMigration(identity);
  }

  async beginRecoveryBackup(input: {
    readonly requestId: string;
    readonly operationId: string;
  }): Promise<AnchorUninstallPublicState> {
    await this.preflight();
    const owner = this.options.checkpointOwner;
    if (!owner) throw new Error("No recovery backup target is configured");
    const status = await owner.status();
    if (
      status.state !== "recoverable" ||
      !status.fullBackupReady ||
      !status.checkpointId ||
      !status.targetId ||
      status.upToLsn === undefined
    ) {
      throw new Error("A verified recovery backup is required before uninstalling this device");
    }
    const trust = await this.#assertCurrentAuthority();
    const identity = Object.freeze({
      v: 1,
      kind: "anchor-uninstall",
      requestId: input.requestId,
      operationId: input.operationId,
      homeId: trust.homeId,
      currentDeviceId: this.options.currentDeviceId,
      anchorEpoch: this.options.anchorEpoch(),
      trustHeadDigest: trust.chainHead.eventDigest,
      path: Object.freeze({
        kind: "recovery-backup" as const,
        checkpointTargetId: status.targetId,
        checkpointGeneration: protocolDigest("AnchorUninstallCheckpointGeneration", 1, {
          checkpointId: status.checkpointId,
          targetId: status.targetId,
          upToLsn: status.upToLsn,
        }),
      }),
    }) satisfies AnchorUninstallLifecycleIdentity;
    await this.#journal.accept(identity);
    return this.#driveRecovery(identity, false);
  }

  async confirmRecoveryBackup(operationId: string): Promise<AnchorUninstallPublicState> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "anchor-uninstall" ||
      operation.identity.path.kind !== "recovery-backup") {
      throw new Error("Recovery-backup uninstall operation is unknown");
    }
    return this.#driveRecovery(operation.identity, true);
  }

  async abort(operationId: string): Promise<AnchorUninstallPublicState> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "anchor-uninstall") {
      throw new Error("Anchor uninstall operation is unknown");
    }
    const abort = createSignedDeviceLifecycleAbort({
      v: 1,
      operationId,
      homeId: operation.identity.homeId,
      subjectDeviceId: operation.identity.currentDeviceId,
      authorizedByDeviceId: operation.identity.currentDeviceId,
      reason: "user-cancelled",
      at: this.options.now?.() ?? new Date().toISOString(),
    }, this.options.issuerKey);
    await this.#journal.abort(operationId, abort);
    await this.options.releaseAdmission();
    return { phase: "cancelled" };
  }

  async state(operationId: string): Promise<AnchorUninstallPublicState | undefined> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "anchor-uninstall") return undefined;
    return projectState(operation);
  }

  async resumeActive(): Promise<void> {
    for (const operation of await this.#journal.active()) {
      if (operation.identity.kind !== "anchor-uninstall") continue;
      if (operation.identity.path.kind === "migration") {
        await this.#driveMigration(operation.identity);
      } else if (
        operation.phase !== "checkpoint-verified" &&
        operation.phase !== "gate-frozen"
      ) {
        await this.#driveRecovery(operation.identity, true);
      } else if (operation.phase === "gate-frozen") {
        await this.#driveRecovery(operation.identity, false);
      }
    }
  }

  async #driveMigration(
    identity: AnchorUninstallLifecycleIdentity,
  ): Promise<AnchorUninstallPublicState> {
    if (identity.path.kind !== "migration") {
      throw new Error("Anchor uninstall path is not a migration");
    }
    const path = identity.path;
    let operation = await this.#requireOperation(identity.operationId);
    if (operation.phase === "accepted") {
      await this.options.closeAdmission();
      operation = await this.#journal.advance(identity.operationId, "gate-frozen", [{
        kind: "accepted-work",
        digest: protocolDigest("AnchorUninstallAdmission", 1, identity),
      }]);
    }
    if (operation.phase === "gate-frozen") {
      await this.options.commitMigration({
        requestId: identity.requestId,
        transferId: path.transferId,
        targetDeviceId: path.targetDeviceId,
      });
      await this.options.verifyMigration(path.targetDeviceId);
      operation = await this.#journal.advance(identity.operationId, "transfer-committed", [{
        kind: "authority-transfer",
        digest: protocolDigest("AnchorUninstallMigration", 1, path),
      }]);
    }
    if (operation.phase === "transfer-committed") {
      await this.options.retireMigratedDevice(identity.operationId);
      operation = await this.#journal.advance(identity.operationId, "cleanup-complete", [{
        kind: "cleanup",
        digest: protocolDigest("MigratedAnchorCleanup", 1, {
          operationId: identity.operationId,
          targetDeviceId: path.targetDeviceId,
        }),
      }]);
    }
    if (operation.phase === "cleanup-complete") {
      await this.#journal.terminal(identity.operationId, "retired", operation.evidence);
    }
    return { phase: "uninstalled" };
  }

  async #driveRecovery(
    identity: AnchorUninstallLifecycleIdentity,
    confirmed: boolean,
  ): Promise<AnchorUninstallPublicState> {
    if (identity.path.kind !== "recovery-backup") {
      throw new Error("Anchor uninstall path is not a recovery backup");
    }
    const path = identity.path;
    const owner = this.options.checkpointOwner;
    if (!owner) throw new Error("Recovery backup owner is unavailable");
    let operation = await this.#requireOperation(identity.operationId);
    if (operation.phase === "accepted") {
      await this.options.closeAdmission();
      operation = await this.#journal.advance(identity.operationId, "gate-frozen", [{
        kind: "accepted-work",
        digest: protocolDigest("AnchorUninstallAdmission", 1, identity),
      }]);
    }
    if (operation.phase === "gate-frozen") {
      const checkpoint = await owner.force(`${identity.operationId}:pre-retirement`);
      await this.#assertCheckpoint(checkpoint, path.checkpointTargetId);
      operation = await this.#journal.advance(identity.operationId, "checkpoint-verified", [{
        kind: "checkpoint",
        digest: checkpoint.envelope.digest,
      }]);
    }
    if (operation.phase === "checkpoint-verified" && !confirmed) {
      return { phase: "backup-verified", nextAction: "confirm-backup" };
    }
    let retirementLsn = operation.evidence
      .filter((item) => item.kind === "credential-exposure")
      .length > 0
      ? (await this.options.log.checkpoint()).lsn
      : undefined;
    if (operation.phase === "checkpoint-verified") {
      retirementLsn = await this.#decideRetirement(identity);
      operation = await this.#requireOperation(identity.operationId);
    }
    if (operation.phase === "retirement-decided") {
      const checkpoint = await owner.force(`${identity.operationId}:final-retirement`);
      await this.#assertCheckpoint(checkpoint, path.checkpointTargetId);
      if (retirementLsn !== undefined && checkpoint.envelope.manifest.upToLsn < retirementLsn) {
        throw new Error("Final recovery backup does not contain the retirement decision");
      }
      operation = await this.#journal.advance(identity.operationId, "final-checkpoint-verified", [{
        kind: "checkpoint",
        digest: checkpoint.envelope.digest,
      }]);
    }
    if (operation.phase === "final-checkpoint-verified") {
      const evidence = await this.options.cleanupRecovery(identity.operationId);
      operation = await this.#journal.advance(identity.operationId, "cleanup-complete", evidence);
    }
    if (operation.phase === "cleanup-complete") {
      await this.#journal.terminal(identity.operationId, "retired", operation.evidence);
      await this.options.onRetired(identity.operationId);
    }
    return { phase: "uninstalled" };
  }

  async #decideRetirement(identity: AnchorUninstallLifecycleIdentity): Promise<number> {
    const result = await this.options.log.transactProjection<UninstallProjection, unknown, number>(
      { trustEvents: [], exposures: [], lifecycle: emptyDeviceLifecycleProjection() },
      (state, entry) => {
        if (entry.stream === "trust" && isTrustRecord(entry.body) && entry.body.t === "home-trust-event") {
          return { ...state, trustEvents: [...state.trustEvents, entry.body.event] };
        }
        if (entry.stream === "exposure" && isExposureRecord(entry.body)) {
          return { ...state, exposures: [...state.exposures, entry.body] };
        }
        if (entry.stream === "device-lifecycle") {
          return {
            ...state,
            lifecycle: reduceDeviceLifecycleProjection(state.lifecycle, entry.body, this.options.verifier),
          };
        }
        return state;
      },
      (state, context) => {
        const operation = state.lifecycle.operations.get(identity.operationId);
        if (!operation || operation.identity.kind !== "anchor-uninstall") {
          throw new Error("Anchor uninstall retirement lost its lifecycle operation");
        }
        if (operation.phase === "retirement-decided") {
          return { kind: "return", value: context.lastLsn };
        }
        if (operation.phase !== "checkpoint-verified") {
          throw new Error("Anchor retirement requires a verified recovery backup");
        }
        const trust = replayTrustChain(state.trustEvents);
        if (
          trust.issuer.deviceId !== identity.currentDeviceId ||
          trust.chainHead.eventDigest !== identity.trustHeadDigest
        ) {
          throw new Error("Current authority changed before anchor retirement");
        }
        const compromised = projectCredentialExposures(state.exposures).records
          .filter((record) => record.deviceId === identity.currentDeviceId && record.state === "active")
          .map((record) => Object.freeze({
            ...record,
            state: "compromised" as const,
            markedAt: context.at,
            rotationHint: record.rotationHint ?? "Rotate this external account credential",
          }));
        const evidence = [{
          kind: "credential-exposure" as const,
          digest: protocolDigest("AnchorRetirementCredentialExposure", 1, compromised),
        }];
        const lifecycle = validateDeviceLifecycleRecord({
          v: 1,
          t: "advanced",
          operationId: identity.operationId,
          phase: "retirement-decided",
          evidence,
        });
        reduceDeviceLifecycleProjection(state.lifecycle, lifecycle, this.options.verifier);
        return {
          kind: "append",
          entries: [
            ...compromised.map((body) => ({ stream: "exposure", body })),
            { stream: "device-lifecycle", body: lifecycle },
          ],
          value: context.nextLsn,
        };
      },
      { streams: ["trust", "exposure", "device-lifecycle"] },
    );
    return result.value;
  }

  async #assertCheckpoint(checkpoint: CheckpointPackage, targetId: string): Promise<void> {
    const status = await this.options.checkpointOwner!.status();
    if (
      status.state !== "recoverable" ||
      !status.fullBackupReady ||
      status.targetId !== targetId ||
      status.checkpointId !== checkpoint.envelope.checkpointId ||
      status.upToLsn !== checkpoint.envelope.manifest.upToLsn
    ) {
      throw new Error("Recovery checkpoint could not be read back from the frozen target");
    }
  }

  async #assertCurrentAuthority(): Promise<ReturnType<typeof replayTrustChain>> {
    const trust = replayTrustChain(await this.options.store.loadTrustEvents());
    if (
      trust.issuer.deviceId !== this.options.currentDeviceId ||
      this.options.issuerKey.deviceId !== trust.issuer.issuerKeyId
    ) {
      throw new Error("Only the current duty device can uninstall itself");
    }
    return trust;
  }

  async #requireOperation(operationId: string): Promise<DeviceLifecycleOperation> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "anchor-uninstall") {
      throw new Error("Anchor uninstall operation is unknown");
    }
    return operation;
  }
}

function projectState(operation: DeviceLifecycleOperation): AnchorUninstallPublicState {
  if (operation.phase === "terminal") return { phase: "uninstalled" };
  if (operation.phase === "aborted") return { phase: "cancelled" };
  if (operation.phase === "checkpoint-verified") {
    return { phase: "backup-verified", nextAction: "confirm-backup" };
  }
  if (operation.phase === "final-checkpoint-verified" || operation.phase === "cleanup-complete") {
    return { phase: "ready-to-uninstall", nextAction: "continue" };
  }
  if (operation.phase === "retirement-decided") {
    return { phase: "retiring-device", nextAction: "continue" };
  }
  return operation.identity.kind === "anchor-uninstall" && operation.identity.path.kind === "migration"
    ? { phase: "moving-duty-device", nextAction: "continue" }
    : { phase: "choose-safe-path", nextAction: "continue" };
}

function isTrustRecord(input: unknown): input is
  | { readonly t: "home-trust-event"; readonly event: HomeTrustEvent }
  | { readonly t: "home-trust-record"; readonly record: HomeTrustRecord } {
  return !!input && typeof input === "object" &&
    ((input as { t?: unknown }).t === "home-trust-event" ||
      (input as { t?: unknown }).t === "home-trust-record");
}

function isExposureRecord(input: unknown): input is CredentialExposureRecord {
  return !!input && typeof input === "object" &&
    typeof (input as { deviceId?: unknown }).deviceId === "string" &&
    typeof (input as { bindingId?: unknown }).bindingId === "string" &&
    new Set(["active", "compromised", "rotated"])
      .has((input as { state?: unknown }).state as string);
}
