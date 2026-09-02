import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "@zhixing/core/protocol";
import {
  createMeshEndpointDescriptor,
  MeshEndpointDirectory,
} from "@zhixing/mesh/bootstrap";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createMeshBootstrapProjectionPorts } from "./mesh-bootstrap-projection.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

describe("Mesh bootstrap projection persistence boundary", () => {
  it("projects one physical source into three frozen finite roles", async () => {
    const directory = new MeshEndpointDirectory();
    const loadEndpoints = vi.fn(async () => directory);
    const acceptEndpoint = vi.fn(async (value: unknown) => value as never);
    const loadTransportPeers = vi.fn(async () => []);
    const acceptTransportPeer = vi.fn(async () => undefined);
    const markBootstrapComplete = vi.fn(async () => undefined);
    const bootstrapCompleted = vi.fn(async () => true);
    const ports = createMeshBootstrapProjectionPorts({
      loadEndpoints,
      acceptEndpoint,
      loadTransportPeers,
      acceptTransportPeer,
      markBootstrapComplete,
      bootstrapCompleted,
    });

    expect(Object.isFrozen(ports)).toBe(true);
    expect(Object.isFrozen(ports.endpoints)).toBe(true);
    expect(Object.isFrozen(ports.transportPeers)).toBe(true);
    expect(Object.isFrozen(ports.completions)).toBe(true);
    expect(Object.keys(ports.endpoints).sort()).toEqual([
      "acceptEndpoint",
      "loadEndpoints",
    ]);
    expect(Object.keys(ports.transportPeers).sort()).toEqual([
      "acceptTransportPeer",
      "loadTransportPeers",
    ]);
    expect(Object.keys(ports.completions).sort()).toEqual([
      "bootstrapCompleted",
      "markBootstrapComplete",
    ]);

    await ports.endpoints.loadEndpoints();
    await ports.endpoints.acceptEndpoint({ v: 1 });
    await ports.transportPeers.loadTransportPeers();
    await ports.transportPeers.acceptTransportPeer({} as never);
    await ports.completions.markBootstrapComplete("peer", "offer");
    await ports.completions.bootstrapCompleted("peer", "offer");
    expect(loadEndpoints).toHaveBeenCalledOnce();
    expect(acceptEndpoint).toHaveBeenCalledOnce();
    expect(loadTransportPeers).toHaveBeenCalledOnce();
    expect(acceptTransportPeer).toHaveBeenCalledOnce();
    expect(markBootstrapComplete).toHaveBeenCalledOnce();
    expect(bootstrapCompleted).toHaveBeenCalledOnce();
  });

  it("preserves the physical store's canonical, replay, conflict, and cleanup behavior", async () => {
    const root = await createTempDir("mesh-bootstrap-projection");
    const distributedRoot = path.join(root, "distributed-runtime");
    const endpointFile = path.join(distributedRoot, "mesh-endpoints.json");
    const peerFile = path.join(distributedRoot, "mesh-peers.json");
    const completionFile = path.join(distributedRoot, "mesh-bootstrap-completions.json");
    const store = new FileMeshBootstrapStore(root);
    const ports = createMeshBootstrapProjectionPorts(store);
    try {
      expect(ports.endpoints).not.toHaveProperty("loadTrustRecord");
      expect(ports.transportPeers).not.toHaveProperty("authorityLog");
      expect(ports.completions).not.toHaveProperty("artifactStore");
      expect((await ports.endpoints.loadEndpoints()).list()).toEqual([]);
      expect(await ports.transportPeers.loadTransportPeers()).toEqual([]);
      expect(await ports.completions.bootstrapCompleted("peer-a", "offer-a")).toBe(false);

      const key = await DeviceKey.generate();
      const descriptor = createMeshEndpointDescriptor({
        deviceId: key.deviceId,
        configuration: {
          enabledRoles: ["anchor"],
          anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
        },
        revision: 1,
        at: "2026-09-02T00:00:00.000Z",
      });
      await ports.endpoints.acceptEndpoint(descriptor);
      const endpointDocument = JSON.parse(await readFile(endpointFile, "utf8"));
      await writeFile(endpointFile, canonicalize({ ...endpointDocument, tolerated: true }));
      expect((await ports.endpoints.loadEndpoints()).get(key.deviceId)).toEqual(descriptor);

      const identity = enrollDeviceIdentity(key, {
        displayName: "projection peer",
        platform: "headless",
        enrolledAt: "2026-09-02T00:00:00.000Z",
      });
      await ports.transportPeers.acceptTransportPeer({
        identity,
        rootCertificatePem: key.rootCertificatePem,
      });
      expect((await ports.transportPeers.loadTransportPeers()).map((peer) =>
        peer.identity.deviceId)).toEqual([key.deviceId]);

      await ports.completions.markBootstrapComplete("peer-a", "offer-a");
      await ports.completions.markBootstrapComplete("peer-a", "offer-a");
      expect(await ports.completions.bootstrapCompleted("peer-a", "offer-a")).toBe(true);
      await expect(ports.completions.markBootstrapComplete("peer-a", "offer-b"))
        .rejects.toThrow("another pairing offer");

      expect(await readFile(completionFile, "utf8")).toBe(
        canonicalize({ "peer-a": "offer-a" }),
      );
      expect((await readdir(distributedRoot)).some((entry) => entry.endsWith(".tmp")))
        .toBe(false);

      await mkdir(distributedRoot, { recursive: true });
      await writeFile(peerFile, "{not-json", "utf8");
      await expect(ports.transportPeers.loadTransportPeers())
        .rejects.toThrow("not valid JSON");
    } finally {
      await store.stopStorageMaintenance();
    }
  });
});
