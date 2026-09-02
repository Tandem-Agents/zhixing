import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { DeviceIdentity, SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { MeshEndpointDirectory } from "@zhixing/mesh/bootstrap";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import {
  MeshServiceRegistry,
  type MeshServiceDefinition,
} from "@zhixing/mesh/service-registry";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import {
  createRecoveryRootEvent,
  createSignedTrustEvent,
} from "@zhixing/mesh/trust-chain";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { createMeshBootstrapProjectionPorts } from "./mesh-bootstrap-projection.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import {
  collectDisasterRecoveryTrustEvidence,
  DISASTER_RECOVERY_TRUST_EVIDENCE_SERVICE,
  registerDisasterRecoveryTrustEvidenceService,
} from "./disaster-recovery-trust-evidence.js";

const controls: ProductionMeshControlPlane[] = [];

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.stop()));
});

describe("disaster recovery reachable-peer evidence", { timeout: 30_000 }, () => {
  it("selects the exact signed suffix from every frozen peer in the cut", async () => {
    const fixture = await trustFixture();
    const registry = new CapturingRegistry();
    registerDisasterRecoveryTrustEvidenceService(registry, {
      store: fixture.peerStore,
      authorizePeer: (deviceId) => deviceId === fixture.localIdentity.deviceId,
    });
    const client = registry.client(fixture.localIdentity.deviceId);
    const before = await fixture.localStore.loadTrustEvents();

    const result = await collectDisasterRecoveryTrustEvidence({
      store: fixture.localStore,
      localDeviceId: fixture.localIdentity.deviceId,
      peers: [{ deviceId: fixture.peerIdentity.deviceId, client }],
      signal: new AbortController().signal,
    });

    expect(result.cut).toEqual([
      fixture.localIdentity.deviceId,
      fixture.peerIdentity.deviceId,
    ].sort((left, right) => left.localeCompare(right, "en-US")));
    expect(result.evidence.map((entry) => entry.deviceId)).toEqual(result.cut);
    expect(result.evidence.find((entry) => entry.deviceId === fixture.peerIdentity.deviceId)
      ?.record.chainHead.seq).toBe(before.at(-1)!.seq + 1);
    expect(await fixture.localStore.loadTrustEvents()).toEqual(before);
  });

  it("fails the whole frozen cut when one peer cannot return evidence", async () => {
    const fixture = await trustFixture();
    const before = await fixture.localStore.loadTrustEvents();
    const unavailable: MeshServiceClient = {
      request: async () => { throw new Error("peer disconnected"); },
    };

    await expect(collectDisasterRecoveryTrustEvidence({
      store: fixture.localStore,
      localDeviceId: fixture.localIdentity.deviceId,
      peers: [{ deviceId: fixture.peerIdentity.deviceId, client: unavailable }],
      signal: new AbortController().signal,
    })).rejects.toThrow(/disconnected/u);
    expect(await fixture.localStore.loadTrustEvents()).toEqual(before);
  });

  it("crosses an authenticated production mesh session before accepting peer evidence", async () => {
    const fixture = await trustFixture();
    const port = await freePort();
    const localServices = new MeshServiceRegistry();
    const peerServices = new MeshServiceRegistry();
    registerDisasterRecoveryTrustEvidenceService(peerServices, {
      store: fixture.peerStore,
      authorizePeer: (deviceId) => deviceId === fixture.localIdentity.deviceId,
    });
    const localTrust = await fixture.localStore.loadTrustRecord();
    const peerTrust = await fixture.peerStore.loadTrustRecord();
    if (!localTrust || !peerTrust) throw new Error("trust evidence fixture is incomplete");
    const localProjection = createMeshBootstrapProjectionPorts(fixture.localStore);
    const peerProjection = createMeshBootstrapProjectionPorts(fixture.peerStore);
    const localControl = new ProductionMeshControlPlane({
      localIdentity: fixture.localKey,
      trust: localTrust,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port } },
      },
      endpoints: new MeshEndpointDirectory(),
      transportPeers: [{
        identity: fixture.peerIdentity,
        rootCertificatePem: fixture.peerKey.rootCertificatePem,
      }],
      secretStore: new MemorySecretStore(),
      endpointDirectory: localProjection.endpoints,
      transportPeerDirectory: localProjection.transportPeers,
      trustProjection: Object.freeze({
        loadTrustRecord: () => fixture.localStore.loadTrustRecord(),
      }),
      services: localServices,
    });
    const peerControl = new ProductionMeshControlPlane({
      localIdentity: fixture.peerKey,
      trust: peerTrust,
      configuration: { enabledRoles: ["executor"] },
      endpoints: new MeshEndpointDirectory([{
        v: 1,
        deviceId: fixture.localIdentity.deviceId,
        transports: [{ kind: "direct", host: "127.0.0.1", port }],
        revision: 1,
        at: "2026-08-10T00:04:00.000Z",
      }]),
      transportPeers: [{
        identity: fixture.localIdentity,
        rootCertificatePem: fixture.localKey.rootCertificatePem,
      }],
      secretStore: new MemorySecretStore(),
      endpointDirectory: peerProjection.endpoints,
      transportPeerDirectory: peerProjection.transportPeers,
      trustProjection: Object.freeze({
        loadTrustRecord: () => fixture.peerStore.loadTrustRecord(),
      }),
      services: peerServices,
    });
    controls.push(localControl, peerControl);
    await localControl.start();
    await peerControl.start();
    await waitFor(() => localControl.connections.has(fixture.peerIdentity.deviceId));

    const result = await collectDisasterRecoveryTrustEvidence({
      store: fixture.localStore,
      localDeviceId: fixture.localIdentity.deviceId,
      peers: [{
        deviceId: fixture.peerIdentity.deviceId,
        client: localControl.connections.client(fixture.peerIdentity.deviceId),
      }],
      signal: new AbortController().signal,
    });

    expect(result.evidence.find((item) => item.deviceId === fixture.peerIdentity.deviceId)
      ?.record.chainHead).toEqual(peerTrust.chainHead);
  });
});

async function trustFixture() {
  const localRoot = await temporary("recovery-evidence-local");
  const peerRoot = await temporary("recovery-evidence-peer");
  const localKey = await DeviceKey.generate();
  const peerKey = await DeviceKey.generate();
  const localIdentity = identity(localKey, "local");
  const peerIdentity = identity(peerKey, "peer");
  const localStore = new FileMeshBootstrapStore(localRoot, localKey);
  const peerStore = new FileMeshBootstrapStore(peerRoot, peerKey);
  onTestFinished(async () => {
    await Promise.all([
      localStore.stopStorageMaintenance(),
      peerStore.stopStorageMaintenance(),
    ]);
  });
  const initialized = await localStore.initializeLocalHome({
    key: localKey,
    identity: localIdentity,
    roles: ["anchor"],
    at: "2026-08-10T00:00:00.000Z",
    homeId: "home-reachable-evidence",
  });
  let trust = await localStore.appendTrustEvent({
    event: createSignedTrustEvent({
      current: initialized.projection,
      signer: localKey,
      at: "2026-08-10T00:01:00.000Z",
      body: { t: "enroll", device: peerIdentity, roles: ["anchor"] },
    }),
    issuerKey: localKey,
  });
  const recoveryRoot = RecoveryRoot.generate();
  trust = await localStore.appendTrustEvent({
    event: createRecoveryRootEvent({
      current: trust,
      op: "establish",
      candidate: recoveryRoot,
      outerSigner: localKey,
      at: "2026-08-10T00:02:00.000Z",
    }),
    issuerKey: localKey,
  });
  const localRecord = await localStore.loadTrustRecord();
  if (!localRecord) throw new Error("local trust record is missing");
  await peerStore.importTrustBootstrap({
    events: await localStore.loadTrustEvents(),
    record: localRecord,
    localDeviceId: peerIdentity.deviceId,
  });
  await peerStore.appendTrustEvent({
    event: createSignedTrustEvent({
      current: trust,
      signer: localKey,
      at: "2026-08-10T00:03:00.000Z",
      body: {
        t: "role-change",
        deviceId: peerIdentity.deviceId,
        roles: ["anchor", "executor"],
      },
    }),
    issuerKey: localKey,
  });
  return { localStore, peerStore, localIdentity, peerIdentity, localKey, peerKey };
}

function identity(key: DeviceKey, displayName: string): DeviceIdentity {
  return enrollDeviceIdentity(key, {
    displayName,
    platform: "headless",
    enrolledAt: "2026-08-10T00:00:00.000Z",
  });
}

async function temporary(label: string): Promise<string> {
  return createTempDir(label);
}

class CapturingRegistry extends MeshServiceRegistry {
  #definition?: MeshServiceDefinition;

  override register(serviceId: string, definition: MeshServiceDefinition): () => void {
    if (serviceId === DISASTER_RECOVERY_TRUST_EVIDENCE_SERVICE) {
      this.#definition = definition;
    }
    return super.register(serviceId, definition);
  }

  client(peerDeviceId: string): MeshServiceClient {
    const definition = this.#definition;
    if (!definition) throw new Error("trust evidence service is not registered");
    const connection = { peer: { deviceId: peerDeviceId } } as never;
    if (definition.authorize && !definition.authorize(connection)) {
      throw new Error("trust evidence service rejected the test peer");
    }
    return {
      request: async (serviceId, payload, signal) => {
        if (serviceId !== DISASTER_RECOVERY_TRUST_EVIDENCE_SERVICE) {
          throw new Error("unexpected service");
        }
        return definition.handler(payload, connection, signal ?? new AbortController().signal);
      },
    };
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing mesh test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("authenticated mesh connection did not converge");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string): Promise<void> {
    this.values.set(`${ref.kind}/${ref.bindingId}`, value);
  }
  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }
  async delete(ref: SecretRef): Promise<void> {
    this.values.delete(`${ref.kind}/${ref.bindingId}`);
  }
  async list(): Promise<SecretRef[]> {
    return [];
  }
  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}
