import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveModelInputCapabilities } from "@zhixing-ai/core";
import { resolveModelInfo } from "@zhixing-ai/core/context";
import {
  BUILTIN_CURATED_CATALOG,
  CatalogSchemaError,
  DEFAULT_MODEL_CATALOG_PORT,
  MODEL_CAPABILITIES,
  ModelDiscoveryCache,
  PROTOCOL_BUDGET_DEFAULTS,
  PROVIDER_PRESETS,
  ProviderConfigError,
  ROLE_RECOMMENDATIONS,
  computeCredentialRevisionToken,
  createModelCatalogPortFromBundle,
  createProviderFromResolved,
  describeGenerationVerification,
  discoverConnectionModels,
  isStructuredNonChatModel,
  normalizeOllamaEndpoints,
  parseCuratedCatalogBundle,
  resolveConnection,
  resolveDiscoveryPlan,
  resolveInferenceBaseUrl,
  resolveLLMRoles,
  resolveLegalVerificationMaxTokens,
  resolveSessionOverride,
  synthesizeConnectionModels,
  verifyModelGeneration,
} from "../index.js";
import type { ModelConnectionConfig } from "../types.js";

const servers: http.Server[] = [];
const tempDirs: string[] = [];

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      handler(req, res, Buffer.concat(chunks).toString("utf8"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-unit3-disc-"));
  tempDirs.push(dir);
  return dir;
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

describe("Unit 3 · Single-source 11-preset catalog, schema & Ollama normalization", () => {
  it("unifies all 11 presets, recommendations, attention thresholds, and Kimi corrected URL from one source", () => {
    const presetIds = DEFAULT_MODEL_CATALOG_PORT.listPresets().map((p) => p.id);
    expect(presetIds).toEqual([
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
    expect(Object.keys(PROVIDER_PRESETS)).toEqual(presetIds);
    expect(ROLE_RECOMMENDATIONS.main?.provider).toBe("deepseek");
    expect(ROLE_RECOMMENDATIONS.light?.provider).toBe("deepseek");
    expect(ROLE_RECOMMENDATIONS.power?.provider).toBe("openai");
    expect(MODEL_CAPABILITIES["deepseek-v4-pro"]?.optimalMaxTokens).toBe(128_000);

    // Kimi corrected list-models URL (来源链接校正)
    const kimi = DEFAULT_MODEL_CATALOG_PORT.getPreset("kimi")!;
    expect(kimi.curated.discovery.docUrl).toBe("https://platform.kimi.ai/docs/api/list-models");
    expect(kimi.curated.ui.modelListDocUrl).toBe("https://platform.kimi.ai/docs/api/list-models");

    // Ollama default免密 + 私网直连
    const ollama = DEFAULT_MODEL_CATALOG_PORT.getPreset("ollama")!;
    expect(ollama.curated.defaultAuthMode).toBe("none");
    expect(ollama.curated.defaultNetwork).toEqual({ proxy: "direct", allowPrivateOrigin: true });
  });

  it("normalizes Ollama inference (/v1) vs native discovery (/api/tags, /api/show) without duplicating /v1 or altering custom basePath", () => {
    // 1. Default root origin -> inference adds /v1, native hits /api/tags & /api/show
    expect(normalizeOllamaEndpoints("http://127.0.0.1:11434")).toEqual({
      inferenceBaseUrl: "http://127.0.0.1:11434/v1",
      nativeTagsUrl: "http://127.0.0.1:11434/api/tags",
      nativeShowUrl: "http://127.0.0.1:11434/api/show",
    });
    expect(normalizeOllamaEndpoints("http://127.0.0.1:11434/")).toEqual({
      inferenceBaseUrl: "http://127.0.0.1:11434/v1",
      nativeTagsUrl: "http://127.0.0.1:11434/api/tags",
      nativeShowUrl: "http://127.0.0.1:11434/api/show",
    });

    // 2. Existing /v1 -> inference does NOT duplicate /v1/v1, native does NOT put /v1 before /api/tags
    expect(normalizeOllamaEndpoints("http://127.0.0.1:11434/v1")).toEqual({
      inferenceBaseUrl: "http://127.0.0.1:11434/v1",
      nativeTagsUrl: "http://127.0.0.1:11434/api/tags",
      nativeShowUrl: "http://127.0.0.1:11434/api/show",
    });
    expect(normalizeOllamaEndpoints("http://127.0.0.1:11434/v1/")).toEqual({
      inferenceBaseUrl: "http://127.0.0.1:11434/v1",
      nativeTagsUrl: "http://127.0.0.1:11434/api/tags",
      nativeShowUrl: "http://127.0.0.1:11434/api/show",
    });

    // 3. Explicit custom basePath preserved untouched for inference, stripped only trailing /v1 for native
    expect(normalizeOllamaEndpoints("https://gw.example.com/my-ollama")).toEqual({
      inferenceBaseUrl: "https://gw.example.com/my-ollama",
      nativeTagsUrl: "https://gw.example.com/my-ollama/api/tags",
      nativeShowUrl: "https://gw.example.com/my-ollama/api/show",
    });
    expect(normalizeOllamaEndpoints("https://gw.example.com/my-ollama/v1")).toEqual({
      inferenceBaseUrl: "https://gw.example.com/my-ollama/v1",
      nativeTagsUrl: "https://gw.example.com/my-ollama/api/tags",
      nativeShowUrl: "https://gw.example.com/my-ollama/api/show",
    });

    // 4. resolveConnection uses resolveInferenceBaseUrl cleanly for Ollama
    const resolved = resolveConnection(
      "ollama",
      {
        name: "Local Ollama",
        presetId: "ollama",
        adapter: "openai-compatible",
        endpoint: "http://127.0.0.1:11434",
        auth: { mode: "none" },
        network: { proxy: "direct", allowPrivateOrigin: true },
      },
      {},
    );
    expect(resolved.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(resolveInferenceBaseUrl("https://gw.example.com/ollama-gw", "openai-compatible", "ollama")).toBe(
      "https://gw.example.com/ollama-gw",
    );
  });

  it("rejects arbitrary field-path/script injection, forward-ignores unknown fields, and gates unsupported per-entry capabilities", () => {
    const injected = structuredClone(BUILTIN_CURATED_CATALOG) as unknown as Record<string, unknown>;
    (injected["models"] as Array<Record<string, unknown>>)[0]!["requestFieldPath"] = "body.evil";
    expect(() => parseCuratedCatalogBundle(injected)).toThrow(CatalogSchemaError);

    // Unknown optional descriptive fields allowed + single entry with future capability isolated without rejecting bundle
    const forward = structuredClone(BUILTIN_CURATED_CATALOG) as unknown as Record<string, unknown>;
    forward["releaseNotesUrl"] = "https://example.com/notes";
    (forward["models"] as Array<Record<string, unknown>>).push({
      presetId: "openai",
      id: "gpt-future-9",
      name: "GPT Future 9",
      futureNote: "ignored safely by old client",
      requiredCapabilities: ["param:future.quantum"],
    });
    const parsed = parseCuratedCatalogBundle(forward);
    const port = createModelCatalogPortFromBundle(parsed);
    const synth = synthesizeConnectionModels({
      connectionId: "openai",
      connection: {
        name: "OpenAI",
        presetId: "openai",
        adapter: "openai-responses",
        endpoint: "https://api.openai.com/v1",
        auth: { mode: "api-key", secretRef: "openai" },
        network: { proxy: "inherit" },
      },
      catalog: port.bundle,
    });
    const futureModel = synth.models.find((m) => m.id === "gpt-future-9")!;
    expect(futureModel.requiresUpgrade).toBe(true);
    expect(futureModel.missingCapabilities).toEqual(["param:future.quantum"]);
    expect(synth.models.find((m) => m.id === "gpt-6.2-astra")!.requiresUpgrade).toBe(false);
  });

  it("enforces 3-layer synthesis (hard constraints vs data vs preferences) and strictly structured non-chat filtering", () => {
    // 1. Authoritative hard constraints cannot be broken by modelOverrides (preserves user input & reports conflict)
    const authConn: ModelConnectionConfig = {
      name: "Anthropic",
      presetId: "anthropic",
      adapter: "anthropic-messages",
      endpoint: "https://api.anthropic.com",
      auth: { mode: "api-key", secretRef: "anthropic" },
      network: { proxy: "inherit" },
      modelOverrides: {
        "claude-sonnet-4-7": { contextWindow: 999_999, supportsImages: true },
      },
      hiddenModels: ["claude-sonnet-4-5-20250929"],
      customModels: ["my-custom-chat"],
    };
    const authSynth = synthesizeConnectionModels({
      connectionId: "anthropic",
      connection: authConn,
      catalog: BUILTIN_CURATED_CATALOG,
      discoveredAuthoritative: true,
      discoveredModels: [
        {
          id: "claude-sonnet-4-7",
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          supportsImages: false, // explicit authoritative false
        },
        // Non-chat by structured outputModalities -> filtered
        { id: "claude-embed-v1", outputModalities: ["embedding"] },
        // Scary name WITHOUT structured non-chat assertion -> MUST BE KEPT (no name heuristic!)
        { id: "embed-tts-image-mystery-chat" },
      ],
    });
    const sonnet = authSynth.models.find((m) => m.id === "claude-sonnet-4-7")!;
    expect(sonnet.fields.contextWindow.value).toBe(200_000);
    expect(sonnet.fields.supportsImages.value).toBe(false);
    expect(sonnet.overrideConflicts.length).toBe(2);
    expect(sonnet.overrideConflicts.map((c) => c.field)).toEqual(["contextWindow", "supportsImages"]);
    // User override input itself untouched in connection object
    expect(authConn.modelOverrides!["claude-sonnet-4-7"]!.contextWindow).toBe(999_999);
    // Structured non-chat filtered, name-only mystery model KEPT with unknown status
    expect(authSynth.filteredNonChatIds).toEqual(["claude-embed-v1"]);
    const mystery = authSynth.models.find((m) => m.id === "embed-tts-image-mystery-chat")!;
    expect(mystery).toBeDefined();
    expect(mystery.metadataStatus).toBe("unknown");
    // Hidden preference respected
    expect(authSynth.models.some((m) => m.id === "claude-sonnet-4-5-20250929")).toBe(false);
    expect(authSynth.hiddenModels.some((m) => m.id === "claude-sonnet-4-5-20250929")).toBe(true);

    // 2. Third-party aggregator (OpenRouter) sits in data layer, NOT hard constraints
    const orSynth = synthesizeConnectionModels({
      connectionId: "openrouter",
      connection: {
        name: "OpenRouter",
        presetId: "openrouter",
        adapter: "openai-compatible",
        endpoint: "https://openrouter.ai/api/v1",
        auth: { mode: "api-key", secretRef: "openrouter" },
        network: { proxy: "inherit" },
        modelOverrides: {
          "openai/gpt-6.2-astra": { contextWindow: 500_000, supportsImages: true },
        },
      },
      catalog: BUILTIN_CURATED_CATALOG,
      discoveredModels: [
        {
          id: "openai/gpt-6.2-astra",
          contextWindow: 128_000,
          supportsImages: false,
          outputModalities: ["text"],
        },
        {
          id: "acme/unmapped-model",
          contextWindow: 64_000,
          outputModalities: ["text"],
        },
      ],
    });
    const orGpt = orSynth.models.find((m) => m.id === "openai/gpt-6.2-astra")!;
    expect(orGpt.overrideConflicts).toEqual([]);
    expect(orGpt.fields.contextWindow).toEqual({ value: 500_000, source: "user-override" });
    expect(orGpt.fields.supportsImages).toEqual({ value: true, source: "user-override" });
    const orUnmapped = orSynth.models.find((m) => m.id === "acme/unmapped-model")!;
    expect(orUnmapped.fields.contextWindow.thirdPartyUnverified).toBe(true);

    // 3. Google supportedGenerationMethods structured non-chat check
    expect(
      isStructuredNonChatModel({
        discovered: { supportedGenerationMethods: ["embedContent"] },
      }),
    ).toBe(true);
    expect(
      isStructuredNonChatModel({
        discovered: { supportedGenerationMethods: ["generateContent", "countTokens"] },
      }),
    ).toBe(false);
  });
});

describe("Unit 3 · Native discovery, 11 preset plans, 4-state errors, isolated cache & voluntary verification", () => {
  it("declares exact discovery paths for all 11 presets (including DashScope origin guard and GLM/MiniMax optional-compat)", () => {
    const byId = (id: string) => DEFAULT_MODEL_CATALOG_PORT.getPreset(id)!.curated;
    expect(resolveDiscoveryPlan({ endpoint: "https://api.deepseek.com", preset: byId("deepseek") }).url).toBe(
      "https://api.deepseek.com/models",
    );
    expect(
      resolveDiscoveryPlan({
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        preset: byId("qwen"),
      }),
    ).toMatchObject({ mode: "native", url: "https://dashscope.aliyuncs.com/api/v1/models" });
    // Unverified custom Qwen host does NOT generalize native /api/v1/models
    expect(
      resolveDiscoveryPlan({
        endpoint: "https://custom-qwen-proxy.example.com/v1",
        preset: byId("qwen"),
      }).mode,
    ).toBe("none");
    expect(
      resolveDiscoveryPlan({
        endpoint: "https://custom-qwen-proxy.example.com/v1",
        preset: byId("qwen"),
        allowOptionalCompatProbe: true,
      }),
    ).toMatchObject({ mode: "optional-compat", url: "https://custom-qwen-proxy.example.com/v1/models" });

    // GLM & MiniMax default mode="none" (no unverified list probe), opt-in optional-compat allowed
    expect(resolveDiscoveryPlan({ endpoint: "https://open.bigmodel.cn/api/paas/v4", preset: byId("glm") }).mode).toBe(
      "none",
    );
    expect(resolveDiscoveryPlan({ endpoint: "https://api.minimax.chat/v1", preset: byId("minimax") }).mode).toBe(
      "none",
    );
    expect(
      resolveDiscoveryPlan({
        endpoint: "https://open.bigmodel.cn/api/paas/v4",
        preset: byId("glm"),
        allowOptionalCompatProbe: true,
      }).url,
    ).toBe("https://open.bigmodel.cn/api/paas/v4/models");

    expect(resolveDiscoveryPlan({ endpoint: "https://api.anthropic.com", preset: byId("anthropic") }).url).toBe(
      "https://api.anthropic.com/v1/models",
    );
    expect(
      resolveDiscoveryPlan({ endpoint: "https://generativelanguage.googleapis.com", preset: byId("google") }).url,
    ).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(resolveDiscoveryPlan({ endpoint: "https://openrouter.ai/api/v1", preset: byId("openrouter") }).url).toBe(
      "https://openrouter.ai/api/v1/models",
    );
    expect(resolveDiscoveryPlan({ endpoint: "https://api.siliconflow.cn/v1", preset: byId("siliconflow") }).url).toBe(
      "https://api.siliconflow.cn/v1/models",
    );
    expect(resolveDiscoveryPlan({ endpoint: "http://127.0.0.1:11434/v1", preset: byId("ollama") })).toMatchObject({
      mode: "native",
      url: "http://127.0.0.1:11434/api/tags",
      ollamaShowUrl: "http://127.0.0.1:11434/api/show",
    });
  });

  it("discovers Ollama via /api/tags + POST /api/show without /v1 and without auth header in none mode", async () => {
    const seenPaths: string[] = [];
    const seenAuth: Array<string | undefined> = [];
    const { url } = await startServer((req, res, body) => {
      seenPaths.push(`${req.method} ${req.url}`);
      seenAuth.push(req.headers.authorization);
      if (req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "nomic-embed-text:latest" }] }));
        return;
      }
      if (req.url === "/api/show" && req.method === "POST") {
        const parsed = JSON.parse(body) as { model: string };
        res.writeHead(200, { "Content-Type": "application/json" });
        if (parsed.model === "qwen3:8b") {
          res.end(
            JSON.stringify({
              capabilities: ["completion", "tools", "thinking"],
              model_info: { "qwen3.context_length": 40_960 },
            }),
          );
        } else {
          res.end(JSON.stringify({ capabilities: ["embedding"], model_info: { "bert.context_length": 8192 } }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });

    // Pass endpoint WITH /v1 to prove native discovery still strips /v1 for /api/tags and /api/show
    const res = await discoverConnectionModels({
      connectionId: "ollama",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: `${url}/v1`,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
    });

    expect(res.status).toBe("discovered");
    expect(seenPaths[0]).toBe("GET /api/tags");
    expect(seenPaths).toContain("POST /api/show");
    expect(seenAuth.every((a) => a === undefined)).toBe(true);
    const qwen = res.models.find((m) => m.id === "qwen3:8b")!;
    expect(qwen.contextWindow).toBe(40_960);
    expect(qwen.supportsTools).toBe(true);
    expect(qwen.supportsThinking).toBe(true);
    const embed = res.models.find((m) => m.id === "nomic-embed-text:latest")!;
    expect(embed.purpose).toBe("embedding");
  });

  it("handles 401, 403 structured reasons, 404/405, timeout, cache isolation, key-change invalidation & TTL staleness", async () => {
    const home = await makeTempDir();
    let mode: "401" | "403-region" | "404" | "405" | "ok" | "slow" = "401";
    const secretA = "custom-nonprefixed-secret-ALPHA-9988";
    const secretB = "custom-nonprefixed-secret-BETA-7766";

    const { url } = await startServer((req, res) => {
      if (mode === "401") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Invalid key ${secretA}` } }));
        return;
      }
      if (mode === "403-region") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unsupported_country_region_territory", message: "Region blocked" } }));
        return;
      }
      if (mode === "404") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      if (mode === "405") {
        res.writeHead(405);
        res.end("Method Not Allowed");
        return;
      }
      if (mode === "slow") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [] }));
        }, 400);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }));
    });

    let nowMs = Date.now();
    const cache = new ModelDiscoveryCache({ homeDir: home, ttlMs: 15 * 60 * 1000, now: () => nowMs });

    // 1. 401 -> auth-rejected, secret redacted everywhere including cache file
    const r401 = await discoverConnectionModels({
      connectionId: "ds-1",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds-1" },
      secretValue: secretA,
      network: { proxy: "direct", allowPrivateOrigin: true },
      cache,
    });
    expect(r401.status).toBe("auth-rejected");
    expect(r401.userMessage).not.toContain(secretA);
    const cacheText = await fs.readFile(cache.cachePath, "utf8");
    expect(cacheText).not.toContain(secretA);
    expect(cacheText).not.toContain("Invalid key");

    // 2. Rotating key invalidates old 401 partition immediately
    const credRevB = computeCredentialRevisionToken({ authMode: "api-key", secretValue: secretB });
    expect(
      await cache.read({
        connectionId: "ds-1",
        endpoint: url,
        adapter: "openai-compatible",
        credentialRevision: credRevB,
      }),
    ).toBeUndefined();

    // 3. Subsequent success replaces prior failure cleanly
    mode = "ok";
    const rOk = await discoverConnectionModels({
      connectionId: "ds-1",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds-1" },
      secretValue: secretB,
      network: { proxy: "direct", allowPrivateOrigin: true },
      cache,
    });
    expect(rOk.status).toBe("discovered");
    expect(rOk.models.map((m) => m.id)).toEqual(["deepseek-v4-pro"]);
    const freshRead = await cache.read({
      connectionId: "ds-1",
      endpoint: url,
      adapter: "openai-compatible",
      credentialRevision: credRevB,
    });
    expect(freshRead?.freshness).toBe("fresh");

    // 4. Expired entry marked stale (上次结果/待刷新), never masquerading as fresh
    nowMs += 20 * 60 * 1000;
    const staleRead = await cache.read({
      connectionId: "ds-1",
      endpoint: url,
      adapter: "openai-compatible",
      credentialRevision: credRevB,
    });
    expect(staleRead?.freshness).toBe("stale");
    expect(staleRead?.freshnessNote).toContain("上次结果");

    // 5. 403 structured region subcode (NOT misclassified as API key error)
    mode = "403-region";
    const r403 = await discoverConnectionModels({
      connectionId: "ds-2",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds-2" },
      secretValue: secretB,
      network: { proxy: "direct", allowPrivateOrigin: true },
    });
    expect(r403.status).toBe("restricted");
    expect(r403.errorSubcode).toBe("forbidden_region");

    // 6. 404 & 405 -> unsupported (never blocks saving)
    mode = "404";
    const r404 = await discoverConnectionModels({
      connectionId: "ds-2",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds-2" },
      secretValue: secretB,
      network: { proxy: "direct", allowPrivateOrigin: true },
    });
    expect(r404.status).toBe("unsupported");
    mode = "405";
    const r405 = await discoverConnectionModels({
      connectionId: "ds-2",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds-2" },
      secretValue: secretB,
      network: { proxy: "direct", allowPrivateOrigin: true },
    });
    expect(r405.status).toBe("unsupported");

    // 7. Timeout -> unreachable with sanitized endpoint + proxy route
    mode = "slow";
    const rTimeout = await discoverConnectionModels({
      connectionId: "ds-2",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds-2" },
      secretValue: secretB,
      network: { proxy: "direct", allowPrivateOrigin: true },
      timeoutMs: 60,
    });
    expect(rTimeout.status).toBe("unreachable");
    expect(rTimeout.errorSubcode).toBe("timeout");
  });

  it("enforces voluntary, cancelable generation verification with legal maxTokens (never max_tokens: 1)", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const { url } = await startServer((req, res, body) => {
      seenBodies.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl_v1",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl_v1",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const notice = describeGenerationVerification({ modelId: "deepseek-v4-pro" });
    expect(notice.maxTokens).toBeGreaterThanOrEqual(64);
    expect(notice.costDisclosure).toContain("费用");

    // Unconfirmed call MUST fail closed without hitting network
    await expect(
      verifyModelGeneration({
        connectionId: "ds",
        presetId: "deepseek",
        adapter: "openai-compatible",
        endpoint: url,
        auth: { mode: "api-key", secretRef: "ds" },
        secretValue: "sk-verify-secret",
        network: { proxy: "direct", allowPrivateOrigin: true },
        modelId: "deepseek-v4-pro",
        userConfirmed: false,
      }),
    ).rejects.toThrow("自愿显式确认");
    expect(seenBodies.length).toBe(0);

    // Confirmed call uses legal max_tokens >= 64 (never 1)
    const verified = await verifyModelGeneration({
      connectionId: "ds",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds" },
      secretValue: "sk-verify-secret",
      network: { proxy: "direct", allowPrivateOrigin: true },
      modelId: "deepseek-v4-pro",
      userConfirmed: true,
      draftRevision: 7,
    });
    expect(verified.status).toBe("verified");
    expect(verified.draftRevision).toBe(7);
    expect(verified.previewText).toBe("OK");
    expect(seenBodies.length).toBe(1);
    const maxTok = Number(seenBodies[0]!["max_tokens"] ?? seenBodies[0]!["max_completion_tokens"]);
    expect(maxTok).toBeGreaterThanOrEqual(64);
    expect(maxTok).not.toBe(1);

    // Pre-aborted cancel never sends network request
    const abort = new AbortController();
    abort.abort();
    const cancelled = await verifyModelGeneration({
      connectionId: "ds",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds" },
      secretValue: "sk-verify-secret",
      network: { proxy: "direct", allowPrivateOrigin: true },
      modelId: "deepseek-v4-pro",
      userConfirmed: true,
      signal: abort.signal,
    });
    expect(cancelled.status).toBe("aborted");
    expect(seenBodies.length).toBe(1);
  });

  it("executes real HTTP native discovery across Anthropic, Google, OpenRouter, SiliconFlow, DashScope, GLM/MiniMax opt-in & Ollama custom basePath", async () => {
    const seenRequests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
    const { url } = await startServer((req, res, body) => {
      seenRequests.push({ method: req.method ?? "GET", url: req.url ?? "", headers: req.headers });
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname === "/v1/models" && req.headers["anthropic-version"]) {
        const after = u.searchParams.get("after_id");
        res.writeHead(200, { "Content-Type": "application/json" });
        if (!after) {
          res.end(
            JSON.stringify({
              data: [{ id: "claude-opus-4-7", display_name: "Claude Opus 4.7", max_input_tokens: 200_000, max_tokens: 32_000 }],
              has_more: true,
              last_id: "claude-opus-4-7",
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              data: [{ id: "claude-sonnet-4-7", display_name: "Claude Sonnet 4.7", max_input_tokens: 200_000, max_tokens: 32_000 }],
              has_more: false,
            }),
          );
        }
        return;
      }
      if (u.pathname === "/v1beta/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              { name: "models/gemini-3.5-pro", displayName: "Gemini 3.5 Pro", inputTokenLimit: 1_000_000, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent"] },
              { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
            ],
          }),
        );
        return;
      }
      if (u.pathname === "/openrouter/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                id: "openai/gpt-6.2-astra",
                name: "GPT-6.2 Astra",
                context_length: 400_000,
                top_provider: { max_completion_tokens: 128_000 },
                architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
                supported_parameters: ["tools"],
                pricing: { prompt: "0.000002", completion: "0.000008" },
              },
              {
                id: "openai/text-embedding-3-large",
                architecture: { output_modalities: ["embedding"] },
              },
            ],
          }),
        );
        return;
      }
      if (u.pathname === "/sf/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "deepseek-ai/DeepSeek-V4-Flash", type: "text", sub_type: "chat" },
              { id: "BAAI/bge-reranker-v2-m3", type: "text", sub_type: "rerank" },
            ],
          }),
        );
        return;
      }
      if (u.pathname === "/api/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              total: 1,
              page_size: 100,
              models: [{ model: "qwen-max", capabilities: ["tools", "thinking"], context_length: 256_000 }],
            },
          }),
        );
        return;
      }
      if (u.pathname === "/my-proxy/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "llama4:latest" }] }));
        return;
      }
      if (u.pathname === "/my-proxy/api/show" && req.method === "POST") {
        const parsed = JSON.parse(body) as { model: string };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: parsed.model, capabilities: ["tools"], model_info: { "llama.context_length": 131_072 } }));
        return;
      }
      if (u.pathname === "/glm/v4/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "glm-4.7" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    // 1. Anthropic pagination + x-api-key + anthropic-version
    const anth = await discoverConnectionModels({
      connectionId: "anth",
      presetId: "anthropic",
      adapter: "anthropic-messages",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "anth" },
      secretValue: "sk-ant-test-key",
      network: { proxy: "direct", allowPrivateOrigin: true },
    });
    expect(anth.status).toBe("discovered");
    expect(anth.models.map((m) => m.id)).toEqual(["claude-opus-4-7", "claude-sonnet-4-7"]);
    expect(seenRequests.some((r) => r.headers["x-api-key"] === "sk-ant-test-key" && r.headers["anthropic-version"] === "2023-06-01")).toBe(true);

    // 2. Google /v1beta/models + x-goog-api-key + structured non-chat method filtering
    const goog = await discoverConnectionModels({
      connectionId: "goog",
      presetId: "google",
      adapter: "google-interactions",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "goog" },
      secretValue: "AIzaSyTestKey123456",
      network: { proxy: "direct", allowPrivateOrigin: true },
    });
    expect(goog.status).toBe("discovered");
    expect(goog.models.map((m) => m.id)).toEqual(["gemini-3.5-pro", "text-embedding-004"]);
    const googSynth = synthesizeConnectionModels({
      connectionId: "goog",
      connection: {
        name: "Google",
        presetId: "google",
        adapter: "google-interactions",
        endpoint: url,
        auth: { mode: "api-key", secretRef: "goog" },
        network: { proxy: "direct", allowPrivateOrigin: true },
      },
      catalog: BUILTIN_CURATED_CATALOG,
      discoveredModels: goog.models,
      discoveredAuthoritative: goog.authoritativeNativeFacts,
    });
    expect(googSynth.filteredNonChatIds).toEqual(["text-embedding-004"]);

    // 3. OpenRouter (non-authoritative + pricing + output_modalities)
    const or = await discoverConnectionModels({
      connectionId: "or",
      presetId: "openrouter",
      adapter: "openai-compatible",
      endpoint: `${url}/openrouter/v1`,
      auth: { mode: "api-key", secretRef: "or" },
      secretValue: "sk-or-test",
      network: { proxy: "direct", allowPrivateOrigin: true },
    });
    expect(or.status).toBe("discovered");
    expect(or.authoritativeNativeFacts).toBe(false);
    expect(or.models.find((m) => m.id === "openai/gpt-6.2-astra")?.pricing?.inputPerMillion).toBe(2);

    // 4. SiliconFlow exact hosted ID + structured rerank filter
    const sf = await discoverConnectionModels({
      connectionId: "sf",
      presetId: "siliconflow",
      adapter: "openai-compatible",
      endpoint: `${url}/sf/v1`,
      auth: { mode: "api-key", secretRef: "sf" },
      secretValue: "sk-sf-test",
      network: { proxy: "direct", allowPrivateOrigin: true },
    });
    expect(sf.status).toBe("discovered");
    expect(sf.models.find((m) => m.id === "BAAI/bge-reranker-v2-m3")?.nativeSubType).toBe("rerank");

    // 5. DashScope verified native origin via catalog entry
    const localDashCatalog = {
      ...BUILTIN_CURATED_CATALOG,
      presets: BUILTIN_CURATED_CATALOG.presets.map((p) =>
        p.id === "qwen"
          ? { ...p, discovery: { ...p.discovery, verifiedOrigins: [url] } }
          : p,
      ),
    };
    const qwen = await discoverConnectionModels({
      connectionId: "qwen",
      presetId: "qwen",
      adapter: "openai-compatible",
      endpoint: `${url}/compatible-mode/v1`,
      auth: { mode: "api-key", secretRef: "qwen" },
      secretValue: "sk-qwen-test",
      network: { proxy: "direct", allowPrivateOrigin: true },
      catalog: localDashCatalog,
    });
    expect(qwen.status).toBe("discovered");
    expect(qwen.models[0]?.id).toBe("qwen-max");
    expect(qwen.models[0]?.supportsThinking).toBe(true);

    // 6. GLM default unsupported (0 HTTP calls) vs allowOptionalCompatProbe=true
    const beforeGlmCount = seenRequests.length;
    const glmDefault = await discoverConnectionModels({
      connectionId: "glm",
      presetId: "glm",
      adapter: "openai-compatible",
      endpoint: `${url}/glm/v4`,
      auth: { mode: "api-key", secretRef: "glm" },
      secretValue: "glm-key",
      network: { proxy: "direct", allowPrivateOrigin: true },
    });
    expect(glmDefault.status).toBe("unsupported");
    expect(seenRequests.length).toBe(beforeGlmCount);
    const glmOptIn = await discoverConnectionModels({
      connectionId: "glm",
      presetId: "glm",
      adapter: "openai-compatible",
      endpoint: `${url}/glm/v4`,
      auth: { mode: "api-key", secretRef: "glm" },
      secretValue: "glm-key",
      network: { proxy: "direct", allowPrivateOrigin: true },
      allowOptionalCompatProbe: true,
    });
    expect(glmOptIn.status).toBe("discovered");
    expect(glmOptIn.models.map((m) => m.id)).toEqual(["glm-4.7"]);

    // 7. Ollama explicit custom basePath preserved (/my-proxy/api/tags & /my-proxy/api/show)
    const ollamaCustom = await discoverConnectionModels({
      connectionId: "ollama-gw",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: `${url}/my-proxy`,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
    });
    expect(ollamaCustom.status).toBe("discovered");
    expect(ollamaCustom.models[0]?.id).toBe("llama4:latest");
    expect(ollamaCustom.models[0]?.contextWindow).toBe(131_072);
  });

  it("R2 F2: enforces Layer-1 hard-constraint clamping in resolveConnection & Kernel resolvers and blocks incompatible requiredCapabilities in resolveLLMRoles / resolveSessionOverride", () => {
    const conn: ModelConnectionConfig = {
      name: "Anthropic Official",
      presetId: "anthropic",
      adapter: "anthropic-messages",
      endpoint: "https://api.anthropic.com",
      auth: { mode: "api-key", secretRef: "anth" },
      network: { proxy: "inherit" },
      modelOverrides: {
        "claude-discovered-tight": {
          contextWindow: 99_999,
          maxOutputTokens: 9_999,
          supportsImages: true,
        },
      },
    };
    const credentials = {
      version: 2 as const,
      modelSecrets: {
        anth: { v: 2 as const, kind: "api-key" as const, value: "sk-ant-r2" },
      },
    };
    const discovery = {
      authoritativeNativeFacts: true,
      models: [
        {
          id: "claude-discovered-tight",
          name: "Claude Discovered Tight",
          contextWindow: 4096,
          maxOutputTokens: 64,
          supportsImages: false,
          supportsTools: true,
        },
      ],
    };

    const resolved = resolveConnection("anth", conn, credentials, { discovery });
    // Raw user override input untouched
    expect(conn.modelOverrides!["claude-discovered-tight"]).toEqual({
      contextWindow: 99_999,
      maxOutputTokens: 9_999,
      supportsImages: true,
    });
    // Runtime resolved outputs strictly clamped by Layer 1 hard constraints + discovered model present in declaredModels
    expect(resolved.declaredModels.find((m) => m.id === "claude-discovered-tight")).toMatchObject({
      contextWindow: 4096,
      maxOutputTokens: 64,
      supportsImages: false,
    });
    expect(resolved.modelOverrides?.["claude-discovered-tight"]).toEqual({
      contextWindow: 4096,
      maxOutputTokens: 64,
    });
    expect(resolved.modelInputCapabilities?.["claude-discovered-tight"]).toEqual({ images: false });
    expect(resolved.overrideConflicts?.["claude-discovered-tight"]?.length).toBe(3);

    // Real Kernel resolvers (resolveModelInfo + resolveModelInputCapabilities) receive clamped limits!
    const provider = createProviderFromResolved(resolved);
    const kernelBudget = resolveModelInfo({
      providerId: provider.id,
      model: "claude-discovered-tight",
      providerModels: provider.models,
      overrides: resolved.modelOverrides,
      protocolDefaults: PROTOCOL_BUDGET_DEFAULTS[resolved.protocol],
    });
    expect(kernelBudget.info).toEqual({ contextWindow: 4096, maxOutputTokens: 64 });
    const kernelInputCaps = resolveModelInputCapabilities({
      model: "claude-discovered-tight",
      providerModels: provider.models,
      overrides: resolved.modelInputCapabilities,
    });
    expect(kernelInputCaps).toEqual({ images: false });

    // Capability hard gate in resolveLLMRoles + resolveSessionOverride
    const futureBundle = parseCuratedCatalogBundle({
      ...structuredClone(BUILTIN_CURATED_CATALOG),
      models: [
        ...BUILTIN_CURATED_CATALOG.models,
        {
          presetId: "anthropic",
          id: "claude-future-v9",
          name: "Claude Future V9",
          requiredCapabilities: ["param:future.quantum"],
        },
      ],
    });
    const futurePort = createModelCatalogPortFromBundle(futureBundle);
    const baseCfg = {
      llm: {
        schemaVersion: 2 as const,
        connections: { anth: conn },
        main: { connectionId: "anth", model: "claude-future-v9" },
      },
    };
    expect(() => resolveLLMRoles(baseCfg, credentials, { catalog: futurePort })).toThrow(ProviderConfigError);
    expect(() => resolveLLMRoles(baseCfg, credentials, { catalog: futurePort })).toThrow("需要升级知行");

    // Optional aux role degrades cleanly with explicit upgrade reason instead of crashing main
    const auxCfg = {
      llm: {
        schemaVersion: 2 as const,
        connections: { anth: conn },
        main: { connectionId: "anth", model: "claude-sonnet-4-7" },
        light: { connectionId: "anth", model: "claude-future-v9" },
      },
    };
    const auxRoles = resolveLLMRoles(auxCfg, credentials, { catalog: futurePort });
    expect(auxRoles.light.model).toBe("claude-sonnet-4-7");
    expect(auxRoles.degradations.length).toBe(1);
    expect(auxRoles.degradations[0]!.reason).toContain("需要升级知行");

    // Session override rejects incompatible known model too
    expect(() =>
      resolveSessionOverride(
        auxCfg,
        credentials,
        { mode: "override", connectionId: "anth", model: "claude-future-v9" },
        { catalog: futurePort },
      ),
    ).toThrow("需要升级知行");
  });

  it("R2 F4: downgrades unverified cloud origins to non-authoritative optional-compat and blocks stale/out-of-order cache writes", async () => {
    const googlePreset = DEFAULT_MODEL_CATALOG_PORT.getPreset("google")!.curated;

    // F4(a): Official Google origin keeps native + authoritativeNativeFacts=true
    const officialPlan = resolveDiscoveryPlan({
      endpoint: "https://generativelanguage.googleapis.com",
      preset: googlePreset,
    });
    expect(officialPlan).toMatchObject({
      mode: "native",
      originVerified: true,
      authoritativeNativeFacts: true,
    });

    // F4(a): Unverified custom origin with Google preset MUST downgrade to optional-compat & authoritativeNativeFacts=false
    const unverifiedPlan = resolveDiscoveryPlan({
      endpoint: "https://unverified.example/v1",
      preset: googlePreset,
    });
    expect(unverifiedPlan).toMatchObject({
      mode: "optional-compat",
      originVerified: false,
      authoritativeNativeFacts: false,
    });

    // synthesizeConnectionModels also refuses to treat unverified origin facts as Layer-1 hard constraints
    const unverifiedSynth = synthesizeConnectionModels({
      connectionId: "goog-proxy",
      connection: {
        name: "Google Proxy",
        presetId: "google",
        adapter: "google-interactions",
        endpoint: "https://unverified.example/v1",
        auth: { mode: "api-key", secretRef: "goog-proxy" },
        network: { proxy: "inherit" },
        modelOverrides: { "gemini-3.5-pro": { maxOutputTokens: 99_999 } },
      },
      catalog: BUILTIN_CURATED_CATALOG,
      discoveredModels: [{ id: "gemini-3.5-pro", maxOutputTokens: 64 }],
    });
    const gem = unverifiedSynth.models.find((m) => m.id === "gemini-3.5-pro")!;
    expect(gem.overrideConflicts).toEqual([]);
    expect(gem.fields.maxOutputTokens).toEqual({ value: 99_999, source: "user-override" });

    // F4(b): Anti-late-write watermark prevents older credential/timestamp/generation write from wiping newer partition
    const home = await makeTempDir();
    const cache = new ModelDiscoveryCache({ homeDir: home });
    const oldIdentity = {
      connectionId: "conn-race",
      endpoint: "https://api.deepseek.com",
      adapter: "openai-compatible" as const,
      credentialRevision: computeCredentialRevisionToken({ authMode: "api-key", secretValue: "sk-old-key" }),
    };
    const newIdentity = {
      connectionId: "conn-race",
      endpoint: "https://api.deepseek.com",
      adapter: "openai-compatible" as const,
      credentialRevision: computeCredentialRevisionToken({ authMode: "api-key", secretValue: "sk-new-key" }),
    };

    const writtenNew = await cache.writeProbeResult(
      newIdentity,
      {
        status: "discovered",
        checkedAt: "2026-11-20T05:00:10Z",
        sanitizedEndpoint: "https://api.deepseek.com",
        modeUsed: "native",
        authoritativeNativeFacts: true,
        models: [{ id: "deepseek-v4-pro", maxOutputTokens: 16_384 }],
        userMessage: "new ok",
      },
      { generation: 2 },
    );
    expect(writtenNew).toBeDefined();

    // Late write with earlier timestamp & earlier generation MUST be ignored!
    const lateOld = await cache.writeProbeResult(
      oldIdentity,
      {
        status: "auth-rejected",
        checkedAt: "2026-11-20T05:00:01Z",
        sanitizedEndpoint: "https://api.deepseek.com",
        modeUsed: "native",
        authoritativeNativeFacts: false,
        models: [],
        userMessage: "stale 401",
      },
      { generation: 1 },
    );
    expect(lateOld).toBeUndefined();
    expect((await cache.read(newIdentity))?.entry.status).toBe("discovered");
    expect(await cache.read(oldIdentity)).toBeUndefined();

    // Invalidation watermark blocks stale in-flight write with older checkedAt from resurrecting
    await cache.invalidateConnection("conn-race", { nowMs: Date.parse("2026-11-20T05:01:00Z") });
    const staleAfterInvalidate = await cache.writeProbeResult(newIdentity, {
      status: "discovered",
      checkedAt: "2026-11-20T05:00:30Z",
      sanitizedEndpoint: "https://api.deepseek.com",
      modeUsed: "native",
      authoritativeNativeFacts: true,
      models: [{ id: "deepseek-v4-pro" }],
      userMessage: "stale resurrect",
    });
    expect(staleAfterInvalidate).toBeUndefined();
    expect(await cache.read(newIdentity)).toBeUndefined();
  });

  it("R2 F5: respects tight model maxOutputTokens=32 and distinguishes verified vs truncated (finish_reason=length) vs empty", async () => {
    // Tight model cap=32 MUST send max_tokens=32 (NEVER 128, NEVER 1!)
    expect(
      resolveLegalVerificationMaxTokens({
        id: "tight-32",
        name: "Tight 32",
        contextWindow: 4096,
        maxOutputTokens: 32,
        supportsTools: true,
      }),
    ).toBe(32);

    const seenMaxTokens: number[] = [];
    let responseMode: "ok" | "truncated-empty" | "stop-empty" = "ok";
    const { url } = await startServer((_req, res, body) => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      seenMaxTokens.push(Number(parsed["max_tokens"] ?? parsed["max_completion_tokens"]));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (responseMode === "ok") {
        res.write(
          `data: ${JSON.stringify({
            id: "c-ok",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
          })}\n\n`,
        );
      } else if (responseMode === "truncated-empty") {
        res.write(
          `data: ${JSON.stringify({
            id: "c-trunc",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "length" }],
          })}\n\n`,
        );
      } else {
        res.write(
          `data: ${JSON.stringify({
            id: "c-empty",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const tightModelInfo = {
      id: "tight-32",
      name: "Tight 32",
      contextWindow: 4096,
      maxOutputTokens: 32,
      supportsTools: true,
    };

    // 1. Tight model verified with max_tokens=32 & non-empty preview
    responseMode = "ok";
    const okRes = await verifyModelGeneration({
      connectionId: "ds",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds" },
      secretValue: "sk-verify",
      network: { proxy: "direct", allowPrivateOrigin: true },
      modelId: "tight-32",
      modelInfo: tightModelInfo,
      userConfirmed: true,
    });
    expect(okRes.status).toBe("verified");
    expect(okRes.maxTokensUsed).toBe(32);
    expect(okRes.previewText).toBe("OK");
    expect(seenMaxTokens.at(-1)).toBe(32);

    // 2. Empty text + finish_reason=length -> "truncated" (NEVER "verified"!)
    responseMode = "truncated-empty";
    const truncRes = await verifyModelGeneration({
      connectionId: "ds",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds" },
      secretValue: "sk-verify",
      network: { proxy: "direct", allowPrivateOrigin: true },
      modelId: "tight-32",
      modelInfo: tightModelInfo,
      userConfirmed: true,
    });
    expect(truncRes.status).toBe("truncated");
    expect(truncRes.stopReason).toBe("max_tokens");

    // 3. Empty text + finish_reason=stop -> "empty" (NEVER "verified"!)
    responseMode = "stop-empty";
    const emptyRes = await verifyModelGeneration({
      connectionId: "ds",
      presetId: "deepseek",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "api-key", secretRef: "ds" },
      secretValue: "sk-verify",
      network: { proxy: "direct", allowPrivateOrigin: true },
      modelId: "tight-32",
      modelInfo: tightModelInfo,
      userConfirmed: true,
    });
    expect(emptyRes.status).toBe("empty");
  });

  it("R3 R2-1: keeps session-local draftRevision from blocking reopened sessions or post-invalidation discovery/verification while still rejecting stale in-flight writes", async () => {
    let listedModel = "before-reopen";
    let delayFirstMs = 0;
    let firstDelayUsed = false;
    let genText = "OK-first";
    const { url } = await startServer((req, res) => {
      if (req.url === "/api/tags") {
        const send = () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ models: [{ name: listedModel, model: listedModel }] }));
        };
        if (delayFirstMs > 0 && !firstDelayUsed) {
          firstDelayUsed = true;
          const capturedModel = listedModel;
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ models: [{ name: capturedModel, model: capturedModel }] }));
          }, delayFirstMs);
          return;
        }
        send();
        return;
      }
      if (req.url === "/api/show") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ capabilities: ["completion"], model_info: { "llama.context_length": 4096 } }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "v-r3",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: genText }, finish_reason: "stop" }],
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const home = await makeTempDir();
    const cache = new ModelDiscoveryCache({ homeDir: home });
    const identity = {
      connectionId: "local",
      endpoint: url,
      adapter: "openai-compatible" as const,
      credentialRevision: "none",
    };

    // 1. Session 1 finishes with draftRevision=3 (both unscoped and session-scoped)
    const first = await discoverConnectionModels({
      connectionId: "local",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
      cache,
      draftRevision: 3,
    });
    expect(first.status).toBe("discovered");
    expect((await cache.read(identity))?.entry.models?.map((m) => m.id)).toEqual(["before-reopen"]);

    // 2. Reopening editor (draftRevision restarts at 0) MUST update persistent cache!
    listedModel = "after-reopen";
    const second = await discoverConnectionModels({
      connectionId: "local",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
      cache,
      draftRevision: 0,
    });
    expect(second.status).toBe("discovered");
    expect((await cache.read(identity))?.entry.models?.map((m) => m.id)).toEqual(["after-reopen"]);

    // 3. Explicit session-scoped flow: session-A gen=3 -> session-A late gen=1 REJECTED, then reopened session-B gen=0 ACCEPTED!
    listedModel = "session-a-v3";
    await discoverConnectionModels({
      connectionId: "local",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
      cache,
      requestSessionId: "session-A",
      draftRevision: 3,
    });
    const rejectedSameSession = await cache.writeProbeResult(
      identity,
      {
        status: "discovered",
        checkedAt: new Date(Date.now() + 5_000).toISOString(),
        authoritativeNativeFacts: true,
        models: [{ id: "session-a-stale-v1" }],
        userMessage: "stale same-session write",
      },
      { sessionId: "session-A", generation: 1 },
    );
    expect(rejectedSameSession).toBeUndefined();
    expect((await cache.read(identity))?.entry.models?.map((m) => m.id)).toEqual(["session-a-v3"]);

    listedModel = "session-b-reopened";
    await discoverConnectionModels({
      connectionId: "local",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
      cache,
      requestSessionId: "session-B",
      draftRevision: 0,
    });
    expect((await cache.read(identity))?.entry.models?.map((m) => m.id)).toEqual(["session-b-reopened"]);

    // 4. Generation verification also works across reopened sessions (session-A gen=3 -> session-B gen=0)
    const verifyA = await verifyModelGeneration({
      connectionId: "local",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: `${url}/v1`,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
      modelId: "model-a",
      effectiveMaxOutputTokens: 32,
      userConfirmed: true,
      cache,
      requestSessionId: "session-A",
      draftRevision: 3,
    });
    expect(verifyA.status).toBe("verified");
    genText = "OK-second";
    const verifyB = await verifyModelGeneration({
      connectionId: "local",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: `${url}/v1`,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
      modelId: "model-b",
      effectiveMaxOutputTokens: 32,
      userConfirmed: true,
      cache,
      requestSessionId: "session-B",
      draftRevision: 0,
    });
    expect(verifyB.status).toBe("verified");
    const verifyCached = await cache.read({
      connectionId: "local",
      endpoint: `${url}/v1`,
      adapter: "openai-compatible",
      credentialRevision: "none",
    });
    expect(verifyCached?.entry.generationVerifications?.["model-b"]?.status).toBe("verified");

    // 5. In-flight probe started BEFORE invalidateConnection MUST be rejected on completion,
    //    while a fresh probe started AFTER invalidateConnection (with draftRevision=0) MUST populate cache!
    const invHome = await makeTempDir();
    const invCache = new ModelDiscoveryCache({ homeDir: invHome });
    listedModel = "pre-invalidate-slow";
    delayFirstMs = 80;
    firstDelayUsed = false;
    const inFlightBeforeInvalidation = discoverConnectionModels({
      connectionId: "local",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
      cache: invCache,
      requestSessionId: "session-old",
      draftRevision: 5,
    });
    // Wait briefly so the slow request has started & captured epoch=0, then invalidate while in-flight
    await new Promise((r) => setTimeout(r, 15));
    await invCache.invalidateConnection("local");
    await inFlightBeforeInvalidation;
    // Slow pre-invalidation probe MUST NOT resurrect cache
    expect(await invCache.read(identity)).toBeUndefined();

    // Immediate fresh editor session (draftRevision=0) AFTER invalidation MUST populate cache cleanly
    listedModel = "post-invalidate-fresh";
    delayFirstMs = 0;
    const afterInv = await discoverConnectionModels({
      connectionId: "local",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: url,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
      cache: invCache,
      draftRevision: 0,
    });
    expect(afterInv.status).toBe("discovered");
    expect((await invCache.read(identity))?.entry.models?.map((m) => m.id)).toEqual(["post-invalidate-fresh"]);

    // Generation verification after invalidation with draftRevision=0 MUST also succeed
    await invCache.invalidateConnection("local");
    const verifyAfterInv = await verifyModelGeneration({
      connectionId: "local",
      presetId: "ollama",
      adapter: "openai-compatible",
      endpoint: `${url}/v1`,
      auth: { mode: "none" },
      network: { proxy: "direct", allowPrivateOrigin: true },
      modelId: "post-inv-model",
      effectiveMaxOutputTokens: 32,
      userConfirmed: true,
      cache: invCache,
      draftRevision: 0,
    });
    expect(verifyAfterInv.status).toBe("verified");
    const postInvVerifyRead = await invCache.read({
      connectionId: "local",
      endpoint: `${url}/v1`,
      adapter: "openai-compatible",
      credentialRevision: "none",
    });
    expect(postInvVerifyRead?.entry.generationVerifications?.["post-inv-model"]?.status).toBe("verified");
  });

  it("Unit 4 R2 F3: user overrides for supportsTools / supportsThinking flow through synthesis and resolveConnection while authoritative false remains a hard constraint", () => {
    const conn = {
      name: "DeepSeek Local",
      presetId: "deepseek",
      adapter: "openai-compatible" as const,
      endpoint: "http://127.0.0.1:11434/v1",
      auth: { mode: "none" as const },
      network: { proxy: "direct" as const, allowPrivateOrigin: true },
      modelOverrides: {
        "deepseek-v4-pro": {
          supportsTools: false,
          supportsThinking: false,
        },
      },
    };

    const synth = synthesizeConnectionModels({
      connectionId: "local",
      connection: conn,
      catalog: BUILTIN_CURATED_CATALOG,
      adapterImplemented: true,
      includeHidden: true,
      includeOverrideOnlyIds: true,
    });
    const candidate = synth.models.find((m) => m.id === "deepseek-v4-pro")!;
    expect(candidate.fields.supportsTools).toEqual({ value: false, source: "user-override" });
    expect(candidate.fields.supportsThinking).toEqual({ value: false, source: "user-override" });
    expect(candidate.fields.thinkingControl).toEqual({
      value: { type: "none" },
      source: "user-override",
    });
    expect(candidate.modelInfo?.supportsTools).toBe(false);
    expect(candidate.modelInfo?.supportsThinking).toBe(false);
    expect(candidate.modelInfo?.thinkingControl).toEqual({ type: "none" });
    expect(candidate.overrideConflicts).toEqual([]);

    const resolved = resolveConnection("local", conn, {});
    const resolvedModel = resolved.declaredModels.find((m) => m.id === "deepseek-v4-pro")!;
    expect(resolvedModel.supportsTools).toBe(false);
    expect(resolvedModel.supportsThinking).toBe(false);
    expect(resolvedModel.thinkingControl).toEqual({ type: "none" });
    expect(resolvedModel.maxOutputTokens).toBe(384_000);
    expect(resolvedModel.recommendedMaxOutputTokens).toBe(16_384);

    // Custom connection without presetId never steals recommendedMaxOutputTokens by model name
    const customNoPreset = resolveConnection(
      "custom_gw",
      {
        name: "Custom Gateway",
        adapter: "openai-compatible",
        endpoint: "http://127.0.0.1:18080/v1",
        auth: { mode: "none" },
        network: { allowPrivateHosts: true },
        customModels: ["deepseek-v4-pro"],
        modelOverrides: {
          "deepseek-v4-pro": { contextWindow: 128_000, maxOutputTokens: 999_999 },
        },
      },
      {},
    );
    const customModelInfo = customNoPreset.declaredModels.find((m) => m.id === "deepseek-v4-pro")!;
    expect(customModelInfo.maxOutputTokens).toBe(999_999);
    expect(customModelInfo.recommendedMaxOutputTokens).toBeUndefined();

    // Authoritative hard denial cannot be bypassed by user override = true
    const forcedTrueConn = {
      ...conn,
      modelOverrides: {
        "deepseek-v4-pro": {
          supportsTools: true,
          supportsThinking: true,
        },
      },
    };
    const clampedSynth = synthesizeConnectionModels({
      connectionId: "local",
      connection: forcedTrueConn,
      catalog: BUILTIN_CURATED_CATALOG,
      discoveredModels: [
        {
          id: "deepseek-v4-pro",
          supportsTools: false,
          supportsThinking: false,
        },
      ],
      discoveredAuthoritative: true,
      adapterImplemented: true,
    });
    const clamped = clampedSynth.models.find((m) => m.id === "deepseek-v4-pro")!;
    expect(clamped.fields.supportsTools.value).toBe(false);
    expect(clamped.fields.supportsThinking.value).toBe(false);
    expect(clamped.modelInfo?.supportsTools).toBe(false);
    expect(clamped.modelInfo?.supportsThinking).toBe(false);
    expect(clamped.overrideConflicts.map((c) => c.field)).toEqual([
      "supportsTools",
      "supportsThinking",
    ]);
  });
});
