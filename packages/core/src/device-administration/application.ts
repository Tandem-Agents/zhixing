import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";

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
  readonly currentOwnerReady: boolean;
  readonly deviceRemovalInProgress: boolean;
  readonly members: readonly DeviceAdministrationDutyMigrationMember[];
}

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

export interface DeviceAdministrationDutyMigrationContextReadPort {
  read(): DeviceAdministrationDutyMigrationContext;
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
  readonly executorRemovalInProgress: boolean;
}

export interface DeviceAdministrationCurrentRemovalContextReadPort {
  read(): Promise<DeviceAdministrationCurrentRemovalContext>;
}

export interface DeviceAdministrationCurrentRemovalMigrationTarget {
  readonly deviceId: string;
  readonly displayName: string;
  readonly ready: boolean;
}

export interface DeviceAdministrationCurrentRemovalMigrationTargetReadPort {
  list(): Promise<readonly DeviceAdministrationCurrentRemovalMigrationTarget[]>;
}

export interface DeviceAdministrationCurrentRemovalRecoveryBackupStatus {
  readonly state: "not-configured" | "pending-verification" | "recoverable" | "unavailable";
  readonly fullBackupReady: boolean;
  readonly checkpointId?: string;
  readonly targetId?: string;
  readonly upToLsn?: number;
}

export interface DeviceAdministrationCurrentRemovalRecoveryBackupReadPort {
  read(): Promise<DeviceAdministrationCurrentRemovalRecoveryBackupStatus>;
}

/** Temporary one-way mechanism bridge to the existing durable uninstall coordinator. */
export interface DeviceAdministrationCurrentRemovalMechanismPort {
  beginMigration(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot>;
  beginRecoveryBackup(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly recoveryPackage: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot>;
  continue(input: {
    readonly operationId: string;
    readonly confirmBackup: true;
    readonly recoveryPackage: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot>;
  abort(input: {
    readonly operationId: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot>;
  read(input: {
    readonly operationId: string;
  }): Promise<DeviceAdministrationCurrentRemovalLifecycleSnapshot | undefined>;
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

/** Physical reachability and target effects; it makes no product decision. */
export interface DeviceAdministrationRemovalEffectPort<Accepted, Abort> {
  isConnected(targetDeviceId: string): boolean;
  accept(input: {
    readonly targetDeviceId: string;
    readonly accepted: Accepted;
  }): Promise<DeviceAdministrationBeginRemovalResult>;
  abort(input: {
    readonly targetDeviceId: string;
    readonly operationId: string;
    readonly abort: Abort;
  }): Promise<DeviceAdministrationRemovalState>;
  decide(input: {
    readonly targetDeviceId: string;
    readonly operationId: string;
    readonly mode: "transfer" | "destroy";
    readonly currentDutyDeviceId: string;
  }): Promise<DeviceAdministrationRemovalState>;
}

export interface DeviceAdministrationApplicationOptions<Accepted, Abort> {
  readonly relationships: DeviceAdministrationRelationshipReadPort;
  readonly removalState: DeviceAdministrationRemovalStateReadPort;
  readonly dutyMigrationTargets: DeviceAdministrationDutyMigrationTargetReadPort;
  readonly removalContext: DeviceAdministrationRemovalContextReadPort;
  readonly removalAuthority: DeviceAdministrationRemovalAuthorityPort<Accepted, Abort>;
  readonly removalEffects: DeviceAdministrationRemovalEffectPort<Accepted, Abort>;
  readonly dutyMigrationContext: DeviceAdministrationDutyMigrationContextReadPort;
  readonly dutyMigration: DeviceAdministrationDutyMigrationPort;
  readonly currentRemovalContext?: DeviceAdministrationCurrentRemovalContextReadPort;
  readonly currentRemovalMigrationTargets?:
    DeviceAdministrationCurrentRemovalMigrationTargetReadPort;
  readonly currentRemovalRecoveryBackup?: DeviceAdministrationCurrentRemovalRecoveryBackupReadPort;
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
    if (!this.options.removalEffects.isConnected(targetDeviceId)) {
      return freezeBeginRemovalResult({ conversations: [], hasAcceptedWork: false });
    }
    return freezeBeginRemovalResult(
      await this.options.removalEffects.accept({ targetDeviceId, accepted }),
    );
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
      if (this.options.removalEffects.isConnected(targetDeviceId)) {
        return freezeRemovalState(await this.options.removalEffects.abort({
          targetDeviceId,
          operationId,
          abort,
        }));
      }
      return freezeRemovalState({
        phase: "waiting-for-device",
        conversations: [],
        localData: "known",
        credentialActions: ["取消已安全记录；目标设备上线后会自动恢复准入"],
      });
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
    if (!this.options.removalEffects.isConnected(targetDeviceId)) {
      throw new Error(
        "The device is offline; choose lost-device revocation or wait for it to reconnect",
      );
    }
    return freezeRemovalState(await this.options.removalEffects.decide({
      targetDeviceId,
      operationId,
      mode: command.mode,
      currentDutyDeviceId: context.currentDutyDeviceId,
    }));
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
    const context = this.options.dutyMigrationContext.read();
    if (!context.currentOwnerReady) {
      throw new Error("Current duty device is completing its durable migration consumers");
    }
    if (!allowDuringDeviceRemoval && context.deviceRemovalInProgress) {
      throw new Error("Duty-device migration is unavailable while a paired device is being removed");
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
    const port = this.#currentDeviceRemoval();
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
      lifecycle = await port.beginMigration({
        requestId,
        operationId,
        transferId,
        targetDeviceId: requireStableText(matches[0]!.deviceId, "Duty device id"),
      });
    } else if (command.path === "recovery-backup") {
      lifecycle = await port.beginRecoveryBackup({
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
    const contextPort = this.options.currentRemovalContext;
    const migrationTargetsPort = this.options.currentRemovalMigrationTargets;
    const recoveryBackupPort = this.options.currentRemovalRecoveryBackup;
    if (!contextPort || !migrationTargetsPort || !recoveryBackupPort) {
      throw this.#currentRemovalUnavailable();
    }
    const context = await contextPort.read();
    if (
      context.currentDutyDeviceId !== context.localDeviceId ||
      context.currentDutyIssuerKeyId !== context.localIssuerKeyId
    ) {
      throw new Error("Only the current duty device can uninstall itself");
    }
    if (context.executorRemovalInProgress) {
      throw new Error("Finish the current device removal before uninstalling this device");
    }
    const migrationTargets = Object.freeze(
      (await migrationTargetsPort.list()).map((target) => Object.freeze({
        deviceId: target.deviceId,
        displayName: target.displayName,
        ready: target.ready,
      })),
    );
    const backup = await recoveryBackupPort.read();
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
    return projectCurrentRemovalState(await this.#currentDeviceRemoval().continue({
      operationId: requireStableText(command.operationId, "Uninstall operation id"),
      confirmBackup: true,
      recoveryPackage: requireStableText(command.recoveryPackage, "Recovery package"),
    }));
  }

  async #cancelCurrentRemoval(
    command: DeviceAdministrationCancelCurrentRemovalCommand,
  ): Promise<DeviceAdministrationCurrentRemovalState> {
    const operationId = requireStableText(command.operationId, "Uninstall operation id");
    const port = this.#currentDeviceRemoval();
    const lifecycle = await port.read({ operationId });
    if (!lifecycle) throw new Error("Anchor uninstall operation is unknown");
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
