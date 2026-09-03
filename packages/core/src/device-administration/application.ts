import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import type {
  BackupRecoveryCurrentRemovalApplication,
  BackupRecoveryCurrentRemovalBinding,
  BackupRecoveryCurrentRemovalPermit,
  BackupRecoveryCurrentRemovalStatus,
} from "../backup-recovery/application.js";
import type { CredentialExposureRecord } from "../contracts/index.js";

export interface DeviceAdministrationRelationship {
  readonly displayName: string;
  readonly reachable: boolean;
}

export interface DeviceAdministrationRemovalState {
  readonly phase:
    | "waiting-for-device"
    | "needs-conversation-decision"
    | "moving-conversations"
    | "revoking-access"
    | "cleaning-device"
    | "removed"
    | "cancelled";
  readonly conversations: readonly string[];
  readonly localData: "known" | "removed" | "unknown";
  readonly credentialActions: readonly string[];
}

export interface DeviceAdministrationDutyMigrationTarget {
  readonly deviceId: string;
  readonly displayName: string;
  readonly ready: boolean;
  readonly code?: "unavailable";
}

export interface DeviceAdministrationListQuery {
  readonly kind: "list-device-relationships";
}

export interface DeviceAdministrationStatusQuery {
  readonly kind: "read-device-removal-state";
  readonly targetName: string;
}

export interface DeviceAdministrationDutyMigrationTargetsQuery {
  readonly kind: "list-duty-migration-targets";
}

export interface DeviceAdministrationCurrentRemovalPreflightQuery {
  readonly kind: "preflight-current-device-removal";
}

export interface DeviceAdministrationCurrentRemovalStatusQuery {
  readonly kind: "read-current-device-removal-status";
  readonly operationId: string;
}

export type DeviceAdministrationQuery =
  | DeviceAdministrationListQuery
  | DeviceAdministrationStatusQuery
  | DeviceAdministrationDutyMigrationTargetsQuery
  | DeviceAdministrationCurrentRemovalPreflightQuery
  | DeviceAdministrationCurrentRemovalStatusQuery;

export interface DeviceAdministrationListResult {
  readonly devices: readonly DeviceAdministrationRelationship[];
}

export interface DeviceAdministrationStatusResult {
  readonly state: DeviceAdministrationRemovalState | null;
}

export interface DeviceAdministrationDutyMigrationTargetsResult {
  readonly devices: readonly DeviceAdministrationDutyMigrationTarget[];
}

export interface DeviceAdministrationCurrentRemovalState {
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

export type DeviceAdministrationCurrentRemovalLifecyclePhase =
  | "accepted"
  | "gate-frozen"
  | "checkpoint-verified"
  | "transfer-committed"
  | "retirement-decided"
  | "gate-closed"
  | "work-settled"
  | "flushed"
  | "final-checkpoint-verified"
  | "cleanup-complete"
  | "terminal"
  | "aborted";

/** Transport- and storage-free raw durable facts needed for product projection. */
export interface DeviceAdministrationCurrentRemovalLifecycleSnapshot {
  readonly kind: "current-device-removal";
  readonly path: "migration" | "recovery-backup";
  readonly phase: DeviceAdministrationCurrentRemovalLifecyclePhase;
}

export interface DeviceAdministrationCurrentRemovalPreflightResult {
  readonly currentDeviceName: string;
  readonly migrationTargets: readonly {
    readonly displayName: string;
    readonly ready: boolean;
  }[];
  readonly recoveryBackupReady: boolean;
}

export interface DeviceAdministrationCurrentRemovalStatusResult {
  readonly state: DeviceAdministrationCurrentRemovalState | null;
}

export type DeviceAdministrationResult =
  | DeviceAdministrationListResult
  | DeviceAdministrationStatusResult
  | DeviceAdministrationDutyMigrationTargetsResult
  | DeviceAdministrationCurrentRemovalPreflightResult
  | DeviceAdministrationCurrentRemovalStatusResult;

export interface DeviceAdministrationBeginRemovalCommand {
  readonly kind: "begin-device-removal";
  readonly requestId: string;
  readonly operationId: string;
  readonly targetName: string;
}

export interface DeviceAdministrationContinueRemovalCommand {
  readonly kind: "continue-device-removal";
  readonly targetName: string;
  readonly mode: "transfer" | "destroy" | "lost" | "cancel";
  readonly operationId?: string;
}

export interface DeviceAdministrationPrepareDutyMigrationCommand {
  readonly kind: "prepare-duty-migration";
  readonly requestId: string;
  readonly transferId: string;
  readonly targetDeviceId: string;
}

export interface DeviceAdministrationCommitDutyMigrationCommand {
  readonly kind: "commit-duty-migration";
  readonly requestId: string;
  readonly transferId: string;
}

export interface DeviceAdministrationCancelDutyMigrationCommand {
  readonly kind: "cancel-duty-migration";
  readonly requestId: string;
  readonly transferId: string;
}

export type DeviceAdministrationBeginCurrentRemovalCommand =
  | {
      readonly kind: "begin-current-device-removal";
      readonly path: "migration";
      readonly requestId: string;
      readonly operationId: string;
      readonly transferId: string;
      readonly targetName: string;
    }
  | {
      readonly kind: "begin-current-device-removal";
      readonly path: "recovery-backup";
      readonly requestId: string;
      readonly operationId: string;
      readonly recoveryPackage: string;
    };

export interface DeviceAdministrationContinueCurrentRemovalCommand {
  readonly kind: "continue-current-device-removal";
  readonly operationId: string;
  readonly confirmBackup: true;
  readonly recoveryPackage: string;
}

export interface DeviceAdministrationCancelCurrentRemovalCommand {
  readonly kind: "cancel-current-device-removal";
  readonly operationId: string;
}

export type DeviceAdministrationCommand =
  | DeviceAdministrationBeginRemovalCommand
  | DeviceAdministrationContinueRemovalCommand
  | DeviceAdministrationPrepareDutyMigrationCommand
  | DeviceAdministrationCommitDutyMigrationCommand
  | DeviceAdministrationCancelDutyMigrationCommand
  | DeviceAdministrationBeginCurrentRemovalCommand
  | DeviceAdministrationContinueCurrentRemovalCommand
  | DeviceAdministrationCancelCurrentRemovalCommand;

export interface DeviceAdministrationBeginRemovalResult {
  readonly conversations: readonly string[];
  readonly hasAcceptedWork: boolean;
}

export interface DeviceAdministrationPrepareDutyMigrationResult {
  readonly stage: "ready";
}

export interface DeviceAdministrationCommitDutyMigrationResult {
  readonly stage: "completed";
}

export interface DeviceAdministrationCancelDutyMigrationResult {
  readonly stage: "cancelled";
}

export type DeviceAdministrationCommandResult =
  | DeviceAdministrationBeginRemovalResult
  | DeviceAdministrationRemovalState
  | DeviceAdministrationPrepareDutyMigrationResult
  | DeviceAdministrationCommitDutyMigrationResult
  | DeviceAdministrationCancelDutyMigrationResult
  | DeviceAdministrationCurrentRemovalState;

export interface DeviceAdministrationRemovalMember {
  readonly deviceId: string;
  readonly displayName: string;
  readonly state: "active" | "revoked" | "pending-reenroll";
}

export interface DeviceAdministrationRemovalContext {
  readonly localDeviceId: string;
  readonly currentDutyDeviceId: string;
  readonly members: readonly DeviceAdministrationRemovalMember[];
}

export interface DeviceAdministrationRemovalOperation {
  readonly operationId: string;
  readonly targetDeviceId: string;
}

export interface DeviceAdministrationDutyMigrationMember {
  readonly deviceId: string;
  readonly state: "active" | "revoked" | "pending-reenroll";
  readonly dutyCapable: boolean;
}

export interface DeviceAdministrationDutyMigrationContext {
  readonly localDeviceId: string;
  readonly currentDutyDeviceId: string;
  readonly members: readonly DeviceAdministrationDutyMigrationMember[];
}

export type DeviceAdministrationDutyMigrationAdmissionOutcome =
  | Readonly<{ readonly kind: "allowed" }>
  | Readonly<{ readonly kind: "current-owner-transition" }>
  | Readonly<{ readonly kind: "paired-device-removal" }>;

/** Existing device relationship mechanism; product visibility stays in the application. */
export interface DeviceAdministrationRelationshipReadPort {
  list(): Promise<readonly DeviceAdministrationRelationship[]>;
}

/** Existing removal-state mechanism; it does not own the user-visible query contract. */
export interface DeviceAdministrationRemovalStateReadPort {
  read(targetName: string): Promise<DeviceAdministrationRemovalState | undefined>;
}

/** Existing successor-readiness mechanism; migration writes remain outside this slice. */
export interface DeviceAdministrationDutyMigrationTargetReadPort {
  list(): Promise<readonly DeviceAdministrationDutyMigrationTarget[]>;
}

export interface DeviceAdministrationRemovalContextReadPort {
  read(): DeviceAdministrationRemovalContext;
}

export interface DeviceAdministrationDutyMigrationAdmissionPort {
  read(): Readonly<{
    readonly context: DeviceAdministrationDutyMigrationContext;
    readonly outcome: DeviceAdministrationDutyMigrationAdmissionOutcome;
  }>;
}

/** Durable transfer mechanism; it owns journal, signatures, checkpoints and replay. */
export interface DeviceAdministrationDutyMigrationPort {
  prepare(input: {
    readonly requestId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
  }): Promise<void>;
  commit(input: {
    readonly requestId: string;
    readonly transferId: string;
  }): Promise<void>;
  cancel(input: {
    readonly requestId: string;
    readonly transferId: string;
  }): Promise<void>;
}

export interface DeviceAdministrationCurrentRemovalContext {
  readonly localDeviceId: string;
  readonly currentDutyDeviceId: string;
  readonly localIssuerKeyId: string;
  readonly currentDutyIssuerKeyId: string;
  readonly currentDeviceName?: string;
}

export type DeviceAdministrationCurrentRemovalAdmissionOutcome =
  | Readonly<{ readonly kind: "allowed" }>
  | Readonly<{ readonly kind: "paired-device-removal" }>;

export interface DeviceAdministrationCurrentRemovalAdmissionPort {
  read(): Promise<Readonly<{
    readonly context: DeviceAdministrationCurrentRemovalContext;
    readonly outcome: DeviceAdministrationCurrentRemovalAdmissionOutcome;
  }>>;
}

export interface DeviceAdministrationCurrentRemovalMigrationTarget {
  readonly deviceId: string;
  readonly displayName: string;
  readonly ready: boolean;
}

export interface DeviceAdministrationCurrentRemovalMigrationTargetReadPort {
  list(): Promise<readonly DeviceAdministrationCurrentRemovalMigrationTarget[]>;
}

/** Device-owned decision used by the atomic retirement Correctness adapter. */
export function decideCurrentDeviceRetirementCredentialExposures(input: {
  readonly records: readonly CredentialExposureRecord[];
  readonly currentDeviceId: string;
  readonly markedAt: string;
}): readonly CredentialExposureRecord[] {
  return Object.freeze(input.records
    .filter((record) =>
      record.deviceId === input.currentDeviceId && record.state === "active")
    .map((record) => Object.freeze({
      ...record,
      state: "compromised" as const,
      markedAt: input.markedAt,
      rotationHint: record.rotationHint ?? "Rotate this external account credential",
    })));
}

/** Signed journal mechanism. Product cancellation eligibility stays in the application. */
export interface DeviceAdministrationCurrentRemovalMechanismPort {
  abort(input: {
    readonly operationId: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot>;
  read(input: {
    readonly operationId: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot | undefined>;
}

export type DeviceAdministrationCurrentRemovalMigrationPhase =
  | "accepted"
  | "gate-frozen"
  | "transfer-committed"
  | "cleanup-complete"
  | "terminal"
  | "aborted";

export interface DeviceAdministrationCurrentRemovalMigrationLifecycleOperation {
  readonly kind: "current-device-removal";
  readonly path: "migration";
  readonly requestId: string;
  readonly operationId: string;
  readonly transferId: string;
  readonly targetDeviceId: string;
  readonly phase: DeviceAdministrationCurrentRemovalMigrationPhase;
}

/** Serialized lifecycle facts. Evidence remains opaque to the Device domain. */
export interface DeviceAdministrationCurrentRemovalMigrationLifecyclePort<Evidence> {
  accept(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
  }): Promise<DeviceAdministrationCurrentRemovalMigrationLifecycleOperation>;
  active(): Promise<readonly DeviceAdministrationCurrentRemovalMigrationLifecycleOperation[]>;
  advance(input: {
    readonly operationId: string;
    readonly phase: "gate-frozen" | "transfer-committed" | "cleanup-complete";
    readonly evidence: readonly Evidence[];
  }): Promise<DeviceAdministrationCurrentRemovalMigrationLifecycleOperation>;
  terminal(
    operationId: string,
  ): Promise<DeviceAdministrationCurrentRemovalMigrationLifecycleOperation>;
}

/** Physical and Correctness effects; this port contains no phase or retry decisions. */
export interface DeviceAdministrationCurrentRemovalMigrationEffectPort<Evidence> {
  closeAdmission(): Promise<void>;
  closeAcceptedWorkAdmission(operationId: string): Promise<void>;
  freezeAcceptedWork(operationId: string): Promise<Evidence>;
  settleAcceptedWork(input: {
    readonly operationId: string;
    readonly strategy: "drain";
    readonly timeoutMs: 30_000;
  }): Promise<void>;
  flushDurableState(): Promise<readonly Evidence[]>;
  settlePhysicalSteps(): Promise<void>;
  commitTransfer(input: {
    readonly requestId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
  }): Promise<void>;
  verifyTransfer(input: {
    readonly transferId: string;
    readonly targetDeviceId: string;
  }): Promise<Evidence>;
  retireLocalDevice(input: {
    readonly operationId: string;
    readonly targetDeviceId: string;
  }): Promise<Evidence>;
}

export interface DeviceAdministrationCurrentRemovalMigrationApplication {
  begin(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot>;
  resumeActive(): Promise<readonly DeviceAdministrationCurrentRemovalLifecycleSnapshot[]>;
}

/** Sole owner of migration-path lifecycle progression and terminal ordering. */
export class DeviceAdministrationCurrentRemovalMigrationApplicationService<Evidence>
  implements DeviceAdministrationCurrentRemovalMigrationApplication
{
  constructor(private readonly options: {
    readonly lifecycle: DeviceAdministrationCurrentRemovalMigrationLifecyclePort<Evidence>;
    readonly effects: DeviceAdministrationCurrentRemovalMigrationEffectPort<Evidence>;
  }) {}

  async begin(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot> {
    return this.#drive(await this.options.lifecycle.accept(input));
  }

  async resumeActive(): Promise<readonly DeviceAdministrationCurrentRemovalLifecycleSnapshot[]> {
    const results: DeviceAdministrationCurrentRemovalLifecycleSnapshot[] = [];
    for (const operation of await this.options.lifecycle.active()) {
      results.push(await this.#drive(operation));
    }
    return Object.freeze(results);
  }

  async #drive(
    initial: DeviceAdministrationCurrentRemovalMigrationLifecycleOperation,
  ): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot> {
    let operation = assertCurrentRemovalMigrationOperation(initial);
    if (operation.phase === "accepted") {
      await this.options.effects.closeAdmission();
      await this.options.effects.closeAcceptedWorkAdmission(operation.operationId);
      const evidence = await this.options.effects.freezeAcceptedWork(operation.operationId);
      operation = assertCurrentRemovalMigrationOperation(await this.options.lifecycle.advance({
        operationId: operation.operationId,
        phase: "gate-frozen",
        evidence: [evidence],
      }));
    }
    if (operation.phase === "gate-frozen") {
      await this.options.effects.settleAcceptedWork({
        operationId: operation.operationId,
        strategy: "drain",
        timeoutMs: 30_000,
      });
      const flushEvidence = await this.options.effects.flushDurableState();
      await this.options.effects.settlePhysicalSteps();
      await this.options.effects.commitTransfer({
        requestId: operation.requestId,
        transferId: operation.transferId,
        targetDeviceId: operation.targetDeviceId,
      });
      const transferEvidence = await this.options.effects.verifyTransfer({
        transferId: operation.transferId,
        targetDeviceId: operation.targetDeviceId,
      });
      operation = assertCurrentRemovalMigrationOperation(await this.options.lifecycle.advance({
        operationId: operation.operationId,
        phase: "transfer-committed",
        evidence: [...flushEvidence, transferEvidence],
      }));
    }
    if (operation.phase === "transfer-committed") {
      const cleanupEvidence = await this.options.effects.retireLocalDevice({
        operationId: operation.operationId,
        targetDeviceId: operation.targetDeviceId,
      });
      operation = assertCurrentRemovalMigrationOperation(await this.options.lifecycle.advance({
        operationId: operation.operationId,
        phase: "cleanup-complete",
        evidence: [cleanupEvidence],
      }));
    }
    if (operation.phase === "cleanup-complete") {
      operation = assertCurrentRemovalMigrationOperation(
        await this.options.lifecycle.terminal(operation.operationId),
      );
    }
    return currentRemovalMigrationSnapshot(operation);
  }
}

export type DeviceAdministrationCurrentRemovalRecoveryPhase =
  | "accepted"
  | "gate-frozen"
  | "checkpoint-verified"
  | "retirement-decided"
  | "gate-closed"
  | "work-settled"
  | "flushed"
  | "final-checkpoint-verified"
  | "cleanup-complete"
  | "terminal"
  | "aborted";

export interface DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation {
  readonly kind: "current-device-removal";
  readonly path: "recovery-backup";
  readonly requestId: string;
  readonly operationId: string;
  readonly binding: BackupRecoveryCurrentRemovalBinding;
  readonly phase: DeviceAdministrationCurrentRemovalRecoveryPhase;
}

/** Serialized lifecycle and atomic retirement primitives; no method chooses the next phase. */
export interface DeviceAdministrationCurrentRemovalRecoveryLifecyclePort<Evidence> {
  assertBeginAdmission(): Promise<void>;
  assertCurrentAuthority(): Promise<void>;
  accept(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly binding: BackupRecoveryCurrentRemovalBinding;
  }): Promise<DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation>;
  state(
    operationId: string,
  ): Promise<DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation | undefined>;
  active(): Promise<readonly DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation[]>;
  advance(input: {
    readonly operationId: string;
    readonly phase:
      | "gate-frozen"
      | "checkpoint-verified"
      | "gate-closed"
      | "work-settled"
      | "flushed"
      | "final-checkpoint-verified"
      | "cleanup-complete";
    readonly evidence: readonly Evidence[];
  }): Promise<DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation>;
  commitRetirement(input: {
    readonly operationId: string;
    readonly acceptedWork: Evidence;
  }): Promise<DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation>;
  phaseLsn(input: {
    readonly operationId: string;
    readonly phase: "flushed";
  }): Promise<number>;
  terminal(
    operationId: string,
  ): Promise<DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation>;
}

/** Host/Correctness effects. Evidence is opaque and phase progression stays in the application. */
export interface DeviceAdministrationCurrentRemovalRecoveryEffectPort<Evidence> {
  closeAdmission(operationId: string): Promise<Evidence>;
  closeAcceptedWorkAdmission(operationId: string): Promise<void>;
  freezeAcceptedWork(operationId: string): Promise<Evidence>;
  restoreAcceptedWork(operationId: string): Promise<void>;
  settleAcceptedWork(input: {
    readonly operationId: string;
    readonly strategy: "immediate";
    readonly timeoutMs: 30_000;
  }): Promise<Evidence>;
  flushDurableState(): Promise<readonly Evidence[]>;
  settlePhysicalSteps(): Promise<void>;
  cleanup(operationId: string): Promise<readonly Evidence[]>;
  onRetired(operationId: string): void | Promise<void>;
}

export interface DeviceAdministrationCurrentRemovalRecoveryApplication {
  readiness(): Promise<BackupRecoveryCurrentRemovalStatus>;
  begin(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly recoveryPackage: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot>;
  confirm(input: {
    readonly operationId: string;
    readonly recoveryPackage: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot>;
  resumeActive(): Promise<readonly DeviceAdministrationCurrentRemovalLifecycleSnapshot[]>;
}

/** Sole owner of recovery-backup removal phase progression and terminal ordering. */
export class DeviceAdministrationCurrentRemovalRecoveryApplicationService<Evidence>
  implements DeviceAdministrationCurrentRemovalRecoveryApplication
{
  constructor(private readonly options: {
    readonly backup: BackupRecoveryCurrentRemovalApplication<Evidence>;
    readonly lifecycle: DeviceAdministrationCurrentRemovalRecoveryLifecyclePort<Evidence>;
    readonly effects: DeviceAdministrationCurrentRemovalRecoveryEffectPort<Evidence>;
  }) {}

  readiness(): Promise<BackupRecoveryCurrentRemovalStatus> {
    return this.options.backup.readiness();
  }

  async begin(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly recoveryPackage: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot> {
    await this.options.lifecycle.assertBeginAdmission();
    const permit = await this.options.backup.prepareBegin({
      recoveryPackage: input.recoveryPackage,
    });
    return this.#drive(
      await this.options.lifecycle.accept({
        requestId: input.requestId,
        operationId: input.operationId,
        binding: permit.binding,
      }),
      { confirmed: false, permit, resume: false },
    );
  }

  async confirm(input: {
    readonly operationId: string;
    readonly recoveryPackage: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot> {
    const operation = await this.options.lifecycle.state(input.operationId);
    if (!operation) throw new Error("Recovery-backup uninstall operation is unknown");
    await this.options.lifecycle.assertCurrentAuthority();
    const permit = await this.options.backup.prepareConfirm({
      recoveryPackage: input.recoveryPackage,
      binding: operation.binding,
    });
    return this.#drive(operation, { confirmed: true, permit, resume: false });
  }

  async resumeActive(): Promise<readonly DeviceAdministrationCurrentRemovalLifecycleSnapshot[]> {
    const results: DeviceAdministrationCurrentRemovalLifecycleSnapshot[] = [];
    for (const operation of await this.options.lifecycle.active()) {
      results.push(await this.#drive(operation, { confirmed: false, resume: true }));
    }
    return Object.freeze(results);
  }

  async #drive(
    initial: DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation,
    input: {
      readonly confirmed: boolean;
      readonly permit?: BackupRecoveryCurrentRemovalPermit<Evidence>;
      readonly resume: boolean;
    },
  ): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot> {
    let operation = assertCurrentRemovalRecoveryOperation(initial);
    let acceptedWorkAdmissionClosed = false;
    if (operation.phase === "accepted") {
      const admissionEvidence = await this.options.effects.closeAdmission(operation.operationId);
      operation = assertCurrentRemovalRecoveryOperation(await this.options.lifecycle.advance({
        operationId: operation.operationId,
        phase: "gate-frozen",
        evidence: [admissionEvidence],
      }));
    } else if (input.resume && operation.phase !== "terminal" && operation.phase !== "aborted") {
      await this.options.effects.closeAdmission(operation.operationId);
    }
    if (operation.phase === "gate-frozen") {
      if (!input.permit) return currentRemovalRecoverySnapshot(operation);
      const checkpointEvidence = await input.permit.verifyCheckpoint({
        requestId: `${operation.operationId}:pre-retirement`,
      });
      operation = assertCurrentRemovalRecoveryOperation(await this.options.lifecycle.advance({
        operationId: operation.operationId,
        phase: "checkpoint-verified",
        evidence: [checkpointEvidence],
      }));
    }
    if (operation.phase === "checkpoint-verified" && !input.confirmed) {
      return currentRemovalRecoverySnapshot(operation);
    }
    if (operation.phase === "checkpoint-verified") {
      await this.options.effects.closeAcceptedWorkAdmission(operation.operationId);
      acceptedWorkAdmissionClosed = true;
      const acceptedWork = await this.options.effects.freezeAcceptedWork(operation.operationId);
      operation = assertCurrentRemovalRecoveryOperation(
        await this.options.lifecycle.commitRetirement({
          operationId: operation.operationId,
          acceptedWork,
        }),
      );
    }
    if (recoveryAcceptedWorkStarted(operation.phase)) {
      if (!acceptedWorkAdmissionClosed) {
        await this.options.effects.closeAcceptedWorkAdmission(operation.operationId);
      }
      await this.options.effects.restoreAcceptedWork(operation.operationId);
    }
    if (input.resume && operation.phase !== "final-checkpoint-verified" &&
      operation.phase !== "cleanup-complete") {
      return currentRemovalRecoverySnapshot(operation);
    }
    if (operation.phase === "retirement-decided") {
      operation = assertCurrentRemovalRecoveryOperation(await this.options.lifecycle.advance({
        operationId: operation.operationId,
        phase: "gate-closed",
        evidence: [],
      }));
    }
    if (operation.phase === "gate-closed") {
      const settlementEvidence = await this.options.effects.settleAcceptedWork({
        operationId: operation.operationId,
        strategy: "immediate",
        timeoutMs: 30_000,
      });
      operation = assertCurrentRemovalRecoveryOperation(await this.options.lifecycle.advance({
        operationId: operation.operationId,
        phase: "work-settled",
        evidence: [settlementEvidence],
      }));
    }
    if (operation.phase === "work-settled") {
      const evidence = await this.options.effects.flushDurableState();
      await this.options.effects.settlePhysicalSteps();
      operation = assertCurrentRemovalRecoveryOperation(await this.options.lifecycle.advance({
        operationId: operation.operationId,
        phase: "flushed",
        evidence,
      }));
    }
    if (operation.phase === "flushed") {
      if (!input.permit) return currentRemovalRecoverySnapshot(operation);
      const flushedLsn = await this.options.lifecycle.phaseLsn({
        operationId: operation.operationId,
        phase: "flushed",
      });
      const checkpointEvidence = await input.permit.verifyCheckpoint({
        requestId: `${operation.operationId}:final-retirement`,
        minimumUpToLsn: flushedLsn,
      });
      operation = assertCurrentRemovalRecoveryOperation(await this.options.lifecycle.advance({
        operationId: operation.operationId,
        phase: "final-checkpoint-verified",
        evidence: [checkpointEvidence],
      }));
    }
    if (operation.phase === "final-checkpoint-verified") {
      const evidence = await this.options.effects.cleanup(operation.operationId);
      operation = assertCurrentRemovalRecoveryOperation(await this.options.lifecycle.advance({
        operationId: operation.operationId,
        phase: "cleanup-complete",
        evidence,
      }));
    }
    if (operation.phase === "cleanup-complete") {
      operation = assertCurrentRemovalRecoveryOperation(
        await this.options.lifecycle.terminal(operation.operationId),
      );
      await this.options.effects.onRetired(operation.operationId);
    }
    return currentRemovalRecoverySnapshot(operation);
  }
}

export class DeviceAdministrationApplicationError extends Error {
  readonly name = "DeviceAdministrationApplicationError";

  constructor(
    readonly kind: "current-device-removal-unavailable",
    message: string,
  ) {
    super(message);
  }
}

/** Durable lifecycle mechanism. Accepted/abort tokens stay opaque to this domain. */
export interface DeviceAdministrationRemovalAuthorityPort<Accepted, Abort> {
  acceptForTarget(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly targetDeviceId: string;
  }): Promise<Accepted>;
  operation(operationId: string): Promise<DeviceAdministrationRemovalOperation | undefined>;
  operationForTarget(
    targetDeviceId: string,
  ): Promise<DeviceAdministrationRemovalOperation | undefined>;
  abort(operationId: string): Promise<Abort>;
  commitLost(operationId: string): Promise<void>;
}

export type DeviceAdministrationRemovalEffectOutcome<Result> =
  | Readonly<{ readonly kind: "completed"; readonly result: Result }>
  | Readonly<{ readonly kind: "unavailable" }>;

/** Effects report only completed or unavailable; product decisions stay in this application. */
export interface DeviceAdministrationRemovalEffectPort<Accepted, Abort> {
  accept(input: {
    readonly targetDeviceId: string;
    readonly accepted: Accepted;
  }): Promise<DeviceAdministrationRemovalEffectOutcome<DeviceAdministrationBeginRemovalResult>>;
  abort(input: {
    readonly targetDeviceId: string;
    readonly operationId: string;
    readonly abort: Abort;
  }): Promise<DeviceAdministrationRemovalEffectOutcome<DeviceAdministrationRemovalState>>;
  decide(input: {
    readonly targetDeviceId: string;
    readonly operationId: string;
    readonly mode: "transfer" | "destroy";
    readonly currentDutyDeviceId: string;
  }): Promise<DeviceAdministrationRemovalEffectOutcome<DeviceAdministrationRemovalState>>;
}

export interface DeviceAdministrationApplicationOptions<Accepted, Abort> {
  readonly relationships: DeviceAdministrationRelationshipReadPort;
  readonly removalState: DeviceAdministrationRemovalStateReadPort;
  readonly dutyMigrationTargets: DeviceAdministrationDutyMigrationTargetReadPort;
  readonly removalContext: DeviceAdministrationRemovalContextReadPort;
  readonly removalAuthority: DeviceAdministrationRemovalAuthorityPort<Accepted, Abort>;
  readonly removalEffects: DeviceAdministrationRemovalEffectPort<Accepted, Abort>;
  readonly dutyMigrationAdmission: DeviceAdministrationDutyMigrationAdmissionPort;
  readonly dutyMigration: DeviceAdministrationDutyMigrationPort;
  readonly currentRemovalAdmission?: DeviceAdministrationCurrentRemovalAdmissionPort;
  readonly currentRemovalMigrationTargets?:
    DeviceAdministrationCurrentRemovalMigrationTargetReadPort;
  readonly currentRemovalMigration?: DeviceAdministrationCurrentRemovalMigrationApplication;
  readonly currentRemovalRecovery?: DeviceAdministrationCurrentRemovalRecoveryApplication;
  readonly currentDeviceRemoval?: DeviceAdministrationCurrentRemovalMechanismPort;
}

export interface DeviceAdministrationApplication {
  query(query: DeviceAdministrationListQuery): Promise<DeviceAdministrationListResult>;
  query(query: DeviceAdministrationStatusQuery): Promise<DeviceAdministrationStatusResult>;
  query(
    query: DeviceAdministrationDutyMigrationTargetsQuery,
  ): Promise<DeviceAdministrationDutyMigrationTargetsResult>;
  query(
    query: DeviceAdministrationCurrentRemovalPreflightQuery,
  ): Promise<DeviceAdministrationCurrentRemovalPreflightResult>;
  query(
    query: DeviceAdministrationCurrentRemovalStatusQuery,
  ): Promise<DeviceAdministrationCurrentRemovalStatusResult>;
  execute(
    command: DeviceAdministrationBeginRemovalCommand,
  ): Promise<DeviceAdministrationBeginRemovalResult>;
  execute(
    command: DeviceAdministrationContinueRemovalCommand,
  ): Promise<DeviceAdministrationRemovalState>;
  execute(
    command: DeviceAdministrationPrepareDutyMigrationCommand,
  ): Promise<DeviceAdministrationPrepareDutyMigrationResult>;
  execute(
    command: DeviceAdministrationCommitDutyMigrationCommand,
  ): Promise<DeviceAdministrationCommitDutyMigrationResult>;
  execute(
    command: DeviceAdministrationCancelDutyMigrationCommand,
  ): Promise<DeviceAdministrationCancelDutyMigrationResult>;
  execute(
    command: DeviceAdministrationBeginCurrentRemovalCommand,
  ): Promise<DeviceAdministrationCurrentRemovalState>;
  execute(
    command: DeviceAdministrationContinueCurrentRemovalCommand,
  ): Promise<DeviceAdministrationCurrentRemovalState>;
  execute(
    command: DeviceAdministrationCancelCurrentRemovalCommand,
  ): Promise<DeviceAdministrationCurrentRemovalState>;
}

/** Sole application owner of current Device Administration reads and commands. */
export class DeviceAdministrationApplicationService<Accepted, Abort>
  implements DeviceAdministrationApplication
{
  constructor(private readonly options: DeviceAdministrationApplicationOptions<Accepted, Abort>) {}

  query(query: DeviceAdministrationListQuery): Promise<DeviceAdministrationListResult>;
  query(query: DeviceAdministrationStatusQuery): Promise<DeviceAdministrationStatusResult>;
  query(
    query: DeviceAdministrationDutyMigrationTargetsQuery,
  ): Promise<DeviceAdministrationDutyMigrationTargetsResult>;
  query(
    query: DeviceAdministrationCurrentRemovalPreflightQuery,
  ): Promise<DeviceAdministrationCurrentRemovalPreflightResult>;
  query(
    query: DeviceAdministrationCurrentRemovalStatusQuery,
  ): Promise<DeviceAdministrationCurrentRemovalStatusResult>;
  async query(query: DeviceAdministrationQuery): Promise<DeviceAdministrationResult> {
    switch (query.kind) {
      case "list-device-relationships":
        return Object.freeze({
          devices: Object.freeze(
            (await this.options.relationships.list()).map(freezeRelationship),
          ),
        });
      case "read-device-removal-state": {
        const targetName = requireStableText(query.targetName, "Device name");
        const state = await this.options.removalState.read(targetName);
        return Object.freeze({
          state: state === undefined ? null : freezeRemovalState(state),
        });
      }
      case "list-duty-migration-targets":
        return Object.freeze({
          devices: Object.freeze(
            (await this.options.dutyMigrationTargets.list()).map(freezeDutyMigrationTarget),
          ),
        });
      case "preflight-current-device-removal": {
        const { preflight } = await this.#readCurrentRemovalPreflight();
        return preflight;
      }
      case "read-current-device-removal-status": {
        const operationId = requireStableText(query.operationId, "Uninstall operation id");
        const lifecycle = await this.#currentDeviceRemoval().read({ operationId });
        return Object.freeze({
          state: lifecycle === undefined ? null : projectCurrentRemovalState(lifecycle),
        });
      }
      default:
        throw new TypeError("Unsupported Device Administration query");
    }
  }

  execute(
    command: DeviceAdministrationBeginRemovalCommand,
  ): Promise<DeviceAdministrationBeginRemovalResult>;
  execute(
    command: DeviceAdministrationContinueRemovalCommand,
  ): Promise<DeviceAdministrationRemovalState>;
  execute(
    command: DeviceAdministrationPrepareDutyMigrationCommand,
  ): Promise<DeviceAdministrationPrepareDutyMigrationResult>;
  execute(
    command: DeviceAdministrationCommitDutyMigrationCommand,
  ): Promise<DeviceAdministrationCommitDutyMigrationResult>;
  execute(
    command: DeviceAdministrationCancelDutyMigrationCommand,
  ): Promise<DeviceAdministrationCancelDutyMigrationResult>;
  execute(
    command: DeviceAdministrationBeginCurrentRemovalCommand,
  ): Promise<DeviceAdministrationCurrentRemovalState>;
  execute(
    command: DeviceAdministrationContinueCurrentRemovalCommand,
  ): Promise<DeviceAdministrationCurrentRemovalState>;
  execute(
    command: DeviceAdministrationCancelCurrentRemovalCommand,
  ): Promise<DeviceAdministrationCurrentRemovalState>;
  async execute(command: DeviceAdministrationCommand): Promise<DeviceAdministrationCommandResult> {
    switch (command.kind) {
      case "begin-device-removal":
        return this.#beginRemoval(command);
      case "continue-device-removal":
        return this.#continueRemoval(command);
      case "prepare-duty-migration":
        return this.#prepareDutyMigration(command);
      case "commit-duty-migration":
        return this.#commitDutyMigration(command);
      case "cancel-duty-migration":
        return this.#cancelDutyMigration(command);
      case "begin-current-device-removal":
        return this.#beginCurrentRemoval(command);
      case "continue-current-device-removal":
        return this.#continueCurrentRemoval(command);
      case "cancel-current-device-removal":
        return this.#cancelCurrentRemoval(command);
      default:
        throw new TypeError("Unsupported Device Administration command");
    }
  }

  async #beginRemoval(
    command: DeviceAdministrationBeginRemovalCommand,
  ): Promise<DeviceAdministrationBeginRemovalResult> {
    const requestId = requireStableText(command.requestId, "Removal request id");
    const operationId = requireStableText(command.operationId, "Removal operation id");
    const targetName = requireStableText(command.targetName, "Device name");
    const context = this.options.removalContext.read();
    if (context.currentDutyDeviceId !== context.localDeviceId) {
      throw new Error("Only the current duty device can remove a paired device");
    }
    const matches = context.members.filter((member) =>
      member.state === "active" && member.displayName === targetName);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? "No active paired device has that name"
        : "More than one active paired device has that name");
    }
    const targetDeviceId = matches[0]!.deviceId;
    if (targetDeviceId === context.currentDutyDeviceId) {
      throw new Error("The current duty device cannot remove itself");
    }
    const accepted = await this.options.removalAuthority.acceptForTarget({
      requestId,
      operationId,
      targetDeviceId,
    });
    const effect = await this.options.removalEffects.accept({ targetDeviceId, accepted });
    switch (effect.kind) {
      case "completed":
        return freezeBeginRemovalResult(effect.result);
      case "unavailable":
        return freezeBeginRemovalResult({ conversations: [], hasAcceptedWork: false });
      default:
        throw new TypeError("Device removal effect outcome is invalid");
    }
  }

  async #continueRemoval(
    command: DeviceAdministrationContinueRemovalCommand,
  ): Promise<DeviceAdministrationRemovalState> {
    const targetName = requireStableText(command.targetName, "Device name");
    if (!new Set(["transfer", "destroy", "lost", "cancel"]).has(command.mode)) {
      throw new TypeError("Removal mode is invalid");
    }
    const context = this.options.removalContext.read();
    if (context.currentDutyDeviceId !== context.localDeviceId) {
      throw new Error("Only the current duty device can continue device removal");
    }
    const named = context.members.filter((member) => member.displayName === targetName);
    if (named.length !== 1) {
      throw new Error(named.length === 0
        ? "Paired device name is unknown"
        : "Paired device name is not unique");
    }
    const requestedOperationId = command.mode === "cancel" && command.operationId !== undefined
      ? requireStableText(command.operationId, "Removal operation id")
      : undefined;
    const operation = requestedOperationId !== undefined
      ? await this.options.removalAuthority.operation(requestedOperationId)
      : await this.options.removalAuthority.operationForTarget(named[0]!.deviceId);
    if (!operation) {
      if (command.mode === "cancel" && requestedOperationId !== undefined) {
        return freezeRemovalState({
          phase: "cancelled",
          conversations: [],
          localData: "known",
          credentialActions: [],
        });
      }
      throw new Error("Removal operation is unknown");
    }
    const matches = context.members.filter((member) =>
      member.deviceId === operation.targetDeviceId && member.displayName === targetName);
    if (matches.length !== 1) {
      throw new Error("Removal target name does not match the accepted device");
    }
    const targetDeviceId = operation.targetDeviceId;
    const operationId = operation.operationId;
    if (command.mode === "cancel") {
      const abort = await this.options.removalAuthority.abort(operationId);
      const effect = await this.options.removalEffects.abort({
        targetDeviceId,
        operationId,
        abort,
      });
      switch (effect.kind) {
        case "completed":
          return freezeRemovalState(effect.result);
        case "unavailable":
          return freezeRemovalState({
            phase: "waiting-for-device",
            conversations: [],
            localData: "known",
            credentialActions: ["取消已安全记录；目标设备上线后会自动恢复准入"],
          });
        default:
          throw new TypeError("Device removal effect outcome is invalid");
      }
    }
    if (command.mode === "lost") {
      await this.options.removalAuthority.commitLost(operationId);
      return freezeRemovalState({
        phase: "removed",
        conversations: [],
        localData: "unknown",
        credentialActions: ["Change credentials for accounts used on this device"],
      });
    }
    if (matches[0]!.state !== "active") {
      throw new Error("Removal target is no longer an active paired device");
    }
    const effect = await this.options.removalEffects.decide({
      targetDeviceId,
      operationId,
      mode: command.mode,
      currentDutyDeviceId: context.currentDutyDeviceId,
    });
    switch (effect.kind) {
      case "completed":
        return freezeRemovalState(effect.result);
      case "unavailable":
        throw new Error(
          "The device is offline; choose lost-device revocation or wait for it to reconnect",
        );
      default:
        throw new TypeError("Device removal effect outcome is invalid");
    }
  }

  async #prepareDutyMigration(
    command: DeviceAdministrationPrepareDutyMigrationCommand,
  ): Promise<DeviceAdministrationPrepareDutyMigrationResult> {
    const input = {
      requestId: requireStableText(command.requestId, "Migration request id"),
      transferId: requireStableText(command.transferId, "Migration transfer id"),
      targetDeviceId: requireStableText(command.targetDeviceId, "Migration target device id"),
    };
    const context = this.#assertDutyMigrationAdmission(false);
    const target = context.members.find((member) => member.deviceId === input.targetDeviceId);
    if (
      input.targetDeviceId === context.localDeviceId ||
      target?.state !== "active" ||
      !target.dutyCapable
    ) {
      throw new TypeError("Migration target is not an active paired duty-capable device");
    }
    await this.options.dutyMigration.prepare(input);
    return Object.freeze({ stage: "ready" });
  }

  async #commitDutyMigration(
    command: DeviceAdministrationCommitDutyMigrationCommand,
  ): Promise<DeviceAdministrationCommitDutyMigrationResult> {
    const input = dutyMigrationIdentity(command);
    this.#assertDutyMigrationAdmission(false);
    await this.options.dutyMigration.commit(input);
    return Object.freeze({ stage: "completed" });
  }

  async #cancelDutyMigration(
    command: DeviceAdministrationCancelDutyMigrationCommand,
  ): Promise<DeviceAdministrationCancelDutyMigrationResult> {
    const input = dutyMigrationIdentity(command);
    this.#assertDutyMigrationAdmission(true);
    await this.options.dutyMigration.cancel(input);
    return Object.freeze({ stage: "cancelled" });
  }

  #assertDutyMigrationAdmission(
    allowDuringDeviceRemoval: boolean,
  ): DeviceAdministrationDutyMigrationContext {
    const { context, outcome } = this.options.dutyMigrationAdmission.read();
    switch (outcome.kind) {
      case "allowed":
        break;
      case "current-owner-transition":
        throw new Error("Current duty device is completing its durable migration consumers");
      case "paired-device-removal":
        if (!allowDuringDeviceRemoval) {
          throw new Error(
            "Duty-device migration is unavailable while a paired device is being removed",
          );
        }
        break;
      default:
        throw new TypeError("Duty-device migration admission outcome is invalid");
    }
    if (context.currentDutyDeviceId !== context.localDeviceId) {
      throw new Error("This device is not the current duty device");
    }
    return context;
  }

  async #beginCurrentRemoval(
    command: DeviceAdministrationBeginCurrentRemovalCommand,
  ): Promise<DeviceAdministrationCurrentRemovalState> {
    const requestId = requireStableText(command.requestId, "Uninstall request id");
    const operationId = requireStableText(command.operationId, "Uninstall operation id");
    let lifecycle: DeviceAdministrationCurrentRemovalLifecycleSnapshot;
    if (command.path === "migration") {
      const transferId = requireStableText(command.transferId, "Uninstall transfer id");
      const targetName = requireStableText(command.targetName, "Duty device name");
      const { migrationTargets } = await this.#readCurrentRemovalPreflight();
      const matches = migrationTargets.filter((candidate) =>
        candidate.ready && candidate.displayName === targetName);
      if (matches.length !== 1) {
        throw new Error(matches.length === 0
          ? "No ready duty device has that name"
          : "More than one ready duty device has that name");
      }
      const migration = this.options.currentRemovalMigration;
      if (!migration) throw this.#currentRemovalUnavailable();
      lifecycle = await migration.begin({
        requestId,
        operationId,
        transferId,
        targetDeviceId: requireStableText(matches[0]!.deviceId, "Duty device id"),
      });
    } else if (command.path === "recovery-backup") {
      lifecycle = await this.#currentRemovalRecovery().begin({
        requestId,
        operationId,
        recoveryPackage: requireStableText(command.recoveryPackage, "Recovery package"),
      });
    } else {
      throw new TypeError("Permanent removal path is invalid");
    }
    return projectCurrentRemovalState(lifecycle);
  }

  async #readCurrentRemovalPreflight(): Promise<{
    readonly preflight: DeviceAdministrationCurrentRemovalPreflightResult;
    readonly migrationTargets: readonly DeviceAdministrationCurrentRemovalMigrationTarget[];
  }> {
    const admissionPort = this.options.currentRemovalAdmission;
    const migrationTargetsPort = this.options.currentRemovalMigrationTargets;
    const recovery = this.options.currentRemovalRecovery;
    if (!admissionPort || !migrationTargetsPort || !recovery) {
      throw this.#currentRemovalUnavailable();
    }
    const admission = await admissionPort.read();
    const context = admission.context;
    if (
      context.currentDutyDeviceId !== context.localDeviceId ||
      context.currentDutyIssuerKeyId !== context.localIssuerKeyId
    ) {
      throw new Error("Only the current duty device can uninstall itself");
    }
    switch (admission.outcome.kind) {
      case "allowed":
        break;
      case "paired-device-removal":
        throw new Error("Finish the current device removal before uninstalling this device");
      default:
        throw new TypeError("Current device removal admission outcome is invalid");
    }
    const migrationTargets = Object.freeze(
      (await migrationTargetsPort.list()).map((target) => Object.freeze({
        deviceId: target.deviceId,
        displayName: target.displayName,
        ready: target.ready,
      })),
    );
    const backup = await recovery.readiness();
    return Object.freeze({
      preflight: freezeCurrentRemovalPreflight({
        currentDeviceName: context.currentDeviceName ?? "当前设备",
        migrationTargets,
        recoveryBackupReady:
          backup.state === "recoverable" &&
          backup.fullBackupReady &&
          !!backup.checkpointId &&
          !!backup.targetId &&
          backup.upToLsn !== undefined,
      }),
      migrationTargets,
    });
  }

  async #continueCurrentRemoval(
    command: DeviceAdministrationContinueCurrentRemovalCommand,
  ): Promise<DeviceAdministrationCurrentRemovalState> {
    if (command.confirmBackup !== true) {
      throw new TypeError("Recovery-backup uninstall requires explicit confirmation");
    }
    return projectCurrentRemovalState(await this.#currentRemovalRecovery().confirm({
      operationId: requireStableText(command.operationId, "Uninstall operation id"),
      recoveryPackage: requireStableText(command.recoveryPackage, "Recovery package"),
    }));
  }

  async #cancelCurrentRemoval(
    command: DeviceAdministrationCancelCurrentRemovalCommand,
  ): Promise<DeviceAdministrationCurrentRemovalState> {
    const operationId = requireStableText(command.operationId, "Uninstall operation id");
    const port = this.#currentDeviceRemoval();
    const lifecycle = await port.read({ operationId });
    if (!lifecycle) throw new Error("Current device removal operation is unknown");
    assertCurrentRemovalCancellationEligible(lifecycle);
    return projectCurrentRemovalState(await port.abort({ operationId }));
  }

  #currentDeviceRemoval(): DeviceAdministrationCurrentRemovalMechanismPort {
    const port = this.options.currentDeviceRemoval;
    if (!port) {
      throw this.#currentRemovalUnavailable();
    }
    return port;
  }

  #currentRemovalRecovery(): DeviceAdministrationCurrentRemovalRecoveryApplication {
    const application = this.options.currentRemovalRecovery;
    if (!application) throw this.#currentRemovalUnavailable();
    return application;
  }

  #currentRemovalUnavailable(): DeviceAdministrationApplicationError {
    return new DeviceAdministrationApplicationError(
      "current-device-removal-unavailable",
      "Current device does not support permanent removal",
    );
  }
}

export const DEVICE_ADMINISTRATION_LIST_QUERY = defineProductApiQuery<
  "device-administration.query.list",
  DeviceAdministrationListQuery,
  DeviceAdministrationListResult
>("device-administration.query.list");

export const DEVICE_ADMINISTRATION_STATUS_QUERY = defineProductApiQuery<
  "device-administration.query.removal-status",
  DeviceAdministrationStatusQuery,
  DeviceAdministrationStatusResult
>("device-administration.query.removal-status");

export const DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY = defineProductApiQuery<
  "device-administration.query.duty-migration-targets",
  DeviceAdministrationDutyMigrationTargetsQuery,
  DeviceAdministrationDutyMigrationTargetsResult
>("device-administration.query.duty-migration-targets");

export const DEVICE_ADMINISTRATION_CURRENT_REMOVAL_PREFLIGHT_QUERY = defineProductApiQuery<
  "device-administration.query.current-removal-preflight",
  DeviceAdministrationCurrentRemovalPreflightQuery,
  DeviceAdministrationCurrentRemovalPreflightResult
>("device-administration.query.current-removal-preflight");

export const DEVICE_ADMINISTRATION_CURRENT_REMOVAL_STATUS_QUERY = defineProductApiQuery<
  "device-administration.query.current-removal-status",
  DeviceAdministrationCurrentRemovalStatusQuery,
  DeviceAdministrationCurrentRemovalStatusResult
>("device-administration.query.current-removal-status");

export const DEVICE_ADMINISTRATION_BEGIN_REMOVAL_COMMAND = defineProductApiCommand<
  "device-administration.command.begin-removal",
  DeviceAdministrationBeginRemovalCommand,
  DeviceAdministrationBeginRemovalResult,
  never
>("device-administration.command.begin-removal", []);

export const DEVICE_ADMINISTRATION_CONTINUE_REMOVAL_COMMAND = defineProductApiCommand<
  "device-administration.command.continue-removal",
  DeviceAdministrationContinueRemovalCommand,
  DeviceAdministrationRemovalState,
  never
>("device-administration.command.continue-removal", []);

export const DEVICE_ADMINISTRATION_PREPARE_DUTY_MIGRATION_COMMAND = defineProductApiCommand<
  "device-administration.command.prepare-duty-migration",
  DeviceAdministrationPrepareDutyMigrationCommand,
  DeviceAdministrationPrepareDutyMigrationResult,
  never
>("device-administration.command.prepare-duty-migration", []);

export const DEVICE_ADMINISTRATION_COMMIT_DUTY_MIGRATION_COMMAND = defineProductApiCommand<
  "device-administration.command.commit-duty-migration",
  DeviceAdministrationCommitDutyMigrationCommand,
  DeviceAdministrationCommitDutyMigrationResult,
  never
>("device-administration.command.commit-duty-migration", []);

export const DEVICE_ADMINISTRATION_CANCEL_DUTY_MIGRATION_COMMAND = defineProductApiCommand<
  "device-administration.command.cancel-duty-migration",
  DeviceAdministrationCancelDutyMigrationCommand,
  DeviceAdministrationCancelDutyMigrationResult,
  never
>("device-administration.command.cancel-duty-migration", []);

export const DEVICE_ADMINISTRATION_BEGIN_CURRENT_REMOVAL_COMMAND = defineProductApiCommand<
  "device-administration.command.begin-current-removal",
  DeviceAdministrationBeginCurrentRemovalCommand,
  DeviceAdministrationCurrentRemovalState,
  never
>("device-administration.command.begin-current-removal", []);

export const DEVICE_ADMINISTRATION_CONTINUE_CURRENT_REMOVAL_COMMAND = defineProductApiCommand<
  "device-administration.command.continue-current-removal",
  DeviceAdministrationContinueCurrentRemovalCommand,
  DeviceAdministrationCurrentRemovalState,
  never
>("device-administration.command.continue-current-removal", []);

export const DEVICE_ADMINISTRATION_CANCEL_CURRENT_REMOVAL_COMMAND = defineProductApiCommand<
  "device-administration.command.cancel-current-removal",
  DeviceAdministrationCancelCurrentRemovalCommand,
  DeviceAdministrationCurrentRemovalState,
  never
>("device-administration.command.cancel-current-removal", []);

export const DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    DEVICE_ADMINISTRATION_LIST_QUERY,
    DEVICE_ADMINISTRATION_STATUS_QUERY,
    DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY,
    DEVICE_ADMINISTRATION_CURRENT_REMOVAL_PREFLIGHT_QUERY,
    DEVICE_ADMINISTRATION_CURRENT_REMOVAL_STATUS_QUERY,
    DEVICE_ADMINISTRATION_BEGIN_REMOVAL_COMMAND,
    DEVICE_ADMINISTRATION_CONTINUE_REMOVAL_COMMAND,
    DEVICE_ADMINISTRATION_PREPARE_DUTY_MIGRATION_COMMAND,
    DEVICE_ADMINISTRATION_COMMIT_DUTY_MIGRATION_COMMAND,
    DEVICE_ADMINISTRATION_CANCEL_DUTY_MIGRATION_COMMAND,
    DEVICE_ADMINISTRATION_BEGIN_CURRENT_REMOVAL_COMMAND,
    DEVICE_ADMINISTRATION_CONTINUE_CURRENT_REMOVAL_COMMAND,
    DEVICE_ADMINISTRATION_CANCEL_CURRENT_REMOVAL_COMMAND,
  ],
  factEvents: [],
});

export function createDeviceAdministrationProductApiContribution(
  application: DeviceAdministrationApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(DEVICE_ADMINISTRATION_LIST_QUERY, async (query) => ({
        result: await application.query(query),
        facts: [],
      })),
      bindProductApiOperation(DEVICE_ADMINISTRATION_STATUS_QUERY, async (query) => ({
        result: await application.query(query),
        facts: [],
      })),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY,
        async (query) => ({
          result: await application.query(query),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_CURRENT_REMOVAL_PREFLIGHT_QUERY,
        async (query) => ({
          result: await application.query(query),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_CURRENT_REMOVAL_STATUS_QUERY,
        async (query) => ({
          result: await application.query(query),
          facts: [],
        }),
      ),
      bindProductApiOperation(DEVICE_ADMINISTRATION_BEGIN_REMOVAL_COMMAND, async (command) => ({
        result: await application.execute(command),
        facts: [],
      })),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_CONTINUE_REMOVAL_COMMAND,
        async (command) => ({
          result: await application.execute(command),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_PREPARE_DUTY_MIGRATION_COMMAND,
        async (command) => ({
          result: await application.execute(command),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_COMMIT_DUTY_MIGRATION_COMMAND,
        async (command) => ({
          result: await application.execute(command),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_CANCEL_DUTY_MIGRATION_COMMAND,
        async (command) => ({
          result: await application.execute(command),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_BEGIN_CURRENT_REMOVAL_COMMAND,
        async (command) => ({
          result: await application.execute(command),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_CONTINUE_CURRENT_REMOVAL_COMMAND,
        async (command) => ({
          result: await application.execute(command),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_CANCEL_CURRENT_REMOVAL_COMMAND,
        async (command) => ({
          result: await application.execute(command),
          facts: [],
        }),
      ),
    ],
    factEvents: [],
  });
}

function freezeRelationship(
  value: DeviceAdministrationRelationship,
): DeviceAdministrationRelationship {
  return Object.freeze({
    displayName: value.displayName,
    reachable: value.reachable,
  });
}

function freezeRemovalState(
  value: DeviceAdministrationRemovalState,
): DeviceAdministrationRemovalState {
  return Object.freeze({
    phase: value.phase,
    conversations: Object.freeze([...value.conversations]),
    localData: value.localData,
    credentialActions: Object.freeze([...value.credentialActions]),
  });
}

function freezeBeginRemovalResult(
  value: DeviceAdministrationBeginRemovalResult,
): DeviceAdministrationBeginRemovalResult {
  return Object.freeze({
    conversations: Object.freeze([...value.conversations]),
    hasAcceptedWork: value.hasAcceptedWork === true,
  });
}

function freezeDutyMigrationTarget(
  value: DeviceAdministrationDutyMigrationTarget,
): DeviceAdministrationDutyMigrationTarget {
  return Object.freeze({
    deviceId: value.deviceId,
    displayName: value.displayName,
    ready: value.ready,
    ...(value.code === undefined ? {} : { code: value.code }),
  });
}

function freezeCurrentRemovalPreflight(
  value: DeviceAdministrationCurrentRemovalPreflightResult,
): DeviceAdministrationCurrentRemovalPreflightResult {
  return Object.freeze({
    currentDeviceName: value.currentDeviceName,
    migrationTargets: Object.freeze(value.migrationTargets.map((target) => Object.freeze({
      displayName: target.displayName,
      ready: target.ready,
    }))),
    recoveryBackupReady: value.recoveryBackupReady,
  });
}

function projectCurrentRemovalState(
  lifecycle: DeviceAdministrationCurrentRemovalLifecycleSnapshot,
): DeviceAdministrationCurrentRemovalState {
  assertCurrentRemovalLifecycle(lifecycle);
  switch (lifecycle.phase) {
    case "terminal":
      return Object.freeze({ phase: "uninstalled" });
    case "aborted":
      return Object.freeze({ phase: "cancelled" });
    case "checkpoint-verified":
      return Object.freeze({ phase: "backup-verified", nextAction: "confirm-backup" });
    case "final-checkpoint-verified":
    case "cleanup-complete":
      return Object.freeze({ phase: "ready-to-uninstall", nextAction: "continue" });
    case "retirement-decided":
    case "gate-closed":
    case "work-settled":
    case "flushed":
      return Object.freeze({ phase: "retiring-device", nextAction: "continue" });
    case "accepted":
    case "gate-frozen":
    case "transfer-committed":
      return lifecycle.path === "migration"
        ? Object.freeze({ phase: "moving-duty-device", nextAction: "continue" })
        : Object.freeze({ phase: "choose-safe-path", nextAction: "continue" });
  }
}

function assertCurrentRemovalMigrationOperation(
  operation: DeviceAdministrationCurrentRemovalMigrationLifecycleOperation,
): DeviceAdministrationCurrentRemovalMigrationLifecycleOperation {
  if (operation.kind !== "current-device-removal" || operation.path !== "migration") {
    throw new TypeError("Current removal migration lifecycle identity is invalid");
  }
  switch (operation.phase) {
    case "accepted":
    case "gate-frozen":
    case "transfer-committed":
    case "cleanup-complete":
    case "terminal":
    case "aborted":
      break;
    default:
      throw new TypeError("Current removal migration lifecycle phase is invalid");
  }
  return Object.freeze({
    kind: "current-device-removal",
    path: "migration",
    requestId: requireStableText(operation.requestId, "Uninstall request id"),
    operationId: requireStableText(operation.operationId, "Uninstall operation id"),
    transferId: requireStableText(operation.transferId, "Uninstall transfer id"),
    targetDeviceId: requireStableText(operation.targetDeviceId, "Duty device id"),
    phase: operation.phase,
  });
}

function currentRemovalMigrationSnapshot(
  operation: DeviceAdministrationCurrentRemovalMigrationLifecycleOperation,
): DeviceAdministrationCurrentRemovalLifecycleSnapshot {
  return Object.freeze({
    kind: "current-device-removal",
    path: "migration",
    phase: operation.phase,
  });
}

function assertCurrentRemovalRecoveryOperation(
  operation: DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation,
): DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation {
  if (operation.kind !== "current-device-removal" || operation.path !== "recovery-backup") {
    throw new TypeError("Current removal recovery lifecycle identity is invalid");
  }
  switch (operation.phase) {
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
      break;
    default:
      throw new TypeError("Current removal recovery lifecycle phase is invalid");
  }
  const binding = operation.binding;
  return Object.freeze({
    kind: "current-device-removal",
    path: "recovery-backup",
    requestId: requireStableText(operation.requestId, "Uninstall request id"),
    operationId: requireStableText(operation.operationId, "Uninstall operation id"),
    binding: Object.freeze({
      checkpointTargetId: requireStableText(
        binding.checkpointTargetId,
        "Recovery checkpoint target id",
      ),
      acceptedRecoveryBinding: requireStableText(
        binding.acceptedRecoveryBinding,
        "Accepted recovery binding",
      ),
      checkpointBinding: requireStableText(
        binding.checkpointBinding,
        "Recovery checkpoint binding",
      ),
    }),
    phase: operation.phase,
  });
}

function currentRemovalRecoverySnapshot(
  operation: DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation,
): DeviceAdministrationCurrentRemovalLifecycleSnapshot {
  return Object.freeze({
    kind: "current-device-removal",
    path: "recovery-backup",
    phase: operation.phase,
  });
}

function recoveryAcceptedWorkStarted(
  phase: DeviceAdministrationCurrentRemovalRecoveryPhase,
): boolean {
  return new Set<DeviceAdministrationCurrentRemovalRecoveryPhase>([
    "retirement-decided",
    "gate-closed",
    "work-settled",
    "flushed",
    "final-checkpoint-verified",
    "cleanup-complete",
  ]).has(phase);
}

function assertCurrentRemovalLifecycle(
  lifecycle: DeviceAdministrationCurrentRemovalLifecycleSnapshot,
): void {
  if (lifecycle.kind !== "current-device-removal") {
    throw new TypeError("Current removal lifecycle kind is invalid");
  }
  const migrationOnly = lifecycle.phase === "transfer-committed";
  const recoveryOnly = new Set<DeviceAdministrationCurrentRemovalLifecyclePhase>([
    "checkpoint-verified",
    "retirement-decided",
    "gate-closed",
    "work-settled",
    "flushed",
    "final-checkpoint-verified",
  ]).has(lifecycle.phase);
  if (
    (migrationOnly && lifecycle.path !== "migration") ||
    (recoveryOnly && lifecycle.path !== "recovery-backup")
  ) {
    throw new TypeError("Current removal lifecycle phase does not match its path");
  }
}

function assertCurrentRemovalCancellationEligible(
  lifecycle: DeviceAdministrationCurrentRemovalLifecycleSnapshot,
): void {
  assertCurrentRemovalLifecycle(lifecycle);
  if (lifecycle.phase === "aborted") {
    throw new TypeError("Lifecycle aborted conflicts with replay");
  }
  if (lifecycle.phase === "terminal") {
    throw new TypeError("Terminal lifecycle operation cannot advance");
  }
  if (
    lifecycle.phase === "transfer-committed" ||
    lifecycle.phase === "retirement-decided" ||
    lifecycle.phase === "gate-closed" ||
    lifecycle.phase === "work-settled" ||
    lifecycle.phase === "flushed" ||
    lifecycle.phase === "final-checkpoint-verified" ||
    lifecycle.phase === "cleanup-complete"
  ) {
    throw new TypeError("Irreversible lifecycle operation cannot be aborted");
  }
}

function requireStableText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function dutyMigrationIdentity(input: {
  readonly requestId: string;
  readonly transferId: string;
}): { readonly requestId: string; readonly transferId: string } {
  return Object.freeze({
    requestId: requireStableText(input.requestId, "Migration request id"),
    transferId: requireStableText(input.transferId, "Migration transfer id"),
  });
}
