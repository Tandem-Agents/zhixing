import type {
  ArtifactRef,
  CheckpointEnvelope,
  CommitEnvelope,
  DeviceIdentity,
  FullAuthorityCheckpointPayload,
  HomeTrustRecord,
  LogicalRecord,
} from "@zhixing/core/contracts";
import { createHash } from "node:crypto";
import {
  classifyRegisteredArtifactReferences,
  classifyRetainedRecordReferences,
  collectRegisteredArtifactRoots,
  type ArtifactStore,
  type ArtifactCheckpointRetentionPort,
  type AuthorityCommitLog,
  type DurableLogCheckpoint,
} from "@zhixing/core/authority";
import {
  runStorageMaintenanceStep,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import { byteDigest, canonicalize, protocolDigest } from "./canonical.js";
import {
  createStoredFullAuthorityCheckpoint,
  type CheckpointPackage,
  type CheckpointRecipient,
  type CheckpointSigner,
} from "./checkpoint.js";

const RECORD_PAGE_COMMITS = 64;
const CHECKPOINT_CHUNK_BYTES = 1024 * 1024;
const MAX_REGISTERED_ROOT_BYTES = 1024 * 1024;
const MAX_RETENTION_SNAPSHOT_ATTEMPTS = 4;
const COVERAGE = Object.freeze([
  "global-authority",
  "conversation-authority",
  "conversation-content",
  "execution-assets",
] as const);

export interface FullAuthorityCheckpointCaptureOptions {
  readonly checkpointId?: string;
  readonly checkpointIdForSource?: (source: DurableLogCheckpoint) => string;
  readonly captureIdentity?: string;
  readonly createdAt: string;
  readonly purpose: CheckpointEnvelope["manifest"]["purpose"];
  readonly trust: HomeTrustRecord;
  readonly issuer: DeviceIdentity & CheckpointSigner;
  readonly recipient: CheckpointRecipient;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly retention: ArtifactCheckpointRetentionPort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly abort?: AbortSignal;
}

export interface CapturedFullAuthorityCheckpoint {
  readonly checkpoint: CheckpointPackage;
  readonly source: { readonly payload: FullAuthorityCheckpointPayload };
}

/** Captures one exact authority-log prefix and the retained artifact closure it names. */
export async function captureFullAuthorityCheckpoint(
  input: FullAuthorityCheckpointCaptureOptions,
): Promise<CapturedFullAuthorityCheckpoint> {
  for (let attempt = 0; attempt < MAX_RETENTION_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      return await captureFullAuthorityCheckpointAttempt(input);
    } catch (error) {
      if (!(error instanceof RetentionSnapshotMoved)) throw error;
    }
  }
  throw new Error("Artifact retention source changed repeatedly while capturing a checkpoint");
}

async function captureFullAuthorityCheckpointAttempt(
  input: FullAuthorityCheckpointCaptureOptions,
): Promise<CapturedFullAuthorityCheckpoint> {
  const abort = input.abort ?? new AbortController().signal;
  return runWithMaintenanceUrgency(() => "foreground", abort, async () => {
    throwIfAborted(abort);
    const retentionSnapshot = await runStep(input, "retention-heads", 1, () =>
      input.retention.checkpointRetentionSnapshot(),
    );
    const origin = await runStep(input, "origin", 1, () => input.log.originCheckpoint());
    const target = retentionSnapshot.sourceHeads[origin.logId];
    if (!target) throw new TypeError("Artifact retention snapshot does not contain the authority log");
    if ((input.checkpointId === undefined) === (input.checkpointIdForSource === undefined)) {
      throw new TypeError("Authority checkpoint capture requires exactly one checkpoint identity source");
    }
    const checkpointId = input.checkpointId ?? input.checkpointIdForSource!(cloneCheckpoint(target));
    if (origin.logId !== target.logId || origin.lsn > target.lsn) {
      throw new TypeError("Authority checkpoint source has an invalid origin");
    }

    const pageDescriptors: FullAuthorityCheckpointPayload["records"]["pages"][number][] = [];
    const retained = new Map<string, ArtifactRef>();
    const classifiedRoots = new Set<string>();
    const headerBudget = new CheckpointHeaderBudget(input, checkpointId, target);
    let cursor = origin;
    let recordCount = 0;

    while (cursor.lsn < target.lsn) {
      throwIfAborted(abort);
      const pageHash = createHash("sha256");
      pageHash.update("[");
      let firstLsn = 0;
      let lastLsn = 0;
      let pageRecordCount = 0;
      let pageCommitCount = 0;
      let pageBytes = 2;
      while (pageCommitCount < RECORD_PAGE_COMMITS && cursor.lsn < target.lsn) {
        const page = await runStep(input, `log:${cursor.lsn}`, 16 * 1024 * 1024, () =>
          input.log.readTail<unknown>(cursor, 1),
        );
        if (
          page.commits.length !== 1 ||
          page.checkpoint.logId !== target.logId ||
          page.checkpoint.lsn !== cursor.lsn + 1 ||
          page.checkpoint.lsn > target.lsn ||
          page.commits[0]!.lsn !== page.checkpoint.lsn
        ) {
          throw new TypeError("Authority checkpoint source did not advance within its frozen prefix");
        }
        const commit = page.commits[0]!;
        const bytes = Buffer.from(canonicalize(commit), "utf8");
        try {
          if (pageCommitCount > 0) pageHash.update(",");
          pageHash.update(bytes);
          pageBytes += bytes.byteLength + (pageCommitCount > 0 ? 1 : 0);
          firstLsn ||= commit.lsn;
          lastLsn = commit.lsn;
          pageRecordCount += commit.entries.length;
          await collectRetainedCandidates(input, [commit], retained, classifiedRoots, headerBudget);
        } finally {
          bytes.fill(0);
        }
        cursor = page.checkpoint;
        pageCommitCount += 1;
      }
      pageHash.update("]");
      const descriptor = {
        seq: pageDescriptors.length,
        firstLsn,
        lastLsn,
        recordCount: pageRecordCount,
        bytes: pageBytes,
        digest: `sha256:${pageHash.digest("hex")}`,
      };
      headerBudget.addPage(descriptor, pageRecordCount);
      pageDescriptors.push(descriptor);
      recordCount += pageRecordCount;
    }

    if (canonicalize(cursor) !== canonicalize(target)) {
      throw new TypeError("Authority checkpoint source prefix changed while it was captured");
    }
    if (target.lsn > 0) {
      await runStep(input, `verify:${target.lsn}`, 1024 * 1024, () => input.log.readEnvelopeAt(target));
    }

    const retention = await runStep(input, "retention-filter", 1, () =>
      input.retention.retainedAtCheckpoint(retentionSnapshot, [...retained.values()]),
    );
    if (retention.status !== "current") throw new RetentionSnapshotMoved();
    const retainedArtifacts = [...retention.retained].sort(compareRefs);
    const finalHead = await runStep(input, "head-final", 1, () => input.log.checkpoint());
    if (
      finalHead.logId !== target.logId ||
      finalHead.lsn < target.lsn
    ) {
      throw new TypeError("Authority checkpoint source prefix failed final verification");
    }
    if (target.lsn > 0) {
      await runStep(input, `verify-final:${target.lsn}`, 1024 * 1024, () =>
        input.log.readEnvelopeAt(target),
      );
    }

    const payload = checkpointPayload(input, checkpointId, target, pageDescriptors, recordCount, retainedArtifacts);
    assertHeaderBudget(payload);
    const chunkRefs = new Map<number, ArtifactRef>();
    const source = {
      async read(seq: number, offset: number, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
        if (signal?.aborted) throw signal.reason ?? new Error("Checkpoint read was cancelled");
        const ref = chunkRefs.get(seq);
        if (!ref) throw new TypeError("Checkpoint chunk source is incomplete");
        return input.artifacts.readRange(ref, offset, limit);
      },
    };
    const checkpoint = await createStoredFullAuthorityCheckpoint({
      payload,
      recipient: input.recipient,
      issuer: input.issuer,
      plaintextChunks: fullPlaintextChunks(input, target, payload),
      source,
      persistChunk: async (seq, bytes) => {
        const ref = await runStep(input, `local-put:${checkpointId}:${seq}`, bytes.byteLength, () =>
          input.artifacts.put(bytes));
        if (ref.bytes !== bytes.byteLength || ref.digest !== byteDigest(bytes)) {
          throw new TypeError("Encrypted checkpoint chunk changed while entering local CAS");
        }
        chunkRefs.set(seq, ref);
      },
    });
    return {
      source: { payload },
      checkpoint,
    };
  });
}

async function collectRetainedCandidates(
  input: FullAuthorityCheckpointCaptureOptions,
  commits: readonly CommitEnvelope<unknown>[],
  retained: Map<string, ArtifactRef>,
  classifiedRoots: Set<string>,
  headerBudget: CheckpointHeaderBudget,
): Promise<void> {
  for (const commit of commits) {
    for (const entry of commit.entries) {
      if (entry.stream === "checkpoint") continue;
      const record = entry as LogicalRecord<unknown>;
      addClassifiedReferences(retained, classifyRetainedRecordReferences(record), headerBudget);
      for (const root of collectRegisteredArtifactRoots([record])) {
        addRef(retained, root.ref, headerBudget);
        const identity = `${root.schema}:${root.ref.digest}`;
        if (classifiedRoots.has(identity)) continue;
        classifiedRoots.add(identity);
        if (root.ref.bytes > MAX_REGISTERED_ROOT_BYTES) {
          throw new TypeError("Authority checkpoint registered artifact root exceeds the fixed header bound");
        }
        const bytes = await runStep(input, `artifact-root:${identity}`, root.ref.bytes, () =>
          input.artifacts.readRange(root.ref, 0, Math.max(1, root.ref.bytes)),
        );
        try {
          if (bytes.byteLength !== root.ref.bytes || byteDigest(bytes) !== root.ref.digest) {
            throw new TypeError("Authority checkpoint registered artifact content is corrupt");
          }
          addClassifiedReferences(
            retained,
            classifyRegisteredArtifactReferences(root, bytes),
            headerBudget,
          );
        } finally {
          Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).fill(0);
        }
      }
    }
  }
}

function checkpointPayload(
  input: FullAuthorityCheckpointCaptureOptions,
  checkpointId: string,
  target: DurableLogCheckpoint,
  pageDescriptors: readonly FullAuthorityCheckpointPayload["records"]["pages"][number][],
  recordCount: number,
  retainedArtifacts: readonly ArtifactRef[],
): FullAuthorityCheckpointPayload {
  const pages = Object.freeze(pageDescriptors.map((page) => ({ ...page })));
  const entries = Object.freeze([...retainedArtifacts].sort(compareRefs).map((ref) => ({ ...ref })));
  return {
    v: 1,
    checkpointId,
    createdAt: input.createdAt,
    homeId: input.trust.homeId,
    issuer: { deviceId: input.issuer.deviceId, keyId: input.issuer.deviceId },
    recipientKeyId: input.recipient.backupKeyId,
    purpose: input.purpose,
    source: cloneCheckpoint(target),
    trustChainHead: { ...input.trust.chainHead },
    coverage: { version: 1, classes: COVERAGE },
    records: {
      pages,
      count: recordCount,
      bytes: pages.reduce((sum, page) => sum + page.bytes, 0),
      digest: protocolDigest("FullAuthorityCheckpointRecordDirectory", 1, pages),
    },
    retainedArtifacts: {
      entries,
      count: entries.length,
      bytes: entries.reduce((sum, ref) => sum + ref.bytes, 0),
      digest: protocolDigest("FullAuthorityCheckpointArtifactDirectory", 1, entries),
    },
  };
}

function assertHeaderBudget(payload: FullAuthorityCheckpointPayload): void {
  if (Buffer.byteLength(canonicalize(payload), "utf8") > CHECKPOINT_CHUNK_BYTES) {
    throw new TypeError("Full checkpoint payload header exceeds the fixed chunk bound");
  }
}

class CheckpointHeaderBudget {
  readonly #baseBytes: number;
  #pageCount = 0;
  #pageElementBytes = 0;
  #recordCount = 0;
  #recordBytes = 0;
  #artifactCount = 0;
  #artifactElementBytes = 0;
  #artifactBytes = 0;

  constructor(
    input: FullAuthorityCheckpointCaptureOptions,
    checkpointId: string,
    target: DurableLogCheckpoint,
  ) {
    this.#baseBytes = canonicalBytes(checkpointPayload(input, checkpointId, target, [], 0, []));
  }

  addPage(
    descriptor: FullAuthorityCheckpointPayload["records"]["pages"][number],
    recordCount: number,
  ): void {
    const next = {
      pageCount: this.#pageCount + 1,
      pageElementBytes: this.#pageElementBytes + canonicalBytes(descriptor),
      recordCount: this.#recordCount + recordCount,
      recordBytes: this.#recordBytes + descriptor.bytes,
      artifactCount: this.#artifactCount,
      artifactElementBytes: this.#artifactElementBytes,
      artifactBytes: this.#artifactBytes,
    };
    this.#assert(next);
    this.#pageCount = next.pageCount;
    this.#pageElementBytes = next.pageElementBytes;
    this.#recordCount = next.recordCount;
    this.#recordBytes = next.recordBytes;
  }

  addArtifact(ref: ArtifactRef): void {
    const next = {
      pageCount: this.#pageCount,
      pageElementBytes: this.#pageElementBytes,
      recordCount: this.#recordCount,
      recordBytes: this.#recordBytes,
      artifactCount: this.#artifactCount + 1,
      artifactElementBytes: this.#artifactElementBytes + canonicalBytes(ref),
      artifactBytes: this.#artifactBytes + ref.bytes,
    };
    this.#assert(next);
    this.#artifactCount = next.artifactCount;
    this.#artifactElementBytes = next.artifactElementBytes;
    this.#artifactBytes = next.artifactBytes;
  }

  #assert(value: {
    readonly pageCount: number;
    readonly pageElementBytes: number;
    readonly recordCount: number;
    readonly recordBytes: number;
    readonly artifactCount: number;
    readonly artifactElementBytes: number;
    readonly artifactBytes: number;
  }): void {
    const bytes = this.#baseBytes +
      arrayContentBytes(value.pageElementBytes, value.pageCount) +
      decimalLength(value.recordCount) - 1 +
      decimalLength(value.recordBytes) - 1 +
      arrayContentBytes(value.artifactElementBytes, value.artifactCount) +
      decimalLength(value.artifactCount) - 1 +
      decimalLength(value.artifactBytes) - 1;
    if (bytes > CHECKPOINT_CHUNK_BYTES) {
      throw new TypeError("Full checkpoint payload header exceeds the fixed chunk bound");
    }
  }
}

function arrayContentBytes(elementBytes: number, count: number): number {
  return count === 0 ? 0 : elementBytes + count - 1;
}

function decimalLength(value: number): number {
  return String(value).length;
}

function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(canonicalize(value), "utf8");
}

async function* fullPlaintextChunks(
  input: FullAuthorityCheckpointCaptureOptions,
  target: DurableLogCheckpoint,
  payload: FullAuthorityCheckpointPayload,
): AsyncGenerator<Uint8Array> {
  const abort = input.abort ?? new AbortController().signal;
  const header = Buffer.from(canonicalize(payload), "utf8");
  try {
    yield header;
  } finally {
    header.fill(0);
  }
  const chunker = new PlaintextChunker(CHECKPOINT_CHUNK_BYTES);
  let cursor = await runStep(input, "origin-pass-2", 1, () => input.log.originCheckpoint());
  let pageIndex = 0;
  while (cursor.lsn < target.lsn) {
    throwIfAborted(abort);
    const descriptor = payload.records.pages[pageIndex];
    if (
      !descriptor || descriptor.seq !== pageIndex || descriptor.firstLsn !== cursor.lsn + 1 ||
      descriptor.lastLsn < descriptor.firstLsn || descriptor.lastLsn > target.lsn
    ) throw new RetentionSnapshotMoved();
    const pageHash = createHash("sha256");
    pageHash.update("[");
    let pageBytes = 2;
    let pageRecordCount = 0;
    let pageCommitCount = 0;
    for (const ready of chunker.push(Buffer.from("["))) {
      try {
        yield ready;
      } finally {
        ready.fill(0);
      }
    }
    while (cursor.lsn < descriptor.lastLsn) {
      const page = await runStep(input, `log-pass-2:${cursor.lsn}`, 16 * 1024 * 1024, () =>
        input.log.readTail<unknown>(cursor, 1));
      if (
        page.commits.length !== 1 ||
        page.checkpoint.logId !== target.logId ||
        page.checkpoint.lsn !== cursor.lsn + 1 ||
        page.commits[0]!.lsn !== page.checkpoint.lsn
      ) throw new RetentionSnapshotMoved();
      const commit = page.commits[0]!;
      const bytes = Buffer.from(canonicalize(commit), "utf8");
      try {
        if (pageCommitCount > 0) {
          pageHash.update(",");
          pageBytes += 1;
          for (const ready of chunker.push(Buffer.from(","))) {
            try {
              yield ready;
            } finally {
              ready.fill(0);
            }
          }
        }
        pageHash.update(bytes);
        pageBytes += bytes.byteLength;
        pageRecordCount += commit.entries.length;
        for (let offset = 0; offset < bytes.byteLength; offset += CHECKPOINT_CHUNK_BYTES) {
          for (const ready of chunker.push(bytes.subarray(offset, offset + CHECKPOINT_CHUNK_BYTES))) {
            try {
              yield ready;
            } finally {
              ready.fill(0);
            }
          }
        }
      } finally {
        bytes.fill(0);
      }
      cursor = page.checkpoint;
      pageCommitCount += 1;
    }
    pageHash.update("]");
    for (const ready of chunker.push(Buffer.from("]"))) {
      try {
        yield ready;
      } finally {
        ready.fill(0);
      }
    }
    if (
      pageCommitCount === 0 || pageCommitCount > RECORD_PAGE_COMMITS ||
      cursor.lsn !== descriptor.lastLsn || pageBytes !== descriptor.bytes ||
      pageRecordCount !== descriptor.recordCount ||
      `sha256:${pageHash.digest("hex")}` !== descriptor.digest
    ) throw new RetentionSnapshotMoved();
    pageIndex += 1;
  }
  if (pageIndex !== payload.records.pages.length || canonicalize(cursor) !== canonicalize(target)) {
    throw new RetentionSnapshotMoved();
  }
  for (let index = 0; index < payload.retainedArtifacts.entries.length; index += 1) {
    const ref = payload.retainedArtifacts.entries[index]!;
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < ref.bytes) {
      throwIfAborted(abort);
      const bytes = Buffer.from(await runStep(
        input,
        `artifact-pass-2:${index}:${offset}`,
        Math.min(CHECKPOINT_CHUNK_BYTES, ref.bytes - offset),
        () => input.artifacts.readRange(ref, offset, Math.min(CHECKPOINT_CHUNK_BYTES, ref.bytes - offset)),
      ));
      try {
        if (bytes.byteLength === 0) throw new TypeError("Retained artifact range made no progress");
        hash.update(bytes);
        for (const ready of chunker.push(bytes)) {
          try {
            yield ready;
          } finally {
            ready.fill(0);
          }
        }
        offset += bytes.byteLength;
      } finally {
        bytes.fill(0);
      }
    }
    if (`sha256:${hash.digest("hex")}` !== ref.digest) {
      throw new TypeError("Authority checkpoint retained artifact content is corrupt");
    }
  }
  const tail = chunker.finish();
  if (tail) {
    try {
      yield tail;
    } finally {
      tail.fill(0);
    }
  }
}

class PlaintextChunker {
  readonly #limit: number;
  #pending: Buffer;
  #length = 0;

  constructor(limit: number) {
    this.#limit = limit;
    this.#pending = Buffer.allocUnsafe(limit);
  }

  push(bytes: Uint8Array): Buffer[] {
    const ready: Buffer[] = [];
    const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(this.#limit - this.#length, bytes.byteLength - offset);
      source.copy(this.#pending, this.#length, offset, offset + take);
      this.#length += take;
      offset += take;
      if (this.#length === this.#limit) {
        ready.push(this.#pending);
        this.#pending = Buffer.allocUnsafe(this.#limit);
        this.#length = 0;
      }
    }
    return ready;
  }

  finish(): Buffer | undefined {
    if (this.#length === 0) {
      this.#pending.fill(0);
      return undefined;
    }
    const value = Buffer.from(this.#pending.subarray(0, this.#length));
    this.#pending.fill(0);
    this.#length = 0;
    return value;
  }
}

function addClassifiedReferences(
  retained: Map<string, ArtifactRef>,
  classified: ReturnType<typeof classifyRetainedRecordReferences>,
  headerBudget: CheckpointHeaderBudget,
): void {
  for (const ref of classified.unconditional) addRef(retained, ref, headerBudget);
  for (const leaf of classified.conversationLeaves) addRef(retained, leaf.ref, headerBudget);
}

function addRef(
  target: Map<string, ArtifactRef>,
  ref: ArtifactRef,
  headerBudget: CheckpointHeaderBudget,
): boolean {
  const existing = target.get(ref.digest);
  if (existing && existing.bytes !== ref.bytes) {
    throw new TypeError("Authority checkpoint saw conflicting artifact lengths");
  }
  if (existing) return false;
  headerBudget.addArtifact(ref);
  target.set(ref.digest, { digest: ref.digest, bytes: ref.bytes });
  return true;
}

function compareRefs(left: ArtifactRef, right: ArtifactRef): number {
  return left.digest.localeCompare(right.digest, "en-US") || left.bytes - right.bytes;
}

function cloneCheckpoint(checkpoint: DurableLogCheckpoint): FullAuthorityCheckpointPayload["source"] {
  return {
    logId: checkpoint.logId,
    lsn: checkpoint.lsn,
    frameEndOffset: checkpoint.frameEndOffset,
    prefixDigest: checkpoint.prefixDigest,
  };
}

async function runStep<T>(
  input: FullAuthorityCheckpointCaptureOptions,
  identity: string,
  bytes: number,
  operation: () => Promise<T>,
): Promise<T> {
  return runStorageMaintenanceStep(
    input.storageMaintenance,
    storageMaintenanceRequest(
      "authority-checkpoint",
      input.trust.homeId,
      { checkpointId: input.checkpointId ?? input.captureIdentity ?? "source-freeze", identity, bytes },
      { obligation: "pre-commit" },
    ),
    operation,
  );
}

function throwIfAborted(abort: AbortSignal): void {
  if (abort.aborted) throw abort.reason ?? new Error("Authority checkpoint capture was cancelled");
}

class RetentionSnapshotMoved extends Error {}
