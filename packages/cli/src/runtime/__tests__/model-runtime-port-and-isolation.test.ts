import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatRequest,
  LLMProvider,
  StreamEvent,
} from "@zhixing-ai/core";
import type { CapabilityDescriptor, ExecutionManifest, SecretRef } from "@zhixing-ai/core/contracts";
import { createExecutionManifest, matchManifest, MODEL_EXECUTION_PROTOCOL_VERSION } from "@zhixing-ai/core/protocol";
import { createTempDir } from "@zhixing-ai/test-utils";
import {
  editConfiguration,
  loadConfigurationSnapshot,
  writeConfig,
  writeCredentials,
  type LLMConfigV2,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing-ai/providers";
import { projectRuntimeConfiguration } from "../runtime-configuration-projections.js";
import { projectRuntimeSecrets } from "../runtime-secret-projections.js";
import { ModelRuntimePort } from "../model-runtime-port.js";
import { createHostKernelModelProviderFactory } from "../kernel-runtime-bindings.js";
import { editRuntimeConfiguration } from "../configuration-application.js";
import { checkStartupConfiguration } from "../startup-application.js";
import {
  createHostModelDiskReconciler,
  reloadHostModelRuntimePort,
} from "../../serve/local-configuration-application.js";
import { createExecutorReadinessSource } from "../../serve/executor-readiness.js";
import { exposureGuardedSecretStore } from "../../serve/credential-exposure-authority.js";
import {
  createAgentRuntime,
  createKernelModelProviderBinding,
  createKernelRuntimeEnvironment,
  createKernelWindowPromptProjection,
  type KernelModelProviderBinding,
} from "@zhixing-ai/orchestrator/runtime";
import { mainProfile } from "@zhixing-ai/orchestrator/profile";
import { resolveAgentIdentity } from "@zhixing-ai/core/identity";
import {
  bindPermissionRuleExecutionSource,
  PermissionStore,
  toPermissionContext,
} from "@zhixing-ai/core/security";
import { setupAuthorityRuntime } from "../../setup-delivery.js";

class MemorySecretStore {
  values = new Map<string, string>();
  queue = Promise.resolve();
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async get(ref: SecretRef) {
    return this.values.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }
  async getOrCreate(ref: SecretRef, create: () => string) {
    const existing = await this.get(ref);
    if (existing !== null) return existing;
    const value = create();
    await this.put(ref, value);
    return value;
  }
  async put(ref: SecretRef, value: string) {
    this.values.set(`${ref.kind}/${ref.bindingId}`, value);
  }
  async delete(ref: SecretRef) {
    this.values.delete(`${ref.kind}/${ref.bindingId}`);
  }
  async list(prefix: string) {
    return [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => {
        const at = key.indexOf("/");
        return {
          kind: key.slice(0, at) as SecretRef["kind"],
          bindingId: key.slice(at + 1),
        };
      });
  }
  async unlockState() {
    return "unlocked" as const;
  }
}

function v2Config(llm: LLMConfigV2, extra?: Partial<ZhixingConfig>): ZhixingConfig {
  return {
    llm,
    ...extra,
  };
}

describe("Unit 1 Group B: ModelRuntimePort, narrow vs full activation, revocation abort, no-key readiness & session isolation", () => {
  it("supports no-key connection readiness without fake credentialBindings and gates cross-device modelSelection on v2 protocol", () => {
    const config = v2Config({
      schemaVersion: 2,
      connections: {
        local_ollama: {
          name: "Local Ollama",
          adapter: "openai-compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          auth: { mode: "none" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
        cloud: {
          name: "DeepSeek Cloud",
          presetId: "deepseek",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "cloud" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "local_ollama", model: "qwen2.5:14b" },
      light: { connectionId: "cloud", model: "deepseek-chat" },
    });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: {
        cloud: { v: 2, kind: "api-key", value: "sk-cloud-real" },
      },
    };
    const cfgProj = projectRuntimeConfiguration(config);
    const secProj = projectRuntimeSecrets(creds);
    const port = new ModelRuntimePort({
      modelConfiguration: cfgProj.model,
      advancementConfiguration: cfgProj.advancement,
      providerCredentials: secProj.providerCredentials,
      exposureCredentials: secProj.credentialExposureCredentials,
      credentialGeneration: "gen-1",
    });

    const readiness = port.readiness();
    // No fake credentialBindings for local_ollama!
    expect(readiness.credentialBindings.map((b) => b.bindingId)).toEqual([
      "credential-provider-cloud",
    ]);
    expect(readiness.modelConnections).toEqual([
      expect.objectContaining({
        connectionId: "cloud",
        authMode: "api-key",
        credentialBindingId: "credential-provider-cloud",
        ready: true,
      }),
      expect.objectContaining({
        connectionId: "local_ollama",
        authMode: "none",
        ready: true,
      }),
    ]);
    expect(readiness.modelConnections.find((c) => c.connectionId === "local_ollama")?.credentialBindingId).toBeUndefined();
    expect(readiness.readyRoles).toEqual(["light", "main", "power"]);

    const readinessSource = createExecutorReadinessSource({
      runtime: { capabilityCatalog: () => ({ tools: ["read"], mcpServers: [] }) },
      credentials: secProj.credentialExposureCredentials,
      credentialGeneration: "gen-1",
      modelRuntimePort: port,
    });
    const published = readinessSource();
    expect(published.modelConnections?.length).toBe(2);
    expect(published.credentialBindings.map((b) => b.bindingId)).toEqual([
      "credential-provider-cloud",
    ]);

    const manifestV2 = createExecutionManifest<"conversation">({
      protocolVersion: MODEL_EXECUTION_PROTOCOL_VERSION,
      baseRef: { execution: "conversation", conversationId: "conv-1", baseRevision: 1 },
      requires: {
        runtimeConfigRev: 1,
        modelProfileRev: 1,
        policyRev: 1,
        skillsRev: 1,
        rubricsRev: 1,
        promptAssetsRev: 1,
        permissionSnapshotVersion: 1,
      },
      environment: {
        deviceId: "dev-1",
        evidenceKinds: ["log"],
        credentialBindings: [],
      },
      tools: ["read"],
      mcpServers: [],
      credentialBindings: [],
      modelSelection: {
        mode: "connection",
        connectionId: "local_ollama",
        model: "qwen2.5:14b",
        adapter: "openai-compatible",
      },
    });
    const v2Capability: CapabilityDescriptor = {
      v: 1,
      executorId: "exec-v2",
      revision: 1,
      protocolVersion: MODEL_EXECUTION_PROTOCOL_VERSION,
      workspaces: [],
      tools: ["read"],
      mcpServers: [],
      credentialBindings: [],
      modelConnections: readiness.modelConnections,
      readyRoles: readiness.readyRoles,
      evidenceCapabilities: ["log"],
      at: "2026-11-19T10:00:00.000Z",
      signature: { alg: "ed25519", keyId: "dev-1", sig: "sig" },
    };
    const v2Inventory = {
      v: 1 as const,
      executorId: "exec-v2",
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
      permissionSnapshotHighWater: 1,
      credentialBindingRevisions: [],
      at: "2026-11-19T10:00:00.000Z",
      signature: { alg: "ed25519" as const, keyId: "dev-1", sig: "sig" },
    };
    const oldV1Capability: CapabilityDescriptor = {
      v: 1,
      executorId: "exec-v1",
      revision: 1,
      protocolVersion: "1",
      workspaces: [],
      tools: ["read"],
      mcpServers: [],
      credentialBindings: [],
      evidenceCapabilities: ["log"],
      at: "2026-11-19T10:00:00.000Z",
      signature: { alg: "ed25519", keyId: "dev-1", sig: "sig" },
    };
    const oldV1Inventory = {
      ...v2Inventory,
      executorId: "exec-v1",
    };
    const missingConnectionsV2Capability: CapabilityDescriptor = {
      ...oldV1Capability,
      executorId: "exec-v2-missing",
      protocolVersion: MODEL_EXECUTION_PROTOCOL_VERSION,
    };
    const missingConnectionsV2Inventory = {
      ...v2Inventory,
      executorId: "exec-v2-missing",
    };
    expect(matchManifest(manifestV2, v2Capability, v2Inventory)).toEqual({ ok: true });
    const oldProtocolResult = matchManifest(manifestV2, oldV1Capability, oldV1Inventory);
    expect(oldProtocolResult.ok).toBe(false);
    const missingConnectionsResult = matchManifest(
      manifestV2,
      missingConnectionsV2Capability,
      missingConnectionsV2Inventory,
    );
    expect(missingConnectionsResult.ok).toBe(false);
    if (!missingConnectionsResult.ok) {
      expect(missingConnectionsResult.error.code).toBe("capability-gap");
      expect(missingConnectionsResult.error.message).toMatch(/model connection/i);
    }
  });

  it("aborts in-flight calls on explicit secret revocation, blocks new calls, closes retired dispatchers after refcount reaches 0, and preserves old snapshot on failed assembly", async () => {
    const initialConfig = v2Config({
      schemaVersion: 2,
      connections: {
        primary: {
          name: "Primary",
          presetId: "deepseek",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "primary" },
          network: { proxy: "inherit" },
        },
        backup: {
          name: "Backup",
          presetId: "openai",
          adapter: "openai-compatible",
          endpoint: "https://api.openai.com/v1",
          auth: { mode: "api-key", secretRef: "backup" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "primary", model: "deepseek-chat" },
    });
    const initialCreds: ZhixingCredentials = {
      version: 2,
      modelSecrets: {
        primary: { v: 2, kind: "api-key", value: "sk-primary-1" },
        backup: { v: 2, kind: "api-key", value: "sk-backup-1" },
      },
    };
    const cProj = projectRuntimeConfiguration(initialConfig);
    const sProj = projectRuntimeSecrets(initialCreds);
    const port = new ModelRuntimePort({
      modelConfiguration: cProj.model,
      advancementConfiguration: cProj.advancement,
      providerCredentials: sProj.providerCredentials,
      exposureCredentials: sProj.credentialExposureCredentials,
      credentialGeneration: "gen-1",
    });

    // Simulate an in-flight call on a tracked provider
    let aborted = false;
    let closed = false;
    let releaseCall!: () => void;
    const callStarted = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const fakeProvider: LLMProvider = {
      id: "primary",
      models: [],
      async *chat(req: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
        releaseCall();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            aborted = true;
            reject(req.abortSignal?.reason ?? new Error("aborted"));
          };
          if (req.abortSignal?.aborted) onAbort();
          else req.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      },
      async close() {
        closed = true;
      },
    };
    const tracked = port.trackRoles(
      {
        main: { provider: fakeProvider, model: "deepseek-chat", chat: (r) => fakeProvider.chat({ ...r, model: "deepseek-chat" }) },
        light: { provider: fakeProvider, model: "deepseek-chat", chat: (r) => fakeProvider.chat({ ...r, model: "deepseek-chat" }) },
        power: { provider: fakeProvider, model: "deepseek-chat", chat: (r) => fakeProvider.chat({ ...r, model: "deepseek-chat" }) },
      },
      {
        main: { resolved: { providerId: "primary", connectionId: "primary", secretRef: "primary", apiKey: "sk-primary-1", baseUrl: "https://api.deepseek.com/v1", protocol: "openai-compatible" }, model: "deepseek-chat" },
        light: { resolved: { providerId: "primary", connectionId: "primary", secretRef: "primary", apiKey: "sk-primary-1", baseUrl: "https://api.deepseek.com/v1", protocol: "openai-compatible" }, model: "deepseek-chat" },
        power: { resolved: { providerId: "primary", connectionId: "primary", secretRef: "primary", apiKey: "sk-primary-1", baseUrl: "https://api.deepseek.com/v1", protocol: "openai-compatible" }, model: "deepseek-chat" },
      },
      port.snapshot().revision,
    );

    const streamPromise = (async () => {
      for await (const _ev of tracked.main.provider.chat({ model: "deepseek-chat", messages: [] })) {
        // wait
      }
    })();
    await callStarted;
    expect(port.inFlightConnectionIds().has("primary")).toBe(true);

    // Attempt broken update (missing secret for main) -> MUST fail pre-check & keep old snapshot
    const brokenConfig = v2Config({
      schemaVersion: 2,
      connections: {
        missing_conn: {
          name: "Broken",
          adapter: "openai-compatible",
          endpoint: "https://api.example.com/v1",
          auth: { mode: "api-key", secretRef: "missing_ref" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "missing_conn", model: "m1" },
    });
    const brokenRes = await port.applyUpdate({
      operationId: "op-broken",
      modelConfiguration: projectRuntimeConfiguration(brokenConfig).model,
      providerCredentials: sProj.providerCredentials,
      exposureCredentials: sProj.credentialExposureCredentials,
      credentialGeneration: "gen-1",
    });
    expect(brokenRes.applied).toBe(false);
    expect(aborted).toBe(false);

    // Now switch main to backup and revoke primary -> MUST abort in-flight call & close retired dispatcher
    const nextConfig = v2Config({
      schemaVersion: 2,
      connections: {
        backup: initialConfig.llm && "schemaVersion" in initialConfig.llm ? initialConfig.llm.connections.backup! : ({} as never),
      },
      main: { connectionId: "backup", model: "gpt-4o" },
    });
    const nextCreds: ZhixingCredentials = {
      version: 2,
      modelSecrets: {
        backup: { v: 2, kind: "api-key", value: "sk-backup-1" },
      },
      revokedModelSecretRefs: ["primary"],
    };
    const nextCProj = projectRuntimeConfiguration(nextConfig);
    const nextSProj = projectRuntimeSecrets(nextCreds);
    const applied = await port.applyUpdate({
      operationId: "op-revoke-primary",
      modelConfiguration: nextCProj.model,
      providerCredentials: nextSProj.providerCredentials,
      exposureCredentials: nextSProj.credentialExposureCredentials,
      credentialGeneration: "gen-2",
    });
    expect(applied.applied).toBe(true);
    if (applied.applied) expect(applied.abortedCalls).toBe(1);
    await expect(streamPromise).rejects.toThrow(/已撤销/u);
    expect(aborted).toBe(true);
    // Allow microtask queue to finish retired close()
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);

    // Subsequent call on revoked secretRef is rejected immediately
    await expect(
      (async () => {
        for await (const _ev of tracked.main.provider.chat({ model: "deepseek-chat", messages: [] })) {
          // unreachable
        }
      })(),
    ).rejects.toThrow(/已撤销/u);
  });

  it("keeps roles.light completely isolated when sessionOverride rebinds primaryRole", () => {
    const config = v2Config({
      schemaVersion: 2,
      connections: {
        main_conn: {
          name: "Main",
          presetId: "deepseek",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "main_conn" },
          network: { proxy: "inherit" },
        },
        light_conn: {
          name: "Light",
          presetId: "openai",
          adapter: "openai-compatible",
          endpoint: "https://api.openai.com/v1",
          auth: { mode: "api-key", secretRef: "light_conn" },
          network: { proxy: "inherit" },
        },
        override_conn: {
          name: "Override",
          adapter: "anthropic-messages",
          endpoint: "https://api.anthropic.com",
          auth: { mode: "api-key", secretRef: "override_conn" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "main_conn", model: "deepseek-chat" },
      light: { connectionId: "light_conn", model: "gpt-4o-mini" },
    });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: {
        main_conn: { v: 2, kind: "api-key", value: "sk-main" },
        light_conn: { v: 2, kind: "api-key", value: "sk-light" },
        override_conn: { v: 2, kind: "api-key", value: "sk-override" },
      },
    };
    const factory = createHostKernelModelProviderFactory({
      configuration: projectRuntimeConfiguration(config).model,
      credentials: projectRuntimeSecrets(creds).providerCredentials,
    });

    const binding = factory.create({
      primaryRole: "main",
      sessionOverride: {
        mode: "override",
        connectionId: "override_conn",
        model: "claude-sonnet-4-20250514",
        maxOutputPreference: 4096,
      },
    });
    // F7 / 设计 §5.1 硬不变量：roles.main 与 roles.light 保持纯用途默认，sessionOverride 独立经 sessionPrimary 交付
    expect(binding.roles.main.provider.id).toBe("main_conn");
    expect(binding.roles.main.model).toBe("deepseek-chat");
    expect(binding.sessionPrimary?.provider.id).toBe("override_conn");
    expect(binding.sessionPrimary?.model).toBe("claude-sonnet-4-20250514");
    expect(binding.sessionPrimaryMaxOutputTokens).toBe(4096);
    // Light MUST NOT be rebound by sessionOverride!
    expect(binding.roles.light.provider.id).toBe("light_conn");
    expect(binding.roles.light.model).toBe("gpt-4o-mini");
  });

  it("arbiter routes pure model edits to narrow applyModelConfiguration and mixed network+model edits to one single requestHostReload", async () => {
    const dir = await createTempDir("config-arbiter");
    const configPath = path.join(dir, "config.jsonc");
    const store = new MemorySecretStore();
    const initialConfig = v2Config({
      schemaVersion: 2,
      connections: {
        c1: {
          name: "C1",
          presetId: "deepseek",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "c1" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "c1", model: "deepseek-chat" },
    });
    const initialCreds: ZhixingCredentials = {
      version: 2,
      modelSecrets: { c1: { v: 2, kind: "api-key", value: "sk-1" } },
    };
    await writeConfig(initialConfig, { configPath });
    await writeCredentials(initialCreds, { store });

    // Case 1: pure model change -> narrow activation ONLY, zero host reload
    const applyModel = vi.fn(async () => ({ applied: true, revision: "rev-2" }));
    const reload = vi.fn(async () => undefined);
    const res1 = await editRuntimeConfiguration(
      {
        zhixingHome: dir,
        configPath,
        secretStore: store as never,
        state: { activeTurnPromise: null },
        applyModelConfiguration: applyModel,
        requestHostReload: reload,
      },
      {
        kind: "config",
        edit: async (session) => {
          const nextConfig = structuredClone(session.initialConfig);
          (nextConfig.llm as LLMConfigV2).main!.model = "deepseek-reasoner";
          await session.writers.save({
            config: nextConfig,
            credentials: session.initialCredentials,
          });
          return {
            kind: "completed",
            config: nextConfig,
            credentials: session.initialCredentials,
          };
        },
      },
    );
    expect(res1.kind).toBe("local-applied");
    expect(applyModel).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    // Case 2: mixed network.proxy + model change -> ONE single host reload, zero narrow activation
    applyModel.mockClear();
    reload.mockClear();
    const res2 = await editRuntimeConfiguration(
      {
        zhixingHome: dir,
        configPath,
        secretStore: store as never,
        state: { activeTurnPromise: null },
        applyModelConfiguration: applyModel,
        requestHostReload: reload,
      },
      {
        kind: "config",
        edit: async (session) => {
          const nextConfig = structuredClone(session.initialConfig);
          (nextConfig.llm as LLMConfigV2).main!.model = "deepseek-chat";
          nextConfig.network = { proxy: "http://127.0.0.1:7890" };
          await session.writers.save({
            config: nextConfig,
            credentials: session.initialCredentials,
          });
          return {
            kind: "completed",
            config: nextConfig,
            credentials: session.initialCredentials,
          };
        },
      },
    );
    expect(res2.kind).toBe("reloaded");
    expect(applyModel).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("exempts configuration/model-retirements/v1 from CredentialExposureAuthority external route checks", async () => {
    const store = new MemorySecretStore();
    await store.put({ kind: "provider", bindingId: "configuration/model-retirements/v1" }, '{"v":1,"items":[]}');
    const assertRoute = vi.fn(async () => {
      throw new Error("should not be called for configuration metadata");
    });
    const guarded = exposureGuardedSecretStore(store, { assertRoute } as never);
    const raw = await guarded.get({ kind: "provider", bindingId: "configuration/model-retirements/v1" });
    expect(raw).toBe('{"v":1,"items":[]}');
    expect(assertRoute).not.toHaveBeenCalled();
  });

  it("F2: revoking main without replacement STILL aborts in-flight calls, blocks new calls on old closure, and strips fallback secret", async () => {
    const cfg = v2Config({
      schemaVersion: 2,
      connections: {
        main_conn: {
          name: "Main",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "main_ref" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "main_conn", model: "deepseek-chat" },
    });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: { main_ref: { v: 2, kind: "api-key", value: "sk-live" } },
    };
    const port = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(cfg).model,
      providerCredentials: projectRuntimeSecrets(creds).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds).credentialExposureCredentials,
      credentialGeneration: "gen-1",
    });

    let aborted = false;
    let started!: () => void;
    const callStarted = new Promise<void>((r) => { started = r; });
    const fakeProvider: LLMProvider = {
      id: "main_conn",
      models: [],
      async *chat(req) {
        started();
        await new Promise<void>((_res, rej) => {
          const onAbort = () => { aborted = true; rej(req.abortSignal?.reason ?? new Error("aborted")); };
          if (req.abortSignal?.aborted) onAbort();
          else req.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
    const resolvedEntry = {
      resolved: {
        providerId: "main_conn",
        connectionId: "main_conn",
        secretRef: "main_ref",
        apiKey: "sk-live",
        baseUrl: "https://api.deepseek.com/v1",
        protocol: "openai-compatible" as const,
      },
      model: "deepseek-chat",
    };
    const tracked = port.trackBinding({
      roles: {
        main: { provider: fakeProvider, model: "deepseek-chat", chat: (r) => fakeProvider.chat({ ...r, model: "deepseek-chat" }) },
        light: { provider: fakeProvider, model: "deepseek-chat", chat: (r) => fakeProvider.chat({ ...r, model: "deepseek-chat" }) },
        power: { provider: fakeProvider, model: "deepseek-chat", chat: (r) => fakeProvider.chat({ ...r, model: "deepseek-chat" }) },
      },
      resolvedRoles: { main: resolvedEntry, light: resolvedEntry, power: resolvedEntry },
      revision: port.snapshot().revision,
    });

    const inFlight = (async () => {
      for await (const _e of tracked.roles.main.provider.chat({ model: "deepseek-chat", messages: [] })) { /* wait */ }
    })();
    await callStarted;

    // Revoke main_ref WITHOUT configuring a replacement main -> resolveLLMRoles throws, applied === false
    const revokedCreds: ZhixingCredentials = {
      version: 2,
      revokedModelSecretRefs: ["main_ref"],
    };
    const res = await port.applyUpdate({
      operationId: "op-revoke-no-replacement",
      modelConfiguration: projectRuntimeConfiguration(cfg).model,
      providerCredentials: projectRuntimeSecrets(revokedCreds).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(revokedCreds).credentialExposureCredentials,
      credentialGeneration: "gen-2",
      revokedSecretRefs: ["main_ref"],
    });
    expect(res.applied).toBe(false);
    if (!res.applied) expect(res.abortedCalls).toBe(1);
    await expect(inFlight).rejects.toThrow(/已撤销/u);
    expect(aborted).toBe(true);
    // Readiness immediately drops the revoked connection and secret
    expect(port.readiness().modelConnections[0]?.ready).toBe(false);
    expect(port.readiness().credentialBindings).toEqual([]);
    // Old closure MUST NOT start new calls even though applyUpdate returned applied: false
    await expect(
      (async () => {
        for await (const _e of tracked.roles.main.provider.chat({ model: "deepseek-chat", messages: [] })) { /* unreachable */ }
      })(),
    ).rejects.toThrow(/已撤销/u);
  });

  it("F3 + F4: keeps retired provider dispatcher open across tool-gap while run lease is held, then closes and fires idle retirement listener on release", async () => {
    const cfg1 = v2Config({
      schemaVersion: 2,
      connections: {
        c1: {
          name: "C1",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "c1" },
          network: { proxy: "inherit" },
        },
        c2: {
          name: "C2",
          adapter: "openai-compatible",
          endpoint: "https://api.openai.com/v1",
          auth: { mode: "api-key", secretRef: "c2" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "c1", model: "deepseek-chat" },
    });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: {
        c1: { v: 2, kind: "api-key", value: "sk-1" },
        c2: { v: 2, kind: "api-key", value: "sk-2" },
      },
    };
    const port = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(cfg1).model,
      providerCredentials: projectRuntimeSecrets(creds).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds).credentialExposureCredentials,
      credentialGeneration: "gen-1",
    });

    const idleNotified: string[] = [];
    port.onConnectionRetiredIdle((connId) => {
      idleNotified.push(connId);
    });

    let closed = false;
    let callCount = 0;
    const fakeProvider: LLMProvider = {
      id: "c1",
      models: [],
      async *chat() {
        if (closed) throw new Error("Connection error: dispatcher closed prematurely");
        callCount += 1;
        yield { type: "text_delta", text: `call-${callCount}` };
        yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async close() {
        closed = true;
      },
    };
    const resolvedEntry = {
      resolved: {
        providerId: "c1",
        connectionId: "c1",
        secretRef: "c1",
        apiKey: "sk-1",
        baseUrl: "https://api.deepseek.com/v1",
        protocol: "openai-compatible" as const,
      },
      model: "deepseek-chat",
    };
    const tracked = port.trackBinding({
      roles: {
        main: { provider: fakeProvider, model: "deepseek-chat", chat: (r) => fakeProvider.chat({ ...r, model: "deepseek-chat" }) },
        light: { provider: fakeProvider, model: "deepseek-chat", chat: (r) => fakeProvider.chat({ ...r, model: "deepseek-chat" }) },
        power: { provider: fakeProvider, model: "deepseek-chat", chat: (r) => fakeProvider.chat({ ...r, model: "deepseek-chat" }) },
      },
      resolvedRoles: { main: resolvedEntry, light: resolvedEntry, power: resolvedEntry },
      revision: port.snapshot().revision,
    });

    // Simulate admitted multi-call run: hold run lease across call #1 -> tool gap -> call #2
    const releaseRunLease = tracked.acquireRunLease();
    for await (const _e of tracked.roles.main.chat({ messages: [] })) { /* call #1 finishes */ }
    expect(port.activeCallCount()).toBe(0);
    expect(port.inFlightConnectionIds().has("c1")).toBe(true);

    // Mid-tool-gap config switch from c1 to c2 -> MUST NOT close c1 while run lease is held!
    const cfg2 = v2Config({
      ...(cfg1.llm as LLMConfigV2),
      main: { connectionId: "c2", model: "gpt-4o" },
    });
    const upd = await port.applyUpdate({
      operationId: "op-switch-c2",
      modelConfiguration: projectRuntimeConfiguration(cfg2).model,
      providerCredentials: projectRuntimeSecrets(creds).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds).credentialExposureCredentials,
      credentialGeneration: "gen-2",
    });
    expect(upd.applied).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(false);
    expect(idleNotified).toEqual([]);

    // LLM call #2 of the SAME admitted run MUST succeed on old open dispatcher!
    let text2 = "";
    for await (const ev of tracked.roles.main.chat({ messages: [] })) {
      if (ev.type === "text_delta") text2 += ev.text;
    }
    expect(text2).toBe("call-2");

    // Releasing the run lease drops refcount to 0 -> immediately closes dispatcher & notifies idle retirement
    releaseRunLease();
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);
    expect(idleNotified).toEqual(["c1"]);
  });

  it("F6: disk reconciler applies pure model disk edits on admission without RPC notify and skips mixed non-model edits", async () => {
    const dir = await createTempDir("disk-reconcile");
    const configPath = path.join(dir, "config.jsonc");
    const store = new MemorySecretStore();
    const cfg1 = v2Config({
      schemaVersion: 2,
      connections: {
        c1: {
          name: "C1",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "c1" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "c1", model: "deepseek-chat" },
    });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: { c1: { v: 2, kind: "api-key", value: "sk-1" } },
    };
    const initSnap = await loadConfigurationSnapshot({ configPath, store: store as never });
    await editConfiguration(
      initSnap,
      { config: cfg1, credentials: creds },
      { configPath, store: store as never, forceModelConfigVersion2: true },
    );
    const port = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(cfg1).model,
      providerCredentials: projectRuntimeSecrets(creds).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds).credentialExposureCredentials,
      credentialGeneration: "gen-1",
    });
    const reconciler = createHostModelDiskReconciler({
      homeDir: dir,
      configPath,
      store: store as never,
      modelRuntimePort: port,
    });
    await reconciler.captureBaseline();
    port.setDiskReconciler(() => reconciler.reconcileFromDisk());

    // 1. Pure model edit written directly to disk (simulating editor crash before RPC notify)
    const cfg2 = v2Config({
      ...(cfg1.llm as LLMConfigV2),
      main: { connectionId: "c1", model: "deepseek-reasoner" },
    });
    await writeConfig(cfg2, { configPath });
    await port.ensureFreshBeforeAdmission();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("deepseek-reasoner");

    // 2. Mixed non-model + model edit written to disk -> MUST NOT half-apply model!
    const cfgMixed: ZhixingConfig = {
      ...cfg2,
      network: { proxy: "http://127.0.0.1:7890" },
      llm: {
        ...(cfg2.llm as LLMConfigV2),
        main: { connectionId: "c1", model: "should-not-half-apply" },
      },
    };
    await writeConfig(cfgMixed, { configPath });
    await port.ensureFreshBeforeAdmission();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("deepseek-reasoner");
  });

  it("F2 rotation hook + F8 startup mismatch fail-closed: publishRotations runs before exposure-guarded applyUpdate, and v2+v1 manifest blocks startup", async () => {
    const dir = await createTempDir("startup-mismatch");
    const configPath = path.join(dir, "config.jsonc");
    const store = new MemorySecretStore();

    // F8: v2 config + non-empty v1 SecretStore manifest -> checkStartupConfiguration MUST return schema-error (NOT ready)
    const v2NoKey = v2Config({
      schemaVersion: 2,
      connections: {
        local_ollama: {
          name: "Ollama",
          adapter: "openai-compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          auth: { mode: "none" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: { connectionId: "local_ollama", model: "qwen3:8b" },
    });
    await writeConfig(v2NoKey, { configPath });
    await writeCredentials({ providers: { deepseek: { apiKey: "sk-v1" } } }, { store });

    const startupRes = await checkStartupConfiguration({
      homeDir: dir,
      configPath,
      secretStore: store as never,
      mode: "host",
      isTTY: false,
      edit: async () => ({ kind: "cancelled" }),
    });
    expect(startupRes.kind).toBe("schema-error");

    // F2: reloadHostModelRuntimePort runs publishRotations BEFORE applyUpdate and reports rotationWarning cleanly on failure
    const dirRot = await createTempDir("rotation-order");
    const rotConfigPath = path.join(dirRot, "config.jsonc");
    const rotStore = new MemorySecretStore();
    await writeConfig(v2NoKey, { configPath: rotConfigPath });
    const rotPort = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(v2NoKey).model,
      providerCredentials: {},
      exposureCredentials: {},
      credentialGeneration: null,
    });
    const order: string[] = [];
    const rotRes = await reloadHostModelRuntimePort({
      homeDir: dirRot,
      configPath: rotConfigPath,
      store: rotStore as never,
      modelRuntimePort: rotPort,
      publishRotations: async () => {
        order.push("publishRotations");
        throw new Error("probe-failed-separate-warning");
      },
      onApplied: async () => {
        order.push("onApplied");
      },
    });
    expect(order).toEqual(["publishRotations", "onApplied"]);
    expect(rotRes.applied).toBe(true);
    expect(rotRes.rotationWarning).toContain("probe-failed-separate-warning");
  });

  it("F1 + F5: device-scoped credentialBindingId aligns when secretRef !== connectionId or shared, and prepareConversationAssignment enforces v2 structured modelSelection", async () => {
    const dir = await createTempDir("f1-f5-authority");
    const store = new MemorySecretStore();

    const cfg = v2Config({
      schemaVersion: 2,
      connections: {
        conn_primary: {
          name: "Primary",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "shared_secret" },
          network: { proxy: "inherit" },
        },
        conn_secondary: {
          name: "Secondary",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "shared_secret" },
          network: { proxy: "inherit" },
        },
        conn_nokey: {
          name: "Ollama",
          adapter: "openai-compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          auth: { mode: "none" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: { connectionId: "conn_primary", model: "deepseek-chat" },
    });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: {
        shared_secret: { v: 2, kind: "api-key", value: "sk-shared-key" },
      },
    };
    const port = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(cfg).model,
      providerCredentials: projectRuntimeSecrets(creds).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds).credentialExposureCredentials,
      credentialGeneration: "gen-f1",
    });
    const readinessSource = createExecutorReadinessSource({
      runtime: { capabilityCatalog: () => ({ tools: ["read"], mcpServers: [] }) },
      credentials: projectRuntimeSecrets(creds).credentialExposureCredentials,
      credentialGeneration: "gen-f1",
      modelRuntimePort: port,
    });
    const authority = await setupAuthorityRuntime({
      zhixingHome: dir,
      secretStore: store as never,
      executorReadiness: readinessSource,
    });

    try {
      // F1: both conn_primary & conn_secondary use secretRef="shared_secret" (!== connectionId)
      const preparedF1 = await authority.prepareConversationAssignment({
        conversationId: "conv-f1",
        executionProfile: {
          tools: ["read"],
          mcpServers: [],
          providerIds: ["conn_primary", "conn_secondary"],
        },
        permissionRules: [],
      });
      expect(preparedF1.policy.manifestCapabilities.protocolVersion).toBe(MODEL_EXECUTION_PROTOCOL_VERSION);
      expect(preparedF1.policy.manifestCapabilities.credentialBindings).toHaveLength(1);
      expect(preparedF1.policy.manifestCapabilities.credentialBindings[0]!.service).toBe("provider-shared_secret");
      expect(preparedF1.policy.manifestCapabilities.credentialBindings[0]!.bindingId).toContain(authority.deviceId);

      // F5: structured modelSelection on conn_nokey emits v2 manifest with modelSelection & zero fake binding for conn_nokey
      const preparedF5 = await authority.prepareConversationAssignment({
        conversationId: "conv-f5",
        executionProfile: {
          tools: ["read"],
          mcpServers: [],
          providerIds: ["conn_nokey"],
        },
        permissionRules: [],
        modelSelection: {
          mode: "connection",
          connectionId: "conn_nokey",
          model: "qwen3:8b",
        },
      });
      expect(preparedF5.policy.manifestCapabilities.protocolVersion).toBe(MODEL_EXECUTION_PROTOCOL_VERSION);
      expect(preparedF5.policy.manifestCapabilities.modelSelection).toEqual({
        mode: "connection",
        connectionId: "conn_nokey",
        model: "qwen3:8b",
      });
      expect(preparedF5.policy.manifestCapabilities.credentialBindings).toEqual([]);

      // F5 negative: requesting a connection that does not exist on target executor MUST fail with capability gap
      await expect(
        authority.prepareConversationAssignment({
          conversationId: "conv-f5-missing",
          executionProfile: {
            tools: ["read"],
            mcpServers: [],
            providerIds: ["conn_primary"],
          },
          permissionRules: [],
          modelSelection: {
            mode: "connection",
            connectionId: "only_on_other_device",
            model: "m-other",
          },
        }),
      ).rejects.toThrow();
    } finally {
      await authority.startupCleanup.run();
    }
  }, 20_000);

  it("F7 runtime end-to-end: sessionOverride routes main loop to sessionPrimary while keeping explicit callText('main') and roles.main strictly on resolvedMain", async () => {
    const calls: Array<{ roleTag: string; model: string }> = [];
    const makeProvider = (id: string): LLMProvider => ({
      id,
      models: [],
      async *chat(req) {
        calls.push({ roleTag: id, model: req.model });
        yield { type: "text_delta", text: `from-${id}-${req.model}` };
        yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    const mainProv = makeProvider("main_conn");
    const lightProv = makeProvider("light_conn");
    const overrideProv = makeProvider("override_conn");
    const binding: KernelModelProviderBinding = createKernelModelProviderBinding({
      primaryRole: "main",
      roles: {
        main: { provider: mainProv, model: "main-m", chat: (r) => mainProv.chat({ ...r, model: "main-m" }) },
        light: { provider: lightProv, model: "light-m", chat: (r) => lightProv.chat({ ...r, model: "light-m" }) },
        power: { provider: mainProv, model: "main-m", chat: (r) => mainProv.chat({ ...r, model: "main-m" }) },
      },
      sessionPrimary: {
        provider: overrideProv,
        model: "override-m",
        chat: (r) => overrideProv.chat({ ...r, model: "override-m" }),
      },
      sessionPrimaryMaxOutputTokens: 2048,
      roleThinking: { main: undefined, light: undefined, power: undefined },
      defaultMaxOutputTokens: { main: 4096, light: 2048, power: 4096 },
      primary: {
        budget: { contextWindow: 128_000, maxOutputTokens: 8192 },
        inputCapabilities: { images: false },
        attention: { optimalMaxTokens: 64_000, riskMaxTokens: 100_000 },
      },
    });
    const dir = await createTempDir("f7-runtime");
    const runtime = await createAgentRuntime({
      modelProvider: binding,
      runtimeEnvironment: createKernelRuntimeEnvironment({
        agentIdentity: resolveAgentIdentity(),
        sessionType: "interactive",
        workspace: { path: dir, source: "global-config" },
        globalConfigPath: path.join(dir, "config.jsonc"),
      }),
      toolImplementation: Object.freeze({
        create: () => Object.freeze({ tools: Object.freeze([]), permissionRuleSets: Object.freeze([]) }),
      }),
      windowPrompt: Object.freeze({
        project: async () => createKernelWindowPromptProjection({ segment: "skill-index", revision: 1, content: null }),
      }),
      securityExecution: Object.freeze({
        create(request: { extractArgument: (tool: string, args: unknown) => string | undefined }) {
          const permStore = new PermissionStore({
            rootDir: null,
            extractArgument: request.extractArgument,
          });
          const contextId = Object.freeze(toPermissionContext({ kind: "main" as const }));
          return Object.freeze({
            contextId,
            trustContext: Object.freeze({ kind: "global" as const }),
            permissionRuleSource: bindPermissionRuleExecutionSource(permStore, contextId),
            persistentApprovals: true,
            recordApproval: () => Object.freeze({ kind: "recorded" as const }),
            executionPermissionRules: () => [],
            securitySnapshot: () => ({
              contextId,
              workspacePath: dir,
              permissionRules: [],
              confirmations: [],
            }),
          });
        },
      }) as never,
      profile: {
        ...mainProfile({ agentIdentity: resolveAgentIdentity() }),
        enabledTools: [],
      },
    });
    try {
      // Explicit callText("main") MUST use pure roles.main ("main_conn" / "main-m"), NOT override_conn!
      const mainText = await runtime.callText("hello", "main");
      expect(mainText).toBe("from-main_conn-main-m");
      // Explicit callText("light") MUST use pure roles.light ("light_conn" / "light-m")!
      const lightText = await runtime.callText("hello", "light");
      expect(lightText).toBe("from-light_conn-light-m");
      // Execution profile MUST include override_conn alongside main_conn & light_conn!
      expect(runtime.executionProfile().providerIds).toContain("override_conn");
      expect(runtime.executionProfile().providerIds).toContain("main_conn");
      expect(runtime.executionProfile().providerIds).toContain("light_conn");
    } finally {
      await runtime.dispose("session-dispose");
    }
  });
});
