import { link, mkdtemp, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArtifactLifecycleIndex,
  FileArtifactStore,
  FileArtifactTemporaryPresenceStore,
  FileAuthorityCommitLog,
  FileResumableArtifactReceiver,
} from "@zhixing/core/authority";
import { MAX_SURFACE_ASSET_BYTES, type CheckpointStreamRecord, type HomeTrustRecord } from "@zhixing/core/contracts";
import type {
  DeviceCapacityAdmission,
  StorageMaintenanceGovernorPort,
  StorageMaintenanceRequest,
} from "@zhixing/core/resources";
import { projectRecoveryReadiness } from "../bootstrap-authority.js";
import { byteDigest, canonicalize, protocolDigest } from "../canonical.js";
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
  decodePairedCheckpointResult,
} from "../paired-checkpoint-target.js";
import { decodeRecoveryPackage, encodeRecoveryPackage } from "../recovery-package.js";
import { RecoveryRoot, keyIdForPublicKey } from "../recovery-root.js";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createRecoveryRootEvent,
  createSignedTrustEvent,
  createTrustGenesisEvent,
  initializeTrustChain,
} from "../trust-chain.js";

const AT = "2026-08-08T00:00:00.000Z";

describe("full authority recovery checkpoints", () => {
  it("strictly decodes every paired checkpoint result shape", async () => {
    const fixture = await authorityFixture();
    const manifest = await captureFullAuthorityCheckpoint({
      checkpointId: "01J00000000000000000000000",
      createdAt: AT,
      purpose: { kind: "periodic" },
      trust: fixture.trust,
      issuer: fixture.issuer,
      recipient: fixture.root.publicIdentity(),
      log: fixture.log,
      artifacts: fixture.artifacts,
      retention: fixture.lifecycle,
    });
    const valid = [
      { t: "checkpoint.begun", checkpointId: "checkpoint-1" },
      { t: "checkpoint.stored", checkpointId: "checkpoint-1" },
      { t: "checkpoint.progress", checkpointId: "checkpoint-1", seq: 0, receivedBytes: 0, complete: false },
      { t: "checkpoint.appended", checkpointId: "checkpoint-1", seq: 0, receivedBytes: 1, complete: true },
      { t: "checkpoint.manifest", checkpointId: "checkpoint-1", envelope: manifest.checkpoint.envelope },
      { t: "checkpoint.range", checkpointId: "checkpoint-1", seq: 0, offset: 0, bytes: "YQ" },
      { t: "checkpoint.retired", checkpointId: "checkpoint-1", supersededBy: "checkpoint-2" },
    ] as const;
    for (const result of valid) expect(decodePairedCheckpointResult(result)).toEqual(result);
    for (const result of valid) {
      expect(() => decodePairedCheckpointResult({ ...result, unexpected: true })).toThrow(/unknown fields/);
    }
    expect(() => decodePairedCheckpointResult({ t: "checkpoint.range", checkpointId: "checkpoint-1", seq: 0, offset: 0, bytes: "%%%" }))
      .toThrow(/range/);
  });

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
      retention: fixture.lifecycle,
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

  it("captures the lifecycle-index retention set at one source head, including large leaves and deletion", async () => {
    const fixture = await authorityFixture();
    const large = await fixture.artifacts.put(Buffer.alloc(8 * 1024 * 1024 + 1, 7));
    const deleted = await fixture.artifacts.put(Buffer.from("deleted-conversation-leaf"));
    await fixture.log.append([
      {
        stream: "run:conversation-live",
        body: { t: "admitted", attachments: [{ ...large, kind: "file" }] },
      },
      {
        stream: "run:conversation-deleted",
        body: { t: "admitted", attachments: [{ ...deleted, kind: "file" }] },
      },
    ]);
    await fixture.log.append([{
      stream: "run:conversation-deleted",
      body: { t: "session-lifecycle", mutation: "delete" },
    }]);

    const captured = await captureFullAuthorityCheckpoint({
      checkpointId: "01J00000000000000000000011",
      createdAt: AT,
      purpose: { kind: "periodic" },
      trust: fixture.trust,
      issuer: fixture.issuer,
      recipient: fixture.root.publicIdentity(),
      log: fixture.log,
      artifacts: fixture.artifacts,
      retention: fixture.lifecycle,
    });

    expect(captured.source.payload.retainedArtifacts.entries).toContainEqual(large);
    expect(captured.source.payload.retainedArtifacts.entries).not.toContainEqual(deleted);
  }, 120_000);

  it("derives distinct current-ready generations for chain changes and same-day root rotation", async () => {
    const fixture = await authorityFixture();
    const target = new MemoryTarget("backup-dir:independent", "filesystem:independent");
    const request = { kind: "daily" as const, day: "2026-08-08" };
    const original = checkpointService(fixture, target);
    const first = await original.createAndReplicate({ request, createdAt: AT });
    await original.verify({ checkpointId: first.envelope.checkpointId, recoveryRoot: fixture.root });
    expect(await original.status()).toMatchObject({ state: "recoverable", fullBackupReady: true });

    const chainEvent = createSignedTrustEvent({
      current: fixture.projection,
      body: { t: "role-change", deviceId: fixture.identity.deviceId, roles: ["anchor"] },
      at: "2026-08-08T00:10:00.000Z",
      signer: fixture.key,
    });
    const chainProjection = applyTrustEvent(fixture.projection, chainEvent);
    const chainTrust = buildHomeTrustRecord(chainProjection, fixture.key);
    const chainService = checkpointService(fixture, target, undefined, {
      trust: chainTrust,
      recipient: fixture.root.publicIdentity(),
    });
    expect(await chainService.status()).toEqual({ state: "not-configured", fullBackupReady: false });
    const chainCheckpoint = await chainService.createAndReplicate({ request, createdAt: AT });
    expect(chainCheckpoint.envelope.checkpointId).not.toBe(first.envelope.checkpointId);
    await chainService.verify({ checkpointId: chainCheckpoint.envelope.checkpointId, recoveryRoot: fixture.root });

    const rotatedRoot = RecoveryRoot.generate();
    const rotateEvent = createRecoveryRootEvent({
      current: chainProjection,
      op: "rotate",
      candidate: rotatedRoot,
      outerSigner: fixture.root,
      at: "2026-08-08T00:20:00.000Z",
    });
    const rotatedProjection = applyTrustEvent(chainProjection, rotateEvent);
    const rotatedTrust = buildHomeTrustRecord(rotatedProjection, fixture.key);
    const rotatedService = checkpointService(fixture, target, undefined, {
      trust: rotatedTrust,
      recipient: rotatedRoot.publicIdentity(),
    });
    expect(await rotatedService.status()).toEqual({ state: "not-configured", fullBackupReady: false });
    const rotated = await rotatedService.createAndReplicate({ request, createdAt: AT });
    expect(new Set([
      first.envelope.checkpointId,
      chainCheckpoint.envelope.checkpointId,
      rotated.envelope.checkpointId,
    ])).toHaveLength(3);
  }, 120_000);

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
  }, 120_000);

  it("replays an old target obligation and records both cleanup phases after a binding switch", async () => {
    const fixture = await authorityFixture();
    const oldTarget = new ResponseLossTarget("backup-dir:old", "filesystem:old");
    const oldService = checkpointService(fixture, oldTarget);
    await expect(oldService.createAndReplicate({
      request: { kind: "daily", day: "2026-08-08" },
      createdAt: AT,
    })).rejects.toThrow(/response lost/);
    const oldCreated = (await checkpointRecords(fixture.log)).find((record): record is Extract<
      CheckpointStreamRecord,
      { t: "checkpoint-created" }
    > => record.t === "checkpoint-created" && record.targetId === oldTarget.targetId)!;

    const currentTarget = new MemoryTarget("backup-dir:current", "filesystem:current");
    const currentService = new AuthorityCheckpointService({
      log: fixture.log,
      artifacts: fixture.artifacts,
      retention: fixture.lifecycle,
      target: currentTarget,
      resolveTarget: async (targetId) => {
        if (targetId === oldTarget.targetId) return oldTarget;
        if (targetId === currentTarget.targetId) return currentTarget;
        throw new Error("unknown target binding");
      },
      trust: fixture.trust,
      issuer: fixture.issuer,
      recipient: fixture.root.publicIdentity(),
      currentAnchor: true,
      clock: () => "2026-08-10T00:00:00.000Z",
    });
    await currentService.recoverPending();
    expect(oldTarget.has(oldCreated.checkpointId)).toBe(true);
    expect((await checkpointRecords(fixture.log)).some((record) =>
      record.t === "checkpoint-replicated" &&
      record.checkpointId === oldCreated.checkpointId &&
      record.targetId === oldTarget.targetId)).toBe(true);
    await oldService.verify({ checkpointId: oldCreated.checkpointId, recoveryRoot: fixture.root });

    const current = await currentService.createAndReplicate({
      request: { kind: "daily", day: "2026-08-09" },
      createdAt: "2026-08-09T00:00:00.000Z",
    });
    await currentService.verify({
      checkpointId: current.envelope.checkpointId,
      recoveryRoot: fixture.root,
      verifiedAt: "2026-08-10T00:00:00.000Z",
    });
    await currentService.cleanupExpired("2026-09-06T00:00:00.000Z");
    const progress = (await checkpointRecords(fixture.log)).filter((record) =>
      record.t === "checkpoint-cleanup-progress" && record.checkpointId === oldCreated.checkpointId);
    expect(progress.map((record) => record.t === "checkpoint-cleanup-progress" ? record.phase : ""))
      .toEqual(["target-retired", "local-released"]);
    expect(oldTarget.has(oldCreated.checkpointId)).toBe(false);
  }, 120_000);

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
      retention: fixture.lifecycle,
    });
    const root = await mkdtemp(path.join(tmpdir(), "zhixing-checkpoint-paired-"));
    const governor = recordingGovernor();
    const sourceGovernor = recordingGovernor();
    const durable = await FileRecoveryCheckpointTarget.openPaired({
      targetRoot: path.join(root, "target"),
      targetDeviceId: "device-target",
      storageMaintenance: governor.port,
    });
    const receiver = new PairedCheckpointReceiver({
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      recipientKeyId: keyIdForPublicKey(fixture.trust.recoveryBackupPublicKey!),
      staging: new FilePairedCheckpointStaging({
        root: path.join(root, "incoming"),
        target: durable,
        storageMaintenance: governor.port,
      }),
    });
    const target = new PairedRecoveryCheckpointTarget({
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      recipientKeyId: captured.checkpoint.envelope.recipientKeyId,
      transport: receiver,
      storageMaintenance: sourceGovernor.port,
    });
    await target.writeDurable(captured.checkpoint);
    const staleRetired = path.join(root, "incoming",
      `.${captured.checkpoint.envelope.checkpointId}.${byteDigest(
        Buffer.from(canonicalize(captured.checkpoint.envelope), "utf8"),
      ).slice(7, 23)}.retired`);
    await mkdir(staleRetired);
    await writeFile(path.join(staleRetired, "interrupted"), "stale");
    await target.writeDurable(captured.checkpoint);
    expect((await readdir(path.join(root, "incoming"))).some((entry) => entry.endsWith(".retired")))
      .toBe(false);
    expect(canonicalPackage(await target.read(captured.checkpoint.envelope.checkpointId))).toBe(
      canonicalPackage(captured.checkpoint),
    );
    await target.retire(captured.checkpoint.envelope.checkpointId, "01J00000000000000000000005");
    await expect(target.read(captured.checkpoint.envelope.checkpointId)).rejects.toThrow(/not present/);
    expect(governor.requests.length).toBeGreaterThan(0);
    expect(governor.requests.every((request) => request.kind === "authority-checkpoint")).toBe(true);
    expect(sourceGovernor.requests.length).toBeGreaterThan(0);
    expect(sourceGovernor.requests.every((request) => request.kind === "authority-checkpoint")).toBe(true);

    const aborted = new AbortController();
    aborted.abort(new Error("checkpoint owner stopped"));
    await expect(target.writeDurable(captured.checkpoint, aborted.signal)).rejects.toThrow(/cancelled|stopped/);

    await expect(receiver.request({
      v: 1,
      t: "checkpoint.unknown",
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      checkpointId: captured.checkpoint.envelope.checkpointId,
    } as never)).rejects.toThrow(/unsupported/);
  }, 15_000);

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

  it("rejects configured-root replacement and final-file hard links before external effects", async () => {
    const fixture = await authorityFixture();
    const captured = await captureFullAuthorityCheckpoint({
      checkpointId: "01J00000000000000000000012",
      createdAt: AT,
      purpose: { kind: "periodic" },
      trust: fixture.trust,
      issuer: fixture.issuer,
      recipient: fixture.root.publicIdentity(),
      log: fixture.log,
      artifacts: fixture.artifacts,
      retention: fixture.lifecycle,
    });
    const root = await mkdtemp(path.join(tmpdir(), "zhixing-checkpoint-identity-"));
    const replacedRoot = path.join(root, "replaced");
    await mkdir(replacedRoot);
    const replacedTarget = await FileRecoveryCheckpointTarget.openPaired({
      targetRoot: replacedRoot,
      targetDeviceId: "device-target",
    });
    await rename(replacedRoot, `${replacedRoot}.original`);
    await mkdir(replacedRoot);
    await expect(replacedTarget.writeDurable(captured.checkpoint)).rejects.toThrow(/identity changed/);
    expect(await readdir(replacedRoot)).toEqual([]);

    const stableRoot = path.join(root, "stable");
    const stableTarget = await FileRecoveryCheckpointTarget.openPaired({
      targetRoot: stableRoot,
      targetDeviceId: "device-target",
    });
    const stagingIdentity = protocolDigest("RecoveryCheckpointStaging", 1, {
      checkpointId: captured.checkpoint.envelope.checkpointId,
      envelopeDigest: captured.checkpoint.envelope.digest,
    }).slice(7, 23);
    const staleStaging = path.join(stableRoot,
      `.${captured.checkpoint.envelope.checkpointId}.${stagingIdentity}.tmp`);
    await mkdir(staleStaging);
    await writeFile(path.join(staleStaging, "interrupted"), "stale");
    await stableTarget.writeDurable(captured.checkpoint);
    expect((await readdir(stableRoot)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
    const manifest = path.join(stableRoot, captured.checkpoint.envelope.checkpointId, "manifest.json");
    const outside = path.join(root, "outside-manifest.json");
    await writeFile(outside, "{}", { flag: "wx" });
    await rm(manifest);
    await link(outside, manifest);
    await expect(stableTarget.read(captured.checkpoint.envelope.checkpointId)).rejects.toThrow(/identity|manifest/);
  }, 120_000);

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

    const busyFixture = await authorityFixture();
    const blockingTarget = new BlockingTarget("backup-dir:blocking", "filesystem:blocking");
    const busyOwner = new AuthorityCheckpointOwner({
      service: checkpointService(busyFixture, blockingTarget),
      identitySeed: "home-checkpoint:anchor:blocking",
      clock: () => new Date("2026-08-08T12:00:00.000Z"),
    });
    busyOwner.start(false);
    const activeDaily = busyOwner.ensureDaily();
    await blockingTarget.entered;
    await expect(busyOwner.force("different-candidate")).rejects.toThrow(/checkpoint-candidate-busy/);
    blockingTarget.release();
    await activeDaily;
    await busyOwner.stop();
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

  it("persists only a finite verification failure code", async () => {
    const fixture = await authorityFixture();
    const target = new FailingReadTarget("backup-dir:failure-code", "filesystem:failure-code");
    const governor = recordingGovernor();
    const service = checkpointService(fixture, target, undefined, { storageMaintenance: governor.port });
    const checkpoint = await service.createAndReplicate({
      request: { kind: "forced", requestId: "failure-code" },
      createdAt: AT,
    });
    const requestsAfterInitialReplication = governor.requests.length;
    expect(requestsAfterInitialReplication).toBeGreaterThan(0);
    await service.createAndReplicate({
      request: { kind: "forced", requestId: "failure-code" },
      createdAt: AT,
    });
    expect(governor.requests.length).toBeGreaterThan(requestsAfterInitialReplication);
    await expect(service.verify({
      checkpointId: checkpoint.envelope.checkpointId,
      recoveryRoot: fixture.root,
    })).rejects.toThrow(/private-path/);
    const failure = (await checkpointRecords(fixture.log)).find((record) =>
      record.t === "checkpoint-verify-failed");
    expect(failure).toMatchObject({ t: "checkpoint-verify-failed", reason: "verification-failed" });
    expect(JSON.stringify(failure)).not.toContain("private-path");
    expect(governor.requests.every((request) => request.kind === "authority-checkpoint")).toBe(true);
  }, 120_000);
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
  const temporaryArtifacts = new FileArtifactStore(path.join(directory, "temporary"));
  const receiver = new FileResumableArtifactReceiver(
    temporaryArtifacts,
    path.join(directory, "partials"),
    { maxArtifactBytes: MAX_SURFACE_ASSET_BYTES },
  );
  const lifecycle = new ArtifactLifecycleIndex({
    rootDir: path.join(directory, "derived"),
    logs: [log],
    artifacts,
    temporaryArtifacts,
    temporaryPresence: new FileArtifactTemporaryPresenceStore(path.join(directory, "presence")),
    receiver,
  });
  return {
    key,
    identity,
    issuer: Object.assign({}, identity, { sign: key.sign.bind(key) }),
    projection,
    trust,
    root,
    artifacts,
    log,
    lifecycle,
  };
}

function checkpointService(
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
  target: RetirableRecoveryCheckpointTarget,
  clock: (() => string) | undefined = () => "2026-08-10T00:00:00.000Z",
  override: {
    readonly trust?: HomeTrustRecord;
    readonly recipient?: ReturnType<RecoveryRoot["publicIdentity"]>;
    readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  } = {},
) {
  return new AuthorityCheckpointService({
    log: fixture.log,
    artifacts: fixture.artifacts,
    retention: fixture.lifecycle,
    target,
    trust: override.trust ?? fixture.trust,
    issuer: fixture.issuer,
    recipient: override.recipient ?? fixture.root.publicIdentity(),
    currentAnchor: true,
    ...(override.storageMaintenance ? { storageMaintenance: override.storageMaintenance } : {}),
    ...(clock ? { clock } : {}),
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

class ResponseLossTarget extends MemoryTarget {
  #loseResponse = true;

  override async writeDurable(checkpoint: CheckpointPackage): Promise<void> {
    await super.writeDurable(checkpoint);
    if (this.#loseResponse) {
      this.#loseResponse = false;
      throw new Error("target response lost after durable write");
    }
  }
}

class BlockingTarget extends MemoryTarget {
  readonly entered: Promise<void>;
  #enter!: () => void;
  #release!: () => void;
  readonly #gate: Promise<void>;

  constructor(targetId: string, independenceDomain: string) {
    super(targetId, independenceDomain);
    this.entered = new Promise((resolve) => { this.#enter = resolve; });
    this.#gate = new Promise((resolve) => { this.#release = resolve; });
  }

  override async writeDurable(checkpoint: CheckpointPackage): Promise<void> {
    this.#enter();
    await this.#gate;
    await super.writeDurable(checkpoint);
  }

  release(): void {
    this.#release();
  }
}

class FailingReadTarget extends MemoryTarget {
  override async read(): Promise<CheckpointPackage> {
    throw new Error("private-path:C:/Users/example/recovery-secret");
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

function recordingGovernor(): {
  readonly port: StorageMaintenanceGovernorPort;
  readonly requests: StorageMaintenanceRequest[];
} {
  const requests: StorageMaintenanceRequest[] = [];
  const permit = {
    granted: {
      memoryReservationBytes: 0,
      temporaryBytes: 0,
      slots: 0,
      readBytes: Number.MAX_SAFE_INTEGER,
      writeBytes: Number.MAX_SAFE_INTEGER,
      ioOperations: Number.MAX_SAFE_INTEGER,
    },
    tryBegin: () => ({ claim: () => undefined, complete: () => undefined }),
    release: () => undefined,
  };
  return {
    requests,
    port: {
      acquire: async (request): Promise<DeviceCapacityAdmission> => {
        requests.push(request);
        return { kind: "granted", permit };
      },
      snapshot: () => ({ queued: {}, inFlight: {} }),
    },
  };
}
