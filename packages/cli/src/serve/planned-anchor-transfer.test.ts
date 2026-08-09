import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  DeviceIdentity,
  SecretRef,
  SecretStorePort,
  Signature,
} from "@zhixing/core/contracts";
import type { ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import type { SecureMeshConnection } from "@zhixing/mesh";
import type {
  MeshServiceDefinition,
  MeshServiceRegistry,
} from "@zhixing/mesh/service-registry";
import { DeviceKey, enrollDeviceIdentity, verifyDeviceSignature } from "@zhixing/mesh/device-identity";
import {
  loadActiveAnchorIssuerKey,
  loadAnchorIssuerKey,
} from "@zhixing/mesh/device-key-store";
import { createSignedTrustEvent } from "@zhixing/mesh/trust-chain";
import { afterEach, describe, expect, it } from "vitest";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import {
  FilePlannedAnchorTransferJournal,
  PlannedAnchorTransferOwner,
  PlannedAnchorTransferTarget,
  type PlannedAnchorTransferTargetPort,
} from "./planned-anchor-transfer.js";
import {
  PlannedAnchorTransferMeshClient,
  registerPlannedAnchorTransferMeshServices,
} from "./planned-anchor-transfer-mesh.js";

const roots: string[] = [];
const NOW = Date.now();
const AT = new Date(NOW).toISOString();
const TRANSFER_ID = "xfer-01J00000000000000000000001";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("planned anchor transfer prepared phase", () => {
  it("durably binds one ready target and one transfer-local issuer key on both logs", async () => {
    const fixture = await createFixture();
    const first = await fixture.owner.prepare({
      requestId: "request-1",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    const replay = await fixture.owner.prepare({
      requestId: "request-1",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });

    expect(first.phase).toBe("prepared");
    expect(replay.readyProof.targetIssuerKeyId).toBe(first.readyProof.targetIssuerKeyId);
    expect((await fixture.sourceJournal.state(TRANSFER_ID))?.phase).toBe("prepared");
    expect((await fixture.targetJournal.state(TRANSFER_ID))?.phase).toBe("prepared");
    expect(first.trustTransition.body.toIssuerPublicKey)
      .toBe(first.readyProof.targetIssuerPublicKey);
    expect(await fixture.sourceStore.loadTrustProjection()).toEqual(fixture.sourceTrust);
    expect(await fixture.targetStore.loadTrustProjection()).toEqual(fixture.sourceTrust);
  });

  it("rejects an overlapping migration before closing source admission", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-1",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await expect(fixture.owner.prepare({
      requestId: "request-2",
      transferId: "xfer-01J00000000000000000000002",
      targetDeviceId: fixture.targetKey.deviceId,
    })).rejects.toThrow("already in progress");
  });

  it("crosses the strict mesh service and authorizes only the current source", async () => {
    const fixture = await createFixture();
    const definitions = new Map<string, MeshServiceDefinition>();
    const registry = {
      register(serviceId: string, definition: MeshServiceDefinition) {
        definitions.set(serviceId, definition);
        return () => definitions.delete(serviceId);
      },
    } as MeshServiceRegistry;
    registerPlannedAnchorTransferMeshServices(registry, {
      target: () => fixture.target,
      targetDeviceId: fixture.targetKey.deviceId,
      currentSourceDeviceId: () => fixture.sourceKey.deviceId,
      verifier: fixture.verifier,
    });
    const sourceConnection = {
      peer: { deviceId: fixture.sourceKey.deviceId },
    } as unknown as SecureMeshConnection;
    const client = new PlannedAnchorTransferMeshClient({
      request: async (serviceId, payload, signal) => {
        const service = definitions.get(serviceId);
        if (!service || service.authorize?.(sourceConnection) === false) {
          throw new Error("unauthorized test service");
        }
        return service.handler(
          payload,
          sourceConnection,
          signal ?? new AbortController().signal,
        );
      },
    }, fixture.sourceKey.deviceId, fixture.targetKey.deviceId, fixture.verifier);
    const owner = new PlannedAnchorTransferOwner({
      deviceId: fixture.sourceKey.deviceId,
      anchorEpoch: () => 1,
      identityKey: fixture.sourceKey,
      bootstrapStore: fixture.sourceStore,
      log: fixture.sourceStore.authorityLog(),
      signer: fixture.sourceKey,
      verifier: fixture.verifier,
      targetFor: () => client,
      artifacts: fixture.sourceStore.artifactStore(),
      ensureRecoveryCheckpoint: async () => digest("mesh-recovery"),
      lifecycle: noOpLifecycle(),
    });

    expect((await owner.prepare({
      requestId: "request-mesh",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    })).phase).toBe("prepared");
    const ready = definitions.get("anchor.transfer.ready")!;
    expect(ready.authorize?.({
      peer: { deviceId: fixture.targetKey.deviceId },
    } as unknown as SecureMeshConnection)).toBe(false);
  });

  it("drains accepted work before freezing one durable source prefix and reinstalls the fence", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-fence",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    fixture.onDrain.current = async () => {
      await fixture.sourceStore.authorityLog().append([
        { stream: "run:test", body: { accepted: true } },
      ]);
    };

    const checkpoint = await fixture.owner.fence({
      requestId: "request-fence",
      transferId: TRANSFER_ID,
    });

    expect((await fixture.sourceJournal.state(TRANSFER_ID))?.phase).toBe("fenced");
    expect(checkpoint).toEqual(await fixture.sourceStore.authorityLog().checkpoint());
    await expect(fixture.sourceStore.authorityLog().append([
      { stream: "run:test", body: { fresh: true } },
    ])).rejects.toThrow("frozen authority writes");

    const restarted = fixture.createOwner();
    await restarted.recoverBeforeAdmission();
    await expect(fixture.sourceStore.authorityLog().append([
      { stream: "control", body: { fresh: true } },
    ])).rejects.toThrow("frozen authority writes");
  });

  it("exports one catalog-bound prefix and imports it only into target-private staging", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-import",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });

    const imported = await fixture.owner.freeze({
      requestId: "request-import",
      transferId: TRANSFER_ID,
    });

    expect(imported.phase).toBe("imported");
    expect((await fixture.target.state(TRANSFER_ID))?.phase).toBe("imported");
    expect(imported.catalog?.coverage).toEqual([
      "conversation-authority",
      "conversation-content",
      "execution-assets",
      "global-authority",
      "pending-obligations",
      "trust-and-anchor",
    ]);
    expect(await fixture.targetStore.artifactStore().has(imported.checkpoint!)).toBe(false);
    expect(await fixture.targetStore.artifactStore().has(imported.catalogRef!)).toBe(false);
  });

  it("commits once on the source and atomically installs the migrated authority on the target", async () => {
    const fixture = await createFixture();
    await fixture.sourceStore.authorityLog().append([
      { stream: "control", body: { t: "test-authority-base", value: "preserved" } },
    ]);
    await fixture.owner.prepare({
      requestId: "request-commit",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    const imported = await fixture.owner.freeze({
      requestId: "request-commit",
      transferId: TRANSFER_ID,
    });

    const committed = await fixture.owner.commit({
      requestId: "request-commit",
      transferId: TRANSFER_ID,
    });
    const replay = await fixture.owner.commit({
      requestId: "request-commit",
      transferId: TRANSFER_ID,
    });

    expect(committed.phase).toBe("committed");
    expect(replay.commit).toEqual(committed.commit);
    expect((await fixture.target.state(TRANSFER_ID))?.phase).toBe("committed");
    const targetTrust = await fixture.targetStore.loadTrustRecord();
    expect(targetTrust?.issuer.deviceId).toBe(fixture.targetKey.deviceId);
    expect(targetTrust?.issuer.issuerKeyId).toBe(committed.readyProof.targetIssuerKeyId);
    expect(targetTrust?.trustEpoch).toBe(fixture.sourceTrust.trustEpoch + 1);
    expect((await loadActiveAnchorIssuerKey(
      fixture.secrets,
      committed.readyProof.targetIssuerKeyId,
    ))?.publicKey).toBe(committed.readyProof.targetIssuerPublicKey);
    expect(await fixture.targetStore.artifactStore().has(imported.checkpoint!)).toBe(true);
    expect(await fixture.targetStore.artifactStore().has(imported.catalogRef!)).toBe(true);
    expect((await fixture.targetStore.authorityLog().readStream("control"))
      .some((entry) => (entry.body as { t?: string }).t === "test-authority-base"))
      .toBe(true);
    await expect(fixture.sourceStore.authorityLog().append([
      { stream: "control", body: { staleSource: true } },
    ])).rejects.toThrow("frozen authority writes");
  });

  it("durably cancels before commit, clears private state, and reopens the source", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-abort",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await fixture.owner.freeze({ requestId: "request-abort", transferId: TRANSFER_ID });

    const aborted = await fixture.owner.abort({
      requestId: "request-abort",
      transferId: TRANSFER_ID,
      reason: "operator-cancelled",
    });

    expect(aborted.phase).toBe("aborted");
    expect((await fixture.target.state(TRANSFER_ID))?.phase).toBe("aborted");
    expect(await loadAnchorIssuerKey(fixture.secrets, TRANSFER_ID)).toBeNull();
    await expect(fixture.sourceStore.authorityLog().append([
      { stream: "control", body: { sourceResumed: true } },
    ])).resolves.toBeDefined();
  });

  it("keeps the source fenced and replays forward after a lost target commit response", async () => {
    const fixture = await createFixture();
    let loseCommitResponse = true;
    const lossyTarget: PlannedAnchorTransferTargetPort = {
      ready: (input) => fixture.target.ready(input),
      apply: async (command) => {
        const result = await fixture.target.apply(command);
        if (command.op === "commit" && loseCommitResponse) {
          loseCommitResponse = false;
          throw new Error("simulated response loss");
        }
        return result;
      },
    };
    const owner = fixture.createOwner(lossyTarget);
    await owner.prepare({
      requestId: "request-recover",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await owner.freeze({ requestId: "request-recover", transferId: TRANSFER_ID });
    await expect(owner.commit({
      requestId: "request-recover",
      transferId: TRANSFER_ID,
    })).rejects.toThrow("simulated response loss");
    expect((await fixture.sourceJournal.state(TRANSFER_ID))?.phase).toBe("committed");
    expect((await fixture.target.state(TRANSFER_ID))?.phase).toBe("committed");

    const restarted = fixture.createOwner();
    await restarted.recoverBeforeAdmission();
    await expect(restarted.commit({
      requestId: "request-recover",
      transferId: TRANSFER_ID,
    })).resolves.toMatchObject({ phase: "committed" });
    await expect(restarted.abort({
      requestId: "request-recover",
      transferId: TRANSFER_ID,
      reason: "operator-cancelled",
    })).rejects.toThrow("only move forward");
  });
});

async function createFixture() {
  const sourceRoot = await temporary("anchor-source-");
  const targetRoot = await temporary("anchor-target-");
  const sourceKey = await DeviceKey.generate();
  const targetKey = await DeviceKey.generate();
  const identities = new Map<string, DeviceIdentity>();
  const sourceIdentity = enroll(sourceKey, "source");
  const targetIdentity = enroll(targetKey, "target");
  identities.set(sourceIdentity.deviceId, sourceIdentity);
  identities.set(targetIdentity.deviceId, targetIdentity);
  const verifier: ProtocolSignatureVerifier = {
    verify: (schemaId: string, version: number, payload: unknown, signature: Signature) => {
      const identity = identities.get(signature.keyId);
      if (!identity) throw new TypeError("Unknown test signer");
      verifyDeviceSignature(identity, schemaId, version, payload, signature);
    },
  };
  const sourceStore = new FileMeshBootstrapStore(sourceRoot, sourceKey);
  const targetStore = new FileMeshBootstrapStore(targetRoot, targetKey);
  let initialized = await sourceStore.initializeLocalHome({
    key: sourceKey,
    identity: sourceIdentity,
    roles: ["anchor"],
    at: AT,
    homeId: "home-1",
  });
  const enrollTarget = createSignedTrustEvent({
    current: initialized.projection,
    signer: sourceKey,
    at: AT,
    body: { t: "enroll", device: targetIdentity, roles: ["anchor"] },
  });
  const sourceTrust = await sourceStore.appendTrustEvent({
    event: enrollTarget,
    issuerKey: sourceKey,
  });
  await targetStore.importTrustBootstrap({
    events: await sourceStore.loadTrustEvents(),
    record: (await sourceStore.loadTrustRecord())!,
    localDeviceId: targetKey.deviceId,
  });
  const secrets = new MemoryStore();
  let owner!: PlannedAnchorTransferOwner;
  const target = new PlannedAnchorTransferTarget({
    deviceId: targetKey.deviceId,
    identityKey: targetKey,
    secretStore: secrets,
    bootstrapStore: targetStore,
    authorityLog: targetStore.authorityLog(),
    artifacts: targetStore.artifactStore(),
    stagingRoot: path.join(targetRoot, "anchor-transfer-staging"),
    sourceFor: () => ({ applyArtifactCommand: (command) => owner.applyArtifactCommand(command) }),
    signer: targetKey,
    verifier,
    readiness: async () => ({
      configuredCapabilities: { providers: [], mcpServers: [], channels: [] },
      protocolRevision: "protocol-v1",
      assetRevision: "assets-v1",
      serviceRevision: "services-v1",
    }),
    now: () => NOW,
  });
  const onDrain = { current: async () => {} };
  const createOwner = (targetPort: PlannedAnchorTransferTargetPort = target) => new PlannedAnchorTransferOwner({
      deviceId: sourceKey.deviceId,
      anchorEpoch: () => 1,
      identityKey: sourceKey,
      bootstrapStore: sourceStore,
      log: sourceStore.authorityLog(),
      signer: sourceKey,
      verifier,
      targetFor: () => targetPort,
      artifacts: sourceStore.artifactStore(),
      ensureRecoveryCheckpoint: async () => digest("verified-recovery"),
      lifecycle: {
        stopAccepting: () => {},
        drainAccepted: () => onDrain.current(),
        resumeAfterAbort: () => {},
      },
    });
  owner = createOwner();
  return {
    sourceKey, targetKey, sourceStore, targetStore, sourceTrust, secrets,
    owner, createOwner, onDrain,
    target,
    verifier,
    sourceJournal: new FilePlannedAnchorTransferJournal(sourceStore.authorityLog(), verifier),
    targetJournal: { state: (transferId: string) => target.state(transferId) },
  };
}

function enroll(key: DeviceKey, displayName: string) {
  return enrollDeviceIdentity(key, { displayName, platform: "linux", enrolledAt: AT });
}

async function temporary(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

class MemoryStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string) { this.values.set(id(ref), value); }
  async get(ref: SecretRef) { return this.values.get(id(ref)) ?? null; }
  async delete(ref: SecretRef) { this.values.delete(id(ref)); }
  async list() { return []; }
  async unlockState() { return "unlocked" as const; }
}

function id(ref: SecretRef) { return `${ref.kind}/${ref.bindingId}`; }

function noOpLifecycle() {
  return {
    stopAccepting: () => {},
    drainAccepted: async () => {},
    resumeAfterAbort: () => {},
  };
}

function digest(seed: string) {
  return `sha256:${Buffer.from(seed).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}
