import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  collectArtifactRefs,
  type DurableLogCheckpoint,
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing-ai/core/authority";
import type { ArtifactRef, CommitEnvelope } from "@zhixing-ai/core/contracts";
import { byteDigest, canonicalize } from "@zhixing-ai/core/protocol";

export interface VerifyRestorePointInput {
  readonly restoreDir: string;
  readonly manifestPath: string;
  readonly expectedCheckpoint: DurableLogCheckpoint;
  readonly expectedHasWal: boolean;
  readonly expectedHasIdentity: boolean;
}

export async function statNonEmptyFile(target: string | undefined): Promise<boolean> {
  if (!target) return false;
  try {
    const info = await stat(target);
    return info.isFile() && info.size > 0;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function createRestorePointArtifactStore(restoreDir: string): FileArtifactStore {
  return new FileArtifactStore(path.join(restoreDir, "artifacts"));
}

/**
 * Verifies a preserved live restore point has an intact manifest, complete
 * authority-envelopes snapshot, bit-exact SHA-256 artifacts in FileArtifactStore
 * layout, required identity companion, and a cold-openable read-only WAL
 * matching the full DurableLogCheckpoint and replayed envelope sequence.
 */
export async function verifyRestorePointRecoverable(
  input: VerifyRestorePointInput,
): Promise<boolean> {
  try {
    const expectedCheckpointCanonical = canonicalize(input.expectedCheckpoint);
    const parsed = JSON.parse(await readFile(input.manifestPath, "utf8")) as {
      v?: unknown;
      checkpoint?: unknown;
      checkpointLsn?: unknown;
      hasAuthorityWal?: unknown;
      hasAuthorityIdentity?: unknown;
      envelopeCount?: unknown;
      artifacts?: Array<{ digest?: unknown; bytes?: unknown }>;
    };
    if (
      parsed?.v !== 1 ||
      parsed.checkpointLsn !== input.expectedCheckpoint.lsn ||
      parsed.checkpoint === undefined ||
      canonicalize(parsed.checkpoint) !== expectedCheckpointCanonical ||
      Boolean(parsed.hasAuthorityWal) !== input.expectedHasWal ||
      Boolean(parsed.hasAuthorityIdentity) !== input.expectedHasIdentity ||
      !Number.isSafeInteger(parsed.envelopeCount) ||
      (parsed.envelopeCount as number) < 0 ||
      !Array.isArray(parsed.artifacts)
    ) {
      return false;
    }

    const envelopes = JSON.parse(
      await readFile(path.join(input.restoreDir, "authority-envelopes.json"), "utf8"),
    ) as unknown;
    if (!Array.isArray(envelopes) || envelopes.length !== parsed.envelopeCount) {
      return false;
    }
    if (input.expectedCheckpoint.lsn > 0) {
      const lastEnvelope = envelopes[envelopes.length - 1] as { lsn?: unknown } | undefined;
      if (envelopes.length === 0 || lastEnvelope?.lsn !== input.expectedCheckpoint.lsn) {
        return false;
      }
    }

    const expectedRefs = new Map<string, ArtifactRef>();
    for (const envelope of envelopes as CommitEnvelope<unknown>[]) {
      if (!Array.isArray(envelope?.entries)) return false;
      for (const ref of collectArtifactRefs(envelope.entries)) {
        if (!expectedRefs.has(ref.digest)) expectedRefs.set(ref.digest, ref);
      }
    }
    if (parsed.artifacts.length !== expectedRefs.size) return false;
    const restoreArtifacts = createRestorePointArtifactStore(input.restoreDir);
    const seenDigests = new Set<string>();
    for (const ref of parsed.artifacts) {
      if (
        typeof ref?.digest !== "string" ||
        !Number.isSafeInteger(ref.bytes) ||
        (ref.bytes as number) < 0 ||
        seenDigests.has(ref.digest)
      ) {
        return false;
      }
      const expected = expectedRefs.get(ref.digest);
      if (!expected || expected.bytes !== ref.bytes) return false;
      seenDigests.add(ref.digest);

      const bytes = await restoreArtifacts.get(expected);
      if (!bytes || bytes.byteLength !== ref.bytes || byteDigest(bytes) !== ref.digest) {
        return false;
      }
    }

    if (
      input.expectedHasIdentity &&
      !(await statNonEmptyFile(path.join(input.restoreDir, "authority.log.identity")))
    ) {
      return false;
    }

    if (input.expectedHasWal) {
      if (!(await statNonEmptyFile(path.join(input.restoreDir, "authority.log")))) {
        return false;
      }
      const probeLog = new FileAuthorityCommitLog(
        input.restoreDir,
        restoreArtifacts,
        { readOnly: true, owner: false },
      );
      try {
        const walCheckpoint = await probeLog.checkpoint();
        if (canonicalize(walCheckpoint) !== expectedCheckpointCanonical) return false;
        const replayedEnvelopes = await probeLog.rebuildProjection<CommitEnvelope<unknown>[]>(
          [],
          (items, _record, envelope) => {
            if (items.length === 0 || items[items.length - 1]!.lsn !== envelope.lsn) {
              items.push(envelope);
            }
            return items;
          },
        );
        if (canonicalize(replayedEnvelopes) !== canonicalize(envelopes)) {
          return false;
        }
      } finally {
        await probeLog.stopStorageMaintenance();
      }
    }

    return true;
  } catch {
    return false;
  }
}
