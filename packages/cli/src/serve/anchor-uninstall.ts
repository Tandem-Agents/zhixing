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
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { projectCredentialExposures } from "@zhixing/mesh/credential-exposure";
import { replayTrustChain } from "@zhixing/mesh/trust-chain";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import type {
  DeviceAdministrationCurrentRemovalLifecyclePhase,
  DeviceAdministrationCurrentRemovalLifecycleSnapshot,
  DeviceAdministrationCurrentRemovalMigrationLifecycleOperation,
  DeviceAdministrationCurrentRemovalMigrationPhase,
  DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation,
} from "@zhixing/core/device-administration/application";
import type { BackupRecoveryCurrentRemovalBinding } from "@zhixing/core/backup-recovery/application";

interface UninstallProjection {
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly exposures: readonly CredentialExposureRecord[];
  readonly lifecycle: DeviceLifecycleProjection;
}

type RecoveryAnchorUninstallOperation = DeviceLifecycleOperation & {
  readonly identity: AnchorUninstallLifecycleIdentity & {
    readonly path: Extract<
      AnchorUninstallLifecycleIdentity["path"],
      { readonly kind: "recovery-backup" }
    >;
  };
};

export class AnchorUninstallCoordinator {
  readonly #journal: DeviceLifecycleJournal;

  constructor(private readonly options: {
    readonly log: FileAuthorityCommitLog;
    readonly store: FileMeshBootstrapStore;
    readonly currentDeviceId: string;
    readonly issuerKey: DeviceKey;
    readonly verifier: ProtocolSignatureVerifier;
    readonly anchorEpoch: () => number;
    readonly releaseAdmission: (operationId: string) => void | Promise<void>;
    readonly now?: () => string;
  }) {
    this.#journal = new DeviceLifecycleJournal(options.log, options.verifier);
  }

  async acceptMigration(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
  }): Promise<DeviceAdministrationCurrentRemovalMigrationLifecycleOperation> {
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
        targetDeviceId: input.targetDeviceId,
        transferId: input.transferId,
      }),
    }) satisfies AnchorUninstallLifecycleIdentity;
    return currentRemovalMigrationLifecycleOperation(await this.#journal.accept(identity));
  }

  async activeMigrations(): Promise<
    readonly DeviceAdministrationCurrentRemovalMigrationLifecycleOperation[]
  > {
    return Object.freeze((await this.#journal.active())
      .filter((operation) =>
        operation.identity.kind === "anchor-uninstall" &&
        operation.identity.path.kind === "migration")
      .map(currentRemovalMigrationLifecycleOperation));
  }

  async advanceMigration(input: {
    readonly operationId: string;
    readonly phase: "gate-frozen" | "transfer-committed" | "cleanup-complete";
    readonly evidence: readonly DeviceLifecycleEvidenceRef[];
  }): Promise<DeviceAdministrationCurrentRemovalMigrationLifecycleOperation> {
    const operation = await this.#requireMigrationOperation(input.operationId);
    return currentRemovalMigrationLifecycleOperation(await this.#journal.advance(
      operation.identity.operationId,
      input.phase,
      input.evidence,
    ));
  }

  async terminalMigration(
    operationId: string,
  ): Promise<DeviceAdministrationCurrentRemovalMigrationLifecycleOperation> {
    const operation = await this.#requireMigrationOperation(operationId);
    return currentRemovalMigrationLifecycleOperation(await this.#journal.terminal(
      operation.identity.operationId,
      "retired",
      operation.evidence,
    ));
  }

  async assertRecoveryBeginAdmission(): Promise<void> {
    await this.#assertRecoveryBeginAdmission();
  }

  async assertCurrentAuthority(): Promise<void> {
    await this.#assertCurrentAuthority();
  }

  async acceptRecovery(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly binding: BackupRecoveryCurrentRemovalBinding;
  }): Promise<DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation> {
    await this.#assertRecoveryBeginAdmission();
    const trust = await this.#assertCurrentAuthority();
    const anchorEpoch = this.options.anchorEpoch();
    if (
      input.binding.homeId !== trust.homeId ||
      input.binding.anchorEpoch !== anchorEpoch ||
      input.binding.trustHeadDigest !== trust.chainHead.eventDigest
    ) {
      throw new Error("Recovery package changes the accepted uninstall generation");
    }
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
        checkpointTargetId: input.binding.checkpointTargetId,
        checkpointGeneration: input.binding.checkpointGeneration,
      }),
    }) satisfies AnchorUninstallLifecycleIdentity;
    return currentRemovalRecoveryLifecycleOperation(await this.#journal.accept(identity));
  }

  async recoveryState(
    operationId: string,
  ): Promise<DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation | undefined> {
    const operation = await this.#journal.state(operationId);
    if (
      !operation ||
      operation.identity.kind !== "anchor-uninstall" ||
      operation.identity.path.kind !== "recovery-backup"
    ) return undefined;
    return currentRemovalRecoveryLifecycleOperation(operation);
  }

  async activeRecoveries(): Promise<
    readonly DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation[]
  > {
    return Object.freeze((await this.#journal.active())
      .filter((operation) =>
        operation.identity.kind === "anchor-uninstall" &&
        operation.identity.path.kind === "recovery-backup")
      .map(currentRemovalRecoveryLifecycleOperation));
  }

  async advanceRecovery(input: {
    readonly operationId: string;
    readonly phase:
      | "gate-frozen"
      | "checkpoint-verified"
      | "gate-closed"
      | "work-settled"
      | "flushed"
      | "final-checkpoint-verified"
      | "cleanup-complete";
    readonly evidence: readonly DeviceLifecycleEvidenceRef[];
  }): Promise<DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation> {
    const operation = await this.#requireRecoveryOperation(input.operationId);
    return currentRemovalRecoveryLifecycleOperation(await this.#journal.advance(
      operation.identity.operationId,
      input.phase,
      input.evidence,
    ));
  }

  async commitRecoveryRetirement(input: {
    readonly operationId: string;
    readonly acceptedWork: DeviceLifecycleEvidenceRef;
  }): Promise<DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation> {
    const operation = await this.#requireRecoveryOperation(input.operationId);
    await this.#commitRetirementDecision(operation.identity, input.acceptedWork);
    return currentRemovalRecoveryLifecycleOperation(
      await this.#requireRecoveryOperation(input.operationId),
    );
  }

  recoveryPhaseLsn(input: {
    readonly operationId: string;
    readonly phase: "flushed";
  }): Promise<number> {
    return this.#phaseLsn(input.operationId, input.phase);
  }

  async terminalRecovery(
    operationId: string,
  ): Promise<DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation> {
    const operation = await this.#requireRecoveryOperation(operationId);
    return currentRemovalRecoveryLifecycleOperation(await this.#journal.terminal(
      operation.identity.operationId,
      "retired",
      operation.evidence,
    ));
  }

  async abort(operationId: string): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot> {
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
    const aborted = await this.#journal.abort(operationId, abort);
    await this.options.releaseAdmission(operationId);
    return currentRemovalLifecycleSnapshot(aborted);
  }

  async readLifecycle(
    operationId: string,
  ): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot | undefined> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "anchor-uninstall") return undefined;
    return currentRemovalLifecycleSnapshot(operation);
  }

  async #commitRetirementDecision(
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

  async #assertRecoveryBeginAdmission(): Promise<void> {
    await this.#assertCurrentAuthority();
    const active = await this.#journal.active();
    if (active.some((operation) => operation.identity.kind === "executor-removal")) {
      throw new Error("Finish the current device removal before uninstalling this device");
    }
  }

  async #requireOperation(operationId: string): Promise<DeviceLifecycleOperation> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "anchor-uninstall") {
      throw new Error("Anchor uninstall operation is unknown");
    }
    return operation;
  }

  async #requireMigrationOperation(operationId: string): Promise<DeviceLifecycleOperation> {
    const operation = await this.#requireOperation(operationId);
    if (
      operation.identity.kind !== "anchor-uninstall" ||
      operation.identity.path.kind !== "migration"
    ) {
      throw new Error("Anchor uninstall path is not a migration");
    }
    return operation;
  }

  async #requireRecoveryOperation(
    operationId: string,
  ): Promise<RecoveryAnchorUninstallOperation> {
    const operation = await this.#requireOperation(operationId);
    assertRecoveryAnchorUninstallOperation(operation);
    return operation;
  }
}

function assertRecoveryAnchorUninstallOperation(
  operation: DeviceLifecycleOperation,
): asserts operation is RecoveryAnchorUninstallOperation {
  if (
    operation.identity.kind !== "anchor-uninstall" ||
    operation.identity.path.kind !== "recovery-backup"
  ) {
    throw new Error("Anchor uninstall path is not recovery backup");
  }
}

function currentRemovalMigrationLifecycleOperation(
  operation: DeviceLifecycleOperation,
): DeviceAdministrationCurrentRemovalMigrationLifecycleOperation {
  if (
    operation.identity.kind !== "anchor-uninstall" ||
    operation.identity.path.kind !== "migration"
  ) {
    throw new TypeError("Anchor migration lifecycle requires a migration operation");
  }
  return Object.freeze({
    kind: "current-device-removal",
    path: "migration",
    requestId: operation.identity.requestId,
    operationId: operation.identity.operationId,
    transferId: operation.identity.path.transferId,
    targetDeviceId: operation.identity.path.targetDeviceId,
    phase: currentRemovalMigrationPhase(operation.phase),
  });
}

function currentRemovalMigrationPhase(
  phase: DeviceLifecycleOperation["phase"],
): DeviceAdministrationCurrentRemovalMigrationPhase {
  switch (phase) {
    case "accepted":
    case "gate-frozen":
    case "transfer-committed":
    case "cleanup-complete":
    case "terminal":
    case "aborted":
      return phase;
    default:
      throw new TypeError("Anchor migration lifecycle phase is invalid");
  }
}

function currentRemovalRecoveryLifecycleOperation(
  operation: DeviceLifecycleOperation,
): DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation {
  if (
    operation.identity.kind !== "anchor-uninstall" ||
    operation.identity.path.kind !== "recovery-backup"
  ) {
    throw new TypeError("Anchor recovery lifecycle requires a recovery-backup operation");
  }
  return Object.freeze({
    kind: "current-device-removal",
    path: "recovery-backup",
    requestId: operation.identity.requestId,
    operationId: operation.identity.operationId,
    binding: Object.freeze({
      homeId: operation.identity.homeId,
      anchorEpoch: operation.identity.anchorEpoch,
      trustHeadDigest: operation.identity.trustHeadDigest,
      checkpointTargetId: operation.identity.path.checkpointTargetId,
      checkpointGeneration: operation.identity.path.checkpointGeneration,
    }),
    phase: currentRemovalRecoveryPhase(operation.phase),
  });
}

function currentRemovalRecoveryPhase(
  phase: DeviceLifecycleOperation["phase"],
): DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation["phase"] {
  switch (phase) {
    case "accepted":
    case "gate-frozen":
    case "checkpoint-verified":
    case "retirement-decided":
    case "gate-closed":
    case "work-settled":
    case "flushed":
    case "final-checkpoint-verified":
    case "cleanup-complete":
    case "terminal":
    case "aborted":
      return phase;
    default:
      throw new TypeError("Anchor recovery lifecycle phase is invalid");
  }
}

function currentRemovalLifecycleSnapshot(
  operation: DeviceLifecycleOperation,
): DeviceAdministrationCurrentRemovalLifecycleSnapshot {
  if (operation.identity.kind !== "anchor-uninstall") {
    throw new TypeError("Anchor uninstall lifecycle snapshot requires an anchor operation");
  }
  return Object.freeze({
    kind: "current-device-removal",
    path: operation.identity.path.kind,
    phase: currentRemovalLifecyclePhase(operation.phase),
  });
}

function currentRemovalLifecyclePhase(
  phase: DeviceLifecycleOperation["phase"],
): DeviceAdministrationCurrentRemovalLifecyclePhase {
  switch (phase) {
    case "accepted":
    case "gate-frozen":
    case "checkpoint-verified":
    case "transfer-committed":
    case "retirement-decided":
    case "gate-closed":
    case "work-settled":
    case "flushed":
    case "final-checkpoint-verified":
    case "cleanup-complete":
    case "terminal":
    case "aborted":
      return phase;
    default:
      throw new TypeError("Anchor uninstall lifecycle phase is invalid");
  }
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
