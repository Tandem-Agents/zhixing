import { readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import {
  FileArtifactStore,
  FileResumableArtifactReceiver,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  ExecutionAssetSnapshotV2,
} from "@zhixing-ai/core/contracts";
import {
  byteDigest,
  validateExecutionAssetSnapshotV2,
  validateExecutorCapabilitySnapshot,
  type ExecutorCapabilitySnapshot,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import { MeshProtocolError } from "@zhixing-ai/mesh/errors";
import type { MeshServiceClient } from "@zhixing-ai/mesh/request-channel";
import type {
  ExecutionAssetV2SyncSource,
  FileExecutionAssetCache,
} from "./execution-asset-cache.js";
import {
  collectExpectedRefsFromSnapshot,
  decodeExactBase64,
  decodeJsonPayload,
  decodeSnapshotMetaEnvelope,
  decodeV2Request,
  encodeJsonPayload,
  encodeSnapshotMetaEnvelope,
  isRecord,
  MAX_EXECUTION_ASSET_BYTES,
  MAX_EXECUTION_ASSET_CHUNK_BYTES,
  MAX_RECONCILE_PAGE_REFS,
  MAX_SNAPSHOT_META_BYTES,
  MAX_VERIFIED_SNAPSHOTS,
  validateReconcileResponse,
  validateStageMetaResponse,
  type ExecutionSnapshotV2Request,
  type ReconcileAssetsV2Response,
  type StageSnapshotMetaV2Response,
  type UploadAssetChunkV2Response,
} from "./execution-snapshot-v2-wire.js";

export { MAX_EXECUTION_ASSET_CHUNK_BYTES, MAX_RECONCILE_PAGE_REFS };
export type {
  ExecutionSnapshotV2Request,
  ReconcileAssetsV2Response,
  StageSnapshotMetaV2Response,
  UploadAssetChunkV2Response,
};

const EXECUTION_SNAPSHOT_SERVICE = "execution.snapshot";

export class ExecutionAssetV2UnsupportedError extends Error {}

export interface ExecutionSnapshotV2SyncHandler {
  handleRequest(
    rawPayload: unknown,
    input: {
      readonly peerId: string;
      readonly authorizePeer: (deviceId: string, access: "read" | "write") => boolean;
      readonly signal: AbortSignal;
    },
  ): Promise<unknown>;
}

interface StagedVerifiedSnapshot {
  readonly snapshot: ExecutionAssetSnapshotV2;
  readonly expectedRefs: readonly ArtifactRef[];
  readonly refMap: ReadonlyMap<string, ArtifactRef>;
  readonly metaRef?: ArtifactRef;
}

export function createExecutionAssetV2SyncHandler(options: {
  readonly zhixingHome: string;
  readonly artifacts: FileArtifactStore;
  readonly executionAssets: FileExecutionAssetCache;
  readonly verifier: ProtocolSignatureVerifier;
  readonly refreshCapability: () => Promise<ExecutorCapabilitySnapshot>;
  readonly runRevisionChange?: <T>(work: () => Promise<T>) => Promise<T>;
}): ExecutionSnapshotV2SyncHandler {
  const verifiedSnapshots = new Map<string, StagedVerifiedSnapshot>();
  const partialsDir = path.join(
    options.zhixingHome,
    "distributed-runtime",
    "execution-asset-partials",
  );
  const receiver = new FileResumableArtifactReceiver(options.artifacts, partialsDir, {
    maxArtifactBytes: MAX_EXECUTION_ASSET_BYTES,
    maxChunkBytes: MAX_EXECUTION_ASSET_CHUNK_BYTES,
  });
  const metaCasDir = path.join(partialsDir, "meta-cas");
  const metaArtifacts = new FileArtifactStore(metaCasDir);
  const metaReceiver = new FileResumableArtifactReceiver(
    metaArtifacts,
    path.join(partialsDir, "meta-staging"),
    {
      maxArtifactBytes: MAX_SNAPSHOT_META_BYTES,
      maxChunkBytes: MAX_EXECUTION_ASSET_CHUNK_BYTES,
    },
  );

  const collectKeepMetaDigests = (): Set<string> => {
    const keep = new Set<string>();
    for (const staged of verifiedSnapshots.values()) {
      if (staged.metaRef) keep.add(staged.metaRef.digest);
    }
    return keep;
  };

  const rememberSnapshot = async (entry: StagedVerifiedSnapshot): Promise<void> => {
    const existing = verifiedSnapshots.get(entry.snapshot.digest);
    let evicted = false;
    if (!existing && verifiedSnapshots.size >= MAX_VERIFIED_SNAPSHOTS) {
      const oldestKey = verifiedSnapshots.keys().next().value;
      if (oldestKey !== undefined) {
        verifiedSnapshots.delete(oldestKey);
        evicted = true;
      }
    }
    verifiedSnapshots.set(entry.snapshot.digest, entry);
    if (evicted) {
      await sweepUnpinnedMetaArtifacts(metaCasDir, collectKeepMetaDigests());
    }
  };

  const resolveStagedOrCurrentSnapshot = async (
    snapshotDigest: string,
  ): Promise<StagedVerifiedSnapshot | undefined> => {
    const staged = verifiedSnapshots.get(snapshotDigest);
    if (staged) return staged;
    const current = await options.executionAssets.currentV2();
    if (current && current.digest === snapshotDigest) {
      const expectedRefs = collectExpectedRefsFromSnapshot(current);
      return {
        snapshot: current,
        expectedRefs,
        refMap: new Map(expectedRefs.map((ref) => [ref.digest, ref])),
      };
    }
    return undefined;
  };

  const assertAuthorizedWrite = (
    authorizePeer: (deviceId: string, access: "read" | "write") => boolean,
    peerId: string,
    signal: AbortSignal,
    reason: string,
  ): void => {
    signal.throwIfAborted();
    if (!authorizePeer(peerId, "write")) {
      throw new MeshProtocolError("unauthorized-peer", reason);
    }
  };

  return {
    async handleRequest(rawPayload, { peerId, authorizePeer, signal }) {
      assertAuthorizedWrite(
        authorizePeer,
        peerId,
        signal,
        "Authenticated mesh peer cannot synchronize execution v2 assets",
      );
      const req = decodeV2Request(rawPayload, options.verifier);

      if (req.method === "stage-snapshot-meta-v2") {
        const chunkBytes = decodeExactBase64(
          req.chunkBase64,
          "Execution snapshot metadata chunk",
        );
        if (chunkBytes.byteLength > MAX_EXECUTION_ASSET_CHUNK_BYTES) {
          throw new TypeError("Execution snapshot metadata chunk exceeds 256 KiB limit");
        }
        let progress = await metaReceiver.progress(req.metaRef);
        if (!progress.complete) {
          if (req.offset < progress.receivedBytes) {
            const overlap = progress.receivedBytes - req.offset;
            if (overlap < chunkBytes.byteLength) {
              progress = await metaReceiver.append(
                req.metaRef,
                progress.receivedBytes,
                chunkBytes.subarray(overlap),
              );
            }
          } else {
            progress = await metaReceiver.append(req.metaRef, req.offset, chunkBytes);
          }
        }
        if (!progress.complete) {
          return {
            v: 2,
            receivedBytes: progress.receivedBytes,
            complete: false,
          } satisfies StageSnapshotMetaV2Response;
        }
        const metaBytes = await metaArtifacts.get(req.metaRef);
        let decoded: ReturnType<typeof decodeSnapshotMetaEnvelope>;
        try {
          decoded = decodeSnapshotMetaEnvelope(metaBytes, options.verifier);
        } catch (error) {
          await metaArtifacts.delete(req.metaRef).catch(() => undefined);
          throw error;
        }
        const { snapshot, expectedRefs } = decoded;
        await rememberSnapshot({
          snapshot,
          expectedRefs,
          refMap: new Map(expectedRefs.map((ref) => [ref.digest, ref])),
          metaRef: req.metaRef,
        });
        return {
          v: 2,
          receivedBytes: progress.receivedBytes,
          complete: true,
          snapshotDigest: snapshot.digest,
          totalRefs: expectedRefs.length,
        } satisfies StageSnapshotMetaV2Response;
      }

      if (req.method === "reconcile-assets-v2") {
        let staged: StagedVerifiedSnapshot;
        if ("snapshotDigest" in req) {
          const found = await resolveStagedOrCurrentSnapshot(req.snapshotDigest);
          if (!found) {
            throw new TypeError("Execution asset v2 snapshot metadata is not staged");
          }
          staged = found;
        } else {
          const expectedRefs = collectExpectedRefsFromSnapshot(req.snapshot, req.indexRefs);
          staged = {
            snapshot: req.snapshot,
            expectedRefs,
            refMap: new Map(expectedRefs.map((ref) => [ref.digest, ref])),
          };
          await rememberSnapshot(staged);
        }
        const start = req.cursor ?? 0;
        const pageLimit = Math.min(
          req.limit ?? MAX_RECONCILE_PAGE_REFS,
          MAX_RECONCILE_PAGE_REFS,
        );
        const page = staged.expectedRefs.slice(start, start + pageLimit);
        const missingRefs: Array<{ readonly ref: ArtifactRef; readonly receivedBytes: number }> =
          [];
        for (const ref of page) {
          signal.throwIfAborted();
          let present = false;
          try {
            await options.artifacts.readIdentity(ref);
            present = true;
          } catch {
            present = false;
          }
          if (present) continue;
          const progress = await receiver.progress(ref);
          if (!progress.complete) {
            missingRefs.push({ ref, receivedBytes: progress.receivedBytes });
          }
        }
        const nextOffset = start + page.length;
        return {
          v: 2,
          missingRefs,
          ...(nextOffset < staged.expectedRefs.length ? { nextCursor: nextOffset } : {}),
        } satisfies ReconcileAssetsV2Response;
      }

      if (req.method === "upload-asset-chunk-v2") {
        assertAuthorizedWrite(
          authorizePeer,
          peerId,
          signal,
          "Peer authorization revoked during chunk upload",
        );
        const stagedForUpload = await resolveStagedOrCurrentSnapshot(req.snapshotDigest);
        const authorized = stagedForUpload?.refMap.get(req.ref.digest);
        if (!authorized || authorized.bytes !== req.ref.bytes) {
          throw new TypeError(
            "Execution asset chunk is not authorized by a reconciled v2 snapshot",
          );
        }
        const chunkBytes = decodeExactBase64(req.chunkBase64, "Execution asset chunk");
        if (chunkBytes.byteLength > MAX_EXECUTION_ASSET_CHUNK_BYTES) {
          throw new TypeError("Execution asset chunk exceeds 256 KiB limit");
        }
        const progress = await receiver.append(req.ref, req.offset, chunkBytes);
        if (progress.complete) {
          const stored = await options.artifacts.get(req.ref);
          if (stored.byteLength !== req.ref.bytes || byteDigest(stored) !== req.ref.digest) {
            throw new TypeError("Uploaded execution asset failed integrity verification");
          }
        }
        return {
          v: 2,
          receivedBytes: progress.receivedBytes,
          complete: progress.complete,
        } satisfies UploadAssetChunkV2Response;
      }

      assertAuthorizedWrite(
        authorizePeer,
        peerId,
        signal,
        "Peer authorization revoked before v2 asset commit",
      );
      const snapshot =
        "snapshotDigest" in req
          ? (await resolveStagedOrCurrentSnapshot(req.snapshotDigest))?.snapshot
          : req.snapshot;
      if (!snapshot) {
        throw new TypeError("Execution asset v2 snapshot metadata is not staged");
      }
      const runRevisionChange =
        options.runRevisionChange ?? (<T>(work: () => Promise<T>) => work());
      return await runRevisionChange(async () => {
        assertAuthorizedWrite(
          authorizePeer,
          peerId,
          signal,
          "Peer authorization revoked before v2 asset publish",
        );
        await options.executionAssets.installV2(snapshot, {
          signal,
          assertAuthorized: () =>
            assertAuthorizedWrite(
              authorizePeer,
              peerId,
              signal,
              "Peer authorization revoked before v2 asset publish",
            ),
        });
        const existingStaged = verifiedSnapshots.get(snapshot.digest);
        if (existingStaged?.metaRef) {
          verifiedSnapshots.set(snapshot.digest, {
            snapshot: existingStaged.snapshot,
            expectedRefs: existingStaged.expectedRefs,
            refMap: existingStaged.refMap,
          });
        }
        await sweepUnpinnedMetaArtifacts(metaCasDir, collectKeepMetaDigests());
        return validateExecutorCapabilitySnapshot(
          await options.refreshCapability(),
          options.verifier,
        );
      });
    },
  };
}

export async function syncExecutionAssetsV2OverMesh(input: {
  readonly client: MeshServiceClient;
  readonly verifier: ProtocolSignatureVerifier;
  readonly source: ExecutionAssetV2SyncSource;
  readonly signal?: AbortSignal;
}): Promise<ExecutorCapabilitySnapshot> {
  const snapshot = validateExecutionAssetSnapshotV2(
    input.source.v2Snapshot,
    input.verifier,
  );
  input.signal?.throwIfAborted();
  const { bytes: metaBytes, ref: metaRef } = encodeSnapshotMetaEnvelope(
    snapshot,
    input.source.indexRefs,
  );
  let metaOffset = 0;
  while (metaOffset < metaBytes.byteLength) {
    input.signal?.throwIfAborted();
    const slice = metaBytes.subarray(
      metaOffset,
      Math.min(metaBytes.byteLength, metaOffset + MAX_EXECUTION_ASSET_CHUNK_BYTES),
    );
    let stageRaw: unknown;
    try {
      stageRaw = decodeJsonPayload(
        await input.client.request(
          EXECUTION_SNAPSHOT_SERVICE,
          encodeJsonPayload({
            v: 2,
            method: "stage-snapshot-meta-v2",
            metaRef,
            offset: metaOffset,
            chunkBase64: Buffer.from(slice).toString("base64"),
          } satisfies ExecutionSnapshotV2Request),
          input.signal,
        ),
      );
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (
        code === "service-failed" ||
        /Execution snapshot (?:request is invalid|method is unsupported)/iu.test(message)
      ) {
        throw new ExecutionAssetV2UnsupportedError(message, { cause: error });
      }
      throw error;
    }
    const stageRes = validateStageMetaResponse(stageRaw);
    metaOffset = stageRes.receivedBytes;
    if (stageRes.complete) {
      if (stageRes.snapshotDigest !== snapshot.digest) {
        throw new TypeError("Execution snapshot metadata completion digest mismatch");
      }
      break;
    }
  }

  const allMissing: Array<{ readonly ref: ArtifactRef; readonly receivedBytes: number }> = [];
  let cursor: number | undefined = 0;
  while (cursor !== undefined) {
    input.signal?.throwIfAborted();
    const reconcileBytes = await input.client.request(
      EXECUTION_SNAPSHOT_SERVICE,
      encodeJsonPayload({
        v: 2,
        method: "reconcile-assets-v2",
        snapshotDigest: snapshot.digest,
        cursor,
        limit: MAX_RECONCILE_PAGE_REFS,
      } satisfies ExecutionSnapshotV2Request),
      input.signal,
    );
    const reconcile = validateReconcileResponse(decodeJsonPayload(reconcileBytes));
    allMissing.push(...reconcile.missingRefs);
    cursor = reconcile.nextCursor;
  }

  for (const item of allMissing) {
    let offset = item.receivedBytes;
    if (item.ref.bytes === 0) {
      input.signal?.throwIfAborted();
      await uploadChunk(
        input.client,
        snapshot.digest,
        item.ref,
        0,
        new Uint8Array(0),
        input.signal,
      );
      continue;
    }
    while (offset < item.ref.bytes) {
      input.signal?.throwIfAborted();
      const length = Math.min(MAX_EXECUTION_ASSET_CHUNK_BYTES, item.ref.bytes - offset);
      const chunk = await input.source.readArtifactRange(item.ref, offset, length);
      if (chunk.byteLength === 0) {
        throw new Error(`Execution asset source range returned empty chunk at ${offset}`);
      }
      const res = await uploadChunk(
        input.client,
        snapshot.digest,
        item.ref,
        offset,
        chunk,
        input.signal,
      );
      offset = res.receivedBytes;
      if (res.complete) break;
    }
  }

  input.signal?.throwIfAborted();
  const commitRaw = decodeJsonPayload(
    await input.client.request(
      EXECUTION_SNAPSHOT_SERVICE,
      encodeJsonPayload({
        v: 2,
        method: "commit-assets-v2",
        snapshotDigest: snapshot.digest,
      } satisfies ExecutionSnapshotV2Request),
      input.signal,
    ),
  );
  return validateExecutorCapabilitySnapshot(
    commitRaw as ExecutorCapabilitySnapshot,
    input.verifier,
  );
}

async function uploadChunk(
  client: MeshServiceClient,
  snapshotDigest: string,
  ref: ArtifactRef,
  offset: number,
  chunk: Uint8Array,
  signal?: AbortSignal,
): Promise<UploadAssetChunkV2Response> {
  const raw = decodeJsonPayload(
    await client.request(
      EXECUTION_SNAPSHOT_SERVICE,
      encodeJsonPayload({
        v: 2,
        method: "upload-asset-chunk-v2",
        snapshotDigest,
        ref,
        offset,
        chunkBase64: Buffer.from(chunk).toString("base64"),
      } satisfies ExecutionSnapshotV2Request),
      signal,
    ),
  );
  if (
    !isRecord(raw) ||
    raw.v !== 2 ||
    !Number.isSafeInteger(raw.receivedBytes) ||
    typeof raw.complete !== "boolean"
  ) {
    throw new TypeError("Execution asset v2 chunk response is invalid");
  }
  return raw as unknown as UploadAssetChunkV2Response;
}

async function sweepUnpinnedMetaArtifacts(
  metaCasDir: string,
  keepDigests: ReadonlySet<string>,
): Promise<void> {
  // Only sweep content-addressed meta-cas/sha256/<xx>/<hex>; sibling meta-staging
  // holds active resumable checkpoints and must stay untouched.
  const sha256Root = path.join(metaCasDir, "sha256");
  let buckets: import("node:fs").Dirent[];
  try {
    buckets = await readdir(sha256Root, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = path.join(sha256Root, bucket.name);
    const files = await readdir(bucketDir, { encoding: "utf8", withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      if (keepDigests.has(`sha256:${file.name}`)) continue;
      await rm(path.join(bucketDir, file.name), { force: true });
    }
    await rmdir(bucketDir).catch(() => undefined);
  }
}
