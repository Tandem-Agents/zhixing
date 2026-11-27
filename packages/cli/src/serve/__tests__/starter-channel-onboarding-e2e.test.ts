import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createTempDir } from "@zhixing-ai/test-utils";
import { FileArtifactStore, FileAuthorityCommitLog, registerDeviceLifecycleProjection } from "@zhixing-ai/core/authority";
import type { HttpHandler, InboundMessage } from "@zhixing-ai/core/channels";
import type { ExtensionCandidate } from "@zhixing-ai/core/extensions/contracts";
import {
  EXTENSION_PRODUCT_API_EXACT_SET,
  extensionApplyConfiguration,
  extensionList,
  extensionLocalSetup,
  extensionManage,
} from "@zhixing-ai/core/extensions/application";
import { ProductApiDispatcher } from "@zhixing-ai/core/product-api";
import { SkillCatalogLoadApplicationService, getBuiltinSkill } from "@zhixing-ai/core/skills/catalog";
import { runContextStorage } from "@zhixing-ai/orchestrator/runtime";
import { writeConfig, writeCredentials } from "@zhixing-ai/providers";
import { EncryptedVaultSecretStore } from "@zhixing-ai/secrets";
import { createSkillMaterializeTool } from "@zhixing-ai/tools-builtin";
import { ChannelConfiguration } from "../../runtime/extensions/channel-configuration.js";
import { setupChannels, type SetupChannelsResult } from "../channels.js";

const CLEANUPS: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (CLEANUPS.length > 0) {
    const fn = CLEANUPS.pop()!;
    await fn();
  }
});

describe("starter-channel bundled esbuild & managed channel e2e", { timeout: 60_000 }, () => {
  it("bundles unmodified starter-channel.ts and completes unverified-block -> 502 retry -> inbound/outbound receipt", async () => {
    const root = await createTempDir("starter-e2e");
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });
    CLEANUPS.push(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    const loader = new SkillCatalogLoadApplicationService({
      readScope: async () => ({ kind: "builtin-only" }),
      readContent: async () => "",
      stageUsage: async () => {},
    });
    const matTool = createSkillMaterializeTool(loader);
    const builtinExt = getBuiltinSkill("外部能力接入");
    expect(builtinExt).not.toBeNull();
    const versionInfo = await loader.readPackage({ id: "system:外部能力接入" });
    for (const r of builtinExt!.resources) {
      if (!r.path.startsWith("kit/") && !r.path.startsWith("examples/")) continue;
      const matRes = await runContextStorage.run(
        { conversationId: "ws:scene:primary", lineage: "power", hasAuthorizedWorkspace: true } as never,
        () =>
          matTool.call(
            {
              id: "system:外部能力接入",
              resource: r.path,
              path: r.path,
              expectedVersion: versionInfo.packageVersion,
            },
            { workingDirectory: ws },
          ),
      );
      expect(matRes.isError).not.toBe(true);
    }

    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve("tsup"))("esbuild") as {
      build: (opts: Record<string, unknown>) => Promise<{ outputFiles: Array<{ text: string }> }>;
    };
    const bundled = await build({
      entryPoints: [join(ws, "examples", "starter-channel.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: ["node:*"],
      write: false,
      logLevel: "silent",
    });
    const code = bundled.outputFiles[0]!.text;
    const starterManifest = JSON.parse(
      builtinExt!.resources.find((r) => r.path === "examples/manifest.json")!.content,
    ) as ExtensionCandidate["manifest"];
    const candidate: ExtensionCandidate = {
      manifest: { ...starterManifest, digest: createHash("sha256").update(code).digest("hex") },
      code,
      provenance: { url: "https://github.com/Tandem-Agents/zhixing", revision: "0.1.0", kind: "authored" },
      sources: { "examples/starter-channel.ts": code },
      build: "esbuild node24 esm",
    };

    let failOutbound502 = false;
    const outboundRequests: Array<{
      idempotencyKey: string | undefined;
      authorization: string | undefined;
      body: { accountId: string; target: { channelId: string; to: string }; content: { text: string }; meta?: { idempotencyKey?: string } };
      messageId: string;
    }> = [];
    const server: Server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/outbound") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (failOutbound502) {
        res.statusCode = 502;
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        accountId: string;
        target: { channelId: string; to: string };
        content: { text: string };
        meta?: { idempotencyKey?: string };
      };
      const messageId = `plat-msg-${outboundRequests.length + 1}`;
      outboundRequests.push({
        idempotencyKey: typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined,
        authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        body,
        messageId,
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, messageId }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    CLEANUPS.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Missing platform port");
    const platformUrl = `http://127.0.0.1:${addr.port}`;

    const configPath = join(root, "config.jsonc");
    const key = randomBytes(32);
    const store = new EncryptedVaultSecretStore({
      vaultPath: join(root, "vault.json"),
      masterKey: { state: async () => "unlocked", loadExisting: async () => Buffer.from(key), loadOrCreate: async () => Buffer.from(key) },
    });
    await writeConfig({}, { configPath });
    const configuration = new ChannelConfiguration(configPath, store);
    const log = new FileAuthorityCommitLog(join(root, "authority"), new FileArtifactStore(join(root, "facts")));
    registerDeviceLifecycleProjection(log);
    const routes = new Map<string, HttpHandler>();
    const received: InboundMessage[] = [];
    const system: SetupChannelsResult = await setupChannels({
      authorityLog: () => log,
      configuration,
      artifactDirectory: join(root, "extensions", "artifacts"),
      httpRoutes: routes,
      isCurrentOwner: () => true,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    CLEANUPS.push(async () => {
      await system.dispose();
      await log.stopStorageMaintenance();
    });
    await system.connectConfigured({
      inbound: {
        kind: "router",
        handleMessage: async (msg) => {
          received.push(msg);
        },
      },
      onChallengeAction: async () => {},
    });
    await system.activate();

    const api = new ProductApiDispatcher(EXTENSION_PRODUCT_API_EXACT_SET, [system.productApi]);
    const prepReq = { action: "prepare" as const, id: "op-starter", instanceId: "my-starter", source: { conversationId: "ws:scene:primary", request: "connect starter" } };
    await api.command(extensionManage, prepReq);
    await api.command(extensionManage, { action: "connect", id: "op-starter", expectedRevision: 1, candidate });

    const cfg = { messaging: { "my-starter": { type: "starter-channel" } } };
    const creds = { channels: { "my-starter": { accountId: "acct-1", endpointUrl: platformUrl, apiToken: "starter-tok-1" } } };
    await configuration.stage(["my-starter"], cfg, creds, {}, { "my-starter": true });
    await writeConfig(cfg, { configPath });
    await writeCredentials(creds, { store });
    await api.command(extensionApplyConfiguration, { ids: ["my-starter"] });
    await expect.poll(async () => (await api.query(extensionList, undefined)).instances[0]?.phase, { timeout: 10_000 }).toBe("running");

    const webhook = async (payload: Record<string, unknown>) => {
      const handler = routes.get("/channels/my-starter/webhook");
      if (!handler) throw new Error("starter webhook route not registered");
      let status = 200;
      let body = "";
      await handler(
        Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), {
          method: "POST",
          headers: { "x-starter-token": "starter-tok-1" },
        }) as never,
        {
          writeHead(codeNum: number) {
            status = codeNum;
          },
          end(val?: Buffer) {
            body = val?.toString("utf8") ?? "";
          },
        } as never,
      );
      return { status, body };
    };

    const unverified = await webhook({ messageId: "m-early", from: "owner-1", text: "business before verify", chatType: "dm" });
    expect(unverified.status).toBe(403);
    expect(outboundRequests).toHaveLength(0);

    const setupCodes = await api.query(extensionLocalSetup, undefined);
    const connectCmd = /连接 [a-f0-9]{32}/.exec(setupCodes["my-starter"] ?? "")?.[0];
    expect(connectCmd).toBeTruthy();
    const step2 = await webhook({ messageId: "m-conn", from: "owner-1", text: connectCmd!, chatType: "dm" });
    expect(step2.status).toBe(200);
    expect(outboundRequests).toHaveLength(1);
    const challengeCmd = /确认 [a-f0-9]{32}/.exec(outboundRequests[0]!.body.content.text)?.[0];
    expect(challengeCmd).toBeTruthy();

    failOutbound502 = true;
    const step3Fail = await webhook({ messageId: "m-conf-1", from: "owner-1", text: challengeCmd!, chatType: "dm" });
    expect([403, 500]).toContain(step3Fail.status);
    const afterCommit = (await api.query(extensionList, undefined)).instances[0]!;
    expect(afterCommit.admission?.ready).toBe(true);

    failOutbound502 = false;
    const step3Retry = await webhook({ messageId: "m-conf-2", from: "owner-1", text: challengeCmd!, chatType: "dm" });
    expect(step3Retry.status).toBe(200);
    expect(outboundRequests).toHaveLength(2);
    expect(outboundRequests[1]!.body.content.text).toContain("连接验证已完成");
    expect(outboundRequests[1]!.idempotencyKey).toMatch(/^extension-verified:/);
    expect(system.inbound.has("my-starter")).toBe(true);
    expect(system.delivery.status("my-starter")).toBe("connected");

    const biz = await webhook({ messageId: "m-biz-1", from: "owner-1", text: "real business ping", chatType: "dm" });
    expect(biz.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("real business ping");

    const deliveryRes = await system.delivery.send(
      { channelId: "my-starter", to: "owner-1" },
      { text: "reply pong" },
      { idempotencyKey: "biz-reply-1" },
    );
    expect(deliveryRes).toMatchObject({ success: true, retryable: false, messageId: "plat-msg-3" });
    expect(outboundRequests).toHaveLength(3);
    expect(outboundRequests[2]).toMatchObject({
      idempotencyKey: "biz-reply-1",
      authorization: "Bearer starter-tok-1",
      body: { accountId: "acct-1", target: { channelId: "my-starter", to: "owner-1" }, content: { text: "reply pong" } },
    });
  });
});
