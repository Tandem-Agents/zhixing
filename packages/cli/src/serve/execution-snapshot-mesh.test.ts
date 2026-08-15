import type { ExecutionAssetBundle } from "@zhixing/core/contracts";
import {
  canonicalize,
  createSignedCapabilityDescriptor,
  createSignedExecutionAssetSnapshot,
  createSignedExecutorVersionInventory,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type { SecureMeshConnection } from "@zhixing/mesh";
import type {
  MeshServiceDefinition,
  MeshServiceRegistry,
} from "@zhixing/mesh/service-registry";
import { describe, expect, it, vi } from "vitest";
import {
  registerExecutionSnapshotMeshService,
  type ExecutionSnapshotPublisher,
} from "./execution-snapshot-mesh.js";

const NOW = "2026-08-15T00:00:00.000Z";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test-digest",
      keyId: "anchor-a",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
  verify(schemaId, version, payload, signature) {
    const expected = this.sign(schemaId, version, payload);
    if (canonicalize(signature) !== canonicalize(expected)) {
      throw new TypeError("Protocol signature is invalid");
    }
  },
};

describe("execution snapshot mesh wire boundary", () => {
  it("installs a canonical v1 bundle through the production decoder", async () => {
    const bundle = executionAssetBundle();
    const installAssets = vi.fn(async () => capabilitySnapshot());
    const definition = registerService({
      currentCapability: async () => capabilitySnapshot(),
      installPermission: async () => capabilitySnapshot(),
      installAssets,
    });

    expect(definition.availability).toBe("negotiated-version");
    await expect(dispatch(definition, {
      v: 1,
      method: "install-assets",
      bundle,
    })).resolves.toBeInstanceOf(Uint8Array);
    expect(installAssets).toHaveBeenCalledOnce();
    expect(installAssets).toHaveBeenCalledWith(bundle);
  });

  it("rejects polluted, wrong-version and invalid snapshots before publisher effects", async () => {
    const installAssets = vi.fn(async () => capabilitySnapshot());
    const definition = registerService({
      currentCapability: async () => capabilitySnapshot(),
      installPermission: async () => capabilitySnapshot(),
      installAssets,
    });
    const valid = executionAssetBundle();
    const wrongDigest = {
      ...valid,
      snapshot: { ...valid.snapshot, digest: `sha256:${"0".repeat(64)}` },
    };
    const wrongSignature = {
      ...valid,
      snapshot: {
        ...valid.snapshot,
        signature: { ...valid.snapshot.signature, sig: "invalid" },
      },
    };

    const invalidRequests = [
      { v: 1, method: "install-assets", bundle: valid, extra: true },
      { v: 2, method: "install-assets", bundle: valid },
      { v: 1, method: "install-assets", bundle: { ...valid, extra: true } },
      { v: 1, method: "install-assets", bundle: { ...valid, v: 2 } },
      { v: 1, method: "install-assets", bundle: { v: 1, artifacts: [] } },
      { v: 1, method: "install-assets", bundle: { v: 1, snapshot: valid.snapshot } },
      { v: 1, method: "install-assets", bundle: wrongDigest },
      { v: 1, method: "install-assets", bundle: wrongSignature },
    ];

    for (const request of invalidRequests) {
      await expect(dispatch(definition, request)).rejects.toThrow();
    }
    expect(installAssets).not.toHaveBeenCalled();
  });
});

function registerService(publisher: ExecutionSnapshotPublisher): MeshServiceDefinition {
  let definition: MeshServiceDefinition | undefined;
  const registry = {
    register(serviceId: string, next: MeshServiceDefinition) {
      expect(serviceId).toBe("execution.snapshot");
      definition = next;
      return () => {};
    },
  } as MeshServiceRegistry;
  registerExecutionSnapshotMeshService(
    registry,
    publisher,
    () => true,
    identity,
  );
  if (!definition) throw new Error("execution snapshot service was not registered");
  return definition;
}

function dispatch(definition: MeshServiceDefinition, request: unknown): Promise<Uint8Array> {
  const connection = {
    peer: { deviceId: "executor-device", publicKey: "test-key" },
  } as unknown as SecureMeshConnection;
  return definition.handler(
    Buffer.from(canonicalize(request), "utf8"),
    connection,
    new AbortController().signal,
  );
}

function executionAssetBundle(): ExecutionAssetBundle {
  return {
    v: 1,
    snapshot: createSignedExecutionAssetSnapshot({
      snapshotRevision: 1,
      skillCatalogRevision: 0,
      generatedAt: NOW,
      skills: [],
      rubrics: [],
      promptAssets: [],
    }, identity),
    artifacts: [],
  };
}

function capabilitySnapshot() {
  return {
    descriptor: createSignedCapabilityDescriptor({
      executorId: "executor-a",
      revision: 1,
      protocolVersion: "1",
      workspaces: [],
      tools: [],
      mcpServers: [],
      credentialBindings: [],
      evidenceCapabilities: [],
      at: NOW,
    }, identity),
    inventory: createSignedExecutorVersionInventory({
      executorId: "executor-a",
      inventoryRevision: 1,
      capabilityRevision: 1,
      configVersions: {
        runtimeConfigRev: 1,
        modelProfileRev: 1,
        policyRev: 1,
      },
      assetVersions: {
        skillsRev: 1,
        rubricsRev: 1,
        promptAssetsRev: 1,
      },
      permissionSnapshotHighWater: 0,
      credentialBindingRevisions: [],
      at: NOW,
    }, identity),
  };
}
