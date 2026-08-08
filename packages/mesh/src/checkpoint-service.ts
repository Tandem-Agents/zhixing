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
  openFullAuthorityCheckpoint,
  verifyRecoveryCheckpointVerification,
  type CheckpointPackage,
  type CheckpointRecipient,
  type CheckpointSigner,
} from "./checkpoint.js";
import { captureFullAuthorityCheckpoint } from "./full-checkpoint.js";
import type { RetirableRecoveryCheckpointTarget } from "./checkpoint-target.js";
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

export interface AuthorityCheckpointServiceOptions {
  readonly log: AuthorityCommitLog;
  readonly artifacts: MutableArtifactStore;
  readonly retention: ArtifactCheckpointRetentionPort;
  readonly target: RetirableRecoveryCheckpointTarget;
  readonly resolveTarget?: (
    targetId: string,
    recipientKeyId: string,
  ) => Promise<RetirableRecoveryCheckpointTarget>;
  readonly trust: HomeTrustRecord;
  readonly issuer: DeviceIdentity & CheckpointSigner;
  readonly recipient: CheckpointRecipient;
  readonly currentAnchor: boolean;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly clock?: () => string;
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
      this.#assertCreatedBinding(existing);
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
    this.#assertCreatedBinding(created);
    const records = await this.#records();
    const existing = records.find((record): record is Extract<
      CheckpointStreamRecord,
      { t: "checkpoint-verified" }
    > => record.t === "checkpoint-verified" && record.checkpointId === input.checkpointId);
    let opened: ReturnType<typeof openFullAuthorityCheckpoint> | undefined;
    try {
      const target = await this.#target(created.targetId, created.recipientKeyId);
      const checkpoint = await target.read(input.checkpointId);
      opened = await this.#artifactStep(
        `open:${input.checkpointId}`,
        checkpoint.chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0),
        undefined,
        async () => openFullAuthorityCheckpoint({
          package: checkpoint,
          recoveryRoot: input.recoveryRoot,
          issuer: this.options.issuer,
        }),
      );
      assertFullBinding(created, checkpoint, opened.payload, this.options.trust);
      if (existing) {
        verifyRecoveryCheckpointVerification({
          verification: existing.verification,
          envelope: checkpoint.envelope,
          targetId: this.options.target.targetId,
          verificationNonce: opened.verificationNonce,
          recoveryRootPublicKey: input.recoveryRoot.rootPublicKey,
        });
        return existing.verification;
      }
      const replicated = records.find((record) =>
        record.t === "checkpoint-replicated" &&
        record.checkpointId === input.checkpointId &&
        record.targetId === this.options.target.targetId);
      if (!replicated) throw new Error("Recovery backup has not reached its configured target");
      const verifiedAt = input.verifiedAt ?? this.#clock();
      const verification = createRecoveryCheckpointVerification({
        envelope: checkpoint.envelope,
        targetId: this.options.target.targetId,
        verificationNonce: opened.verificationNonce,
        verifiedAt,
        recoveryRoot: input.recoveryRoot,
      });
      verifyRecoveryCheckpointVerification({
        verification,
        envelope: checkpoint.envelope,
        targetId: this.options.target.targetId,
        verificationNonce: opened.verificationNonce,
        recoveryRootPublicKey: input.recoveryRoot.rootPublicKey,
      });
      const superseded = currentFullVerified(records, created.recipientKeyId)
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
          targetId: this.options.target.targetId,
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
          targetId: this.options.target.targetId,
          envelopeDigest: created.envelopeDigest,
          reason: checkpointVerificationFailureCode(error),
          at: input.verifiedAt ?? this.#clock(),
        }]);
      }
      throw error;
    } finally {
      opened?.verificationNonce.fill(0);
      for (const page of opened?.recordPages ?? []) page.fill(0);
      for (const artifact of opened?.retainedArtifacts ?? []) artifact.fill(0);
    }
  }

  async status(): Promise<RecoveryBackupStatus> {
    if (!this.options.currentAnchor) return { state: "not-configured", fullBackupReady: false };
    if (!this.options.trust.recoveryBackupPublicKey) {
      return { state: "not-configured", fullBackupReady: false };
    }
    const records = await this.#records();
    const recipientKeyId = keyIdForPublicKey(this.options.trust.recoveryBackupPublicKey);
    const generation = this.#generation();
    const verifiedPair = currentFullVerified(records, recipientKeyId)
      .toReversed()
      .map((verified) => ({
        verified,
        created: records.find((record): record is Extract<
          CheckpointStreamRecord,
          { t: "checkpoint-created" }
        > => record.t === "checkpoint-created" &&
          record.checkpointId === verified.checkpointId &&
          canonicalize(record.generation) === canonicalize(generation)),
      }))
      .find(({ created, verified }) =>
        created?.targetId !== undefined && validVerificationSignature(verified, this.options.trust));
    if (verifiedPair?.created) {
      const created = verifiedPair.created;
        const checkpoint = await this.#loadLocalPackage(created);
        if (isFullEnvelope(checkpoint.envelope)) {
          return {
            state: "recoverable",
            fullBackupReady: true,
            checkpointId: created.checkpointId,
            targetId: created.targetId,
            createdAt: checkpoint.envelope.createdAt,
            upToLsn: created.upToLsn,
          };
        }
    }
    const pending = [...records].reverse().find((record): record is Extract<
      CheckpointStreamRecord,
      { t: "checkpoint-created" }
    > =>
      record.t === "checkpoint-created" &&
      canonicalize(record.generation) === canonicalize(generation));
    return pending
      ? {
          state: "pending-verification",
          fullBackupReady: false,
          checkpointId: pending.checkpointId,
          targetId: pending.targetId,
          upToLsn: pending.upToLsn,
        }
      : { state: "not-configured", fullBackupReady: false };
  }

  /** Returns the newest durable target copy, including a terminal replay candidate. */
  async verificationCandidate(): Promise<string | undefined> {
    this.#assertEnabled();
    const records = await this.#records();
    const generation = this.#generation();
    const replicated = new Set(records
      .filter((record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-replicated" }> =>
        record.t === "checkpoint-replicated" &&
        record.targetId === this.options.target.targetId &&
        record.recipientKeyId === this.options.recipient.backupKeyId)
      .map((record) => record.checkpointId));
    return [...records].reverse().find((record): record is Extract<
      CheckpointStreamRecord,
      { t: "checkpoint-created" }
    > => record.t === "checkpoint-created" &&
      canonicalize(record.generation) === canonicalize(generation) &&
      replicated.has(record.checkpointId))?.checkpointId;
  }

  async cleanupExpired(now = this.#clock(), abort?: AbortSignal): Promise<void> {
    const records = await this.#records();
    const nowMs = Date.parse(now);
    for (const record of records) {
      if (
        record.t !== "checkpoint-superseded" ||
        nowMs - Date.parse(record.at) < RETENTION_MS
      ) continue;
      const created = records.find((candidate): candidate is Extract<
        CheckpointStreamRecord,
        { t: "checkpoint-created" }
      > => candidate.t === "checkpoint-created" && candidate.checkpointId === record.checkpointId);
      if (!created?.targetId) continue;
      const targetRetired = records.some((candidate) =>
        candidate.t === "checkpoint-cleanup-progress" &&
        candidate.checkpointId === record.checkpointId &&
        candidate.supersededBy === record.supersededBy &&
        candidate.targetId === created.targetId &&
        candidate.phase === "target-retired");
      if (!targetRetired) {
        const target = await this.#target(created.targetId, created.recipientKeyId);
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
      }
      const latest = await this.#records();
      if (latest.some((candidate) => candidate.t === "checkpoint-cleanup-progress" &&
        candidate.checkpointId === record.checkpointId && candidate.phase === "local-released")) continue;
      const snapshot = await this.options.retention.checkpointRetentionSnapshot();
      const retained = await this.options.retention.retainedAtCheckpoint(snapshot, [created.envelopeRef]);
      if (retained.status !== "current" || retained.retained.length > 0) continue;
      await appendCheckpointRecords(this.options.log, [{
        t: "checkpoint-cleanup-progress",
        checkpointId: record.checkpointId,
        supersededBy: record.supersededBy,
        targetId: created.targetId,
        phase: "local-released",
        at: now,
      }]);
    }
  }

  /** Replays all durable created obligations against their original target binding. */
  async recoverPending(abort?: AbortSignal): Promise<void> {
    const records = await this.#records();
    for (const created of records) {
      if (created.t !== "checkpoint-created" || !created.targetId || !created.generation) continue;
      if (records.some((record) => record.t === "checkpoint-replicated" &&
        record.checkpointId === created.checkpointId && record.targetId === created.targetId)) continue;
      const checkpoint = await this.#loadLocalPackage(created, abort);
      await this.#replicate(checkpoint, created, abort,
        await this.#target(created.targetId, created.recipientKeyId));
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
    const existing = (await this.#records()).find((record): record is Extract<
      CheckpointStreamRecord,
      { t: "checkpoint-replicated" }
    > => record.t === "checkpoint-replicated" &&
      record.checkpointId === created.checkpointId &&
      record.targetId === target.targetId);
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
      const chunk = checkpoint.chunks.find((candidate) => candidate.seq === descriptor.seq);
      if (!chunk) throw new TypeError("Checkpoint package has an incomplete chunk exact-set");
      const stored = await this.#artifactStep(
        `local-put:${checkpoint.envelope.checkpointId}:${descriptor.seq}`,
        descriptor.bytes,
        abort,
        () => this.options.artifacts.put(chunk.bytes),
      );
      if (canonicalize(stored) !== canonicalize({ digest: descriptor.digest, bytes: descriptor.bytes })) {
        throw new TypeError("Checkpoint chunk changed while entering the local artifact store");
      }
    }
    if (checkpoint.chunks.length !== checkpoint.envelope.chunks.length) {
      throw new TypeError("Checkpoint package contains undeclared chunks");
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
    const envelopeBytes = await this.#artifactStep(
      `local-get:${created.checkpointId}:envelope`,
      created.envelopeRef.bytes,
      abort,
      () => this.options.artifacts.get(created.envelopeRef),
    );
    const text = Buffer.from(envelopeBytes).toString("utf8");
    const envelope = JSON.parse(text) as CheckpointEnvelope;
    if (
      canonicalize(envelope) !== text ||
      envelope.checkpointId !== created.checkpointId ||
      envelope.digest !== created.envelopeDigest ||
      canonicalize(checkpointEnvelopeArtifact(envelope)) !== canonicalize(created.envelopeRef)
    ) throw new TypeError("Stored checkpoint envelope does not match its created fact");
    const chunks = await Promise.all(envelope.chunks.map(async (descriptor) => ({
      seq: descriptor.seq,
      bytes: await this.#artifactStep(
        `local-get:${created.checkpointId}:${descriptor.seq}`,
        descriptor.bytes,
        abort,
        () => this.options.artifacts.get({ digest: descriptor.digest, bytes: descriptor.bytes }),
      ),
    })));
    return { envelope, chunks };
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

  async #records(): Promise<readonly CheckpointStreamRecord[]> {
    return (await this.options.log.readStream<CheckpointStreamRecord>("checkpoint"))
      .map((entry) => entry.body);
  }

  async #created(checkpointId: string): Promise<Extract<
    CheckpointStreamRecord,
    { t: "checkpoint-created" }
  > | undefined> {
    return (await this.#records()).find((record): record is Extract<
      CheckpointStreamRecord,
      { t: "checkpoint-created" }
    > => record.t === "checkpoint-created" && record.checkpointId === checkpointId);
  }

  async #createdFor(
    generation: RecoveryCheckpointGeneration,
    request: RecoveryCheckpointRequest,
  ): Promise<Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> | undefined> {
    return (await this.#records()).find((record): record is Extract<
      CheckpointStreamRecord,
      { t: "checkpoint-created" }
    > => record.t === "checkpoint-created" &&
      canonicalize(record.generation) === canonicalize(generation) &&
      canonicalize(record.request) === canonicalize(request));
  }

  #assertCreatedBinding(record: Extract<CheckpointStreamRecord, { t: "checkpoint-created" }>): void {
    if (
      record.targetId !== this.options.target.targetId ||
      record.recipientKeyId !== this.options.recipient.backupKeyId ||
      canonicalize(record.generation) !== canonicalize(this.#generation()) ||
      !record.source || !record.request
    ) throw new TypeError("Checkpoint replay belongs to another recovery target or root");
  }

  #target(targetId: string | undefined, recipientKeyId: string): Promise<RetirableRecoveryCheckpointTarget> {
    if (!targetId) return Promise.reject(new TypeError("Checkpoint target binding is missing"));
    if (targetId === this.options.target.targetId) return Promise.resolve(this.options.target);
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
  await log.transactProjection<readonly CheckpointStreamRecord[], CheckpointStreamRecord, void>(
    [],
    (state, record) => record.stream === "checkpoint" ? reduceRecords(state, record.body) : state,
    (state) => {
      let next = state;
      const entries = [];
      for (const record of records) {
        const existing = next.find((candidate) => checkpointRecordKey(candidate) === checkpointRecordKey(record));
        if (existing) {
          if (canonicalize(existing) !== canonicalize(record)) {
            throw new TypeError("Checkpoint lifecycle replay conflicts with durable state");
          }
          continue;
        }
        next = reduceRecords(next, record);
        entries.push({ stream: "checkpoint", body: record });
      }
      return entries.length === 0
        ? { kind: "return", value: undefined }
        : { kind: "append", entries, value: undefined };
    },
    {
      stream: "checkpoint",
      ...(candidateReferences.length > 0 ? { candidateReferences } : {}),
    },
  );
}

function reduceRecords(
  state: readonly CheckpointStreamRecord[],
  record: CheckpointStreamRecord,
): readonly CheckpointStreamRecord[] {
  const existing = state.find((candidate) => checkpointRecordKey(candidate) === checkpointRecordKey(record));
  if (!existing) return [...state, record];
  if (canonicalize(existing) !== canonicalize(record)) {
    throw new TypeError("Checkpoint lifecycle contains conflicting durable facts");
  }
  return state;
}

function checkpointRecordKey(record: CheckpointStreamRecord): string {
  switch (record.t) {
    case "checkpoint-created":
    case "checkpoint-superseded":
      return `${record.t}:${record.checkpointId}`;
    case "checkpoint-cleanup-progress":
      return `${record.t}:${record.checkpointId}:${record.targetId}:${record.phase}`;
    case "checkpoint-replicated":
    case "checkpoint-verified":
      return `${record.t}:${record.checkpointId}:${record.targetId}`;
    case "checkpoint-verify-failed":
      return `${record.t}:${canonicalize(record)}`;
  }
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

function currentFullVerified(
  records: readonly CheckpointStreamRecord[],
  recipientKeyId: string,
): Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }>[] {
  const superseded = new Set(records
    .filter((record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-superseded" }> =>
      record.t === "checkpoint-superseded")
    .map((record) => record.checkpointId));
  return records.filter((record): record is Extract<
    CheckpointStreamRecord,
    { t: "checkpoint-verified" }
  > => record.t === "checkpoint-verified" &&
    record.recipientKeyId === recipientKeyId &&
    !superseded.has(record.checkpointId));
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
