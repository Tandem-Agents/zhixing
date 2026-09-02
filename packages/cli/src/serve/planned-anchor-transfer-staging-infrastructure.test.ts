import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { FileArtifactStore } from "@zhixing/core/authority";
import type { ArtifactRef } from "@zhixing/core/contracts";
import type { ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished } from "vitest";
import type { PlannedAnchorCandidateIdentity } from "./planned-anchor-transfer.js";
import { createPlannedAnchorTransferStagingInfrastructure } from "./planned-anchor-transfer-staging-infrastructure.js";

const TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECOND_TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAW";

const verifier: ProtocolSignatureVerifier = {
  verify() {},
};

describe("planned-anchor transfer staging infrastructure", () => {
  it("projects one finite frozen boundary and recovers candidate, journal and bytes", async () => {
    const home = await createTempDir("planned-anchor-staging-resume");
    const destination = new FileArtifactStore(path.join(home, "distributed-runtime", "artifacts"));
    const first = createPlannedAnchorTransferStagingInfrastructure({ zhixingHome: home });
    onTestFinished(() => first.close());
    const target = first.openTarget({ artifacts: destination, verifier });
    const session = target.forTransfer(TRANSFER_ID);

    expect(Object.keys(first)).toEqual([
      "openTarget",
      "openTransfer",
      "cleanupPostInstall",
      "close",
    ]);
    expect(Object.keys(target)).toEqual([
      "candidates",
      "recoverableTransferIds",
      "forTransfer",
      "close",
    ]);
    expect(Object.keys(session)).toEqual([
      "journal",
      "artifacts",
      "receiver",
      "promotion",
      "exists",
      "cleanupTransfer",
      "cleanupTransferAndJournal",
      "close",
    ]);
    expect(Object.keys(session.artifacts)).toEqual(["get", "readRange", "has"]);
    expect(Object.keys(session.receiver)).toEqual(["progress", "append"]);
    expect(Object.keys(session.promotion)).toEqual(["progress", "append"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.artifacts)).toBe(true);
    expect(Object.isFrozen(session.receiver)).toBe(true);
    expect(Object.isFrozen(session.promotion)).toBe(true);

    const identity = candidateIdentity(TRANSFER_ID);
    await target.candidates.claimCandidate(identity);
    const reservation = {
      v: 1 as const,
      t: "planned-anchor-ready-reserved" as const,
      transferId: TRANSFER_ID,
      targetDeviceId: identity.targetDeviceId,
      proofDigest: "proof-digest",
      snapshotDigest: "snapshot-digest",
      expiresAt: "2026-08-24T12:00:00.000Z",
    };
    await session.journal.reserveReady(reservation);
    const bytes = Buffer.from("planned anchor private artifact", "utf8");
    const ref = artifactRef(bytes);
    const prefix = bytes.subarray(0, 11);
    await expect(session.receiver.append(ref, 0, prefix)).resolves.toEqual({
      receivedBytes: prefix.byteLength,
      complete: false,
    });
    await target.close();

    const restarted = createPlannedAnchorTransferStagingInfrastructure({ zhixingHome: home });
    onTestFinished(() => restarted.close());
    const restartedTarget = restarted.openTarget({ artifacts: destination, verifier });
    const restartedSession = restartedTarget.forTransfer(TRANSFER_ID);
    expect(await restartedTarget.candidates.state(TRANSFER_ID)).toEqual({ identity });
    expect(await restartedTarget.recoverableTransferIds()).toEqual([TRANSFER_ID]);
    expect(await restartedSession.journal.readyReservation(TRANSFER_ID)).toEqual(reservation);
    await expect(restartedSession.receiver.progress(ref)).resolves.toEqual({
      receivedBytes: prefix.byteLength,
      complete: false,
    });
    await expect(
      restartedSession.receiver.append(ref, prefix.byteLength, bytes.subarray(prefix.byteLength)),
    ).resolves.toEqual({ receivedBytes: bytes.byteLength, complete: true });
    await expect(restartedSession.artifacts.get(ref)).resolves.toEqual(bytes);
    await expect(restartedSession.promotion.append(ref, 0, bytes)).resolves.toEqual({
      receivedBytes: bytes.byteLength,
      complete: true,
    });
    await expect(destination.get(ref)).resolves.toEqual(bytes);

    expect(() => restartedTarget.forTransfer("../escape")).toThrow(
      "Migration transfer id is not safe for private storage",
    );
    await expect(restartedSession.receiver.progress({
      digest: `sha256:${"0".repeat(64)}`,
      bytes: 512 * 1024 * 1024 * 1024 + 1,
    })).rejects.toThrow("configured byte limit");
    const oversizedChunk = Buffer.alloc(512 * 1024 + 1);
    await expect(
      restartedSession.receiver.append(artifactRef(oversizedChunk), 0, oversizedChunk),
    ).rejects.toThrow("configured byte limit");
  });

  it("keeps replay journals while applying each exact physical cleanup", async () => {
    const home = await createTempDir("planned-anchor-staging-cleanup");
    const destination = new FileArtifactStore(path.join(home, "distributed-runtime", "artifacts"));
    const staging = createPlannedAnchorTransferStagingInfrastructure({ zhixingHome: home });
    onTestFinished(() => staging.close());
    const target = staging.openTarget({ artifacts: destination, verifier });

    const aborted = target.forTransfer(TRANSFER_ID);
    await target.candidates.claimCandidate(candidateIdentity(TRANSFER_ID));
    await aborted.journal.reserveReady(reservation(TRANSFER_ID));
    await receiveOne(aborted.receiver);
    await aborted.cleanupTransfer();
    await expect(access(transferRoot(home, TRANSFER_ID))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(journalRoot(home, TRANSFER_ID))).resolves.toBeUndefined();
    expect(await target.candidates.state(TRANSFER_ID)).toBeDefined();

    const released = target.forTransfer(SECOND_TRANSFER_ID);
    await released.journal.reserveReady(reservation(SECOND_TRANSFER_ID));
    await receiveOne(released.receiver);
    await released.cleanupTransferAndJournal();
    await expect(access(transferRoot(home, SECOND_TRANSFER_ID))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(journalRoot(home, SECOND_TRANSFER_ID))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const postInstall = target.forTransfer(SECOND_TRANSFER_ID);
    await postInstall.journal.reserveReady(reservation(SECOND_TRANSFER_ID));
    await receiveOne(postInstall.receiver);
    await staging.cleanupPostInstall(SECOND_TRANSFER_ID);
    await expect(access(transferRoot(home, SECOND_TRANSFER_ID))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(journalRoot(home, SECOND_TRANSFER_ID))).resolves.toBeUndefined();
    expect(await target.candidates.state(TRANSFER_ID)).toBeDefined();
  });
});

function candidateIdentity(transferId: string): PlannedAnchorCandidateIdentity {
  return {
    homeId: "home-test",
    requestId: `request:${transferId}`,
    transferId,
    sourceDeviceId: "device-source",
    targetDeviceId: "device-target",
    trustEpoch: 1,
    trustChainHead: { seq: 1, eventDigest: "trust-head" },
    sourceAnchorEpoch: 1,
  };
}

function reservation(transferId: string) {
  return {
    v: 1 as const,
    t: "planned-anchor-ready-reserved" as const,
    transferId,
    targetDeviceId: "device-target",
    proofDigest: `proof:${transferId}`,
    snapshotDigest: `snapshot:${transferId}`,
    expiresAt: "2026-08-24T12:00:00.000Z",
  };
}

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

function transferRoot(home: string, transferId: string): string {
  return path.join(
    home,
    "distributed-runtime",
    "anchor-transfer-staging",
    "transfers",
    transferId,
  );
}

function journalRoot(home: string, transferId: string): string {
  return path.join(
    home,
    "distributed-runtime",
    "anchor-transfer-staging",
    "journals",
    transferId,
  );
}
