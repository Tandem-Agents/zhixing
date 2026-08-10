/**
 * setup-delivery 回归测试
 *
 * 专注于 TD#1 修复：channel-not-found 返回 retryable:true 而非 false。
 * Daemon 长时运行期间，channel adapter 重连过渡窗口里查不到，必须重试，
 * 否则投递会被 Outbox 静默丢弃。
 *
 * 直接验证源码的最小方式：读文件查 retryable:true 字面量 + 确保 setupDelivery
 * 能正常组装栈。深度 Outbox 重试行为由 core 包自己的测试覆盖。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthorityDeliveryPipeline,
  ChannelRegistry,
  MemoryStore,
  OutboxRegistry,
  type PermissionRule,
} from "@zhixing/core";
import { SurfaceAssetCoordinator } from "@zhixing/core/authority";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import {
  createExecutionManifest,
  matchManifest,
  protocolDigest,
  validateTrustRuleSnapshot,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import {
  INSTALLED_AUTHORITY_GENERATION_PARTICIPANTS,
  setupAuthorityRuntime,
  setupDelivery,
  type DeliveryStack,
} from "../setup-delivery.js";
import type { InstalledAuthorityGeneration } from "../serve/planned-anchor-transfer.js";
import {
  FileExecutionSnapshotVersionStore,
  FileTrustRuleSnapshotCatalog,
} from "../executor-snapshot-version-store.js";
import { createDeviceCapacityRuntime } from "../serve/device-capacity-runtime.js";
import { StartupRollback } from "../serve/startup-rollback.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const TEST_EXECUTOR_READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

const EMPTY_EXECUTION_PROFILE = {
  tools: [] as string[],
  mcpServers: [] as string[],
  providerIds: [] as string[],
};

function prepareAuthority(
  authority: Awaited<ReturnType<typeof setupAuthorityRuntime>>,
  input: {
    readonly executionProfile?: typeof EMPTY_EXECUTION_PROFILE;
    readonly permissionRules?: readonly PermissionRule[];
  } = {},
) {
  return authority.prepareConversationAssignment({
    conversationId: "test-conversation",
    executionProfile: input.executionProfile ?? EMPTY_EXECUTION_PROFILE,
    permissionRules: input.permissionRules ?? [],
  });
}

vi.setConfig({ testTimeout: 30_000 });

describe("setupDelivery — TD#1 channel-not-found retryable", () => {
  let home: string;
  let stack: DeliveryStack | null = null;

  beforeEach(async () => {
    home = await createTempDir("delivery");
  });

  afterEach(async () => {
    if (stack) {
      await stack.stop().catch(() => {});
      stack = null;
    }
  });

  it("source code: channel-not-found path uses retryable:true (TD#1 regression guard)", async () => {
    // 直接读源码断言——防止未来误改回 retryable:false
    const srcPath = resolve(__dirname, "..", "setup-delivery.ts");
    const src = await readFile(srcPath, "utf-8");

    // 查找 "Channel not found" 周围的 retryable 字段
    const idx = src.indexOf("Channel not found");
    expect(idx).toBeGreaterThan(0);
    const chunk = src.slice(idx, idx + 300);
    expect(chunk).toMatch(/retryable:\s*true/);
    expect(chunk).not.toMatch(/retryable:\s*false/);
  });

  it("assembles a valid DeliveryStack with an empty channel registry", async () => {
    const channels = new ChannelRegistry();
    const authorityRuntime = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
    stack = await setupDelivery({
      channels,
      zhixingHome: home,
      authorityRuntime,
      logger: quietLogger,
    });
    expect(stack).toBeDefined();
    expect(stack.authorityDelivery).toBeDefined();
    expect(stack.outboxRegistry).toBeDefined();
    expect(typeof stack.stop).toBe("function");
  });

  it("takes over legacy memory from the explicitly configured authority home", async () => {
    const legacy = new MemoryStore(resolve(home, "me"));
    await legacy.save({
      category: "person",
      id: "legacy-person",
      meta: { name: "Legacy", relation: "friend" },
      content: "remembered before authority cutover",
    });

    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
    try {
      const result = await authority.globalState!.read(
        {
          kind: "memory-list",
          scope: { kind: "personal" },
          domain: "people",
        },
        {
          principal: { kind: "host", component: "setup-memory-cutover-test" },
          requestId: "setup-memory-cutover-read",
          deadlineAt: "2099-01-01T00:00:00.000Z",
          authority: { domain: "global", anchorEpoch: authority.anchorEpoch },
        },
      );
      expect(result).toMatchObject({
        kind: "memory-list",
        entries: [{ id: "legacy-person", content: "remembered before authority cutover" }],
      });
    } finally {
      await authority.startupCleanup.run();
    }
  });

  it("freezes an explicit workspace revision and preflights it before local execution", async () => {
    const capacity = createDeviceCapacityRuntime(resolve(home, "capacity"));
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      executorReadiness: TEST_EXECUTOR_READINESS,
      deviceCapacity: capacity.arbiter,
      storageMaintenance: capacity.storage,
    });
    const migration = authority.workspaceBindingMigration;
    expect(migration).toBeDefined();
    const abort = new AbortController().signal;
    const workspacePath = resolve(home, "workspace-a");
    const binding = await migration!.importLegacy(
      {
        migrationId: "test-workspace-selection",
        sourceSnapshotToken: "snapshot-a",
        displayName: "Workspace A",
        absolutePath: workspacePath,
      },
      abort,
    );
    await migration!.activateLegacy(
      {
        migrationId: "test-workspace-selection",
        sourceSnapshotToken: "snapshot-a",
      },
      abort,
    );

    const prepared = await authority.prepareConversationAssignment({
      conversationId: "main",
      executionProfile: EMPTY_EXECUTION_PROFILE,
      permissionRules: [],
      environment: {
        workspace: {
          deviceId: authority.deviceId,
          bindingRef: binding.bindingRef,
        },
      },
    });
    expect(prepared.environment.workspace).toEqual({
      deviceId: authority.deviceId,
      bindingRef: binding.bindingRef,
      workspaceBindingRevision: binding.workspaceBindingRevision,
    });
    const createdScene = await authority.globalState!.mutate(
      {
        kind: "workscene-create",
        name: "Workspace Scene",
        workspace: {
          deviceId: authority.deviceId,
          bindingRef: binding.bindingRef,
        },
      },
      {
        principal: { kind: "host", component: "setup-delivery-test" },
        requestId: "create-workspace-scene",
        authority: { domain: "global", anchorEpoch: authority.anchorEpoch },
        deadlineAt: "2099-01-01T00:00:00.000Z",
      },
    );
    if (createdScene.kind !== "workscene-applied") {
      throw new Error("workscene creation did not return an applied scene");
    }
    await expect(
      authority.prepareConversationAssignment({
        conversationId: `ws:${createdScene.scene.id}:conv_main`,
        executionProfile: EMPTY_EXECUTION_PROFILE,
        permissionRules: [],
      }),
    ).resolves.toMatchObject({
      environment: {
        workspace: {
          deviceId: authority.deviceId,
          bindingRef: binding.bindingRef,
          workspaceBindingRevision: binding.workspaceBindingRevision,
        },
      },
    });
    const manifest = createExecutionManifest({
      baseRef: {
        execution: "conversation",
        conversationId: "main",
        baseRevision: 0,
      },
      protocolVersion: prepared.policy.manifestCapabilities.protocolVersion,
      requires: {
        ...prepared.policy.manifestRequires,
        permissionSnapshotVersion:
          prepared.policy.permissionSnapshot.snapshotVersion,
      },
      tools: [...prepared.policy.manifestCapabilities.tools],
      mcpServers: [...prepared.policy.manifestCapabilities.mcpServers],
      environment: prepared.environment,
      credentialBindings: [
        ...prepared.policy.manifestCapabilities.credentialBindings,
      ],
    });
    await expect(
      authority.preflightLocalConversationEnvironment(manifest),
    ).resolves.toEqual({ workspaceRoot: workspacePath });
    await expect(authority.environment!.probePath(workspacePath)).resolves.toBe(
      "directory",
    );
    const resolveWorkspace = vi.spyOn(
      authority.environment!,
      "resolveWorkspace",
    );
    const firstPreflight =
      authority.preflightLocalConversationEnvironment(manifest, "assignment-a");
    const claimedPreflight =
      authority.takeLocalConversationEnvironmentPreflight(
        manifest,
        "assignment-a",
      );
    await expect(Promise.all([firstPreflight, claimedPreflight])).resolves.toEqual([
      { workspaceRoot: workspacePath },
      { workspaceRoot: workspacePath },
    ]);
    await expect(
      authority.preflightLocalConversationEnvironment(manifest, "assignment-a"),
    ).resolves.toEqual({ workspaceRoot: workspacePath });
    expect(resolveWorkspace).toHaveBeenCalledTimes(1);
    authority.releaseLocalConversationEnvironmentPreflight(
      manifest,
      "assignment-a",
    );
    await expect(
      authority.preflightLocalConversationEnvironment(manifest, "assignment-a"),
    ).resolves.toEqual({ workspaceRoot: workspacePath });
    expect(resolveWorkspace).toHaveBeenCalledTimes(2);

    const staleManifest = {
      ...manifest,
      environment: {
        ...manifest.environment,
        workspace: {
          ...manifest.environment.workspace!,
          workspaceBindingRevision:
            manifest.environment.workspace!.workspaceBindingRevision + 1,
        },
      },
    };
    await expect(
      authority.preflightLocalConversationEnvironment(staleManifest),
    ).resolves.toMatchObject({
      workspaceRoot: null,
      error: { code: "revision-conflict", retryable: true },
    });

    const unbound = await authority.prepareConversationAssignment({
      conversationId: "main",
      executionProfile: EMPTY_EXECUTION_PROFILE,
      permissionRules: [],
    });
    expect(unbound.environment.workspace).toBeUndefined();
    await authority.stopStorageMaintenance();
  }, 120_000);

  it("rolls back every partially acquired delivery resource when later startup fails", async () => {
    const order: string[] = [];
    const authorityPrepare = vi
      .spyOn(AuthorityDeliveryPipeline.prototype, "prepare")
      .mockRejectedValueOnce(new Error("authority delivery failed"));
    const authorityStop = vi
      .spyOn(AuthorityDeliveryPipeline.prototype, "stop")
      .mockImplementationOnce(async () => {
        order.push("authority");
      });
    const outboxStop = vi
      .spyOn(OutboxRegistry.prototype, "dispose")
      .mockImplementationOnce(async () => {
        order.push("outbox");
      });
    try {
      const authorityRuntime = await setupAuthorityRuntime({
        zhixingHome: home,
        secretStore: new MemorySecretStore(),
        executorReadiness: TEST_EXECUTOR_READINESS,
      });
      await expect(
        setupDelivery({
          channels: new ChannelRegistry(),
          zhixingHome: home,
          authorityRuntime,
          logger: quietLogger,
          startupRollback: new StartupRollback(),
        }),
      ).rejects.toThrow("authority delivery failed");

      expect(order).toEqual(["authority", "outbox"]);
      expect(authorityStop).toHaveBeenCalledTimes(1);
      expect(outboxStop).toHaveBeenCalledTimes(1);
    } finally {
      authorityPrepare.mockRestore();
      authorityStop.mockRestore();
      outboxStop.mockRestore();
    }
  });

  it("stops maintenance exactly once when startup fails after recovery", async () => {
    // U23-67:恢复已启动维护资源之后、函数返回之前失败——清理所有权必须在任何
    // 资源取得前就建立,否则这个窗口里没有人持有停止句柄。
    const openCatalog = vi
      .spyOn(FileTrustRuleSnapshotCatalog, "open")
      .mockRejectedValueOnce(new Error("trust catalog failed"));
    const stopAssets = vi.spyOn(
      SurfaceAssetCoordinator.prototype,
      "stopStorageMaintenance",
    );
    try {
      const rollback = new StartupRollback();
      await expect(
        setupAuthorityRuntime({
          zhixingHome: home,
          secretStore: new MemorySecretStore(),
          executorReadiness: TEST_EXECUTOR_READINESS,
          startupRollback: rollback,
        }),
      ).rejects.toThrow("trust catalog failed");
      // 内部失败即执行 handle:恢复期启动的维护义务恰一次停止。
      expect(stopAssets).toHaveBeenCalledTimes(1);
      // 外层启动失败再走同一回滚事务,复用同一幂等 handle,不重复停止。
      await rollback.rollback();
      expect(stopAssets).toHaveBeenCalledTimes(1);
    } finally {
      openCatalog.mockRestore();
      stopAssets.mockRestore();
    }
  });

  it("stops maintenance on failure even without an ambient rollback transaction", async () => {
    // 未注入外层事务的独立调用者(测试、嵌入场景)同样不得泄漏维护任务。
    const openCatalog = vi
      .spyOn(FileTrustRuleSnapshotCatalog, "open")
      .mockRejectedValueOnce(new Error("trust catalog failed"));
    const stopAssets = vi.spyOn(
      SurfaceAssetCoordinator.prototype,
      "stopStorageMaintenance",
    );
    try {
      await expect(
        setupAuthorityRuntime({
          zhixingHome: home,
          secretStore: new MemorySecretStore(),
          executorReadiness: TEST_EXECUTOR_READINESS,
        }),
      ).rejects.toThrow("trust catalog failed");
      expect(stopAssets).toHaveBeenCalledTimes(1);
    } finally {
      openCatalog.mockRestore();
      stopAssets.mockRestore();
    }
  });

  it("shares one idempotent cleanup handle between rollback and shutdown", async () => {
    // 成功启动后:外层启动回滚与正常停机复用运行时返回的同一 handle,资源只释放一次。
    const stopAssets = vi.spyOn(
      SurfaceAssetCoordinator.prototype,
      "stopStorageMaintenance",
    );
    try {
      const rollback = new StartupRollback();
      const runtime = await setupAuthorityRuntime({
        zhixingHome: home,
        secretStore: new MemorySecretStore(),
        executorReadiness: TEST_EXECUTOR_READINESS,
        startupRollback: rollback,
      });
      expect(runtime.startupCleanup.name).toBe(
        "authorityRuntime.stopStorageMaintenance",
      );
      // 模拟外层后续接入面失败触发整链回滚。
      await rollback.rollback();
      expect(stopAssets).toHaveBeenCalledTimes(1);
      // 正常停机链再执行同一 handle:缓存结果,不再第二次停止。
      await runtime.startupCleanup.run();
      expect(stopAssets).toHaveBeenCalledTimes(1);
    } finally {
      stopAssets.mockRestore();
    }
  });

  it("publishes one durable monotonic execution snapshot revision", async () => {
    const secretStore = new MemorySecretStore();
    const first = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
      configurationSnapshot: { executableVersion: "1", profile: "main" },
    });
    const firstPrepared = await prepareAuthority(first);
    const replayed = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
      configurationSnapshot: { executableVersion: "1", profile: "main" },
    });
    const replayedPrepared = await prepareAuthority(replayed);
    const advanced = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
      configurationSnapshot: { executableVersion: "2", profile: "main" },
    });
    const advancedPrepared = await prepareAuthority(advanced);

    expect(first.executorCapabilities.snapshotFor(first.executorId)?.inventory.inventoryRevision)
      .toBe(1);
    expect(replayed.executorCapabilities.snapshotFor(replayed.executorId)?.inventory.inventoryRevision)
      .toBe(1);
    const advancedInventory = advanced.executorCapabilities
      .snapshotFor(advanced.executorId)?.inventory;
    expect(advancedInventory?.inventoryRevision).toBe(2);
    expect(new Set([
      ...Object.values(advancedInventory!.configVersions),
      ...Object.values(advancedInventory!.assetVersions),
    ])).toEqual(new Set([2]));
    expect(replayedPrepared.policy.permissionSnapshot.digest).toBe(
      firstPrepared.policy.permissionSnapshot.digest,
    );
    expect(advancedPrepared.policy.permissionSnapshot.snapshotVersion).toBe(1);
    expect(advancedInventory?.permissionSnapshotHighWater).toBe(1);
    expect(advanced.permissionSnapshotFor(
      firstPrepared.policy.permissionSnapshot.digest,
    )).toEqual(firstPrepared.policy.permissionSnapshot);
    expect(() => validateTrustRuleSnapshot(
      advancedPrepared.policy.permissionSnapshot,
      advanced.verifier,
    )).not.toThrow();
  });

  it("keeps device generations stable while retaining interleaved permission snapshots", async () => {
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
    const makeRule = (id: string): PermissionRule => ({
      id,
      pattern: { tool: "bash", argument: id },
      decision: "allow",
      scope: "global",
      createdAt: 1,
      lastMatchedAt: 0,
      matchCount: 0,
    });
    const first = await prepareAuthority(authority, {
      permissionRules: [makeRule("permission-a")],
    });
    const second = await prepareAuthority(authority, {
      permissionRules: [makeRule("permission-b")],
    });
    const current = authority.executorCapabilities.snapshotFor(authority.executorId)!;

    expect(first.policy.permissionSnapshot.snapshotVersion).toBe(1);
    expect(second.policy.permissionSnapshot.snapshotVersion).toBe(2);
    expect(current.descriptor.revision).toBe(1);
    expect(current.inventory.inventoryRevision).toBe(2);
    expect(current.inventory.permissionSnapshotHighWater).toBe(2);
    expect(new Set([
      ...Object.values(current.inventory.configVersions),
      ...Object.values(current.inventory.assetVersions),
    ])).toEqual(new Set([1]));
    expect(authority.permissionSnapshotFor(first.policy.permissionSnapshot.digest))
      .toEqual(first.policy.permissionSnapshot);

    const firstManifest = createExecutionManifest({
      baseRef: {
        execution: "conversation",
        conversationId: "conversation-permission-a",
        baseRevision: 0,
      },
      protocolVersion: first.policy.manifestCapabilities.protocolVersion,
      requires: {
        ...first.policy.manifestRequires,
        permissionSnapshotVersion: first.policy.permissionSnapshot.snapshotVersion,
      },
      tools: [...first.policy.manifestCapabilities.tools],
      mcpServers: [...first.policy.manifestCapabilities.mcpServers],
      environment: {},
      credentialBindings: [...first.policy.manifestCapabilities.credentialBindings],
    });
    expect(matchManifest(firstManifest, current.descriptor, current.inventory))
      .toEqual({ ok: true });
  });

  it("publishes the real non-secret executor readiness catalog", async () => {
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      executorReadiness: {
        tools: ["Read", "Write"],
        mcpServers: ["local-mcp"],
        credentialBindings: [{
          bindingId: "credential-provider-main",
          service: "provider-main",
          verification: "user-alias",
        }],
        deviceScopedCredentialBindingIds: ["credential-provider-main"],
        credentialGeneration: "credential-generation-a",
      },
    });
    const prepared = await prepareAuthority(authority, {
      executionProfile: {
        tools: ["Read"],
        mcpServers: ["local-mcp"],
        providerIds: ["main"],
      },
    });
    const snapshot = authority.executorCapabilities.snapshotFor(authority.executorId);
    const expectedBindingId = `user-alias:${authority.deviceId}:credential-provider-main`;
    expect(snapshot?.descriptor).toMatchObject({
      tools: ["Read", "Write"],
      mcpServers: ["local-mcp"],
      credentialBindings: [{
        bindingId: expectedBindingId,
        service: "provider-main",
        revision: 1,
      }],
    });
    expect(prepared.policy.manifestCapabilities)
      .toMatchObject({
        tools: ["Read"],
        mcpServers: ["local-mcp"],
        credentialBindings: [{
          bindingId: expectedBindingId,
          service: "provider-main",
          revision: 1,
        }],
      });
  });

  it("does not infer user-alias credential equivalence across devices", async () => {
    const peerHome = await createTempDir("zhixing-credential-alias-peer-");
    try {
      const readiness = {
        tools: [] as string[],
        mcpServers: [] as string[],
        credentialBindings: [{
          bindingId: "credential-provider-main",
          service: "provider-main",
          verification: "user-alias" as const,
        }],
        deviceScopedCredentialBindingIds: ["credential-provider-main"],
        credentialGeneration: "credential-generation-a",
      };
      const local = await setupAuthorityRuntime({
        zhixingHome: home,
        secretStore: new MemorySecretStore(),
        executorReadiness: readiness,
      });
      const peer = await setupAuthorityRuntime({
        zhixingHome: peerHome,
        secretStore: new MemorySecretStore(),
        executorReadiness: readiness,
      });
      const executionProfile = {
        ...EMPTY_EXECUTION_PROFILE,
        providerIds: ["main"],
      };
      await prepareAuthority(local, { executionProfile });
      await prepareAuthority(peer, { executionProfile });
      const localBinding = local.executorCapabilities.snapshotFor(local.executorId)
        ?.descriptor.credentialBindings[0];
      const peerBinding = peer.executorCapabilities.snapshotFor(peer.executorId)
        ?.descriptor.credentialBindings[0];
      expect(localBinding?.bindingId).toBe(
        `user-alias:${local.deviceId}:credential-provider-main`,
      );
      expect(peerBinding?.bindingId).toBe(
        `user-alias:${peer.deviceId}:credential-provider-main`,
      );
      expect(peerBinding?.bindingId).not.toBe(localBinding?.bindingId);
    } finally {
      await rm(peerHome, { force: true, recursive: true });
    }
  });

  it("keeps historical verification keys separate from live device authorization", async () => {
    const peerKey = await DeviceKey.generate();
    const peerIdentity = enrollDeviceIdentity(peerKey, {
      displayName: "revoked peer",
      platform: "headless",
      enrolledAt: new Date().toISOString(),
    });
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      trustedIdentities: [peerIdentity],
      authorizedDeviceIds: [],
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
    const payload = { historical: true };
    const signature = peerKey.sign("HistoricalVerificationProbe", 1, payload);

    expect(() => authority.verifier.verify(
      "HistoricalVerificationProbe",
      1,
      payload,
      signature,
    )).not.toThrow();
  });

  it("constructs an executor-only authority stack without anchor owners", async () => {
    const capacity = createDeviceCapacityRuntime(resolve(home, "executor-capacity"));
    const runtime = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      executorReadiness: TEST_EXECUTOR_READINESS,
      enableAnchor: false,
      enableLocalExecutor: true,
      deviceCapacity: capacity.arbiter,
      storageMaintenance: capacity.storage,
    });

    expect(runtime.executorLog).toBeDefined();
    expect(runtime.executorResourceGovernor).toBeDefined();
    expect(runtime.environment).toBeDefined();
    expect(runtime.workspaceBindingAdmin).toBeDefined();
    expect(runtime.workspaceBindingMigration).toBeDefined();
    expect(runtime.workspaceProbe).toBeDefined();
    expect(runtime.globalState).toBeUndefined();
    expect(() => runtime.authorityLog).toThrow("Anchor authority role is not enabled");
    expect(() => runtime.authority).toThrow("Anchor authority role is not enabled");
    expect(() => runtime.controlAdmission).toThrow("Anchor authority role is not enabled");
    expect(() => runtime.resourceGovernor).toThrow("Anchor authority role is not enabled");
  });

  it("constructs an anchor-only authority stack without loading local environment ports", async () => {
    const runtime = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      executorReadiness: TEST_EXECUTOR_READINESS,
      enableAnchor: true,
      enableLocalExecutor: false,
    });

    expect(runtime.authorityLog).toBeDefined();
    expect(runtime.controlAdmission).toBeDefined();
    expect(runtime.globalState).toBeDefined();
    expect(runtime.environment).toBeUndefined();
    expect(runtime.workspaceBindingAdmin).toBeUndefined();
    expect(runtime.workspaceBindingMigration).toBeUndefined();
    expect(runtime.workspaceProbe).toBeUndefined();
    expect(() => runtime.executorLog).toThrow(
      "Local executor role is not enabled",
    );
    expect(() => runtime.executorResourceGovernor).toThrow(
      "Local executor role is not enabled",
    );
  });

  it.each([
    { profile: "anchor+executor", enableLocalExecutor: true },
    { profile: "anchor-only", enableLocalExecutor: false },
  ])("rebinds every fixed authority owner to installed generations in the $profile profile", async ({
    enableLocalExecutor,
  }) => {
    const runtime = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      executorReadiness: TEST_EXECUTOR_READINESS,
      enableAnchor: true,
      enableLocalExecutor,
    });
    try {
      const origin = await runtime.authorityLog.originCheckpoint();
      const initial = {
        authority: runtime.authority,
        controlAdmission: runtime.controlAdmission,
        resourceGovernor: runtime.resourceGovernor,
        surfaceAssets: runtime.surfaceAssets,
        checkpointRetention: runtime.checkpointRetention,
        rubricGlobalState: runtime.rubricGlobalState,
        globalMutationParticipants: runtime.globalMutationParticipants,
      };
      await initial.authority.list();
      const generation = (epoch: number): InstalledAuthorityGeneration => ({
        transferId: `xfer-01J0000000000000000000000${epoch}`,
        commitDigest: protocolDigest("InstalledGenerationCommit", 1, { epoch }),
        baseDigest: protocolDigest("InstalledGenerationBase", 1, { epoch }),
        sourceHead: origin,
        targetLogId: origin.logId,
        installLsn: epoch,
        anchorEpoch: epoch,
        trustEpoch: epoch,
        trustChainHead: {
          seq: epoch,
          eventDigest: protocolDigest("InstalledGenerationTrust", 1, { epoch }),
        },
      });

      const second = generation(2);
      const receipt = await runtime.rebindInstalledAuthority(second);
      expect(receipt).toEqual({
        generation: second,
        participants: INSTALLED_AUTHORITY_GENERATION_PARTICIPANTS,
      });
      expect(runtime.anchorEpoch).toBe(2);
      expect(runtime.authority).not.toBe(initial.authority);
      expect(runtime.controlAdmission).not.toBe(initial.controlAdmission);
      expect(runtime.resourceGovernor).not.toBe(initial.resourceGovernor);
      expect(runtime.surfaceAssets).toBe(initial.surfaceAssets);
      expect(runtime.checkpointRetention).not.toBe(initial.checkpointRetention);
      expect(runtime.rubricGlobalState).not.toBe(initial.rubricGlobalState);
      expect(runtime.globalMutationParticipants).toHaveLength(
        initial.globalMutationParticipants.length,
      );
      for (const [index, participant] of runtime.globalMutationParticipants.entries()) {
        expect(participant).not.toBe(initial.globalMutationParticipants[index]);
      }
      await expect(runtime.authority.list()).resolves.toEqual([]);
      expect(await runtime.rebindInstalledAuthority(structuredClone(second))).toEqual(receipt);

      const third = generation(3);
      await expect(runtime.rebindInstalledAuthority(third)).resolves.toMatchObject({
        generation: { anchorEpoch: 3, trustEpoch: 3 },
      });
      expect(runtime.anchorEpoch).toBe(3);
    } finally {
      await runtime.startupCleanup.run().catch(() => undefined);
    }
  });

  it("selects only the compatible executor named by owner affinity", async () => {
    const incompatibleHome = await createTempDir("delivery-incompatible-executor");
    const compatibleHome = await createTempDir("delivery-compatible-executor");
    try {
      const incompatible = await setupAuthorityRuntime({
        zhixingHome: incompatibleHome,
        secretStore: new MemorySecretStore(),
        executorId: "executor:incompatible",
        executorReadiness: TEST_EXECUTOR_READINESS,
        enableAnchor: false,
      });
      const compatible = await setupAuthorityRuntime({
        zhixingHome: compatibleHome,
        secretStore: new MemorySecretStore(),
        executorId: "executor:compatible",
        executorReadiness: { ...TEST_EXECUTOR_READINESS, tools: ["Read"] },
        enableAnchor: false,
      });
      const anchor = await setupAuthorityRuntime({
        zhixingHome: home,
        secretStore: new MemorySecretStore(),
        executorId: "executor:anchor",
        trustedIdentities: [incompatible.identity, compatible.identity],
        executorReadiness: { ...TEST_EXECUTOR_READINESS, tools: ["Read"] },
      });
      incompatible.reconcileTrustedDevices([anchor.identity], [anchor.deviceId]);
      compatible.reconcileTrustedDevices([anchor.identity], [anchor.deviceId]);
      const profile = { ...EMPTY_EXECUTION_PROFILE, tools: ["Read"] };
      const remote = await anchor.prepareConversationAssignment({
        conversationId: "test-conversation",
        executionProfile: profile,
        permissionRules: [],
        recentExecutorId: compatible.executorId,
        targets: [
          {
            executorId: incompatible.executorId,
            deviceId: incompatible.identity.deviceId,
            synchronizePermission: (snapshot) =>
              incompatible.installPermissionSnapshot(snapshot),
          },
          {
            executorId: compatible.executorId,
            deviceId: compatible.identity.deviceId,
            synchronizePermission: (snapshot) =>
              compatible.installPermissionSnapshot(snapshot),
          },
        ],
      });
      expect(remote.executorId).toBe(compatible.executorId);

      const local = await anchor.prepareConversationAssignment({
        conversationId: "test-conversation",
        executionProfile: profile,
        permissionRules: [],
        recentExecutorId: anchor.executorId,
        targets: [{
          executorId: incompatible.executorId,
          deviceId: incompatible.identity.deviceId,
          synchronizePermission: (snapshot) =>
            incompatible.installPermissionSnapshot(snapshot),
        }],
      });
      expect(local.executorId).toBe(anchor.executorId);

      await expect(
        anchor.prepareConversationAssignment({
          conversationId: "test-conversation",
          executionProfile: profile,
          permissionRules: [],
          targets: [{
            executorId: compatible.executorId,
            deviceId: compatible.identity.deviceId,
            synchronizePermission: (snapshot) =>
              compatible.installPermissionSnapshot(snapshot),
          }],
        }),
      ).rejects.toThrow("requires an explicit executor selection");
    } finally {
      await rm(incompatibleHome, { force: true, recursive: true });
      await rm(compatibleHome, { force: true, recursive: true });
    }
  });

  it("refreshes live device authorization without rebuilding the authority runtime", async () => {
    const peerHome = await createTempDir("delivery-live-authorization-peer");
    try {
      const peer = await setupAuthorityRuntime({
        zhixingHome: peerHome,
        secretStore: new MemorySecretStore(),
        executorReadiness: TEST_EXECUTOR_READINESS,
      });
      const local = await setupAuthorityRuntime({
        zhixingHome: home,
        secretStore: new MemorySecretStore(),
        authorizedDeviceIds: [],
        executorReadiness: TEST_EXECUTOR_READINESS,
      });
      await prepareAuthority(peer);
      const snapshot = await peer.currentExecutorSnapshot();

      await expect(local.acceptExecutorSnapshot(snapshot)).rejects.toThrow(
        "untrusted device",
      );
      local.reconcileTrustedDevices([peer.identity], [peer.deviceId]);
      await expect(local.acceptExecutorSnapshot(snapshot)).resolves.toBeUndefined();
      local.reconcileTrustedDevices([peer.identity], []);
      await expect(local.acceptExecutorSnapshot(snapshot)).rejects.toThrow(
        "not currently authorized",
      );
      expect(() => local.verifier.verify(
        "CapabilityDescriptor",
        1,
        {
          v: snapshot.descriptor.v,
          executorId: snapshot.descriptor.executorId,
          revision: snapshot.descriptor.revision,
          protocolVersion: snapshot.descriptor.protocolVersion,
          workspaces: snapshot.descriptor.workspaces,
          tools: snapshot.descriptor.tools,
          mcpServers: snapshot.descriptor.mcpServers,
          credentialBindings: snapshot.descriptor.credentialBindings,
          evidenceCapabilities: snapshot.descriptor.evidenceCapabilities,
          at: snapshot.descriptor.at,
        },
        snapshot.descriptor.signature,
      )).not.toThrow();
    } finally {
      await rm(peerHome, { force: true, recursive: true });
    }
  });

  it("advances the execution snapshot when credentials rotate under the same binding", async () => {
    const secretStore = new MemorySecretStore();
    const readiness = {
      tools: [] as string[],
      mcpServers: [] as string[],
      credentialBindings: [{
        bindingId: "credential-provider-main",
        service: "provider-main",
        verification: "user-alias" as const,
      }],
      deviceScopedCredentialBindingIds: ["credential-provider-main"],
    };
    const first = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: {
        ...readiness,
        credentialGeneration: "credential-generation-a",
      },
    });
    const executionProfile = {
      ...EMPTY_EXECUTION_PROFILE,
      providerIds: ["main"],
    };
    await prepareAuthority(first, { executionProfile });
    const rotated = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: {
        ...readiness,
        credentialGeneration: "credential-generation-b",
      },
    });
    const rotatedPrepared = await prepareAuthority(rotated, { executionProfile });

    const firstSnapshot = first.executorCapabilities.snapshotFor(first.executorId);
    const rotatedSnapshot = rotated.executorCapabilities.snapshotFor(rotated.executorId);
    expect(rotatedSnapshot?.inventory.inventoryRevision).toBe(
      (firstSnapshot?.inventory.inventoryRevision ?? 0) + 1,
    );
    expect(rotatedSnapshot?.descriptor.credentialBindings[0]?.revision).toBe(
      rotatedSnapshot?.inventory.inventoryRevision,
    );
    expect(rotatedPrepared.policy.manifestCapabilities
      .credentialBindings[0]?.revision).toBe(rotatedSnapshot?.inventory.inventoryRevision);
  });

  it("versions permission policy by portable canonical content", async () => {
    const secretStore = new MemorySecretStore();
    const rule = (
      id: string,
      contextPath: string,
      telemetry = { lastMatchedAt: 1, matchCount: 0 },
    ) => ({
      id,
      pattern: { tool: "bash", argument: "*" },
      decision: "allow" as const,
      scope: "context" as const,
      createdAt: 1,
      ...telemetry,
      contextId: { kind: "main" as const },
      contextPath,
    });
    const first = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
    const firstPrepared = await prepareAuthority(first, {
      permissionRules: [rule("rule-b", "C:\\first"), rule("rule-a", "C:\\first")],
    });
    const replayed = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
    const replayedPrepared = await prepareAuthority(replayed, {
      permissionRules: [
        rule("rule-a", "D:\\moved", { lastMatchedAt: 99, matchCount: 12 }),
        rule("rule-b", "D:\\moved", { lastMatchedAt: 42, matchCount: 3 }),
      ],
    });
    expect(replayedPrepared.policy.permissionSnapshot.digest).toBe(
      firstPrepared.policy.permissionSnapshot.digest,
    );
    expect(replayedPrepared.policy.permissionSnapshot.rules)
      .toEqual(firstPrepared.policy.permissionSnapshot.rules);
    expect(replayedPrepared.policy.permissionSnapshot.rules.some(
      (entry) => "contextPath" in entry,
    )).toBe(false);
  });

  it("fails closed when an established executor directory disappears", async () => {
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
    await prepareAuthority(authority);
    await rm(resolve(
      home,
      "distributed-runtime",
      "executor-capability-directory.json",
    ));
    await expect(setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
    })).rejects.toThrow("state is missing");
  });

  it("fails closed when the version source disappears beside an established directory", async () => {
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
    await prepareAuthority(authority);
    await rm(resolve(
      home,
      "distributed-runtime",
      "executor-snapshot-version.json",
    ));
    await expect(setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
    })).rejects.toThrow("version state is missing");
  });

  it("resumes an explicitly incomplete first bootstrap after a crash", async () => {
    const authorityRoot = resolve(home, "distributed-runtime");
    const secretStore = new MemorySecretStore();
    await new FileExecutionSnapshotVersionStore(resolve(
      authorityRoot,
      "executor-snapshot-version.json",
    )).synchronize(
      "executor:local",
      protocolDigest("InterruptedBootstrap", 1, {}),
      protocolDigest("InterruptedInventoryBootstrap", 1, {}),
      { allowInitialize: true },
    );

    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
    await prepareAuthority(authority);
    expect(authority.executorCapabilities.snapshotFor(authority.executorId))
      .toBeDefined();

    await rm(resolve(authorityRoot, "executor-capability-directory.json"));
    await expect(setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: TEST_EXECUTOR_READINESS,
    })).rejects.toThrow("state is missing");
  });
});

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string) { this.values.set(secretKey(ref), value); }
  async get(ref: SecretRef) { return this.values.get(secretKey(ref)) ?? null; }
  async delete(ref: SecretRef) { this.values.delete(secretKey(ref)); }
  async list(prefix: string) {
    return [...this.values.keys()]
      .filter((value) => value.startsWith(prefix))
      .map((value) => {
        const separator = value.indexOf("/");
        return {
          kind: value.slice(0, separator) as SecretRef["kind"],
          bindingId: value.slice(separator + 1),
        };
      });
  }
  async unlockState() { return "unlocked" as const; }
}

function secretKey(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
