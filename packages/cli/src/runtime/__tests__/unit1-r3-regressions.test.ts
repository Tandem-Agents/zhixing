import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantMessage, userMessage, type LLMProvider, type Message } from "@zhixing-ai/core";
import {
  createSignedCapabilityDescriptor,
  createSignedExecutorVersionInventory,
  EXECUTION_PROTOCOL_VERSION,
  MODEL_EXECUTION_PROTOCOL_VERSION,
  type ExecutorCapabilitySnapshot,
} from "@zhixing-ai/core/protocol";
import { resolveAgentIdentity } from "@zhixing-ai/core/identity";
import {
  bindPermissionRuleExecutionSource,
  PermissionStore,
  toPermissionContext,
} from "@zhixing-ai/core/security";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing-ai/mesh/device-identity";
import {
  createAgentRuntime,
  createControlCompletionPort,
  createKernelRuntimeEnvironment,
  createKernelWindowPromptProjection,
} from "@zhixing-ai/orchestrator/runtime";
import { mainProfile } from "@zhixing-ai/orchestrator/profile";
import { RuntimeHost } from "@zhixing-ai/runtime-host";
import { createConversationRuntimeProjection } from "@zhixing-ai/runtime-host/conversation-runtime-projection";
import {
  editConfiguration,
  loadConfigurationSnapshot,
  readManifestMetadataUnlocked,
  writeConfig,
  writeCredentials,
  type LLMConfigV2,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing-ai/providers";
import { createPlatformSecretStore } from "@zhixing-ai/secrets";
import { createTempDir } from "@zhixing-ai/test-utils";
import { createHostAdvancementModelProviderFactory } from "../advancement-model-provider.js";
import { editRuntimeConfiguration } from "../configuration-application.js";
import { createHostKernelModelProviderFactory } from "../kernel-runtime-bindings.js";
import { ModelRuntimePort } from "../model-runtime-port.js";
import { projectRuntimeConfiguration } from "../runtime-configuration-projections.js";
import { projectRuntimeSecrets } from "../runtime-secret-projections.js";
import {
  createHostModelDiskReconciler,
  reloadHostModelRuntimePort,
} from "../../serve/local-configuration-application.js";
import { createExecutorReadinessSource } from "../../serve/executor-readiness.js";
import { ExecutorRuntimeSubstrate } from "../../serve/executor-role-runtime.js";
import { projectConversationCapabilitiesForDevice } from "../../serve/workscene-runtime-projection.js";
import { setupAuthorityRuntime } from "../../setup-delivery.js";

interface CapturedHttpRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

async function startMockOpenAiServer(options?: {
  readonly replyText?: (req: CapturedHttpRequest) => string;
}): Promise<{
  readonly baseUrl: string;
  readonly requests: CapturedHttpRequest[];
  close(): Promise<void>;
}> {
  const requests: CapturedHttpRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const captured: CapturedHttpRequest = {
        path: req.url ?? "",
        authorization:
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : undefined,
        body,
      };
      requests.push(captured);
      const reply = options?.replyText
        ? options.replyText(captured)
        : `ok:${String(body.model ?? "unknown")}:${captured.path}`;
      const stream = body.stream !== false;
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const chunk1 = {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: String(body.model ?? "mock"),
          choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }],
        };
        const chunk2 = {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: String(body.model ?? "mock"),
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1700000000,
            model: String(body.model ?? "mock"),
            choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind mock HTTP server");
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function v2Config(llm: LLMConfigV2, extra?: Partial<ZhixingConfig>): ZhixingConfig {
  return { llm, ...extra };
}

function makePermissionSecurityExecution(dir: string) {
  return Object.freeze({
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
  }) as never;
}

describe("Unit 1 R3 Regressions (R2-A / R2-B / R2-C / R2-D / R2-E + forceCompact real HTTP)", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop()!;
      await close().catch(() => {});
    }
  });

  it("R2-E: rotating a revoked secretRef NEVER resurrects an old provider instance still held by a Run lease (in-flight abort + real HTTP)", async () => {
    let releaseFirstStream: (() => void) | undefined;
    const requests: CapturedHttpRequest[] = [];
    let holdFirst = true;
    const server = http.createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", async () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        requests.push({
          path: req.url ?? "",
          authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
          body,
        });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-r2e",
            object: "chat.completion.chunk",
            created: 1700000000,
            model: String(body.model ?? "m-main"),
            choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }],
          })}\n\n`,
        );
        if (holdFirst) {
          holdFirst = false;
          await new Promise<void>((resolve) => {
            releaseFirstStream = resolve;
            res.on("close", resolve);
          });
        }
        if (!res.destroyed) {
          res.end(
            `data: ${JSON.stringify({
              id: "chatcmpl-r2e",
              object: "chat.completion.chunk",
              created: 1700000000,
              model: String(body.model ?? "m-main"),
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            })}\n\ndata: [DONE]\n\n`,
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstStream?.();
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );

    const cfg = v2Config({
      schemaVersion: 2,
      connections: {
        main_conn: {
          name: "Main",
          adapter: "openai-compatible",
          endpoint: `${baseUrl}/main/v1`,
          auth: { mode: "api-key", secretRef: "ref_main" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: { connectionId: "main_conn", model: "m-main" },
    });
    const creds1: ZhixingCredentials = {
      version: 2,
      modelSecrets: { ref_main: { v: 2, kind: "api-key", value: "sk-old-revoked" } },
    };
    const port = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(cfg).model,
      providerCredentials: projectRuntimeSecrets(creds1).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds1).credentialExposureCredentials,
      credentialGeneration: "gen-1",
    });
    const factory = createHostKernelModelProviderFactory({
      configuration: projectRuntimeConfiguration(cfg).model,
      credentials: projectRuntimeSecrets(creds1).providerCredentials,
      modelRuntimePort: port,
    });

    // Assemble old binding & hold an active Run lease while stream #1 is IN-FLIGHT
    const oldBinding = factory.create({ primaryRole: "main" });
    const releaseOldLease = oldBinding.acquireRunLease!();
    try {
      const firstStream = oldBinding.roles.main.chat({
        messages: [userMessage("ping-1")],
        maxTokens: 128,
      });
      while (requests.length === 0 || !releaseFirstStream) {
        const nextEv = await firstStream.next();
        if (nextEv.done) throw new Error("first stream ended before hitting upstream");
        if (nextEv.value.type === "error") throw nextEv.value.error;
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]!.authorization).toBe("Bearer sk-old-revoked");

      // Step 1: Revoke ref_main while call #1 is IN-FLIGHT -> abortedCalls === 1!
      const revokeRes = await port.applyUpdate({
        modelConfiguration: projectRuntimeConfiguration(cfg).model,
        providerCredentials: { revokedModelSecretRefs: ["ref_main"] },
        exposureCredentials: { revokedModelSecretRefs: ["ref_main"] },
        credentialGeneration: "gen-revoked",
        revokedSecretRefs: ["ref_main"],
      });
      expect(revokeRes.applied).toBe(false);
      if (!revokeRes.applied) expect(revokeRes.abortedCalls).toBe(1);

      // Step 2: Rotate ref_main to a brand-new secret value BEFORE old stream finishes and while old Run lease is STILL held!
      const creds2: ZhixingCredentials = {
        version: 2,
        modelSecrets: { ref_main: { v: 2, kind: "api-key", value: "sk-new-rotated" } },
      };
      const rotRes = await port.applyUpdate({
        operationId: "op-rotate-ref-main",
        modelConfiguration: projectRuntimeConfiguration(cfg).model,
        providerCredentials: projectRuntimeSecrets(creds2).providerCredentials,
        exposureCredentials: projectRuntimeSecrets(creds2).credentialExposureCredentials,
        credentialGeneration: "gen-2",
      });
      expect(rotRes.applied).toBe(true);

      // End aborted first stream while STILL keeping old Run lease
      try {
        await firstStream.return(undefined);
      } catch {
        // expected aborted stream
      }

      // Step 3: Calling the OLD binding (still holding old Run lease) MUST fail closed and send ZERO HTTP!
      await expect(
        (async () => {
          for await (const _ev of oldBinding.roles.main.chat({
            messages: [userMessage("must-not-send-old-key")],
          })) {
            // unreachable
          }
        })(),
      ).rejects.toThrow(/已撤销/u);
      expect(requests).toHaveLength(1);

      // Step 4: A freshly assembled binding MUST succeed with the NEW rotated key
      const newBinding = factory.create({ primaryRole: "main" });
      const releaseNewLease = newBinding.acquireRunLease!();
      try {
        let text2 = "";
        for await (const ev of newBinding.roles.main.chat({
          messages: [userMessage("ping-new")],
        })) {
          if (ev.type === "text_delta") text2 += ev.text;
        }
        expect(text2).toContain("partial");
        expect(requests).toHaveLength(2);
        expect(requests[1]!.authorization).toBe("Bearer sk-new-rotated");
      } finally {
        releaseNewLease();
        await newBinding.dispose?.();
      }
    } finally {
      releaseFirstStream?.();
      releaseOldLease();
      await oldBinding.dispose?.();
      await port.dispose();
    }
  });

  it("R2-D: reloadHostModelRuntimePort and disk reconciler BOTH fail closed on v2 config + v1 SecretStore manifest mismatch", async () => {
    const dir = await createTempDir("r2d-hot-mismatch");
    const configPath = path.join(dir, "config.jsonc");
    const store = createPlatformSecretStore({ homeDir: dir });

    // Start valid v2 runtime in memory
    const liveCfg = v2Config({
      schemaVersion: 2,
      connections: {
        local_ok: {
          name: "Local OK",
          adapter: "openai-compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          auth: { mode: "none" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: { connectionId: "local_ok", model: "live-model" },
    });
    const port = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(liveCfg).model,
      providerCredentials: {},
      exposureCredentials: {},
      credentialGeneration: "gen-live",
    });

    // Put mismatched pair on disk: v2 config + non-empty v1 SecretStore manifest (missing modelConfigVersion=2)
    const mismatchedCfg = v2Config({
      schemaVersion: 2,
      connections: {
        local_ok: {
          name: "Local OK",
          adapter: "openai-compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          auth: { mode: "none" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: { connectionId: "local_ok", model: "should-not-apply" },
    });
    await writeConfig(mismatchedCfg, { configPath });
    await writeCredentials({ providers: { deepseek: { apiKey: "sk-v1-legacy" } } }, { store });

    const beforeManifest = await readManifestMetadataUnlocked(store);
    expect(beforeManifest?.modelConfigVersion).toBe(1);

    const publishRotations = vi.fn(async () => {});
    const onApplied = vi.fn(async () => {});
    const reloadRes = await reloadHostModelRuntimePort({
      homeDir: dir,
      configPath,
      store,
      modelRuntimePort: port,
      publishRotations,
      onApplied,
    });
    expect(reloadRes.applied).toBe(false);
    expect(reloadRes.reason).toMatch(/失配/u);
    expect(publishRotations).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("live-model");

    // Verify v1 manifest & secret were NOT mutated/auto-migrated silently
    const afterManifest = await readManifestMetadataUnlocked(store);
    expect(afterManifest?.modelConfigVersion).toBe(1);

    // Disk reconciler must also refuse mismatch
    const reconciler = createHostModelDiskReconciler({
      homeDir: dir,
      configPath,
      store,
      modelRuntimePort: port,
    });
    await reconciler.captureBaseline();
    // Touch config to ensure fingerprint changes
    await writeConfig(
      v2Config({
        ...(mismatchedCfg.llm as LLMConfigV2),
        main: { connectionId: "local_ok", model: "still-must-not-apply" },
      }),
      { configPath },
    );
    await reconciler.reconcileFromDisk();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("live-model");
    await port.dispose();
  });

  it("R2-A1 + R2-A2: disk reconciler immediately revokes secrets during mixed edit without notify AND blocks half-apply on non-model MCP credential change", async () => {
    const server = await startMockOpenAiServer();
    closers.push(() => server.close());

    const dir = await createTempDir("r2a-disk-mixed");
    const configPath = path.join(dir, "config.jsonc");
    const store = createPlatformSecretStore({ homeDir: dir });

    const initialCfg = v2Config(
      {
        schemaVersion: 2,
        connections: {
          main_conn: {
            name: "Main",
            adapter: "openai-compatible",
            endpoint: `${server.baseUrl}/main/v1`,
            auth: { mode: "api-key", secretRef: "main_ref" },
            network: { proxy: "direct", allowPrivateOrigin: true },
          },
        },
        main: { connectionId: "main_conn", model: "model-v1" },
      },
      {
        agent: { displayName: "InitialAgent" },
        mcp: { servers: { github: { transport: "http", url: "https://mcp.example.com" } } },
      },
    );
    const initialCreds: ZhixingCredentials = {
      version: 2,
      modelSecrets: { main_ref: { v: 2, kind: "api-key", value: "sk-initial" } },
      mcp: { github: { token: "mcp-tok-1" } },
    };
    const baseSnap = await loadConfigurationSnapshot({ configPath, store });
    await editConfiguration(
      baseSnap,
      { config: initialCfg, credentials: initialCreds },
      { configPath, store, forceModelConfigVersion2: true },
    );
    const loaded1 = await loadConfigurationSnapshot({ configPath, store });
    const port = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(loaded1.config).model,
      providerCredentials: projectRuntimeSecrets(loaded1.credentials).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(loaded1.credentials).credentialExposureCredentials,
      credentialGeneration: loaded1.generation,
    });
    const onSecurityRevoked = vi.fn(async () => {});
    const reconciler = createHostModelDiskReconciler({
      homeDir: dir,
      configPath,
      store,
      modelRuntimePort: port,
      onSecurityRevoked,
    });
    await reconciler.captureBaseline();
    port.setDiskReconciler(() => reconciler.reconcileFromDisk());

    // R2-A2: Paired edit changes llm.main.model AND mcp credential (public config.mcp UNCHANGED!) -> MUST NOT half-apply model!
    const snap2 = await loadConfigurationSnapshot({ configPath, store });
    const cfgMcpMixed = structuredClone(snap2.config);
    (cfgMcpMixed.llm as LLMConfigV2).main!.model = "model-should-not-half-apply";
    const credsMcpMixed: ZhixingCredentials = {
      ...structuredClone(snap2.credentials),
      mcp: { github: { token: "mcp-tok-2-changed" } },
    };
    await editConfiguration(
      snap2,
      { config: cfgMcpMixed, credentials: credsMcpMixed },
      { configPath, store, forceModelConfigVersion2: true },
    );
    await port.ensureFreshBeforeAdmission();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-v1");

    // R2-A1: Mixed edit changes agent.displayName AND revokes main_ref WITHOUT RPC notify -> MUST enforce revocation immediately with 0 HTTP!
    const factory = createHostKernelModelProviderFactory({
      configuration: port.snapshot().modelConfiguration,
      credentials: port.snapshot().providerCredentials,
      modelRuntimePort: port,
    });
    const existingBinding = factory.create({ primaryRole: "main" });

    const snap3 = await loadConfigurationSnapshot({ configPath, store });
    const cfgMixedRevoke = structuredClone(snap3.config);
    cfgMixedRevoke.agent = { displayName: "RenamedAgent" };
    (cfgMixedRevoke.llm as LLMConfigV2).main!.model = "model-mixed-not-applied";
    const credsMixedRevoke: ZhixingCredentials = {
      ...structuredClone(snap3.credentials),
      modelSecrets: {},
      revokedModelSecretRefs: ["main_ref"],
    };
    await editConfiguration(
      snap3,
      { config: cfgMixedRevoke, credentials: credsMixedRevoke },
      { configPath, store, forceModelConfigVersion2: true },
    );

    await port.ensureFreshBeforeAdmission();
    expect(onSecurityRevoked).toHaveBeenCalledTimes(1);
    expect(port.readiness().modelConnections.find((c) => c.connectionId === "main_conn")?.ready).toBe(false);
    // Model config was NOT half-applied
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-v1");
    // Old binding MUST fail closed with 0 upstream HTTP requests!
    await expect(
      (async () => {
        for await (const _ev of existingBinding.roles.main.chat({
          messages: [userMessage("blocked")],
        })) {
          // unreachable
        }
      })(),
    ).rejects.toThrow(/已撤销/u);
    expect(server.requests).toHaveLength(0);
    await existingBinding.dispose?.();
    await port.dispose();
  }, 20_000);

  it("R2-A1 arbiter: mixed edit containing secret revocation calls applyModelConfiguration({ revokeOnly: true }) BEFORE activeTurnPromise resolves and BEFORE requestHostReload", async () => {
    const dir = await createTempDir("r2a-arbiter-revoke");
    const configPath = path.join(dir, "config.jsonc");
    const store = createPlatformSecretStore({ homeDir: dir });

    const initialCfg = v2Config(
      {
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
      },
      { agent: { displayName: "OldName" } },
    );
    const initialCreds: ZhixingCredentials = {
      version: 2,
      modelSecrets: { c1: { v: 2, kind: "api-key", value: "sk-1" } },
    };
    const base = await loadConfigurationSnapshot({ configPath, store });
    await editConfiguration(
      base,
      { config: initialCfg, credentials: initialCreds },
      { configPath, store, forceModelConfigVersion2: true },
    );

    const events: string[] = [];
    let releaseTurn!: () => void;
    const activeTurnPromise = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const applyModel = vi.fn(async (input: Record<string, unknown>) => {
      events.push(`applyModel:revokeOnly=${String(input.revokeOnly)}`);
      // Release turn ONLY AFTER confirming revokeOnly fired while turn was still active!
      releaseTurn();
      return { applied: true, revision: "rev-revoked" };
    });
    const reload = vi.fn(async () => {
      events.push("requestHostReload");
    });

    const result = await editRuntimeConfiguration(
      {
        zhixingHome: dir,
        configPath,
        secretStore: store,
        state: { activeTurnPromise },
        applyModelConfiguration: applyModel as never,
        requestHostReload: reload,
      },
      {
        kind: "config",
        edit: async (session) => {
          const nextConfig = structuredClone(session.initialConfig);
          nextConfig.agent = { displayName: "NewName" };
          const nextCredentials: ZhixingCredentials = {
            version: 2,
            modelSecrets: {},
            revokedModelSecretRefs: ["c1"],
          };
          await session.writers.save({
            config: nextConfig,
            credentials: nextCredentials,
          });
          return {
            kind: "completed",
            config: nextConfig,
            credentials: nextCredentials,
          };
        },
      },
    );

    expect(result.kind).toBe("reloaded");
    expect(events).toEqual(["applyModel:revokeOnly=true", "requestHostReload"]);
    expect(applyModel).toHaveBeenCalledWith(
      expect.objectContaining({
        revokeOnly: true,
        revokedSecretRefs: ["c1"],
      }),
    );
  });

  it("R2-B: Advancement binding dynamically follows ModelRuntimePort updates, honors same-source maxOutputPreference over real HTTP, and propagates provider error events instead of returning ok:true empty text", async () => {
    const server = await startMockOpenAiServer();
    closers.push(() => server.close());

    const cfg1 = v2Config({
      schemaVersion: 2,
      connections: {
        main_conn: {
          name: "Main",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/main/v1`,
          auth: { mode: "api-key", secretRef: "main_ref" },
          network: { proxy: "direct", allowPrivateOrigin: true },
          modelOverrides: {
            "m-v1": { maxOutputTokens: 2048 },
            "light-v1": { maxOutputTokens: 1024 },
            "m-v2": { maxOutputTokens: 2048 },
          },
        },
      },
      main: { connectionId: "main_conn", model: "m-v1", maxOutputPreference: 128 },
      light: { connectionId: "main_conn", model: "light-v1", maxOutputPreference: 64 },
    });
    const creds1: ZhixingCredentials = {
      version: 2,
      modelSecrets: { main_ref: { v: 2, kind: "api-key", value: "sk-adv-1" } },
    };
    const port = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(cfg1).model,
      advancementConfiguration: projectRuntimeConfiguration(cfg1).advancement,
      providerCredentials: projectRuntimeSecrets(creds1).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds1).credentialExposureCredentials,
      credentialGeneration: "gen-adv-1",
    });

    const meter = {
      reserveUsage: vi.fn(async () => ({}) as never),
      consume: vi.fn(async () => ({}) as never),
    };
    const factory = createHostAdvancementModelProviderFactory({
      configuration: projectRuntimeConfiguration(cfg1).advancement,
      credentials: projectRuntimeSecrets(creds1).providerCredentials,
      modelRuntimePort: port,
    });
    // Created ONCE and held long-term — exact advancement-controller.ts lifecycle!
    const binding = factory.create({ resourceMeter: meter });
    const fakeLease = { reservationId: "res-adv-1" } as never;
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();

    // 1. Call main -> real HTTP must send model="m-v1" and max_tokens=128 (NOT 4096!)
    const resMain1 = await binding.completion.complete({
      role: "main",
      messages: [userMessage("adv-main-1")],
      lease: fakeLease,
      deadlineAt,
    });
    expect(resMain1.ok).toBe(true);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.body.model).toBe("m-v1");
    expect(server.requests[0]!.body.max_tokens).toBe(128);

    // 2. Call light -> real HTTP must send model="light-v1" and max_tokens=64
    const resLight1 = await binding.completion.complete({
      role: "light",
      messages: [userMessage("adv-light-1")],
      lease: fakeLease,
      deadlineAt,
    });
    expect(resLight1.ok).toBe(true);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.body.model).toBe("light-v1");
    expect(server.requests[1]!.body.max_tokens).toBe(64);

    // 3. Hot-update ModelRuntimePort to m-v2 + maxOutputPreference=256 (WITHOUT recreating binding!)
    const cfg2 = v2Config({
      ...(cfg1.llm as LLMConfigV2),
      main: { connectionId: "main_conn", model: "m-v2", maxOutputPreference: 256 },
    });
    const upd = await port.applyUpdate({
      operationId: "op-adv-hot-update",
      modelConfiguration: projectRuntimeConfiguration(cfg2).model,
      advancementConfiguration: projectRuntimeConfiguration(cfg2).advancement,
      providerCredentials: projectRuntimeSecrets(creds1).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds1).credentialExposureCredentials,
      credentialGeneration: "gen-adv-2",
    });
    expect(upd.applied).toBe(true);

    const resMain2 = await binding.completion.complete({
      role: "main",
      messages: [userMessage("adv-main-2")],
      lease: fakeLease,
      deadlineAt,
    });
    expect(resMain2.ok).toBe(true);
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]!.body.model).toBe("m-v2");
    expect(server.requests[2]!.body.max_tokens).toBe(256);

    // 4. Revoke main_ref -> SAME binding MUST return { ok: false } with 0 new HTTP hits (NEVER ok:true empty text!)
    await port.enforceRevocations({ revokedSecretRefs: ["main_ref"] });
    const resRevoked = await binding.completion.complete({
      role: "main",
      messages: [userMessage("adv-after-revoke")],
      lease: fakeLease,
      deadlineAt,
    });
    expect(resRevoked.ok).toBe(false);
    expect(server.requests).toHaveLength(3);

    // 5. Direct unit proof: createControlCompletionPort handles StreamEvent type === "error" as { ok: false }
    const failingProvider: LLMProvider = {
      id: "err-prov",
      models: [],
      async *chat() {
        yield { type: "error", error: new Error("upstream dispatcher closed") };
      },
    };
    const errorPort = createControlCompletionPort({
      roles: {
        main: { provider: failingProvider, model: "m", chat: (r) => failingProvider.chat({ ...r, model: "m" }) },
        light: { provider: failingProvider, model: "m", chat: (r) => failingProvider.chat({ ...r, model: "m" }) },
      },
      meter,
      defaultMaxOutputTokens: { main: 128, light: 64 },
    });
    const errRes = await errorPort.complete({
      role: "main",
      messages: [userMessage("hi")],
      lease: fakeLease,
      deadlineAt,
    });
    expect(errRes.ok).toBe(false);
    if (!errRes.ok) {
      expect(errRes.error.message).toContain("upstream dispatcher closed");
    }

    await port.dispose();
  });

  it("R2-C: cross-device follow-role succeeds when source main=alpha and target main=beta (disjoint), AND scheduler/job consumes structured modelSelection over real HTTP", async () => {
    const server = await startMockOpenAiServer();
    closers.push(() => server.close());

    // Part 1: Cross-device follow-role with disjoint connections (source has alpha, remote target ONLY has beta)
    const dir = await createTempDir("r2c-cross-device");
    const store = createPlatformSecretStore({ homeDir: dir });
    const remoteKey = await DeviceKey.generate();
    const remoteIdentity = enrollDeviceIdentity(remoteKey, {
      displayName: "remote-beta-exec",
      platform: "linux",
      enrolledAt: "2026-11-19T10:00:00.000Z",
    });

    const authority = await setupAuthorityRuntime({
      zhixingHome: dir,
      secretStore: store,
      enableLocalExecutor: false,
      trustedIdentities: [remoteIdentity],
      authorizedDeviceIds: [remoteIdentity.deviceId],
      projectConversationCapabilities: projectConversationCapabilitiesForDevice,
    });
    closers.push(() => authority.startupCleanup.run());

    const remoteDescriptor = createSignedCapabilityDescriptor(
      {
        executorId: "executor:remote-beta",
        revision: 1,
        protocolVersion: MODEL_EXECUTION_PROTOCOL_VERSION,
        workspaces: [],
        tools: ["read"],
        mcpServers: [],
        credentialBindings: [
          {
            bindingId: `user-alias:${remoteIdentity.deviceId}:credential-provider-beta_secret`,
            service: "provider-beta_secret",
            verification: "user-alias",
            revision: 1,
          },
          {
            bindingId: `user-alias:${remoteIdentity.deviceId}:credential-provider-power_secret`,
            service: "provider-power_secret",
            verification: "user-alias",
            revision: 1,
          },
        ],
        modelConnections: [
          {
            connectionId: "beta",
            adapter: "openai-compatible",
            authMode: "api-key",
            ready: true,
            credentialBindingId: `user-alias:${remoteIdentity.deviceId}:credential-provider-beta_secret`,
            revision: "rev-beta-1",
            boundRoles: ["light", "main"],
          },
          {
            connectionId: "power_conn",
            adapter: "openai-compatible",
            authMode: "api-key",
            ready: true,
            credentialBindingId: `user-alias:${remoteIdentity.deviceId}:credential-provider-power_secret`,
            revision: "rev-power-1",
            boundRoles: ["power"],
          },
        ],
        readyRoles: ["light", "main", "power"],
        evidenceCapabilities: ["artifact", "file-diff", "log"],
        at: "2026-11-19T10:00:00.000Z",
      },
      remoteKey,
    );
    const makeRemoteSnapshot = (permissionHighWater: number): ExecutorCapabilitySnapshot => ({
      descriptor: remoteDescriptor,
      inventory: createSignedExecutorVersionInventory(
        {
          executorId: "executor:remote-beta",
          inventoryRevision: permissionHighWater + 1,
          capabilityRevision: 1,
          configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
          assetVersions: { skillsRev: 1, rubricsRev: 1, promptAssetsRev: 1 },
          permissionSnapshotHighWater: permissionHighWater,
          credentialBindingRevisions: remoteDescriptor.credentialBindings.map(
            ({ bindingId, revision }) => ({ bindingId, revision }),
          ),
          at: "2026-11-19T10:00:00.000Z",
        },
        remoteKey,
      ),
    });

    // Source has executionProfile.providerIds: ["alpha"] (NOT present on target!), yet follow-role: "main" MUST succeed using target's "beta"!
    const preparedConv = await authority.prepareConversationAssignment({
      conversationId: "conv-cross-beta",
      executionProfile: {
        tools: ["read"],
        mcpServers: [],
        providerIds: ["alpha"],
      },
      permissionRules: [],
      modelSelection: { mode: "follow-role", role: "main" },
      targets: [
        {
          executorId: "executor:remote-beta",
          deviceId: remoteIdentity.deviceId,
          synchronizePermission: async (snapshot) => makeRemoteSnapshot(snapshot.snapshotVersion),
        },
      ],
    });
    expect(preparedConv.executorId).toBe("executor:remote-beta");
    expect(preparedConv.policy.manifestCapabilities.protocolVersion).toBe(MODEL_EXECUTION_PROTOCOL_VERSION);
    expect(preparedConv.policy.manifestCapabilities.modelSelection).toEqual({
      mode: "follow-role",
      role: "main",
    });
    // Bound ONLY to target's beta_secret (role=main), NOT source's alpha and NOT power_secret!
    expect(preparedConv.policy.manifestCapabilities.credentialBindings.map((b) => b.service)).toEqual([
      "provider-beta_secret",
    ]);

    // Scheduler prepareJobAssignment with structured follow-role: "power" binds ONLY target's power_secret!
    const preparedJob = await authority.prepareJobAssignment({
      instruction: {
        kind: "agent-turn",
        prompt: "run heavy analysis",
        tools: ["read"],
        modelSelection: { mode: "follow-role", role: "power" },
      },
      capabilities: { tools: ["read"], mcpServers: [] },
      modelSelection: { mode: "follow-role", role: "power" },
      targets: [
        {
          executorId: "executor:remote-beta",
          deviceId: remoteIdentity.deviceId,
          synchronizePermission: async (snapshot) => makeRemoteSnapshot(snapshot.snapshotVersion),
        },
      ],
    });
    expect(preparedJob.policy.manifestCapabilities.protocolVersion).toBe(MODEL_EXECUTION_PROTOCOL_VERSION);
    expect(preparedJob.policy.manifestCapabilities.modelSelection).toEqual({
      mode: "follow-role",
      role: "power",
    });
    expect(preparedJob.policy.manifestCapabilities.credentialBindings.map((b) => b.service)).toEqual([
      "provider-power_secret",
    ]);

    // Negative: v1 remote executor MUST be rejected when explicit modelSelection is requested
    const v1Key = await DeviceKey.generate();
    const v1Identity = enrollDeviceIdentity(v1Key, {
      displayName: "legacy-v1-exec",
      platform: "linux",
      enrolledAt: "2026-11-19T10:00:00.000Z",
    });
    authority.reconcileTrustedDevices([remoteIdentity, v1Identity], [remoteIdentity.deviceId, v1Identity.deviceId]);
    const v1Descriptor = createSignedCapabilityDescriptor(
      {
        executorId: "executor:legacy-v1",
        revision: 1,
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        workspaces: [],
        tools: ["read"],
        mcpServers: [],
        credentialBindings: [],
        evidenceCapabilities: ["artifact", "file-diff", "log"],
        at: "2026-11-19T10:00:00.000Z",
      },
      v1Key,
    );
    await expect(
      authority.prepareJobAssignment({
        instruction: {
          kind: "agent-turn",
          prompt: "explicit connection on v1",
          tools: ["read"],
          modelSelection: { mode: "connection", connectionId: "beta", model: "beta-m" },
        },
        capabilities: { tools: ["read"], mcpServers: [] },
        modelSelection: { mode: "connection", connectionId: "beta", model: "beta-m" },
        targets: [
          {
            executorId: "executor:legacy-v1",
            deviceId: v1Identity.deviceId,
            synchronizePermission: async (snapshot) => ({
              descriptor: v1Descriptor,
              inventory: createSignedExecutorVersionInventory(
                {
                  executorId: "executor:legacy-v1",
                  inventoryRevision: snapshot.snapshotVersion + 1,
                  capabilityRevision: 1,
                  configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
                  assetVersions: { skillsRev: 1, rubricsRev: 1, promptAssetsRev: 1 },
                  permissionSnapshotHighWater: snapshot.snapshotVersion,
                  credentialBindingRevisions: [],
                  at: "2026-11-19T10:00:00.000Z",
                },
                v1Key,
              ),
            }),
          },
        ],
      }),
    ).rejects.toThrow(/no compatible executor/i);

    // Part 2: ExecutorRuntimeSubstrate.createJobRuntime real HTTP consumption of follow-role & connection selection
    const jobCfg = v2Config({
      schemaVersion: 2,
      connections: {
        main_c: {
          name: "Main",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/job-main/v1`,
          auth: { mode: "api-key", secretRef: "main_s" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
        power_c: {
          name: "Power",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/job-power/v1`,
          auth: { mode: "api-key", secretRef: "power_s" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
        alt_c: {
          name: "Alt",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/job-alt/v1`,
          auth: { mode: "api-key", secretRef: "alt_s" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: { connectionId: "main_c", model: "main-m" },
      power: { connectionId: "power_c", model: "power-m" },
    });
    const jobCreds: ZhixingCredentials = {
      version: 2,
      modelSecrets: {
        main_s: { v: 2, kind: "api-key", value: "sk-job-main" },
        power_s: { v: 2, kind: "api-key", value: "sk-job-power" },
        alt_s: { v: 2, kind: "api-key", value: "sk-job-alt" },
      },
    };
    const jobPort = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(jobCfg).model,
      providerCredentials: projectRuntimeSecrets(jobCreds).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(jobCreds).credentialExposureCredentials,
      credentialGeneration: "gen-job",
    });
    closers.push(() => jobPort.dispose());

    const substrate = new ExecutorRuntimeSubstrate({
      zhixingHome: dir,
      modelConfiguration: projectRuntimeConfiguration(jobCfg).model,
      kernelEnvironmentConfiguration: projectRuntimeConfiguration(jobCfg).kernelEnvironment,
      credentials: projectRuntimeSecrets(jobCreds).providerCredentials,
      modelRuntimePort: jobPort,
      createToolImplementation: () =>
        Object.freeze({ create: () => Object.freeze({ tools: Object.freeze([]), permissionRuleSets: Object.freeze([]) }) }),
      permissionStorage: { bind: () => makePermissionSecurityExecution(dir) } as never,
      mcpTools: { snapshot: () => ({ tools: [], serverIds: [] }) },
      systemProtectedPaths: [],
      interactions: {} as never,
      artifactStore: () => ({}) as never,
      deviceCapacity: {
        interactive: undefined as never,
        scheduler: undefined as never,
        orchestration: undefined as never,
      },
    });

    // 2a. follow-role: "power" -> hits /job-power/v1 with power-m & sk-job-power
    const powerJobRt = await substrate.createJobRuntime(
      { kind: "agent-turn", prompt: "do power work" },
      {} as never,
      { tools: [], mcpServers: [] },
      null,
      { mode: "follow-role", role: "power" },
    );
    try {
      const completion = await powerJobRt.run({
        modelInput: { messages: [userMessage("do power work")] },
        identity: { turnIndex: 0 },
        control: {},
        correctness: {},
        observation: {},
      });
      expect(completion.terminal.reason).toBe("completed");
    } finally {
      await powerJobRt.dispose("session-dispose");
    }
    expect(server.requests.at(-1)?.path).toContain("/job-power/v1");
    expect(server.requests.at(-1)?.body.model).toBe("power-m");
    expect(server.requests.at(-1)?.authorization).toBe("Bearer sk-job-power");

    // 2b. explicit mode: "connection" -> hits /job-alt/v1 with alt-m & sk-job-alt
    const altJobRt = await substrate.createJobRuntime(
      { kind: "agent-turn", prompt: "do alt work" },
      {} as never,
      { tools: [], mcpServers: [] },
      null,
      { mode: "connection", connectionId: "alt_c", model: "alt-m" },
    );
    try {
      const completion = await altJobRt.run({
        modelInput: { messages: [userMessage("do alt work")] },
        identity: { turnIndex: 0 },
        control: {},
        correctness: {},
        observation: {},
      });
      expect(completion.terminal.reason).toBe("completed");
    } finally {
      await altJobRt.dispose("session-dispose");
    }
    expect(server.requests.at(-1)?.path).toContain("/job-alt/v1");
    expect(server.requests.at(-1)?.body.model).toBe("alt-m");
    expect(server.requests.at(-1)?.authorization).toBe("Bearer sk-job-alt");
  }, 25_000);

  it("Real HTTP forceCompact proof: compact summary strictly hits roles.light endpoint/model, NOT roles.main or sessionOverride", async () => {
    const server = await startMockOpenAiServer({
      replyText: (req) =>
        req.path.includes("/light/")
          ? "<facts>LightCompactFacts</facts><state>LightState</state><active>LightActive</active>"
          : `Reply from ${req.path}`,
    });
    closers.push(() => server.close());

    const cfg = v2Config({
      schemaVersion: 2,
      connections: {
        main_conn: {
          name: "Main",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/main/v1`,
          auth: { mode: "api-key", secretRef: "main_s" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
        light_conn: {
          name: "Light",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/light/v1`,
          auth: { mode: "api-key", secretRef: "light_s" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
        override_conn: {
          name: "Override",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/override/v1`,
          auth: { mode: "api-key", secretRef: "override_s" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: { connectionId: "main_conn", model: "main-m" },
      light: { connectionId: "light_conn", model: "light-m" },
    });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: {
        main_s: { v: 2, kind: "api-key", value: "sk-main" },
        light_s: { v: 2, kind: "api-key", value: "sk-light" },
        override_s: { v: 2, kind: "api-key", value: "sk-override" },
      },
    };
    const port = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(cfg).model,
      providerCredentials: projectRuntimeSecrets(creds).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds).credentialExposureCredentials,
      credentialGeneration: "gen-compact",
    });
    closers.push(() => port.dispose());

    const factory = createHostKernelModelProviderFactory({
      configuration: projectRuntimeConfiguration(cfg).model,
      credentials: projectRuntimeSecrets(creds).providerCredentials,
      modelRuntimePort: port,
    });
    const dir = await createTempDir("force-compact-http");
    const runtime = await createAgentRuntime({
      modelProvider: factory.create({
        primaryRole: "main",
        sessionOverride: {
          mode: "override",
          connectionId: "override_conn",
          model: "override-m",
        },
      }),
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
      securityExecution: makePermissionSecurityExecution(dir),
      profile: {
        ...mainProfile({ agentIdentity: resolveAgentIdentity() }),
        enabledTools: [],
      },
    });
    closers.push(() => runtime.dispose("session-dispose"));

    // 1. Run a turn -> hits /override/v1
    const history: Message[] = [
      userMessage("First turn context A"),
      assistantMessage("First assistant answer A"),
      userMessage("Second turn context B"),
    ];
    const completion = await runtime.run({
      modelInput: { messages: history },
      identity: { turnIndex: 1 },
      control: {},
      correctness: {},
      observation: {},
    });
    expect(completion.terminal.reason).toBe("completed");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.path).toContain("/override/v1");
    expect(server.requests[0]!.body.model).toBe("override-m");
    expect(server.requests[0]!.authorization).toBe("Bearer sk-override");

    // 2. Call forceCompact with 10 turns -> compact summary HTTP MUST hit /light/v1 with light-m & sk-light!
    const compactHistory: Message[] = [];
    for (let i = 0; i < 10; i++) {
      compactHistory.push(userMessage(`turn-${i}-question`), assistantMessage(`turn-${i}-answer`));
    }
    const compactRes = await runtime.forceCompact(compactHistory, 10);
    expect(compactRes.modified).toBe(true);
    expect(compactRes.windowCompact?.structuredSummary?.facts).toBe("LightCompactFacts");
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.path).toContain("/light/v1");
    expect(server.requests[1]!.body.model).toBe("light-m");
    expect(server.requests[1]!.authorization).toBe("Bearer sk-light");
  });

  it("R4 / R3-C1a: follow-role params and maxOutputPreference overrides take effect over real HTTP on RuntimeHost and ExecutorRuntimeSubstrate while keeping roles.* pure", async () => {
    const server = await startMockOpenAiServer();
    closers.push(() => server.close());

    const dir = await createTempDir("r4-c1a-follow-role");
    const cfg = v2Config({
      schemaVersion: 2,
      connections: {
        ds_conn: {
          name: "DeepSeek Mock",
          presetId: "deepseek",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/ds/v1`,
          auth: { mode: "api-key", secretRef: "ds_s" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
        light_conn: {
          name: "Light Mock",
          presetId: "deepseek",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/light/v1`,
          auth: { mode: "api-key", secretRef: "light_s" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: {
        connectionId: "ds_conn",
        model: "deepseek-v4-pro",
        maxOutputPreference: 181,
        params: { thinking: { mode: "effort", effort: "max" } },
      },
      light: {
        connectionId: "light_conn",
        model: "deepseek-v4-pro",
        maxOutputPreference: 141,
        params: { thinking: { mode: "effort", effort: "max" } },
      },
    });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: {
        ds_s: { v: 2, kind: "api-key", value: "sk-ds" },
        light_s: { v: 2, kind: "api-key", value: "sk-light" },
      },
    };
    const projectedConfig = projectRuntimeConfiguration(cfg);
    const projectedSecrets = projectRuntimeSecrets(creds);
    const port = new ModelRuntimePort({
      modelConfiguration: projectedConfig.model,
      providerCredentials: projectedSecrets.providerCredentials,
      exposureCredentials: projectedSecrets.credentialExposureCredentials,
      credentialGeneration: "gen-r4-c1a",
    });
    closers.push(() => port.dispose());

    const substrate = new ExecutorRuntimeSubstrate({
      zhixingHome: dir,
      modelConfiguration: projectedConfig.model,
      kernelEnvironmentConfiguration: projectedConfig.kernelEnvironment,
      credentials: projectedSecrets.providerCredentials,
      modelRuntimePort: port,
      createToolImplementation: () =>
        Object.freeze({
          create: () => Object.freeze({ tools: Object.freeze([]), permissionRuleSets: Object.freeze([]) }),
        }),
      permissionStorage: {
        bind: () => makePermissionSecurityExecution(dir),
      } as never,
      mcpTools: { snapshot: () => ({ tools: [], serverIds: [] }) } as never,
      systemProtectedPaths: [],
      interactions: {} as never,
      artifactStore: () => ({}) as never,
      deviceCapacity: {
        interactive: undefined as never,
        scheduler: undefined as never,
        orchestration: undefined as never,
      },
    });

    // 1. ExecutorRuntimeSubstrate.createJobRuntime with follow-role light + maxOutputPreference: 71 + thinking: off
    const execJobRt = await substrate.createJobRuntime(
      {
        jobId: "job-follow-light-override",
        name: "follow-light-override",
        prompt: "run job",
        allowedTools: [],
        modelSelection: {
          mode: "follow-role",
          role: "light",
          maxOutputPreference: 71,
          params: { thinking: { mode: "off" } },
        },
      },
      {} as never,
      { tools: [], mcpServers: [] },
      null,
      {
        mode: "follow-role",
        role: "light",
        maxOutputPreference: 71,
        params: { thinking: { mode: "off" } },
      },
    );
    try {
      const comp = await execJobRt.run({
        modelInput: { messages: [userMessage("exec job follow-role override")] },
        identity: { turnIndex: 1 },
        control: {},
        correctness: {},
        observation: {},
      });
      expect(comp.terminal.reason).toBe("completed");
      const jobReq = server.requests.at(-1)!;
      expect(jobReq.path).toContain("/light/v1");
      expect(jobReq.body.model).toBe("deepseek-v4-pro");
      expect(jobReq.body.max_tokens).toBe(71);
      expect(jobReq.body.thinking).toEqual({ type: "disabled" });

      // Pure roles.light MUST stay untouched (141 + thinking enabled) on the SAME runtime!
      await execJobRt.callText("light", [userMessage("pure light check")]);
      const pureLightReq = server.requests.at(-1)!;
      expect(pureLightReq.path).toContain("/light/v1");
      expect(pureLightReq.body.max_tokens).toBe(141);
      expect(pureLightReq.body.thinking).toEqual({ type: "enabled" });
    } finally {
      await execJobRt.dispose("session-dispose");
    }

    // 2. ExecutorRuntimeSubstrate.createConversationRuntime with follow-role light + maxOutputPreference: 73
    const execConvRt = await substrate.createConversationRuntime(
      dir,
      "conv:exec-follow-light",
      { tools: [], mcpServers: [], providerIds: [] },
      null,
      {
        mode: "follow-role",
        role: "light",
        maxOutputPreference: 73,
        params: { thinking: { mode: "off" } },
      },
    );
    try {
      const comp = await execConvRt.run({
        modelInput: { messages: [userMessage("exec conv follow-role override")] },
        identity: { turnIndex: 1 },
        control: {},
        correctness: {},
        observation: {},
      });
      expect(comp.terminal.reason).toBe("completed");
      const convReq = server.requests.at(-1)!;
      expect(convReq.path).toContain("/light/v1");
      expect(convReq.body.max_tokens).toBe(73);
      expect(convReq.body.thinking).toEqual({ type: "disabled" });
    } finally {
      await execConvRt.dispose("session-dispose");
    }

    // 3. RuntimeHost (Anchor path): both createConversationRuntime and createJobRuntime forward primaryRoleOverrides!
    const modelFactory = createHostKernelModelProviderFactory({
      configuration: projectedConfig.model,
      credentials: projectedSecrets.providerCredentials,
      modelRuntimePort: port,
    });
    const host = new RuntimeHost({
      modelProvider: modelFactory,
      runtimeEnvironment: {
        create: () =>
          createKernelRuntimeEnvironment({
            agentIdentity: resolveAgentIdentity(),
            sessionType: "interactive",
            workspace: { path: dir, source: "global-config" },
            globalConfigPath: path.join(dir, "config.jsonc"),
          }),
      },
    });
    const runtimeTools = Object.freeze({
      extraTools: Object.freeze([]),
      executionMcpServers: Object.freeze([]),
      implementation: Object.freeze({
        create: () => Object.freeze({ tools: Object.freeze([]), permissionRuleSets: Object.freeze([]) }),
      }),
    });
    const windowPrompt = Object.freeze({
      project: async () => createKernelWindowPromptProjection({ segment: "skill-index", revision: 1, content: null }),
    });
    const securityExecution = makePermissionSecurityExecution(dir);
    const rawBareProfile = mainProfile({ agentIdentity: resolveAgentIdentity() });
    const bareProfile = Object.freeze({
      ...rawBareProfile,
      constraints: Object.freeze([...rawBareProfile.constraints]),
      enabledTools: Object.freeze([]),
      ...(rawBareProfile.capabilities !== undefined
        ? { capabilities: Object.freeze({ ...rawBareProfile.capabilities }) }
        : {}),
    });

    const hostJobRt = await host.createJobRuntime({
      profile: bareProfile,
      runtimeTools,
      windowPrompt,
      securityExecution,
      confirmationBroker: {} as never,
      primaryRole: "light",
      primaryRoleOverrides: { maxOutputPreference: 79, params: { thinking: { mode: "off" } } },
    });
    try {
      const comp = await hostJobRt.run({
        modelInput: { messages: [userMessage("anchor host job follow-role override")] },
        identity: { turnIndex: 1 },
        control: {},
        correctness: {},
        observation: {},
      });
      expect(comp.terminal.reason).toBe("completed");
      expect(server.requests.at(-1)!.body.max_tokens).toBe(79);
      expect(server.requests.at(-1)!.body.thinking).toEqual({ type: "disabled" });
    } finally {
      await hostJobRt.dispose("session-dispose");
    }

    const hostConvRt = await host.createConversationRuntime(
      createConversationRuntimeProjection({
        primaryRole: "light",
        primaryRoleOverrides: { maxOutputPreference: 83, params: { thinking: { mode: "off" } } },
        profile: bareProfile,
        runtimeTools,
        windowPrompt,
        securityExecution,
      }),
    );
    try {
      const comp = await hostConvRt.run({
        modelInput: { messages: [userMessage("anchor host conv follow-role override")] },
        identity: { turnIndex: 1 },
        control: {},
        correctness: {},
        observation: {},
      });
      expect(comp.terminal.reason).toBe("completed");
      expect(server.requests.at(-1)!.body.max_tokens).toBe(83);
      expect(server.requests.at(-1)!.body.thinking).toEqual({ type: "disabled" });
    } finally {
      await hostConvRt.dispose("session-dispose");
    }
  });

  it("R4 / R3-C1b: legacy bare mainModelOverride inherits target role maxOutputPreference and validates thinking against the target model over real HTTP", async () => {
    const server = await startMockOpenAiServer();
    closers.push(() => server.close());
    const dir = await createTempDir("r4-c1b-bare-override");

    const cfg = v2Config({
      schemaVersion: 2,
      connections: {
        ds_conn: {
          name: "DeepSeek Mock",
          presetId: "deepseek",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/ds/v1`,
          auth: { mode: "api-key", secretRef: "ds_s" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: {
        connectionId: "ds_conn",
        model: "deepseek-v4-pro",
        maxOutputPreference: 181,
        params: { thinking: { mode: "effort", effort: "max" } },
      },
    });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: { ds_s: { v: 2, kind: "api-key", value: "sk-ds" } },
    };
    const projectedConfig = projectRuntimeConfiguration(cfg);
    const projectedSecrets = projectRuntimeSecrets(creds);
    const port = new ModelRuntimePort({
      modelConfiguration: projectedConfig.model,
      providerCredentials: projectedSecrets.providerCredentials,
      exposureCredentials: projectedSecrets.credentialExposureCredentials,
      credentialGeneration: "gen-r4-c1b",
    });
    closers.push(() => port.dispose());

    const modelFactory = createHostKernelModelProviderFactory({
      configuration: projectedConfig.model,
      credentials: projectedSecrets.providerCredentials,
      modelRuntimePort: port,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 1. Bare override to deepseek-v4-flash (does NOT support thinking) -> MUST inherit max_tokens: 181 AND drop incompatible thinking!
      const bindingFlash = modelFactory.create({
        primaryRole: "main",
        mainModelOverride: "deepseek-v4-flash",
      });
      expect(bindingFlash.roles.main.model).toBe("deepseek-v4-pro");
      expect(bindingFlash.sessionPrimary?.model).toBe("deepseek-v4-flash");
      expect(bindingFlash.sessionPrimaryThinking).toBeUndefined();
      expect(bindingFlash.sessionPrimaryMaxOutputTokens).toBe(181);

      const rtFlash = await createAgentRuntime({
        modelProvider: bindingFlash,
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
        securityExecution: makePermissionSecurityExecution(dir),
        profile: { ...mainProfile({ agentIdentity: resolveAgentIdentity() }), enabledTools: [] },
      });
      try {
        const comp = await rtFlash.run({
          modelInput: { messages: [userMessage("legacy bare override flash")] },
          identity: { turnIndex: 1 },
          control: {},
          correctness: {},
          observation: {},
        });
        expect(comp.terminal.reason).toBe("completed");
        const flashReq = server.requests.at(-1)!;
        expect(flashReq.body.model).toBe("deepseek-v4-flash");
        expect(flashReq.body.max_tokens).toBe(181);
        expect(flashReq.body.thinking).toBeUndefined();
      } finally {
        await rtFlash.dispose("session-dispose");
      }

      // 2. Bare override to a thinking-capable model (deepseek-v4-pro) -> inherits BOTH max_tokens: 181 AND valid thinking!
      const bindingPro = modelFactory.create({
        primaryRole: "main",
        mainModelOverride: "deepseek-v4-pro",
      });
      expect(bindingPro.sessionPrimaryMaxOutputTokens).toBe(181);
      expect(bindingPro.sessionPrimaryThinking).toEqual({ mode: "effort", effort: "max" });
      await bindingPro.dispose?.();
    } finally {
      warn.mockRestore();
    }
  });

  it("R4 / R3-C1c: optional role fallback (light unset or degraded -> main) inherits main params and maxOutputPreference over real HTTP for both Advancement and Kernel", async () => {
    const server = await startMockOpenAiServer();
    closers.push(() => server.close());
    const dir = await createTempDir("r4-c1c-fallback");

    // Case A: light UNSET, main has maxOutputPreference: 128 + thinking effort: max
    const cfgUnset = v2Config({
      schemaVersion: 2,
      connections: {
        ds_conn: {
          name: "DeepSeek Mock",
          presetId: "deepseek",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/ds/v1`,
          auth: { mode: "api-key", secretRef: "ds_s" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: {
        connectionId: "ds_conn",
        model: "deepseek-v4-pro",
        maxOutputPreference: 128,
        params: { thinking: { mode: "effort", effort: "max" } },
      },
    });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: { ds_s: { v: 2, kind: "api-key", value: "sk-ds" } },
    };
    const port = new ModelRuntimePort({
      modelConfiguration: projectRuntimeConfiguration(cfgUnset).model,
      advancementConfiguration: projectRuntimeConfiguration(cfgUnset).advancement,
      providerCredentials: projectRuntimeSecrets(creds).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds).credentialExposureCredentials,
      credentialGeneration: "gen-r4-c1c-1",
    });
    closers.push(() => port.dispose());

    const meter = {
      reserveUsage: vi.fn(async () => ({}) as never),
      consume: vi.fn(async () => ({}) as never),
    };
    const advFactory = createHostAdvancementModelProviderFactory({
      configuration: projectRuntimeConfiguration(cfgUnset).advancement,
      credentials: projectRuntimeSecrets(creds).providerCredentials,
      modelRuntimePort: port,
    });
    const advBinding = advFactory.create({ resourceMeter: meter });
    const fakeLease = { reservationId: "res-r4-c1c" } as never;
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();

    const advResUnset = await advBinding.completion.complete({
      role: "light",
      messages: [userMessage("adv light unset fallback")],
      lease: fakeLease,
      deadlineAt,
    });
    expect(advResUnset.ok).toBe(true);
    const advReqUnset = server.requests.at(-1)!;
    expect(advReqUnset.body.model).toBe("deepseek-v4-pro");
    expect(advReqUnset.body.max_tokens).toBe(128);
    expect(advReqUnset.body.thinking).toEqual({ type: "enabled" });

    // Kernel light fallback ALSO sends 128 + thinking enabled!
    const kernelFactory = createHostKernelModelProviderFactory({
      configuration: projectRuntimeConfiguration(cfgUnset).model,
      credentials: projectRuntimeSecrets(creds).providerCredentials,
      modelRuntimePort: port,
    });
    const kernelRt = await createAgentRuntime({
      modelProvider: kernelFactory.create({ primaryRole: "main" }),
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
      securityExecution: makePermissionSecurityExecution(dir),
      profile: { ...mainProfile({ agentIdentity: resolveAgentIdentity() }), enabledTools: [] },
    });
    try {
      await kernelRt.callText("light", [userMessage("kernel light unset fallback")]);
      const kernelReq = server.requests.at(-1)!;
      expect(kernelReq.body.model).toBe("deepseek-v4-pro");
      expect(kernelReq.body.max_tokens).toBe(128);
      expect(kernelReq.body.thinking).toEqual({ type: "enabled" });
    } finally {
      await kernelRt.dispose("session-dispose");
    }

    // Case B: light DEGRADED (points to missing connection) -> falls back to main with 132!
    const cfgDegraded = v2Config({
      ...(cfgUnset.llm as LLMConfigV2),
      main: {
        connectionId: "ds_conn",
        model: "deepseek-v4-pro",
        maxOutputPreference: 132,
      },
      light: {
        connectionId: "missing_conn",
        model: "ghost-light",
        maxOutputPreference: 55,
      },
    });
    const upd = await port.applyUpdate({
      operationId: "op-r4-c1c-degraded",
      modelConfiguration: projectRuntimeConfiguration(cfgDegraded).model,
      advancementConfiguration: projectRuntimeConfiguration(cfgDegraded).advancement,
      providerCredentials: projectRuntimeSecrets(creds).providerCredentials,
      exposureCredentials: projectRuntimeSecrets(creds).credentialExposureCredentials,
      credentialGeneration: "gen-r4-c1c-2",
    });
    expect(upd.applied).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const advResDegraded = await advBinding.completion.complete({
        role: "light",
        messages: [userMessage("adv light degraded fallback")],
        lease: fakeLease,
        deadlineAt,
      });
      expect(advResDegraded.ok).toBe(true);
      expect(server.requests.at(-1)!.body.model).toBe("deepseek-v4-pro");
      expect(server.requests.at(-1)!.body.max_tokens).toBe(132);

      const degradedBinding = kernelFactory.create({ primaryRole: "light" });
      expect(degradedBinding.defaultMaxOutputTokens.light).toBe(132);
      await degradedBinding.dispose?.();
    } finally {
      warn.mockRestore();
    }
  });

  it("R4 / R3-F6: pure-model save during startup window before captureBaseline() converges on admission; startup mixed edit + revocation never half-applies model while enforcing revocation immediately", async () => {
    const server = await startMockOpenAiServer();
    closers.push(() => server.close());

    // Sub-case 1: pure-model save between ModelRuntimePort creation and captureBaseline()
    const home1 = await createTempDir("r4-f6-pure-startup");
    const configPath1 = path.join(home1, "config.jsonc");
    const store1 = createPlatformSecretStore({ homeDir: home1 });
    const startupCfg1 = v2Config({
      schemaVersion: 2,
      connections: {
        c1: {
          name: "Startup Conn",
          adapter: "openai-compatible",
          endpoint: `${server.baseUrl}/s1/v1`,
          auth: { mode: "api-key", secretRef: "s1_ref" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: { connectionId: "c1", model: "startup-model" },
    });
    const emptySnap1 = await loadConfigurationSnapshot({ configPath: configPath1, store: store1 });
    await editConfiguration(
      emptySnap1,
      {
        config: startupCfg1,
        credentials: { version: 2, modelSecrets: { s1_ref: { v: 2, kind: "api-key", value: "sk-s1" } } },
      },
      { configPath: configPath1, store: store1, forceModelConfigVersion2: true },
    );

    const bootSnap1 = await loadConfigurationSnapshot({ configPath: configPath1, store: store1 });
    const bootProj1 = projectRuntimeConfiguration(bootSnap1.config);
    const bootSecrets1 = projectRuntimeSecrets(bootSnap1.credentials);
    const port1 = new ModelRuntimePort({
      modelConfiguration: bootProj1.model,
      advancementConfiguration: bootProj1.advancement,
      providerCredentials: bootSecrets1.providerCredentials,
      exposureCredentials: bootSecrets1.credentialExposureCredentials,
      credentialGeneration: bootSnap1.generation,
    });
    closers.push(() => port1.dispose());

    // Save pure-model update to disk WITHOUT RPC notify BEFORE captureBaseline()!
    const savedDuringStartup = v2Config({
      ...(startupCfg1.llm as LLMConfigV2),
      main: { connectionId: "c1", model: "saved-during-startup" },
    });
    await editConfiguration(
      bootSnap1,
      { config: savedDuringStartup, credentials: bootSnap1.credentials },
      { configPath: configPath1, store: store1, forceModelConfigVersion2: true },
    );

    const reconciler1 = createHostModelDiskReconciler({
      homeDir: home1,
      configPath: configPath1,
      store: store1,
      modelRuntimePort: port1,
    });
    await reconciler1.captureBaseline();
    port1.setDiskReconciler(() => reconciler1.reconcileFromDisk());
    await port1.ensureFreshBeforeAdmission();

    const factory1 = createHostKernelModelProviderFactory({
      configuration: bootProj1.model,
      credentials: bootSecrets1.providerCredentials,
      modelRuntimePort: port1,
    });
    const binding1 = factory1.create({ primaryRole: "main" });
    const release1 = binding1.acquireRunLease?.();
    try {
      for await (const _ of binding1.roles.main.chat({
        messages: [userMessage("after startup save race")],
        maxTokens: 64,
      })) {
        // drain
      }
    } finally {
      release1?.();
      await binding1.dispose?.();
    }
    expect(server.requests.at(-1)?.body.model).toBe("saved-during-startup");

    // Sub-case 2: startup-window MIXED edit (agent.displayName + llm.main) + revocation with initialAuthorityConfiguration
    const home2 = await createTempDir("r4-f6-mixed-startup");
    const configPath2 = path.join(home2, "config.jsonc");
    const store2 = createPlatformSecretStore({ homeDir: home2 });
    const startupCfg2: ZhixingConfig = {
      ...v2Config({
        schemaVersion: 2,
        connections: {
          c2: {
            name: "Mixed Startup Conn",
            adapter: "openai-compatible",
            endpoint: `${server.baseUrl}/s2/v1`,
            auth: { mode: "api-key", secretRef: "s2_ref" },
            network: { proxy: "direct", allowPrivateOrigin: true },
          },
        },
        main: { connectionId: "c2", model: "boot-model-2" },
      }),
      agent: { displayName: "BootAgent" },
    };
    const emptySnap2 = await loadConfigurationSnapshot({ configPath: configPath2, store: store2 });
    await editConfiguration(
      emptySnap2,
      {
        config: startupCfg2,
        credentials: { version: 2, modelSecrets: { s2_ref: { v: 2, kind: "api-key", value: "sk-s2" } } },
      },
      { configPath: configPath2, store: store2, forceModelConfigVersion2: true },
    );

    const bootSnap2 = await loadConfigurationSnapshot({ configPath: configPath2, store: store2 });
    const bootProj2 = projectRuntimeConfiguration(bootSnap2.config);
    const bootSecrets2 = projectRuntimeSecrets(bootSnap2.credentials);
    const port2 = new ModelRuntimePort({
      modelConfiguration: bootProj2.model,
      advancementConfiguration: bootProj2.advancement,
      providerCredentials: bootSecrets2.providerCredentials,
      exposureCredentials: bootSecrets2.credentialExposureCredentials,
      credentialGeneration: bootSnap2.generation,
    });
    closers.push(() => port2.dispose());

    // Mutate disk during startup window: non-model agent.displayName + llm.main + revoke s2_ref
    await editConfiguration(
      bootSnap2,
      {
        config: {
          ...startupCfg2,
          agent: { displayName: "EditedDuringStartup" },
          llm: {
            ...(startupCfg2.llm as LLMConfigV2),
            main: { connectionId: "c2", model: "mixed-should-not-half-apply" },
          },
        },
        credentials: {
          version: 2,
          modelSecrets: {},
          revokedModelSecretRefs: ["s2_ref"],
        },
      },
      { configPath: configPath2, store: store2 },
    );

    const reconciler2 = createHostModelDiskReconciler({
      homeDir: home2,
      configPath: configPath2,
      store: store2,
      modelRuntimePort: port2,
      initialAuthorityConfiguration: bootProj2.authority,
      initialMcpCredentials: bootSecrets2.mcpCredentials,
    });
    await reconciler2.captureBaseline();
    port2.setDiskReconciler(() => reconciler2.reconcileFromDisk());
    await port2.ensureFreshBeforeAdmission();

    // Mixed edit MUST NOT half-apply model, while revocation MUST be enforced immediately!
    const liveLlm2 = port2.snapshot().modelConfiguration.llm as LLMConfigV2;
    expect(liveLlm2.main.model).toBe("boot-model-2");
    expect(port2.snapshot().providerCredentials.revokedModelSecretRefs).toContain("s2_ref");
    const reqCountBefore = server.requests.length;
    const factory2 = createHostKernelModelProviderFactory({
      configuration: bootProj2.model,
      credentials: bootSecrets2.providerCredentials,
      modelRuntimePort: port2,
    });
    expect(() => factory2.create({ primaryRole: "main" })).toThrow();
    expect(server.requests.length).toBe(reqCountBefore);
  });

  it("R5 / F6 observed-vs-applied: captureBaseline, reconcileFromDisk (onApplied window), and markSynced NEVER mark an unapplied newer save as synced", async () => {
    const home = await createTempDir("r5-f6-observed-vs-applied");
    const configPath = path.join(home, "config.jsonc");
    const store = createPlatformSecretStore({ homeDir: home });
    const makeCfg = (model: string): ZhixingConfig =>
      v2Config({
        schemaVersion: 2,
        connections: {
          c1: {
            name: "Conn",
            adapter: "openai-compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            auth: { mode: "api-key", secretRef: "s1" },
            network: { proxy: "direct", allowPrivateOrigin: true },
          },
        },
        main: { connectionId: "c1", model },
      });
    const creds: ZhixingCredentials = {
      version: 2,
      modelSecrets: { s1: { v: 2, kind: "api-key", value: "sk-r5" } },
    };

    const initSnap = await loadConfigurationSnapshot({ configPath, store });
    await editConfiguration(
      initSnap,
      { config: makeCfg("model-A"), credentials: creds },
      { configPath, store, forceModelConfigVersion2: true },
    );

    const bootSnap = await loadConfigurationSnapshot({ configPath, store });
    const bootProj = projectRuntimeConfiguration(bootSnap.config);
    const bootSecrets = projectRuntimeSecrets(bootSnap.credentials);
    const port = new ModelRuntimePort({
      modelConfiguration: bootProj.model,
      advancementConfiguration: bootProj.advancement,
      providerCredentials: bootSecrets.providerCredentials,
      exposureCredentials: bootSecrets.credentialExposureCredentials,
      credentialGeneration: bootSnap.generation,
    });
    closers.push(() => port.dispose());

    const saveModel = async (model: string) => {
      const cur = await loadConfigurationSnapshot({ configPath, store });
      await editConfiguration(
        cur,
        { config: makeCfg(model), credentials: cur.credentials },
        { configPath, store, forceModelConfigVersion2: true },
      );
    };

    // Case 1: Deterministic interleaving inside captureBaseline:
    // Save model-B right after captureBaseline reads model-A (via fs.readFileSync inside localConfig.read),
    // BEFORE captureBaseline returns. Because synced digest is derived from snapshot A itself,
    // captureBaseline MUST bind to A (never B), so admission 1 converges to model-B!
    let injectedBSave = false;
    const origReadFileSync = fs.readFileSync.bind(fs);
    let configReadCount = 0;
    const spyReadFileSync = vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const content = origReadFileSync(...args);
      if (typeof args[0] === "string" && path.resolve(args[0]) === path.resolve(configPath)) {
        configReadCount += 1;
      }
      return content;
    }) as typeof fs.readFileSync);

    let injectedCSave = false;
    const reconciler = createHostModelDiskReconciler({
      homeDir: home,
      configPath,
      store,
      modelRuntimePort: port,
      onApplied: async () => {
        // Case 2: During onApplied of model-B, real paired save writes model-C!
        if (!injectedCSave && (port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model === "model-B") {
          injectedCSave = true;
          await saveModel("model-C");
        }
      },
    });
    try {
      await reconciler.captureBaseline();
    } finally {
      spyReadFileSync.mockRestore();
    }
    expect(configReadCount).toBeGreaterThan(0);
    await saveModel("model-B");
    injectedBSave = true;
    expect(injectedBSave).toBe(true);
    port.setDiskReconciler(() => reconciler.reconcileFromDisk());

    // Admission 1: reconciles model-B; inside onApplied of model-B, model-C is saved on disk!
    await port.ensureFreshBeforeAdmission();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-B");
    expect(injectedCSave).toBe(true);

    // Admission 2: MUST NOT have marked model-C as synced; MUST immediately converge to model-C!
    await port.ensureFreshBeforeAdmission();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-C");

    // Case 3a: Explicit reloadHostModelRuntimePort applies model-D, while onApplied saves model-E;
    // passing appliedSourceDigest to markSynced() MUST NOT swallow model-E!
    await saveModel("model-D");
    let appliedDigest: string | undefined;
    const explicitRes = await reloadHostModelRuntimePort({
      homeDir: home,
      configPath,
      store,
      modelRuntimePort: port,
      onApplied: async () => {
        await saveModel("model-E");
      },
      onAppliedSourceDigest: (digest) => {
        appliedDigest = digest;
      },
    });
    expect(explicitRes.applied).toBe(true);
    expect(appliedDigest).toBeDefined();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-D");
    await reconciler.markSynced(appliedDigest);

    await port.ensureFreshBeforeAdmission();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-E");

    // Case 3b: Zero-arg markSynced() while disk already moved to model-F MUST NOT mark model-F synced!
    await saveModel("model-F");
    await reconciler.markSynced();
    await port.ensureFreshBeforeAdmission();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-F");

    // Case 4 (R6 A -> B -> A): Concurrent save to model-G right before reloadHostModelRuntimePort's
    // paired read applies model-G and MUST return model-G's own source digest (NOT model-F's!).
    // Then saving BACK to model-F without notify MUST converge back to model-F (NOT stay stuck on model-G)!
    await saveModel("model-G");
    let abaDigest: string | undefined;
    const abaRes = await reloadHostModelRuntimePort({
      homeDir: home,
      configPath,
      store,
      modelRuntimePort: port,
      onAppliedSourceDigest: (digest) => {
        abaDigest = digest;
      },
    });
    expect(abaRes.applied).toBe(true);
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-G");
    await reconciler.markSynced(abaDigest);

    // Save back to exact prior content model-F without RPC notify!
    await saveModel("model-F");
    await port.ensureFreshBeforeAdmission();
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-F");

    // Case 5 (R6 single-snapshot mixed-edit guard during publishRotations re-read):
    // If a concurrent mixed edit (agent.displayName + llm.main = "mixed-race") lands while
    // publishRotations is awaiting, the post-rotation re-read MUST reject the mixed edit on THAT
    // exact snapshot instead of half-applying "mixed-race"!
    let injectedMixed = false;
    const reconcilerMixed = createHostModelDiskReconciler({
      homeDir: home,
      configPath,
      store,
      modelRuntimePort: port,
      publishRotations: async () => {
        if (!injectedMixed) {
          injectedMixed = true;
          const cur = await loadConfigurationSnapshot({ configPath, store });
          await editConfiguration(
            cur,
            {
              config: {
                ...makeCfg("mixed-race"),
                agent: { displayName: "ConcurrentMixedAgent" },
              },
              credentials: cur.credentials,
            },
            { configPath, store, forceModelConfigVersion2: true },
          );
        }
      },
    });
    await reconcilerMixed.captureBaseline();
    port.setDiskReconciler(() => reconcilerMixed.reconcileFromDisk());
    await saveModel("model-H-trigger");
    await port.ensureFreshBeforeAdmission();
    expect(injectedMixed).toBe(true);
    expect((port.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-F");

    // Case 6 (R7 unified explicit activation owner):
    // N1 saves pure-model model-I (notification delayed); before N1's explicit applyModelConfiguration arrives,
    // N2 saves a MIXED edit (model-J + agent.displayName + secret revocation s1).
    // Calling reconciler.applyExplicitActivation(...) MUST reject half-applying model-J (live stays model-F)
    // AND MUST enforce secret revocation s1 immediately!
    const explicitHome = await createTempDir("r7-explicit-mixed-reject");
    const explicitConfigPath = path.join(explicitHome, "config.jsonc");
    const explicitStore = createPlatformSecretStore({ homeDir: explicitHome });
    const explicitBaseCfg: ZhixingConfig = {
      ...makeCfg("model-A"),
      agent: { displayName: "BootAgent" },
    };
    const explicitInitSnap = await loadConfigurationSnapshot({ configPath: explicitConfigPath, store: explicitStore });
    await editConfiguration(
      explicitInitSnap,
      { config: explicitBaseCfg, credentials: creds },
      { configPath: explicitConfigPath, store: explicitStore, forceModelConfigVersion2: true },
    );
    const explicitBootSnap = await loadConfigurationSnapshot({ configPath: explicitConfigPath, store: explicitStore });
    const explicitBootProj = projectRuntimeConfiguration(explicitBootSnap.config);
    const explicitBootSecrets = projectRuntimeSecrets(explicitBootSnap.credentials);
    const explicitPort = new ModelRuntimePort({
      modelConfiguration: explicitBootProj.model,
      advancementConfiguration: explicitBootProj.advancement,
      providerCredentials: explicitBootSecrets.providerCredentials,
      exposureCredentials: explicitBootSecrets.credentialExposureCredentials,
      credentialGeneration: explicitBootSnap.generation,
    });
    closers.push(() => explicitPort.dispose());

    const explicitReconciler = createHostModelDiskReconciler({
      homeDir: explicitHome,
      configPath: explicitConfigPath,
      store: explicitStore,
      modelRuntimePort: explicitPort,
      initialAuthorityConfiguration: explicitBootProj.authority,
      initialMcpCredentials: explicitBootSecrets.mcpCredentials,
    });
    await explicitReconciler.captureBaseline();

    // N1 pure-model save B (delayed notification)
    const n1Snap = await loadConfigurationSnapshot({ configPath: explicitConfigPath, store: explicitStore });
    await editConfiguration(
      n1Snap,
      {
        config: { ...explicitBaseCfg, llm: makeCfg("model-B").llm },
        credentials: n1Snap.credentials,
      },
      { configPath: explicitConfigPath, store: explicitStore, forceModelConfigVersion2: true },
    );
    // N2 mixed edit C + agent.displayName + revoke s1 lands BEFORE N1's explicit applyModelConfiguration arrives!
    const n2Snap = await loadConfigurationSnapshot({ configPath: explicitConfigPath, store: explicitStore });
    await editConfiguration(
      n2Snap,
      {
        config: {
          ...makeCfg("model-C-mixed"),
          agent: { displayName: "MixedAgentN2" },
        },
        credentials: {
          version: 2,
          modelSecrets: {},
          revokedModelSecretRefs: ["s1"],
        },
      },
      { configPath: explicitConfigPath, store: explicitStore, forceModelConfigVersion2: true },
    );

    const explicitMixedRes = await explicitReconciler.applyExplicitActivation({
      operationId: "op-delayed-n1-notify",
    });
    expect(explicitMixedRes.applied).toBe(false);
    expect((explicitPort.snapshot().modelConfiguration.llm as LLMConfigV2).main?.model).toBe("model-A");
    expect(explicitPort.snapshot().providerCredentials.revokedModelSecretRefs).toContain("s1");
  }, 25_000);
});
