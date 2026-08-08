import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { CheckpointStreamRecord, HomeTrustRecord } from "@zhixing/core/contracts";
import { projectRecoveryReadiness } from "../bootstrap-authority.js";
import { canonicalize } from "../canonical.js";
import { AuthorityCheckpointService } from "../checkpoint-service.js";
import { AuthorityCheckpointOwner } from "../checkpoint-owner.js";
import { FileRecoveryCheckpointTarget, type RetirableRecoveryCheckpointTarget } from "../checkpoint-target.js";
import { openFullAuthorityCheckpoint, type CheckpointPackage } from "../checkpoint.js";
import { DeviceKey, enrollDeviceIdentity } from "../device-identity.js";
import { captureFullAuthorityCheckpoint } from "../full-checkpoint.js";
import {
  FilePairedCheckpointStaging,
  PairedCheckpointReceiver,
  PairedRecoveryCheckpointTarget,
} from "../paired-checkpoint-target.js";
import { decodeRecoveryPackage, encodeRecoveryPackage } from "../recovery-package.js";
import { RecoveryRoot, keyIdForPublicKey } from "../recovery-root.js";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createRecoveryRootEvent,
  createTrustGenesisEvent,
  initializeTrustChain,
} from "../trust-chain.js";

const AT = "2026-08-08T00:00:00.000Z";

describe("full authority recovery checkpoints", () => {
  it("captures one exact authority prefix, encrypts it, and excludes checkpoint recursion", async () => {
    const fixture = await authorityFixture();
    const business = Buffer.from("retained-business-asset");
    const businessRef = await fixture.artifacts.put(business);
    const oldCheckpoint = Buffer.from("old-checkpoint-envelope");
    const oldCheckpointRef = await fixture.artifacts.put(oldCheckpoint);
    await fixture.log.append([
      { stream: "control", body: { t: "global-state-write", ref: businessRef } },
      {
        stream: "checkpoint",
        body: { t: "legacy-checkpoint", envelopeRef: oldCheckpointRef },
      },
    ]);

    const captured = await captureFullAuthorityCheckpoint({
      checkpointId: "01J00000000000000000000001",
      createdAt: AT,
      purpose: { kind: "periodic" },
      trust: fixture.trust,
      issuer: fixture.issuer,
      recipient: fixture.root.publicIdentity(),
      log: fixture.log,
      artifacts: fixture.artifacts,
    });
    await fixture.log.append([{ stream: "control", body: { t: "later" } }]);

    expect(captured.source.payload.source.lsn).toBe(1);
    expect(captured.source.payload.retainedArtifacts.entries).toEqual([businessRef]);
    expect(captured.source.payload.coverage.classes).toEqual([
      "global-authority",
      "conversation-authority",
      "conversation-content",
      "execution-assets",
    ]);
    const opened = openFullAuthorityCheckpoint({
      package: captured.checkpoint,
      recoveryRoot: fixture.root,
      issuer: fixture.identity,
    });
    try {
      expect(opened.payload.source).toEqual(captured.source.payload.source);
      expect(opened.retainedArtifacts.map((bytes) => bytes.toString())).toContain(
        business.toString(),
      );
    } finally {
      opened.verificationNonce.fill(0);
      opened.recordPages.forEach((bytes) => bytes.fill(0));
      opened.retainedArtifacts.forEach((bytes) => bytes.fill(0));
    }
    const tampered = clonePackage(captured.checkpoint);
    tampered.chunks[0]!.bytes[0] ^= 1;
    expect(() => openFullAuthorityCheckpoint({
      package: tampered,
      recoveryRoot: fixture.root,
      issuer: fixture.identity,
    })).toThrow(/chunk content/);

    const unknownHeader = clonePackage(captured.checkpoint);
    (unknownHeader.envelope as unknown as Record<string, unknown>).unexpected = true;
    expect(() => openFullAuthorityCheckpoint({
      package: unknownHeader,
      recoveryRoot: fixture.root,
      issuer: fixture.identity,
    })).toThrow(/missing or unknown fields/);

    const duplicateChunk = clonePackage(captured.checkpoint);
    duplicateChunk.chunks.push({
      seq: duplicateChunk.chunks[0]!.seq,
      bytes: Buffer.from(duplicateChunk.chunks[0]!.bytes),
    });
    expect(() => openFullAuthorityCheckpoint({
      package: duplicateChunk,
      recoveryRoot: fixture.root,
      issuer: fixture.identity,
    })).toThrow(/incomplete or duplicated/);
  });

  it("creates, resumes, truly verifies, supersedes and projects a full backup", async () => {
    const fixture = await authorityFixture();
    await fixture.log.append([{ stream: "control", body: { t: "global-state-write", value: 1 } }]);
    const target = new MemoryTarget("backup-dir:independent", "filesystem:independent");
    const service = checkpointService(fixture, target);
    const first = await service.createAndReplicate({
      checkpointId: "01J00000000000000000000002",
      createdAt: AT,
    });
    const verification = await service.verify({
      checkpointId: first.envelope.checkpointId,
      recoveryRoot: fixture.root,
      verifiedAt: "2026-08-08T00:01:00.000Z",
    });
    expect(await service.verify({
      checkpointId: first.envelope.checkpointId,
      recoveryRoot: fixture.root,
    })).toEqual(verification);
    expect(await service.status()).toMatchObject({ state: "recoverable", fullBackupReady: true });

    const records = await checkpointRecords(fixture.log);
    const created = records.filter((record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> =>
      record.t === "checkpoint-created");
    const verified = records.filter((record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }> =>
      record.t === "checkpoint-verified");
    const readiness = projectRecoveryReadiness({
      trust: fixture.projection,
      createdRecords: created,
      verifiedRecords: verified,
      checkpointEnvelopes: [first.envelope],
    });
    expect(readiness).toMatchObject({
      ready: false,
      fullBackupReady: true,
      fullCheckpointId: first.envelope.checkpointId,
      fullTargetId: target.targetId,
    });

    await fixture.log.append([{ stream: "control", body: { t: "global-state-write", value: 2 } }]);
    const second = await service.createAndReplicate({
      checkpointId: "01J00000000000000000000003",
      createdAt: "2026-08-09T00:00:00.000Z",
    });
    await service.verify({ checkpointId: second.envelope.checkpointId, recoveryRoot: fixture.root });
    expect(await service.verificationCandidate()).toBe(second.envelope.checkpointId);
    expect((await checkpointRecords(fixture.log)).some((record) =>
      record.t === "checkpoint-superseded" &&
      record.checkpointId === first.envelope.checkpointId &&
      record.supersededBy === second.envelope.checkpointId)).toBe(true);
    const firstCreated = created.find((record) => record.checkpointId === first.envelope.checkpointId)!;
    const retainedFirst = await fixture.log.retainedArtifactReferences([
      firstCreated.envelopeRef,
      ...first.envelope.chunks.map(({ digest, bytes }) => ({ digest, bytes })),
    ]);
    expect(retainedFirst).toEqual([]);
    expect(await fixture.log.retainedArtifactReferences([
      ...second.envelope.chunks.map(({ digest, bytes }) => ({ digest, bytes })),
    ])).toHaveLength(second.envelope.chunks.length);

    await service.cleanupExpired("2026-09-05T23:59:59.999Z");
    expect(target.has(first.envelope.checkpointId)).toBe(true);
    await service.cleanupExpired("2026-09-06T00:00:00.000Z");
    expect(target.has(first.envelope.checkpointId)).toBe(false);
    expect(target.has(second.envelope.checkpointId)).toBe(true);
  });

  it("resumes bounded paired-device upload and performs byte-exact remote read-back", async () => {
    const fixture = await authorityFixture();
    const largeRef = await fixture.artifacts.put(Buffer.alloc(700_000, 7));
    await fixture.log.append([{ stream: "control", body: { t: "global-state-write", ref: largeRef } }]);
    const captured = await captureFullAuthorityCheckpoint({
      checkpointId: "01J00000000000000000000004",
      createdAt: AT,
      purpose: { kind: "periodic" },
      trust: fixture.trust,
      issuer: fixture.issuer,
      recipient: fixture.root.publicIdentity(),
      log: fixture.log,
      artifacts: fixture.artifacts,
    });
    const root = await mkdtemp(path.join(tmpdir(), "zhixing-checkpoint-paired-"));
    const durable = await FileRecoveryCheckpointTarget.openPaired({
      targetRoot: path.join(root, "target"),
      targetDeviceId: "device-target",
    });
    const receiver = new PairedCheckpointReceiver({
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      recipientKeyId: keyIdForPublicKey(fixture.trust.recoveryBackupPublicKey!),
      staging: new FilePairedCheckpointStaging({
        root: path.join(root, "incoming"),
        target: durable,
      }),
    });
    const target = new PairedRecoveryCheckpointTarget({
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      recipientKeyId: captured.checkpoint.envelope.recipientKeyId,
      transport: receiver,
    });
    await target.writeDurable(captured.checkpoint);
    await target.writeDurable(captured.checkpoint);
    expect(canonicalPackage(await target.read(captured.checkpoint.envelope.checkpointId))).toBe(
      canonicalPackage(captured.checkpoint),
    );
    await target.retire(captured.checkpoint.envelope.checkpointId, "01J00000000000000000000005");
    await expect(target.read(captured.checkpoint.envelope.checkpointId)).rejects.toThrow(/not present/);

    await expect(receiver.request({
      v: 1,
      t: "checkpoint.unknown",
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      checkpointId: captured.checkpoint.envelope.checkpointId,
    } as never)).rejects.toThrow(/unsupported/);
  });

  it("rejects non-independent or linked directory roots before writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhixing-checkpoint-directory-"));
    const source = path.join(root, "authority");
    const target = path.join(root, "backup");
    await mkdir(source);
    await mkdir(target);
    await expect(FileRecoveryCheckpointTarget.open({ sourceRoot: source, targetRoot: target }))
      .rejects.toThrow(/physically independent/);

    const linked = path.join(root, "linked-target");
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(FileRecoveryCheckpointTarget.openPaired({
      targetRoot: linked,
      targetDeviceId: "device-target",
    })).rejects.toThrow(/symbolic link|real directory/);
  });

  it("single-flights daily and forced checkpoint obligations and drains on stop", async () => {
    const fixture = await authorityFixture();
    await fixture.log.append([{ stream: "control", body: { t: "global-state-write", value: 1 } }]);
    const target = new MemoryTarget("backup-dir:independent", "filesystem:independent");
    const service = checkpointService(fixture, target);
    const owner = new AuthorityCheckpointOwner({
      service,
      identitySeed: "home-checkpoint:anchor:backup-dir",
      clock: () => new Date("2026-08-08T12:00:00.000Z"),
      retryMs: 60_000,
    });
    owner.start();
    const [left, right] = await Promise.all([owner.ensureDaily(), owner.ensureDaily()]);
    expect(left.envelope.checkpointId).toBe(right.envelope.checkpointId);
    expect((await checkpointRecords(fixture.log)).filter((record) => record.t === "checkpoint-created"))
      .toHaveLength(1);
    const forced = await owner.force("migration-1");
    expect(forced.envelope.checkpointId).not.toBe(left.envelope.checkpointId);
    await owner.stop();
    await expect(owner.force("after-stop")).rejects.toThrow(/stopped/);

    const restarted = new AuthorityCheckpointOwner({
      service: checkpointService(fixture, target, () => "2026-08-11T00:00:00.000Z"),
      identitySeed: "home-checkpoint:anchor:backup-dir",
      clock: () => new Date("2026-08-08T18:00:00.000Z"),
    });
    restarted.start();
    await expect(restarted.ensureDaily()).resolves.toMatchObject({
      envelope: { checkpointId: left.envelope.checkpointId },
    });
    await restarted.stop();
  });

  it("emits only the secret-only package while still accepting a legacy package", async () => {
    const fixture = await authorityFixture();
    const current = encodeRecoveryPackage(fixture.root);
    expect(current.startsWith("zxrp2:")).toBe(true);
    expect(decodeRecoveryPackage(current).root.publicIdentity()).toEqual(fixture.root.publicIdentity());
    const currentPayload = JSON.parse(Buffer.from(current.slice(6), "base64url").toString("utf8")) as Record<string, unknown>;
    expect(() => decodeRecoveryPackage(`zxrp2:${Buffer.from(canonicalize({
      ...currentPayload,
      extra: true,
    }), "utf8").toString("base64url")}`)).toThrow(/unknown fields/);
    expect(() => decodeRecoveryPackage(`zxrp2:${Buffer.from(canonicalize({
      ...currentPayload,
      rootIdentity: { ...(currentPayload.rootIdentity as Record<string, unknown>), rootKeyId: "wrong" },
    }), "utf8").toString("base64url")}`)).toThrow(/does not match/);

    const legacyCheckpoint: CheckpointPackage = {
      envelope: { checkpointId: "legacy" } as CheckpointPackage["envelope"],
      chunks: [{ seq: 0, bytes: Buffer.from("legacy") }],
    };
    const legacy = `zxrp1:${Buffer.from(JSON.stringify({
      checkpoint: {
        chunks: [{ bytes: Buffer.from("legacy").toString("base64url"), seq: 0 }],
        envelope: legacyCheckpoint.envelope,
      },
      recoverySecret: fixture.root.exportSecret(),
      v: 1,
    }), "utf8").toString("base64url")}`;
    expect(decodeRecoveryPackage(legacy).legacyCheckpoint?.chunks[0]?.bytes.toString()).toBe("legacy");
  });
});

async function authorityFixture() {
  const key = await DeviceKey.generate();
  const identity = enrollDeviceIdentity(key, {
    displayName: "anchor",
    platform: "headless",
    enrolledAt: AT,
  });
  const genesis = createTrustGenesisEvent({ homeId: "home-checkpoint", issuer: identity, signer: key, at: AT });
  const initial = initializeTrustChain(genesis);
  const root = RecoveryRoot.generate();
  const rootEvent = createRecoveryRootEvent({
    current: initial,
    op: "establish",
    candidate: root,
    outerSigner: key,
    at: AT,
  });
  const projection = applyTrustEvent(initial, rootEvent);
  const trust = buildHomeTrustRecord(projection, key);
  const directory = await mkdtemp(path.join(tmpdir(), "zhixing-checkpoint-authority-"));
  const artifacts = new FileArtifactStore(path.join(directory, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(directory, "authority"), artifacts, { clock: () => AT });
  return {
    key,
    identity,
    issuer: Object.assign({}, identity, { sign: key.sign.bind(key) }),
    projection,
    trust,
    root,
    artifacts,
    log,
  };
}

function checkpointService(
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
  target: RetirableRecoveryCheckpointTarget,
  clock: () => string = () => "2026-08-10T00:00:00.000Z",
) {
  return new AuthorityCheckpointService({
    log: fixture.log,
    artifacts: fixture.artifacts,
    target,
    trust: fixture.trust,
    issuer: fixture.issuer,
    recipient: fixture.root.publicIdentity(),
    currentAnchor: true,
    clock,
  });
}

async function checkpointRecords(log: FileAuthorityCommitLog) {
  return (await log.readStream<CheckpointStreamRecord>("checkpoint")).map((entry) => entry.body);
}

class MemoryTarget implements RetirableRecoveryCheckpointTarget {
  readonly #values = new Map<string, CheckpointPackage>();
  constructor(readonly targetId: string, readonly independenceDomain: string) {}
  async writeDurable(checkpoint: CheckpointPackage) {
    const existing = this.#values.get(checkpoint.envelope.checkpointId);
    if (existing && canonicalPackage(existing) !== canonicalPackage(checkpoint)) {
      throw new TypeError("checkpoint conflict");
    }
    this.#values.set(checkpoint.envelope.checkpointId, clonePackage(checkpoint));
  }
  async read(checkpointId: string) {
    const value = this.#values.get(checkpointId);
    if (!value) throw new Error("checkpoint not present");
    return clonePackage(value);
  }
  async retire(checkpointId: string) {
    this.#values.delete(checkpointId);
  }
  has(checkpointId: string): boolean {
    return this.#values.has(checkpointId);
  }
}

function clonePackage(checkpoint: CheckpointPackage): { envelope: CheckpointPackage["envelope"]; chunks: { seq: number; bytes: Buffer }[] } {
  return {
    envelope: JSON.parse(JSON.stringify(checkpoint.envelope)) as CheckpointPackage["envelope"],
    chunks: checkpoint.chunks.map((chunk) => ({ seq: chunk.seq, bytes: Buffer.from(chunk.bytes) })),
  };
}

function canonicalPackage(checkpoint: CheckpointPackage): string {
  return canonicalize({
    envelope: checkpoint.envelope,
    chunks: checkpoint.chunks.map((chunk) => ({
      seq: chunk.seq,
      digest: Buffer.from(chunk.bytes).toString("base64url"),
    })),
  });
}
