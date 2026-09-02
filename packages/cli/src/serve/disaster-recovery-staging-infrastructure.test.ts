import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { FileArtifactStore } from "@zhixing/core/authority";
import type { ArtifactRef, DeviceIdentity } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
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
