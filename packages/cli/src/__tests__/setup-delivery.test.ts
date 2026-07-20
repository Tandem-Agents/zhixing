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
import { ChannelRegistry, type PermissionRule } from "@zhixing/core";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import {
  createExecutionManifest,
  matchManifest,
  protocolDigest,
  validateTrustRuleSnapshot,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import {
  setupAuthorityRuntime,
  setupDelivery,
  type DeliveryStack,
} from "../setup-delivery.js";
import { FileExecutionSnapshotVersionStore } from "../executor-snapshot-version-store.js";

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
    expect(stack.delivery).toBeDefined();
    expect(stack.outboxRegistry).toBeDefined();
    expect(typeof stack.stop).toBe("function");
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
