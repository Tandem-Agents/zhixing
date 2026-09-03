import type {
  BackupRecoveryCurrentRemovalBinding,
} from "../backup-recovery/application.js";
import { protocolDigest } from "../protocol/index.js";
import type {
  AnchorUninstallLifecycleIdentity,
  DeviceLifecycleAbort,
  DeviceLifecycleEvidenceRef,
  DeviceLifecycleIdentity,
  DeviceLifecycleOperation,
  DeviceLifecyclePhase,
  UnsignedDeviceLifecycleAbort,
} from "../protocol/index.js";
import type {
  DeviceAdministrationCurrentRemovalAdmissionPort,
  DeviceAdministrationCurrentRemovalLifecyclePhase,
  DeviceAdministrationCurrentRemovalLifecycleSnapshot,
  DeviceAdministrationCurrentRemovalMechanismPort,
  DeviceAdministrationCurrentRemovalMigrationLifecycleOperation,
  DeviceAdministrationCurrentRemovalMigrationLifecyclePort,
  DeviceAdministrationCurrentRemovalMigrationPhase,
  DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation,
  DeviceAdministrationCurrentRemovalRecoveryLifecyclePort,
} from "./application.js";

export interface DeviceAdministrationCurrentRemovalAuthorityBindingFacts {
  readonly homeId: string;
  readonly anchorEpoch: number;
  readonly trustHeadDigest: string;
}

export interface DeviceAdministrationCurrentRemovalAuthorityFacts
  extends DeviceAdministrationCurrentRemovalAuthorityBindingFacts {
  readonly localDeviceId: string;
  readonly currentDutyDeviceId: string;
  readonly localIssuerKeyId: string;
  readonly currentDutyIssuerKeyId: string;
  readonly currentDeviceName?: string;
  readonly executorRemovalInProgress: boolean;
}

/** Maps current physical Authority and lifecycle state to one domain admission snapshot. */
export function createDeviceAdministrationCurrentRemovalAdmissionPort(options: {
  readonly readAuthority: () => Promise<DeviceAdministrationCurrentRemovalAuthorityFacts>;
}): DeviceAdministrationCurrentRemovalAdmissionPort {
  return Object.freeze({
    read: async () => {
      const authority = await options.readAuthority();
      return Object.freeze({
        context: Object.freeze({
          localDeviceId: authority.localDeviceId,
          currentDutyDeviceId: authority.currentDutyDeviceId,
          localIssuerKeyId: authority.localIssuerKeyId,
          currentDutyIssuerKeyId: authority.currentDutyIssuerKeyId,
          ...(authority.currentDeviceName
            ? { currentDeviceName: authority.currentDeviceName }
            : {}),
        }),
        outcome: Object.freeze({
          kind: authority.executorRemovalInProgress
            ? "paired-device-removal" as const
            : "allowed" as const,
        }),
      });
    },
  });
}

/** Physical current-Authority fence mapped to the opaque binding consumed by both domains. */
export interface DeviceAdministrationCurrentRemovalRecoveryBindingPort {
  create(input: {
    readonly authority: DeviceAdministrationCurrentRemovalAuthorityBindingFacts;
    readonly checkpointTargetId: string;
    readonly rootKeyId: string;
    readonly recipientKeyId: string;
  }): BackupRecoveryCurrentRemovalBinding;
  assertCurrent(input: {
    readonly authority: DeviceAdministrationCurrentRemovalAuthorityBindingFacts;
    readonly binding: BackupRecoveryCurrentRemovalBinding;
    readonly rootKeyId: string;
    readonly recipientKeyId: string;
  }): void;
  assertAuthorityCurrent(input: {
    readonly authority: DeviceAdministrationCurrentRemovalAuthorityBindingFacts;
    readonly binding: BackupRecoveryCurrentRemovalBinding;
  }): void;
  restore(identity: AnchorUninstallLifecycleIdentity): BackupRecoveryCurrentRemovalBinding;
}

export function createDeviceAdministrationCurrentRemovalRecoveryBindingPort():
  DeviceAdministrationCurrentRemovalRecoveryBindingPort {
  const port: DeviceAdministrationCurrentRemovalRecoveryBindingPort = {
    create: (input) => recoveryBinding({
      authority: input.authority,
      checkpointTargetId: input.checkpointTargetId,
      rootKeyId: input.rootKeyId,
      recipientKeyId: input.recipientKeyId,
    }),
    assertCurrent: (input) => {
      const expected = recoveryBinding({
        authority: input.authority,
        checkpointTargetId: input.binding.checkpointTargetId,
        rootKeyId: input.rootKeyId,
        recipientKeyId: input.recipientKeyId,
      });
      if (
        expected.acceptedRecoveryBinding !== input.binding.acceptedRecoveryBinding ||
        expected.checkpointBinding !== input.binding.checkpointBinding
      ) {
        throw new Error("Recovery package changes the accepted uninstall generation");
      }
    },
    assertAuthorityCurrent: (input) => {
      const authority = input.authority;
      if (
        currentAuthorityBinding(authority) !== input.binding.acceptedRecoveryBinding
      ) {
        throw new Error("Recovery package changes the accepted uninstall generation");
      }
    },
    restore: (identity) => Object.freeze({
      checkpointTargetId: identity.path.kind === "recovery-backup"
        ? identity.path.checkpointTargetId
        : invalidRecoveryPath(),
      acceptedRecoveryBinding: currentAuthorityBinding(identity),
      checkpointBinding: identity.path.kind === "recovery-backup"
        ? identity.path.checkpointGeneration
        : invalidRecoveryPath(),
    }),
  };
  return Object.freeze(port);
}

export interface DeviceAdministrationCurrentRemovalJournalPort {
  state(operationId: string): Promise<DeviceLifecycleOperation | undefined>;
  active(): Promise<readonly DeviceLifecycleOperation[]>;
  accept(identity: DeviceLifecycleIdentity): Promise<DeviceLifecycleOperation>;
  advance(
    operationId: string,
    phase: Exclude<DeviceLifecyclePhase, "accepted" | "terminal" | "aborted">,
    evidence?: readonly DeviceLifecycleEvidenceRef[],
  ): Promise<DeviceLifecycleOperation>;
  abort(
    operationId: string,
    abort: DeviceLifecycleAbort,
  ): Promise<DeviceLifecycleOperation>;
  terminal(
    operationId: string,
    outcome: "stopped" | "removed" | "retired",
    evidence?: readonly DeviceLifecycleEvidenceRef[],
  ): Promise<DeviceLifecycleOperation>;
}

export function createDeviceAdministrationCurrentRemovalMigrationLifecyclePort(options: {
  readonly journal: DeviceAdministrationCurrentRemovalJournalPort;
  readonly readAuthority: () => Promise<DeviceAdministrationCurrentRemovalAuthorityFacts>;
}): DeviceAdministrationCurrentRemovalMigrationLifecyclePort<DeviceLifecycleEvidenceRef> {
  const port: DeviceAdministrationCurrentRemovalMigrationLifecyclePort<
    DeviceLifecycleEvidenceRef
  > = {
    accept: async (input) => {
      const authority = assertCurrentAuthority(await options.readAuthority());
      return migrationOperation(await options.journal.accept(Object.freeze({
        v: 1,
        kind: "anchor-uninstall",
        requestId: input.requestId,
        operationId: input.operationId,
        homeId: authority.homeId,
        currentDeviceId: authority.localDeviceId,
        anchorEpoch: authority.anchorEpoch,
        trustHeadDigest: authority.trustHeadDigest,
        path: Object.freeze({
          kind: "migration" as const,
          targetDeviceId: input.targetDeviceId,
          transferId: input.transferId,
        }),
      })));
    },
    active: async () => Object.freeze((await options.journal.active())
      .filter(isMigrationOperation)
      .map(migrationOperation)),
    advance: async (input) => migrationOperation(await options.journal.advance(
      (await requireMigrationOperation(options.journal, input.operationId)).identity.operationId,
      input.phase,
      input.evidence,
    )),
    terminal: async (operationId) => {
      const operation = await requireMigrationOperation(options.journal, operationId);
      return migrationOperation(await options.journal.terminal(
        operation.identity.operationId,
        "retired",
        operation.evidence,
      ));
    },
  };
  return Object.freeze(port);
}

export function createDeviceAdministrationCurrentRemovalRecoveryLifecyclePort(options: {
  readonly journal: DeviceAdministrationCurrentRemovalJournalPort;
  readonly readAuthority: () => Promise<DeviceAdministrationCurrentRemovalAuthorityFacts>;
  readonly binding: DeviceAdministrationCurrentRemovalRecoveryBindingPort;
  readonly commitRetirement: (input: {
    readonly identity: AnchorUninstallLifecycleIdentity;
    readonly acceptedWork: DeviceLifecycleEvidenceRef;
  }) => Promise<void>;
  readonly phaseLsn: (input: {
    readonly operationId: string;
    readonly phase: "flushed";
  }) => Promise<number>;
}): DeviceAdministrationCurrentRemovalRecoveryLifecyclePort<DeviceLifecycleEvidenceRef> {
  const port: DeviceAdministrationCurrentRemovalRecoveryLifecyclePort<
    DeviceLifecycleEvidenceRef
  > = {
    assertBeginAdmission: async () => {
      const authority = assertCurrentAuthority(await options.readAuthority());
      if (authority.executorRemovalInProgress) {
        throw new Error("Finish the current device removal before uninstalling this device");
      }
    },
    assertCurrentAuthority: async () => {
      assertCurrentAuthority(await options.readAuthority());
    },
    accept: async (input) => {
      const authority = assertCurrentAuthority(await options.readAuthority());
      if (authority.executorRemovalInProgress) {
        throw new Error("Finish the current device removal before uninstalling this device");
      }
      options.binding.assertAuthorityCurrent({ authority, binding: input.binding });
      return recoveryOperation(await options.journal.accept(Object.freeze({
        v: 1,
        kind: "anchor-uninstall",
        requestId: input.requestId,
        operationId: input.operationId,
        homeId: authority.homeId,
        currentDeviceId: authority.localDeviceId,
        anchorEpoch: authority.anchorEpoch,
        trustHeadDigest: authority.trustHeadDigest,
        path: Object.freeze({
          kind: "recovery-backup" as const,
          checkpointTargetId: input.binding.checkpointTargetId,
          checkpointGeneration: input.binding.checkpointBinding,
        }),
      })), options.binding);
    },
    state: async (operationId) => {
      const operation = await options.journal.state(operationId);
      return operation && isRecoveryOperation(operation)
        ? recoveryOperation(operation, options.binding)
        : undefined;
    },
    active: async () => Object.freeze((await options.journal.active())
      .filter(isRecoveryOperation)
      .map((operation) => recoveryOperation(operation, options.binding))),
    advance: async (input) => recoveryOperation(
      await options.journal.advance(
        (await requireRecoveryOperation(options.journal, input.operationId)).identity.operationId,
        input.phase,
        input.evidence,
      ),
      options.binding,
    ),
    commitRetirement: async (input) => {
      const operation = await requireRecoveryOperation(options.journal, input.operationId);
      await options.commitRetirement({
        identity: operation.identity,
        acceptedWork: input.acceptedWork,
      });
      return recoveryOperation(
        await requireRecoveryOperation(options.journal, input.operationId),
        options.binding,
      );
    },
    phaseLsn: options.phaseLsn,
    terminal: async (operationId) => {
      const operation = await requireRecoveryOperation(options.journal, operationId);
      return recoveryOperation(
        await options.journal.terminal(
          operation.identity.operationId,
          "retired",
          operation.evidence,
        ),
        options.binding,
      );
    },
  };
  return Object.freeze(port);
}

export function createDeviceAdministrationCurrentRemovalMechanismPort(options: {
  readonly journal: DeviceAdministrationCurrentRemovalJournalPort;
  readonly signAbort: (input: UnsignedDeviceLifecycleAbort) => DeviceLifecycleAbort;
  readonly releaseAdmission: (operationId: string) => void | Promise<void>;
  readonly now?: () => string;
}): DeviceAdministrationCurrentRemovalMechanismPort {
  const port: DeviceAdministrationCurrentRemovalMechanismPort = {
    abort: async ({ operationId }) => {
      const operation = await requireCurrentRemovalOperation(options.journal, operationId);
      const abort = options.signAbort({
        v: 1,
        operationId,
        homeId: operation.identity.homeId,
        subjectDeviceId: operation.identity.currentDeviceId,
        authorizedByDeviceId: operation.identity.currentDeviceId,
        reason: "user-cancelled",
        at: options.now?.() ?? new Date().toISOString(),
      });
      const aborted = await options.journal.abort(operationId, abort);
      await options.releaseAdmission(operationId);
      return lifecycleSnapshot(aborted);
    },
    read: async ({ operationId }) => {
      const operation = await options.journal.state(operationId);
      return operation && operation.identity.kind === "anchor-uninstall"
        ? lifecycleSnapshot(operation)
        : undefined;
    },
  };
  return Object.freeze(port);
}

export function assertDeviceAdministrationRetirementAuthority(input: {
  readonly currentDeviceId: string;
  readonly acceptedTrustHeadDigest: string;
  readonly currentDutyDeviceId: string;
  readonly currentTrustHeadDigest: string;
}): void {
  if (
    input.currentDutyDeviceId !== input.currentDeviceId ||
    input.currentTrustHeadDigest !== input.acceptedTrustHeadDigest
  ) {
    throw new Error("Current authority changed before anchor retirement");
  }
}

function assertCurrentAuthority(
  facts: DeviceAdministrationCurrentRemovalAuthorityFacts,
): DeviceAdministrationCurrentRemovalAuthorityFacts {
  if (
    facts.currentDutyDeviceId !== facts.localDeviceId ||
    facts.currentDutyIssuerKeyId !== facts.localIssuerKeyId
  ) {
    throw new Error("Only the current duty device can uninstall itself");
  }
  return facts;
}

function recoveryBinding(input: {
  readonly authority: Pick<
    DeviceAdministrationCurrentRemovalAuthorityFacts,
    "homeId" | "anchorEpoch" | "trustHeadDigest"
  >;
  readonly checkpointTargetId: string;
  readonly rootKeyId: string;
  readonly recipientKeyId: string;
}): BackupRecoveryCurrentRemovalBinding {
  return Object.freeze({
    checkpointTargetId: input.checkpointTargetId,
    acceptedRecoveryBinding: currentAuthorityBinding(input.authority),
    checkpointBinding: protocolDigest("AnchorUninstallCheckpointGeneration", 1, {
      homeId: input.authority.homeId,
      anchorEpoch: input.authority.anchorEpoch,
      trustHeadDigest: input.authority.trustHeadDigest,
      targetId: input.checkpointTargetId,
      rootKeyId: input.rootKeyId,
      recipientKeyId: input.recipientKeyId,
    }),
  });
}

function currentAuthorityBinding(authority: Pick<
  DeviceAdministrationCurrentRemovalAuthorityFacts,
  "homeId" | "anchorEpoch" | "trustHeadDigest"
>): string {
  return protocolDigest("AnchorUninstallAcceptedRecoveryBinding", 1, {
    homeId: authority.homeId,
    anchorEpoch: authority.anchorEpoch,
    trustHeadDigest: authority.trustHeadDigest,
  });
}

function invalidRecoveryPath(): never {
  throw new TypeError("Anchor recovery binding requires a recovery-backup operation");
}

function isMigrationOperation(operation: DeviceLifecycleOperation): boolean {
  return operation.identity.kind === "anchor-uninstall" &&
    operation.identity.path.kind === "migration";
}

function isRecoveryOperation(
  operation: DeviceLifecycleOperation,
): operation is DeviceLifecycleOperation & { readonly identity: AnchorUninstallLifecycleIdentity } {
  return operation.identity.kind === "anchor-uninstall" &&
    operation.identity.path.kind === "recovery-backup";
}

async function requireCurrentRemovalOperation(
  journal: DeviceAdministrationCurrentRemovalJournalPort,
  operationId: string,
): Promise<DeviceLifecycleOperation & { readonly identity: AnchorUninstallLifecycleIdentity }> {
  const operation = await journal.state(operationId);
  if (!operation || !isCurrentRemovalOperation(operation)) {
    throw new Error("Anchor uninstall operation is unknown");
  }
  return operation;
}

function isCurrentRemovalOperation(
  operation: DeviceLifecycleOperation,
): operation is DeviceLifecycleOperation & { readonly identity: AnchorUninstallLifecycleIdentity } {
  return operation.identity.kind === "anchor-uninstall";
}

async function requireMigrationOperation(
  journal: DeviceAdministrationCurrentRemovalJournalPort,
  operationId: string,
): Promise<DeviceLifecycleOperation & { readonly identity: AnchorUninstallLifecycleIdentity }> {
  const operation = await requireCurrentRemovalOperation(journal, operationId);
  if (operation.identity.path.kind !== "migration") {
    throw new Error("Anchor uninstall path is not a migration");
  }
  return operation;
}

async function requireRecoveryOperation(
  journal: DeviceAdministrationCurrentRemovalJournalPort,
  operationId: string,
): Promise<DeviceLifecycleOperation & { readonly identity: AnchorUninstallLifecycleIdentity }> {
  const operation = await requireCurrentRemovalOperation(journal, operationId);
  if (operation.identity.path.kind !== "recovery-backup") {
    throw new Error("Anchor uninstall path is not recovery backup");
  }
  return operation;
}

function migrationOperation(
  operation: DeviceLifecycleOperation,
): DeviceAdministrationCurrentRemovalMigrationLifecycleOperation {
  if (!isMigrationOperation(operation) || operation.identity.kind !== "anchor-uninstall" ||
    operation.identity.path.kind !== "migration") {
    throw new TypeError("Anchor migration lifecycle requires a migration operation");
  }
  return Object.freeze({
    kind: "current-device-removal",
    path: "migration",
    requestId: operation.identity.requestId,
    operationId: operation.identity.operationId,
    transferId: operation.identity.path.transferId,
    targetDeviceId: operation.identity.path.targetDeviceId,
    phase: migrationPhase(operation.phase),
  });
}

function migrationPhase(
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

function recoveryOperation(
  operation: DeviceLifecycleOperation,
  binding: DeviceAdministrationCurrentRemovalRecoveryBindingPort,
): DeviceAdministrationCurrentRemovalRecoveryLifecycleOperation {
  if (!isRecoveryOperation(operation) || operation.identity.path.kind !== "recovery-backup") {
    throw new TypeError("Anchor recovery lifecycle requires a recovery-backup operation");
  }
  return Object.freeze({
    kind: "current-device-removal",
    path: "recovery-backup",
    requestId: operation.identity.requestId,
    operationId: operation.identity.operationId,
    binding: binding.restore(operation.identity),
    phase: recoveryPhase(operation.phase),
  });
}

function recoveryPhase(
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

function lifecycleSnapshot(
  operation: DeviceLifecycleOperation,
): DeviceAdministrationCurrentRemovalLifecycleSnapshot {
  if (operation.identity.kind !== "anchor-uninstall") {
    throw new TypeError("Anchor uninstall lifecycle snapshot requires an anchor operation");
  }
  return Object.freeze({
    kind: "current-device-removal",
    path: operation.identity.path.kind,
    phase: lifecyclePhase(operation.phase),
  });
}

function lifecyclePhase(
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
