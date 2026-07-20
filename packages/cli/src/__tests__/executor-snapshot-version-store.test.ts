import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { PermissionRule } from "@zhixing/core";
import { protocolDigest } from "@zhixing/core/protocol";
import type {
  ExecutorCapabilityDirectoryState,
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  FileExecutionSnapshotVersionStore,
  FileExecutorCapabilityDirectoryStore,
  FileTrustRuleSnapshotCatalog,
} from "../executor-snapshot-version-store.js";

const NOW = "2026-07-19T00:00:00.000Z";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload) {
    return {
      alg: "test-digest",
      keyId: "device-a",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    const expected = signer.sign(schemaId, version, payload);
    if (
      signature.alg !== expected.alg ||
      signature.keyId !== expected.keyId ||
      signature.sig !== expected.sig
    ) {
      throw new TypeError("Test signature is invalid");
    }
  },
};

function permissionRule(id: string, argument: string): PermissionRule {
  return {
    id,
    pattern: { tool: "bash", argument },
    decision: "allow",
    scope: "global",
    createdAt: 1,
    lastMatchedAt: 0,
    matchCount: 0,
  };
}

vi.setConfig({ testTimeout: 30_000 });

describe("FileExecutionSnapshotVersionStore", () => {
  it("separates device generations from inventory-only changes", async () => {
    const root = await createTempDir("execution-snapshot-version");
    const file = path.join(root, "snapshot.json");
    const store = new FileExecutionSnapshotVersionStore(file, () => NOW);
    const firstDevice = protocolDigest("ExecutionDeviceTest", 1, { value: 1 });
    const secondDevice = protocolDigest("ExecutionDeviceTest", 1, { value: 2 });
    const firstInventory = protocolDigest("ExecutionInventoryTest", 1, {
      device: firstDevice,
      permissionSnapshotHighWater: 1,
    });
    const secondInventory = protocolDigest("ExecutionInventoryTest", 1, {
      device: firstDevice,
      permissionSnapshotHighWater: 2,
    });
    const thirdInventory = protocolDigest("ExecutionInventoryTest", 1, {
      device: secondDevice,
      permissionSnapshotHighWater: 2,
    });
    const fourthInventory = protocolDigest("ExecutionInventoryTest", 1, {
      device: firstDevice,
      permissionSnapshotHighWater: 2,
    });

    await expect(
      store.synchronize("executor:local", firstDevice, firstInventory),
    ).resolves.toEqual({
      deviceRevision: 1,
      inventoryRevision: 1,
      initialized: true,
      deviceGeneratedAt: NOW,
      inventoryGeneratedAt: NOW,
      capabilityDirectoryEstablished: false,
    });
    await expect(
      store.synchronize("executor:local", firstDevice, firstInventory),
    ).resolves.toEqual({
      deviceRevision: 1,
      inventoryRevision: 1,
      initialized: false,
      deviceGeneratedAt: NOW,
      inventoryGeneratedAt: NOW,
      capabilityDirectoryEstablished: false,
    });
    await store.markCapabilityDirectoryEstablished({
      executorId: "executor:local",
      deviceDigest: firstDevice,
      deviceRevision: 1,
      inventoryDigest: firstInventory,
      inventoryRevision: 1,
    });
    await expect(
      store.synchronize("executor:local", firstDevice, secondInventory),
    ).resolves.toEqual({
      deviceRevision: 1,
      inventoryRevision: 2,
      initialized: false,
      deviceGeneratedAt: NOW,
      inventoryGeneratedAt: NOW,
      capabilityDirectoryEstablished: true,
    });
    await expect(
      store.synchronize("executor:local", secondDevice, thirdInventory),
    ).resolves.toEqual({
      deviceRevision: 2,
      inventoryRevision: 3,
      initialized: false,
      deviceGeneratedAt: NOW,
      inventoryGeneratedAt: NOW,
      capabilityDirectoryEstablished: true,
    });
    await expect(
      new FileExecutionSnapshotVersionStore(file, () => NOW).synchronize(
        "executor:local",
        firstDevice,
        fourthInventory,
      ),
    ).resolves.toEqual({
      deviceRevision: 3,
      inventoryRevision: 4,
      initialized: false,
      deviceGeneratedAt: NOW,
      inventoryGeneratedAt: NOW,
      capabilityDirectoryEstablished: true,
    });
  });

  it("linearizes concurrent publishers and fails closed on corrupt state", async () => {
    const root = await createTempDir("execution-snapshot-version-race");
    const file = path.join(root, "snapshot.json");
    const deviceDigest = protocolDigest("ExecutionDeviceTest", 1, { shared: true });
    const inventoryDigest = protocolDigest("ExecutionInventoryTest", 1, {
      shared: true,
    });

    const resolutions = await Promise.all(
      Array.from({ length: 4 }, () =>
        new FileExecutionSnapshotVersionStore(file).synchronize(
          "executor:local",
          deviceDigest,
          inventoryDigest,
        ),
      ),
    );
    expect(resolutions.map(({ deviceRevision }) => deviceRevision)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(resolutions.map(({ inventoryRevision }) => inventoryRevision)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(resolutions.filter(({ initialized }) => initialized)).toHaveLength(1);
    expect(resolutions.every(({ capabilityDirectoryEstablished }) =>
      capabilityDirectoryEstablished === false)).toBe(true);

    await expect(
      storeMarkWithStaleSnapshot(file, deviceDigest, inventoryDigest),
    ).rejects.toThrow(
      "changed before directory establishment",
    );

    await writeFile(file, "{}\n", "utf8");
    await expect(
      new FileExecutionSnapshotVersionStore(file).synchronize(
        "executor:local",
        deviceDigest,
        inventoryDigest,
      ),
    ).rejects.toThrow("fields are invalid");
  });

  it("fails closed when the version source and capability directory diverge", async () => {
    const root = await createTempDir("execution-snapshot-version-coherence");
    const file = path.join(root, "snapshot.json");
    const store = new FileExecutionSnapshotVersionStore(file, () => NOW);
    const deviceDigest = protocolDigest("ExecutionDeviceTest", 1, { value: 1 });
    const inventoryDigest = protocolDigest("ExecutionInventoryTest", 1, {
      value: 1,
    });

    await expect(store.assertCapabilityDirectoryCoherence(false)).resolves.toBeUndefined();
    await expect(store.assertCapabilityDirectoryCoherence(true)).rejects.toThrow(
      "version state is missing",
    );
    const resolution = await store.synchronize(
      "executor:local",
      deviceDigest,
      inventoryDigest,
    );
    await expect(store.assertCapabilityDirectoryCoherence(true)).resolves.toBeUndefined();
    await store.markCapabilityDirectoryEstablished({
      executorId: "executor:local",
      deviceDigest,
      deviceRevision: resolution.deviceRevision,
      inventoryDigest,
      inventoryRevision: resolution.inventoryRevision,
    });
    await expect(store.assertCapabilityDirectoryCoherence(false)).rejects.toThrow(
      "directory state is missing",
    );
  });
});

async function storeMarkWithStaleSnapshot(
  file: string,
  deviceDigest: string,
  inventoryDigest: string,
): Promise<void> {
  await new FileExecutionSnapshotVersionStore(file)
    .markCapabilityDirectoryEstablished({
      executorId: "executor:local",
      deviceDigest,
      deviceRevision: 1,
      inventoryDigest,
      inventoryRevision: 2,
    });
}

describe("FileTrustRuleSnapshotCatalog", () => {
  it("allocates one version per normalized content under concurrent publishers", async () => {
    const root = await createTempDir("permission-snapshot-catalog");
    const first = await FileTrustRuleSnapshotCatalog.open(root, verifier);
    const second = await FileTrustRuleSnapshotCatalog.open(root, verifier);
    const rules = [permissionRule("rule-a", "npm test")];

    const [fromFirst, fromSecond] = await Promise.all([
      first.publishRules({ rules, signer, generatedAt: NOW }),
      second.publishRules({ rules, signer, generatedAt: "2026-07-19T00:00:01.000Z" }),
    ]);
    expect(fromFirst.snapshot.digest).toBe(fromSecond.snapshot.digest);
    expect(fromFirst.snapshot.snapshotVersion).toBe(1);
    expect(fromSecond.snapshot.snapshotVersion).toBe(1);
    expect(fromFirst.highWater).toBe(1);
    expect(fromSecond.highWater).toBe(1);

    const changed = await first.publishRules({
      rules: [permissionRule("rule-b", "pnpm test")],
      signer,
      generatedAt: "2026-07-19T00:00:02.000Z",
    });
    expect(changed.snapshot.snapshotVersion).toBe(2);
    expect(changed.highWater).toBe(2);

    const replay = await second.publishRules({
      rules,
      signer,
      generatedAt: "2026-07-19T00:00:03.000Z",
    });
    expect(replay.snapshot.digest).toBe(fromFirst.snapshot.digest);
    expect(replay.snapshot.snapshotVersion).toBe(1);
    expect(replay.highWater).toBe(2);

    const reopened = await FileTrustRuleSnapshotCatalog.open(root, verifier);
    expect(reopened.snapshotFor(fromFirst.snapshot.digest)).toEqual(fromFirst.snapshot);
    expect(reopened.snapshotFor(changed.snapshot.digest)).toEqual(changed.snapshot);
    await expect(reopened.highWater()).resolves.toBe(2);
  });
});

describe("FileExecutorCapabilityDirectoryStore", () => {
  it("persists consecutive generations and rejects stale writers", async () => {
    const root = await createTempDir("executor-capability-directory");
    const file = path.join(root, "directory.json");
    const store = new FileExecutorCapabilityDirectoryStore(file);
    const first: ExecutorCapabilityDirectoryState = {
      v: 1,
      generation: 1,
      executors: [],
    };
    await store.save(first, 0);
    await expect(store.load()).resolves.toEqual(first);
    await expect(
      store.save({ ...first, generation: 2 }, 0),
    ).rejects.toThrow("changed concurrently");
    await store.save({ ...first, generation: 2 }, 1);
    await expect(
      new FileExecutorCapabilityDirectoryStore(file).load(),
    ).resolves.toEqual({ ...first, generation: 2 });
  });
});
