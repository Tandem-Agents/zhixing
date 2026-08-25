import { link, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  ArtifactLifecycleIndex,
  FileArtifactStore,
  FileArtifactTemporaryPresenceStore,
  FileAuthorityCommitLog,
  FileResumableArtifactReceiver,
  type ArtifactCheckpointRetentionPort,
  type ArtifactStore,
  type AuthorityCommitLog,
  type DurableLogCheckpoint,
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
import {
  createRootActivationCheckpoint,
  openFullAuthorityCheckpoint,
  readCheckpointChunk,
  verifyStoredFullAuthorityCheckpoint,
  type CheckpointPackage,
} from "../checkpoint.js";
import { DeviceKey, enrollDeviceIdentity } from "../device-identity.js";
import { captureFullAuthorityCheckpoint } from "../full-checkpoint.js";
import {
  FilePairedCheckpointStaging,
  PairedCheckpointReceiver,
  PairedRecoveryCheckpointTarget,
  decodePairedCheckpointResult,
  type PairedCheckpointTransport,
} from "../paired-checkpoint-target.js";
import {
  decodeRecoveryPackage,
  encodeRecoveryPackage,
  requireCurrentRecoveryPackage,
} from "../recovery-package.js";
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
      {
        t: "checkpoint.inventory",
        requestId: "request-1",
        targetId: "backup-device:device-target",
        recipientKeyId: manifest.checkpoint.envelope.recipientKeyId,
        entries: [{ checkpointId: manifest.checkpoint.envelope.checkpointId, envelope: manifest.checkpoint.envelope }],
      },
      { t: "checkpoint.range", checkpointId: "checkpoint-1", seq: 0, offset: 0, bytes: "YQ" },
      { t: "checkpoint.retired", checkpointId: "checkpoint-1", supersededBy: "checkpoint-2" },
      {
        t: "checkpoint.root-activated",
        checkpointId: "checkpoint-1",
        chainHead: { seq: 2, eventDigest: `sha256:${"2".repeat(64)}` },
      },
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
    const readLimits: number[] = [];
    const boundedLog = {
      originCheckpoint: fixture.log.originCheckpoint.bind(fixture.log),
      checkpoint: fixture.log.checkpoint.bind(fixture.log),
      readEnvelopeAt: fixture.log.readEnvelopeAt.bind(fixture.log),
      readTail: async (checkpoint: DurableLogCheckpoint, limit: number) => {
        readLimits.push(limit);
        return fixture.log.readTail(checkpoint, limit);
      },
    } as unknown as AuthorityCommitLog;
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
      log: boundedLog,
      artifacts: fixture.artifacts,
      retention: fixture.lifecycle,
    });
    expect(readLimits.length).toBeGreaterThanOrEqual(2);
    expect(readLimits.every((limit) => limit === 1)).toBe(true);
    await fixture.log.append([{ stream: "control", body: { t: "later" } }]);

    expect(captured.source.payload.source.lsn).toBe(1);
    expect(captured.source.payload.retainedArtifacts.entries).toEqual([businessRef]);
    expect(captured.source.payload.coverage.classes).toEqual([
      "global-authority",
      "conversation-authority",
      "conversation-content",
      "execution-assets",
    ]);
    const materialized = await materializePackage(captured.checkpoint);
    const opened = openFullAuthorityCheckpoint({
      package: materialized,
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
    const tampered = clonePackage(materialized);
    tampered.chunks[0]!.bytes[0] ^= 1;
    expect(() => openFullAuthorityCheckpoint({
      package: tampered,
      recoveryRoot: fixture.root,
      issuer: fixture.identity,
    })).toThrow(/chunk content/);

    const unknownHeader = clonePackage(materialized);
    (unknownHeader.envelope as unknown as Record<string, unknown>).unexpected = true;
    expect(() => openFullAuthorityCheckpoint({
      package: unknownHeader,
      recoveryRoot: fixture.root,
      issuer: fixture.identity,
    })).toThrow(/missing or unknown fields/);

    const duplicateChunk = clonePackage(materialized);
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

  it("streams verified full contents into a transfer-private artifact store", async () => {
    const fixture = await authorityFixture();
    const retained = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
    const retainedRef = await fixture.artifacts.put(retained);
    await fixture.log.append([{ stream: "control", body: { t: "global-state-write", ref: retainedRef } }]);
    const captured = await captureFullAuthorityCheckpoint({
      checkpointId: "01J0000000000000000000000S",
      createdAt: AT,
      purpose: { kind: "periodic" },
      trust: fixture.trust,
      issuer: fixture.issuer,
      recipient: fixture.root.publicIdentity(),
      log: fixture.log,
      artifacts: fixture.artifacts,
      retention: fixture.lifecycle,
    });
    const root = await createTempDir("checkpoint-private-import");
    const store = new FileArtifactStore(path.join(root, "artifacts"));
    const receiver = new FileResumableArtifactReceiver(store, path.join(root, "partials"), {
      maxArtifactBytes: MAX_SURFACE_ASSET_BYTES,
      maxChunkBytes: 1024 * 1024,
    });
    const writes: number[] = [];
    const verified = await verifyStoredFullAuthorityCheckpoint({
      package: captured.checkpoint,
      recoveryRoot: fixture.root,
      issuer: fixture.identity,
      sink: {
        write: async (content, offset, bytes) => {
          writes.push(bytes.byteLength);
          const progress = await receiver.append(content.ref, offset, bytes);
          if (offset + bytes.byteLength === content.ref.bytes && !progress.complete) {
            throw new Error("Private checkpoint content did not finalize");
          }
        },
      },
    });
    try {
      expect(verified.payload.source).toEqual(captured.source.payload.source);
      expect(Math.max(...writes)).toBeLessThanOrEqual(1024 * 1024);
      expect(await store.get(retainedRef)).toEqual(retained);
      for (const page of verified.payload.records.pages) {
        expect(await store.has({ digest: page.digest, bytes: page.bytes })).toBe(true);
      }
    } finally {
      verified.verificationNonce.fill(0);
      retained.fill(0);
    }
  }, 120_000);

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

  it("rejects an oversized retention directory while refs are entering the fixed header budget", async () => {
    const fixture = await authorityFixture();
    const origin: DurableLogCheckpoint = {
      logId: "header-budget",
      lsn: 0,
      frameEndOffset: 0,
      prefixDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };
    const target: DurableLogCheckpoint = {
      ...origin,
      lsn: 1,
      frameEndOffset: 1,
      prefixDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    };
    const commit = {
      v: 1 as const,
      t: "CommitEnvelope" as const,
      lsn: 1,
      at: AT,
      envelopeDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      entries: Array.from({ length: 12_000 }, (_, index) => ({
      stream: "control",
      body: {
        t: "global-state-write",
        ref: {
          digest: `sha256:${index.toString(16).padStart(64, "0")}`,
          bytes: 1,
        },
      },
      })),
    };
    const log = {
      originCheckpoint: async () => origin,
      checkpoint: async () => target,
      readTail: async (_checkpoint: DurableLogCheckpoint, limit: number) => {
        expect(limit).toBe(1);
        return { commits: [commit], checkpoint: target, hasMore: false };
      },
      readEnvelopeAt: async () => commit,
    } as unknown as AuthorityCommitLog;
    const retention = {
      checkpointRetentionSnapshot: async () => ({ sourceHeads: { [target.logId]: target } }),
      retainedAtCheckpoint: async () => {
        throw new Error("Retention filtering must not run after the header budget is exhausted");
      },
    } as ArtifactCheckpointRetentionPort;
    const artifacts = {
      readRange: async () => {
        throw new Error("Artifact content must not be read after the header budget is exhausted");
      },
    } as unknown as ArtifactStore;

    await expect(captureFullAuthorityCheckpoint({
      checkpointId: "01J00000000000000000000012",
      createdAt: AT,
      purpose: { kind: "periodic" },
      trust: fixture.trust,
      issuer: fixture.issuer,
      recipient: fixture.root.publicIdentity(),
      log,
      artifacts,
      retention,
    })).rejects.toThrow(/payload header exceeds/);
  }, 120_000);

  it("derives distinct current-ready generations for chain changes and same-day root rotation", async () => {
    const fixture = await authorityFixture();
    const target = new MemoryTarget("backup-dir:independent", "filesystem:independent");
    const request = { kind: "daily" as const, day: "2026-08-08" };
    const original = checkpointService(fixture, target);
    const first = await original.createAndReplicate({ request, createdAt: AT });
    await original.verify({ checkpointId: first.envelope.checkpointId, recoveryRoot: fixture.root });
    expect(await original.status()).toMatchObject({ state: "recoverable", fullBackupReady: true });

    const changedTarget = checkpointService(
      fixture,
      new MemoryTarget("backup-dir:replacement", "filesystem:replacement"),
    );
    expect(await changedTarget.status()).toEqual({
      state: "not-configured",
      fullBackupReady: false,
      targetId: "backup-dir:replacement",
    });

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
    expect(await chainService.status()).toEqual({
      state: "not-configured",
      fullBackupReady: false,
      targetId: "backup-dir:independent",
    });
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
    expect(await rotatedService.status()).toEqual({
      state: "not-configured",
      fullBackupReady: false,
      targetId: "backup-dir:independent",
    });
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
    expect(await service.verificationCandidate()).toEqual({
      checkpointId: second.envelope.checkpointId,
      targetId: target.targetId,
    });
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

    await fixture.log.append([{
      stream: "checkpoint",
      body: {
        t: "checkpoint-cleanup-progress",
        checkpointId: first.envelope.checkpointId,
        supersededBy: second.envelope.checkpointId,
        targetId: target.targetId,
        phase: "local-released",
        at: "2026-08-10T00:00:00.000Z",
      } satisfies CheckpointStreamRecord,
    }, {
      stream: "checkpoint",
      body: {
        t: "checkpoint-cleanup-progress",
        checkpointId: first.envelope.checkpointId,
        supersededBy: second.envelope.checkpointId,
        targetId: target.targetId,
        phase: "local-released",
        at: "2026-08-11T00:00:00.000Z",
      } satisfies CheckpointStreamRecord,
    }]);
    expect(await service.status()).toMatchObject({
      state: "recoverable",
      checkpointId: second.envelope.checkpointId,
    });

    await service.cleanupExpired("2026-09-05T23:59:59.999Z");
    expect(target.has(first.envelope.checkpointId)).toBe(true);
    await service.cleanupExpired("2026-09-06T00:00:00.000Z");
    expect(target.has(first.envelope.checkpointId)).toBe(false);
    expect(target.has(second.envelope.checkpointId)).toBe(true);
  }, 120_000);

  it("replays an old target obligation and records only target retirement after a binding switch", async () => {
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
    expect(await currentService.verificationCandidate()).toEqual({
      checkpointId: oldCreated.checkpointId,
      targetId: oldTarget.targetId,
    });
    await currentService.verify({ checkpointId: oldCreated.checkpointId, recoveryRoot: fixture.root });

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
      .toEqual(["target-retired"]);
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
    const root = await createTempDir("checkpoint-paired");
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
    const incoming = path.join(root, "incoming");
    await rename(incoming, `${incoming}.original`);
    await mkdir(incoming);
    const staleRetired = path.join(`${incoming}.original`,
      `.${captured.checkpoint.envelope.checkpointId}.${byteDigest(
        Buffer.from(canonicalize(captured.checkpoint.envelope), "utf8"),
      ).slice(7, 23)}.retired`);
    await mkdir(staleRetired);
    await writeFile(path.join(staleRetired, "envelope.json"), canonicalize(captured.checkpoint.envelope));
    await target.writeDurable(captured.checkpoint);
    expect(await readdir(incoming)).toEqual([]);
    expect((await readdir(`${incoming}.original`)).some((entry) => entry.endsWith(".retired")))
      .toBe(false);
    const remote = await materializePackage(await target.read(captured.checkpoint.envelope.checkpointId));
    const local = await materializePackage(captured.checkpoint);
    expect(materializedBytes(remote)).toEqual(materializedBytes(local));

    const initialRootCheckpoint = createRootActivationCheckpoint({
      checkpointId: "01J00000000000000000000006",
      createdAt: AT,
      plan: { v: 1, kind: "establish", rootEvent: fixture.rootEvent },
      recoveryRoot: fixture.root,
      issuer: fixture.issuer,
      scope: ["trust"],
      domainRevisions: { trust: fixture.initial.chainHead.seq },
      upToLsn: fixture.initial.chainHead.seq,
      plaintextChunks: [Buffer.from("root establishment")],
    });
    const rootEstablishmentStaging = path.join(root, "root-establishment-incoming");
    const rootEstablishmentReceiver = () => new PairedCheckpointReceiver({
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      rootEstablishment: true,
      staging: new FilePairedCheckpointStaging({
        root: rootEstablishmentStaging,
        target: durable,
        storageMaintenance: governor.port,
      }),
    });
    const rootEstablishmentTarget = (receiver: PairedCheckpointReceiver) =>
      new PairedRecoveryCheckpointTarget({
        homeId: fixture.trust.homeId,
        sourceDeviceId: fixture.identity.deviceId,
        targetDeviceId: "device-target",
        recipientKeyId: initialRootCheckpoint.envelope.recipientKeyId,
        transport: receiver,
        storageMaintenance: sourceGovernor.port,
      });
    await rootEstablishmentTarget(rootEstablishmentReceiver()).writeDurable(initialRootCheckpoint);
    const restartedReceiver = rootEstablishmentReceiver();
    await expect(restartedReceiver.request({
      v: 1,
      t: "checkpoint.begin",
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      envelope: initialRootCheckpoint.envelope,
    })).resolves.toEqual({
      t: "checkpoint.begun",
      checkpointId: initialRootCheckpoint.envelope.checkpointId,
    });
    await expect(restartedReceiver.request({
      v: 1,
      t: "checkpoint.begin",
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      envelope: {
        ...initialRootCheckpoint.envelope,
        checkpointId: "01J00000000000000000000007",
      },
    })).rejects.toThrow(/already bound/);

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

  it("inventories only complete full checkpoints and strictly binds paired inventory results", async () => {
    const fixture = await authorityFixture();
    const captured = await captureFullAuthorityCheckpoint({
      checkpointId: "01J00000000000000000000031",
      createdAt: AT,
      purpose: { kind: "periodic" },
      trust: fixture.trust,
      issuer: fixture.issuer,
      recipient: fixture.root.publicIdentity(),
      log: fixture.log,
      artifacts: fixture.artifacts,
      retention: fixture.lifecycle,
    });
    const root = await createTempDir("checkpoint-inventory");
    const targetRoot = path.join(root, "target");
    const durable = await FileRecoveryCheckpointTarget.openPaired({
      targetRoot,
      targetDeviceId: "device-target",
    });
    await durable.writeDurable(captured.checkpoint);

    const trustOnly = clonePackage(await materializePackage(captured.checkpoint));
    trustOnly.envelope = {
      ...trustOnly.envelope,
      checkpointId: "01J00000000000000000000032",
      manifest: { ...trustOnly.envelope.manifest, scope: ["trust"] },
    };
    await durable.writeDurable(trustOnly);
    await mkdir(path.join(targetRoot, "01J00000000000000000000033"));
    await writeFile(path.join(targetRoot, "01J00000000000000000000033", "envelope.json"), "{}");
    await writeFile(path.join(targetRoot, "unrelated.txt"), "not a checkpoint");

    await expect(durable.inventory("inventory-1")).resolves.toEqual([{
      checkpointId: captured.checkpoint.envelope.checkpointId,
      targetId: "backup-device:device-target",
      recipientKeyId: captured.checkpoint.envelope.recipientKeyId,
      envelope: captured.checkpoint.envelope,
    }]);

    const receiver = new PairedCheckpointReceiver({
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      recipientKeyId: captured.checkpoint.envelope.recipientKeyId,
      staging: new FilePairedCheckpointStaging({
        root: path.join(root, "incoming"),
        target: durable,
      }),
    });
    const paired = new PairedRecoveryCheckpointTarget({
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      recipientKeyId: captured.checkpoint.envelope.recipientKeyId,
      transport: receiver,
    });
    await expect(paired.inventory("inventory-2")).resolves.toHaveLength(1);
    const unrelated = new PairedRecoveryCheckpointTarget({
      homeId: fixture.trust.homeId,
      sourceDeviceId: fixture.identity.deviceId,
      targetDeviceId: "device-target",
      recipientKeyId: captured.checkpoint.envelope.recipientKeyId,
      transport: {
        request: async () => ({
          t: "checkpoint.inventory",
          requestId: "other-request",
          targetId: "backup-device:device-target",
          recipientKeyId: captured.checkpoint.envelope.recipientKeyId,
          entries: [],
        }),
      },
    });
    await expect(unrelated.inventory("inventory-3")).rejects.toThrow(/unrelated inventory/);

    await durable.retire(captured.checkpoint.envelope.checkpointId, "01J00000000000000000000034");
    await expect(durable.inventory("inventory-4")).resolves.toEqual([]);
  }, 120_000);

  it("holds no capacity permit during paired range I/O and fails before decode when admission is unavailable", async () => {
    const fixture = await authorityFixture();
    const captured = await captureFullAuthorityCheckpoint({
      checkpointId: "01J00000000000000000000007",
      createdAt: AT,
      purpose: { kind: "periodic" },
      trust: fixture.trust,
      issuer: fixture.issuer,
      recipient: fixture.root.publicIdentity(),
      log: fixture.log,
      artifacts: fixture.artifacts,
      retention: fixture.lifecycle,
    });
    const descriptor = captured.checkpoint.envelope.chunks[0]!;
    const chunk = await readCheckpointChunk(captured.checkpoint, descriptor.seq);
    try {
      for (const admission of [
        { kind: "capacity-gap", blockedBy: "memoryReservationBytes", required: 1, available: 0 },
        { kind: "cancelled" },
      ] as const) {
        let finishRange!: () => void;
        let markRequested!: () => void;
        const rangeGate = new Promise<void>((resolve) => { finishRange = resolve; });
        const requested = new Promise<void>((resolve) => { markRequested = resolve; });
        const transport: PairedCheckpointTransport = {
          request: async (command) => {
            if (command.t === "checkpoint.get") {
              return {
                t: "checkpoint.manifest",
                checkpointId: command.checkpointId,
                envelope: captured.checkpoint.envelope,
              };
            }
            if (command.t !== "checkpoint.range") throw new Error("unexpected command");
            markRequested();
            await rangeGate;
            return {
              t: "checkpoint.range",
              checkpointId: command.checkpointId,
              seq: command.seq,
              offset: command.offset,
              bytes: chunk.subarray(command.offset, command.offset + command.limit).toString("base64url"),
            };
          },
        };
        let acquireCalls = 0;
        const target = new PairedRecoveryCheckpointTarget({
          homeId: fixture.trust.homeId,
          sourceDeviceId: fixture.identity.deviceId,
          targetDeviceId: "capacity-target",
          recipientKeyId: captured.checkpoint.envelope.recipientKeyId,
          transport,
          storageMaintenance: {
            acquire: async () => {
              acquireCalls += 1;
              return admission as DeviceCapacityAdmission;
            },
            snapshot: () => ({ queued: {}, inFlight: {} }),
          },
        });
        const remote = await target.read(captured.checkpoint.envelope.checkpointId);
        const reading = remote.source!.read(
          descriptor.seq,
          0,
          Math.min(descriptor.bytes, 256 * 1024),
        );
        await requested;
        expect(acquireCalls).toBe(0);
        finishRange();
        await expect(reading).rejects.toThrow(/capacity|cancelled/i);
        expect(acquireCalls).toBe(1);
      }
    } finally {
      chunk.fill(0);
    }
  }, 120_000);

  it("rejects non-independent or linked directory roots before writing", async () => {
    const root = await createTempDir("checkpoint-directory");
    const source = path.join(root, "authority");
    const target = path.join(root, "backup");
    await mkdir(source);
    await mkdir(target);
    await expect(FileRecoveryCheckpointTarget.open({ sourceRoot: source, targetRoot: target }))
      .rejects.toThrow(/physically independent/);

    const missing = path.join(root, "missing-target");
    await expect(FileRecoveryCheckpointTarget.open({
      sourceRoot: source,
      targetRoot: missing,
      create: false,
    })).rejects.toThrow();
    expect(await readdir(root)).not.toContain("missing-target");

    const linked = path.join(root, "linked-target");
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(FileRecoveryCheckpointTarget.openPaired({
      targetRoot: linked,
      targetDeviceId: "device-target",
    })).rejects.toThrow(/symbolic link|real directory|reparse point/);
  });

  it("keeps configured-root replacement on the frozen object and rejects final-file hard links", async () => {
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
    const root = await createTempDir("checkpoint-identity");
    const replacedRoot = path.join(root, "replaced");
    await mkdir(replacedRoot);
    const replacedTarget = await FileRecoveryCheckpointTarget.openPaired({
      targetRoot: replacedRoot,
      targetDeviceId: "device-target",
    });
    await rename(replacedRoot, `${replacedRoot}.original`);
    await mkdir(replacedRoot);
    await replacedTarget.writeDurable(captured.checkpoint);
    expect(await readdir(replacedRoot)).toEqual([]);
    expect(await readdir(`${replacedRoot}.original`)).toContain(captured.checkpoint.envelope.checkpointId);

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
    await writeFile(path.join(staleStaging, "envelope.json"), canonicalize(captured.checkpoint.envelope));
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
  }, 120_000);

  it("strictly discriminates current and legacy trust-only recovery packages", async () => {
    const fixture = await authorityFixture();
    const current = encodeRecoveryPackage(fixture.root);
    expect(current.startsWith("zxrp2:")).toBe(true);
    expect(decodeRecoveryPackage(current)).toMatchObject({
      version: 2,
      root: expect.any(RecoveryRoot),
    });
    const currentPayload = JSON.parse(Buffer.from(current.slice(6), "base64url").toString("utf8")) as Record<string, unknown>;
    expect(() => decodeRecoveryPackage(`zxrp2:${Buffer.from(canonicalize({
      ...currentPayload,
      extra: true,
    }), "utf8").toString("base64url")}`)).toThrow(/unknown fields/);
    expect(() => decodeRecoveryPackage(`zxrp2:${Buffer.from(canonicalize({
      ...currentPayload,
      rootIdentity: { ...(currentPayload.rootIdentity as Record<string, unknown>), rootKeyId: "wrong" },
    }), "utf8").toString("base64url")}`)).toThrow(/does not match/);

    const checkpoint = createRootActivationCheckpoint({
      checkpointId: "01J00000000000000000000009",
      createdAt: AT,
      plan: { v: 1, kind: "establish", rootEvent: fixture.rootEvent },
      recoveryRoot: fixture.root,
      issuer: fixture.issuer,
      scope: ["trust"],
      domainRevisions: { trust: fixture.initial.chainHead.seq },
      upToLsn: fixture.initial.chainHead.seq,
      plaintextChunks: [Buffer.from("legacy trust checkpoint")],
    });
    const legacy = legacyRecoveryPackage(fixture.root, checkpoint);
    const decodedLegacy = decodeRecoveryPackage(legacy);
    expect(decodedLegacy).toMatchObject({
      version: 1,
      root: expect.any(RecoveryRoot),
      checkpoint: { envelope: { checkpointId: checkpoint.envelope.checkpointId } },
    });
    expect(() => requireCurrentRecoveryPackage(decodedLegacy)).toThrow(
      "valid only for initial root activation",
    );

    const legacyPayload = JSON.parse(
      Buffer.from(legacy.slice(6), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(() => decodeRecoveryPackage(`zxrp1:${Buffer.from(canonicalize({
      ...legacyPayload,
      extra: true,
    }), "utf8").toString("base64url")}`)).toThrow(/unknown fields/);
    expect(() => decodeRecoveryPackage(`zxrp1:${Buffer.from(canonicalize({
      ...legacyPayload,
      recoverySecret: RecoveryRoot.generate().exportSecret(),
    }), "utf8").toString("base64url")}`)).toThrow(/does not match/);
    const legacyCheckpoint = legacyPayload.checkpoint as {
      chunks: Array<{ seq: number; bytes: string }>;
      envelope: Record<string, unknown>;
    };
    expect(() => decodeRecoveryPackage(`${legacy}=`)).toThrow(/canonical/);
    expect(() => decodeRecoveryPackage(`zxrp1:${Buffer.from(canonicalize({
      ...legacyPayload,
      checkpoint: {
        ...legacyCheckpoint,
        envelope: {
          ...legacyCheckpoint.envelope,
          recipientKeyId: "wrong-recipient",
        },
      },
    }), "utf8").toString("base64url")}`)).toThrow(/does not match/);
    const manifest = legacyCheckpoint.envelope.manifest as Record<string, unknown>;
    expect(() => decodeRecoveryPackage(`zxrp1:${Buffer.from(canonicalize({
      ...legacyPayload,
      checkpoint: {
        ...legacyCheckpoint,
        envelope: {
          ...legacyCheckpoint.envelope,
          manifest: { ...manifest, scope: ["trust", "global-authority"] },
        },
      },
    }), "utf8").toString("base64url")}`)).toThrow(/trust-only/);
    const purpose = manifest.purpose as Record<string, unknown>;
    const plan = purpose.plan as Record<string, unknown>;
    const legacyRootEvent = plan.rootEvent as Record<string, unknown>;
    expect(() => decodeRecoveryPackage(`zxrp1:${Buffer.from(canonicalize({
      ...legacyPayload,
      checkpoint: {
        ...legacyCheckpoint,
        envelope: {
          ...legacyCheckpoint.envelope,
          manifest: {
            ...manifest,
            purpose: {
              ...purpose,
              plan: {
                ...plan,
                rootEvent: {
                  ...legacyRootEvent,
                  body: {
                    ...(legacyRootEvent.body as Record<string, unknown>),
                    rootPublicKey: "wrong-root",
                  },
                },
              },
            },
          },
        },
      },
    }), "utf8").toString("base64url")}`)).toThrow(/does not match/);
    expect(() => decodeRecoveryPackage(`zxrp1:${Buffer.from(canonicalize({
      ...legacyPayload,
      checkpoint: {
        ...legacyCheckpoint,
        chunks: [{ ...legacyCheckpoint.chunks[0], bytes: "dGFtcGVy" }],
      },
    }), "utf8").toString("base64url")}`)).toThrow(/does not match its envelope/);
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
  const directory = await createTempDir("checkpoint-authority");
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
  onTestFinished(() => lifecycle.stopStorageMaintenance());
  return {
    key,
    identity,
    issuer: Object.assign({}, identity, { sign: key.sign.bind(key) }),
    projection,
    initial,
    rootEvent,
    trust,
    root,
    artifacts,
    log,
    lifecycle,
  };
}

function legacyRecoveryPackage(root: RecoveryRoot, checkpoint: CheckpointPackage): string {
  return `zxrp1:${Buffer.from(canonicalize({
    v: 1,
    recoverySecret: root.exportSecret(),
    checkpoint: {
      envelope: checkpoint.envelope,
      chunks: checkpoint.chunks?.map((chunk) => ({
        seq: chunk.seq,
        bytes: Buffer.from(chunk.bytes).toString("base64url"),
      })) ?? [],
    },
  }), "utf8").toString("base64url")}`;
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
    this.#values.set(checkpoint.envelope.checkpointId, checkpoint);
  }
  async read(checkpointId: string) {
    const value = this.#values.get(checkpointId);
    if (!value) throw new Error("checkpoint not present");
    return value;
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
  if (!checkpoint.chunks) throw new TypeError("test package is not materialized");
  return {
    envelope: JSON.parse(JSON.stringify(checkpoint.envelope)) as CheckpointPackage["envelope"],
    chunks: checkpoint.chunks.map((chunk) => ({ seq: chunk.seq, bytes: Buffer.from(chunk.bytes) })),
  };
}

async function materializePackage(checkpoint: CheckpointPackage): Promise<CheckpointPackage> {
  const chunks = [];
  for (const descriptor of checkpoint.envelope.chunks) {
    chunks.push({ seq: descriptor.seq, bytes: await readCheckpointChunk(checkpoint, descriptor.seq) });
  }
  return { envelope: checkpoint.envelope, chunks };
}

function canonicalPackage(checkpoint: CheckpointPackage): string {
  return canonicalize(checkpoint.envelope);
}

function materializedBytes(checkpoint: CheckpointPackage): readonly string[] {
  if (!checkpoint.chunks) throw new TypeError("test package is not materialized");
  return checkpoint.chunks.map((chunk) => Buffer.from(chunk.bytes).toString("base64url"));
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
