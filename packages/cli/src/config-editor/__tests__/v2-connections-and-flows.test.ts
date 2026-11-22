import { describe, expect, it } from "vitest";
import type { LLMConfigV2, ZhixingConfig, ZhixingCredentials } from "@zhixing-ai/providers";
import { checkModel } from "../checks/model.js";
import { modelSection } from "../sections/model.js";
import {
  confirmProtectedLegacyProvider,
  createInitialState,
  deleteConnection,
  dismissMigrationPendingItem,
  inspectConnectionDeleteImpact,
  setConfirmedRepairEndpoint,
  upsertConnection,
  writeConnectionSecret,
} from "../state.js";
import {
  buildConnectionConfigMeta,
  buildConnectionDeleteMeta,
  buildMigrationRepairProviderMeta,
} from "../model/entity.js";
import { resolveInputField } from "../model/input.js";
import { buildConnectionListMeta, buildMigrationRepairMeta } from "../model/list.js";
import { TerminalConfigurationEditor } from "../../terminal/configuration-editor.js";
import type { TerminalView } from "@zhixing-ai/terminal-ui/protocol";

describe("Unit 1 Group C: /config v2 connections, defaults, compromised rotation, migration repair & deletion", () => {
  it("first-run auto-binds main for a no-key local connection; regular add preserves existing defaults", () => {
    // 1. First-run empty v2 template
    const emptyConfig: ZhixingConfig = {
      llm: { schemaVersion: 2, connections: {} },
    };
    const emptyCreds: ZhixingCredentials = { version: 2 };
    expect(checkModel(emptyConfig, emptyCreds).length).toBeGreaterThan(0);

    let state = createInitialState(emptyConfig, emptyCreds);
    state = upsertConnection(
      state,
      "local_ollama",
      {
        name: "Local Ollama",
        adapter: "openai-compatible",
        endpoint: "http://127.0.0.1:11434/v1",
        auth: { mode: "none" },
        network: { proxy: "direct", allowPrivateOrigin: true },
        customModels: ["qwen2.5:14b"],
      },
      { autoBindMainModel: "qwen2.5:14b" },
    );

    const llmAfterFirst = state.config.llm as LLMConfigV2;
    expect(llmAfterFirst.main).toEqual({
      connectionId: "local_ollama",
      model: "qwen2.5:14b",
    });
    // No-key connection passes checkModel with ZERO blocking issues!
    expect(checkModel(state.config, state.credentials)).toEqual([]);

    // 2. Regular add when main already exists MUST preserve main/light/power defaults
    state = upsertConnection(
      state,
      "corp_gw",
      {
        name: "Corp Gateway",
        adapter: "openai-compatible",
        endpoint: "https://gw.corp.example/v1",
        auth: { mode: "header", headerName: "X-Corp-Key", secretRef: "corp_gw" },
        network: { proxy: "inherit" },
        customModels: ["corp-pro"],
      },
      { autoBindMainModel: "corp-pro" },
    );
    state = writeConnectionSecret(state, "corp_gw", "header", "gw-secret-123");

    const llmAfterSecond = state.config.llm as LLMConfigV2;
    expect(llmAfterSecond.main).toEqual({
      connectionId: "local_ollama",
      model: "qwen2.5:14b",
    });
    expect(llmAfterSecond.connections.corp_gw?.auth).toEqual({
      mode: "header",
      headerName: "X-Corp-Key",
      secretRef: "corp_gw",
    });
    expect(state.credentials.modelSecrets?.corp_gw).toEqual({
      v: 2,
      kind: "header",
      value: "gw-secret-123",
    });
  });

  it("displays compromised credentials as '已封禁 · 存在但不可读取' without secret leakage and unblocks on rotation", async () => {
    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          deepseek: {
            name: "DeepSeek",
            presetId: "deepseek",
            adapter: "openai-compatible",
            endpoint: "https://api.deepseek.com/v1",
            auth: { mode: "api-key", secretRef: "deepseek" },
            network: { proxy: "inherit" },
          },
        },
        main: { connectionId: "deepseek", model: "deepseek-chat" },
      },
    };
    const credentials: ZhixingCredentials = {
      version: 2,
      compromisedModelSecretTokens: { deepseek: "opaque-token-abc" },
    };

    const issues = checkModel(config, credentials);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.label).toContain("已封禁");

    const state = createInitialState(config, credentials);
    const entries = modelSection.entries(state);
    expect(entries[0]!.label).toBe("服务商连接");
    expect(entries[0]!.state.statusText).toContain("已封禁");
    const mainEntry = entries.find((e) => e.label.startsWith("主模型"))!;
    expect(mainEntry.state.kind).toBe("blocked");
    expect(mainEntry.state.statusText).toContain("已封禁 · 存在但不可读取");

    const connList = buildConnectionListMeta(state);
    expect(connList.items[0]!.description).toContain("已封禁 · 存在但不可读取");

    const connMeta = buildConnectionConfigMeta(state, {
      kind: "connection-config",
      connectionId: "deepseek",
    });
    const secretRow = connMeta.rows.find((r) => r.label === "API Key")!;
    expect(secretRow.status.text).toContain("已封禁 · 存在但不可读取");

    // Verify TerminalConfigurationEditor publishes compromised status without leaking token
    const published: Array<Omit<TerminalView, "generation">> = [];
    let saved = false;
    const editor = new TerminalConfigurationEditor({
      session: {
        initialConfig: config,
        initialCredentials: credentials,
        writers: {
          save: async () => {
            saved = true;
          },
        },
      },
      title: "配置",
      sections: ["model"],
      purpose: "edit",
      publish: async (view) => {
        published.push(view);
      },
    });
    const runPromise = editor.run();
    // Wait for initial publish then cancel -> zero save
    await new Promise((r) => setTimeout(r, 10));
    expect(JSON.stringify(published.at(-1))).toContain("已封禁");
    expect(JSON.stringify(published.at(-1))).not.toContain("opaque-token-abc");
    editor.cancel();
    const res = await runPromise;
    expect(res.kind).toBe("cancelled");
    expect(saved).toBe(false);

    // Rotate secret -> clears compromised token and passes checkModel
    const rotated = writeConnectionSecret(state, "deepseek", "api-key", "sk-new-rotated");
    expect(rotated.credentials.compromisedModelSecretTokens).toBeUndefined();
    expect(checkModel(rotated.config, rotated.credentials)).toEqual([]);
  });

  it("handles migration repair for protectedLegacyProviders and migrationPending", () => {
    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {},
        migrationPending: [
          {
            id: "unattributed-old",
            kind: "unattributed-override",
            sourceProviderId: "old",
            summary: "旧服务商缺少端点",
            legacyFields: { models: ["m1"] },
            createdAt: "2026-11-19T00:00:00.000Z",
          },
        ],
      },
    };
    const credentials: ZhixingCredentials = {
      version: 2,
      protectedLegacyProviders: {
        private_gw: {
          apiKey: "sk-legacy-private",
          baseUrl: "http://127.0.0.1:8088/v1",
          protocol: "openai-compatible",
          models: ["gw-model"],
        },
      },
    };
    let state = createInitialState(config, credentials);
    const sectionEntries = modelSection.entries(state);
    expect(sectionEntries.some((e) => e.label === "迁移待修复项")).toBe(true);

    const repairList = buildMigrationRepairMeta(state);
    expect(repairList.items.length).toBe(2);

    state = confirmProtectedLegacyProvider(state, "private_gw", {
      allowPrivateOrigin: true,
      autoBindMainModel: "gw-model",
    });
    expect(state.credentials.protectedLegacyProviders).toBeUndefined();
    expect(state.credentials.modelSecrets?.private_gw?.value).toBe("sk-legacy-private");
    const llm = state.config.llm as LLMConfigV2;
    expect(llm.connections.private_gw?.endpoint).toBe("http://127.0.0.1:8088/v1");
    expect(llm.connections.private_gw?.network.allowPrivateOrigin).toBe(true);
    expect(llm.main).toEqual({ connectionId: "private_gw", model: "gw-model" });

    state = dismissMigrationPendingItem(state, "unattributed-old");
    expect((state.config.llm as LLMConfigV2).migrationPending).toBeUndefined();
    expect(modelSection.entries(state).some((e) => e.label === "迁移待修复项")).toBe(false);
  });

  it("previews deletion impact, enforces main rebind, clears aux roles, and records retire vs revoke", () => {
    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          c1: {
            name: "Conn 1",
            adapter: "openai-compatible",
            endpoint: "https://api.deepseek.com/v1",
            auth: { mode: "api-key", secretRef: "ref-1" },
            network: { proxy: "inherit" },
          },
          c2: {
            name: "Conn 2",
            adapter: "openai-compatible",
            endpoint: "https://api.openai.com/v1",
            auth: { mode: "api-key", secretRef: "ref-2" },
            network: { proxy: "inherit" },
            customModels: ["gpt-4o"],
          },
        },
        main: { connectionId: "c1", model: "deepseek-chat" },
        light: { connectionId: "c1", model: "deepseek-chat" },
      },
    };
    const credentials: ZhixingCredentials = {
      version: 2,
      modelSecrets: {
        "ref-1": { v: 2, kind: "api-key", value: "sk-1" },
        "ref-2": { v: 2, kind: "api-key", value: "sk-2" },
      },
    };
    const state = createInitialState(config, credentials);
    const impact = inspectConnectionDeleteImpact(state, "c1");
    expect(impact.affectsMain).toBe(true);
    expect(impact.referencedRoles).toEqual(["main", "light"]);
    expect(impact.secretSharedWith).toEqual([]);
    expect(impact.candidateRebindConnections).toEqual(["c2"]);

    const delMeta = buildConnectionDeleteMeta(state, {
      kind: "connection-delete",
      connectionId: "c1",
      inFlightMode: "revoke",
    });
    expect(delMeta.description).toContain("main / light");

    // Deleting main connection without rebind MUST throw
    expect(() =>
      deleteConnection(state, { connectionId: "c1", mode: "retire" }),
    ).toThrow(/改绑/);

    // Deleting with rebindMain + mode: "revoke" updates main, clears light, records retirement & revocation & abort
    const afterRevoke = deleteConnection(state, {
      connectionId: "c1",
      rebindMain: { connectionId: "c2", model: "gpt-4o" },
      mode: "revoke",
    });
    const nextLlm = afterRevoke.config.llm as LLMConfigV2;
    expect(nextLlm.connections.c1).toBeUndefined();
    expect(nextLlm.main).toEqual({ connectionId: "c2", model: "gpt-4o" });
    expect(nextLlm.light).toBeUndefined();
    expect(afterRevoke.credentials.modelSecrets?.["ref-1"]).toBeUndefined();
    expect(afterRevoke.credentials.revokedModelSecretRefs).toEqual(["ref-1"]);
    expect(afterRevoke.abortConnectionIds).toEqual(["c1"]);
    expect(afterRevoke.modelRetirements).toHaveLength(1);
    expect(afterRevoke.modelRetirements![0]!.mode).toBe("revoke");
  });

  it("P1 + P2: redacts unconfirmed protected legacy URL in entity/input UI, restores roles/thinking/modelOverrides on confirm, and repairs blocked v1 URLs", () => {
    const secretPathUrl = "https://gw.corp.example/secret-tenant-token-999/v1";
    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {},
        migrationPending: [
          {
            id: "protected-roles-corp_gw",
            kind: "protected-legacy-roles",
            sourceProviderId: "corp_gw",
            summary: "受保护旧自定义端点待确认",
            legacyRoles: {
              main: {
                provider: "corp_gw",
                model: "corp-m1",
                thinking: { mode: "effort", effort: "high" },
              },
              light: {
                provider: "corp_gw",
                model: "corp-m1-mini",
              },
            },
            legacyFields: {
              modelOverrides: { "corp-m1": { contextWindow: 65536, maxOutputTokens: 8192 } },
              modelInputCapabilities: { "corp-m1": { images: true } },
              quirks: { thinkingDialect: "deepseek" },
              models: ["corp-m1", "corp-m1-mini"],
            },
            createdAt: "2026-11-19T00:00:00.000Z",
          },
        ],
      },
    };
    const credentials: ZhixingCredentials = {
      version: 2,
      protectedLegacyProviders: {
        corp_gw: {
          apiKey: "sk-corp-key",
          baseUrl: secretPathUrl,
          protocol: "openai-compatible",
          models: ["corp-m1", "corp-m1-mini"],
          modelOverrides: { "corp-m1": { contextWindow: 65536, maxOutputTokens: 8192 } },
          modelInputCapabilities: { "corp-m1": { images: true } },
          quirks: { thinkingDialect: "deepseek" },
        },
      },
    };

    let state = createInitialState(config, credentials);

    // P2: repair list, entity status.text, and input field MUST NOT leak raw protected path
    const repairList = buildMigrationRepairMeta(state);
    expect(JSON.stringify(repairList)).not.toContain("secret-tenant-token-999");
    expect(repairList.items).toHaveLength(1);

    const entityMeta = buildMigrationRepairProviderMeta(state, {
      kind: "migration-repair-provider",
      providerId: "corp_gw",
    });
    expect(JSON.stringify(entityMeta)).not.toContain("secret-tenant-token-999");
    expect(entityMeta.rows[0]!.status.text).toContain("https://gw.corp.example");
    expect(entityMeta.description).toContain("main=corp-m1");

    const inputMeta = resolveInputField("repair-endpoint:corp_gw", state);
    expect(inputMeta).not.toBeNull();
    expect(inputMeta!.sensitive).toBe(true);
    expect(inputMeta!.currentValue(state)).toBeUndefined();
    expect(inputMeta!.hint).not.toContain("secret-tenant-token-999");

    // P1: confirming restores main/light roles, thinking, merged modelOverrides, dialect, customModels, and clears pending
    state = confirmProtectedLegacyProvider(state, "corp_gw");
    const llm = state.config.llm as LLMConfigV2;
    expect(llm.connections.corp_gw?.endpoint).toBe(secretPathUrl);
    expect(llm.connections.corp_gw?.modelOverrides?.["corp-m1"]).toEqual({
      contextWindow: 65536,
      maxOutputTokens: 8192,
      supportsImages: true,
    });
    expect(llm.connections.corp_gw?.dialect).toEqual({ thinking: "deepseek" });
    expect(llm.connections.corp_gw?.customModels).toEqual(["corp-m1", "corp-m1-mini"]);
    expect(llm.main).toEqual({
      connectionId: "corp_gw",
      model: "corp-m1",
      params: { thinking: { mode: "effort", effort: "high" } },
    });
    expect(llm.light).toEqual({ connectionId: "corp_gw", model: "corp-m1-mini" });
    expect(llm.migrationPending).toBeUndefined();
    expect(state.credentials.protectedLegacyProviders).toBeUndefined();

    // P1 blocked v1 URL: checkModel blocks it, repair list surfaces it, secret-bearing URL is rejected, clean replacement converts to v2
    const blockedV1Config: ZhixingConfig = {
      llm: {
        main: { provider: "blocked_gw", model: "m-blocked" },
      },
    };
    const blockedV1Creds: ZhixingCredentials = {
      providers: {
        blocked_gw: {
          apiKey: "sk-1",
          baseUrl: "https://user:superpass@gw.example.com/v1?api_key=leak123",
          protocol: "openai-compatible",
        },
      },
    };
    expect(checkModel(blockedV1Config, blockedV1Creds).some((i) => i.label.includes("迁移修复"))).toBe(true);
    let blockedState = createInitialState(blockedV1Config, blockedV1Creds);
    const blockedList = buildMigrationRepairMeta(blockedState);
    expect(blockedList.items.some((i) => i.label.includes("blocked_gw"))).toBe(true);
    expect(JSON.stringify(blockedList)).not.toContain("superpass");
    expect(JSON.stringify(blockedList)).not.toContain("leak123");

    expect(() => confirmProtectedLegacyProvider(blockedState, "blocked_gw")).toThrow(/纯净端点/);
    const blockedEntity = buildMigrationRepairProviderMeta(blockedState, {
      kind: "migration-repair-provider",
      providerId: "blocked_gw",
    });
    expect(blockedEntity.rows[0]!.status.level).toBe("pending");
    expect(JSON.stringify(blockedEntity)).not.toContain("superpass");
    expect(JSON.stringify(blockedEntity)).not.toContain("leak123");

    blockedState = setConfirmedRepairEndpoint(blockedState, "blocked_gw", "https://gw.example.com/secret-subpath/v1");
    const overriddenEntity = buildMigrationRepairProviderMeta(blockedState, {
      kind: "migration-repair-provider",
      providerId: "blocked_gw",
    });
    expect(overriddenEntity.rows[0]!.status.level).toBe("ready");
    expect(overriddenEntity.rows[0]!.status.text).toContain("https://gw.example.com");
    expect(JSON.stringify(overriddenEntity)).not.toContain("secret-subpath");

    blockedState = setConfirmedRepairEndpoint(blockedState, "blocked_gw", "https://gw.example.com/v1");
    blockedState = confirmProtectedLegacyProvider(blockedState, "blocked_gw");
    const repairedLlm = blockedState.config.llm as LLMConfigV2;
    expect(repairedLlm.schemaVersion).toBe(2);
    expect(repairedLlm.connections.blocked_gw?.endpoint).toBe("https://gw.example.com/v1");
    expect(repairedLlm.main).toEqual({ connectionId: "blocked_gw", model: "m-blocked" });
    expect(checkModel(blockedState.config, blockedState.credentials)).toEqual([]);
  });
});
