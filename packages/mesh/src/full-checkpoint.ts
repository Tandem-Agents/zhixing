import type {
  ArtifactRef,
  CheckpointEnvelope,
  CommitEnvelope,
  DeviceIdentity,
  FullAuthorityCheckpointPayload,
  HomeTrustRecord,
} from "@zhixing/core/contracts";
import {
  collectArtifactRefs,
  type ArtifactStore,
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
  createFullAuthorityCheckpoint,
  type CheckpointPackage,
  type CheckpointRecipient,
  type CheckpointSigner,
  type FullAuthorityCheckpointSource,
} from "./checkpoint.js";

const RECORD_PAGE_COMMITS = 64;
const ARTIFACT_PARSE_BYTES = 8 * 1024 * 1024;
const COVERAGE = Object.freeze([
  "global-authority",
  "conversation-authority",
  "conversation-content",
  "execution-assets",
] as const);

export interface FullAuthorityCheckpointCaptureOptions {
  readonly checkpointId: string;
  readonly createdAt: string;
  readonly purpose: CheckpointEnvelope["manifest"]["purpose"];
  readonly trust: HomeTrustRecord;
  readonly issuer: DeviceIdentity & CheckpointSigner;
  readonly recipient: CheckpointRecipient;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly abort?: AbortSignal;
}

export interface CapturedFullAuthorityCheckpoint {
  readonly checkpoint: CheckpointPackage;
  readonly source: FullAuthorityCheckpointSource;
}

/** Captures one exact authority-log prefix and the retained artifact closure it names. */
export async function captureFullAuthorityCheckpoint(
  input: FullAuthorityCheckpointCaptureOptions,
): Promise<CapturedFullAuthorityCheckpoint> {
  const abort = input.abort ?? new AbortController().signal;
  return runWithMaintenanceUrgency(() => "foreground", abort, async () => {
    throwIfAborted(abort);
    const target = await runStep(input, "head", 1, () => input.log.checkpoint());
    const origin = await runStep(input, "origin", 1, () => input.log.originCheckpoint());
    if (origin.logId !== target.logId || origin.lsn > target.lsn) {
      throw new TypeError("Authority checkpoint source has an invalid origin");
    }

    const recordPages: Buffer[] = [];
    const pageDescriptors: FullAuthorityCheckpointPayload["records"]["pages"][number][] = [];
    const retained = new Map<string, ArtifactRef>();
    let cursor = origin;
    let recordCount = 0;

    while (cursor.lsn < target.lsn) {
      throwIfAborted(abort);
      const remaining = target.lsn - cursor.lsn;
      const page = await runStep(input, `log:${cursor.lsn}`, 16 * 1024 * 1024, () =>
        input.log.readTail<unknown>(cursor, Math.min(RECORD_PAGE_COMMITS, remaining)),
      );
      if (
        page.commits.length === 0 ||
        page.checkpoint.logId !== target.logId ||
        page.checkpoint.lsn <= cursor.lsn ||
        page.checkpoint.lsn > target.lsn
      ) {
        throw new TypeError("Authority checkpoint source did not advance within its frozen prefix");
      }
      const firstLsn = page.commits[0]!.lsn;
      const lastLsn = page.commits.at(-1)!.lsn;
      if (firstLsn !== cursor.lsn + 1 || lastLsn !== page.checkpoint.lsn) {
        throw new TypeError("Authority checkpoint record page is not contiguous");
      }
      const bytes = Buffer.from(canonicalize(page.commits), "utf8");
      const count = page.commits.reduce((sum, commit) => sum + commit.entries.length, 0);
      pageDescriptors.push({
        seq: pageDescriptors.length,
        firstLsn,
        lastLsn,
        recordCount: count,
        bytes: bytes.byteLength,
        digest: byteDigest(bytes),
      });
      recordPages.push(bytes);
      recordCount += count;
      collectRetainedRoots(page.commits, retained);
      cursor = page.checkpoint;
    }

    if (canonicalize(cursor) !== canonicalize(target)) {
      throw new TypeError("Authority checkpoint source prefix changed while it was captured");
    }
    if (target.lsn > 0) {
      await runStep(input, `verify:${target.lsn}`, 1024 * 1024, () => input.log.readEnvelopeAt(target));
    }

    const retainedArtifacts = await collectArtifactClosure(input, retained, abort);
    const retainedBytes = await Promise.all(
      retainedArtifacts.map((ref, index) =>
        runStep(input, `artifact-final:${index}:${ref.digest}`, ref.bytes, () => input.artifacts.get(ref)),
      ),
    );
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

    const payload: FullAuthorityCheckpointPayload = {
      v: 1,
      checkpointId: input.checkpointId,
      createdAt: input.createdAt,
      homeId: input.trust.homeId,
      issuer: { deviceId: input.issuer.deviceId, keyId: input.issuer.deviceId },
      recipientKeyId: input.recipient.backupKeyId,
      purpose: input.purpose,
      source: cloneCheckpoint(target),
      trustChainHead: { ...input.trust.chainHead },
      coverage: { version: 1, classes: COVERAGE },
      records: {
        pages: Object.freeze(pageDescriptors),
        count: recordCount,
        bytes: pageDescriptors.reduce((sum, page) => sum + page.bytes, 0),
        digest: protocolDigest("FullAuthorityCheckpointRecordDirectory", 1, pageDescriptors),
      },
      retainedArtifacts: {
        entries: Object.freeze(retainedArtifacts),
        count: retainedArtifacts.length,
        bytes: retainedArtifacts.reduce((sum, ref) => sum + ref.bytes, 0),
        digest: protocolDigest("FullAuthorityCheckpointArtifactDirectory", 1, retainedArtifacts),
      },
    };
    const source: FullAuthorityCheckpointSource = {
      payload,
      recordPages: Object.freeze(recordPages),
      retainedArtifacts: Object.freeze(retainedBytes.map((bytes) => Buffer.from(bytes))),
    };
    return {
      source,
      checkpoint: createFullAuthorityCheckpoint({
        source,
        recipient: input.recipient,
        issuer: input.issuer,
      }),
    };
  });
}

function collectRetainedRoots(
  commits: readonly CommitEnvelope<unknown>[],
  retained: Map<string, ArtifactRef>,
): void {
  for (const commit of commits) {
    for (const entry of commit.entries) {
      if (entry.stream === "checkpoint") continue;
      for (const ref of collectArtifactRefs(entry.body)) addRef(retained, ref);
    }
  }
}

async function collectArtifactClosure(
  input: FullAuthorityCheckpointCaptureOptions,
  roots: Map<string, ArtifactRef>,
  abort: AbortSignal,
): Promise<ArtifactRef[]> {
  const queue = [...roots.values()];
  for (let index = 0; index < queue.length; index += 1) {
    throwIfAborted(abort);
    const ref = queue[index]!;
    const bytes = await runStep(input, `artifact:${index}:${ref.digest}`, ref.bytes, () =>
      input.artifacts.get(ref),
    );
    if (bytes.byteLength !== ref.bytes || byteDigest(bytes) !== ref.digest) {
      throw new TypeError("Authority checkpoint artifact content is corrupt");
    }
    if (bytes.byteLength > ARTIFACT_PARSE_BYTES) continue;
    const nested = parseCanonicalObject(bytes);
    if (nested === undefined) continue;
    for (const child of collectArtifactRefs(nested)) {
      if (addRef(roots, child)) queue.push(child);
    }
  }
  return [...roots.values()].sort(compareRefs);
}

function parseCanonicalObject(bytes: Uint8Array): unknown | undefined {
  const text = Buffer.from(bytes).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  return canonicalize(value) === text ? value : undefined;
}

function addRef(target: Map<string, ArtifactRef>, ref: ArtifactRef): boolean {
  const existing = target.get(ref.digest);
  if (existing && existing.bytes !== ref.bytes) {
    throw new TypeError("Authority checkpoint saw conflicting artifact lengths");
  }
  if (existing) return false;
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
      { checkpointId: input.checkpointId, identity, bytes },
      { obligation: "pre-commit" },
    ),
    operation,
  );
}

function throwIfAborted(abort: AbortSignal): void {
  if (abort.aborted) throw abort.reason ?? new Error("Authority checkpoint capture was cancelled");
}
