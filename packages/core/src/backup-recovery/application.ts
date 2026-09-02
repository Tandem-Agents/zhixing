export type BackupRecoveryAdministrationTargetSelection =
  | { readonly kind: "directory"; readonly directory: string }
  | {
      readonly kind: "paired-device";
      readonly displayName: string;
    };

export type BackupRecoveryAdministrationTargetBinding =
  | {
      readonly kind: "directory";
      readonly targetId: string;
      readonly directory: string;
    }
  | {
      readonly kind: "paired-device";
      readonly targetId: string;
      readonly deviceId: string;
    };

export interface BackupRecoveryAdministrationPairedDevice {
  readonly deviceId: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly current: boolean;
}

export type BackupRecoveryAdministrationRootState =
  | { readonly kind: "missing" }
  | {
      readonly kind: "established";
      readonly recipientKeyId: string;
      readonly checkpointRevision: string;
    };

export interface BackupRecoveryAdministrationTargetConfiguration {
  readonly currentTargetId: string;
  readonly bindings: readonly BackupRecoveryAdministrationTargetBinding[];
}

export interface BackupRecoveryAdministrationVerificationCandidate {
  readonly checkpointId: string;
  readonly targetId: string;
}

export type BackupRecoveryPublicStatus =
  | {
      readonly state: "not-configured";
      readonly fullBackupReady: false;
      readonly nextAction: "run-backup-setup";
    }
  | {
      readonly state: "pending-verification";
      readonly fullBackupReady: false;
      readonly nextAction: "run-backup-verify";
    }
  | {
      readonly state: "recoverable";
      readonly fullBackupReady: true;
    }
  | {
      readonly state: "unavailable";
      readonly fullBackupReady: boolean;
      readonly nextAction:
        | "repair-backup-configuration"
        | "restore-backup-connection"
        | "check-backup-target";
    };

export type BackupRecoveryAdministrationStatus =
  | BackupRecoveryPublicStatus
  | {
      readonly state: "configured-empty";
      readonly fullBackupReady: false;
      readonly nextAction: "run-backup-setup";
    };

export interface BackupRecoveryPublicStatusSource {
  readonly state: "not-configured" | "pending-verification" | "recoverable" | "unavailable";
  readonly fullBackupReady: boolean;
  readonly code?: "configuration-invalid" | "runtime-unavailable" | "target-unavailable";
}

/** Domain-owned projection shared by backup status surfaces; mechanisms only report raw state. */
export function projectBackupRecoveryPublicStatus(
  status: BackupRecoveryPublicStatusSource,
): BackupRecoveryPublicStatus {
  switch (status.state) {
    case "recoverable":
      return Object.freeze({ state: "recoverable", fullBackupReady: true });
    case "pending-verification":
      return Object.freeze({
        state: "pending-verification",
        fullBackupReady: false,
        nextAction: "run-backup-verify",
      });
    case "unavailable":
      return Object.freeze({
        state: "unavailable",
        fullBackupReady: status.fullBackupReady,
        nextAction: projectUnavailableBackupAction(status.code),
      });
    case "not-configured":
      return Object.freeze({
        state: "not-configured",
        fullBackupReady: false,
        nextAction: "run-backup-setup",
      });
  }
}

function projectUnavailableBackupAction(
  code: BackupRecoveryPublicStatusSource["code"],
): Extract<BackupRecoveryPublicStatus, { readonly state: "unavailable" }>["nextAction"] {
  switch (code) {
    case "configuration-invalid":
      return "repair-backup-configuration";
    case "runtime-unavailable":
      return "restore-backup-connection";
    case "target-unavailable":
      return "check-backup-target";
    default:
      throw new TypeError("Backup recovery unavailable reason is invalid");
  }
}

export type BackupRecoveryAdministrationSetupResult =
  | { readonly kind: "initial-root-established" }
  | { readonly kind: "legacy-root-established" }
  | { readonly kind: "checkpoint-created"; readonly checkpointId: string };

export type BackupRecoveryAdministrationErrorCode =
  | "duplicate-paired-device-name"
  | "invalid-paired-device"
  | "missing-recipient-identity"
  | "target-not-configured"
  | "current-target-binding-missing"
  | "verification-candidate-missing"
  | "verification-target-binding-missing"
  | "recovery-root-missing";

export class BackupRecoveryAdministrationError extends Error {
  readonly name = "BackupRecoveryAdministrationError";

  constructor(readonly code: BackupRecoveryAdministrationErrorCode) {
    super(code);
  }
}

export interface BackupRecoveryAdministrationMechanismPort<PreparedRoot, Target, RecoveryPackage> {
  listPairedDevices(): Promise<readonly BackupRecoveryAdministrationPairedDevice[]>;
  readRootState(): Promise<BackupRecoveryAdministrationRootState>;
  prepareInitialRoot(): Promise<PreparedRoot>;
  preparedRootRecipientKeyId(prepared: PreparedRoot): string;
  selectTarget(binding: BackupRecoveryAdministrationTargetBinding): Promise<void>;
  withDirectoryTarget<Result>(
    directory: string,
    use: (
      binding: Extract<BackupRecoveryAdministrationTargetBinding, { readonly kind: "directory" }>,
      target: Target,
    ) => Promise<Result>,
  ): Promise<Result>;
  withSelectedTarget<Result>(
    binding: BackupRecoveryAdministrationTargetBinding,
    recipientKeyId: string,
    use: (target: Target) => Promise<Result>,
  ): Promise<Result>;
  replayRootActivation(
    binding: BackupRecoveryAdministrationTargetBinding,
    target: Target,
  ): Promise<void>;
  establishInitialRoot(prepared: PreparedRoot, target: Target): Promise<{
    readonly legacyTrustOnly: boolean;
  }>;
  activateInitialRoot(
    binding: BackupRecoveryAdministrationTargetBinding,
    prepared: PreparedRoot,
    target: Target,
  ): Promise<void>;
  createCheckpoint(target: Target, requestId: string): Promise<{ readonly checkpointId: string }>;
  loadTargetConfiguration(): Promise<BackupRecoveryAdministrationTargetConfiguration | undefined>;
  verificationCandidate(
    targetId: string,
  ): Promise<BackupRecoveryAdministrationVerificationCandidate | undefined>;
  readRecoveryPackage(): Promise<RecoveryPackage>;
  verifyCheckpoint(input: {
    readonly target: Target;
    readonly checkpointId: string;
    readonly recoveryPackage: RecoveryPackage;
  }): Promise<void>;
  readStatus(targetId: string): Promise<BackupRecoveryPublicStatusSource>;
}

export interface BackupRecoveryAdministrationApplication {
  setup(target: BackupRecoveryAdministrationTargetSelection): Promise<BackupRecoveryAdministrationSetupResult>;
  verify(): Promise<{ readonly checkpointId: string }>;
  status(): Promise<BackupRecoveryAdministrationStatus>;
}

/**
 * Owns the finite backup-target product decisions. Root rotation/reset and disaster recovery are
 * deliberately outside this application boundary.
 */
export class BackupRecoveryAdministrationApplicationService<PreparedRoot, Target, RecoveryPackage>
  implements BackupRecoveryAdministrationApplication
{
  constructor(
    private readonly mechanism:
      BackupRecoveryAdministrationMechanismPort<PreparedRoot, Target, RecoveryPackage>,
  ) {}

  async setup(
    selection: BackupRecoveryAdministrationTargetSelection,
  ): Promise<BackupRecoveryAdministrationSetupResult> {
    if (selection.kind === "directory") {
      const directory = requireNonEmpty(selection.directory, "Recovery backup directory");
      return this.mechanism.withDirectoryTarget(directory, async (binding, target) => {
        await this.mechanism.selectTarget(binding);
        const root = await this.mechanism.readRootState();
        if (root.kind === "established") {
          const checkpoint = await this.mechanism.createCheckpoint(
            target,
            `backup-setup:${binding.targetId}:${root.checkpointRevision}`,
          );
          return Object.freeze({
            kind: "checkpoint-created" as const,
            checkpointId: checkpoint.checkpointId,
          });
        }
        const prepared = await this.mechanism.prepareInitialRoot();
        const established = await this.mechanism.establishInitialRoot(prepared, target);
        return Object.freeze({
          kind: established.legacyTrustOnly
            ? "legacy-root-established" as const
            : "initial-root-established" as const,
        });
      });
    }

    const binding = await this.#resolvePairedTarget(selection);
    const root = await this.mechanism.readRootState();
    if (root.kind === "established") {
      await this.mechanism.selectTarget(binding);
      return this.mechanism.withSelectedTarget(binding, root.recipientKeyId, async (target) => {
        await this.mechanism.replayRootActivation(binding, target);
        const checkpoint = await this.mechanism.createCheckpoint(
          target,
          `backup-setup:${binding.targetId}:${root.checkpointRevision}`,
        );
        return Object.freeze({
          kind: "checkpoint-created" as const,
          checkpointId: checkpoint.checkpointId,
        });
      });
    }

    const prepared = await this.mechanism.prepareInitialRoot();
    const recipientKeyId = this.mechanism.preparedRootRecipientKeyId(prepared);
    if (!recipientKeyId) {
      throw new BackupRecoveryAdministrationError("missing-recipient-identity");
    }
    await this.mechanism.selectTarget(binding);
    return this.mechanism.withSelectedTarget(binding, recipientKeyId, async (target) => {
      const established = await this.mechanism.establishInitialRoot(prepared, target);
      await this.mechanism.activateInitialRoot(binding, prepared, target);
      return Object.freeze({
        kind: established.legacyTrustOnly
          ? "legacy-root-established" as const
          : "initial-root-established" as const,
      });
    });
  }

  async verify(): Promise<{ readonly checkpointId: string }> {
    const configured = await this.mechanism.loadTargetConfiguration();
    if (!configured) throw new BackupRecoveryAdministrationError("target-not-configured");
    const current = requireBinding(configured, configured.currentTargetId, "current");
    const candidate = await this.mechanism.verificationCandidate(current.targetId);
    if (!candidate) {
      throw new BackupRecoveryAdministrationError("verification-candidate-missing");
    }
    const binding = requireBinding(configured, candidate.targetId, "verification");
    const root = await this.mechanism.readRootState();
    if (root.kind !== "established") {
      throw new BackupRecoveryAdministrationError("recovery-root-missing");
    }
    await this.mechanism.withSelectedTarget(binding, root.recipientKeyId, async (target) => {
      const recoveryPackage = await this.mechanism.readRecoveryPackage();
      await this.mechanism.verifyCheckpoint({
        target,
        checkpointId: candidate.checkpointId,
        recoveryPackage,
      });
    });
    return Object.freeze({ checkpointId: candidate.checkpointId });
  }

  async status(): Promise<BackupRecoveryAdministrationStatus> {
    const configured = await this.mechanism.loadTargetConfiguration();
    if (!configured) {
      return projectBackupRecoveryPublicStatus({
        state: "not-configured",
        fullBackupReady: false,
      });
    }
    const binding = requireBinding(configured, configured.currentTargetId, "current");
    const status = projectBackupRecoveryPublicStatus(
      await this.mechanism.readStatus(binding.targetId),
    );
    if (status.state === "not-configured") {
      return Object.freeze({
        state: "configured-empty",
        fullBackupReady: false,
        nextAction: "run-backup-setup",
      });
    }
    return status;
  }

  async #resolvePairedTarget(
    selection: Extract<BackupRecoveryAdministrationTargetSelection, { readonly kind: "paired-device" }>,
  ): Promise<Extract<BackupRecoveryAdministrationTargetBinding, { readonly kind: "paired-device" }>> {
    const value = requireNonEmpty(selection.displayName, "Paired recovery backup device");
    const devices = await this.mechanism.listPairedDevices();
    const matches = devices.filter((device) =>
      device.active && device.displayName === value);
    if (matches.length > 1) {
      throw new BackupRecoveryAdministrationError("duplicate-paired-device-name");
    }
    const device = matches[0];
    if (!device || device.current) {
      throw new BackupRecoveryAdministrationError("invalid-paired-device");
    }
    return Object.freeze({
      kind: "paired-device",
      targetId: `backup-device:${device.deviceId}`,
      deviceId: device.deviceId,
    });
  }
}

export interface BackupRecoveryRootIdentity {
  readonly rootPublicKey: string;
  readonly backupPublicKey: string;
}

export interface BackupRecoveryRootLifecycleContext {
  readonly homeId: string;
  readonly trustEpoch: number;
  readonly chainHead: {
    readonly seq: number;
    readonly eventDigest: string;
  };
  readonly currentDeviceId: string;
  readonly issuerDeviceId: string;
  readonly issuerKeyId: string;
  readonly signerKeyId: string;
  readonly activeDeviceIds: readonly string[];
  readonly currentRoot?: BackupRecoveryRootIdentity;
}

export interface BackupRecoveryRootMaterial<Root> {
  readonly root: Root;
  readonly identity: BackupRecoveryRootIdentity;
}

export interface BackupRecoveryPreparedReplacementRoot<Root> {
  readonly generated: BackupRecoveryRootMaterial<Root>;
  readonly readBack: BackupRecoveryRootMaterial<Root>;
}

export interface BackupRecoveryRootResetApproval<Signature> {
  readonly v: 1;
  readonly homeId: string;
  readonly seq: number;
  readonly prevEventDigest: string;
  readonly trustEpoch: number;
  readonly at: string;
  readonly coSign: {
    readonly deviceId: string;
    readonly sig: Signature;
  };
}

export type BackupRecoveryRootActivationPlan<Event> =
  | {
      readonly v: 1;
      readonly kind: "rotate";
      readonly rootEvent: Event;
    }
  | {
      readonly v: 1;
      readonly kind: "domain-reset-establish";
      readonly resetEvent: Event;
      readonly rootEvent: Event;
    };

export interface BackupRecoveryRootIssuerSession<Root, Event, Checkpoint, Target, Signature> {
  readonly context: BackupRecoveryRootLifecycleContext;
  readCurrentPackage(): Promise<BackupRecoveryRootMaterial<Root>>;
  prepareReplacementRoot(): Promise<BackupRecoveryPreparedReplacementRoot<Root>>;
  createRotateEvent(input: {
    readonly currentRoot: Root;
    readonly candidateRoot: Root;
    readonly at: string;
  }): Event;
  createInvalidationEvent(input: {
    readonly currentRoot: Root;
    readonly at: string;
  }): Event;
  createResetEvents(input: {
    readonly approval: BackupRecoveryRootResetApproval<Signature>;
    readonly candidateRoot: Root;
    readonly at: string;
  }): { readonly resetEvent: Event; readonly rootEvent: Event };
  withCurrentTarget<Result>(
    candidateRoot: Root,
    use: (target: Target) => Promise<Result>,
  ): Promise<Result>;
  targetId(target: Target): string;
  captureCheckpoint(input: {
    readonly plan: BackupRecoveryRootActivationPlan<Event>;
    readonly candidateRoot: Root;
    readonly createdAt: string;
  }): Promise<Checkpoint>;
  currentCheckpointIds(targetId: string): Promise<readonly string[]>;
  activate(input: {
    readonly plan: BackupRecoveryRootActivationPlan<Event>;
    readonly candidateRoot: Root;
    readonly checkpoint: Checkpoint;
    readonly target: Target;
    readonly supersedeCheckpointIds: readonly string[];
  }): Promise<void>;
  commitInvalidation(event: Event): Promise<void>;
}

export interface BackupRecoveryRootApprovalSession<Signature> {
  readonly context: BackupRecoveryRootLifecycleContext;
  createApproval(at: string): BackupRecoveryRootResetApproval<Signature>;
}

export interface BackupRecoveryRootLifecycleMechanismPort<
  Root,
  Event,
  Checkpoint,
  Target,
  Signature,
> {
  now(): string;
  withIssuerSession<Result>(
    use: (
      session: BackupRecoveryRootIssuerSession<Root, Event, Checkpoint, Target, Signature>,
    ) => Promise<Result>,
  ): Promise<Result>;
  withApprovalSession<Result>(
    use: (session: BackupRecoveryRootApprovalSession<Signature>) => Promise<Result>,
  ): Promise<Result>;
}

export type BackupRecoveryRootLifecycleErrorCode =
  | "rotate-confirmation-required"
  | "invalidate-confirmation-required"
  | "approve-reset-confirmation-required"
  | "reset-confirmation-required"
  | "current-issuer-required"
  | "current-root-missing"
  | "reset-current-root-missing"
  | "current-package-mismatch"
  | "replacement-readback-mismatch"
  | "approval-generation-mismatch"
  | "approval-cosigner-ineligible"
  | "approval-cosigner-is-issuer";

export class BackupRecoveryRootLifecycleError extends Error {
  readonly name = "BackupRecoveryRootLifecycleError";

  constructor(readonly code: BackupRecoveryRootLifecycleErrorCode) {
    super(code);
  }
}

export type BackupRecoveryRootLifecycleOutcome<Signature> =
  | { readonly kind: "rotated" }
  | { readonly kind: "invalidated" }
  | {
      readonly kind: "reset-approved";
      readonly approval: BackupRecoveryRootResetApproval<Signature>;
    }
  | { readonly kind: "reset" };

export const BACKUP_RECOVERY_ROOT_LIFECYCLE_DESCRIPTOR = Object.freeze({
  owner: "backup-recovery",
  commands: Object.freeze(["rotate", "invalidate", "approve-reset", "reset"] as const),
  checkpointed: Object.freeze(["rotate", "reset"] as const),
});

export interface BackupRecoveryRootLifecycleApplication<Signature> {
  rotate(input: { readonly userConfirmed: boolean }): Promise<BackupRecoveryRootLifecycleOutcome<Signature>>;
  invalidate(input: { readonly userConfirmed: boolean }): Promise<BackupRecoveryRootLifecycleOutcome<Signature>>;
  approveReset(input: { readonly userConfirmed: boolean }): Promise<BackupRecoveryRootLifecycleOutcome<Signature>>;
  reset(input: {
    readonly userConfirmed: boolean;
    readonly decodeApproval: () => BackupRecoveryRootResetApproval<Signature>;
  }): Promise<BackupRecoveryRootLifecycleOutcome<Signature>>;
}

/** Sole owner of the public recovery-root lifecycle decisions and command progression. */
export class BackupRecoveryRootLifecycleApplicationService<
  Root,
  Event,
  Checkpoint,
  Target,
  Signature,
> implements BackupRecoveryRootLifecycleApplication<Signature> {
  constructor(private readonly mechanism:
    BackupRecoveryRootLifecycleMechanismPort<Root, Event, Checkpoint, Target, Signature>) {}

  async rotate(
    input: { readonly userConfirmed: boolean },
  ): Promise<BackupRecoveryRootLifecycleOutcome<Signature>> {
    if (!input.userConfirmed) {
      throw new BackupRecoveryRootLifecycleError("rotate-confirmation-required");
    }
    return this.mechanism.withIssuerSession(async (session) => {
      const context = freezeRootLifecycleContext(session.context);
      assertCurrentIssuer(context);
      const current = await session.readCurrentPackage();
      assertCurrentRoot(context, current.identity);
      const candidate = await session.prepareReplacementRoot();
      assertSameRoot(candidate.generated.identity, candidate.readBack.identity);
      const at = requireCanonicalTime(this.mechanism.now());
      const rootEvent = session.createRotateEvent({
        currentRoot: current.root,
        candidateRoot: candidate.readBack.root,
        at,
      });
      const plan = Object.freeze({
        v: 1 as const,
        kind: "rotate" as const,
        rootEvent,
      });
      await session.withCurrentTarget(candidate.readBack.root, async (target) => {
        const targetId = requireText(session.targetId(target), "Recovery target id");
        const checkpoint = await session.captureCheckpoint({
          plan,
          candidateRoot: candidate.readBack.root,
          createdAt: at,
        });
        const supersedeCheckpointIds = Object.freeze([
          ...await session.currentCheckpointIds(targetId),
        ]);
        await session.activate({
          plan,
          candidateRoot: candidate.readBack.root,
          checkpoint,
          target,
          supersedeCheckpointIds,
        });
      });
      return Object.freeze({ kind: "rotated" as const });
    });
  }

  async invalidate(
    input: { readonly userConfirmed: boolean },
  ): Promise<BackupRecoveryRootLifecycleOutcome<Signature>> {
    if (!input.userConfirmed) {
      throw new BackupRecoveryRootLifecycleError("invalidate-confirmation-required");
    }
    return this.mechanism.withIssuerSession(async (session) => {
      const context = freezeRootLifecycleContext(session.context);
      assertCurrentIssuer(context);
      const current = await session.readCurrentPackage();
      assertCurrentRoot(context, current.identity);
      const event = session.createInvalidationEvent({
        currentRoot: current.root,
        at: requireCanonicalTime(this.mechanism.now()),
      });
      await session.commitInvalidation(event);
      return Object.freeze({ kind: "invalidated" as const });
    });
  }

  async approveReset(
    input: { readonly userConfirmed: boolean },
  ): Promise<BackupRecoveryRootLifecycleOutcome<Signature>> {
    if (!input.userConfirmed) {
      throw new BackupRecoveryRootLifecycleError("approve-reset-confirmation-required");
    }
    return this.mechanism.withApprovalSession(async (session) => {
      const context = freezeRootLifecycleContext(session.context);
      assertEligibleCoSigner(context);
      const approval = freezeResetApproval(
        session.createApproval(requireCanonicalTime(this.mechanism.now())),
      );
      assertApprovalGeneration(context, approval);
      return Object.freeze({ kind: "reset-approved" as const, approval });
    });
  }

  async reset(input: {
    readonly userConfirmed: boolean;
    readonly decodeApproval: () => BackupRecoveryRootResetApproval<Signature>;
  }): Promise<BackupRecoveryRootLifecycleOutcome<Signature>> {
    if (!input.userConfirmed) {
      throw new BackupRecoveryRootLifecycleError("reset-confirmation-required");
    }
    const approval = freezeResetApproval(input.decodeApproval());
    return this.mechanism.withIssuerSession(async (session) => {
      const context = freezeRootLifecycleContext(session.context);
      assertCurrentIssuer(context);
      if (!context.currentRoot) {
        throw new BackupRecoveryRootLifecycleError("reset-current-root-missing");
      }
      assertApprovalGeneration(context, approval);
      assertApprovalCoSigner(context, approval.coSign.deviceId);
      const candidate = await session.prepareReplacementRoot();
      assertSameRoot(candidate.generated.identity, candidate.readBack.identity);
      const at = requireCanonicalTime(this.mechanism.now());
      const events = session.createResetEvents({
        approval,
        candidateRoot: candidate.readBack.root,
        at,
      });
      const plan = Object.freeze({
        v: 1 as const,
        kind: "domain-reset-establish" as const,
        resetEvent: events.resetEvent,
        rootEvent: events.rootEvent,
      });
      await session.withCurrentTarget(candidate.readBack.root, async (target) => {
        const targetId = requireText(session.targetId(target), "Recovery target id");
        const checkpoint = await session.captureCheckpoint({
          plan,
          candidateRoot: candidate.readBack.root,
          createdAt: at,
        });
        const supersedeCheckpointIds = Object.freeze([
          ...await session.currentCheckpointIds(targetId),
        ]);
        await session.activate({
          plan,
          candidateRoot: candidate.readBack.root,
          checkpoint,
          target,
          supersedeCheckpointIds,
        });
      });
      return Object.freeze({ kind: "reset" as const });
    });
  }
}

function freezeRootLifecycleContext(
  value: BackupRecoveryRootLifecycleContext,
): BackupRecoveryRootLifecycleContext {
  const activeDeviceIds = Object.freeze(value.activeDeviceIds.map((id) =>
    requireText(id, "Active recovery device id")));
  if (new Set(activeDeviceIds).size !== activeDeviceIds.length) {
    throw new TypeError("Active recovery device ids must be unique");
  }
  return Object.freeze({
    homeId: requireText(value.homeId, "Recovery home id"),
    trustEpoch: requireEpoch(value.trustEpoch),
    chainHead: Object.freeze({
      seq: requireEpoch(value.chainHead.seq),
      eventDigest: requireText(value.chainHead.eventDigest, "Recovery trust head"),
    }),
    currentDeviceId: requireText(value.currentDeviceId, "Current recovery device id"),
    issuerDeviceId: requireText(value.issuerDeviceId, "Recovery issuer device id"),
    issuerKeyId: requireText(value.issuerKeyId, "Recovery issuer key id"),
    signerKeyId: requireText(value.signerKeyId, "Recovery signer key id"),
    activeDeviceIds,
    ...(value.currentRoot ? { currentRoot: freezeRootIdentity(value.currentRoot) } : {}),
  });
}

function freezeRootIdentity(value: BackupRecoveryRootIdentity): BackupRecoveryRootIdentity {
  return Object.freeze({
    rootPublicKey: requireText(value.rootPublicKey, "Recovery root public key"),
    backupPublicKey: requireText(value.backupPublicKey, "Recovery backup public key"),
  });
}

function freezeResetApproval<Signature>(
  value: BackupRecoveryRootResetApproval<Signature>,
): BackupRecoveryRootResetApproval<Signature> {
  if (value.v !== 1) throw new TypeError("Recovery root reset approval version is unsupported");
  return Object.freeze({
    v: 1,
    homeId: requireText(value.homeId, "Recovery reset home id"),
    seq: requireEpoch(value.seq),
    prevEventDigest: requireText(value.prevEventDigest, "Recovery reset trust head"),
    trustEpoch: requireEpoch(value.trustEpoch),
    at: requireCanonicalTime(value.at),
    coSign: Object.freeze({
      deviceId: requireText(value.coSign.deviceId, "Recovery reset co-signer"),
      sig: value.coSign.sig,
    }),
  });
}

function assertCurrentIssuer(context: BackupRecoveryRootLifecycleContext): void {
  if (
    context.currentDeviceId !== context.issuerDeviceId ||
    context.signerKeyId !== context.issuerKeyId
  ) {
    throw new BackupRecoveryRootLifecycleError("current-issuer-required");
  }
}

function assertCurrentRoot(
  context: BackupRecoveryRootLifecycleContext,
  identity: BackupRecoveryRootIdentity,
): void {
  if (!context.currentRoot) {
    throw new BackupRecoveryRootLifecycleError("current-root-missing");
  }
  if (!sameRoot(context.currentRoot, identity)) {
    throw new BackupRecoveryRootLifecycleError("current-package-mismatch");
  }
}

function assertSameRoot(
  generated: BackupRecoveryRootIdentity,
  readBack: BackupRecoveryRootIdentity,
): void {
  if (!sameRoot(generated, readBack)) {
    throw new BackupRecoveryRootLifecycleError("replacement-readback-mismatch");
  }
}

function sameRoot(a: BackupRecoveryRootIdentity, b: BackupRecoveryRootIdentity): boolean {
  return a.rootPublicKey === b.rootPublicKey && a.backupPublicKey === b.backupPublicKey;
}

function assertEligibleCoSigner(context: BackupRecoveryRootLifecycleContext): void {
  if (context.currentDeviceId === context.issuerDeviceId) {
    throw new BackupRecoveryRootLifecycleError("approval-cosigner-is-issuer");
  }
  if (!context.activeDeviceIds.includes(context.currentDeviceId)) {
    throw new BackupRecoveryRootLifecycleError("approval-cosigner-ineligible");
  }
}

function assertApprovalGeneration<Signature>(
  context: BackupRecoveryRootLifecycleContext,
  approval: BackupRecoveryRootResetApproval<Signature>,
): void {
  if (
    approval.homeId !== context.homeId ||
    approval.seq !== context.chainHead.seq + 1 ||
    approval.prevEventDigest !== context.chainHead.eventDigest ||
    approval.trustEpoch !== context.trustEpoch
  ) {
    throw new BackupRecoveryRootLifecycleError("approval-generation-mismatch");
  }
}

function assertApprovalCoSigner(
  context: BackupRecoveryRootLifecycleContext,
  deviceId: string,
): void {
  if (deviceId === context.issuerDeviceId) {
    throw new BackupRecoveryRootLifecycleError("approval-cosigner-is-issuer");
  }
  if (!context.activeDeviceIds.includes(deviceId)) {
    throw new BackupRecoveryRootLifecycleError("approval-cosigner-ineligible");
  }
}

function requireCanonicalTime(value: string): string {
  const time = requireText(value, "Recovery lifecycle time");
  if (new Date(time).toISOString() !== time) {
    throw new TypeError("Recovery lifecycle time must be canonical");
  }
  return time;
}

function requireBinding(
  configuration: BackupRecoveryAdministrationTargetConfiguration,
  targetId: string,
  role: "current" | "verification",
): BackupRecoveryAdministrationTargetBinding {
  const binding = configuration.bindings.find((candidate) => candidate.targetId === targetId);
  if (!binding) {
    throw new BackupRecoveryAdministrationError(role === "current"
      ? "current-target-binding-missing"
      : "verification-target-binding-missing");
  }
  return binding;
}

function requireNonEmpty(value: string, label: string): string {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
  return value;
}

export interface BackupRecoveryDisasterAdmissionSelection {
  readonly directory?: string;
  readonly pairedDeviceName?: string;
  readonly backupNumber?: number;
}

export interface BackupRecoveryDisasterAdmissionPairedDevice {
  readonly deviceId: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly current: boolean;
}

export interface BackupRecoveryDisasterAdmissionContext {
  readonly homeId: string;
  readonly currentDeviceId: string;
  readonly issuerDeviceId: string;
  readonly pairedDevices: readonly BackupRecoveryDisasterAdmissionPairedDevice[];
  readonly configuredPairedDeviceId?: string;
  readonly recoveryBackupRecipientKeyId?: string;
}

export type BackupRecoveryDisasterAdmissionTargetSelection =
  | { readonly kind: "directory"; readonly directory: string }
  | {
      readonly kind: "paired-device";
      readonly deviceId: string;
      readonly displayName: string;
      readonly recipientKeyId: string;
    };

export interface BackupRecoveryDisasterAdmissionInventorySource<Target> {
  readonly displayName: string;
  readonly target: Target;
}

export interface BackupRecoveryDisasterAdmissionInventoryEntry<Envelope> {
  readonly checkpointId: string;
  readonly targetId: string;
  readonly recipientKeyId: string;
  readonly envelope: Envelope;
  readonly envelopeIdentity: {
    readonly checkpointId: string;
    readonly createdAt: string;
    readonly recipientKeyId: string;
    readonly digest: string;
  };
}

export interface BackupRecoveryDisasterAdmissionCandidate {
  readonly number: number;
  readonly location: string;
  readonly backedUpAt: string;
  readonly state: "pending-verification";
}

export interface BackupRecoveryDisasterRecoveryRoot<Root> {
  readonly root: Root;
  readonly identity: {
    readonly rootKeyId: string;
    readonly backupKeyId: string;
  };
}

export interface BackupRecoveryDisasterPrepareIntent<Envelope> {
  readonly v: 1;
  readonly op: "prepare";
  readonly requestId: string;
  readonly transferId: string;
  readonly targetDeviceId: string;
  readonly checkpointTargetId: string;
  readonly recoveryRoot: {
    readonly homeId: string;
    readonly rootKeyId: string;
    readonly recipientKeyId: string;
  };
  readonly checkpointEnvelope: Envelope;
}

export interface BackupRecoveryDisasterAdmission<Root, Checkpoint, Prepare> {
  readonly requestId: string;
  readonly transferId: string;
  readonly checkpointTargetId: string;
  readonly checkpointEnvelopeDigest: string;
  readonly recoveryRoot: Root;
  readonly checkpoint: Checkpoint;
  readonly prepare: Prepare;
}

export type BackupRecoveryDisasterAdmissionErrorCode =
  | "source-selection-conflict"
  | "current-issuer"
  | "paired-device-name-not-unique"
  | "target-selection-required"
  | "paired-device-ineligible"
  | "recovery-root-missing"
  | "invalid-discovery-request-id"
  | "invalid-candidate-location"
  | "invalid-candidate-envelope"
  | "candidate-not-found"
  | "candidate-selection-required"
  | "invalid-candidate-number"
  | "recovery-package-mismatch"
  | "invalid-transfer-id";

export class BackupRecoveryDisasterAdmissionError extends Error {
  readonly name = "BackupRecoveryDisasterAdmissionError";

  constructor(
    readonly code: BackupRecoveryDisasterAdmissionErrorCode,
    readonly errorKind: "error" | "type-error" = "error",
  ) {
    super(code);
  }
}

export function validateBackupRecoveryDisasterAdmissionSelection(
  selection: BackupRecoveryDisasterAdmissionSelection,
): void {
  if ([selection.directory, selection.pairedDeviceName]
    .filter((value) => value !== undefined).length > 1) {
    throw new BackupRecoveryDisasterAdmissionError(
      "source-selection-conflict",
      "type-error",
    );
  }
}

/** Mechanism-only port. It opens resources and moves/signs bytes but makes no admission decision. */
export interface BackupRecoveryDisasterAdmissionMechanismPort<
  Target,
  Envelope,
  Root,
  Checkpoint,
  Prepare,
> {
  deriveDiscoveryRequestId(input: {
    readonly homeId: string;
    readonly targetDeviceId: string;
  }): string;
  withInventorySources<Result>(
    selection: BackupRecoveryDisasterAdmissionTargetSelection,
    use: (
      sources: readonly BackupRecoveryDisasterAdmissionInventorySource<Target>[],
    ) => Promise<Result>,
  ): Promise<Result>;
  inventory(
    target: Target,
    requestId: string,
  ): Promise<readonly BackupRecoveryDisasterAdmissionInventoryEntry<Envelope>[]>;
  presentCandidates(candidates: readonly BackupRecoveryDisasterAdmissionCandidate[]): void;
  readRecoveryRoot(): Promise<BackupRecoveryDisasterRecoveryRoot<Root>>;
  deriveTransferId(input: {
    readonly requestId: string;
    readonly targetDeviceId: string;
    readonly checkpointTargetId: string;
    readonly checkpointEnvelopeDigest: string;
  }): string;
  signPrepare(intent: BackupRecoveryDisasterPrepareIntent<Envelope>, root: Root): Prepare;
  readCheckpoint(target: Target, checkpointId: string): Promise<Checkpoint>;
}

export interface BackupRecoveryDisasterAdmissionApplication<Root, Checkpoint, Prepare> {
  admit(
    selection: BackupRecoveryDisasterAdmissionSelection,
  ): Promise<BackupRecoveryDisasterAdmission<Root, Checkpoint, Prepare>>;
}

interface BackupRecoveryDisasterCandidateRecord<Target, Envelope> {
  readonly public: BackupRecoveryDisasterAdmissionCandidate;
  readonly target: Target;
  readonly entry: BackupRecoveryDisasterAdmissionInventoryEntry<Envelope>;
}

/** Sole owner of disaster-recovery source, candidate and pre-install admission decisions. */
export class BackupRecoveryDisasterAdmissionApplicationService<
  Target,
  Envelope,
  Root,
  Checkpoint,
  Prepare,
> implements BackupRecoveryDisasterAdmissionApplication<Root, Checkpoint, Prepare> {
  constructor(
    private readonly context: BackupRecoveryDisasterAdmissionContext,
    private readonly mechanism: BackupRecoveryDisasterAdmissionMechanismPort<
      Target,
      Envelope,
      Root,
      Checkpoint,
      Prepare
    >,
  ) {}

  async admit(
    selection: BackupRecoveryDisasterAdmissionSelection,
  ): Promise<BackupRecoveryDisasterAdmission<Root, Checkpoint, Prepare>> {
    const context = freezeDisasterAdmissionContext(this.context);
    if (context.currentDeviceId === context.issuerDeviceId) {
      throw new BackupRecoveryDisasterAdmissionError("current-issuer");
    }
    const targetSelection = this.#resolveTarget(selection, context);
    const requestId = this.mechanism.deriveDiscoveryRequestId({
      homeId: context.homeId,
      targetDeviceId: context.currentDeviceId,
    });
    if (!/^recover:[a-f0-9]{64}$/u.test(requestId)) {
      throw new BackupRecoveryDisasterAdmissionError(
        "invalid-discovery-request-id",
        "type-error",
      );
    }
    return this.mechanism.withInventorySources(targetSelection, async (sources) => {
      const candidates = await this.#discover(requestId, sources);
      this.mechanism.presentCandidates(candidates.map((candidate) => candidate.public));
      const selected = this.#select(candidates, selection.backupNumber);
      const recovered = await this.mechanism.readRecoveryRoot();
      const rootKeyId = requireText(recovered.identity.rootKeyId, "Recovery root key id");
      const backupKeyId = requireText(recovered.identity.backupKeyId, "Recovery backup key id");
      if (
        selected.entry.recipientKeyId !== backupKeyId ||
        selected.entry.envelopeIdentity.recipientKeyId !== backupKeyId
      ) {
        throw new BackupRecoveryDisasterAdmissionError("recovery-package-mismatch");
      }
      const transferInput = Object.freeze({
        requestId,
        targetDeviceId: context.currentDeviceId,
        checkpointTargetId: selected.entry.targetId,
        checkpointEnvelopeDigest: selected.entry.envelopeIdentity.digest,
      });
      const transferId = this.mechanism.deriveTransferId(transferInput);
      if (!/^xfer-[0-9A-HJKMNP-TV-Z]{26}$/u.test(transferId)) {
        throw new BackupRecoveryDisasterAdmissionError("invalid-transfer-id", "type-error");
      }
      const intent = Object.freeze({
        v: 1 as const,
        op: "prepare" as const,
        requestId,
        transferId,
        targetDeviceId: context.currentDeviceId,
        checkpointTargetId: selected.entry.targetId,
        recoveryRoot: Object.freeze({
          homeId: context.homeId,
          rootKeyId,
          recipientKeyId: backupKeyId,
        }),
        checkpointEnvelope: selected.entry.envelope,
      });
      const prepare = this.mechanism.signPrepare(intent, recovered.root);
      const checkpoint = await this.mechanism.readCheckpoint(
        selected.target,
        selected.entry.checkpointId,
      );
      return Object.freeze({
        requestId,
        transferId,
        checkpointTargetId: selected.entry.targetId,
        checkpointEnvelopeDigest: selected.entry.envelopeIdentity.digest,
        recoveryRoot: recovered.root,
        checkpoint,
        prepare,
      });
    });
  }

  #resolveTarget(
    selection: BackupRecoveryDisasterAdmissionSelection,
    context: BackupRecoveryDisasterAdmissionContext,
  ): BackupRecoveryDisasterAdmissionTargetSelection {
    validateBackupRecoveryDisasterAdmissionSelection(selection);
    if (selection.directory) {
      return Object.freeze({
        kind: "directory" as const,
        directory: requireText(selection.directory, "Recovery backup directory"),
      });
    }
    const named = selection.pairedDeviceName === undefined
      ? []
      : context.pairedDevices.filter((device) =>
          device.active && !device.current && device.displayName === selection.pairedDeviceName);
    if (selection.pairedDeviceName !== undefined && named.length !== 1) {
      throw new BackupRecoveryDisasterAdmissionError("paired-device-name-not-unique");
    }
    const deviceId = named[0]?.deviceId ?? context.configuredPairedDeviceId;
    if (!deviceId) {
      throw new BackupRecoveryDisasterAdmissionError("target-selection-required");
    }
    const device = context.pairedDevices.find((candidate) =>
      candidate.deviceId === deviceId && candidate.active);
    if (!device || device.current) {
      throw new BackupRecoveryDisasterAdmissionError("paired-device-ineligible");
    }
    if (!context.recoveryBackupRecipientKeyId) {
      throw new BackupRecoveryDisasterAdmissionError("recovery-root-missing");
    }
    return Object.freeze({
      kind: "paired-device" as const,
      deviceId,
      displayName: device.displayName,
      recipientKeyId: context.recoveryBackupRecipientKeyId,
    });
  }

  async #discover(
    requestId: string,
    sources: readonly BackupRecoveryDisasterAdmissionInventorySource<Target>[],
  ): Promise<readonly BackupRecoveryDisasterCandidateRecord<Target, Envelope>[]> {
    const records: Array<{
      readonly displayName: string;
      readonly target: Target;
      readonly entry: BackupRecoveryDisasterAdmissionInventoryEntry<Envelope>;
    }> = [];
    for (const source of sources) {
      const displayName = normalizeDisasterCandidateLocation(source.displayName);
      for (const entry of await this.mechanism.inventory(source.target, requestId)) {
        const identity = entry.envelopeIdentity;
        if (
          !entry.checkpointId ||
          !entry.targetId ||
          entry.checkpointId !== identity.checkpointId ||
          !identity.recipientKeyId ||
          !identity.digest ||
          !isCanonicalTime(identity.createdAt)
        ) {
          throw new BackupRecoveryDisasterAdmissionError(
            "invalid-candidate-envelope",
            "type-error",
          );
        }
        records.push({ displayName, target: source.target, entry });
      }
    }
    return Object.freeze(records
      .sort((left, right) =>
        right.entry.envelopeIdentity.createdAt.localeCompare(left.entry.envelopeIdentity.createdAt) ||
        left.entry.targetId.localeCompare(right.entry.targetId) ||
        left.entry.checkpointId.localeCompare(right.entry.checkpointId))
      .map((record, index) => Object.freeze({
        target: record.target,
        entry: record.entry,
        public: Object.freeze({
          number: index + 1,
          location: record.displayName,
          backedUpAt: record.entry.envelopeIdentity.createdAt,
          state: "pending-verification" as const,
        }),
      })));
  }

  #select(
    candidates: readonly BackupRecoveryDisasterCandidateRecord<Target, Envelope>[],
    number?: number,
  ): BackupRecoveryDisasterCandidateRecord<Target, Envelope> {
    if (candidates.length === 0) {
      throw new BackupRecoveryDisasterAdmissionError("candidate-not-found");
    }
    if (number === undefined) {
      if (candidates.length !== 1) {
        throw new BackupRecoveryDisasterAdmissionError("candidate-selection-required");
      }
      return candidates[0]!;
    }
    if (!Number.isSafeInteger(number) || number < 1 || number > candidates.length) {
      throw new BackupRecoveryDisasterAdmissionError(
        "invalid-candidate-number",
        "type-error",
      );
    }
    return candidates[number - 1]!;
  }
}

function freezeDisasterAdmissionContext(
  value: BackupRecoveryDisasterAdmissionContext,
): BackupRecoveryDisasterAdmissionContext {
  return Object.freeze({
    homeId: requireText(value.homeId, "Recovery home id"),
    currentDeviceId: requireText(value.currentDeviceId, "Recovery target device id"),
    issuerDeviceId: requireText(value.issuerDeviceId, "Recovery issuer device id"),
    pairedDevices: Object.freeze(value.pairedDevices.map((device) => Object.freeze({
      deviceId: requireText(device.deviceId, "Paired device id"),
      displayName: requireText(device.displayName, "Paired device display name"),
      active: device.active,
      current: device.current,
    }))),
    ...(value.configuredPairedDeviceId === undefined
      ? {}
      : { configuredPairedDeviceId: requireText(
          value.configuredPairedDeviceId,
          "Configured recovery device id",
        ) }),
    ...(value.recoveryBackupRecipientKeyId === undefined
      ? {}
      : { recoveryBackupRecipientKeyId: requireText(
          value.recoveryBackupRecipientKeyId,
          "Recovery backup recipient key id",
        ) }),
  });
}

function normalizeDisasterCandidateLocation(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 120 || /[\r\n\0]/u.test(normalized)) {
    throw new BackupRecoveryDisasterAdmissionError(
      "invalid-candidate-location",
      "type-error",
    );
  }
  return normalized;
}

function isCanonicalTime(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export interface BackupRecoveryDisasterInstallAdmission {
  readonly requestId: string;
  readonly transferId: string;
  readonly checkpointTargetId: string;
  readonly checkpointEnvelopeDigest: string;
}

export interface BackupRecoveryDisasterInstalledGeneration<Generation> {
  readonly transferId: string;
  readonly issuerDeviceId: string;
  readonly generation: Generation;
}

export interface BackupRecoveryCredentialRotationRequirement {
  readonly service: string;
  readonly tenant?: string;
  readonly rotationHint?: string;
}

export type BackupRecoveryDisasterProgress = "installing" | "recovery-committed";

export type BackupRecoveryDisasterCompletion = Readonly<{
  state: "completed";
  credentialRotation:
    | Readonly<{ state: "not-required" }>
    | Readonly<{
        state: "required";
        actions: readonly Readonly<{
          service: string;
          tenant?: string;
          instruction: string;
        }>[];
      }>;
  nextStep: Readonly<{ kind: "confirm-old-device-isolated" }>;
}>;

export type BackupRecoveryDisasterFinish = Readonly<{ state: "finished" }>;

export interface BackupRecoveryDisasterAbortIntent<Admission> {
  readonly admission: Admission;
  readonly requestId: string;
  readonly transferId: string;
  readonly checkpointTargetId: string;
  readonly checkpointEnvelopeDigest: string;
  readonly reason: "operator-cancelled";
  readonly at: string;
}

export interface BackupRecoveryDisasterFreshInstallPort<
  Admission extends BackupRecoveryDisasterInstallAdmission,
  Evidence,
> {
  admit(): Promise<Admission>;
  collectPrepareEvidence(admission: Admission): Promise<Evidence>;
  prepareAndImport(input: {
    readonly admission: Admission;
    readonly evidence: Evidence;
  }): Promise<void>;
  commit(admission: Admission): Promise<void>;
  abort(input: BackupRecoveryDisasterAbortIntent<Admission>): Promise<void>;
}

export interface BackupRecoveryDisasterRecoverySession<
  Admission extends BackupRecoveryDisasterInstallAdmission,
  Evidence,
  Generation,
> {
  readonly currentDeviceId: string;
  readonly issuerDeviceId: string;
  readCurrentInstallation(): Promise<
    BackupRecoveryDisasterInstalledGeneration<Generation> | undefined
  >;
  waitForPostInstallReceipt(generation: Generation): Promise<void>;
  readCredentialRotationRequirements(): Promise<
    readonly BackupRecoveryCredentialRotationRequirement[]
  >;
  presentProgress(progress: BackupRecoveryDisasterProgress): void;
  presentCompletion(completion: BackupRecoveryDisasterCompletion): void;
  withFreshInstall<Result>(
    use: (
      port: BackupRecoveryDisasterFreshInstallPort<Admission, Evidence>,
    ) => Promise<Result>,
  ): Promise<Result>;
}

export interface BackupRecoveryDisasterFinishSession<Generation> {
  readCurrentInstallation(): Promise<
    BackupRecoveryDisasterInstalledGeneration<Generation> | undefined
  >;
  readTombstoneDisposition(
    transferId: string,
  ): Promise<"eligible" | "terminal" | "ineligible">;
  tombstone(transferId: string): Promise<void>;
}

/**
 * Backup/Storage mechanisms. They move, sign and persist recovery facts but do
 * not decide which generation is resumed or when install/finish is complete.
 */
export interface BackupRecoveryDisasterLifecycleMechanismPort<
  Admission extends BackupRecoveryDisasterInstallAdmission,
  Evidence,
  Generation,
> {
  now(): string;
  withRecoverySession<Result>(
    use: (
      session: BackupRecoveryDisasterRecoverySession<Admission, Evidence, Generation>,
    ) => Promise<Result>,
  ): Promise<Result>;
  withFinishSession<Result>(
    use: (session: BackupRecoveryDisasterFinishSession<Generation>) => Promise<Result>,
  ): Promise<Result>;
}

export interface BackupRecoveryDisasterLifecycleApplication {
  recover(): Promise<BackupRecoveryDisasterCompletion>;
  finish(input: {
    readonly userConfirmedOldDeviceIsolated: boolean;
  }): Promise<BackupRecoveryDisasterFinish>;
}

export type BackupRecoveryDisasterLifecycleErrorCode =
  | "current-device-not-recovering"
  | "installation-generation-mismatch"
  | "finish-confirmation-required"
  | "finish-installation-missing"
  | "finish-installation-ineligible";

export class BackupRecoveryDisasterLifecycleError extends Error {
  readonly name = "BackupRecoveryDisasterLifecycleError";

  constructor(readonly code: BackupRecoveryDisasterLifecycleErrorCode) {
    super(code);
  }
}

/** Sole owner of disaster install, response-loss continuation and finish decisions. */
export class BackupRecoveryDisasterLifecycleApplicationService<
  Admission extends BackupRecoveryDisasterInstallAdmission,
  Evidence,
  Generation,
> implements BackupRecoveryDisasterLifecycleApplication {
  constructor(
    private readonly mechanism: BackupRecoveryDisasterLifecycleMechanismPort<
      Admission,
      Evidence,
      Generation
    >,
  ) {}

  recover(): Promise<BackupRecoveryDisasterCompletion> {
    return this.mechanism.withRecoverySession(async (session) => {
      const currentDeviceId = requireText(session.currentDeviceId, "Recovery target device id");
      const issuerDeviceId = requireText(session.issuerDeviceId, "Recovery issuer device id");
      if (currentDeviceId === issuerDeviceId) {
        const installed = await session.readCurrentInstallation();
        if (!installed || installed.issuerDeviceId !== currentDeviceId) {
          throw new BackupRecoveryDisasterLifecycleError("current-device-not-recovering");
        }
        await session.waitForPostInstallReceipt(installed.generation);
        return this.#completion(session);
      }

      return session.withFreshInstall(async (fresh) => {
        const admission = freezeDisasterInstallAdmission(await fresh.admit());
        const evidence = await fresh.collectPrepareEvidence(admission);
        try {
          await fresh.prepareAndImport({ admission, evidence });
          session.presentProgress("installing");
          await fresh.commit(admission);
          const installed = await session.readCurrentInstallation();
          if (!installed || installed.transferId !== admission.transferId) {
            throw new BackupRecoveryDisasterLifecycleError(
              "installation-generation-mismatch",
            );
          }
          await session.waitForPostInstallReceipt(installed.generation);
        } catch (error) {
          const at = this.mechanism.now();
          if (!isCanonicalTime(at)) {
            throw new TypeError("Disaster recovery abort time is invalid", { cause: error });
          }
          await fresh.abort(Object.freeze({
            admission,
            requestId: admission.requestId,
            transferId: admission.transferId,
            checkpointTargetId: admission.checkpointTargetId,
            checkpointEnvelopeDigest: admission.checkpointEnvelopeDigest,
            reason: "operator-cancelled" as const,
            at,
          })).catch(() => undefined);
          throw error;
        }
        return this.#completion(session);
      });
    });
  }

  async finish(input: {
    readonly userConfirmedOldDeviceIsolated: boolean;
  }): Promise<BackupRecoveryDisasterFinish> {
    if (!input.userConfirmedOldDeviceIsolated) {
      throw new BackupRecoveryDisasterLifecycleError("finish-confirmation-required");
    }
    return this.mechanism.withFinishSession(async (session) => {
      const current = await session.readCurrentInstallation();
      if (!current) {
        throw new BackupRecoveryDisasterLifecycleError("finish-installation-missing");
      }
      const transferId = requireText(current.transferId, "Recovery transfer id");
      const disposition = await session.readTombstoneDisposition(transferId);
      switch (disposition) {
        case "ineligible":
          throw new BackupRecoveryDisasterLifecycleError("finish-installation-ineligible");
        case "eligible":
          await session.tombstone(transferId);
          break;
        case "terminal":
          break;
        default:
          throw new TypeError("Disaster recovery tombstone disposition is invalid");
      }
      return Object.freeze({ state: "finished" as const });
    });
  }

  async #completion(
    session: BackupRecoveryDisasterRecoverySession<Admission, Evidence, Generation>,
  ): Promise<BackupRecoveryDisasterCompletion> {
    session.presentProgress("recovery-committed");
    const requirements = await session.readCredentialRotationRequirements();
    const actions = Object.freeze(requirements.map((item) => Object.freeze({
      service: requireText(item.service, "Credential service"),
      ...(item.tenant === undefined
        ? {}
        : { tenant: requireText(item.tenant, "Credential tenant") }),
      instruction: item.rotationHint === undefined
        ? "在对应服务中撤销旧凭据并发布新凭据"
        : requireText(item.rotationHint, "Credential rotation instruction"),
    })));
    const completion = Object.freeze({
      state: "completed" as const,
      credentialRotation: actions.length === 0
        ? Object.freeze({ state: "not-required" as const })
        : Object.freeze({ state: "required" as const, actions }),
      nextStep: Object.freeze({ kind: "confirm-old-device-isolated" as const }),
    });
    session.presentCompletion(completion);
    return completion;
  }
}

function freezeDisasterInstallAdmission<
  Admission extends BackupRecoveryDisasterInstallAdmission,
>(value: Admission): Admission {
  requireText(value.requestId, "Disaster recovery request id");
  requireText(value.transferId, "Disaster recovery transfer id");
  requireText(value.checkpointTargetId, "Disaster recovery checkpoint target id");
  requireText(value.checkpointEnvelopeDigest, "Disaster recovery checkpoint digest");
  return Object.freeze(value);
}

export interface BackupRecoveryCurrentRemovalStatus {
  readonly state: "not-configured" | "pending-verification" | "recoverable" | "unavailable";
  readonly fullBackupReady: boolean;
  readonly checkpointId?: string;
  readonly targetId?: string;
  readonly upToLsn?: number;
}

export interface BackupRecoveryCurrentRemovalBinding {
  readonly homeId: string;
  readonly anchorEpoch: number;
  readonly trustHeadDigest: string;
  readonly checkpointTargetId: string;
  readonly checkpointGeneration: string;
}

export interface BackupRecoveryCurrentRemovalPackageIdentity {
  readonly rootKeyId: string;
  readonly backupKeyId: string;
  readonly rootPublicKey: string;
  readonly backupPublicKey: string;
}

export interface BackupRecoveryCurrentRemovalContext {
  readonly homeId: string;
  readonly anchorEpoch: number;
  readonly trustHeadDigest: string;
  readonly recoveryRootPublicKey: string;
  readonly recoveryBackupPublicKey: string;
}

export interface BackupRecoveryDecodedCurrentPackage<Package> {
  readonly package: Package;
  readonly identity: BackupRecoveryCurrentRemovalPackageIdentity;
}

export interface BackupRecoveryForcedCheckpoint<Checkpoint> {
  readonly checkpoint: Checkpoint;
  readonly checkpointId: string;
  readonly envelopeDigest: string;
  readonly upToLsn: number;
}

export interface BackupRecoveryCheckpointVerification<Evidence> {
  readonly targetId: string;
  readonly checkpointId: string;
  readonly envelopeDigest: string;
  readonly evidence: Evidence;
}

/** Backup/Storage primitives. They decode, sign and move bytes but make no removal decision. */
export interface BackupRecoveryCurrentRemovalMechanismPort<Package, Checkpoint, Evidence> {
  hasCheckpointOwner(): boolean;
  readStatus(): Promise<BackupRecoveryCurrentRemovalStatus>;
  readContext(): Promise<BackupRecoveryCurrentRemovalContext>;
  decodeCurrentPackage(value: string): BackupRecoveryDecodedCurrentPackage<Package>;
  bindingDigest(input: {
    readonly homeId: string;
    readonly anchorEpoch: number;
    readonly trustHeadDigest: string;
    readonly targetId: string;
    readonly rootKeyId: string;
    readonly recipientKeyId: string;
  }): string;
  forceCheckpoint(requestId: string): Promise<BackupRecoveryForcedCheckpoint<Checkpoint>>;
  verifyCheckpoint(input: {
    readonly checkpoint: Checkpoint;
    readonly recoveryPackage: Package;
  }): Promise<BackupRecoveryCheckpointVerification<Evidence>>;
}

/** Opaque cross-domain permit. Device Administration cannot obtain recovery secrets or bytes. */
export interface BackupRecoveryCurrentRemovalPermit<Evidence> {
  readonly binding: BackupRecoveryCurrentRemovalBinding;
  verifyCheckpoint(input: {
    readonly requestId: string;
    readonly minimumUpToLsn?: number;
  }): Promise<Evidence>;
}

export interface BackupRecoveryCurrentRemovalApplication<Evidence> {
  readiness(): Promise<BackupRecoveryCurrentRemovalStatus>;
  prepareBegin(input: {
    readonly recoveryPackage: string;
  }): Promise<BackupRecoveryCurrentRemovalPermit<Evidence>>;
  prepareConfirm(input: {
    readonly recoveryPackage: string;
    readonly binding: BackupRecoveryCurrentRemovalBinding;
  }): Promise<BackupRecoveryCurrentRemovalPermit<Evidence>>;
}

/** Sole owner of recovery package/root/generation binding and checkpoint permission. */
export class BackupRecoveryCurrentRemovalApplicationService<Package, Checkpoint, Evidence>
  implements BackupRecoveryCurrentRemovalApplication<Evidence>
{
  constructor(private readonly mechanism:
    BackupRecoveryCurrentRemovalMechanismPort<Package, Checkpoint, Evidence>) {}

  async readiness(): Promise<BackupRecoveryCurrentRemovalStatus> {
    return freezeStatus(await this.mechanism.readStatus());
  }

  async prepareBegin(input: {
    readonly recoveryPackage: string;
  }): Promise<BackupRecoveryCurrentRemovalPermit<Evidence>> {
    const decoded = this.mechanism.decodeCurrentPackage(requireText(
      input.recoveryPackage,
      "Recovery package",
    ));
    if (!this.mechanism.hasCheckpointOwner()) {
      throw new Error("No recovery backup target is configured");
    }
    const [status, context] = await Promise.all([
      this.mechanism.readStatus(),
      this.mechanism.readContext(),
    ]);
    const checkpointTargetId = requireText(
      status.targetId,
      "Recovery backup target identity",
      "Recovery backup target identity is unavailable",
    );
    return this.#permit(decoded, context, Object.freeze({
      homeId: requireText(context.homeId, "Recovery home id"),
      anchorEpoch: requireEpoch(context.anchorEpoch),
      trustHeadDigest: requireText(context.trustHeadDigest, "Recovery trust head"),
      checkpointTargetId,
      checkpointGeneration: this.#generation({
        context,
        targetId: checkpointTargetId,
        identity: decoded.identity,
      }),
    }));
  }

  async prepareConfirm(input: {
    readonly recoveryPackage: string;
    readonly binding: BackupRecoveryCurrentRemovalBinding;
  }): Promise<BackupRecoveryCurrentRemovalPermit<Evidence>> {
    const decoded = this.mechanism.decodeCurrentPackage(requireText(
      input.recoveryPackage,
      "Recovery package",
    ));
    const binding = freezeBinding(input.binding);
    const context = await this.mechanism.readContext();
    const generation = this.#generation({
      context: Object.freeze({
        ...context,
        homeId: binding.homeId,
        anchorEpoch: binding.anchorEpoch,
        trustHeadDigest: binding.trustHeadDigest,
      }),
      targetId: binding.checkpointTargetId,
      identity: decoded.identity,
    });
    if (
      context.homeId !== binding.homeId ||
      generation !== binding.checkpointGeneration
    ) {
      throw new Error("Recovery package changes the accepted uninstall generation");
    }
    return this.#permit(decoded, context, binding);
  }

  #permit(
    decoded: BackupRecoveryDecodedCurrentPackage<Package>,
    context: BackupRecoveryCurrentRemovalContext,
    binding: BackupRecoveryCurrentRemovalBinding,
  ): BackupRecoveryCurrentRemovalPermit<Evidence> {
    assertRootBinding(context, decoded.identity);
    const frozenBinding = freezeBinding(binding);
    return Object.freeze({
      binding: frozenBinding,
      verifyCheckpoint: async ({
        requestId,
        minimumUpToLsn,
      }: {
        readonly requestId: string;
        readonly minimumUpToLsn?: number;
      }) => {
        const checkpoint = await this.mechanism.forceCheckpoint(requireText(
          requestId,
          "Recovery checkpoint request id",
        ));
        const verification = await this.mechanism.verifyCheckpoint({
          checkpoint: checkpoint.checkpoint,
          recoveryPackage: decoded.package,
        });
        if (
          verification.targetId !== frozenBinding.checkpointTargetId ||
          verification.checkpointId !== checkpoint.checkpointId ||
          verification.envelopeDigest !== checkpoint.envelopeDigest
        ) {
          throw new Error("Recovery checkpoint verification does not bind the frozen target");
        }
        if (minimumUpToLsn !== undefined) {
          if (!Number.isSafeInteger(minimumUpToLsn) || minimumUpToLsn < 0) {
            throw new TypeError("Recovery checkpoint minimum LSN is invalid");
          }
          if (checkpoint.upToLsn < minimumUpToLsn) {
            throw new Error("Final recovery backup does not contain the accepted-work flush");
          }
        }
        return verification.evidence;
      },
    });
  }

  #generation(input: {
    readonly context: BackupRecoveryCurrentRemovalContext;
    readonly targetId: string;
    readonly identity: BackupRecoveryCurrentRemovalPackageIdentity;
  }): string {
    return requireText(this.mechanism.bindingDigest({
      homeId: requireText(input.context.homeId, "Recovery home id"),
      anchorEpoch: requireEpoch(input.context.anchorEpoch),
      trustHeadDigest: requireText(input.context.trustHeadDigest, "Recovery trust head"),
      targetId: requireText(input.targetId, "Recovery checkpoint target id"),
      rootKeyId: requireText(input.identity.rootKeyId, "Recovery root key id"),
      recipientKeyId: requireText(input.identity.backupKeyId, "Recovery recipient key id"),
    }), "Recovery checkpoint generation");
  }
}

function assertRootBinding(
  context: BackupRecoveryCurrentRemovalContext,
  identity: BackupRecoveryCurrentRemovalPackageIdentity,
): void {
  if (
    context.recoveryRootPublicKey !== identity.rootPublicKey ||
    context.recoveryBackupPublicKey !== identity.backupPublicKey
  ) {
    throw new Error("Recovery package does not bind the current home recovery root");
  }
}

function freezeStatus(
  value: BackupRecoveryCurrentRemovalStatus,
): BackupRecoveryCurrentRemovalStatus {
  if (!new Set(["not-configured", "pending-verification", "recoverable", "unavailable"])
    .has(value.state)) {
    throw new TypeError("Recovery backup status is invalid");
  }
  return Object.freeze({
    state: value.state,
    fullBackupReady: value.fullBackupReady === true,
    ...(value.checkpointId === undefined
      ? {}
      : { checkpointId: requireText(value.checkpointId, "Recovery checkpoint id") }),
    ...(value.targetId === undefined
      ? {}
      : { targetId: requireText(value.targetId, "Recovery checkpoint target id") }),
    ...(value.upToLsn === undefined ? {} : { upToLsn: requireEpoch(value.upToLsn) }),
  });
}

function freezeBinding(
  value: BackupRecoveryCurrentRemovalBinding,
): BackupRecoveryCurrentRemovalBinding {
  return Object.freeze({
    homeId: requireText(value.homeId, "Recovery home id"),
    anchorEpoch: requireEpoch(value.anchorEpoch),
    trustHeadDigest: requireText(value.trustHeadDigest, "Recovery trust head"),
    checkpointTargetId: requireText(value.checkpointTargetId, "Recovery checkpoint target id"),
    checkpointGeneration: requireText(
      value.checkpointGeneration,
      "Recovery checkpoint generation",
    ),
  });
}

function requireText(value: unknown, label: string, message?: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    if (message) throw new Error(message);
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function requireEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Recovery generation value is invalid");
  }
  return value as number;
}
