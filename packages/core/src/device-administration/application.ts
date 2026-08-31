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

export type DeviceAdministrationQuery =
  | DeviceAdministrationListQuery
  | DeviceAdministrationStatusQuery
  | DeviceAdministrationDutyMigrationTargetsQuery;

export interface DeviceAdministrationListResult {
  readonly devices: readonly DeviceAdministrationRelationship[];
}

export interface DeviceAdministrationStatusResult {
  readonly state: DeviceAdministrationRemovalState | null;
}

export interface DeviceAdministrationDutyMigrationTargetsResult {
  readonly devices: readonly DeviceAdministrationDutyMigrationTarget[];
}

export type DeviceAdministrationResult =
  | DeviceAdministrationListResult
  | DeviceAdministrationStatusResult
  | DeviceAdministrationDutyMigrationTargetsResult;

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

export type DeviceAdministrationCommand =
  | DeviceAdministrationBeginRemovalCommand
  | DeviceAdministrationContinueRemovalCommand
  | DeviceAdministrationPrepareDutyMigrationCommand
  | DeviceAdministrationCommitDutyMigrationCommand
  | DeviceAdministrationCancelDutyMigrationCommand;

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
  | DeviceAdministrationCancelDutyMigrationResult;

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
}

export interface DeviceAdministrationApplication {
  query(query: DeviceAdministrationListQuery): Promise<DeviceAdministrationListResult>;
  query(query: DeviceAdministrationStatusQuery): Promise<DeviceAdministrationStatusResult>;
  query(
    query: DeviceAdministrationDutyMigrationTargetsQuery,
  ): Promise<DeviceAdministrationDutyMigrationTargetsResult>;
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

export const DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    DEVICE_ADMINISTRATION_LIST_QUERY,
    DEVICE_ADMINISTRATION_STATUS_QUERY,
    DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY,
    DEVICE_ADMINISTRATION_BEGIN_REMOVAL_COMMAND,
    DEVICE_ADMINISTRATION_CONTINUE_REMOVAL_COMMAND,
    DEVICE_ADMINISTRATION_PREPARE_DUTY_MIGRATION_COMMAND,
    DEVICE_ADMINISTRATION_COMMIT_DUTY_MIGRATION_COMMAND,
    DEVICE_ADMINISTRATION_CANCEL_DUTY_MIGRATION_COMMAND,
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
