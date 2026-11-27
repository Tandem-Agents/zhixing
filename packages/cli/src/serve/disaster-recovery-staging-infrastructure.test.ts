import { createHash } from "node:crypto";
import { access, copyFile, readFile, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing-ai/core/authority";
import type { ArtifactRef, DeviceIdentity } from "@zhixing-ai/core/contracts";
import { canonicalize } from "@zhixing-ai/core/protocol";
import { createTempDir } from "@zhixing-ai/test-utils";
import { describe, expect, it, onTestFinished } from "vitest";
import { createDisasterRecoveryStagingInfrastructure } from
  "./disaster-recovery-staging-infrastructure.js";

const TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECOND_TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAW";
const identity = Object.freeze({
  deviceId: "device-target",
  publicKey: "device-public-key",
  displayName: "target",
  platform: "headless",
  enrolledAt: "2026-08-24T00:00:00.000Z",
}) as DeviceIdentity;

describe("disaster-recovery staging infrastructure", () => {
  it("projects one frozen physical boundary and resumes private and promotion bytes", async () => {
    const home = await createTempDir("disaster-recovery-staging-resume");
    const shared = new FileArtifactStore(path.join(home, "distributed-runtime", "artifacts"));
    const first = createDisasterRecoveryStagingInfrastructure({ zhixingHome: home });
    onTestFinished(() => first.close());
    const target = first.openTarget({ sharedArtifacts: shared });
    const session = await target.forTransfer({
      transferId: TRANSFER_ID,
      rootPublicKey: "recovery-root",
      identity,
    });

    expect(Object.keys(first)).toEqual([
      "openTarget",
      "preserveLiveRestorePoint",
      "cleanupPostInstall",
      "cleanupCurrentDevice",
      "close",
    ]);
    expect(Object.keys(target)).toEqual(["candidateFor", "forTransfer", "close"]);
    expect(Object.keys(session)).toEqual([
      "transferId",
      "artifacts",
      "journal",
      "privateImport",
      "promotion",
      "exists",
      "cleanupTransfer",
      "close",
    ]);
    expect(Object.keys(session.privateImport)).toEqual(["progress", "append"]);
    expect(Object.keys(session.promotion)).toEqual(["progress", "append"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(session)).toBe(true);

    const bytes = Buffer.from("disaster recovery private artifact", "utf8");
    const ref = artifactRef(bytes);
    const prefix = bytes.subarray(0, 12);
    await expect(session.privateImport.append(ref, 0, prefix)).resolves.toEqual({
      receivedBytes: prefix.byteLength,
      complete: false,
    });
    await session.journal.states();
    await first.close();

    const restarted = createDisasterRecoveryStagingInfrastructure({ zhixingHome: home });
    onTestFinished(() => restarted.close());
    const restartedTarget = restarted.openTarget({ sharedArtifacts: shared });
    const resumed = await restartedTarget.forTransfer({
      transferId: TRANSFER_ID,
      rootPublicKey: "recovery-root",
      identity,
    });
    await expect(resumed.privateImport.progress(ref)).resolves.toEqual({
      receivedBytes: prefix.byteLength,
      complete: false,
    });
    await expect(
      resumed.privateImport.append(ref, prefix.byteLength, bytes.subarray(prefix.byteLength)),
    ).resolves.toEqual({ receivedBytes: bytes.byteLength, complete: true });
    await expect(resumed.artifacts.get(ref)).resolves.toEqual(bytes);
    await expect(resumed.promotion.append(ref, 0, bytes)).resolves.toEqual({
      receivedBytes: bytes.byteLength,
      complete: true,
    });
    await expect(shared.get(ref)).resolves.toEqual(bytes);

    await expect(restartedTarget.forTransfer({
      transferId: "../escape",
      rootPublicKey: "recovery-root",
      identity,
    })).rejects.toThrow("not safe for private storage");
    await expect(resumed.privateImport.progress({
      digest: `sha256:${"0".repeat(64)}`,
      bytes: 512 * 1024 * 1024 * 1024 + 1,
    })).rejects.toThrow("configured byte limit");
    const oversizedChunk = Buffer.alloc(1024 * 1024 + 1);
    await expect(
      resumed.privateImport.append(artifactRef(oversizedChunk), 0, oversizedChunk),
    ).rejects.toThrow("configured byte limit");
  });

  it("keeps replay journals for abort/post-install and removes the whole root for device cleanup", async () => {
    const home = await createTempDir("disaster-recovery-staging-cleanup");
    const shared = new FileArtifactStore(path.join(home, "distributed-runtime", "artifacts"));
    const staging = createDisasterRecoveryStagingInfrastructure({ zhixingHome: home });
    onTestFinished(() => staging.close());
    const target = staging.openTarget({ sharedArtifacts: shared });

    const aborted = await target.forTransfer({
      transferId: TRANSFER_ID,
      rootPublicKey: "recovery-root",
      identity,
    });
    await aborted.journal.states();
    await receiveOne(aborted.privateImport);
    await aborted.cleanupTransfer();
    await expect(access(transferRoot(home, TRANSFER_ID))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(journalRoot(home, TRANSFER_ID))).resolves.toBeUndefined();

    const installed = await target.forTransfer({
      transferId: SECOND_TRANSFER_ID,
      rootPublicKey: "recovery-root",
      identity,
    });
    await installed.journal.states();
    await receiveOne(installed.privateImport);
    await staging.cleanupPostInstall(SECOND_TRANSFER_ID);
    await expect(access(transferRoot(home, SECOND_TRANSFER_ID))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(journalRoot(home, SECOND_TRANSFER_ID))).resolves.toBeUndefined();

    await staging.cleanupCurrentDevice();
    await expect(access(stagingRoot(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts without restore-point.json on EIO or missing artifact and succeeds on retry with same transferId", async () => {
    const home = await createTempDir("disaster-recovery-restore-retry");
    const shared = new FileArtifactStore(path.join(home, "distributed-runtime", "artifacts"));
    const liveLog = new FileAuthorityCommitLog(
      path.join(home, "distributed-runtime", "authority"),
      shared,
      { clock: () => "2026-11-26T00:00:00.000Z" },
    );
    const staging = createDisasterRecoveryStagingInfrastructure({ zhixingHome: home });
    onTestFinished(async () => {
      await staging.close();
      await liveLog.stopStorageMaintenance();
    });

    const contentRef = await shared.put(Buffer.from("live-skill-doc", "utf8"));
    await liveLog.append([{
      stream: "control",
      body: { t: "skill-create-v2", skillId: "live-skill", contentRef },
    }]);

    // 1. EIO during rebuildProjection aborts without publishing restore-point.json
    const restoreManifest = path.join(home, "recovery-restore-points", TRANSFER_ID, "restore-point.json");
    let injectReadError = true;
    const wrappedLog: Pick<FileAuthorityCommitLog, "checkpoint" | "originCheckpoint" | "rebuildProjection"> = {
      checkpoint: () => liveLog.checkpoint(),
      originCheckpoint: () => liveLog.originCheckpoint(),
      rebuildProjection: async (initial, reducer, options) => {
        if (injectReadError) {
          throw Object.assign(new Error("EIO: disk read failed"), { code: "EIO" });
        }
        return liveLog.rebuildProjection(initial, reducer, options);
      },
    };
    await expect(
      staging.preserveLiveRestorePoint!({
        transferId: TRANSFER_ID,
        authorityLog: wrappedLog,
        sharedArtifacts: shared,
      }),
    ).rejects.toThrow("EIO");
    await expect(stat(restoreManifest)).rejects.toMatchObject({ code: "ENOENT" });

    // 2. Missing referenced artifact throws instead of skipping silently
    const missingRef = artifactRef(Buffer.from("missing-blob", "utf8"));
    await expect(
      staging.preserveLiveRestorePoint!({
        transferId: SECOND_TRANSFER_ID,
        authorityLog: {
          checkpoint: () => liveLog.checkpoint(),
          originCheckpoint: () => liveLog.originCheckpoint(),
          rebuildProjection: async () => ([{
            v: 2,
            lsn: 1,
            stream: "control",
            at: "2026-11-26T00:00:00.000Z",
            entries: [{ stream: "control", body: { t: "ref-holder", ref: missingRef } }],
          }] as never),
        },
        sharedArtifacts: shared,
      }),
    ).rejects.toThrow();

    // 3. Same transferId retries cleanly once EIO clears and publishes full manifest + artifacts
    injectReadError = false;
    await staging.preserveLiveRestorePoint!({
      transferId: TRANSFER_ID,
      authorityLog: liveLog,
      sharedArtifacts: shared,
    });
    const liveCheckpoint = await liveLog.checkpoint();
    const saved = JSON.parse(await readFile(restoreManifest, "utf8")) as {
      v: number;
      checkpoint?: unknown;
      checkpointLsn: number;
      hasAuthorityIdentity?: boolean;
      artifacts: ArtifactRef[];
    };
    expect(saved.v).toBe(1);
    expect(saved.checkpointLsn).toBe(1);
    expect(canonicalize(saved.checkpoint)).toBe(canonicalize(liveCheckpoint));
    expect(saved.hasAuthorityIdentity).toBe(false);
    expect(saved.artifacts).toHaveLength(1);

    // 4. Same-length artifact tamper at FileArtifactStore layout + missing authority-envelopes.json -> rebuilt bit-exact
    const restoreDir = path.join(home, "recovery-restore-points", TRANSFER_ID);
    const restoreArtStore = new FileArtifactStore(path.join(restoreDir, "artifacts"));
    const artFile = restoreArtStore.pathFor(contentRef);
    await writeFile(artFile, Buffer.from("CORRUPTED_BYTE", "utf8"));
    await unlink(path.join(restoreDir, "authority-envelopes.json"));
    await staging.preserveLiveRestorePoint!({
      transferId: TRANSFER_ID,
      authorityLog: liveLog,
      sharedArtifacts: shared,
    });
    expect(await readFile(artFile, "utf8")).toBe("live-skill-doc");
    expect(JSON.parse(await readFile(path.join(restoreDir, "authority-envelopes.json"), "utf8"))).toHaveLength(1);

    // 5. Same-LSN foreign WAL mismatch (different-test-fact, lsn === 1) -> detected via full checkpoint/replay & rebuilt
    const foreignDir = path.join(home, "foreign-wal");
    const foreignArt = new FileArtifactStore(path.join(home, "foreign-art"));
    const foreignLog = new FileAuthorityCommitLog(foreignDir, foreignArt, {
      clock: () => "2026-11-26T00:00:00.000Z",
    });
    try {
      await foreignLog.append([{ stream: "control", body: { t: "different-test-fact" } }]);
      expect((await foreignLog.checkpoint()).lsn).toBe(liveCheckpoint.lsn);
      expect(canonicalize(await foreignLog.checkpoint())).not.toBe(canonicalize(liveCheckpoint));
    } finally {
      await foreignLog.stopStorageMaintenance();
    }
    await copyFile(path.join(foreignDir, "authority.log"), path.join(restoreDir, "authority.log"));
    await staging.preserveLiveRestorePoint!({
      transferId: TRANSFER_ID,
      authorityLog: liveLog,
      sharedArtifacts: shared,
    });

    // 6. Truncated authority.log -> detected via cold-open & rebuilt cleanly; companion .identity loss detected & rebuilt
    await truncate(path.join(restoreDir, "authority.log"), 8);
    await staging.preserveLiveRestorePoint!({
      transferId: TRANSFER_ID,
      authorityLog: liveLog,
      sharedArtifacts: shared,
    });

    await writeFile(liveLog.identityPath, Buffer.from("live-identity-companion", "utf8"));
    const liveWithIdCheckpoint = await liveLog.checkpoint();
    await staging.preserveLiveRestorePoint!({
      transferId: TRANSFER_ID,
      authorityLog: liveLog,
      sharedArtifacts: shared,
    });
    expect(
      (JSON.parse(await readFile(restoreManifest, "utf8")) as { hasAuthorityIdentity?: boolean }).hasAuthorityIdentity,
    ).toBe(true);
    await unlink(path.join(restoreDir, "authority.log.identity"));
    await staging.preserveLiveRestorePoint!({
      transferId: TRANSFER_ID,
      authorityLog: liveLog,
      sharedArtifacts: shared,
    });
    expect((await stat(path.join(restoreDir, "authority.log.identity"))).size).toBeGreaterThan(0);

    // 7. Intact retry is idempotent; then stop & delete live source and cold-open restoreDir via FileArtifactStore
    await staging.preserveLiveRestorePoint!({
      transferId: TRANSFER_ID,
      authorityLog: liveLog,
      sharedArtifacts: shared,
    });
    await staging.close();
    await liveLog.stopStorageMaintenance();
    await rm(path.join(home, "distributed-runtime", "authority"), { recursive: true, force: true });
    await rm(path.join(home, "distributed-runtime", "artifacts"), { recursive: true, force: true });

    const isolatedArtifacts = new FileArtifactStore(path.join(restoreDir, "artifacts"));
    const probeLog = new FileAuthorityCommitLog(
      restoreDir,
      isolatedArtifacts,
      { readOnly: true, owner: false },
    );
    try {
      expect(canonicalize(await probeLog.checkpoint())).toBe(canonicalize(liveWithIdCheckpoint));
      const replayedBodies = await probeLog.rebuildProjection<Array<{ t?: string; skillId?: string; contentRef?: ArtifactRef }>>(
        [],
        (items, record) => [...items, record.body as { t?: string; skillId?: string; contentRef?: ArtifactRef }],
      );
      expect(replayedBodies).toHaveLength(1);
      expect(replayedBodies[0]?.t).toBe("skill-create-v2");
      const recoveredBytes = await isolatedArtifacts.get(replayedBodies[0]!.contentRef!);
      expect(Buffer.from(recoveredBytes).toString("utf8")).toBe("live-skill-doc");
    } finally {
      await probeLog.stopStorageMaintenance();
    }
  });
});

async function receiveOne(receiver: {
  append(ref: ArtifactRef, offset: number, bytes: Uint8Array): Promise<unknown>;
}): Promise<void> {
  const bytes = Buffer.from("cleanup payload", "utf8");
  await receiver.append(artifactRef(bytes), 0, bytes);
}

function artifactRef(bytes: Uint8Array): ArtifactRef {
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.byteLength,
  };
}

function stagingRoot(home: string): string {
  return path.join(home, "distributed-runtime", "disaster-recovery-staging");
}

function transferRoot(home: string, transferId: string): string {
  return path.join(stagingRoot(home), "transfers", transferId);
}

function journalRoot(home: string, transferId: string): string {
  return path.join(stagingRoot(home), "journals", transferId);
}
