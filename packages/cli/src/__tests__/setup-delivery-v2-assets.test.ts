import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileArtifactStore } from "@zhixing-ai/core/authority";
import type { SecretRef, SecretStorePort } from "@zhixing-ai/core/contracts";
import {
  createSignedCapabilityDescriptor,
  createSignedExecutorVersionInventory,
  protocolDigest,
} from "@zhixing-ai/core/protocol";
import { encodeSkillPackageArchive } from "@zhixing-ai/core/skills/archive";
import { skillNameToId } from "@zhixing-ai/core/skills/id";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing-ai/mesh/device-identity";
import { MeshRequestChannel } from "@zhixing-ai/mesh/request-channel";
import { connectAuthenticatedMesh, createAuthenticatedMeshServer } from "@zhixing-ai/mesh/handshake";
import { HandshakeReplayWindow } from "@zhixing-ai/mesh/replay-window";
import { MeshServiceRegistry } from "@zhixing-ai/mesh/service-registry";
import { createTempDir } from "@zhixing-ai/test-utils";
import {
  MeshExecutionSnapshotClient,
  registerExecutionSnapshotMeshService,
} from "../serve/execution-snapshot-mesh.js";
import { createExecutionAssetV2SyncHandler } from "../serve/execution-snapshot-v2-sync.js";
import { FileExecutionAssetCache } from "../serve/execution-asset-cache.js";
import { setupAuthorityRuntime } from "../setup-delivery.js";

const NOW = "2026-11-27T08:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string) {
    this.values.set(`${ref.kind}/${ref.bindingId}`, value);
  }
  async get(ref: SecretRef) {
    return this.values.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const key = `${ref.kind}/${ref.bindingId}`;
    const existing = this.values.get(key);
    if (existing !== undefined) return existing;
    const created = create();
    this.values.set(key, created);
    return created;
  }
  async delete(ref: SecretRef) {
    this.values.delete(`${ref.kind}/${ref.bindingId}`);
  }
  async list(prefix: string) {
    return [...this.values.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => {
        const idx = k.indexOf("/");
        return { kind: k.slice(0, idx) as SecretRef["kind"], bindingId: k.slice(idx + 1) };
      });
  }
  async unlockState() {
    return "unlocked" as const;
  }
}

vi.setConfig({ testTimeout: 30_000 });

describe("setupAuthorityRuntime v2 globalState routing, live asset refresh & lazy v1 bundle", () => {
  it(
    "routes skill-catalog-v2/get-v2, auto-publishes after commits, and skips lazy v1 bundle on v2->v2 sync",
    { timeout: 30_000 },
    async () => {
    const anchorHome = await createTempDir("setup-v2-anchor");
    const execHome = await createTempDir("setup-v2-exec");
    cleanups.push(async () => {
      await rm(anchorHome, { recursive: true, force: true });
      await rm(execHome, { recursive: true, force: true });
    });

    const anchorKey = await DeviceKey.generate();
    const execKey = await DeviceKey.generate();
    const anchorIdent = enrollDeviceIdentity(anchorKey, {
      displayName: "anchor-a",
      platform: "windows",
      enrolledAt: NOW,
    });
    const execIdent = enrollDeviceIdentity(execKey, {
      displayName: "exec-b",
      platform: "windows",
      enrolledAt: NOW,
    });

    const anchor = await setupAuthorityRuntime({
      zhixingHome: anchorHome,
      secretStore: new MemorySecretStore(),
      deviceKey: anchorKey,
      trustedIdentities: [anchorIdent, execIdent],
      authorizedDeviceIds: [anchorIdent.deviceId, execIdent.deviceId],
      executorReadiness: {
        tools: ["read", "runtime_inspect", "skill_read"],
        mcpServers: [],
        credentialBindings: [],
        deviceScopedCredentialBindingIds: [],
        credentialGeneration: null,
      },
      clock: () => NOW,
    });
    cleanups.push(() => anchor.stopStorageMaintenance());

    // Startup immediately produces non-empty bundle & syncSourceV2 even on empty catalog
    expect(await anchor.currentExecutionAssetBundle()).toBeDefined();
    expect(await anchor.currentExecutionAssetSyncV2?.()).toBeDefined();
    const emptyV2 = await anchor.globalState!.read(
      { kind: "skill-catalog-v2", includeDisabled: true },
      {
        principal: { kind: "host", component: "test" },
        requestId: "r-empty-v2",
        deadlineAt: "2026-11-27T09:00:00.000Z",
        authority: { domain: "global", anchorEpoch: anchor.anchorEpoch },
      },
    );
    expect(emptyV2).toMatchObject({ kind: "skill-catalog-v2", catalogRevision: 0, entries: [] });

    // Commit create -> attachment-only edit -> visibility change -> disable via real anchor.globalState
    const pkgA = encodeSkillPackageArchive([
      { path: "SKILL.md", content: "---\nname: live-skill\ndescription: v1\n---\nBody\n" },
      { path: "notes/doc.md", content: "attachment-v1" },
    ]);
    const pkgB = encodeSkillPackageArchive([
      { path: "SKILL.md", content: "---\nname: live-skill\ndescription: v1\n---\nBody\n" },
      { path: "notes/doc.md", content: "attachment-v2" },
    ]);
    const contentRef = await anchor.artifacts.put(
      Buffer.from("---\nname: live-skill\ndescription: v1\n---\nBody\n", "utf8"),
    );
    const pkgRefA = await anchor.artifacts.put(pkgA.bytes);
    const pkgRefB = await anchor.artifacts.put(pkgB.bytes);
    const ctx = (reqId: string) => ({
      principal: { kind: "host" as const, component: "test" },
      requestId: reqId,
      deadlineAt: "2026-11-27T09:00:00.000Z",
      authority: { domain: "global" as const, anchorEpoch: anchor.anchorEpoch },
    });
    const skillId = skillNameToId("live-skill");

    await anchor.globalState!.mutate(
      {
        kind: "skill-create-v2",
        mode: "work",
        record: {
          name: "live-skill",
          description: "v1",
          content: contentRef,
          packageRef: pkgRefA,
          visibility: { modelAutoIndex: true, userSlashCommand: true },
        },
      },
      ctx("mut-1"),
    );
    let syncV2 = await anchor.currentExecutionAssetSyncV2?.();
    expect(syncV2?.v2Snapshot.skillCatalogRevision).toBe(1);
    expect(syncV2?.v2Snapshot.skills[0]?.id).toBe(skillId);
    expect(syncV2?.v2Snapshot.skills[0]?.packageRef).toEqual(pkgRefA);

    await anchor.globalState!.mutate(
      {
        kind: "skill-update-v2",
        skillId,
        mode: "work",
        expectedRevision: 1,
        record: {
          name: "live-skill",
          description: "v1",
          content: contentRef,
          packageRef: pkgRefB,
          visibility: { modelAutoIndex: true, userSlashCommand: true },
        },
      },
      ctx("mut-2"),
    );
    syncV2 = await anchor.currentExecutionAssetSyncV2?.();
    expect(syncV2?.v2Snapshot.skillCatalogRevision).toBe(2);
    expect(syncV2?.v2Snapshot.skills[0]?.packageRef).toEqual(pkgRefB);

    await anchor.globalState!.mutate(
      {
        kind: "skill-set-visibility",
        skillId,
        expectedRevision: 2,
        visibility: { modelAutoIndex: false, userSlashCommand: true },
      },
      ctx("mut-3"),
    );
    const v1AfterVis = await anchor.currentExecutionAssetBundle();
    expect(v1AfterVis?.snapshot.skillCatalogRevision).toBe(3);
    expect(v1AfterVis?.snapshot.skills[0]?.disabled).toBe(true);

    await anchor.globalState!.mutate(
      { kind: "skill-set-state", skillId, expectedRevision: 3, patch: { disabled: true } },
      ctx("mut-4"),
    );
    syncV2 = await anchor.currentExecutionAssetSyncV2?.();
    expect(syncV2?.v2Snapshot.skillCatalogRevision).toBe(4);
    expect(syncV2?.v2Snapshot.skills[0]?.disabled).toBe(true);

    // Pair over real TLS Mesh and assert lazy v1 bundle() is called 0 times during v2 -> v2 sync
    const execArtifacts = new FileArtifactStore(path.join(execHome, "artifacts"));
    const execCache = new FileExecutionAssetCache(
      path.join(execHome, "distributed-runtime", "execution-assets.json"),
      execArtifacts,
      anchor.verifier,
    );
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
          evidenceCapabilities: ["artifact"],
          at: NOW,
        },
        execKey,
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
        execKey,
      ),
    };
    const verifier = {
      verify: anchor.verifier.verify.bind(anchor.verifier),
    };
    const regB = new MeshServiceRegistry();
    const v2Handler = createExecutionAssetV2SyncHandler({
      zhixingHome: execHome,
      artifacts: execArtifacts,
      executionAssets: execCache,
      verifier,
      refreshCapability: async () => cap,
    });
    registerExecutionSnapshotMeshService(
      regB,
      {
        currentCapability: async () => cap,
        installPermission: async () => cap,
        installAssets: async () => cap,
      },
      () => true,
      verifier,
      v2Handler,
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

    const spy = vi.spyOn(anchor.executionAssetCatalog as FileExecutionAssetCache, "bundle");
    const client = new MeshExecutionSnapshotClient(chan, verifier);
    await anchor.synchronizeExecutorBaseline!({
      executorId: cap.descriptor.executorId,
      synchronizePermission: (perm, lazyBundle, v2Src) =>
        client.installPermission(perm, lazyBundle, v2Src),
    });
    expect(spy).toHaveBeenCalledTimes(0);

    const execReadV2 = await execCache.read({ kind: "skill-get-v2", skillId });
    expect(execReadV2.kind === "skill-get-v2" && execReadV2.entry?.packageRef).toEqual(pkgRefB);
    expect(execReadV2.kind === "skill-get-v2" && execReadV2.catalogRevision).toBe(4);
    expect(execReadV2.kind === "skill-get-v2" && execReadV2.entry?.disabled).toBe(true);
    expect(
      protocolDigest("VerifyEmpty", 1, { ok: true }),
    ).toMatch(/^sha256:/);
  },
  );

  it(
    "R2-1a & R2-1b: preserves committed skill mutations when derived snapshot refresh fails transiently, catches up on sync, and reads 0 body bytes on unchanged prepareConversationAssignment",
    { timeout: 30_000 },
    async () => {
      const anchorHome = await createTempDir("setup-v2-r2-1b");
      cleanups.push(async () => {
        await rm(anchorHome, { recursive: true, force: true });
      });

      const anchorKey = await DeviceKey.generate();
      const remoteKey = await DeviceKey.generate();
      const anchorIdent = enrollDeviceIdentity(anchorKey, {
        displayName: "anchor-main",
        platform: "windows",
        enrolledAt: NOW,
      });
      const remoteIdent = enrollDeviceIdentity(remoteKey, {
        displayName: "remote-exec",
        platform: "windows",
        enrolledAt: NOW,
      });

      const anchor = await setupAuthorityRuntime({
        zhixingHome: anchorHome,
        secretStore: new MemorySecretStore(),
        deviceKey: anchorKey,
        trustedIdentities: [anchorIdent, remoteIdent],
        authorizedDeviceIds: [anchorIdent.deviceId, remoteIdent.deviceId],
        executorReadiness: {
          tools: ["read", "runtime_inspect", "skill_read"],
          mcpServers: [],
          credentialBindings: [],
          deviceScopedCredentialBindingIds: [],
          credentialGeneration: null,
        },
        clock: () => NOW,
      });
      cleanups.push(() => anchor.stopStorageMaintenance());

      const body = "---\nname: resilient-skill\ndescription: v1\n---\nBody content\n";
      const contentRef = await anchor.artifacts.put(Buffer.from(body, "utf8"));
      const catalogCache = anchor.executionAssetCatalog as FileExecutionAssetCache;

      // 1) Inject transient failure into derived publish during skill mutation
      const publishSpy = vi.spyOn(catalogCache, "publishFromAuthority");
      publishSpy.mockRejectedValueOnce(new Error("transient EIO during derived snapshot publish"));

      const ctx = {
        principal: { kind: "host" as const, component: "test" },
        requestId: "mut-transient-eio",
        deadlineAt: "2026-11-27T09:00:00.000Z",
        authority: { domain: "global" as const, anchorEpoch: anchor.anchorEpoch },
      };
      // Mutate must resolve with its authoritative committed receipt despite derived failure
      await expect(
        anchor.globalState!.mutate(
          {
            kind: "skill-create-v2",
            mode: "work",
            record: {
              name: "resilient-skill",
              description: "v1",
              content: contentRef,
              visibility: { modelAutoIndex: true, userSlashCommand: true },
            },
          },
          ctx,
        ),
      ).resolves.toMatchObject({ revision: 1, catalogRevision: 1 });

      // Transient error cleared: next sync catch-up publishes the committed catalogRevision
      const caughtUp = await anchor.currentExecutionAssetSyncV2!();
      expect(caughtUp?.v2Snapshot.skillCatalogRevision).toBe(1);
      expect(caughtUp?.v2Snapshot.skills[0]?.id).toBe(skillNameToId("resilient-skill"));

      // 2) On unchanged catalog: pure-local prepareConversationAssignment skips publish/syncSourceV2,
      // and remote-target prepareConversationAssignment performs 0 artifact body reads.
      const getSpy = vi.spyOn(anchor.artifacts, "get");
      const refForDigestSpy = vi.spyOn(anchor.artifacts, "referenceForDigest");
      const syncSourceSpy = vi.spyOn(catalogCache, "syncSourceV2");
      publishSpy.mockClear();
      getSpy.mockClear();
      refForDigestSpy.mockClear();
      syncSourceSpy.mockClear();

      await anchor.prepareConversationAssignment({
        conversationId: "conv-local-only",
        executionProfile: { tools: ["read"], mcpServers: [], providerIds: [] },
        permissionRules: [],
      });
      // On pure-local prepareConversationAssignment: skips syncSourceV2 entirely and reads 0 body bytes
      expect(syncSourceSpy).toHaveBeenCalledTimes(0);
      expect(getSpy).toHaveBeenCalledTimes(0);
      expect(refForDigestSpy).toHaveBeenCalledTimes(0);

      const remoteCap = {
        descriptor: createSignedCapabilityDescriptor(
          {
            executorId: `exec:${remoteIdent.deviceId}`,
            revision: 1,
            protocolVersion: "2",
            workspaces: [],
            tools: ["read", "runtime_inspect", "skill_read"],
            mcpServers: [],
            credentialBindings: [],
            evidenceCapabilities: ["artifact"],
            at: NOW,
          },
          remoteKey,
        ),
        inventory: createSignedExecutorVersionInventory(
          {
            executorId: `exec:${remoteIdent.deviceId}`,
            inventoryRevision: 1,
            capabilityRevision: 1,
            configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
            assetVersions: { skillsRev: 2, rubricsRev: 2, promptAssetsRev: 2 },
            permissionSnapshotHighWater: 0,
            credentialBindingRevisions: [],
            at: NOW,
          },
          remoteKey,
        ),
      };

      await anchor.prepareConversationAssignment({
        conversationId: "conv-with-remote",
        executionProfile: { tools: ["read"], mcpServers: [], providerIds: [] },
        permissionRules: [],
        recentExecutorId: remoteCap.descriptor.executorId,
        targets: [
          {
            executorId: remoteCap.descriptor.executorId,
            deviceId: remoteIdent.deviceId,
            synchronizePermission: async (_perm, _bundle, syncV2) => {
              expect(syncV2?.v2Snapshot.skillCatalogRevision).toBe(1);
              return remoteCap;
            },
          },
        ],
      });
      expect(getSpy).toHaveBeenCalledTimes(0);
      expect(refForDigestSpy).toHaveBeenCalledTimes(0);
    },
  );
});
