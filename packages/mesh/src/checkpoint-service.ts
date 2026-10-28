import type {
  ArtifactRef,
  CheckpointEnvelope,
  CheckpointStreamRecord,
  DeviceIdentity,
  HomeTrustRecord,
  RecoveryCheckpointGeneration,
  RecoveryCheckpointRequest,
  RecoveryCheckpointVerification,
} from "@zhixing/core/contracts";
import type {
  AuthorityCommitLog,
  ArtifactCheckpointRetentionPort,
  MutableArtifactStore,
} from "@zhixing/core/authority";
import { canonicalize, protocolDigest } from "./canonical.js";
import {
  checkpointEnvelopeArtifact,
  checkpointPurpose,
  deriveCheckpointId,
  createRecoveryCheckpointVerification,
  readCheckpointChunk,
  verifyStoredFullAuthorityCheckpoint,
  verifyRecoveryCheckpointVerification,
  type CheckpointPackage,
  type CheckpointRecipient,
  type CheckpointSigner,
} from "./checkpoint.js";
import { captureFullAuthorityCheckpoint } from "./full-checkpoint.js";
import type { RetirableRecoveryCheckpointTarget } from "./checkpoint-target.js";
import {
  CHECKPOINT_LIFECYCLE_PROJECTION_ID, CheckpointLifecycleView, checkpointRecordKey, registerCheckpointLifecycleIndex,
} from "./checkpoint-lifecycle-index.js";

export { CHECKPOINT_LIFECYCLE_PROJECTION_ID, CheckpointLifecycleView, registerCheckpointLifecycleIndex } from "./checkpoint-lifecycle-index.js";

/** 在 checkpoint 生命周期投影的同一已验证视图上读取（先幂等登记，读前追平有界尾部）。 */
export async function readCheckpointLifecycle<T>(log: AuthorityCommitLog, read: (view: CheckpointLifecycleView) => Promise<T>): Promise<T> {
  registerCheckpointLifecycleIndex(log);
  return (await log.transactDurableProjection<never, T>(CHECKPOINT_LIFECYCLE_PROJECTION_ID,
    async (current) => ({ kind: "return", value: await read(new CheckpointLifecycleView(current)) }))).value;
}
import { keyIdForPublicKey, RecoveryRoot, verifyRecoverySignature } from "./recovery-root.js";
import {
  runStorageMaintenanceStep,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";

const FULL_SCOPE = Object.freeze([
  "global-authority",
  "conversation-authority",
  "conversation-content",
  "execution-assets",
] as const);
const RETENTION_MS = 27 * 24 * 60 * 60 * 1000;

export interface RecoveryBackupStatus {
  readonly state: "not-configured" | "pending-verification" | "recoverable" | "unavailable";
  readonly fullBackupReady: boolean;
  readonly code?: "configuration-invalid" | "target-unavailable" | "runtime-unavailable";
  readonly checkpointId?: string;
  readonly targetId?: string;
  readonly createdAt?: string;
  readonly upToLsn?: number;
}

export interface RecoveryCheckpointVerificationCandidate {
  readonly checkpointId: string;
  readonly targetId: string;
}

export interface DurableRecoveryBackupStatusOptions {
  readonly log: AuthorityCommitLog;
  readonly artifacts: MutableArtifactStore;
  readonly trust: HomeTrustRecord;
  readonly currentAnchor: boolean;
  readonly targetId: string;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly abort?: AbortSignal;
}

export async function projectDurableRecoveryBackupStatus(
  options: DurableRecoveryBackupStatusOptions,
): Promise<RecoveryBackupStatus> {
  if (
    !options.currentAnchor ||
    !options.trust.recoveryRootPublicKey ||
    !options.trust.recoveryBackupPublicKey
  ) {
    return { state: "not-configured", fullBackupReady: false };
  }
  const recipientKeyId = keyIdForPublicKey(options.trust.recoveryBackupPublicKey);
  const generation: RecoveryCheckpointGeneration = {
    rootKeyId: keyIdForPublicKey(options.trust.recoveryRootPublicKey),
    recipientKeyId,
    trustChainHead: { ...options.trust.chainHead },
    targetId: options.targetId,
  };
  // 只读当前（未被取代）的已验证记录，最新在前；配对的 created 与同代际最新的 created 按键读
  const { verifiedPair, pending } = await readCheckpointLifecycle(options.log, async (view) => {
    let found: { verified: Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }>; created: Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> } | undefined;
    for (const verified of await view.currentVerified(recipientKeyId)) {
      if (verified.targetId !== options.targetId) continue;
      const created = await view.created(verified.checkpointId);
      if (created !== undefined && created.targetId === options.targetId && created.generation !== undefined &&
          canonicalize(created.generation) === canonicalize(generation) &&
          verified.envelopeDigest === created.envelopeDigest && validVerificationSignature(verified, options.trust)) {
        found = { verified, created };
        break;
      }
    }
    return { verifiedPair: found, pending: await view.latestCreated(generation) };
  });
  if (verifiedPair?.created) {
    const created = verifiedPair.created;
    const abort = options.abort ?? new AbortController().signal;
    const envelopeBytes = Buffer.from(await runWithMaintenanceUrgency(
      () => "foreground",
      abort,
      () => runStorageMaintenanceStep(
        options.storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          options.trust.homeId,
          { identity: `local-get:${created.checkpointId}:envelope`, bytes: created.envelopeRef.bytes },
          { obligation: "committed" },
        ),
        () => options.artifacts.get(created.envelopeRef),
      ),
    ));
    const text = envelopeBytes.toString("utf8");
    envelopeBytes.fill(0);
    const envelope = JSON.parse(text) as CheckpointEnvelope;
    if (
      canonicalize(envelope) !== text ||
      envelope.checkpointId !== created.checkpointId ||
      envelope.digest !== created.envelopeDigest ||
      canonicalize(checkpointEnvelopeArtifact(envelope)) !== canonicalize(created.envelopeRef)
    ) {
      throw new TypeError("Stored checkpoint envelope does not match its created fact");
    }
    if (isFullEnvelope(envelope)) {
      return {
        state: "recoverable",
        fullBackupReady: true,
        checkpointId: created.checkpointId,
        targetId: created.targetId,
        createdAt: envelope.createdAt,
        upToLsn: created.upToLsn,
      };
    }
  }
  return pending
    ? {
        state: "pending-verification",
        fullBackupReady: false,
        checkpointId: pending.checkpointId,
        targetId: pending.targetId,
        upToLsn: pending.upToLsn,
      }
    : { state: "not-configured", fullBackupReady: false, targetId: options.targetId };
}

export interface AuthorityCheckpointServiceOptions {
  readonly log: AuthorityCommitLog;
  readonly artifacts: MutableArtifactStore;
  readonly retention: ArtifactCheckpointRetentionPort;
  readonly target: RetirableRecoveryCheckpointTarget;
  readonly resolveTarget?: (
    targetId: string,
    recipientKeyId: string,
  ) => Promise<RecoveryCheckpointTargetSession>;
  readonly trust: HomeTrustRecord;
  readonly issuer: DeviceIdentity & CheckpointSigner;
  readonly recipient: CheckpointRecipient;
  readonly currentAnchor: boolean;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly clock?: () => string;
}

export interface RecoveryCheckpointTargetSession {
  readonly target: RetirableRecoveryCheckpointTarget;
  readonly close: () => Promise<void>;
}

export class AuthorityCheckpointService {
  readonly #clock: () => string;

  constructor(private readonly options: AuthorityCheckpointServiceOptions) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  candidateKey(request: RecoveryCheckpointRequest): string {
    this.#assertEnabled();
    return protocolDigest("RecoveryCheckpointCandidate", 1, {
      generation: this.#generation(),
      request,
    });
  }

  async createAndReplicate(input: {
    readonly checkpointId?: string;
    readonly createdAt?: string;
    readonly purpose?: CheckpointEnvelope["manifest"]["purpose"];
    readonly request?: RecoveryCheckpointRequest;
    readonly abort?: AbortSignal;
  } = {}): Promise<CheckpointPackage> {
    this.#assertEnabled();
    const generation = this.#generation();
    const request = input.request ?? {
      kind: "forced" as const,
      requestId: `checkpoint:${input.checkpointId ?? "manual"}`,
    };
    const existing = await this.#createdFor(generation, request);
    if (existing) {
      this.#assertCreatedForCurrentTarget(existing);
      const checkpoint = await this.#loadLocalPackage(existing, input.abort);
      await this.#replicate(checkpoint, existing, input.abort);
      return checkpoint;
    }

    const createdAt = input.createdAt ?? this.#clock();
    const captured = await captureFullAuthorityCheckpoint({
      ...(input.checkpointId
        ? { checkpointId: input.checkpointId }
        : {
            captureIdentity: protocolDigest("RecoveryCheckpointCandidate", 1, { generation, request }),
            checkpointIdForSource: (source) => deriveCheckpointId(
              protocolDigest("RecoveryCheckpointIdentity", 1, { generation, request, source }),
              request.kind === "daily" ? Date.parse(`${request.day}T00:00:00.000Z`) : 0,
            ),
          }),
      createdAt,
      purpose: input.purpose ?? { kind: "periodic" },
      trust: this.options.trust,
      issuer: this.options.issuer,
      recipient: this.options.recipient,
      log: this.options.log,
      artifacts: this.options.artifacts,
      retention: this.options.retention,
      ...(this.options.storageMaintenance
        ? { storageMaintenance: this.options.storageMaintenance }
        : {}),
      ...(input.abort ? { abort: input.abort } : {}),
    });
    const envelopeRef = await this.#persistLocalPackage(captured.checkpoint, input.abort);
    const checkpointId = captured.checkpoint.envelope.checkpointId;
    const created: Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> = {
      t: "checkpoint-created",
      checkpointId,
      recipientKeyId: captured.checkpoint.envelope.recipientKeyId,
      purpose: checkpointPurpose(captured.checkpoint.envelope),
      envelopeRef,
      upToLsn: captured.checkpoint.envelope.manifest.upToLsn,
      envelopeDigest: captured.checkpoint.envelope.digest,
      targetId: this.options.target.targetId,
      generation,
      request,
      source: { ...captured.source.payload.source },
    };
    await appendCheckpointRecords(this.options.log, [created]);
    await this.#replicate(captured.checkpoint, created, input.abort);
    return captured.checkpoint;
  }

  async verify(input: {
    readonly checkpointId: string;
    readonly recoveryRoot: RecoveryRoot;
    readonly verifiedAt?: string;
  }): Promise<RecoveryCheckpointVerification> {
    this.#assertEnabled();
    const created = await this.#created(input.checkpointId);
    if (!created) throw new Error("Recovery backup has not been created");
    this.#assertCreatedAuthority(created);
    // 同一视图：该 checkpoint 已有的 verified（按先后的第一个），以及当前未被取代的 verified（最新在前）
    const { existing, current, replicated } = await readCheckpointLifecycle(this.options.log, async (view) => ({
      existing: (await view.verifiedOfCheckpoint(input.checkpointId))[0],
      current: await view.currentVerified(created.recipientKeyId),
      replicated: created.targetId ? await view.replicated(input.checkpointId, created.targetId) : undefined,
    }));
    let opened: Awaited<ReturnType<typeof verifyStoredFullAuthorityCheckpoint>> | undefined;
    let targetSession: RecoveryCheckpointTargetSession | undefined;
    try {
      targetSession = await this.#target(created.targetId, created.recipientKeyId);
      const target = targetSession.target;
      const checkpoint = await target.read(input.checkpointId);
      opened = await verifyStoredFullAuthorityCheckpoint({
        package: checkpoint,
        recoveryRoot: input.recoveryRoot,
        issuer: this.options.issuer,
      });
      assertFullBinding(created, checkpoint, opened.payload, this.options.trust);
      if (existing) {
        verifyRecoveryCheckpointVerification({
          verification: existing.verification,
          envelope: checkpoint.envelope,
          targetId: created.targetId!,
          verificationNonce: opened.verificationNonce,
          recoveryRootPublicKey: input.recoveryRoot.rootPublicKey,
        });
        return existing.verification;
      }
      if (!replicated) throw new Error("Recovery backup has not reached its configured target");
      const verifiedAt = input.verifiedAt ?? this.#clock();
      const verification = createRecoveryCheckpointVerification({
        envelope: checkpoint.envelope,
        targetId: created.targetId!,
        verificationNonce: opened.verificationNonce,
        verifiedAt,
        recoveryRoot: input.recoveryRoot,
      });
      verifyRecoveryCheckpointVerification({
        verification,
        envelope: checkpoint.envelope,
        targetId: created.targetId!,
        verificationNonce: opened.verificationNonce,
        recoveryRootPublicKey: input.recoveryRoot.rootPublicKey,
      });
      const superseded = [...current].reverse()
        .filter((record) => record.checkpointId !== input.checkpointId)
        .map<Extract<CheckpointStreamRecord, { t: "checkpoint-superseded" }>>((record) => ({
          t: "checkpoint-superseded",
          checkpointId: record.checkpointId,
          supersededBy: input.checkpointId,
          at: verifiedAt,
        }));
      await appendCheckpointRecords(this.options.log, [
        {
          t: "checkpoint-verified",
          checkpointId: input.checkpointId,
          recipientKeyId: created.recipientKeyId,
          purpose: created.purpose,
          targetId: created.targetId!,
          envelopeDigest: created.envelopeDigest,
          verification,
        },
        ...superseded,
      ]);
      return verification;
    } catch (error) {
      if (!existing) {
        await appendCheckpointRecords(this.options.log, [{
          t: "checkpoint-verify-failed",
          checkpointId: input.checkpointId,
          recipientKeyId: created.recipientKeyId,
          purpose: created.purpose,
          targetId: created.targetId!,
          envelopeDigest: created.envelopeDigest,
          reason: checkpointVerificationFailureCode(error),
          at: input.verifiedAt ?? this.#clock(),
        }]);
      }
      throw error;
    } finally {
      opened?.verificationNonce.fill(0);
      await targetSession?.close();
    }
  }

  async status(): Promise<RecoveryBackupStatus> {
    return projectDurableRecoveryBackupStatus({
      log: this.options.log,
      artifacts: this.options.artifacts,
      trust: this.options.trust,
      currentAnchor: this.options.currentAnchor,
      targetId: this.options.target.targetId,
      ...(this.options.storageMaintenance
        ? { storageMaintenance: this.options.storageMaintenance }
        : {}),
    });
  }

  /** Returns the newest durable target copy, including a terminal replay candidate. */
  async verificationCandidate(): Promise<RecoveryCheckpointVerificationCandidate | undefined> {
    this.#assertEnabled();
    const generation = this.#generation();
    // 当前代际（root/recipient/trustChainHead）已复制的 created 中按 created 先后最新的一个，投影里按键维护
    return readCheckpointLifecycle(this.options.log, (view) => view.latestReplicated(generation));
  }

  async cleanupExpired(now = this.#clock(), abort?: AbortSignal): Promise<void> {
    // 只读已过保留期、目标尚未退役的待清理项（投影里按取代时间排序，退役后即移出）
    const due = await readCheckpointLifecycle(this.options.log, async (view) => {
      const items: { record: { checkpointId: string; supersededBy: string }; created: Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> }[] = [];
      for (const item of await view.cleanupDue(Date.parse(now) - RETENTION_MS)) {
        const created = await view.created(item.checkpointId);
        if (created?.targetId === item.targetId) items.push({ record: item, created });
      }
      return items;
    });
    for (const { record, created } of due) {
      if (!created.targetId) continue;
      {
        const targetSession = await this.#target(created.targetId, created.recipientKeyId);
        try {
          const target = targetSession.target;
          await target.retire(record.checkpointId, record.supersededBy, abort);
          throwIfAborted(abort);
          await appendCheckpointRecords(this.options.log, [{
            t: "checkpoint-cleanup-progress",
            checkpointId: record.checkpointId,
            supersededBy: record.supersededBy,
            targetId: created.targetId,
            phase: "target-retired",
            at: now,
          }]);
        } finally {
          await targetSession.close();
        }
      }
    }
  }

  /** Replays all durable created obligations against their original target binding. */
  async recoverPending(abort?: AbortSignal): Promise<void> {
    // 只读待复制的 created（有目标与代际、尚未复制），按 created 先后
    for (const created of await readCheckpointLifecycle(this.options.log, (view) => view.pendingReplication())) {
      if (!created.targetId || !created.generation) continue;
      const checkpoint = await this.#loadLocalPackage(created, abort);
      const targetSession = await this.#target(created.targetId, created.recipientKeyId);
      try {
        await this.#replicate(checkpoint, created, abort, targetSession.target);
      } finally {
        await targetSession.close();
      }
    }
  }

  async #replicate(
    checkpoint: CheckpointPackage,
    created: Extract<CheckpointStreamRecord, { t: "checkpoint-created" }>,
    abort?: AbortSignal,
    target: RetirableRecoveryCheckpointTarget = this.options.target,
  ): Promise<void> {
    if (abort?.aborted) throw abort.reason ?? new Error("Recovery backup was cancelled");
    await target.writeDurable(checkpoint, abort);
    if (abort?.aborted) throw abort.reason ?? new Error("Recovery backup was cancelled");
    const existing = await readCheckpointLifecycle(this.options.log, (view) => view.replicated(created.checkpointId, target.targetId));
    if (existing) {
      if (
        existing.recipientKeyId !== created.recipientKeyId ||
        existing.envelopeDigest !== created.envelopeDigest ||
        canonicalize(existing.purpose) !== canonicalize(created.purpose)
      ) throw new TypeError("Checkpoint replication replay conflicts with durable state");
      return;
    }
    await appendCheckpointRecords(this.options.log, [{
      t: "checkpoint-replicated",
      checkpointId: created.checkpointId,
      recipientKeyId: created.recipientKeyId,
      purpose: created.purpose,
      targetId: target.targetId,
      envelopeDigest: created.envelopeDigest,
      at: this.#clock(),
    }]);
  }

  async #persistLocalPackage(checkpoint: CheckpointPackage, abort?: AbortSignal): Promise<ArtifactRef> {
    for (const descriptor of checkpoint.envelope.chunks) {
      const chunk = await readCheckpointChunk(checkpoint, descriptor.seq, abort);
      try {
        const stored = await this.#artifactStep(
          `local-put:${checkpoint.envelope.checkpointId}:${descriptor.seq}`,
          descriptor.bytes,
          abort,
          () => this.options.artifacts.put(chunk),
        );
        if (canonicalize(stored) !== canonicalize({ digest: descriptor.digest, bytes: descriptor.bytes })) {
          throw new TypeError("Checkpoint chunk changed while entering the local artifact store");
        }
      } finally {
        chunk.fill(0);
      }
    }
    const bytes = Buffer.from(canonicalize(checkpoint.envelope), "utf8");
    const stored = await this.#artifactStep(
      `local-put:${checkpoint.envelope.checkpointId}:envelope`,
      bytes.byteLength,
      abort,
      () => this.options.artifacts.put(bytes),
    );
    if (canonicalize(stored) !== canonicalize(checkpointEnvelopeArtifact(checkpoint.envelope))) {
      throw new TypeError("Checkpoint envelope changed while entering the local artifact store");
    }
    return stored;
  }

  async #loadLocalPackage(
    created: Extract<CheckpointStreamRecord, { t: "checkpoint-created" }>,
    abort?: AbortSignal,
  ): Promise<CheckpointPackage> {
    const envelopeBytes = Buffer.from(await this.#artifactStep(
      `local-get:${created.checkpointId}:envelope`,
      created.envelopeRef.bytes,
      abort,
      () => this.options.artifacts.get(created.envelopeRef),
    ));
    const text = envelopeBytes.toString("utf8");
    envelopeBytes.fill(0);
    const envelope = JSON.parse(text) as CheckpointEnvelope;
    if (
      canonicalize(envelope) !== text ||
      envelope.checkpointId !== created.checkpointId ||
      envelope.digest !== created.envelopeDigest ||
      canonicalize(checkpointEnvelopeArtifact(envelope)) !== canonicalize(created.envelopeRef)
    ) throw new TypeError("Stored checkpoint envelope does not match its created fact");
    return {
      envelope,
      source: {
        read: (seq, offset, limit, signal) => {
          const descriptor = envelope.chunks[seq];
          if (!descriptor || descriptor.seq !== seq) {
            return Promise.reject(new TypeError("Stored checkpoint chunk sequence is invalid"));
          }
          return this.#artifactStep(
            `local-get:${created.checkpointId}:${seq}:${offset}`,
            Math.min(limit, Math.max(0, descriptor.bytes - offset)),
            signal ?? abort,
            () => this.options.artifacts.readRange(
              { digest: descriptor.digest, bytes: descriptor.bytes },
              offset,
              limit,
            ),
          );
        },
      },
    };
  }

  #artifactStep<T>(
    identity: string,
    bytes: number,
    abort: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const signal = abort ?? new AbortController().signal;
    return runWithMaintenanceUrgency(() => "foreground", signal, () =>
      runStorageMaintenanceStep(
        this.options.storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          this.options.trust.homeId,
          { identity, bytes },
          { obligation: "committed" },
        ),
        operation,
      ));
  }

  #created(checkpointId: string): Promise<Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> | undefined> {
    return readCheckpointLifecycle(this.options.log, (view) => view.created(checkpointId));
  }

  #createdFor(
    generation: RecoveryCheckpointGeneration,
    request: RecoveryCheckpointRequest,
  ): Promise<Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> | undefined> {
    return readCheckpointLifecycle(this.options.log, (view) => view.createdFor(generation, request));
  }

  #assertCreatedForCurrentTarget(record: Extract<CheckpointStreamRecord, { t: "checkpoint-created" }>): void {
    if (
      record.targetId !== this.options.target.targetId ||
      record.recipientKeyId !== this.options.recipient.backupKeyId ||
      !record.generation ||
      !record.source ||
      !record.request ||
      canonicalize(record.generation) !== canonicalize(this.#generation())
    ) throw new TypeError("Checkpoint replay belongs to another recovery target or root");
  }

  #assertCreatedAuthority(record: Extract<CheckpointStreamRecord, { t: "checkpoint-created" }>): void {
    if (
      !record.targetId ||
      !record.generation ||
      record.generation.targetId !== record.targetId ||
      record.recipientKeyId !== this.options.recipient.backupKeyId ||
      !sameAuthorityGeneration(record.generation, this.#generation()) ||
      !record.source ||
      !record.request
    ) throw new TypeError("Checkpoint replay belongs to another recovery root or authority generation");
  }

  #target(targetId: string | undefined, recipientKeyId: string): Promise<RecoveryCheckpointTargetSession> {
    if (!targetId) return Promise.reject(new TypeError("Checkpoint target binding is missing"));
    if (
      targetId === this.options.target.targetId &&
      recipientKeyId === this.options.recipient.backupKeyId
    ) return Promise.resolve(Object.freeze({
      target: this.options.target,
      close: async () => undefined,
    }));
    if (!this.options.resolveTarget) return Promise.reject(new Error("Recovery checkpoint target binding is unavailable"));
    return this.options.resolveTarget(targetId, recipientKeyId);
  }

  #generation(): RecoveryCheckpointGeneration {
    if (!this.options.trust.recoveryRootPublicKey) {
      throw new Error("Recovery backup requires the current recovery root");
    }
    return {
      rootKeyId: keyIdForPublicKey(this.options.trust.recoveryRootPublicKey),
      recipientKeyId: this.options.recipient.backupKeyId,
      trustChainHead: { ...this.options.trust.chainHead },
      targetId: this.options.target.targetId,
    };
  }

  #assertEnabled(): void {
    if (!this.options.currentAnchor) throw new Error("Recovery backup is owned by the current anchor");
    if (
      !this.options.trust.recoveryBackupPublicKey ||
      keyIdForPublicKey(this.options.trust.recoveryBackupPublicKey) !==
        this.options.recipient.backupKeyId
    ) throw new Error("Recovery backup requires the current recovery root");
  }
}

async function appendCheckpointRecords(
  log: AuthorityCommitLog,
  records: readonly CheckpointStreamRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const candidateReferences = records
    .filter((record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> =>
      record.t === "checkpoint-created")
    .map((record) => record.envelopeRef);
  // 按记录键在生命周期投影上去重：同键同内容跳过，同键不同内容即为冲突；不再从 LSN 0 重放 checkpoint 流
  registerCheckpointLifecycleIndex(log);
  await log.transactDurableProjection<CheckpointStreamRecord, void>(
    CHECKPOINT_LIFECYCLE_PROJECTION_ID,
    async (current) => {
      const view = new CheckpointLifecycleView(current);
      const batch = new Map<string, CheckpointStreamRecord>();
      const entries = [];
      for (const record of records) {
        const key = checkpointRecordKey(record);
        const existing = batch.get(key) ?? await view.fact(key, record.t);
        if (existing) {
          if (canonicalize(existing) !== canonicalize(record)) {
            throw new TypeError("Checkpoint lifecycle replay conflicts with durable state");
          }
          continue;
        }
        // 本地释放阶段不留事实，与原重放口径一致
        if (!(record.t === "checkpoint-cleanup-progress" && record.phase === "local-released")) batch.set(key, record);
        entries.push({ stream: "checkpoint", body: record });
      }
      return entries.length === 0
        ? { kind: "return", value: undefined }
        : { kind: "append", entries, value: undefined };
    },
    candidateReferences.length > 0 ? { candidateReferences } : undefined,
  );
}

function assertFullBinding(
  created: Extract<CheckpointStreamRecord, { t: "checkpoint-created" }>,
  checkpoint: CheckpointPackage,
  payload: import("@zhixing/core/contracts").FullAuthorityCheckpointPayload,
  trust: HomeTrustRecord,
): void {
  if (
    checkpoint.envelope.checkpointId !== created.checkpointId ||
    checkpoint.envelope.digest !== created.envelopeDigest ||
    payload.checkpointId !== created.checkpointId ||
    payload.recipientKeyId !== created.recipientKeyId ||
    payload.homeId !== trust.homeId ||
    payload.trustChainHead.seq !== trust.chainHead.seq ||
    payload.trustChainHead.eventDigest !== trust.chainHead.eventDigest ||
    canonicalize(payload.source) !== canonicalize(created.source) ||
    canonicalize(created.generation) !== canonicalize({
      rootKeyId: keyIdForPublicKey(trust.recoveryRootPublicKey!),
      recipientKeyId: created.recipientKeyId,
      trustChainHead: trust.chainHead,
      targetId: created.targetId,
    }) ||
    canonicalize(payload.coverage.classes) !== canonicalize(FULL_SCOPE)
  ) throw new TypeError("Recovery backup payload does not match its durable lifecycle facts");
}

function sameAuthorityGeneration(
  left: RecoveryCheckpointGeneration,
  right: RecoveryCheckpointGeneration,
): boolean {
  return left.rootKeyId === right.rootKeyId &&
    left.recipientKeyId === right.recipientKeyId &&
    canonicalize(left.trustChainHead) === canonicalize(right.trustChainHead);
}

function validVerificationSignature(
  record: Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }>,
  trust: HomeTrustRecord,
): boolean {
  if (!trust.recoveryRootPublicKey) return false;
  const { signature, ...unsigned } = record.verification;
  try {
    verifyRecoverySignature(
      trust.recoveryRootPublicKey,
      "RecoveryCheckpointVerification",
      1,
      unsigned,
      signature,
    );
    return true;
  } catch {
    return false;
  }
}

function isFullEnvelope(envelope: CheckpointEnvelope): boolean {
  return canonicalize(envelope.manifest.scope) === canonicalize(FULL_SCOPE);
}

function checkpointVerificationFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("target") || message.includes("connection") || message.includes("unavailable")) {
    return "target-unavailable";
  }
  if (message.includes("package") || message.includes("envelope") || message.includes("chunk") ||
    message.includes("decrypt") || message.includes("signature")) return "package-invalid";
  if (message.includes("checkpoint") || message.includes("binding") || message.includes("recipient")) {
    return "checkpoint-mismatch";
  }
  return "verification-failed";
}

function throwIfAborted(abort: AbortSignal | undefined): void {
  if (abort?.aborted) throw abort.reason ?? new Error("Recovery backup was cancelled");
}
