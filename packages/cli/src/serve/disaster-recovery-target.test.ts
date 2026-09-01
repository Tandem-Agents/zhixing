import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import type {
  ArtifactRef,
  DeviceIdentity,
  DisasterRecoveryCommand,
  SecretRef,
  SecretStorePort,
} from "@zhixing/core/contracts";
import { FileAuthorityCommitLog } from "@zhixing/core/authority";
import {
  createSignedDisasterRecoveryAbort,
  createSignedDisasterRecoveryCommand,
  protocolDigest,
} from "@zhixing/core/protocol";
import { captureFullAuthorityCheckpoint } from "@zhixing/mesh/full-checkpoint";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import {
  createRecoveryRootEvent,
  createSignedTrustEvent,
} from "@zhixing/mesh/trust-chain";
import { createCredentialExposureRecord } from "@zhixing/mesh/credential-exposure";
import { createPlannedAnchorReadinessCoordinator } from "../setup-delivery.js";
import {
  FileDisasterRecoveryCandidateJournal,
  type DisasterRecoveryInstallDecision,
} from "./disaster-recovery-candidate.js";
import { loadCurrentDisasterRecoveryInstallation } from "./disaster-recovery-installation.js";
import {
  completeDisasterRecoveryInstallationBeforeBootstrap,
  DisasterRecoveryTarget,
} from "./disaster-recovery-target.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

const AT = "2026-08-10T00:00:00.000Z";
const NOW = Date.parse("2026-08-10T01:00:00.000Z");
describe("disaster recovery target", () => {
  it("durably single-flights the selected source-less checkpoint before private effects", async () => {
    const fixture = await createFixture();
    const journal = new FileDisasterRecoveryCandidateJournal(
      new FileAuthorityCommitLog(
        path.join(fixture.stagingRoot, "candidate-claims"),
        fixture.targetStore.artifactStore(),
      ),
      fixture.recoveryRoot.rootPublicKey,
    );
    const first = prepareCommand(fixture, "request-first", "xfer-01KXPWTM80BYB4SH423EJT1CV1");
    expect(await journal.claim(first)).toEqual({ prepare: first });
    expect(await journal.claim(first)).toEqual({ prepare: first });

    const second = prepareCommand(fixture, "request-second", "xfer-01KXPWTM80BYB4SH423EJT1CV2");
    await expect(journal.claim(second)).rejects.toThrow(/candidate|progress|active/i);
    expect(await fixture.secrets.list()).toEqual([]);
  }, 120_000);

  it("truly unseals, privately imports, atomically installs and replays one disaster generation", async () => {
    const fixture = await createFixture();
    const target = fixture.createTarget();
    const prepare = prepareCommand(fixture, "request-recover", "xfer-01KXPWTM80BYB4SH423EJT1CV3");
    const imported = await target.prepareAndImport({
      prepare,
      checkpoint: fixture.checkpoint,
      recoveryRoot: fixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(fixture),
    });
    expect(imported.state.phase).toBe("imported");
    expect(imported.state.imported?.onsiteVerification.targetId).toBe("backup-dir:test");
    expect(imported.state.imported?.catalog.pendingObligations).toBeDefined();
    expect(await loadCurrentDisasterRecoveryInstallation(fixture.targetStore.authorityLog()))
      .toBeUndefined();

    const committed = await target.commit({
      transferId: prepare.transferId,
      recoveryRoot: fixture.recoveryRoot,
    });
    expect(committed.state.phase).toBe("committed");
    expect(committed.trustRecord.issuer.deviceId).toBe(fixture.targetIdentity.deviceId);
    expect(committed.trustRecord.anchorEpoch).toBeUndefined();
    expect(committed.trustRecord.members.find((member) =>
      member.device.deviceId === fixture.sourceIdentity.deviceId)?.state).toBe("revoked");
    expect((await loadCurrentDisasterRecoveryInstallation(
      fixture.targetStore.authorityLog(),
    ))?.installation.transferId).toBe(prepare.transferId);

    const replayTarget = fixture.createTarget();
    const replay = await replayTarget.commit({
      transferId: prepare.transferId,
      recoveryRoot: fixture.recoveryRoot,
    });
    expect(replay.installation).toEqual(committed.installation);
    const descriptor = await completeDisasterRecoveryInstallationBeforeBootstrap({
      zhixingHome: fixture.targetRoot,
      deviceId: fixture.targetIdentity.deviceId,
      secretStore: fixture.secrets,
      bootstrapStore: fixture.targetStore,
      stagingRoot: fixture.stagingRoot,
      now: () => NOW,
    });
    expect(descriptor?.installedGeneration).toMatchObject({
      mode: "disaster-recovery",
      transferId: prepare.transferId,
      anchorEpoch: 2,
    });
    expect(await replayTarget.tombstoneDisposition(prepare.transferId)).toBe("eligible");
    expect(await replayTarget.tombstoneDisposition("xfer-foreign")).toBe("ineligible");

    await expect(replayTarget.tombstone({
      transferId: prepare.transferId,
      userConfirmedOldDeviceIsolated: false,
    })).rejects.toThrow(/确认旧设备/);
    const tombstoned = await replayTarget.tombstone({
      transferId: prepare.transferId,
      userConfirmedOldDeviceIsolated: true,
      at: "2026-08-10T01:05:00.000Z",
    });
    expect(tombstoned.phase).toBe("tombstoned");
    expect(await replayTarget.tombstoneDisposition(prepare.transferId)).toBe("terminal");
    expect(await replayTarget.tombstone({
      transferId: prepare.transferId,
      userConfirmedOldDeviceIsolated: true,
    })).toEqual(tombstoned);
  }, 120_000);

  it("resumes a durable verified candidate without recomputing verification or imported bytes", async () => {
    const fixture = await createFixture({ retainedArtifact: true });
    const target = fixture.createTarget();
    const prepare = prepareCommand(fixture, "request-verified-replay", "xfer-01KXPWTM80BYB4SH423EJT1CV7");
    const originalRecordVerified = FileDisasterRecoveryCandidateJournal.prototype.recordVerified;
    const verifiedFault = vi.spyOn(
      FileDisasterRecoveryCandidateJournal.prototype,
      "recordVerified",
    ).mockImplementationOnce(async function(
      this: FileDisasterRecoveryCandidateJournal,
      transferId,
      verified,
    ) {
      await originalRecordVerified.call(this, transferId, verified);
      throw new Error("injected failure after verified sync");
    });
    await expect(target.prepareAndImport({
      prepare,
      checkpoint: fixture.checkpoint,
      recoveryRoot: fixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(fixture),
    })).rejects.toThrow(/after verified sync/);
    verifiedFault.mockRestore();

    const journal = fixture.candidateJournal();
    const frozenVerified = (await journal.state(prepare.transferId))?.verified;
    expect(frozenVerified).toBeDefined();
    fixture.advanceNow(60_000);
    const imported = await fixture.createTarget().prepareAndImport({
      prepare,
      checkpoint: fixture.checkpoint,
      recoveryRoot: fixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(fixture),
    });
    expect(imported.state.phase).toBe("imported");
    expect((await journal.state(prepare.transferId))?.verified).toEqual(frozenVerified);
    fixture.advanceNow(60_000);
    expect(await fixture.createTarget().prepareAndImport({
      prepare,
      checkpoint: fixture.checkpoint,
      recoveryRoot: fixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(fixture),
    })).toEqual(imported);
  }, 120_000);

  it("stores oversized verified and install decisions as strictly hydrated candidate artifacts", async () => {
    const verifiedFixture = await createFixture({ catalogStreams: 240 });
    const verifiedTarget = verifiedFixture.createTarget();
    const verifiedPrepare = prepareCommand(
      verifiedFixture,
      "request-oversized-candidate",
      "xfer-01KXPWTM80BYB4SH423EJT1CZA",
    );
    const originalRecordVerified = FileDisasterRecoveryCandidateJournal.prototype.recordVerified;
    const verifiedFault = vi.spyOn(
      FileDisasterRecoveryCandidateJournal.prototype,
      "recordVerified",
    ).mockImplementationOnce(async function(
      this: FileDisasterRecoveryCandidateJournal,
      transferId,
      verified,
    ) {
      await originalRecordVerified.call(this, transferId, verified);
      throw new Error("injected oversized verified response loss");
    });
    await expect(verifiedTarget.prepareAndImport({
      prepare: verifiedPrepare,
      checkpoint: verifiedFixture.checkpoint,
      recoveryRoot: verifiedFixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(verifiedFixture),
    })).rejects.toThrow(/oversized verified response loss/);
    verifiedFault.mockRestore();

    const verifiedRecords = (await verifiedFixture.candidateLog().readAll())
      .flatMap((envelope) => envelope.entries)
      .filter((entry) => entry.stream === "transfer:anchor-disaster-candidate")
      .map((entry) => entry.body as Record<string, unknown>);
    const verifiedRecord = verifiedRecords.find((record) =>
      record.t === "disaster-recovery-candidate-verified");
    expect(verifiedRecord).not.toHaveProperty("verifiedJson");
    const verifiedRef = verifiedRecord?.verifiedRef as ArtifactRef;
    expect(verifiedRef.bytes).toBeGreaterThan(32 * 1024);
    await expect(
      verifiedFixture.candidateJournal().state(verifiedPrepare.transferId),
    ).resolves.toMatchObject({
      verified: { catalog: { transferId: verifiedPrepare.transferId } },
    });
    await writeFile(
      verifiedFixture.targetStore.artifactStore().pathFor(verifiedRef),
      Buffer.from("corrupt candidate payload", "utf8"),
    );
    await expect(verifiedFixture.createTarget().prepareAndImport({
      prepare: verifiedPrepare,
      checkpoint: verifiedFixture.checkpoint,
      recoveryRoot: verifiedFixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(verifiedFixture),
    })).rejects.toThrow(/artifact|candidate|digest|size|corrupt/i);

    const decisionFixture = await createFixture();
    const decisionTarget = decisionFixture.createTarget();
    const decisionPrepare = prepareCommand(
      decisionFixture,
      "request-oversized-decision",
      "xfer-01KXPWTM80BYB4SH423EJT1CZD",
    );
    await decisionTarget.prepareAndImport({
      prepare: decisionPrepare,
      checkpoint: decisionFixture.checkpoint,
      recoveryRoot: decisionFixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(decisionFixture),
    });
    let capturedDecision: DisasterRecoveryInstallDecision | undefined;
    const decisionFault = vi.spyOn(
      FileDisasterRecoveryCandidateJournal.prototype,
      "decideInstall",
    ).mockImplementationOnce(async (_transferId, decision) => {
      capturedDecision = decision;
      throw new Error("injected before oversized decision append");
    });
    await expect(decisionTarget.commit({
      transferId: decisionPrepare.transferId,
      recoveryRoot: decisionFixture.recoveryRoot,
    })).rejects.toThrow(/before oversized decision append/);
    decisionFault.mockRestore();
    if (!capturedDecision) throw new Error("decision fixture did not reach install decision");
    const exposure = capturedDecision.installationEntries.find((entry) =>
      entry.stream === "exposure");
    if (!exposure) throw new Error("decision fixture has no compromised exposure");
    const expandedDecision: DisasterRecoveryInstallDecision = {
      ...capturedDecision,
      installationEntries: Object.freeze([
        ...capturedDecision.installationEntries.slice(0, -2),
        ...Array.from({ length: 180 }, (_, index) => ({
          stream: "exposure",
          body: {
            ...(exposure.body as Record<string, unknown>),
            bindingId: `provider:oversized-${index.toString().padStart(4, "0")}`,
          },
        })),
        ...capturedDecision.installationEntries.slice(-2),
      ]),
    };
    await decisionFixture.candidateJournal().decideInstall(
      decisionPrepare.transferId,
      expandedDecision,
    );
    const committed = await decisionTarget.commit({
      transferId: decisionPrepare.transferId,
      recoveryRoot: decisionFixture.recoveryRoot,
    });
    const decisionRecords = (await decisionFixture.candidateLog().readAll())
      .flatMap((envelope) => envelope.entries)
      .filter((entry) => entry.stream === "transfer:anchor-disaster-candidate")
      .map((entry) => entry.body as Record<string, unknown>);
    const decisionRecord = decisionRecords.find((record) =>
      record.t === "disaster-recovery-candidate-install-decided");
    expect(decisionRecord).not.toHaveProperty("decisionJson");
    const decisionRef = decisionRecord?.decisionRef as ArtifactRef;
    expect(decisionRef.bytes).toBeGreaterThan(32 * 1024);
    await expect(
      decisionFixture.candidateJournal().state(decisionPrepare.transferId),
    ).resolves.toMatchObject({
      installDecision: { installation: committed.installation },
      terminal: "committed",
    });

    const authorityBefore = await decisionFixture.targetAuthorityLog.readAll();
    await writeFile(
      decisionFixture.targetStore.artifactStore().pathFor(decisionRef),
      Buffer.from("corrupt decision payload", "utf8"),
    );
    await expect(decisionFixture.createTarget().commit({
      transferId: decisionPrepare.transferId,
      recoveryRoot: decisionFixture.recoveryRoot,
    })).rejects.toThrow(/artifact|candidate|digest|size|corrupt/i);
    await expect(decisionFixture.targetAuthorityLog.readAll()).resolves.toEqual(authorityBefore);
  }, 120_000);

  it("holds the target-wide claim from install decision through startup private completion", async () => {
    const fixture = await createFixture();
    const target = fixture.createTarget();
    const prepare = prepareCommand(fixture, "request-install-replay", "xfer-01KXPWTM80BYB4SH423EJT1CV8");
    await target.prepareAndImport({
      prepare,
      checkpoint: fixture.checkpoint,
      recoveryRoot: fixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(fixture),
    });
    const originalInstall = fixture.targetAuthorityLog.installPlannedAnchorPrefix.bind(
      fixture.targetAuthorityLog,
    );
    const installFault = vi.spyOn(
      fixture.targetAuthorityLog,
      "installPlannedAnchorPrefix",
    ).mockImplementationOnce(async (input) => {
      await originalInstall(input);
      throw new Error("injected lost install response");
    });
    await expect(target.commit({
      transferId: prepare.transferId,
      recoveryRoot: fixture.recoveryRoot,
    })).rejects.toThrow(/lost install response/);
    installFault.mockRestore();

    const journal = fixture.candidateJournal();
    const decided = await journal.state(prepare.transferId);
    expect(decided).toMatchObject({
      installDecision: { installation: { transferId: prepare.transferId } },
    });
    expect(decided?.terminal).toBeUndefined();
    const next = prepareCommand(fixture, "request-blocked", "xfer-01KXPWTM80BYB4SH423EJT1CV9");
    await expect(journal.claim(next)).rejects.toThrow(/candidate|progress/i);
    await expect(target.abort({
      abort: abortCommand(fixture, prepare),
      recoveryRoot: fixture.recoveryRoot,
    })).rejects.toThrow(/committed disaster recovery cannot be cancelled/i);

    const descriptor = await completeDisasterRecoveryInstallationBeforeBootstrap({
      zhixingHome: fixture.targetRoot,
      deviceId: fixture.targetIdentity.deviceId,
      secretStore: fixture.secrets,
      bootstrapStore: fixture.targetStore,
      stagingRoot: fixture.stagingRoot,
      now: fixture.now,
    });
    expect(descriptor?.state?.phase).toBe("committed");
    expect(await journal.state(prepare.transferId)).toMatchObject({
      installDecision: { installation: { transferId: prepare.transferId } },
      terminal: "committed",
    });
    expect(await journal.claim(next)).toEqual({ prepare: next });
    const replay = await fixture.createTarget().commit({
      transferId: prepare.transferId,
      recoveryRoot: fixture.recoveryRoot,
    });
    expect(replay.installation).toEqual(descriptor?.installation);
  }, 120_000);

  it("persists a root-signed abort before cleanup and rejects late commit", async () => {
    const fixture = await createFixture();
    const target = fixture.createTarget();
    const prepare = prepareCommand(fixture, "request-abort", "xfer-01KXPWTM80BYB4SH423EJT1CV4");
    await target.prepareAndImport({
      prepare,
      checkpoint: fixture.checkpoint,
      recoveryRoot: fixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(fixture),
    });
    const abort = createSignedDisasterRecoveryAbort({
      v: 1,
      mode: "disaster-recovery",
      requestId: prepare.requestId,
      transferId: prepare.transferId,
      targetDeviceId: prepare.targetDeviceId,
      checkpointTargetId: prepare.checkpointTargetId,
      checkpointEnvelopeDigest: prepare.checkpointEnvelope.digest,
      reason: "operator-cancelled",
      at: "2026-08-10T01:02:00.000Z",
    }, fixture.recoveryRoot);
    const state = await target.abort({ abort, recoveryRoot: fixture.recoveryRoot });
    expect(state.phase).toBe("aborted");
    expect(await target.abort({ abort, recoveryRoot: fixture.recoveryRoot })).toEqual(state);
    expect(await fixture.secrets.list()).toEqual([]);
    await expect(target.commit({
      transferId: prepare.transferId,
      recoveryRoot: fixture.recoveryRoot,
    })).rejects.toThrow(/verified|imported|terminal/i);
  }, 120_000);

  it("deletes a verified but not imported transfer key after authenticated abort", async () => {
    const fixture = await createFixture();
    const target = fixture.createTarget();
    const prepare = prepareCommand(
      fixture,
      "request-verified-abort",
      "xfer-01KXPWTM80BYB4SH423EJT1CZB",
    );
    const originalRecordVerified = FileDisasterRecoveryCandidateJournal.prototype.recordVerified;
    const verifiedFault = vi.spyOn(
      FileDisasterRecoveryCandidateJournal.prototype,
      "recordVerified",
    ).mockImplementationOnce(async function(
      this: FileDisasterRecoveryCandidateJournal,
      transferId,
      verified,
    ) {
      await originalRecordVerified.call(this, transferId, verified);
      throw new Error("injected failure before imported");
    });
    await expect(target.prepareAndImport({
      prepare,
      checkpoint: fixture.checkpoint,
      recoveryRoot: fixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(fixture),
    })).rejects.toThrow(/before imported/);
    verifiedFault.mockRestore();
    expect(await fixture.secrets.list()).toHaveLength(1);

    await expect(target.abort({
      abort: abortCommand(fixture, prepare),
      recoveryRoot: fixture.recoveryRoot,
    })).resolves.toMatchObject({ phase: "aborted" });
    expect(await fixture.secrets.list()).toEqual([]);
  }, 120_000);

  it("compensates an exact transfer key created after abort observed an empty slot", async () => {
    const fixture = await createFixture();
    const target = fixture.createTarget();
    const prepare = prepareCommand(
      fixture,
      "request-late-key-abort",
      "xfer-01KXPWTM80BYB4SH423EJT1CZC",
    );
    const entered = deferred<void>();
    const release = deferred<void>();
    fixture.secrets.beforePut = async (ref) => {
      if (!ref.bindingId.includes(prepare.transferId)) return;
      entered.resolve();
      await release.promise;
      fixture.secrets.beforePut = undefined;
    };

    const preparing = target.prepareAndImport({
      prepare,
      checkpoint: fixture.checkpoint,
      recoveryRoot: fixture.recoveryRoot,
      trustEvidence: await localTrustEvidence(fixture),
    });
    await entered.promise;
    await expect(target.abort({
      abort: abortCommand(fixture, prepare),
      recoveryRoot: fixture.recoveryRoot,
    })).resolves.toMatchObject({ phase: "aborted" });
    release.resolve();
    await expect(preparing).rejects.toThrow(/durably aborted/i);
    expect(await fixture.secrets.list()).toEqual([]);
  }, 120_000);

  it("persists a root-signed claim-only abort before any private phase exists", async () => {
    const fixture = await createFixture();
    const journal = new FileDisasterRecoveryCandidateJournal(
      new FileAuthorityCommitLog(
        path.join(fixture.stagingRoot, "candidate-claims"),
        fixture.targetStore.artifactStore(),
      ),
      fixture.recoveryRoot.rootPublicKey,
    );
    const prepare = prepareCommand(fixture, "request-claim-abort", "xfer-01KXPWTM80BYB4SH423EJT1CV5");
    await journal.claim(prepare);
    const target = fixture.createTarget();
    const abort = createSignedDisasterRecoveryAbort({
      v: 1,
      mode: "disaster-recovery",
      requestId: prepare.requestId,
      transferId: prepare.transferId,
      targetDeviceId: prepare.targetDeviceId,
      checkpointTargetId: prepare.checkpointTargetId,
      checkpointEnvelopeDigest: prepare.checkpointEnvelope.digest,
      reason: "operator-cancelled",
      at: "2026-08-10T01:02:00.000Z",
    }, fixture.recoveryRoot);

    const aborted = await target.abort({ abort, recoveryRoot: fixture.recoveryRoot });
    expect(aborted).toMatchObject({ phase: "aborted", transferId: prepare.transferId, abort });
    expect(await target.abort({ abort, recoveryRoot: fixture.recoveryRoot })).toEqual(aborted);
    expect(await fixture.secrets.list()).toEqual([]);
    expect(await journal.claim(prepare)).toEqual({
      prepare,
      terminal: "aborted",
      abort,
    });
    const next = prepareCommand(fixture, "request-after-abort", "xfer-01KXPWTM80BYB4SH423EJT1CV6");
    expect(await journal.claim(next)).toEqual({ prepare: next });
  }, 120_000);
});

async function localTrustEvidence(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const events = await fixture.targetStore.loadTrustEvents();
  const record = await fixture.targetStore.loadTrustRecord();
  if (!record) throw new Error("fixture trust record is missing");
  const cut = Object.freeze([fixture.targetIdentity.deviceId]);
  const evidence = Object.freeze([Object.freeze({
    deviceId: fixture.targetIdentity.deviceId,
    events,
    record,
  })]);
  return Object.freeze({
    cut,
    evidence,
    digest: protocolDigest("DisasterRecoveryReachabilityEvidence", 1, {
      cut,
      evidence: evidence.map((item) => ({
        deviceId: item.deviceId,
        chainHead: item.record.chainHead,
        trustEpoch: item.record.trustEpoch,
        recordDigest: protocolDigest("HomeTrustRecord", 1, item.record),
      })),
    }),
  });
}

async function createFixture(options: {
  readonly retainedArtifact?: boolean;
  readonly catalogStreams?: number;
} = {}) {
  const sourceRoot = await createTempDir("disaster-source");
  const targetRoot = await createTempDir("disaster-target");
  const sourceKey = await DeviceKey.generate();
  const targetKey = await DeviceKey.generate();
  const sourceIdentity = enroll(sourceKey, "lost anchor");
  const targetIdentity = enroll(targetKey, "recovery anchor");
  const sourceStore = new FileMeshBootstrapStore(sourceRoot, sourceKey);
  const targetStore = new FileMeshBootstrapStore(targetRoot, targetKey);
  let trust = await sourceStore.initializeLocalHome({
    key: sourceKey,
    identity: sourceIdentity,
    roles: ["anchor"],
    at: AT,
    homeId: "home-disaster",
  });
  const enrollTarget = createSignedTrustEvent({
    current: trust.projection,
    signer: sourceKey,
    at: "2026-08-10T00:01:00.000Z",
    body: { t: "enroll", device: targetIdentity, roles: ["anchor"] },
  });
  trust = await sourceStore.appendTrustEvent({ event: enrollTarget, issuerKey: sourceKey });
  const recoveryRoot = RecoveryRoot.generate();
  const rootEvent = createRecoveryRootEvent({
    current: trust,
    op: "establish",
    candidate: recoveryRoot,
    outerSigner: sourceKey,
    at: "2026-08-10T00:02:00.000Z",
  });
  trust = await sourceStore.appendTrustEvent({ event: rootEvent, issuerKey: sourceKey });
  const trustRecord = await sourceStore.loadTrustRecord();
  if (!trustRecord) throw new Error("fixture trust record is missing");
  await targetStore.importTrustBootstrap({
    events: await sourceStore.loadTrustEvents(),
    record: trustRecord,
    localDeviceId: targetIdentity.deviceId,
  });
  const activeExposure = createCredentialExposureRecord({
    deviceId: sourceIdentity.deviceId,
    bindingId: "provider:test",
    service: "provider",
    verifiedPrincipal: {
      verification: "service-verified",
      canonicalProviderPrincipal: "test@example.invalid",
    },
    markedAt: "2026-08-10T00:03:00.000Z",
  });
  await sourceStore.authorityLog().append([{ stream: "exposure", body: activeExposure }]);
  const catalogRecords = Array.from({ length: options.catalogStreams ?? 0 }, (_, index) => ({
    stream: `run:catalog-padding-${index.toString().padStart(4, "0")}`,
    body: {
      t: "catalog-padding",
      value: `${index}:`.padEnd(96, "x"),
    },
  }));
  for (let offset = 0; offset < catalogRecords.length; offset += 32) {
    await sourceStore.authorityLog().append(catalogRecords.slice(offset, offset + 32));
  }
  if (options.retainedArtifact) {
    const retained = await sourceStore.artifactStore().put(Buffer.from("retained-disaster-state"));
    await sourceStore.authorityLog().append([{
      stream: "control",
      body: { t: "global-state-write", ref: retained },
    }]);
  }
  const checkpoint = (await captureFullAuthorityCheckpoint({
    checkpointId: "01J000000000000000000000D1",
    createdAt: "2026-08-10T00:04:00.000Z",
    purpose: { kind: "periodic" },
    trust: trustRecord,
    issuer: Object.assign({}, sourceIdentity, { sign: sourceKey.sign.bind(sourceKey) }),
    recipient: recoveryRoot.publicIdentity(),
    log: sourceStore.authorityLog(),
    artifacts: sourceStore.artifactStore(),
    retention: sourceStore.checkpointRetention(),
  })).checkpoint;
  const secrets = new MemorySecretStore();
  const readiness = createPlannedAnchorReadinessCoordinator(async () => ({
    configuredCapabilities: { providers: [], mcpServers: [], channels: [] },
    protocolRevision: "protocol-disaster-v1",
    assetRevision: "assets-disaster-v1",
    serviceRevision: "services-disaster-v1",
    credentialRevision: "credentials-disaster-v1",
  }));
  const stagingRoot = path.join(targetRoot, "disaster-recovery-staging");
  const targetAuthorityLog = targetStore.authorityLog();
  let now = NOW;
  const createTarget = () => new DisasterRecoveryTarget({
    deviceId: targetIdentity.deviceId,
    identity: targetIdentity,
    identityKey: targetKey,
    secretStore: secrets,
    sharedArtifacts: targetStore.artifactStore(),
    authorityLog: targetAuthorityLog,
    stagingRoot,
    readiness: readiness.port,
    now: () => now,
  });
  return {
    sourceRoot,
    targetRoot,
    sourceIdentity,
    targetIdentity,
    sourceStore,
    targetStore,
    recoveryRoot,
    checkpoint,
    secrets,
    stagingRoot,
    targetAuthorityLog,
    now: () => now,
    advanceNow: (milliseconds: number) => {
      now += milliseconds;
    },
    candidateJournal: () => new FileDisasterRecoveryCandidateJournal(
      new FileAuthorityCommitLog(path.join(stagingRoot, "candidate-claims"), targetStore.artifactStore()),
      recoveryRoot.rootPublicKey,
    ),
    candidateLog: () => new FileAuthorityCommitLog(
      path.join(stagingRoot, "candidate-claims"),
      targetStore.artifactStore(),
    ),
    createTarget,
  };
}

function prepareCommand(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  requestId: string,
  transferId: string,
): Extract<DisasterRecoveryCommand, { op: "prepare" }> {
  const root = fixture.recoveryRoot.publicIdentity();
  return createSignedDisasterRecoveryCommand({
    v: 1,
    op: "prepare",
    requestId,
    transferId,
    targetDeviceId: fixture.targetIdentity.deviceId,
    checkpointTargetId: "backup-dir:test",
    recoveryRoot: {
      homeId: "home-disaster",
      rootKeyId: root.rootKeyId,
      recipientKeyId: root.backupKeyId,
    },
    checkpointEnvelope: fixture.checkpoint.envelope,
  }, fixture.recoveryRoot) as Extract<DisasterRecoveryCommand, { op: "prepare" }>;
}

function abortCommand(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  prepare: Extract<DisasterRecoveryCommand, { op: "prepare" }>,
) {
  return createSignedDisasterRecoveryAbort({
    v: 1,
    mode: "disaster-recovery",
    requestId: prepare.requestId,
    transferId: prepare.transferId,
    targetDeviceId: prepare.targetDeviceId,
    checkpointTargetId: prepare.checkpointTargetId,
    checkpointEnvelopeDigest: prepare.checkpointEnvelope.digest,
    reason: "operator-cancelled",
    at: "2026-08-10T01:02:00.000Z",
  }, fixture.recoveryRoot);
}

function enroll(key: DeviceKey, displayName: string): DeviceIdentity {
  return enrollDeviceIdentity(key, {
    displayName,
    platform: "headless",
    enrolledAt: AT,
  });
}

class MemorySecretStore implements SecretStorePort {
  readonly #values = new Map<string, string>();
  beforePut: ((ref: SecretRef) => Promise<void>) | undefined;

  async put(ref: SecretRef, value: string): Promise<void> {
    await this.beforePut?.(ref);
    this.#values.set(secretId(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.#values.get(secretId(ref)) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.#values.delete(secretId(ref));
  }

  async list(): Promise<readonly SecretRef[]> {
    return [...this.#values.keys()].map((value) => {
      const [kind, ...binding] = value.split("/");
      return { kind: kind as SecretRef["kind"], bindingId: binding.join("/") };
    });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function secretId(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
