import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_CURATED_CATALOG,
  ModelCatalogManager,
  ModelDiscoveryCache,
  computeCredentialRevisionToken,
  discoverConnectionModels,
  generateTufFourRoleKeySet,
  publishTufCatalogRepository,
  type CuratedCatalogBundle,
} from "@zhixing-ai/providers";
import type { TerminalView } from "@zhixing-ai/terminal-ui/protocol";
import { SUPPORTED_PROVIDERS } from "../registries/index.js";
import { TerminalConfigurationEditor } from "../terminal/configuration-editor.js";
import { buildConnectionConfigMeta } from "../config-editor/model/entity.js";
import { buildModelListMeta } from "../config-editor/model/list.js";
import {
  buildPresetConnection,
  createInitialState,
  recordDraftDiscoveryResult,
  upsertConnection,
  writeConnectionSecret,
} from "../config-editor/state.js";
import { ModelRuntimePort } from "../runtime/model-runtime-port.js";

const servers: http.Server[] = [];
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-unit3-cli-"));
  tempDirs.push(dir);
  return dir;
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ url: string }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}` };
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("Unit 3 · CLI single-source registry, hostless N draft isolation & ModelRuntimePort live catalog", () => {
  it("exposes all 11 presets from single source including Ollama (auth none) and Kimi corrected doc URL", () => {
    expect(SUPPORTED_PROVIDERS.map((p) => p.id)).toEqual([
      "deepseek",
      "qwen",
      "kimi",
      "glm",
      "minimax",
      "openai",
      "anthropic",
      "siliconflow",
      "openrouter",
      "google",
      "ollama",
    ]);
    const ollamaConn = buildPresetConnection("ollama")!;
    expect(ollamaConn.auth).toEqual({ mode: "none" });
    expect(ollamaConn.network).toEqual({ proxy: "direct", allowPrivateOrigin: true });
    expect(SUPPORTED_PROVIDERS.find((p) => p.id === "kimi")?.modelListDocUrl).toBe(
      "https://platform.kimi.ai/docs/api/list-models",
    );
  });

  it("runs hostless N draft discovery & voluntary verification locally without leaking draft secrets over published UI views and handles cancel cleanly", async () => {
    const draftSecret = "raw-draft-secret-MUST-NOT-LEAK-42";
    const verifyBodies: Array<Record<string, unknown>> = [];
    let discoverCount = 0;

    const { url } = await startServer((req, res, body) => {
      if (req.url === "/models") {
        discoverCount++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "deepseek-v4-pro" },
              { id: "secret-echo-model-ok" },
            ],
          }),
        );
        return;
      }
      if (req.url === "/chat/completions") {
        verifyBodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const publishedViews: Array<Omit<TerminalView, "generation">> = [];
    let saved = false;
    const editor = new TerminalConfigurationEditor({
      session: {
        initialConfig: {
          llm: {
            schemaVersion: 2,
            connections: {
              ds: {
                name: "DeepSeek Local",
                presetId: "deepseek",
                adapter: "openai-compatible",
                endpoint: url,
                auth: { mode: "api-key", secretRef: "ds" },
                network: { proxy: "direct", allowPrivateOrigin: true },
              },
            },
            main: { connectionId: "ds", model: "deepseek-v4-pro" },
          },
        },
        initialCredentials: {
          version: 2,
          modelSecrets: {
            ds: { v: 2, kind: "api-key", value: draftSecret },
          },
        },
        writers: {
          async save() {
            saved = true;
          },
        },
      },
      title: "配置",
      sections: ["model"],
      purpose: "setup",
      publish: async (view) => {
        publishedViews.push(view);
      },
    });

    const runPromise = editor.run();
    const latest = () => publishedViews.at(-1)!;
    const selectByLabel = async (substr: string) => {
      const view = latest();
      const idx = view.choices?.findIndex((c) => c.label.includes(substr)) ?? -1;
      if (idx < 0) throw new Error(`Choice containing "${substr}" not found in ${JSON.stringify(view.choices)}`);
      const choice = view.choices![idx]!;
      await editor.act({ kind: "configuration-action", editId: view.editId!, action: choice.id as never });
    };

    const waitIdle = async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (publishedViews.length > 0 && !latest().busy) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`Timed out waiting for editor idle; latest=${JSON.stringify(latest())}`);
    };

    // Wait initial publish
    await waitIdle();
    await selectByLabel("服务商连接");
    await selectByLabel("DeepSeek Local");
    // Trigger draft discovery locally in N
    await selectByLabel("发现 / 刷新模型列表");
    await waitIdle();
    expect(discoverCount).toBe(1);
    expect(latest().choices?.some((c) => c.detail?.includes("已发现 2 项"))).toBe(true);

    // Open voluntary verification confirmation screen (must NOT send before confirmation)
    await selectByLabel("可选生成验证");
    expect(verifyBodies.length).toBe(0);
    expect(latest().chromeDescription).toContain("费用说明");
    await selectByLabel("发验证");
    await waitIdle();
    expect(verifyBodies.length).toBe(1);
    expect(Number(verifyBodies[0]!["max_tokens"])).toBeGreaterThanOrEqual(64);
    expect(latest().choices?.some((c) => c.detail?.includes("已验证"))).toBe(true);

    // Cancel editor -> MUST NOT commit!
    editor.cancel();
    const outcome = await runPromise;
    expect(outcome.kind).toBe("cancelled");
    expect(saved).toBe(false);

    // Zero draft secrets leaked across ANY published view from N -> U!
    const serializedViews = JSON.stringify(publishedViews);
    expect(serializedViews).not.toContain(draftSecret);
  });

  it("consumes merged catalog + discovered + custom + overrides in model-list and updates ModelRuntimePort from TUF-activated catalog", async () => {
    // 1. model-list merges catalog, discovered, custom, and filters structured non-chat
    let state = createInitialState({}, {});
    state = upsertConnection(state, "or", {
      ...buildPresetConnection("openrouter")!,
      customModels: ["my-pinned-custom"],
      modelOverrides: { "openai/gpt-6.2-astra": { contextWindow: 300_000 } },
    });
    state = recordDraftDiscoveryResult(state, "or", {
      status: "discovered",
      checkedAt: "2026-11-20T00:00:00Z",
      sanitizedEndpoint: "https://openrouter.ai/api/v1",
      proxyRoute: "inherit",
      modeUsed: "native",
      authoritativeNativeFacts: false,
      models: [
        { id: "vendor/newly-discovered-chat", outputModalities: ["text"] },
        { id: "vendor/embed-only", outputModalities: ["embedding"] },
      ],
      userMessage: "ok",
    });
    const listMeta = buildModelListMeta(state, { kind: "model-list", role: "main", providerId: "or" });
    const labels = listMeta.items.map((i) => i.label);
    expect(labels).toContain("openai/gpt-6.2-astra");
    expect(labels).toContain("vendor/newly-discovered-chat");
    expect(labels).toContain("my-pinned-custom");
    expect(labels).not.toContain("vendor/embed-only");

    // 2. ModelCatalogManager + ModelRuntimePort consume a TUF-verified updated catalog revision
    const repoDir = await makeTempDir();
    const homeDir = await makeTempDir();
    const keys = generateTufFourRoleKeySet();
    const updatedBundle: CuratedCatalogBundle = {
      ...structuredClone(BUILTIN_CURATED_CATALOG),
      catalogRevision: "2026.11.20-live-serve-r2",
      publishedAt: "2026-11-20T03:00:00Z",
      attentionThresholds: {
        ...BUILTIN_CURATED_CATALOG.attentionThresholds,
        "deepseek-v4-pro": {
          modelKey: "deepseek-v4-pro",
          optimalMaxTokens: 192_000,
          riskMaxTokens: 320_000,
          source: "Updated MRCR curve",
          verifiedAt: "2026-11-20T03:00:00Z",
        },
      },
    };
    const published = await publishTufCatalogRepository({
      outputDir: repoDir,
      catalog: updatedBundle,
      keys,
    });
    const { url } = await startServer(async (req, res) => {
      const rel = (req.url ?? "/").replace(/^\/+/u, "");
      try {
        const bytes = await fs.readFile(path.join(repoDir, rel));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(bytes);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });

    const manager = new ModelCatalogManager({
      homeDir,
      repository: {
        metadataBaseUrl: `${url}/metadata`,
        targetsBaseUrl: `${url}/targets`,
        targetPath: "catalog-v1.json",
        bootstrapRootBytes: published.rootBytes,
        network: { proxy: "direct", allowPrivateOrigin: true },
      },
    });
    await manager.initialize();
    const runtimePort = new ModelRuntimePort({
      modelConfiguration: {
        llm: {
          schemaVersion: 2,
          connections: {
            ds: buildPresetConnection("deepseek")!,
          },
          main: { connectionId: "ds", model: "deepseek-v4-pro" },
        },
      },
      providerCredentials: {
        version: 2,
        modelSecrets: { ds: { v: 2, kind: "api-key", value: "sk-test" } },
      },
      exposureCredentials: {},
      credentialGeneration: "g1",
      catalog: manager.port(),
    });
    const revBeforeCatalogUpdate = runtimePort.snapshot().revision;
    const seenUpdates: string[] = [];
    runtimePort.onUpdate((snap) => seenUpdates.push(snap.revision));
    manager.onUpdate((port) => runtimePort.setCatalogPort(port));

    expect(runtimePort.optimalMaxTokens()).toBe(128_000);
    const refreshed = await manager.refresh({ force: true });
    expect(refreshed.status).toBe("updated");
    // R2 F1: setCatalogPort MUST advance snapshot().revision AND notify onUpdate listeners synchronously!
    expect(runtimePort.snapshot().revision).not.toBe(revBeforeCatalogUpdate);
    expect(seenUpdates.length).toBeGreaterThanOrEqual(1);
    expect(seenUpdates.at(-1)).toBe(runtimePort.snapshot().revision);
    // RuntimePort atomically observes the new trusted catalog's attention threshold!
    expect(runtimePort.optimalMaxTokens()).toBe(192_000);
    await runtimePort.dispose();
  });

  it("R2 F2: ModelRuntimePort loads ModelDiscoveryCache facts, clamps Layer-1 overrides in session validation & optimalMaxTokens, and invalidates on credential rotation", async () => {
    const homeDir = await makeTempDir();
    const discoveryCache = new ModelDiscoveryCache({ homeDir });
    const anthConn = {
      ...buildPresetConnection("anthropic")!,
      auth: { mode: "api-key" as const, secretRef: "anth" },
      modelOverrides: {
        "claude-discovered-tight": {
          contextWindow: 99_999,
          maxOutputTokens: 9_999,
          supportsImages: true,
        },
      },
    };
    const secretA = "sk-ant-cache-a";
    const secretB = "sk-ant-cache-b";
    await discoveryCache.writeProbeResult({
      connectionId: "anth",
      endpoint: anthConn.endpoint,
      adapter: anthConn.adapter,
      credentialRevision: computeCredentialRevisionToken({ authMode: "api-key", secretValue: secretA }),
    }, {
      status: "discovered",
      checkedAt: new Date().toISOString(),
      sanitizedEndpoint: anthConn.endpoint,
      modeUsed: "native",
      authoritativeNativeFacts: true,
      models: [
        {
          id: "claude-discovered-tight",
          contextWindow: 4096,
          maxOutputTokens: 64,
          supportsImages: false,
          supportsTools: true,
        },
      ],
      userMessage: "ok",
    });

    const runtimePort = new ModelRuntimePort({
      modelConfiguration: {
        llm: {
          schemaVersion: 2,
          connections: { anth: anthConn },
          main: { connectionId: "anth", model: "claude-discovered-tight" },
        },
      },
      providerCredentials: {
        version: 2,
        modelSecrets: { anth: { v: 2, kind: "api-key", value: secretA } },
      },
      exposureCredentials: {},
      credentialGeneration: "g1",
      discoveryCache,
    });
    await runtimePort.ensureFreshBeforeAdmission();

    // RuntimePort loaded matching discovery facts & clamped contextWindow (4096 -> optimal 2048, NOT 49999!)
    expect(runtimePort.discoveryByConnection()["anth"]?.authoritativeNativeFacts).toBe(true);
    expect(runtimePort.optimalMaxTokens()).toBe(2048);

    // Pre-send image validation rejects image on authoritative supportsImages=false despite raw override supportsImages=true!
    const imageCheckErr = await runtimePort.validateSessionModelSelection({
      conversationId: "conv-r2-f2",
      modelSelection: { mode: "override", connectionId: "anth", model: "claude-discovered-tight" },
      activeWindowMessages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "AA==" } }],
        },
      ],
    });
    expect(typeof imageCheckErr).toBe("string");
    expect(imageCheckErr).toContain("图片");

    // Credential rotation in applyUpdate invalidates old discovery partition
    const revBeforeRotate = runtimePort.snapshot().revision;
    const rotated = await runtimePort.applyUpdate({
      modelConfiguration: {
        llm: {
          schemaVersion: 2,
          connections: { anth: anthConn },
          main: { connectionId: "anth", model: "claude-discovered-tight" },
        },
      },
      providerCredentials: {
        version: 2,
        modelSecrets: { anth: { v: 2, kind: "api-key", value: secretB } },
      },
      exposureCredentials: {},
      credentialGeneration: "g2",
    });
    expect(rotated.applied).toBe(true);
    expect(runtimePort.snapshot().revision).not.toBe(revBeforeRotate);
    expect(runtimePort.discoveryByConnection()["anth"]).toBeUndefined();
    await runtimePort.dispose();
  });

  it("enforces 401 explicit second confirmation, 404 non-blocking save, and discards stale draftRevision results after key/endpoint change", () => {
    let state = createInitialState({}, {});
    const dsConn = buildPresetConnection("deepseek")!;
    const secretRef = dsConn.auth.mode === "api-key" ? dsConn.auth.secretRef : "deepseek";
    state = upsertConnection(state, "ds", dsConn);
    state = writeConnectionSecret(state, secretRef, "api-key", "sk-initial-1");
    const revBefore = state.draftRevision ?? 0;

    // 1. 401 blocks direct save until explicit "先存待修" confirmation
    state = recordDraftDiscoveryResult(state, "ds", {
      status: "auth-rejected",
      draftRevision: revBefore,
      checkedAt: "2026-11-20T00:00:00Z",
      sanitizedEndpoint: "https://api.deepseek.com",
      proxyRoute: "inherit",
      modeUsed: "native",
      authoritativeNativeFacts: false,
      models: [],
      httpStatus: 401,
      errorSubcode: "auth_invalid_credentials",
      userMessage: "401 rejected",
    });
    const meta401 = buildConnectionConfigMeta(state, { kind: "connection-config", connectionId: "ds" });
    const directSave = meta401.buttons.find((b) => b.label === "保存")!;
    const resBlocked = directSave.onEnter(state);
    expect(resBlocked.action.type).toBe("stay");
    expect(resBlocked.errorMessage).toContain("401");
    const saveAnyway = meta401.buttons.find((b) => b.label === "先存")!;
    expect(saveAnyway).toBeDefined();
    expect(saveAnyway.onEnter(state).action.type).toBe("pop");

    // 2. Rotating key increments draftRevision and discards stale discovery result with old draftRevision
    state = writeConnectionSecret(state, secretRef, "api-key", "sk-rotated-2");
    expect(state.draftRevision).toBeGreaterThan(revBefore);
    expect(state.draftDiscoveryByConnection?.["ds"]).toBeUndefined();
    const afterStale = recordDraftDiscoveryResult(state, "ds", {
      status: "auth-rejected",
      draftRevision: revBefore, // stale!
      checkedAt: "2026-11-20T00:00:01Z",
      sanitizedEndpoint: "https://api.deepseek.com",
      proxyRoute: "inherit",
      modeUsed: "native",
      authoritativeNativeFacts: false,
      models: [],
      userMessage: "stale 401",
    });
    expect(afterStale.draftDiscoveryByConnection?.["ds"]).toBeUndefined();

    // 3. 404 unsupported does NOT block direct save
    const state404 = recordDraftDiscoveryResult(state, "ds", {
      status: "unsupported",
      draftRevision: state.draftRevision,
      checkedAt: "2026-11-20T00:00:02Z",
      sanitizedEndpoint: "https://api.deepseek.com",
      proxyRoute: "inherit",
      modeUsed: "native",
      authoritativeNativeFacts: false,
      models: [],
      httpStatus: 404,
      userMessage: "404 unsupported",
    });
    const meta404 = buildConnectionConfigMeta(state404, { kind: "connection-config", connectionId: "ds" });
    expect(meta404.buttons.find((b) => b.label === "保存")!.onEnter(state404).action.type).toBe("pop");
  });

  it("R3 R2-1: reopened config-editor session (draftRevision=0) and post-invalidation session update ModelDiscoveryCache & ModelRuntimePort", async () => {
    let listedModel = "before-reopen";
    const { url } = await startServer((req, res) => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: listedModel, model: listedModel }] }));
        return;
      }
      if (req.url === "/api/show") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ capabilities: ["completion"], model_info: { "llama.context_length": 4096 } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const homeDir = await makeTempDir();
    const discoveryCache = new ModelDiscoveryCache({ homeDir });
    const baseConfig = {
      llm: {
        schemaVersion: 2 as const,
        connections: {
          local: {
            name: "Local Ollama",
            presetId: "ollama",
            adapter: "openai-compatible" as const,
            endpoint: url,
            auth: { mode: "none" as const },
            network: { proxy: "direct" as const, allowPrivateOrigin: true },
          },
        },
        main: { connectionId: "local", model: "before-reopen" },
      },
    };
    const runtime = {
      discoverModels: (input: Parameters<typeof discoverConnectionModels>[0]) =>
        discoverConnectionModels({ ...input, cache: discoveryCache }),
    };

    // Session 1: simulate 3 edits (draftRevision=3) then trigger real config-editor discovery row
    let session1 = createInitialState(baseConfig, {});
    session1 = { ...session1, draftRevision: 3 };
    const meta1 = buildConnectionConfigMeta(session1, { kind: "connection-config", connectionId: "local" }, runtime);
    const row1 = meta1.rows.find((r) => r.label.includes("发现"))!;
    const act1 = row1.onEnter(session1).action;
    expect(act1.type).toBe("loading");
    if (act1.type === "loading") {
      await act1.run(new AbortController().signal, () => {});
    }

    // Session 2: reopen editor via createInitialState (new draftSessionId, draftRevision=0)
    listedModel = "after-reopen";
    const session2 = createInitialState(baseConfig, {});
    expect(session2.draftSessionId).toBeTruthy();
    expect(session2.draftSessionId).not.toBe(session1.draftSessionId);
    const meta2 = buildConnectionConfigMeta(session2, { kind: "connection-config", connectionId: "local" }, runtime);
    const row2 = meta2.rows.find((r) => r.label.includes("发现"))!;
    const act2 = row2.onEnter(session2).action;
    expect(act2.type).toBe("loading");
    if (act2.type === "loading") {
      await act2.run(new AbortController().signal, () => {});
    }

    // Runtime port MUST immediately see "after-reopen" from ModelDiscoveryCache!
    const runtimePort = new ModelRuntimePort({
      modelConfiguration: baseConfig,
      providerCredentials: { version: 2 },
      exposureCredentials: {},
      credentialGeneration: "g1",
      discoveryCache,
    });
    await runtimePort.ensureFreshBeforeAdmission();
    expect(runtimePort.discoveryByConnection()["local"]?.models.map((m) => m.id)).toEqual(["after-reopen"]);

    // After explicit cache invalidation, reopening editor (draftRevision=0) MUST repopulate cache & runtime!
    await discoveryCache.invalidateConnection("local");
    listedModel = "after-invalidate-reopen";
    const session3 = createInitialState(baseConfig, {});
    const meta3 = buildConnectionConfigMeta(session3, { kind: "connection-config", connectionId: "local" }, runtime);
    const act3 = meta3.rows.find((r) => r.label.includes("发现"))!.onEnter(session3).action;
    if (act3.type === "loading") {
      await act3.run(new AbortController().signal, () => {});
    }
    await runtimePort.refreshDiscoveryCacheFromDisk();
    expect(runtimePort.discoveryByConnection()["local"]?.models.map((m) => m.id)).toEqual([
      "after-invalidate-reopen",
    ]);
    await runtimePort.dispose();
  });
});
