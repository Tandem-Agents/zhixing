import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import { DeviceLifecycleJournal, FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import {
  DURABLE_SCHEMA_INVENTORY,
  byteDigest,
  canonicalize,
  createSignedReleaseManifest,
  protocolBytes,
  type ProgramArtifact,
  type ProtocolSigner,
  type StableReleaseTarget,
} from "@zhixing/core/protocol";
import type { Signature } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { HOST_STOP_ACCEPTED_WORK_OWNERS, type HostStopAcceptedWorkPorts } from "../serve/host-stop-lifecycle.js";
import { ProgramStore } from "./program-store.js";
import { createReleaseVerifier } from "./release-verifier.js";
import { ProgramUpgradeCoordinator } from "./upgrade-lifecycle.js";

const keys = generateKeyPairSync("ed25519");
const keyId = "upgrade-test";
const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "ed25519",
      keyId,
      sig: sign(null, protocolBytes(schemaId, version, payload), keys.privateKey).toString("base64url"),
    };
  },
};
const verifier = createReleaseVerifier({
  keyId,
  publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
});

describe("program upgrade lifecycle", () => {
  it("settles exact accepted work before switching and verifies the target on a successor", async () => {
    const root = await createTempDir("program-upgrade");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts);
    const journal = new DeviceLifecycleJournal(log);
    const store = new ProgramStore(path.join(root, "program"), "linux-x64");
    const current = release("linux-x64", "1.0.0", "1", "current");
    const candidate = release("linux-x64", "1.1.0", "2", "candidate");
    const currentBytes = Buffer.from(canonicalize(current.manifest), "utf8");
    const candidateBytes = Buffer.from(canonicalize(candidate.manifest), "utf8");
    await store.stage(current.manifest, currentBytes, current.artifact);
    await store.activateStaged(current.manifest, byteDigest(currentBytes));
    await store.stage(candidate.manifest, candidateBytes, candidate.artifact);

    const order: string[] = [];
    const ports = Object.fromEntries(HOST_STOP_ACCEPTED_WORK_OWNERS.map((owner) => [owner, {
      freeze: async () => [{ id: `${owner}:1`, revision: "1" }],
      settle: async () => { order.push(`settle:${owner}`); },
      readBack: async () => { order.push(`read:${owner}`); },
    }])) as unknown as HostStopAcceptedWorkPorts;
    const homeId = (await log.originCheckpoint()).logId;
    const options = {
      journal,
      store,
      verifier,
      artifactStore: artifacts,
      acceptedWork: ports,
      homeId,
      localDeviceId: "device-local",
      host: { kind: "foreground" as const, processId: 41, startedAt: "2026-08-13T00:00:00.000Z" },
      isHostStopped: async () => true,
      runtime: {
        closeAdmission: async () => { order.push("close"); },
        flushDurableState: async () => {
          order.push("flush");
          return [{ kind: "accepted-work" as const, digest: (await log.checkpoint()).prefixDigest }];
        },
        settlePhysicalSteps: async () => { order.push("physical"); },
      },
      installationReceiptPath: path.join(root, "installer-state", "receipt.json"),
    };
    const original = new ProgramUpgradeCoordinator(options);
    const prepared = await original.prepare({
      requestId: "update-request",
      candidateManifestDigest: byteDigest(candidateBytes),
      timeoutMs: 5_000,
    });
    expect(prepared.phase).toBe("flushed");
    expect(order[0]).toBe("close");
    expect(order.slice(-2)).toEqual(["flush", "physical"]);
    expect((await store.loadPointer())?.current.releaseVersion).toBe("1.0.0");

    const successor = new ProgramUpgradeCoordinator({
      ...options,
      host: { kind: "foreground", processId: 42, startedAt: "2026-08-13T00:01:00.000Z" },
    });
    await expect(successor.resumeBeforeStartup()).resolves.toEqual({
      kind: "restart-target",
      operationId: prepared.operationId,
    });
    expect((await store.loadPointer())?.current.releaseVersion).toBe("1.1.0");
    const replayedPointer = await store.activateStaged(candidate.manifest, byteDigest(candidateBytes), {
      sourceManifestDigest: byteDigest(currentBytes),
      pointerGeneration: 1,
    });
    expect(replayedPointer.generation).toBe(2);

    const target = new ProgramUpgradeCoordinator({
      ...options,
      host: { kind: "foreground", processId: 43, startedAt: "2026-08-13T00:02:00.000Z" },
    });
    const action = await target.resumeBeforeStartup();
    expect(action).toMatchObject({ kind: "verify-current", operationId: prepared.operationId });
    await expect(target.prepare({
      requestId: "update-request",
      candidateManifestDigest: byteDigest(candidateBytes),
      timeoutMs: 5_000,
    })).resolves.toEqual({ operationId: prepared.operationId, phase: "flushed" });
    await target.completeHealthy(prepared.operationId, byteDigest(candidateBytes));
    await expect(journal.active()).resolves.toEqual([]);
    await expect(store.loadReceipt()).resolves.toMatchObject({ notice: "updated" });

    await rm(options.installationReceiptPath, { force: true });
    await expect(target.prepare({
      requestId: "terminal-response-replay",
      candidateManifestDigest: byteDigest(candidateBytes),
      timeoutMs: 5_000,
    })).resolves.toEqual({ operationId: prepared.operationId, phase: "flushed" });
    await expect(readFileReceipt(options.installationReceiptPath)).resolves.toMatchObject({
      releaseVersion: "1.1.0",
      releaseSequence: "2",
    });

    const upgradedPointer = await store.loadPointer();
    expect(upgradedPointer?.previous?.releaseVersion).toBe("1.0.0");
    const recovery = await store.stageInstalled(upgradedPointer!.previous!, verifier);
    const recoveryPrepared = await target.prepare({
      requestId: "restore-request",
      candidateManifestDigest: recovery.digest,
      timeoutMs: 5_000,
    });
    const advance = journal.advance.bind(journal);
    let lostOldHostResponse = false;
    vi.spyOn(journal, "advance").mockImplementation(async (...args) => {
      const result = await advance(...args);
      if (args[1] === "old-host-stopped" && !lostOldHostResponse) {
        lostOldHostResponse = true;
        throw new Error("old-host-stopped response lost");
      }
      return result;
    });
    await expect(target.advanceAfterCurrentHostStopped(false)).rejects.toThrow("endpoint is still active");
    await expect(target.advanceAfterCurrentHostStopped(true)).resolves.toBe(true);
    expect(lostOldHostResponse).toBe(true);
    const recoveredTarget = new ProgramUpgradeCoordinator({
      ...options,
      host: { kind: "foreground", processId: 44, startedAt: "2026-08-13T00:03:00.000Z" },
    });
    await expect(recoveredTarget.resumeBeforeStartup()).resolves.toMatchObject({
      kind: "verify-current",
      operationId: recoveryPrepared.operationId,
    });
    await recoveredTarget.completeHealthy(recoveryPrepared.operationId, recovery.digest);
    await expect(store.loadPointer()).resolves.toMatchObject({
      current: { releaseVersion: "1.0.0" },
    });
    await expect(store.loadReceipt()).resolves.toMatchObject({ notice: "restored" });
  }, 120_000);
});

async function readFileReceipt(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

function release(target: StableReleaseTarget, version: string, sequence: string, text: string) {
  const file = Buffer.from(text);
  const artifactDocument: ProgramArtifact = {
    v: 1,
    target,
    releaseVersion: version,
    files: [{ path: "bin/zz", mode: 0o755, digest: byteDigest(file), bytes: file.byteLength, data: file.toString("base64url") }],
  };
  const artifact = Buffer.from(canonicalize(artifactDocument), "utf8");
  const manifest = createSignedReleaseManifest({
    v: 1,
    releaseVersion: version,
    releaseSequence: sequence,
    channel: "stable",
    target,
    nodeVersion: "22.18.0",
    sourceTreeDigest: `sha256:${"1".repeat(64)}`,
    packageGraphDigest: `sha256:${"2".repeat(64)}`,
    artifact: { digest: byteDigest(artifact), bytes: artifact.byteLength },
    protocolRange: { readMin: "1", readMax: "1", writeVersion: "1" },
    durableSchemas: DURABLE_SCHEMA_INVENTORY,
    minimumRollbackVersion: "1.0.0",
    keyId,
  }, signer);
  return { artifact, manifest };
}
