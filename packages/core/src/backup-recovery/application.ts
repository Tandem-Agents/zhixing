export type BackupRecoveryAdministrationTargetSelection =
  | { readonly kind: "directory"; readonly directory: string }
  | {
      readonly kind: "paired-device";
      readonly selector:
        | { readonly kind: "display-name"; readonly value: string }
        | { readonly kind: "device-id"; readonly value: string };
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

export type BackupRecoveryAdministrationStatus =
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
      readonly state: "configured-empty";
      readonly fullBackupReady: false;
      readonly nextAction: "run-backup-setup";
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
        | "start-authenticated-mesh"
        | "check-backup-target";
    };

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
  readStatus(targetId: string): Promise<{
    readonly state: "not-configured" | "pending-verification" | "recoverable" | "unavailable";
    readonly fullBackupReady: boolean;
    readonly code?: "configuration-invalid" | "runtime-unavailable" | "target-unavailable";
  }>;
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
      return Object.freeze({
        state: "not-configured" as const,
        fullBackupReady: false as const,
        nextAction: "run-backup-setup" as const,
      });
    }
    const binding = requireBinding(configured, configured.currentTargetId, "current");
    const status = await this.mechanism.readStatus(binding.targetId);
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
          nextAction: status.code === "configuration-invalid"
            ? "repair-backup-configuration"
            : status.code === "runtime-unavailable"
              ? "start-authenticated-mesh"
              : "check-backup-target",
        });
      case "not-configured":
        return Object.freeze({
          state: "configured-empty",
          fullBackupReady: false,
          nextAction: "run-backup-setup",
        });
    }
  }

  async #resolvePairedTarget(
    selection: Extract<BackupRecoveryAdministrationTargetSelection, { readonly kind: "paired-device" }>,
  ): Promise<Extract<BackupRecoveryAdministrationTargetBinding, { readonly kind: "paired-device" }>> {
    const value = requireNonEmpty(selection.selector.value, "Paired recovery backup device");
    const devices = await this.mechanism.listPairedDevices();
    const matches = devices.filter((device) =>
      device.active && (selection.selector.kind === "device-id"
        ? device.deviceId === value
        : device.displayName === value));
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
