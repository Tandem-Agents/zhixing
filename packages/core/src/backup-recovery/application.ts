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
