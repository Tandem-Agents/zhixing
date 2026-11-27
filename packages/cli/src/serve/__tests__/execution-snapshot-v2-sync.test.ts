import { stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileArtifactStore } from "@zhixing-ai/core/authority";
import type { GlobalReadResult, GlobalStatePort, Signature } from "@zhixing-ai/core/contracts";
import {
  byteDigest,
  canonicalize,
  createSignedCapabilityDescriptor,
  createSignedExecutionAssetSnapshot,
  createSignedExecutionAssetSnapshotV2,
  createSignedExecutorVersionInventory,
  createSignedTrustRuleSnapshot,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import type { SkillCatalogEntryV2 } from "@zhixing-ai/core/skills/catalog";
import {
  decodeSkillPackageArchive,
  encodeSkillPackageArchive,
} from "@zhixing-ai/core/skills/archive";
import { createTempDir } from "@zhixing-ai/test-utils";
import { MemorySecretStore } from "./conversation-protocol-runtime-fixture.js";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing-ai/mesh/device-identity";
import { FileExecutionAssetCache } from "../execution-asset-cache.js";
import {
  MAX_EXECUTION_ASSET_CHUNK_BYTES,
  createExecutionAssetV2SyncHandler,
  syncExecutionAssetsV2OverMesh,
} from "../execution-snapshot-v2-sync.js";
import {
  MeshExecutionSnapshotClient,
  registerExecutionSnapshotMeshService,
} from "../execution-snapshot-mesh.js";
import { cleanupExecutorDeviceLocalState } from "../device-removal-cleanup.js";
import type { DisasterRecoveryStagingArea } from "../disaster-recovery-staging.js";

const NOW = "2026-11-26T12:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "anchor-test",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    if (signature.sig !== signer.sign(schemaId, version, payload).sig) {
      throw new TypeError("Signature mismatch");
    }
  },
};

function makeSkillEntryV2(input: {
  readonly id: string;
  readonly contentRef: { readonly digest: string; readonly bytes: number };
  readonly packageRef?: { readonly digest: string; readonly bytes: number };
}): SkillCatalogEntryV2 {
  const baseV2 = {
    id: input.id,
    name: input.id,
    description: "Wave 6.1 test package",
    source: "own" as const,
    mode: "work" as const,
    pinned: false,
    disabled: false,
    createdAt: NOW,
    usage: null,
    contentRef: input.contentRef,
    revision: 1,
    visibility: { modelAutoIndex: true, userSlashCommand: true },
    ...(input.packageRef ? { packageRef: input.packageRef } : {}),
  };
  return {
    ...baseV2,
    digest: protocolDigest("SkillCatalogEntry", 2, baseV2),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("ExecutionAssetSnapshotV2 sync, resume, fallback & cleanup", () => {
  it("syncs 2 MiB 64-member packages + rubrics in <= 256 KiB chunks, resumes after disconnect, aborts on peer revocation, and supports offline paginated reads", async () => {
    const anchorHome = await createTempDir("unit2-v2sync-anchor");
    const execHome = await createTempDir("unit2-v2sync-exec");
    cleanups.push(async () => {
      const fs = await import("node:fs/promises");
      await fs.rm(anchorHome, { recursive: true, force: true });
      await fs.rm(execHome, { recursive: true, force: true });
    });

    const anchorArtifacts = new FileArtifactStore(path.join(anchorHome, "artifacts"));
    const execArtifacts = new FileArtifactStore(path.join(execHome, "artifacts"));
    const anchorCache = new FileExecutionAssetCache(
      path.join(anchorHome, "distributed-runtime", "execution-assets.json"),
      anchorArtifacts,
      verifier,
    );
    const execCache = new FileExecutionAssetCache(
      path.join(execHome, "distributed-runtime", "execution-assets.json"),
      execArtifacts,
      verifier,
    );

    const templateA = `A:${"x".repeat(448 * 1024 - 2)}`;
    const templateB = `B:${"y".repeat(448 * 1024 - 2)}`;
    const deepestText = "DEEPEST-LEAF-CONTENT-OK";
    const skillMd = "---\nname: big-pkg\ndescription: Large 64-member skill\n---\nBody\n";
    const members: Array<{ readonly path: string; readonly content: string }> = [
      { path: "SKILL.md", content: skillMd },
      { path: "templates/part-a.txt", content: templateA },
      { path: "templates/part-b.txt", content: templateB },
      { path: "l1/l2/l3/l4/l5/member-063-deepest.md", content: deepestText },
    ];
    for (let index = 4; index < 64; index += 1) {
      members.push({ path: `extra/m-${index}.txt`, content: `member-${index}` });
    }
    const { bytes: archiveBytes } = encodeSkillPackageArchive(members);
    expect(archiveBytes.byteLength).toBeGreaterThan(896 * 1024);

    const contentRef = await anchorArtifacts.put(Buffer.from(skillMd, "utf8"));
    const packageRef = await anchorArtifacts.put(archiveBytes);
    const rubricBytes = Buffer.from(JSON.stringify({ id: "rubric-v2", check: true }), "utf8");
    const rubricRef = await anchorArtifacts.put(rubricBytes);
    const v2Entry = makeSkillEntryV2({ id: "big-pkg", contentRef, packageRef });

    const authorityState: GlobalStatePort = {
      async read(query): Promise<GlobalReadResult> {
        if (query.kind === "skill-catalog") {
          const { visibility: _v, packageRef: _p, digest: _d, ...v1Base } = v2Entry;
          return {
            kind: "skill-catalog",
            catalogRevision: 1,
            entries: [{ ...v1Base, digest: protocolDigest("SkillCatalogEntry", 1, v1Base) }],
          };
        }
        if (query.kind === "skill-catalog-v2") {
          return { kind: "skill-catalog-v2", catalogRevision: 1, entries: [v2Entry] };
        }
        if (query.kind === "asset-index" && query.asset === "rubrics") {
          return {
            kind: "asset-index",
            entries: [{ id: "rubric-v2", kind: "rubrics", revision: 1, digest: rubricRef.digest }],
          };
        }
        return { kind: "asset-index", entries: [] };
      },
      async stage() {
        return { accepted: true };
      },
    };

    await anchorCache.publishFromAuthority({
      state: authorityState,
      anchorEpoch: 1,
      signer,
      generatedAt: NOW,
    });
    const syncSource = await anchorCache.syncSourceV2();
    expect(syncSource).toBeDefined();
    expect(syncSource!.indexRefs?.some((ref) => ref.digest === rubricRef.digest)).toBe(true);

    const handlers = new Map<string, (payload: Uint8Array, conn: { peer: { deviceId: string } }, sig: AbortSignal) => Promise<Uint8Array>>();
    let peerAuthorized = true;
    const capability = {
      descriptor: createSignedCapabilityDescriptor(
        {
          executorId: "exec-b",
          revision: 1,
          protocolVersion: "2",
          workspaces: [],
          tools: ["read", "runtime_inspect", "skill_read"],
          mcpServers: [],
          credentialBindings: [],
          evidenceCapabilities: ["artifact", "file-diff", "log"],
          at: NOW,
        },
        signer,
      ),
      inventory: createSignedExecutorVersionInventory(
        {
          executorId: "exec-b",
          inventoryRevision: 1,
          capabilityRevision: 1,
          configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
          assetVersions: { skillsRev: 2, rubricsRev: 2, promptAssetsRev: 2 },
          permissionSnapshotHighWater: 0,
          credentialBindingRevisions: [],
          at: NOW,
        },
        signer,
      ),
    };
    const v2Sync = createExecutionAssetV2SyncHandler({
      zhixingHome: execHome,
      artifacts: execArtifacts,
      executionAssets: execCache,
      verifier,
      refreshCapability: async () => capability,
    });
    registerExecutionSnapshotMeshService(
      {
        register(name, def) {
          handlers.set(name, def.handler);
          return () => handlers.delete(name);
        },
      } as never,
      {
        currentCapability: async () => capability,
        installPermission: async () => capability,
        installAssets: async () => capability,
      },
      () => peerAuthorized,
      verifier,
      v2Sync,
    );

    const requestHandler = handlers.get("execution.snapshot")!;
    let chunkCount = 0;
    let disconnectAfterChunks = 2;
    let revokeOnChunkCount = Number.POSITIVE_INFINITY;
    const chunkSizes: number[] = [];
    const client = {
      async request(_service: string, payload: Uint8Array, signal?: AbortSignal) {
        const parsed = JSON.parse(Buffer.from(payload).toString("utf8")) as {
          method?: string;
          chunkBase64?: string;
        };
        if (parsed.method === "upload-asset-chunk-v2") {
          chunkCount += 1;
          chunkSizes.push(Buffer.from(parsed.chunkBase64 ?? "", "base64").byteLength);
          if (chunkCount === disconnectAfterChunks + 1) {
            throw new Error("Simulated mid-stream mesh disconnect");
          }
          if (chunkCount === revokeOnChunkCount) {
            peerAuthorized = false;
          }
        }
        return await requestHandler(
          payload,
          { peer: { deviceId: "anchor-a" } },
          signal ?? new AbortController().signal,
        );
      },
    };

    const v2JsonPath = path.join(execHome, "distributed-runtime", "execution-assets-v2.json");
    const partialsDir = path.join(execHome, "distributed-runtime", "execution-asset-partials");

    // Item 1: Unreconciled snapshotDigest or unreferenced ref rejected BEFORE touching partials
    const rogueBytes = Buffer.from("ROGUE_CHUNK", "utf8");
    const rogueRef = { digest: byteDigest(rogueBytes), bytes: rogueBytes.byteLength };
    await expect(
      client.request(
        "execution.snapshot",
        Buffer.from(
          canonicalize({
            v: 2,
            method: "upload-asset-chunk-v2",
            snapshotDigest: `sha256:${"a".repeat(64)}`,
            ref: rogueRef,
            offset: 0,
            chunkBase64: rogueBytes.toString("base64"),
          }),
          "utf8",
        ),
      ),
    ).rejects.toThrow("Execution asset chunk is not authorized by a reconciled v2 snapshot");
    expect(await exists(partialsDir)).toBe(false);

    // Item 2: Seed older v1 snapshot (snapshotRevision: 2, empty rubrics) on execCache before syncing v2 (revision >= 3)
    const olderV1Bundle = {
      v: 1 as const,
      snapshot: createSignedExecutionAssetSnapshot(
        {
          snapshotRevision: 2,
          skillCatalogRevision: 1,
          skills: [],
          rubrics: [],
          promptAssets: [],
          generatedAt: NOW,
        },
        signer,
      ),
      artifacts: [],
    };
    await execCache.installBundle(olderV1Bundle);

    await expect(
      syncExecutionAssetsV2OverMesh({ client: client as never, verifier, source: syncSource! }),
    ).rejects.toThrow("Simulated mid-stream mesh disconnect");
    await expect(
      client.request(
        "execution.snapshot",
        Buffer.from(
          canonicalize({
            v: 2,
            method: "upload-asset-chunk-v2",
            snapshotDigest: syncSource!.v2Snapshot.digest,
            ref: rogueRef,
            offset: 0,
            chunkBase64: rogueBytes.toString("base64"),
          }),
          "utf8",
        ),
      ),
    ).rejects.toThrow("Execution asset chunk is not authorized by a reconciled v2 snapshot");
    expect(await exists(v2JsonPath)).toBe(false);
    expect(await exists(partialsDir)).toBe(true);
    expect(chunkSizes.every((size) => size <= MAX_EXECUTION_ASSET_CHUNK_BYTES)).toBe(true);

    // Revoke mid-stream before next chunk must abort immediately without publishing v2 cache
    disconnectAfterChunks = 9999;
    const chunksBeforeRevoke = chunkCount;
    revokeOnChunkCount = chunksBeforeRevoke + 1;
    await expect(
      syncExecutionAssetsV2OverMesh({ client: client as never, verifier, source: syncSource! }),
    ).rejects.toThrow(/Authenticated mesh peer cannot synchronize execution v2 assets|Peer authorization revoked/u);
    expect(chunkCount).toBe(chunksBeforeRevoke + 1);
    expect(await exists(v2JsonPath)).toBe(false);

    // Restore authorization & resume from receivedBytes cleanly (anchor republished at rev >= 3 so v2 beats v1 rev 2)
    peerAuthorized = true;
    const rubricReadBefore = await execCache.read({ kind: "asset-index", asset: "rubrics" });
    expect(rubricReadBefore.kind === "asset-index" && rubricReadBefore.entries).toEqual([]);
    await execCache.installV2(
      createSignedExecutionAssetSnapshotV2(
        {
          snapshotRevision: 3,
          skillCatalogRevision: 1,
          skills: [v2Entry],
          rubrics: [{ id: "rubric-v2", kind: "rubrics", revision: 1, digest: rubricRef.digest }],
          promptAssets: [],
          generatedAt: NOW,
        },
        signer,
      ),
    ).catch(() => {});
    const resumed = await syncExecutionAssetsV2OverMesh({
      client: client as never,
      verifier,
      source: syncSource!,
    });
    expect(resumed.descriptor.executorId).toBe("exec-b");
    expect(await exists(v2JsonPath)).toBe(true);

    const catalogRead = await execCache.read({ kind: "skill-catalog-v2", includeDisabled: true });
    expect(catalogRead.kind).toBe("skill-catalog-v2");
    expect(catalogRead.kind === "skill-catalog-v2" && catalogRead.entries[0]?.packageRef).toEqual(packageRef);
    const v1SkillRead = await execCache.read({ kind: "skill-get", skillId: "big-pkg" });
    expect(v1SkillRead.kind === "skill-get" && v1SkillRead.entry?.id).toBe("big-pkg");
    const rubricRead = await execCache.read({ kind: "asset-index", asset: "rubrics" });
    expect(rubricRead.kind === "asset-index" && rubricRead.entries[0]?.digest).toBe(rubricRef.digest);

    // Offline paginated read via readArtifactRange (< 12288 B chunks) reconstructs identical package
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < packageRef.bytes; offset += 12_288) {
      const part = await execCache.readArtifactRange(packageRef.digest, offset, 12_288);
      expect(part).toBeDefined();
      chunks.push(part!);
    }
    const reassembled = Buffer.concat(chunks);
    expect(byteDigest(reassembled)).toBe(packageRef.digest);
    const unpacked = decodeSkillPackageArchive(reassembled);
    const deepestMember = unpacked.byPath.get("l1/l2/l3/l4/l5/member-063-deepest.md");
    expect(deepestMember?.text).toBe(deepestText);

    // Device removal cleans v1, v2, locks, and partials
    const deviceKey = await DeviceKey.generate();
    enrollDeviceIdentity(deviceKey, { displayName: "exec-b", platform: "windows", enrolledAt: NOW });
    const stagingStub: DisasterRecoveryStagingArea = {
      openTarget() {
        throw new Error("unused");
      },
      async cleanupPostInstall() {},
      async cleanupCurrentDevice() {},
      async close() {},
    };
    await cleanupExecutorDeviceLocalState({
      zhixingHome: execHome,
      secretStore: new MemorySecretStore(),
      deviceKey,
      disasterRecoveryStaging: stagingStub,
      unregisterFuture: async () => {},
    });
    expect(await exists(v2JsonPath)).toBe(false);
    expect(await exists(partialsDir)).toBe(false);
    expect(await exists(path.join(execHome, "distributed-runtime", "execution-assets.json"))).toBe(false);
  });

  it("falls back to v1 install-assets when remote target rejects v2 execution snapshot requests", async () => {
    const v1Bundle = {
      v: 1 as const,
      snapshot: createSignedExecutionAssetSnapshot(
        {
          snapshotRevision: 2,
          skillCatalogRevision: 1,
          skills: [],
          rubrics: [],
          promptAssets: [],
          generatedAt: NOW,
        },
        signer,
      ),
      artifacts: [],
    };
    const v2Snapshot = createSignedExecutionAssetSnapshotV2(
      {
        snapshotRevision: 2,
        skillCatalogRevision: 1,
        skills: [],
        rubrics: [],
        promptAssets: [],
        generatedAt: NOW,
      },
      signer,
    );
    const capability = {
      descriptor: createSignedCapabilityDescriptor(
        {
          executorId: "legacy-exec",
          revision: 1,
          protocolVersion: "1",
          workspaces: [],
          tools: ["load_skill", "read"],
          mcpServers: [],
          credentialBindings: [],
          evidenceCapabilities: [],
          at: NOW,
        },
        signer,
      ),
      inventory: createSignedExecutorVersionInventory(
        {
          executorId: "legacy-exec",
          inventoryRevision: 1,
          capabilityRevision: 1,
          configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
          assetVersions: { skillsRev: 2, rubricsRev: 2, promptAssetsRev: 2 },
          permissionSnapshotHighWater: 0,
          credentialBindingRevisions: [],
          at: NOW,
        },
        signer,
      ),
    };
    const permission = createSignedTrustRuleSnapshot(
      { snapshotVersion: 1, rules: [], generatedAt: NOW },
      signer,
    );
    const methods: string[] = [];
    const client = {
      request: vi.fn(async (_service: string, payload: Uint8Array) => {
        const parsed = JSON.parse(Buffer.from(payload).toString("utf8")) as { v?: number; method?: string };
        methods.push(`${parsed.v}:${parsed.method}`);
        if (parsed.v === 2) {
          throw new Error("Execution snapshot request is invalid");
        }
        return Buffer.from(JSON.stringify(capability), "utf8");
      }),
    };
    const meshClient = new MeshExecutionSnapshotClient(client as never, verifier);
    let lazyBundleCalls = 0;
    const result = await meshClient.installPermission(
      permission,
      async () => {
        lazyBundleCalls += 1;
        return v1Bundle;
      },
      {
        v2Snapshot,
        readArtifactRange: async () => new Uint8Array(0),
      },
    );
    expect(result.descriptor.executorId).toBe("legacy-exec");
    // Known v1 descriptor skips futile v2 RPC probe and builds v1 bundle once on demand.
    expect(lazyBundleCalls).toBe(1);
    expect(methods).toEqual(["1:install-permission", "1:install-assets"]);

    const { MeshProtocolError } = await import("@zhixing-ai/mesh/errors");
    const wireFallbackClient = {
      request: vi.fn(async (_service: string, payload: Uint8Array) => {
        const parsed = JSON.parse(Buffer.from(payload).toString("utf8")) as { v?: number; method?: string };
        if (parsed.v === 2) {
          throw new MeshProtocolError("service-failed", "Mesh service failed");
        }
        return Buffer.from(JSON.stringify(capability), "utf8");
      }),
    };
    const { ExecutionAssetV2UnsupportedError } = await import("../execution-snapshot-v2-sync.js");
    await expect(
      syncExecutionAssetsV2OverMesh({
        client: wireFallbackClient as never,
        verifier,
        source: { v2Snapshot, readArtifactRange: async () => new Uint8Array(0) },
      }),
    ).rejects.toThrow(ExecutionAssetV2UnsupportedError);

    const authClient = new MeshExecutionSnapshotClient(
      {
        request: vi.fn(async (_service: string, payload: Uint8Array) => {
          const parsed = JSON.parse(Buffer.from(payload).toString("utf8")) as { v?: number };
          if (parsed.v === 2) {
            throw new MeshProtocolError("unauthorized-peer", "Mesh peer is not authorized");
          }
          return Buffer.from(JSON.stringify(capability), "utf8");
        }),
      } as never,
      verifier,
    );
    await expect(
      authClient.installPermission(permission, undefined, {
        v2Snapshot,
        readArtifactRange: async () => new Uint8Array(0),
      }),
    ).rejects.toMatchObject({ code: "unauthorized-peer" });

    // Item 3: v2 executor NEVER calls lazy bundle() and NEVER swallows service-failed into v1 downgrade
    const v2Capability = {
      descriptor: createSignedCapabilityDescriptor(
        {
          executorId: "v2-exec",
          revision: 1,
          protocolVersion: "2",
          workspaces: [],
          tools: ["read", "runtime_inspect", "skill_read"],
          mcpServers: [],
          credentialBindings: [],
          evidenceCapabilities: [],
          at: NOW,
        },
        signer,
      ),
      inventory: createSignedExecutorVersionInventory(
        {
          executorId: "v2-exec",
          inventoryRevision: 1,
          capabilityRevision: 1,
          configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
          assetVersions: { skillsRev: 2, rubricsRev: 2, promptAssetsRev: 2 },
          permissionSnapshotHighWater: 0,
          credentialBindingRevisions: [],
          at: NOW,
        },
        signer,
      ),
    };
    const v2NoDowngradeMethods: string[] = [];
    const v2NoDowngradeClient = new MeshExecutionSnapshotClient(
      {
        request: vi.fn(async (_service: string, payload: Uint8Array) => {
          const parsed = JSON.parse(Buffer.from(payload).toString("utf8")) as { v?: number; method?: string };
          v2NoDowngradeMethods.push(`${parsed.v}:${parsed.method}`);
          if (parsed.v === 2) {
            throw new MeshProtocolError("service-failed", "Simulated transient v2 failure");
          }
          return Buffer.from(JSON.stringify(v2Capability), "utf8");
        }),
      } as never,
      verifier,
    );
    let v2BundleCalls = 0;
    await expect(
      v2NoDowngradeClient.installPermission(
        permission,
        async () => {
          v2BundleCalls += 1;
          return v1Bundle;
        },
        {
          v2Snapshot,
          readArtifactRange: async () => new Uint8Array(0),
        },
      ),
    ).rejects.toThrow();
    expect(v2BundleCalls).toBe(0);
    expect(v2NoDowngradeMethods).toEqual(["1:install-permission", "2:stage-snapshot-meta-v2"]);
  });

  it(
    "syncs > 1 MiB 1,350-entry v2 catalog over default Mesh frame limit and blocks queued commit on peer revocation",
    { timeout: 30_000 },
    async () => {
    const fs = await import("node:fs/promises");
    const anchorHome = await createTempDir("unit2-v2-large-anchor");
    const execHome = await createTempDir("unit2-v2-large-exec");
    cleanups.push(async () => {
      await fs.rm(anchorHome, { recursive: true, force: true });
      await fs.rm(execHome, { recursive: true, force: true });
    });

    const anchorArtifacts = new FileArtifactStore(path.join(anchorHome, "artifacts"));
    const execArtifacts = new FileArtifactStore(path.join(execHome, "artifacts"));
    const anchorCache = new FileExecutionAssetCache(
      path.join(anchorHome, "distributed-runtime", "execution-assets.json"),
      anchorArtifacts,
      verifier,
    );
    const execCache = new FileExecutionAssetCache(
      path.join(execHome, "distributed-runtime", "execution-assets.json"),
      execArtifacts,
      verifier,
    );

    const baseContentRef = await anchorArtifacts.put(
      Buffer.from("---\nname: shared-ref\ndescription: Large catalog entry\n---\nBody\n", "utf8"),
    );
    const pkgBytes = encodeSkillPackageArchive([
      { path: "SKILL.md", content: "---\nname: pkg\ndescription: small pkg\n---\nBody\n" },
      { path: "notes/info.md", content: "small attachment" },
    ]).bytes;
    const basePackageRef = await anchorArtifacts.put(pkgBytes);
    const entries: SkillCatalogEntryV2[] = [];
    const longDesc = `Large catalog entry description padding ${"d".repeat(520)}`;
    for (let index = 0; index < 1350; index += 1) {
      const baseV2 = {
        id: `catalog-skill-${String(index).padStart(4, "0")}`,
        name: `catalog-skill-${String(index).padStart(4, "0")}`,
        description: longDesc,
        source: "own" as const,
        mode: "work" as const,
        pinned: false,
        disabled: false,
        createdAt: NOW,
        usage: null,
        contentRef: baseContentRef,
        revision: 1,
        visibility: { modelAutoIndex: true, userSlashCommand: true },
        packageRef: basePackageRef,
      };
      entries.push({
        ...baseV2,
        digest: protocolDigest("SkillCatalogEntry", 2, baseV2),
      });
    }
    const largeSnapshot = createSignedExecutionAssetSnapshotV2(
      {
        snapshotRevision: 2,
        skillCatalogRevision: 10,
        skills: entries,
        rubrics: [],
        promptAssets: [],
        generatedAt: NOW,
      },
      signer,
    );
    await anchorCache.installV2(largeSnapshot);
    const metaBytes = Buffer.byteLength(canonicalize({ v: 2, snapshot: largeSnapshot }), "utf8");
    expect(metaBytes).toBeGreaterThan(1_048_576);

    const { connectAuthenticatedMesh, createAuthenticatedMeshServer } = await import("@zhixing-ai/mesh/handshake");
    const { HandshakeReplayWindow } = await import("@zhixing-ai/mesh/replay-window");
    const { MeshRequestChannel } = await import("@zhixing-ai/mesh/request-channel");
    const { MeshServiceRegistry } = await import("@zhixing-ai/mesh/service-registry");
    const execKey = await DeviceKey.generate();
    const anchorKey = await DeviceKey.generate();
    const execIdent = enrollDeviceIdentity(execKey, { displayName: "exec", platform: "windows", enrolledAt: NOW });
    const anchorIdent = enrollDeviceIdentity(anchorKey, { displayName: "anchor", platform: "windows", enrolledAt: NOW });

    const cap = {
      descriptor: createSignedCapabilityDescriptor(
        {
          executorId: `exec:${execIdent.deviceId}`,
          revision: 1,
          protocolVersion: "2",
          workspaces: [],
          tools: ["read", "runtime_inspect", "skill_read"],
          mcpServers: [],
          credentialBindings: [],
          evidenceCapabilities: [],
          at: NOW,
        },
        signer,
      ),
      inventory: createSignedExecutorVersionInventory(
        {
          executorId: `exec:${execIdent.deviceId}`,
          inventoryRevision: 1,
          capabilityRevision: 1,
          configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
          assetVersions: { skillsRev: 2, rubricsRev: 2, promptAssetsRev: 2 },
          permissionSnapshotHighWater: 0,
          credentialBindingRevisions: [],
          at: NOW,
        },
        signer,
      ),
    };
    let peerAuthorized = true;
    let releaseQueue!: () => void;
    let queueEntered!: () => void;
    let queueBlocked = false;
    const regB = new MeshServiceRegistry();
    const v2Sync = createExecutionAssetV2SyncHandler({
      zhixingHome: execHome,
      artifacts: execArtifacts,
      executionAssets: execCache,
      verifier,
      refreshCapability: async () => cap,
      runRevisionChange: async (work) => {
        if (queueBlocked) {
          queueEntered();
          await new Promise<void>((res) => {
            releaseQueue = res;
          });
        }
        return await work();
      },
    });
    registerExecutionSnapshotMeshService(
      regB,
      { currentCapability: async () => cap, installPermission: async () => cap, installAssets: async () => cap },
      () => peerAuthorized,
      verifier,
      v2Sync,
    );
    const server = await createAuthenticatedMeshServer(
      {
        identity: execKey,
        trustedPeers: [{ identity: anchorIdent, rootCertificatePem: anchorKey.rootCertificatePem }],
        protocolRange: { min: "1", max: "1" },
        replayWindow: new HandshakeReplayWindow(),
        authorizePeer: () => true,
      },
      (conn) => {
        // Default maxFrameBytes (1 MiB) — never enlarged!
        new MeshRequestChannel(conn, regB);
      },
    );
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    cleanups.push(() => new Promise<void>((res) => server.close(() => res())));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("missing port");
    const conn = await connectAuthenticatedMesh({
      host: "127.0.0.1",
      port: addr.port,
      identity: anchorKey,
      trustedPeer: { identity: execIdent, rootCertificatePem: execKey.rootCertificatePem },
      protocolRange: { min: "1", max: "1" },
      authorizePeer: () => true,
    });
    const chan = new MeshRequestChannel(conn, new MeshServiceRegistry());
    cleanups.push(async () => {
      await chan.close().catch(() => {});
      await conn.close().catch(() => {});
    });

    const sourceV2 = await anchorCache.syncSourceV2();
    expect(sourceV2).toBeDefined();

    // 1) Queued revocation fence: block commit inside runRevisionChange, revoke peer, release -> rejected & not published!
    queueBlocked = true;
    const enteredPromise = new Promise<void>((res) => {
      queueEntered = res;
    });
    const revokedSync = syncExecutionAssetsV2OverMesh({
      client: chan,
      verifier,
      source: sourceV2!,
    });
    await enteredPromise;
    peerAuthorized = false;
    releaseQueue();
    await expect(revokedSync).rejects.toMatchObject({ code: "unauthorized-peer" });
    expect(await exists(path.join(execHome, "distributed-runtime", "execution-assets-v2.json"))).toBe(false);

    // 2) Restore auth and complete > 1 MiB 1,350-entry sync over unmodified 1 MiB MeshRequestChannel
    peerAuthorized = true;
    queueBlocked = false;
    const committed = await syncExecutionAssetsV2OverMesh({
      client: chan,
      verifier,
      source: sourceV2!,
    });
    expect(committed.descriptor.executorId).toBe(cap.descriptor.executorId);
    const readBack = await execCache.read({ kind: "skill-catalog-v2", includeDisabled: true });
    expect(readBack.kind === "skill-catalog-v2" && readBack.entries).toHaveLength(1350);
  },
  );

  it(
    "R2-2: sweeps committed and evicted meta-cas artifacts across 3x4=12 releases while preserving active meta-staging checkpoints",
    { timeout: 30_000 },
    async () => {
      const fs = await import("node:fs/promises");
      const { encodeSnapshotMetaEnvelope, encodeJsonPayload, decodeJsonPayload } = await import(
        "../execution-snapshot-v2-wire.js"
      );
      const { connectAuthenticatedMesh, createAuthenticatedMeshServer } = await import(
        "@zhixing-ai/mesh/handshake"
      );
      const { HandshakeReplayWindow } = await import("@zhixing-ai/mesh/replay-window");
      const { MeshRequestChannel } = await import("@zhixing-ai/mesh/request-channel");
      const { MeshServiceRegistry } = await import("@zhixing-ai/mesh/service-registry");

      const execHome = await createTempDir("unit2-v2-metacas-exec");
      const anchorHome = await createTempDir("unit2-v2-metacas-anchor");
      cleanups.push(async () => {
        await fs.rm(execHome, { recursive: true, force: true });
        await fs.rm(anchorHome, { recursive: true, force: true });
      });

      const anchorArtifacts = new FileArtifactStore(path.join(anchorHome, "artifacts"));
      const execArtifacts = new FileArtifactStore(path.join(execHome, "artifacts"));
      const anchorCache = new FileExecutionAssetCache(
        path.join(anchorHome, "distributed-runtime", "execution-assets.json"),
        anchorArtifacts,
        verifier,
      );
      const execCache = new FileExecutionAssetCache(
        path.join(execHome, "distributed-runtime", "execution-assets.json"),
        execArtifacts,
        verifier,
      );

      const execKey = await DeviceKey.generate();
      const anchorKey = await DeviceKey.generate();
      const execIdent = enrollDeviceIdentity(execKey, { displayName: "exec", platform: "windows", enrolledAt: NOW });
      const anchorIdent = enrollDeviceIdentity(anchorKey, { displayName: "anchor", platform: "windows", enrolledAt: NOW });
      const cap = {
        descriptor: createSignedCapabilityDescriptor(
          {
            executorId: `exec:${execIdent.deviceId}`,
            revision: 1,
            protocolVersion: "2",
            workspaces: [],
            tools: ["read", "runtime_inspect", "skill_read"],
            mcpServers: [],
            credentialBindings: [],
            evidenceCapabilities: [],
            at: NOW,
          },
          signer,
        ),
        inventory: createSignedExecutorVersionInventory(
          {
            executorId: `exec:${execIdent.deviceId}`,
            inventoryRevision: 1,
            capabilityRevision: 1,
            configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
            assetVersions: { skillsRev: 2, rubricsRev: 2, promptAssetsRev: 2 },
            permissionSnapshotHighWater: 0,
            credentialBindingRevisions: [],
            at: NOW,
          },
          signer,
        ),
      };

      const countFilesRecursive = async (dirPath: string): Promise<number> => {
        let entries: Awaited<ReturnType<typeof fs.readdir>>;
        try {
          entries = await fs.readdir(dirPath, { withFileTypes: true });
        } catch (error) {
          if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
            return 0;
          }
          throw error;
        }
        let total = 0;
        for (const entry of entries) {
          const full = path.join(dirPath, entry.name);
          if (entry.isDirectory()) total += await countFilesRecursive(full);
          else if (entry.isFile()) total += 1;
        }
        return total;
      };

      const partialsDir = path.join(execHome, "distributed-runtime", "execution-asset-partials");
      const metaCasShaRoot = path.join(partialsDir, "meta-cas", "sha256");
      const metaStagingDir = path.join(partialsDir, "meta-staging");

      // Prepare a multi-chunk (> 256 KiB) meta envelope to simulate an active interrupted meta-staging breakpoint
      const bigBodyRef = await anchorArtifacts.put(Buffer.from("# Pending\n", "utf8"));
      const pendingSkills: SkillCatalogEntryV2[] = [];
      for (let i = 0; i < 420; i += 1) {
        const base = {
          id: `pending-skill-${String(i).padStart(4, "0")}`,
          name: `pending-skill-${String(i).padStart(4, "0")}`,
          description: `Pending checkpoint padding ${"p".repeat(520)}`,
          source: "own" as const,
          mode: "work" as const,
          pinned: false,
          disabled: false,
          createdAt: NOW,
          usage: null,
          contentRef: bigBodyRef,
          revision: 1,
          visibility: { modelAutoIndex: true, userSlashCommand: true },
        };
        pendingSkills.push({ ...base, digest: protocolDigest("SkillCatalogEntry", 2, base) });
      }
      const pendingSnapshot = createSignedExecutionAssetSnapshotV2(
        {
          snapshotRevision: 99,
          skillCatalogRevision: 99,
          skills: pendingSkills,
          rubrics: [],
          promptAssets: [],
          generatedAt: NOW,
        },
        signer,
      );
      const pendingMeta = encodeSnapshotMetaEnvelope(pendingSnapshot);
      expect(pendingMeta.bytes.byteLength).toBeGreaterThan(262_144);

      const contentRef = await anchorArtifacts.put(Buffer.from("# Shared\n", "utf8"));
      const skills: SkillCatalogEntryV2[] = [];
      let rev = 1;
      let interruptedOffset = 0;

      // 3 handler instances * 4 releases = 12 releases
      for (let instanceIdx = 0; instanceIdx < 3; instanceIdx += 1) {
        const regB = new MeshServiceRegistry();
        const v2Sync = createExecutionAssetV2SyncHandler({
          zhixingHome: execHome,
          artifacts: execArtifacts,
          executionAssets: execCache,
          verifier,
          refreshCapability: async () => cap,
        });
        registerExecutionSnapshotMeshService(
          regB,
          { currentCapability: async () => cap, installPermission: async () => cap, installAssets: async () => cap },
          () => true,
          verifier,
          v2Sync,
        );
        const server = await createAuthenticatedMeshServer(
          {
            identity: execKey,
            trustedPeers: [{ identity: anchorIdent, rootCertificatePem: anchorKey.rootCertificatePem }],
            protocolRange: { min: "1", max: "1" },
            replayWindow: new HandshakeReplayWindow(),
            authorizePeer: () => true,
          },
          (conn) => {
            new MeshRequestChannel(conn, regB);
          },
        );
        await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("missing port");
        const conn = await connectAuthenticatedMesh({
          host: "127.0.0.1",
          port: addr.port,
          identity: anchorKey,
          trustedPeer: { identity: execIdent, rootCertificatePem: execKey.rootCertificatePem },
          protocolRange: { min: "1", max: "1" },
          authorizePeer: () => true,
        });
        const chan = new MeshRequestChannel(conn, new MeshServiceRegistry());

        try {
          if (instanceIdx === 0) {
            // Stage only the first 64 KiB chunk of pendingSnapshot into meta-staging before the 12 releases
            const firstSlice = pendingMeta.bytes.subarray(0, 65_536);
            const stageRes = decodeJsonPayload(
              await chan.request(
                "execution.snapshot",
                encodeJsonPayload({
                  v: 2,
                  method: "stage-snapshot-meta-v2",
                  metaRef: pendingMeta.ref,
                  offset: 0,
                  chunkBase64: Buffer.from(firstSlice).toString("base64"),
                }),
              ),
            ) as { receivedBytes: number; complete: boolean };
            expect(stageRes.complete).toBe(false);
            interruptedOffset = stageRes.receivedBytes;
            expect(interruptedOffset).toBe(65_536);
          }

          for (let releaseIdx = 0; releaseIdx < 4; releaseIdx += 1) {
            rev += 1;
            const id = `rel-${instanceIdx}-${releaseIdx}`;
            const base = {
              id,
              name: id,
              description: `${id} desc`,
              source: "own" as const,
              mode: "work" as const,
              pinned: false,
              disabled: false,
              createdAt: NOW,
              usage: null,
              contentRef,
              revision: 1,
              visibility: { modelAutoIndex: true, userSlashCommand: true },
            };
            skills.push({ ...base, digest: protocolDigest("SkillCatalogEntry", 2, base) });
            const snap = createSignedExecutionAssetSnapshotV2(
              {
                snapshotRevision: rev,
                skillCatalogRevision: rev,
                skills: [...skills],
                rubrics: [],
                promptAssets: [],
                generatedAt: NOW,
              },
              signer,
            );
            await anchorCache.installV2(snap);
            const source = await anchorCache.syncSourceV2();
            await syncExecutionAssetsV2OverMesh({
              client: chan,
              verifier,
              source: source!,
            });
            // Every release sweeps its committed meta-cas artifact -> 0 files remain in meta-cas/sha256
            expect(await countFilesRecursive(metaCasShaRoot)).toBe(0);
          }

          if (instanceIdx === 2) {
            // Active meta-staging checkpoint must have survived all 12 sweeps and resume cleanly
            expect(await countFilesRecursive(metaStagingDir)).toBeGreaterThan(0);
            let offset = interruptedOffset;
            let completed = false;
            while (offset < pendingMeta.bytes.byteLength) {
              const slice = pendingMeta.bytes.subarray(offset, Math.min(pendingMeta.bytes.byteLength, offset + 262_144));
              const res = decodeJsonPayload(
                await chan.request(
                  "execution.snapshot",
                  encodeJsonPayload({
                    v: 2,
                    method: "stage-snapshot-meta-v2",
                    metaRef: pendingMeta.ref,
                    offset,
                    chunkBase64: Buffer.from(slice).toString("base64"),
                  }),
                ),
              ) as { receivedBytes: number; complete: boolean; snapshotDigest?: string };
              offset = res.receivedBytes;
              completed = res.complete;
              if (completed) {
                expect(res.snapshotDigest).toBe(pendingSnapshot.digest);
                break;
              }
            }
            expect(completed).toBe(true);
          }
        } finally {
          await chan.close().catch(() => {});
          await conn.close().catch(() => {});
          await new Promise<void>((res) => server.close(() => res()));
        }
      }
    },
  );

  it(
    "R3-2: two concurrent syncs and a post-commit retry on the same snapshotDigest both succeed with the same revision while stale or revoked requests fail closed",
    { timeout: 30_000 },
    async () => {
      const fs = await import("node:fs/promises");
      const { encodeJsonPayload, decodeJsonPayload } = await import(
        "../execution-snapshot-v2-wire.js"
      );
      const execHome = await createTempDir("unit2-v2-r3-2-exec");
      const anchorHome = await createTempDir("unit2-v2-r3-2-anchor");
      cleanups.push(async () => {
        await fs.rm(execHome, { recursive: true, force: true });
        await fs.rm(anchorHome, { recursive: true, force: true });
      });

      const anchorArtifacts = new FileArtifactStore(path.join(anchorHome, "artifacts"));
      const execArtifacts = new FileArtifactStore(path.join(execHome, "artifacts"));
      const anchorCache = new FileExecutionAssetCache(
        path.join(anchorHome, "distributed-runtime", "execution-assets.json"),
        anchorArtifacts,
        verifier,
      );
      const execCache = new FileExecutionAssetCache(
        path.join(execHome, "distributed-runtime", "execution-assets.json"),
        execArtifacts,
        verifier,
      );

      let peerAuthorized = true;
      const currentCapability = async () => {
        const curV2 = await execCache.currentV2();
        const rev = curV2?.snapshotRevision ?? 1;
        return {
          descriptor: createSignedCapabilityDescriptor(
            {
              executorId: "exec-r3-2",
              revision: rev,
              protocolVersion: "2",
              workspaces: [],
              tools: ["read", "runtime_inspect", "skill_read"],
              mcpServers: [],
              credentialBindings: [],
              evidenceCapabilities: [],
              at: NOW,
            },
            signer,
          ),
          inventory: createSignedExecutorVersionInventory(
            {
              executorId: "exec-r3-2",
              inventoryRevision: rev,
              capabilityRevision: rev,
              configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
              assetVersions: { skillsRev: rev, rubricsRev: rev, promptAssetsRev: rev },
              permissionSnapshotHighWater: 0,
              credentialBindingRevisions: [],
              at: NOW,
            },
            signer,
          ),
        };
      };

      let revisionChain: Promise<unknown> = Promise.resolve();
      const runRevisionChange = <T>(work: () => Promise<T>): Promise<T> => {
        const next = revisionChain.then(work, work);
        revisionChain = next.then(() => undefined, () => undefined);
        return next;
      };

      const makeHandler = () => {
        const handlers = new Map<
          string,
          (payload: Uint8Array, conn: { peer: { deviceId: string } }, sig: AbortSignal) => Promise<Uint8Array>
        >();
        const v2Sync = createExecutionAssetV2SyncHandler({
          zhixingHome: execHome,
          artifacts: execArtifacts,
          executionAssets: execCache,
          verifier,
          refreshCapability: currentCapability,
          runRevisionChange,
        });
        registerExecutionSnapshotMeshService(
          {
            register(name, def) {
              handlers.set(name, def.handler);
              return () => handlers.delete(name);
            },
          } as never,
          {
            currentCapability,
            installPermission: currentCapability,
            installAssets: currentCapability,
          },
          () => peerAuthorized,
          verifier,
          v2Sync,
        );
        return handlers.get("execution.snapshot")!;
      };

      let handler = makeHandler();
      const contentRef1 = await anchorArtifacts.put(Buffer.from("# Skill Rev 1\n", "utf8"));
      const entry1Base = {
        id: "conc-skill-1",
        name: "conc-skill-1",
        description: "v1",
        source: "own" as const,
        mode: "work" as const,
        pinned: false,
        disabled: false,
        createdAt: NOW,
        usage: null,
        contentRef: contentRef1,
        revision: 1,
        visibility: { modelAutoIndex: true, userSlashCommand: true },
      };
      const snap1 = createSignedExecutionAssetSnapshotV2(
        {
          snapshotRevision: 2,
          skillCatalogRevision: 1,
          skills: [{ ...entry1Base, digest: protocolDigest("SkillCatalogEntry", 2, entry1Base) }],
          rubrics: [],
          promptAssets: [],
          generatedAt: NOW,
        },
        signer,
      );
      await anchorCache.installV2(snap1);
      const source1 = (await anchorCache.syncSourceV2())!;

      // Force both syncs to finish reconcile-assets-v2 BEFORE either sends commit-assets-v2
      let reconciledCount = 0;
      let releaseCommits!: () => void;
      const bothReconciled = new Promise<void>((res) => {
        releaseCommits = res;
      });
      const barrierClient = {
        async request(_service: string, payload: Uint8Array, signal?: AbortSignal) {
          const parsed = decodeJsonPayload(payload) as { method?: string };
          if (parsed.method === "reconcile-assets-v2") {
            const resp = await handler(
              payload,
              { peer: { deviceId: "anchor-a" } },
              signal ?? new AbortController().signal,
            );
            reconciledCount += 1;
            if (reconciledCount >= 2) releaseCommits();
            return resp;
          }
          if (parsed.method === "commit-assets-v2") {
            await bothReconciled;
          }
          return await handler(
            payload,
            { peer: { deviceId: "anchor-a" } },
            signal ?? new AbortController().signal,
          );
        },
      };

      const [resA, resB] = await Promise.all([
        syncExecutionAssetsV2OverMesh({ client: barrierClient as never, verifier, source: source1 }),
        syncExecutionAssetsV2OverMesh({ client: barrierClient as never, verifier, source: source1 }),
      ]);
      expect(resA.inventory.assetVersions.skillsRev).toBe(2);
      expect(resB.inventory.assetVersions.skillsRev).toBe(2);

      // Post-commit duplicate commit-assets-v2 on a fresh handler instance (empty in-memory verifiedSnapshots)
      handler = makeHandler();
      const replayCommitBytes = await handler(
        encodeJsonPayload({
          v: 2,
          method: "commit-assets-v2",
          snapshotDigest: snap1.digest,
        }),
        { peer: { deviceId: "anchor-a" } },
        new AbortController().signal,
      );
      const replayCap = decodeJsonPayload(replayCommitBytes) as {
        inventory: { assetVersions: { skillsRev: number } };
      };
      expect(replayCap.inventory.assetVersions.skillsRev).toBe(2);

      // Advance to revision 3, then ensure stale revision 2 commit and unauthorized commit fail closed
      const snap2 = createSignedExecutionAssetSnapshotV2(
        {
          snapshotRevision: 3,
          skillCatalogRevision: 2,
          skills: [
            {
              ...entry1Base,
              revision: 2,
              digest: protocolDigest("SkillCatalogEntry", 2, { ...entry1Base, revision: 2 }),
            },
          ],
          rubrics: [],
          promptAssets: [],
          generatedAt: NOW,
        },
        signer,
      );
      await anchorCache.installV2(snap2);
      const source2 = (await anchorCache.syncSourceV2())!;
      const directClient = {
        request: (_svc: string, payload: Uint8Array, sig?: AbortSignal) =>
          handler(payload, { peer: { deviceId: "anchor-a" } }, sig ?? new AbortController().signal),
      };
      // Stage snap1 in memory first, then publish snap2, then try to commit stale snap1 -> rejected
      await handler(
        encodeJsonPayload({
          v: 2,
          method: "reconcile-assets-v2",
          snapshot: snap1,
        }),
        { peer: { deviceId: "anchor-a" } },
        new AbortController().signal,
      );
      const res2 = await syncExecutionAssetsV2OverMesh({
        client: directClient as never,
        verifier,
        source: source2,
      });
      expect(res2.inventory.assetVersions.skillsRev).toBe(3);

      await expect(
        handler(
          encodeJsonPayload({
            v: 2,
            method: "commit-assets-v2",
            snapshotDigest: snap1.digest,
          }),
          { peer: { deviceId: "anchor-a" } },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/cannot be (?:rewritten or )?rolled back|not staged/iu);

      peerAuthorized = false;
      await expect(
        handler(
          encodeJsonPayload({
            v: 2,
            method: "commit-assets-v2",
            snapshotDigest: snap2.digest,
          }),
          { peer: { deviceId: "anchor-a" } },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/Authenticated mesh peer cannot synchronize|Peer authorization revoked/u);
    },
  );
});
