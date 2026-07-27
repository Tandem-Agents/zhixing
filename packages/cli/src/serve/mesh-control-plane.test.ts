import { createServer } from "node:net";
import type {
  DeviceIdentity,
  HomeTrustRecord,
  SecretRef,
  SecretStorePort,
} from "@zhixing/core/contracts";
import { MeshEndpointDirectory } from "@zhixing/mesh/bootstrap";
import {
  BlindRendezvousMatcher,
  readBlindRendezvousHello,
} from "@zhixing/mesh/blind-rendezvous";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { createTempDir } from "@zhixing/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";

describe("production mesh control plane", () => {
  const controls: ProductionMeshControlPlane[] = [];
  const relayClosers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(controls.splice(0).map((control) => control.stop()));
    await Promise.all(relayClosers.splice(0).map((close) => close()));
  });

  it("lets only the non-anchor dial and establishes an authenticated direct session", async () => {
    const [anchor, executor] = await Promise.all([
      createDevice("anchor"),
      createDevice("executor"),
    ]);
    const port = await freePort();
    const trust = trustRecord(anchor.identity, executor.identity);
    const anchorRoot = await createTempDir("mesh-anchor-control");
    const executorRoot = await createTempDir("mesh-executor-control");
    const anchorSecrets = new MemorySecretStore();
    await anchorSecrets.put(
      { kind: "rendezvous", bindingId: executor.identity.deviceId },
      "pairwise-secret",
    );
    const anchorControl = new ProductionMeshControlPlane({
      localIdentity: anchor.key,
      trust,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port } },
      },
      endpoints: new MeshEndpointDirectory(),
      transportPeers: [executor.peer],
      secretStore: anchorSecrets,
      bootstrapStore: new FileMeshBootstrapStore(anchorRoot),
      services: new MeshServiceRegistry(),
    });
    const executorControl = new ProductionMeshControlPlane({
      localIdentity: executor.key,
      trust,
      configuration: { enabledRoles: ["executor"] },
      endpoints: new MeshEndpointDirectory([{
        v: 1,
        deviceId: anchor.identity.deviceId,
        transports: [{ kind: "direct", host: "127.0.0.1", port }],
        revision: 1,
        at: new Date().toISOString(),
      }]),
      transportPeers: [anchor.peer],
      secretStore: new MemorySecretStore(),
      bootstrapStore: new FileMeshBootstrapStore(executorRoot),
      services: new MeshServiceRegistry(),
    });
    controls.push(anchorControl, executorControl);

    await anchorControl.start();
    await executorControl.start();
    await waitFor(() =>
      anchorControl.connections.has(executor.identity.deviceId) &&
      executorControl.connections.has(anchor.identity.deviceId));

    expect(anchorControl.connections.has(executor.identity.deviceId)).toBe(true);
    expect(executorControl.connections.has(anchor.identity.deviceId)).toBe(true);

    await anchorControl.reconcileTrust({
      ...trust,
      chainHead: { seq: 3, eventDigest: `sha256:${"2".repeat(64)}` },
      members: trust.members.map((member) =>
        member.device.deviceId === executor.identity.deviceId
          ? { ...member, state: "revoked" as const }
          : member),
    });
    await waitFor(() => !anchorControl.connections.has(executor.identity.deviceId));
    expect(await anchorSecrets.get({
      kind: "rendezvous",
      bindingId: executor.identity.deviceId,
    })).toBeNull();
  });

  it("reconciles initial trust and activates a newly paired surface without restart", async () => {
    const [anchor, executor] = await Promise.all([
      createDevice("online-anchor"),
      createDevice("online-executor"),
    ]);
    const port = await freePort();
    const anchorStore = new FileMeshBootstrapStore(
      await createTempDir("mesh-online-anchor-control"),
    );
    const initialTrust = anchorOnlyTrustRecord(anchor.identity);
    const onTrustReconciled = vi.fn();
    const anchorControl = new ProductionMeshControlPlane({
      localIdentity: anchor.key,
      trust: initialTrust,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port } },
      },
      endpoints: new MeshEndpointDirectory(),
      transportPeers: [],
      secretStore: new MemorySecretStore(),
      bootstrapStore: anchorStore,
      services: new MeshServiceRegistry(),
      onTrustReconciled,
    });
    const joinedTrust = trustRecord(anchor.identity, executor.identity, "surface");
    const executorControl = new ProductionMeshControlPlane({
      localIdentity: executor.key,
      trust: joinedTrust,
      configuration: { enabledRoles: ["surface"] },
      endpoints: new MeshEndpointDirectory([{
        v: 1,
        deviceId: anchor.identity.deviceId,
        transports: [{ kind: "direct", host: "127.0.0.1", port }],
        revision: 1,
        at: new Date().toISOString(),
      }]),
      transportPeers: [anchor.peer],
      secretStore: new MemorySecretStore(),
      bootstrapStore: new FileMeshBootstrapStore(
        await createTempDir("mesh-online-executor-control"),
      ),
      services: new MeshServiceRegistry(),
    });
    controls.push(anchorControl, executorControl);

    await anchorControl.start();
    await anchorStore.acceptTransportPeer(executor.peer);
    await anchorControl.reconcileTrust(joinedTrust);
    await executorControl.start();
    await waitFor(() =>
      anchorControl.connections.has(executor.identity.deviceId) &&
      executorControl.connections.has(anchor.identity.deviceId));

    expect(executorControl.connections.has(anchor.identity.deviceId)).toBe(true);
    expect(onTrustReconciled).toHaveBeenCalledTimes(2);
    expect(onTrustReconciled).toHaveBeenNthCalledWith(1, initialTrust);
    expect(onTrustReconciled).toHaveBeenNthCalledWith(2, joinedTrust);

    await anchorControl.reconcileTrust({
      ...joinedTrust,
      chainHead: { seq: 3, eventDigest: `sha256:${"3".repeat(64)}` },
      members: joinedTrust.members.map((member) =>
        member.device.deviceId === executor.identity.deviceId
          ? { ...member, roles: [] }
          : member),
    });
    await waitFor(() => !anchorControl.connections.has(executor.identity.deviceId));
    expect(onTrustReconciled).toHaveBeenCalledTimes(3);
  });

  it("retries a durable endpoint update after a transient receiver failure", async () => {
    const [anchor, executor] = await Promise.all([
      createDevice("endpoint-anchor"),
      createDevice("endpoint-executor"),
    ]);
    const port = await freePort();
    const trust = trustRecord(anchor.identity, executor.identity);
    const oldEndpoint = {
      v: 1 as const,
      deviceId: anchor.identity.deviceId,
      transports: [{ kind: "direct" as const, host: "127.0.0.1", port }],
      revision: 1,
      at: new Date().toISOString(),
    };
    const newEndpoint = {
      ...oldEndpoint,
      revision: 2,
      at: new Date(Date.now() + 1_000).toISOString(),
    };
    const executorStore = new FileMeshBootstrapStore(
      await createTempDir("mesh-endpoint-executor-control"),
    );
    const acceptEndpoint = executorStore.acceptEndpoint.bind(executorStore);
    const acceptSpy = vi.spyOn(executorStore, "acceptEndpoint")
      .mockRejectedValueOnce(new Error("endpoint storage temporarily unavailable"))
      .mockImplementation(acceptEndpoint);
    const connectionErrors: string[] = [];
    const executorEndpoints = new MeshEndpointDirectory([oldEndpoint]);
    const anchorControl = new ProductionMeshControlPlane({
      localIdentity: anchor.key,
      trust,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port } },
      },
      endpoints: new MeshEndpointDirectory([newEndpoint]),
      transportPeers: [executor.peer],
      secretStore: new MemorySecretStore(),
      bootstrapStore: new FileMeshBootstrapStore(
        await createTempDir("mesh-endpoint-anchor-control"),
      ),
      services: new MeshServiceRegistry(),
      localEndpoint: newEndpoint,
      onConnectionError: (error) => connectionErrors.push(
        `${error.name}:${"code" in error ? String(error.code) : "none"}:${error.message}`,
      ),
    });
    const executorControl = new ProductionMeshControlPlane({
      localIdentity: executor.key,
      trust,
      configuration: { enabledRoles: ["executor"] },
      endpoints: executorEndpoints,
      transportPeers: [anchor.peer],
      secretStore: new MemorySecretStore(),
      bootstrapStore: executorStore,
      services: new MeshServiceRegistry(),
    });
    controls.push(anchorControl, executorControl);

    await anchorControl.start();
    await executorControl.start();
    await waitFor(async () =>
      (await executorStore.loadEndpoints()).get(anchor.identity.deviceId)?.revision === 2)
      .catch(async () => {
        throw new Error(
          `endpoint update did not converge: attempts=${acceptSpy.mock.calls.length}; ` +
          `memory=${executorEndpoints.get(anchor.identity.deviceId)?.revision}; ` +
          `disk=${(await executorStore.loadEndpoints()).get(anchor.identity.deviceId)?.revision}; ` +
          `errors=${connectionErrors.join(" | ")}`,
        );
      });

    expect(acceptSpy).toHaveBeenCalledTimes(2);
    expect((await executorStore.loadEndpoints()).get(anchor.identity.deviceId)).toEqual(
      newEndpoint,
    );
  });

  it("stops an anchor with an active remote session without waiting on that peer", async () => {
    const [anchor, executor] = await Promise.all([
      createDevice("stop-anchor"),
      createDevice("stop-executor"),
    ]);
    const port = await freePort();
    const trust = trustRecord(anchor.identity, executor.identity);
    const anchorControl = new ProductionMeshControlPlane({
      localIdentity: anchor.key,
      trust,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port } },
      },
      endpoints: new MeshEndpointDirectory(),
      transportPeers: [executor.peer],
      secretStore: new MemorySecretStore(),
      bootstrapStore: new FileMeshBootstrapStore(
        await createTempDir("mesh-stop-anchor-control"),
      ),
      services: new MeshServiceRegistry(),
    });
    const executorControl = new ProductionMeshControlPlane({
      localIdentity: executor.key,
      trust,
      configuration: { enabledRoles: ["executor"] },
      endpoints: new MeshEndpointDirectory([{
        v: 1,
        deviceId: anchor.identity.deviceId,
        transports: [{ kind: "direct", host: "127.0.0.1", port }],
        revision: 1,
        at: new Date().toISOString(),
      }]),
      transportPeers: [anchor.peer],
      secretStore: new MemorySecretStore(),
      bootstrapStore: new FileMeshBootstrapStore(
        await createTempDir("mesh-stop-executor-control"),
      ),
      services: new MeshServiceRegistry(),
    });
    controls.push(anchorControl, executorControl);
    await anchorControl.start();
    await executorControl.start();
    await waitFor(() => anchorControl.connections.has(executor.identity.deviceId));

    await expect(Promise.race([
      anchorControl.stop(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("anchor shutdown timed out")), 2_000)),
    ])).resolves.toBeUndefined();
  });

  it("lets a surface fall back from direct transport to an authenticated blind relay", async () => {
    const [anchor, executor] = await Promise.all([
      createDevice("relay-anchor"),
      createDevice("relay-executor"),
    ]);
    const matcher = new BlindRendezvousMatcher();
    const relayMatches: string[] = [];
    const relay = createServer((socket) => {
      void readBlindRendezvousHello(socket)
        .then((hello) => {
          relayMatches.push(`${hello.key}:${matcher.accept(socket, hello)}`);
        })
        .catch((error) => socket.destroy(error instanceof Error ? error : undefined));
    });
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    const relayAddress = relay.address();
    if (!relayAddress || typeof relayAddress === "string") throw new Error("relay did not bind");
    relayClosers.push(async () => {
      matcher.close();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    });

    const pairwiseSecret = Buffer.alloc(32, 0x5a).toString("base64url");
    const anchorSecrets = new MemorySecretStore();
    const executorSecrets = new MemorySecretStore();
    await anchorSecrets.put(
      { kind: "rendezvous", bindingId: executor.identity.deviceId },
      pairwiseSecret,
    );
    await executorSecrets.put(
      { kind: "rendezvous", bindingId: anchor.identity.deviceId },
      pairwiseSecret,
    );
    const trust = trustRecord(anchor.identity, executor.identity, "surface");
    const unreachablePort = await freePort();
    const relayEndpoint = { host: "127.0.0.1", port: relayAddress.port };
    const connectionErrors: string[] = [];
    const anchorControl = new ProductionMeshControlPlane({
      localIdentity: anchor.key,
      trust,
      configuration: {
        enabledRoles: ["anchor"],
        relayRegistration: relayEndpoint,
      },
      endpoints: new MeshEndpointDirectory(),
      transportPeers: [executor.peer],
      secretStore: anchorSecrets,
      bootstrapStore: new FileMeshBootstrapStore(
        await createTempDir("mesh-relay-anchor-control"),
      ),
      services: new MeshServiceRegistry(),
      onConnectionError: (error) => connectionErrors.push(`anchor: ${error.message}`),
    });
    const executorControl = new ProductionMeshControlPlane({
      localIdentity: executor.key,
      trust,
      configuration: { enabledRoles: ["surface"] },
      endpoints: new MeshEndpointDirectory([{
        v: 1,
        deviceId: anchor.identity.deviceId,
        transports: [
          { kind: "direct", host: "127.0.0.1", port: unreachablePort },
          { kind: "blind-relay", relay: relayEndpoint },
        ],
        revision: 1,
        at: new Date().toISOString(),
      }]),
      transportPeers: [anchor.peer],
      secretStore: executorSecrets,
      bootstrapStore: new FileMeshBootstrapStore(
        await createTempDir("mesh-relay-executor-control"),
      ),
      services: new MeshServiceRegistry(),
      onConnectionError: (error) => connectionErrors.push(`executor: ${error.message}`),
    });
    controls.push(anchorControl, executorControl);

    await anchorControl.start();
    await executorControl.start();
    await waitFor(() =>
      anchorControl.connections.has(executor.identity.deviceId) &&
      executorControl.connections.has(anchor.identity.deviceId)).catch(() => {
        throw new Error(
          `mesh relay did not converge: waiting=${matcher.waiting}; ` +
          `matches=${relayMatches.join(",")}; errors=${connectionErrors.join(" | ")}`,
        );
      });

    expect(anchorControl.connections.has(executor.identity.deviceId)).toBe(true);
    expect(executorControl.connections.has(anchor.identity.deviceId)).toBe(true);
  }, 120_000);
});

async function createDevice(name: string) {
  const key = await DeviceKey.generate();
  const identity = enrollDeviceIdentity(key, {
    displayName: name,
    platform: "headless",
    enrolledAt: new Date().toISOString(),
  });
  return {
    key,
    identity,
    peer: { identity, rootCertificatePem: key.rootCertificatePem },
  };
}

function trustRecord(
  anchor: DeviceIdentity,
  executor: DeviceIdentity,
  peerRole: "executor" | "surface" = "executor",
): HomeTrustRecord {
  return {
    v: 1,
    schemaId: "HomeTrustRecord",
    homeId: "home-test",
    trustEpoch: 1,
    issuer: { deviceId: anchor.deviceId, issuerKeyId: anchor.deviceId },
    chainHead: { seq: 2, eventDigest: `sha256:${"1".repeat(64)}` },
    members: [
      { device: anchor, roles: ["anchor"], state: "active" },
      { device: executor, roles: [peerRole], state: "active" },
    ],
    signature: { alg: "ed25519", keyId: anchor.deviceId, sig: "test" },
  };
}

function anchorOnlyTrustRecord(anchor: DeviceIdentity): HomeTrustRecord {
  return {
    v: 1,
    schemaId: "HomeTrustRecord",
    homeId: "home-test",
    trustEpoch: 1,
    issuer: { deviceId: anchor.deviceId, issuerKeyId: anchor.deviceId },
    chainHead: { seq: 1, eventDigest: `sha256:${"0".repeat(64)}` },
    members: [{ device: anchor, roles: ["anchor"], state: "active" }],
    signature: { alg: "ed25519", keyId: anchor.deviceId, sig: "test" },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("mesh connection did not converge");
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
