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
import type { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import { decodeRecoveryPackage } from "@zhixing/mesh/recovery-package";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { projectCredentialExposures } from "@zhixing/mesh/credential-exposure";
import { replayTrustChain } from "@zhixing/mesh/trust-chain";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import {
  freezeHostStopAcceptedWork,
  loadHostStopAcceptedWork,
  settleHostStopAcceptedWork,
  type HostStopAcceptedWorkPorts,
  type HostStopAcceptedWorkSnapshot,
} from "./host-stop-lifecycle.js";
import type { ArtifactStore } from "@zhixing/core/authority";

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
    readonly recoveryAcceptedWork?: {
      readonly ports: HostStopAcceptedWorkPorts;
      readonly artifactStore: ArtifactStore;
      readonly closeAdmission: (operationId: string) => Promise<void>;
      readonly onFrozen?: (snapshot: HostStopAcceptedWorkSnapshot) => void | Promise<void>;
      readonly flushDurableState: () => Promise<readonly DeviceLifecycleEvidenceRef[]>;
      readonly settlePhysicalSteps: () => Promise<void>;
    };
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
    readonly recoveryPackage: string;
  }): Promise<AnchorUninstallPublicState> {
    const decoded = decodeRecoveryPackage(input.recoveryPackage);
    await this.preflight();
    const owner = this.options.checkpointOwner;
    if (!owner) throw new Error("No recovery backup target is configured");
    const status = await owner.status();
    if (!status.targetId) throw new Error("Recovery backup target identity is unavailable");
    const trust = await this.#assertCurrentAuthority();
    const rootIdentity = decoded.root.publicIdentity();
    const anchorEpoch = this.options.anchorEpoch();
    if (
      trust.recoveryRootPublicKey !== rootIdentity.rootPublicKey ||
      trust.recoveryBackupPublicKey !== rootIdentity.backupPublicKey
    ) throw new Error("Recovery package does not bind the current home recovery root");
    const identity = Object.freeze({
      v: 1,
      kind: "anchor-uninstall",
      requestId: input.requestId,
      operationId: input.operationId,
      homeId: trust.homeId,
      currentDeviceId: this.options.currentDeviceId,
      anchorEpoch,
      trustHeadDigest: trust.chainHead.eventDigest,
      path: Object.freeze({
        kind: "recovery-backup" as const,
        checkpointTargetId: status.targetId,
        checkpointGeneration: protocolDigest("AnchorUninstallCheckpointGeneration", 1, {
          homeId: trust.homeId,
          anchorEpoch,
          trustHeadDigest: trust.chainHead.eventDigest,
          targetId: status.targetId,
          rootKeyId: rootIdentity.rootKeyId,
          recipientKeyId: rootIdentity.backupKeyId,
        }),
      }),
    }) satisfies AnchorUninstallLifecycleIdentity;
    await this.#journal.accept(identity);
    return this.#driveRecovery(identity, false, decoded.root);
  }

  async confirmRecoveryBackup(
    operationId: string,
    recoveryPackage: string,
  ): Promise<AnchorUninstallPublicState> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "anchor-uninstall" ||
      operation.identity.path.kind !== "recovery-backup") {
      throw new Error("Recovery-backup uninstall operation is unknown");
    }
    const decoded = decodeRecoveryPackage(recoveryPackage);
    await this.#assertRecoveryRoot(operation.identity, decoded.root);
    return this.#driveRecovery(operation.identity, true, decoded.root);
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
    for (let operation of await this.#journal.active()) {
      if (operation.identity.kind !== "anchor-uninstall") continue;
      if (operation.identity.path.kind === "migration") {
        await this.#driveMigration(operation.identity);
      } else {
        if (operation.phase === "accepted") {
          await this.options.closeAdmission();
          await this.#journal.advance(operation.identity.operationId, "gate-frozen", [{
            kind: "accepted-work",
            digest: protocolDigest("AnchorUninstallAdmission", 1, operation.identity),
          }]);
        } else if (operation.phase !== "terminal" && operation.phase !== "aborted") {
          await this.options.closeAdmission();
          if (recoveryClosureStarted(operation.phase)) {
            const closure = this.#requireRecoveryAcceptedWork();
            await closure.closeAdmission(operation.identity.operationId);
            const snapshot = await loadHostStopAcceptedWork(
              operation,
              closure.artifactStore,
            );
            await closure.onFrozen?.(snapshot);
          }
          if (operation.phase === "final-checkpoint-verified") {
            const evidence = await this.options.cleanupRecovery(operation.identity.operationId);
            operation = await this.#journal.advance(
              operation.identity.operationId,
              "cleanup-complete",
              evidence,
            );
          }
          if (operation.phase === "cleanup-complete") {
            await this.#journal.terminal(
              operation.identity.operationId,
              "retired",
              operation.evidence,
            );
            await this.options.onRetired(operation.identity.operationId);
          }
        }
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
    recoveryRoot: RecoveryRoot,
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
      const verification = await this.#assertCheckpoint(checkpoint, path.checkpointTargetId, recoveryRoot);
      operation = await this.#journal.advance(identity.operationId, "checkpoint-verified", [{
        kind: "checkpoint",
        digest: protocolDigest("RecoveryCheckpointVerification", 1, verification),
      }]);
    }
    if (operation.phase === "checkpoint-verified" && !confirmed) {
      return { phase: "backup-verified", nextAction: "confirm-backup" };
    }
    if (operation.phase === "checkpoint-verified") {
      const closure = this.#requireRecoveryAcceptedWork();
      await closure.closeAdmission(identity.operationId);
      const frozen = await freezeHostStopAcceptedWork(
        identity.operationId,
        closure.ports,
        closure.artifactStore,
      );
      await this.#decideRetirement(identity, frozen.evidence);
      operation = await this.#requireOperation(identity.operationId);
    }
    if (operation.phase === "retirement-decided") {
      const closure = this.#requireRecoveryAcceptedWork();
      const snapshot = await loadHostStopAcceptedWork(operation, closure.artifactStore);
      await closure.onFrozen?.(snapshot);
      operation = await this.#journal.advance(identity.operationId, "gate-closed");
    }
    if (operation.phase === "gate-closed") {
      const closure = this.#requireRecoveryAcceptedWork();
      const snapshot = await loadHostStopAcceptedWork(operation, closure.artifactStore);
      await closure.onFrozen?.(snapshot);
      await settleHostStopAcceptedWork({
        operationId: identity.operationId,
        strategy: "immediate",
        timeoutMs: 30_000,
        snapshot,
        ports: closure.ports,
      });
      operation = await this.#journal.advance(identity.operationId, "work-settled", [{
        kind: "accepted-work",
        digest: protocolDigest("AnchorUninstallAcceptedWorkSettlement", 1, {
          operationId: identity.operationId,
          artifactDigest: frozenAcceptedWorkDigest(operation),
        }),
      }]);
    }
    if (operation.phase === "work-settled") {
      const closure = this.#requireRecoveryAcceptedWork();
      const evidence = await closure.flushDurableState();
      await closure.settlePhysicalSteps();
      operation = await this.#journal.advance(identity.operationId, "flushed", evidence);
    }
    if (operation.phase === "flushed") {
      const flushedLsn = await this.#phaseLsn(identity.operationId, "flushed");
      const checkpoint = await owner.force(`${identity.operationId}:final-retirement`);
      const verification = await this.#assertCheckpoint(checkpoint, path.checkpointTargetId, recoveryRoot);
      if (checkpoint.envelope.manifest.upToLsn < flushedLsn) {
        throw new Error("Final recovery backup does not contain the accepted-work flush");
      }
      operation = await this.#journal.advance(identity.operationId, "final-checkpoint-verified", [{
        kind: "checkpoint",
        digest: protocolDigest("RecoveryCheckpointVerification", 1, verification),
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

  async #decideRetirement(
    identity: AnchorUninstallLifecycleIdentity,
    acceptedWork: DeviceLifecycleEvidenceRef,
  ): Promise<number> {
    if (
      acceptedWork.kind !== "accepted-work" ||
      !acceptedWork.artifact ||
      acceptedWork.digest !== acceptedWork.artifact.digest
    ) {
      throw new Error("Anchor retirement requires its frozen accepted-work artifact");
    }
    const result = await this.options.log.transactProjection<
      UninstallProjection,
      unknown,
      number | undefined
    >(
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
          return { kind: "return", value: undefined };
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
        const evidence = [
          acceptedWork,
          {
            kind: "credential-exposure" as const,
            digest: protocolDigest("AnchorRetirementCredentialExposure", 1, compromised),
          },
        ];
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
      {
        streams: ["trust", "exposure", "device-lifecycle"],
        candidateReferences: [acceptedWork.artifact],
      },
    );
    return result.value ?? this.#retirementDecisionLsn(identity.operationId);
  }

  async #assertCheckpoint(
    checkpoint: CheckpointPackage,
    targetId: string,
    recoveryRoot: RecoveryRoot,
  ) {
    const verification = await this.options.checkpointOwner!.verify(
      checkpoint.envelope.checkpointId,
      recoveryRoot,
    );
    if (
      verification.targetId !== targetId ||
      verification.checkpointId !== checkpoint.envelope.checkpointId ||
      verification.envelopeDigest !== checkpoint.envelope.digest
    ) {
      throw new Error("Recovery checkpoint verification does not bind the frozen target");
    }
    return verification;
  }

  async #assertRecoveryRoot(
    identity: AnchorUninstallLifecycleIdentity,
    recoveryRoot: RecoveryRoot,
  ): Promise<void> {
    if (identity.path.kind !== "recovery-backup") throw new Error("Anchor uninstall path is not recovery backup");
    const trust = await this.#assertCurrentAuthority();
    const rootIdentity = recoveryRoot.publicIdentity();
    const generation = protocolDigest("AnchorUninstallCheckpointGeneration", 1, {
      homeId: trust.homeId,
      anchorEpoch: identity.anchorEpoch,
      trustHeadDigest: identity.trustHeadDigest,
      targetId: identity.path.checkpointTargetId,
      rootKeyId: rootIdentity.rootKeyId,
      recipientKeyId: rootIdentity.backupKeyId,
    });
    if (
      generation !== identity.path.checkpointGeneration ||
      trust.recoveryRootPublicKey !== rootIdentity.rootPublicKey ||
      trust.recoveryBackupPublicKey !== rootIdentity.backupPublicKey
    ) throw new Error("Recovery package changes the accepted uninstall generation");
  }

  async #retirementDecisionLsn(operationId: string): Promise<number> {
    return this.#phaseLsn(operationId, "retirement-decided");
  }

  async #phaseLsn(
    operationId: string,
    phase: "retirement-decided" | "flushed",
  ): Promise<number> {
    const records = await this.options.log.readStream<unknown>("device-lifecycle");
    const decision = records.find((entry) => {
      const record = validateDeviceLifecycleRecord(entry.body);
      return record.t === "advanced" &&
        record.operationId === operationId &&
        record.phase === phase;
    });
    if (!decision) throw new Error(`Anchor uninstall ${phase} LSN is missing`);
    return decision.lsn;
  }

  #requireRecoveryAcceptedWork() {
    const closure = this.options.recoveryAcceptedWork;
    if (!closure) throw new Error("Recovery-backup uninstall requires accepted-work closure");
    return closure;
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
  if (
    operation.phase === "retirement-decided" ||
    operation.phase === "gate-closed" ||
    operation.phase === "work-settled" ||
    operation.phase === "flushed"
  ) {
    return { phase: "retiring-device", nextAction: "continue" };
  }
  return operation.identity.kind === "anchor-uninstall" && operation.identity.path.kind === "migration"
    ? { phase: "moving-duty-device", nextAction: "continue" }
    : { phase: "choose-safe-path", nextAction: "continue" };
}

function recoveryClosureStarted(phase: DeviceLifecycleOperation["phase"]): boolean {
  return new Set([
    "retirement-decided",
    "gate-closed",
    "work-settled",
    "flushed",
    "final-checkpoint-verified",
    "cleanup-complete",
  ]).has(phase);
}

function frozenAcceptedWorkDigest(operation: DeviceLifecycleOperation): string {
  const evidence = operation.evidence.filter((item) =>
    item.kind === "accepted-work" && item.artifact);
  if (evidence.length !== 1) {
    throw new Error("Anchor uninstall accepted-work artifact is missing or ambiguous");
  }
  return evidence[0]!.digest;
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
