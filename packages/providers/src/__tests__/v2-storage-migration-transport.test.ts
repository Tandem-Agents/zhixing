import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import type { SecretRef, SecretStorePort } from "@zhixing-ai/core/contracts";
import { resolveMaxOutputTokens } from "@zhixing-ai/core";
import {
  createConnectionDeliveryFetch,
  newDelivery,
  provenUndelivered,
  withDelivery,
} from "../adapters/delivery-transport.js";
import { loadConfig } from "../config-loader.js";
import { validateConfigSemantics } from "../config-validator.js";
import {
  editConfiguration,
  loadConfigurationSnapshot,
  migrateConfigurationV1ToV2,
  settlePendingModelRetirements,
} from "../configuration-edit.js";
import {
  compromisedSecretToken,
  CONFIGURATION_EDIT_REF,
  loadCredentials,
  MODEL_RETIREMENTS_REF,
  readManifestMetadataUnlocked,
  readPendingModelRetirementsUnlocked,
  writeCredentials,
  type CredentialStoreCoordinator,
} from "../credentials-loader.js";
import { createProviderRoles } from "../create-provider.js";
import { resolveConnection, resolveLLMRoles, resolveSessionOverride } from "../resolve.js";
import type { LLMConfigV2, ZhixingConfig } from "../types.js";

function createMemorySecretStore(): SecretStorePort &
  CredentialStoreCoordinator & {
    readonly entries: Map<string, string>;
  } {
  const entries = new Map<string, string>();
  const keyOf = (ref: SecretRef) => `${ref.kind}/${ref.bindingId}`;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    entries,
    async unlockState() {
      return "unlocked";
    },
    async get(ref) {
      return entries.get(keyOf(ref)) ?? null;
    },
    async put(ref, value) {
      entries.set(keyOf(ref), value);
    },
    async delete(ref) {
      entries.delete(keyOf(ref));
    },
    async list(prefix) {
      const out: SecretRef[] = [];
      for (const full of entries.keys()) {
        if (!full.startsWith(prefix)) continue;
        const slash = full.indexOf("/");
        out.push({
          kind: full.slice(0, slash) as SecretRef["kind"],
          bindingId: full.slice(slash + 1),
        });
      }
      return out;
    },
    async runExclusive<T>(op: () => Promise<T>): Promise<T> {
      const next = tail.then(op, op);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

function makeTempDir(): Promise<string> {
  return createTempDir("u1-providers");
}

describe("Unit 1 Group A: v2 storage, safe migration, retirement, revocation & single-hop transport", () => {
  it("migrates verified v1 config to v2, removes root modelCapabilityOverrides, protects unconfirmed custom baseUrl, and writes modelConfigVersion=2", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "config.jsonc");
    const store = createMemorySecretStore();

    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          main: { provider: "deepseek", model: "deepseek-v4-pro" },
          light: { provider: "custom-gw", model: "my-model" },
        },
        modelCapabilityOverrides: {
          "DeepSeek-V4-Pro": { optimalMaxTokens: 32000, riskMaxTokens: 64000 },
        },
        workspace: { root: dir },
      }),
      "utf8",
    );

    await writeCredentials(
      {
        providers: {
          deepseek: { apiKey: "sk-ds-live" },
          "custom-gw": {
            apiKey: "sk-gw-live",
            baseUrl: "https://gw.private.example/secret-path-token/v1",
            protocol: "openai-compatible",
          },
        },
      },
      { store },
    );

    const first = await migrateConfigurationV1ToV2({ configPath, store });
    expect(first.status).toBe("migrated");
    expect(first.protectedLegacyProviderIds).toEqual(["custom-gw"]);

    // 幂等重跑不覆盖
    const second = await migrateConfigurationV1ToV2({ configPath, store });
    expect(second.status).toBe("already-v2");

    const diskRaw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(diskRaw.modelCapabilityOverrides).toBeUndefined();
    expect(JSON.stringify(diskRaw)).not.toContain("secret-path-token");
    expect(JSON.stringify(diskRaw)).not.toContain("sk-ds-live");
    expect(JSON.stringify(diskRaw)).not.toContain("sk-gw-live");

    const config = loadConfig({ configPath, noAutoCreate: true });
    expect(config.llm?.schemaVersion).toBe(2);
    expect(config.llm?.connections.deepseek?.endpoint).toBe("https://api.deepseek.com");
    expect(config.llm?.connections["custom-gw"]).toBeUndefined();
    expect(config.llm?.main).toEqual({ connectionId: "deepseek", model: "deepseek-v4-pro" });
    expect(config.llm?.attentionPolicies?.["deepseek-v4-pro"]).toEqual({
      optimalMaxTokens: 32000,
      riskMaxTokens: 64000,
    });

    const manifest = await readManifestMetadataUnlocked(store);
    expect(manifest?.modelConfigVersion).toBe(2);

    const creds = await loadCredentials({ store });
    expect(creds.modelSecrets?.deepseek).toEqual({
      v: 2,
      kind: "api-key",
      value: "sk-ds-live",
    });
    expect(creds.protectedLegacyProviders?.["custom-gw"]?.baseUrl).toBe(
      "https://gw.private.example/secret-path-token/v1",
    );
  });

  it("blocks auto-migration and preserves original v1 pair when legacy baseUrl contains explicit URL credentials or query auth", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "config.jsonc");
    const store = createMemorySecretStore();

    writeFileSync(
      configPath,
      JSON.stringify({
        llm: { main: { provider: "leaked", model: "m1" } },
        workspace: { root: dir },
      }),
      "utf8",
    );
    await writeCredentials(
      {
        providers: {
          leaked: {
            apiKey: "sk-1",
            baseUrl: "https://api.example.com/v1?api_key=embedded-secret",
            protocol: "openai-compatible",
          },
        },
      },
      { store },
    );

    const result = await migrateConfigurationV1ToV2({ configPath, store });
    expect(result.status).toBe("blocked");
    expect(result.blockedProviders).toEqual(["leaked"]);

    const diskRaw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect((diskRaw.llm as Record<string, unknown>).schemaVersion).toBeUndefined();
    const creds = await loadCredentials({ store });
    expect(creds.providers?.leaked?.apiKey).toBe("sk-1");
  });

  it("writes modelConfigVersion=2 even for pure no-key v2 config and preserves it across MCP-only edits", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "config.jsonc");
    const store = createMemorySecretStore();

    const emptyConfig = loadConfig({ configPath });
    expect(emptyConfig.llm?.schemaVersion).toBe(2);
    expect(emptyConfig.llm?.main).toBeUndefined();

    const nextLlm: LLMConfigV2 = {
      schemaVersion: 2,
      connections: {
        ollama: {
          name: "Ollama Local",
          adapter: "openai-compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          auth: { mode: "none" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: { connectionId: "ollama", model: "qwen3:8b" },
    };

    await editConfiguration(
      { config: emptyConfig, credentials: {} },
      { config: { ...emptyConfig, llm: nextLlm }, credentials: {} },
      { configPath, store },
    );

    const manifestAfterNoKey = await readManifestMetadataUnlocked(store);
    expect(manifestAfterNoKey?.modelConfigVersion).toBe(2);

    // 后续仅 MCP 编辑必须保留 modelConfigVersion = 2
    const snap = await loadConfigurationSnapshot({ configPath, store });
    await editConfiguration(
      { config: snap.config, credentials: snap.credentials },
      {
        config: {
          ...snap.config,
          mcp: { servers: { docs: { transport: "stdio", command: "echo", enabled: true } } },
        },
        credentials: { ...snap.credentials, mcp: { docs: { TOKEN: "abc" } } },
      },
      { configPath, store, scope: "mcp" },
    );

    const manifestAfterMcp = await readManifestMetadataUnlocked(store);
    expect(manifestAfterMcp?.modelConfigVersion).toBe(2);

    // 免密连接可正常解析且不需要假 API Key
    const roles = resolveLLMRoles(snap.config, snap.credentials);
    expect(roles.main.resolved.authMode).toBe("none");
    expect(roles.main.resolved.apiKey).toBe("");
  });

  it("handles durable connection retirement (shared vs unshared), explicit revocation (no resurrection), and compromised opaque-token rotation", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "config.jsonc");
    const store = createMemorySecretStore();
    const initial = loadConfig({ configPath });

    const llm: LLMConfigV2 = {
      schemaVersion: 2,
      connections: {
        c1: {
          name: "Conn 1",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com",
          auth: { mode: "api-key", secretRef: "shared-ref" },
          network: { proxy: "inherit" },
        },
        c2: {
          name: "Conn 2",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com",
          auth: { mode: "api-key", secretRef: "shared-ref" },
          network: { proxy: "inherit" },
        },
        c3: {
          name: "Conn 3",
          adapter: "openai-compatible",
          endpoint: "https://api.openai.com/v1",
          auth: { mode: "header", headerName: "X-Custom-Auth", secretRef: "solo-ref" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "c1", model: "deepseek-chat" },
    };

    await editConfiguration(
      { config: initial, credentials: {} },
      {
        config: { ...initial, llm },
        credentials: {
          version: 2,
          modelSecrets: {
            "shared-ref": { v: 2, kind: "api-key", value: "sk-shared" },
            "solo-ref": { v: 2, kind: "header", value: "hdr-solo" },
          },
        },
      },
      { configPath, store },
    );

    // 1. 删除 c2（共用 shared-ref）+ 删除 c3（独占 solo-ref，初始处于在途）
    const snap1 = await loadConfigurationSnapshot({ configPath, store });
    const nextLlm1: LLMConfigV2 = {
      ...snap1.config.llm!,
      connections: { c1: snap1.config.llm!.connections.c1! },
    };
    await editConfiguration(
      { config: snap1.config, credentials: snap1.credentials },
      { config: { ...snap1.config, llm: nextLlm1 }, credentials: snap1.credentials },
      {
        configPath,
        store,
        modelRetirements: [
          {
            operationId: "op-1",
            connectionId: "c2",
            secretRef: "shared-ref",
            mode: "retire",
            sourceRevision: "rev-1",
            createdAt: new Date().toISOString(),
          },
          {
            operationId: "op-2",
            connectionId: "c3",
            secretRef: "solo-ref",
            mode: "retire",
            sourceRevision: "rev-1",
            createdAt: new Date().toISOString(),
          },
        ],
      },
    );

    // c3 在途时保留 solo-ref，c2 结算后因 c1 共用保留 shared-ref
    const inFlightResult = await settlePendingModelRetirements({
      configPath,
      store,
      inFlightConnectionIds: new Set(["c3"]),
    });
    expect(inFlightResult).toEqual({ settled: 1, remaining: 1 });
    expect((await loadCredentials({ store })).modelSecrets?.["shared-ref"]?.value).toBe("sk-shared");
    expect((await loadCredentials({ store })).modelSecrets?.["solo-ref"]?.value).toBe("hdr-solo");

    // c3 结束后引用归零，幂等清理 solo-ref 且保留 shared-ref
    const drainedResult = await settlePendingModelRetirements({ configPath, store });
    expect(drainedResult).toEqual({ settled: 1, remaining: 0 });
    const credsAfterDrain = await loadCredentials({ store });
    expect(credsAfterDrain.modelSecrets?.["shared-ref"]?.value).toBe("sk-shared");
    expect(credsAfterDrain.modelSecrets?.["solo-ref"]).toBeUndefined();
    expect(await readPendingModelRetirementsUnlocked(store)).toEqual([]);

    // 2. 封禁凭据（compromised）不透明基线令牌轮换
    const snapComp = await loadConfigurationSnapshot({
      configPath,
      store,
      authorizeCredentialRead: async ({ kind, id }) => !(kind === "provider" && id === "shared-ref"),
    });
    expect(snapComp.credentials.modelSecrets?.["shared-ref"]).toBeUndefined();
    expect(snapComp.credentials.compromisedModelSecretTokens?.["shared-ref"]).toBe(
      compromisedSecretToken(snapComp.generation!, "shared-ref"),
    );

    await editConfiguration(
      { config: snapComp.config, credentials: snapComp.credentials },
      {
        config: snapComp.config,
        credentials: {
          ...snapComp.credentials,
          modelSecrets: {
            ...snapComp.credentials.modelSecrets,
            "shared-ref": { v: 2, kind: "api-key", value: "sk-rotated-new" },
          },
        },
      },
      { configPath, store },
    );
    expect((await loadCredentials({ store })).modelSecrets?.["shared-ref"]?.value).toBe("sk-rotated-new");

    // 3. 显式撤权：持久解绑，重启不复活，解析拒绝
    const snapRev = await loadConfigurationSnapshot({ configPath, store });
    await editConfiguration(
      { config: snapRev.config, credentials: snapRev.credentials },
      {
        config: snapRev.config,
        credentials: {
          ...snapRev.credentials,
          revokedModelSecretRefs: ["shared-ref"],
        },
      },
      { configPath, store },
    );
    const snapAfterRevoke = await loadConfigurationSnapshot({ configPath, store });
    expect(snapAfterRevoke.credentials.modelSecrets?.["shared-ref"]).toBeUndefined();
    expect(snapAfterRevoke.credentials.revokedModelSecretRefs).toEqual(["shared-ref"]);
    expect(() =>
      resolveConnection("c1", snapAfterRevoke.config.llm!.connections.c1!, snapAfterRevoke.credentials),
    ).toThrow(/已显式撤销/);
  });

  it("rejects reserved management secretRef paths, unsafe public config fields, and unimplemented adapters", () => {
    const badConfig: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          bad: {
            name: "Bad",
            adapter: "openai-compatible",
            endpoint: "https://user:pass@api.example.com/v1?api_key=123",
            auth: { mode: "header", headerName: "Host", secretRef: MODEL_RETIREMENTS_REF.bindingId },
            network: { proxy: "inherit" },
          },
        },
      },
    };
    const issues = validateConfigSemantics(badConfig);
    expect(issues.length).toBeGreaterThanOrEqual(4);

    // 单元 2 四协议全部就绪后，能力门控继续拒绝未知/未实现的适配器标识
    expect(() =>
      resolveConnection(
        "future",
        {
          name: "Future",
          adapter: "future-unimplemented" as unknown as "openai-responses",
          endpoint: "https://api.example.com/v1",
          auth: { mode: "api-key", secretRef: "oa" },
          network: { proxy: "inherit" },
        },
        { modelSecrets: { oa: { v: 2, kind: "api-key", value: "sk-1" } } },
      ),
    ).toThrow(/尚未实现受控适配/);
  });

  it("enforces sessionOverride isolation (never rebinds light) and resolveMaxOutputTokens contract", () => {
    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          connA: {
            name: "A",
            adapter: "openai-compatible",
            endpoint: "https://api.deepseek.com",
            auth: { mode: "api-key", secretRef: "refA" },
            network: { proxy: "inherit" },
          },
          connB: {
            name: "B",
            adapter: "anthropic-messages",
            endpoint: "https://api.anthropic.com",
            auth: { mode: "api-key", secretRef: "refB" },
            network: { proxy: "inherit" },
          },
        },
        main: { connectionId: "connA", model: "m-main" },
        light: { connectionId: "connA", model: "m-light" },
        power: { connectionId: "connB", model: "m-power" },
      },
    };
    const credentials = {
      modelSecrets: {
        refA: { v: 2 as const, kind: "api-key" as const, value: "sk-a" },
        refB: { v: 2 as const, kind: "api-key" as const, value: "sk-b" },
      },
    };

    const { roles, resolvedRoles, sessionPrimary, effectivePrimary } = createProviderRoles({
      config,
      credentials,
      primaryRole: "main",
      sessionOverride: { mode: "override", connectionId: "connB", model: "m-session-override" },
    });
    // F7 / 设计 §5.1 硬不变量：roles.main 与 roles.light 均保持纯用途默认，绝不被 sessionOverride 覆盖
    expect(roles.main.provider.id).toBe("connA");
    expect(roles.main.model).toBe("m-main");
    expect(roles.light.provider.id).toBe("connA");
    expect(roles.light.model).toBe("m-light");
    expect(resolvedRoles.main.resolved.id).toBe("connA");
    expect(resolvedRoles.light.resolved.id).toBe("connA");
    expect(sessionPrimary?.provider.id).toBe("connB");
    expect(sessionPrimary?.model).toBe("m-session-override");
    expect(effectivePrimary?.resolved.id).toBe("connB");

    expect(resolveSessionOverride(config, credentials, { mode: "follow-default" })).toBeUndefined();

    const maxOut = resolveMaxOutputTokens({
      userPreference: 16000,
      modelCatalogMaxOutput: 8192,
      protocolDefault: 4096,
      hardCap: 12000,
      thinkingBudget: 12000,
    });
    expect(maxOut.source).toBe("user-preference");
    expect(maxOut.maxTokens).toBe(12000);
    expect(maxOut.adjusted).toBe(true);
    expect(maxOut.adjustmentReasons.length).toBe(2);
  });

  it("stops cross-origin redirect before contacting new origin and protects undelivered ledger on first-hop 3xx and proxy tunnel errors", async () => {
    const contacted: string[] = [];
    const crossTransport = createConnectionDeliveryFetch({
      proxyPolicy: "direct",
      rawFetch: async (input) => {
        contacted.push(String(input));
        return new Response(null, {
          status: 307,
          headers: { location: "https://evil.example.com/steal" },
        });
      },
    });
    const rec1 = newDelivery();
    await expect(
      withDelivery(rec1, () => crossTransport.fetch("https://api.example.com/v1/chat")),
    ).rejects.toThrow(/跨源重定向/);
    expect(contacted).toEqual(["https://api.example.com/v1/chat"]);
    expect(provenUndelivered(rec1)).toBe(false);

    // 首跳 307 同源后次跳连接拒绝：已收到首跳响应，不能标未送达
    let hop = 0;
    const sameOrigin3xx = createConnectionDeliveryFetch({
      proxyPolicy: "direct",
      rawFetch: async () => {
        hop += 1;
        if (hop === 1) {
          return new Response(null, { status: 307, headers: { location: "/v2/chat" } });
        }
        const err = new Error("connect refused") as NodeJS.ErrnoException;
        err.code = "ECONNREFUSED";
        throw err;
      },
    });
    const rec2 = newDelivery();
    await expect(
      withDelivery(rec2, () => sameOrigin3xx.fetch("https://api.example.com/v1/chat")),
    ).rejects.toThrow();
    expect(provenUndelivered(rec2)).toBe(false);

    // 代理路径隧道后错误不得轻率标未送达
    const proxyTunnelErr = createConnectionDeliveryFetch({
      proxyPolicy: "inherit",
      networkProxy: "http://127.0.0.1:7890",
      rawFetch: async () => {
        const err = new Error("TLS socket hang up over tunnel") as NodeJS.ErrnoException;
        err.code = "ECONNREFUSED";
        throw err;
      },
    });
    const rec3 = newDelivery();
    await expect(
      withDelivery(rec3, () => proxyTunnelErr.fetch("https://api.example.com/v1/chat")),
    ).rejects.toThrow();
    expect(provenUndelivered(rec3)).toBe(false);

    // 直连首跳建连拒绝：标未送达
    const directRefused = createConnectionDeliveryFetch({
      proxyPolicy: "direct",
      rawFetch: async () => {
        const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
        err.code = "ECONNREFUSED";
        throw err;
      },
    });
    const rec4 = newDelivery();
    await expect(
      withDelivery(rec4, () => directRefused.fetch("https://api.example.com/v1/chat")),
    ).rejects.toThrow();
    expect(provenUndelivered(rec4)).toBe(true);
    // 跨源 307 重定向不泄露未经确认的 Location 路径 token，且 fetch(Request) 保留 method/headers/body
    let capturedMethod: string | undefined;
    let capturedHeader: string | null = null;
    let capturedBodyText = "";
    const reqPreservingTransport = createConnectionDeliveryFetch({
      proxyPolicy: "direct",
      rawFetch: async (_url, init) => {
        capturedMethod = init?.method;
        capturedHeader = new Headers(init?.headers).get("x-test-token");
        if (init?.body instanceof Uint8Array) {
          capturedBodyText = new TextDecoder().decode(init.body);
        } else if (typeof init?.body === "string") {
          capturedBodyText = init.body;
        }
        return new Response(null, {
          status: 307,
          headers: { location: "https://evil.example.com/private-path-token/v1?secret=leak" },
        });
      },
    });
    const reqObj = new Request("https://api.example.com/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-token": "ok-123" },
      body: JSON.stringify({ hello: "world" }),
    });
    let caughtErr: Error | undefined;
    try {
      await reqPreservingTransport.fetch(reqObj);
    } catch (err) {
      caughtErr = err as Error;
    }
    expect(capturedMethod).toBe("POST");
    expect(capturedHeader).toBe("ok-123");
    expect(capturedBodyText).toBe('{"hello":"world"}');
    expect(caughtErr?.message).toContain("https://evil.example.com");
    expect(caughtErr?.message).not.toContain("private-path-token");
    expect(caughtErr?.message).not.toContain("secret=leak");

    expect(CONFIGURATION_EDIT_REF.bindingId).toBe("configuration/edit-v1");
  });

  it("P3 + F4: preserves recreated same-ID connection new secret across stale retire settlement and auto-settles on startup/recovery", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "config.jsonc");
    const store = createMemorySecretStore();
    const initial = loadConfig({ configPath });

    const llm1: LLMConfigV2 = {
      schemaVersion: 2,
      connections: {
        connA: {
          name: "Conn A",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "connA" },
          network: { proxy: "inherit" },
        },
        connB: {
          name: "Conn B",
          adapter: "openai-compatible",
          endpoint: "https://api.openai.com/v1",
          auth: { mode: "api-key", secretRef: "connB" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "connB", model: "gpt-4o" },
    };

    await editConfiguration(
      { config: initial, credentials: {} },
      {
        config: { ...initial, llm: llm1 },
        credentials: {
          version: 2,
          modelSecrets: {
            connA: { v: 2, kind: "api-key", value: "sk-old-A" },
            connB: { v: 2, kind: "api-key", value: "sk-B" },
          },
        },
      },
      { configPath, store },
    );

    // 1. 删除 connA（mode: retire，记录 secretHash），假设此时 connA 有在途运行
    const snapBeforeDel = await loadConfigurationSnapshot({ configPath, store });
    const llmAfterDel: LLMConfigV2 = {
      ...snapBeforeDel.config.llm!,
      connections: { connB: snapBeforeDel.config.llm!.connections.connB! },
    };
    await editConfiguration(
      { config: snapBeforeDel.config, credentials: snapBeforeDel.credentials },
      { config: { ...snapBeforeDel.config, llm: llmAfterDel }, credentials: snapBeforeDel.credentials },
      {
        configPath,
        store,
        modelRetirements: [
          {
            operationId: "op-retire-A",
            connectionId: "connA",
            secretRef: "connA",
            mode: "retire",
            sourceRevision: "rev-1",
            createdAt: new Date().toISOString(),
          },
        ],
      },
    );

    const queued = await readPendingModelRetirementsUnlocked(store);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.secretHash).toMatch(/^[0-9a-f]{64}$/u);

    // 2. 在途尚未结束时，用户用同 ID "connA" 和新密钥 "sk-new-recreated-A" 重建连接
    const snapBeforeRecreate = await loadConfigurationSnapshot({ configPath, store });
    await editConfiguration(
      { config: snapBeforeRecreate.config, credentials: snapBeforeRecreate.credentials },
      {
        config: {
          ...snapBeforeRecreate.config,
          llm: {
            ...snapBeforeRecreate.config.llm!,
            connections: {
              ...snapBeforeRecreate.config.llm!.connections,
              connA: {
                name: "Conn A Recreated",
                adapter: "openai-compatible",
                endpoint: "https://api.deepseek.com/v1",
                auth: { mode: "api-key", secretRef: "connA" },
                network: { proxy: "inherit" },
              },
            },
          },
        },
        credentials: {
          ...snapBeforeRecreate.credentials,
          modelSecrets: {
            ...snapBeforeRecreate.credentials.modelSecrets,
            connA: { v: 2, kind: "api-key", value: "sk-new-recreated-A" },
          },
        },
      },
      { configPath, store },
    );

    // 3. 旧在途结束，结算旧 retire：绝不能删掉重建后的 connA 新密钥！
    const settledRecreate = await settlePendingModelRetirements({ configPath, store });
    expect(settledRecreate).toEqual({ settled: 1, remaining: 0 });
    expect((await loadCredentials({ store })).modelSecrets?.connA?.value).toBe("sk-new-recreated-A");

    // 4. F4：再次删除 connA 后不做显式 settle，经冷启动 loadConfigurationSnapshot({ settleRetirements: true }) 自动清理
    const snap2 = await loadConfigurationSnapshot({ configPath, store });
    await editConfiguration(
      { config: snap2.config, credentials: snap2.credentials },
      {
        config: {
          ...snap2.config,
          llm: {
            ...snap2.config.llm!,
            connections: { connB: snap2.config.llm!.connections.connB! },
          },
        },
        credentials: snap2.credentials,
      },
      {
        configPath,
        store,
        modelRetirements: [
          {
            operationId: "op-retire-A-2",
            connectionId: "connA",
            secretRef: "connA",
            mode: "retire",
            sourceRevision: "rev-2",
            createdAt: new Date().toISOString(),
          },
        ],
      },
    );
    const coldBootSnap = await loadConfigurationSnapshot({
      configPath,
      store,
      autoMigrate: true,
      settleRetirements: true,
    });
    expect(coldBootSnap.pendingModelRetirements).toEqual([]);
    expect(coldBootSnap.credentials.modelSecrets?.connA).toBeUndefined();
    expect(coldBootSnap.credentials.modelSecrets?.connB?.value).toBe("sk-B");
  });

  it("P1 + F8: preserves protected legacy roles/overrides in migrationPending without leaking URL, and flags v2+v1 manifest mismatch", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "config.jsonc");
    const store = createMemorySecretStore();

    // P1: v1 config where main & light point to a protected custom endpoint with thinking + overrides + quirks
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          main: { provider: "corp_gw", model: "corp-m1", thinking: { mode: "effort", effort: "high" } },
          light: { provider: "corp_gw", model: "corp-m1-mini" },
        },
      }),
      "utf8",
    );
    await writeCredentials(
      {
        providers: {
          corp_gw: {
            apiKey: "sk-corp-secret",
            baseUrl: "https://gw.corp.example/internal-token-path/v1",
            protocol: "openai-compatible",
            models: ["corp-m1", "corp-m1-mini"],
            modelOverrides: { "corp-m1": { contextWindow: 65536, maxOutputTokens: 8192 } },
            modelInputCapabilities: { "corp-m1": { images: true } },
            quirks: { thinkingDialect: "deepseek" },
          },
        },
      },
      { store },
    );

    const mig = await migrateConfigurationV1ToV2({ configPath, store });
    expect(mig.status).toBe("migrated");
    expect(mig.protectedLegacyProviderIds).toEqual(["corp_gw"]);

    const rawPublicConfig = readFileSync(configPath, "utf8");
    expect(rawPublicConfig).not.toContain("internal-token-path");
    expect(rawPublicConfig).not.toContain("sk-corp-secret");

    const snap = await loadConfigurationSnapshot({ configPath, store });
    const llm = snap.config.llm as LLMConfigV2;
    expect(llm.migrationPending).toHaveLength(1);
    expect(llm.migrationPending![0]!.kind).toBe("protected-legacy-roles");
    expect(llm.migrationPending![0]!.legacyRoles?.main).toEqual({
      provider: "corp_gw",
      model: "corp-m1",
      thinking: { mode: "effort", effort: "high" },
    });
    expect(llm.migrationPending![0]!.legacyRoles?.light).toEqual({
      provider: "corp_gw",
      model: "corp-m1-mini",
    });

    // F8: v2 config paired with non-empty v1 SecretStore manifest MUST report mismatch in BOTH autoMigrate & plain read
    const dirMismatch = await makeTempDir();
    const mismatchConfigPath = path.join(dirMismatch, "config.jsonc");
    const mismatchStore = createMemorySecretStore();
    writeFileSync(
      mismatchConfigPath,
      JSON.stringify({
        llm: {
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
        },
      }),
      "utf8",
    );
    await writeCredentials(
      { providers: { deepseek: { apiKey: "sk-v1-legacy" } } },
      { store: mismatchStore },
    );
    const mismatchAuto = await loadConfigurationSnapshot({
      configPath: mismatchConfigPath,
      store: mismatchStore,
      autoMigrate: true,
    });
    expect(mismatchAuto.migration?.status).toBe("mismatch");
    const mismatchPlain = await loadConfigurationSnapshot({
      configPath: mismatchConfigPath,
      store: mismatchStore,
    });
    expect(mismatchPlain.migration?.status).toBe("mismatch");
    // Original v1 SecretStore MUST stay untouched
    expect((await loadCredentials({ store: mismatchStore })).providers?.deepseek?.apiKey).toBe(
      "sk-v1-legacy",
    );
  });

  it("clears revokedModelSecretRefs from persisted manifest when rotating the sole revoked secretRef to a new key", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "config.jsonc");
    const store = createMemorySecretStore();
    const init = await loadConfigurationSnapshot({ configPath, store });
    const llm: LLMConfigV2 = {
      schemaVersion: 2,
      connections: {
        solo: {
          name: "Solo",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "solo_ref" },
          network: { proxy: "inherit" },
        },
      },
      main: { connectionId: "solo", model: "deepseek-chat" },
    };
    await editConfiguration(
      init,
      {
        config: { ...init.config, llm },
        credentials: {
          version: 2,
          modelSecrets: { solo_ref: { v: 2, kind: "api-key", value: "sk-initial" } },
        },
      },
      { configPath, store, forceModelConfigVersion2: true },
    );

    const afterInit = await loadConfigurationSnapshot({ configPath, store });
    await editConfiguration(
      afterInit,
      {
        config: afterInit.config,
        credentials: {
          version: 2,
          modelSecrets: {},
          revokedModelSecretRefs: ["solo_ref"],
        },
      },
      { configPath, store, forceModelConfigVersion2: true },
    );
    const afterRevoke = await loadConfigurationSnapshot({ configPath, store });
    expect(afterRevoke.credentials.revokedModelSecretRefs).toEqual(["solo_ref"]);

    // Rotate sole revoked secretRef to a new value -> MUST clear revokedModelSecretRefs in persisted manifest!
    await editConfiguration(
      afterRevoke,
      {
        config: afterRevoke.config,
        credentials: {
          version: 2,
          modelSecrets: { solo_ref: { v: 2, kind: "api-key", value: "sk-rotated" } },
        },
      },
      { configPath, store, forceModelConfigVersion2: true },
    );
    const afterRotate = await loadConfigurationSnapshot({ configPath, store });
    expect(afterRotate.credentials.revokedModelSecretRefs).toBeUndefined();
    expect(afterRotate.credentials.modelSecrets?.solo_ref?.value).toBe("sk-rotated");
  });
});
