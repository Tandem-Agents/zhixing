import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { FileAuthorityCommitLog, FileArtifactStore } from "@zhixing/core/authority";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
import { ExtensionApplication, EXTENSION_PRODUCT_API_EXACT_SET, extensionManage, extensionApplyConfiguration, extensionList, extensionLocalSetup } from "@zhixing/core/extensions/application";
import { resolveConversationId } from "../../../../server/src/channels/conversation-binder.js";
import type { ExtensionCandidate, ExtensionOperation } from "@zhixing/core/extensions/contracts";
import { EncryptedVaultSecretStore } from "@zhixing/secrets";
import { writeConfig, writeCredentials } from "@zhixing/providers";
import { setupChannels, type SetupChannelsResult } from "../channels.js";
import { ChannelConfiguration } from "../../runtime/extensions/channel-configuration.js";
import { createChannelExtensionReadiness } from "../../runtime/extensions/channel-readiness.js";
import { createChannelTypeBinding } from "../../runtime/extensions/channel-binding.js";
import { listSupportedChannels } from "../../registries/channels.js";
import { messagingSection } from "../../config-editor/sections/messaging.js";
import { checkMessaging } from "../../config-editor/checks/messaging.js";
import { extensionContinuationText } from "../extension-continuation.js";
import { renderInputPanel } from "../../config-editor/panels/input.js";
import { renderEntityPanel } from "../../config-editor/panels/entity.js";
import { Renderer } from "../../tui/index.js";

vi.mock("../../runtime/extensions/catalog.js", () => ({ packagedExtensions: () => [] }));
const roots: string[] = [];
const systems: SetupChannelsResult[] = [];
let code: string;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("tsup"))("esbuild");
  const result = await build({ entryPoints: [fileURLToPath(new URL("./fixtures/onboarding-channel.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
  code = result.outputFiles[0].text;
});
afterEach(async () => {
  await Promise.all(systems.splice(0).map(system => system.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(kind: "existing" | "authored" = "authored") {
  const root = await mkdtemp(join(tmpdir(), "zhixing-onboard-")); roots.push(root);
  const configPath = join(root, "config.jsonc");
  const artifactDirectory = join(root, "extensions", "artifacts");
  const key = randomBytes(32);
  const store = new EncryptedVaultSecretStore({ vaultPath: join(root, "vault.json"), masterKey: {
    state: async () => "unlocked", loadExisting: async () => Buffer.from(key), loadOrCreate: async () => Buffer.from(key),
  } });
  await writeConfig({}, { configPath });
  const configuration = new ChannelConfiguration(configPath, store);
  const candidate: ExtensionCandidate = { code, manifest: { id: "new-platform", version: "1.0.0", digest: createHash("sha256").update(code).digest("hex"),
    runtime: "node24", entry: "adapter.mjs", protocol: 1, type: "channel", contract: 1,
    declaration: { label: "测试平台", identityFields: ["account"], requiredFields: [
      { id: "account", label: "账号", hint: "", example: "", sensitive: false },
      { id: "token", label: "密钥", hint: "", example: "", sensitive: true },
    ], capabilities: { chatTypes: ["dm", "group", "thread"], media: false, edit: false, streaming: false } } },
    provenance: { url: "https://example.com/official-api", revision: "1.0.0", kind }, sources: { "adapter.mjs": code }, build: "Node 24; fixed bundled fixture" };
  const log = () => new FileAuthorityCommitLog(join(root, "authority"), new FileArtifactStore(join(root, "facts")));
  const notifications: ExtensionOperation[] = [];
  const received: unknown[] = [];
  const routes = new Map();
  const open = async () => {
    const system = await setupChannels({ authorityLog: log, configuration, artifactDirectory, httpRoutes: routes,
      isCurrentOwner: () => true, logger: { debug() {}, info() {}, warn() {}, error() {} },
      notifyOperation: async operation => { notifications.push(operation); } });
    systems.push(system);
    const api = new ProductApiDispatcher(EXTENSION_PRODUCT_API_EXACT_SET, [system.productApi]);
    await system.connectConfigured({ inbound: { kind: "router", handleMessage: async message => { received.push(message); } }, onChallengeAction: async () => {} });
    await system.activate();
    return { system, api };
  };
  const made = await open();
  const request = { action: "prepare" as const, id: "operation", instanceId: "my-app", source: { conversationId: "workscene-fixture", request: "在测试 APP 使用知行" } };
  const configure = async (api = made.api, waitForRunning = true) => {
    const config = { messaging: { "my-app": { type: "new-platform" } } };
    const credentials = { channels: { "my-app": { account: "owner-account", token: "private-fixture-token" } } };
    await configuration.stage(["my-app"], config, credentials, {}, { "my-app": true });
    await writeConfig(config, { configPath }); await writeCredentials(credentials, { store });
    await api.command(extensionApplyConfiguration, { ids: ["my-app"] });
    if (waitForRunning) await expect.poll(async () => (await api.query(extensionList, undefined)).instances[0]?.phase).toBe("running");
  };
  const http = async (message?: object) => {
    const handler = routes.get("/channels/my-app/fixture");
    if (!handler) throw new Error("fixture route unavailable");
    let status = 200; let body = "";
    await handler(Object.assign(Readable.from(message ? [Buffer.from(JSON.stringify(message))] : []), { method: message ? "POST" : "GET", headers: {} }),
      { writeHead(value: number) { status = value; }, end(value?: Buffer) { body = value?.toString() ?? ""; } });
    return { status, body };
  };
  return { ...made, candidate, request, root, configPath, store, open, log, configuration, artifactDirectory, notifications, received, configure, http };
}

describe("published extension onboarding production path", { timeout: 40_000 }, () => {
  it("keeps text controls available during retirement without admitting new business or routes", async () => {
    const message = vi.fn(async (_message, controlOnly) => { if (!controlOnly) throw new Error("unexpected business admission"); });
    const binding = createChannelTypeBinding({ instance: { id: "one" } as never,
      consumers: () => ({ message, challenge: async () => {} }), routes: new Map(), ready: () => {} });
    binding.quiesce!();
    const payload = { channelId: "one", messageId: "cancel-original-run", from: "owner", text: "取消", chatType: "dm" };
    await binding.receive({ method: "channel.message", payload });
    expect(message).toHaveBeenCalledWith(payload, true);
    await expect(binding.receive({ method: "channel.register-route", payload: { path: "/channels/one/new" } })).rejects.toThrow("handing over");
    binding.close();
    await expect(binding.receive({ method: "channel.message", payload })).rejects.toThrow("expired");
  });

  async function ready(f: Awaited<ReturnType<typeof fixture>>) {
    await f.api.command(extensionManage, f.request);
    await f.api.command(extensionManage, { action: "connect", id: "operation", expectedRevision: 1, candidate: f.candidate });
    await f.configure();
    const command = /连接 [a-f0-9]{32}/.exec((await f.api.query(extensionLocalSetup, undefined))["my-app"]!)![0];
    await f.http({ from: "owner", text: command, messageId: "first-proof" });
    await f.http({ from: "owner", text: /确认 [a-f0-9]{32}/.exec(JSON.parse((await f.http()).body).lastReply)![0], messageId: "confirmed-proof" });
    return (await f.api.query(extensionList, undefined)).instances[0]!;
  }
  const version = (candidate: ExtensionCandidate, suffix: string, code = `${candidate.code}\n// ${suffix}`): ExtensionCandidate => ({ ...candidate, code,
    manifest: { ...candidate.manifest, version: "1.0.1", digest: createHash("sha256").update(code).digest("hex") },
    sources: { "adapter.mjs": code }, provenance: { ...candidate.provenance, revision: suffix } });

  it.each([true, false])("gates HTTP controls on prior admission between committed handover and retirement (admitted: %s)", async admitted => {
    const originalCode = code;
    code = code.replace("lastKey = meta?.idempotencyKey;", 'lastKey = meta?.idempotencyKey; if (content.text === "hold-send") await new Promise(resolve => { globalThis.releaseHeldSend = resolve; });')
      .replace('await context.onMessage({', 'if (message.text === "release-held-send") { globalThis.releaseHeldSend?.(); res.end("{}"); return; } await context.onMessage({');
    expect(code).not.toBe(originalCode);
    const f = await fixture(); code = originalCode;
    if (admitted) await ready(f);
    else {
      await f.api.command(extensionManage, f.request);
      await f.api.command(extensionManage, { action: "connect", id: "operation", expectedRevision: 1, candidate: f.candidate });
      await f.configure();
    }
    const controls: string[] = [];
    await f.system.connectConfigured({ inbound: { kind: "router", handleMessage: async () => {},
      handleControlMessage: async message => { if (message.text !== "取消") return false; controls.push(message.text); return true; } }, onChallengeAction: async () => {} });
    let settled = !admitted;
    const sending = admitted ? f.system.delivery.send({ channelId: "my-app", to: "owner" }, { text: "hold-send" }).finally(() => { settled = true; })
      : Promise.resolve({ success: true });
    void sending.catch(() => {});
    if (admitted) await expect.poll(async () => JSON.parse((await f.http()).body).lastReply).toBe("hold-send");
    await f.api.command(extensionManage, { action: admitted ? "update" : "repair", id: "maintenance", instanceId: "my-app", source: f.request.source });
    let committed!: () => void, resume!: () => void;
    const committedGate = new Promise<void>(resolve => { committed = resolve; });
    const resumeGate = new Promise<void>(resolve => { resume = resolve; });
    const acknowledge = f.configuration.acknowledge.bind(f.configuration);
    const spy = vi.spyOn(f.configuration, "acknowledge").mockImplementationOnce(async (...args) => {
      await acknowledge(...args); committed(); await resumeGate;
    });
    const switching = f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: 1, candidate: version(f.candidate, "http") });
    void switching.catch(() => {});
    try {
      await committedGate;
      expect((await f.api.query(extensionList, undefined)).instances[0]!.generation).toBeNull();
      const control = await f.http({ from: "owner", text: "取消", messageId: "cancel-original" });
      const business = await f.http({ from: "owner", text: "new business", messageId: "during-handover" });
      expect(control.status).toBe(admitted ? 200 : 503); expect(controls).toEqual(admitted ? ["取消"] : []);
      expect(business.status).toBe(503);
      expect((await f.http({ from: "owner", text: `确认 ${"f".repeat(32)}`, messageId: "late-proof" })).status).toBe(503);
      if (admitted) expect(settled).toBe(false);
    } finally {
      if (admitted) await f.http({ text: "release-held-send" });
      resume(); spy.mockRestore();
      await Promise.all([sending, switching]);
    }
    await expect(sending).resolves.toMatchObject({ success: true });
  });

  it.each(["cancel", "disable"] as const)("fences new sends after %s commits but before physical handover", async action => {
    const f = await fixture(); await ready(f);
    await f.api.command(extensionManage, { action: "update", id: "maintenance", instanceId: "my-app", source: f.request.source });
    await f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: 1, candidate: version(f.candidate, "rollback") });
    await expect.poll(async () => { try { return JSON.parse((await f.http()).body).lastReply; } catch { return ""; } }, { timeout: 5000 }).toContain("换版");
    const operation = (await f.api.query(extensionList, undefined)).operations!.find(op => op.id === "maintenance")!;
    let release!: () => void; let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const method = action === "cancel" ? "cancel" : "setEnabled";
    const original = ExtensionApplication.prototype[method];
    const spy = vi.spyOn(ExtensionApplication.prototype, method).mockImplementation(async function (this: ExtensionApplication, ...args: unknown[]) {
      const result = await (original as (...values: unknown[]) => Promise<unknown>).apply(this, args); reached(); await barrier; return result;
    } as never);
    const stopping = f.api.command(extensionManage, action === "cancel" ? { action, id: operation.id, expectedRevision: operation.revision } : { action, instanceId: "my-app" });
    await entered;
    try { await expect(f.system.delivery.send({ channelId: "my-app", to: "owner" }, { text: "unverified-candidate-business" })).resolves.toMatchObject({ success: false, retryable: true, attempted: false, error: "Channel not available" }); }
    finally { release(); spy.mockRestore(); await stopping; }
  });

  it("rejects changed declared grouping before handover and changed runtime grouping before admission", async () => {
    const f = await fixture(); const original = await ready(f);
    const message = { channelId: "my-app", chatType: "group" as const, groupId: "group", from: "owner", text: "取消", messageId: "existing-confirmation" };
    const before = resolveConversationId(message, f.system.inbound.bindingPolicy("my-app"));
    await f.api.command(extensionManage, { action: "update", id: "maintenance", instanceId: "my-app", source: f.request.source });
    const candidate = version(f.candidate, "declared");
    await f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: 1, candidate: { ...candidate,
      manifest: { ...candidate.manifest, declaration: { ...candidate.manifest.declaration as object, bindingPolicy: { group: "per-user-in-group" } } } } });
    let state = await f.api.query(extensionList, undefined);
    expect(state.operations!.find(op => op.id === "maintenance")?.phase).toBe("blocked");
    expect(state.instances[0]!.generation).toBe(original.generation);
    const changedCode = f.candidate.code.replace(/id,\s+capabilities:/, 'id, bindingPolicy: { group: "per-user-in-group" }, capabilities:');
    expect(changedCode).not.toBe(f.candidate.code);
    await f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: state.operations!.find(op => op.id === "maintenance")!.revision,
      candidate: version(f.candidate, "runtime", changedCode) });
    await expect.poll(async () => (await f.api.query(extensionList, undefined)).operations!.find(op => op.id === "maintenance")?.phase, { timeout: 14000 }).toBe("blocked");
    state = await f.api.query(extensionList, undefined);
    expect(state.instances[0]!.binding.manifest.digest).toBe(original.binding.manifest.digest);
    expect(resolveConversationId(message, f.system.inbound.bindingPolicy("my-app"))).toBe(before);
  });

  it.each([false, true])("requires the active source archive before duty transfer (verifying: %s)", async verifying => {
    const f = await fixture(); await ready(f);
    let current = f.candidate;
    if (verifying) {
      await f.api.command(extensionManage, { action: "update", id: "maintenance", instanceId: "my-app", source: f.request.source });
      current = version(f.candidate, "new-active");
      await f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: 1, candidate: current });
    }
    const readiness = createChannelExtensionReadiness(f.configuration, f.artifactDirectory);
    expect((await readiness(f.log())).channels).toEqual(["my-app"]);
    await rm(join(f.root, "extensions", "candidates", current.manifest.digest, "candidate.json"));
    await expect(readiness(f.log())).rejects.toThrow();
  });

  it("refuses a repair that expands declared capability before retiring the original process", async () => {
    const f = await fixture(); const original = await ready(f);
    await f.api.command(extensionManage, { action: "repair", id: "maintenance", instanceId: "my-app", source: f.request.source });
    const declaration = f.candidate.manifest.declaration as { capabilities: object };
    const candidate = version(f.candidate, "expanded");
    await f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: 1,
      candidate: { ...candidate, manifest: { ...candidate.manifest, declaration: { ...declaration, capabilities: { ...declaration.capabilities, media: true } } } } });
    const state = await f.api.query(extensionList, undefined);
    expect(state.operations?.find(op => op.id === "maintenance")?.phase).toBe("blocked");
    expect(state.instances[0]?.generation).toBe(original.generation);
    expect((await f.system.delivery.send({ channelId: "my-app", to: "owner" }, { text: "old connection" })).success).toBe(true);
  });

  it("requires the pinned rollback artifact and local account materials before duty transfer", async () => {
    const f = await fixture(); const original = await ready(f);
    await f.api.command(extensionManage, { action: "update", id: "maintenance", instanceId: "my-app", source: f.request.source });
    const candidate = version(f.candidate, "transfer");
    await f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: 1, candidate });
    await expect.poll(async () => (await f.api.query(extensionList, undefined)).instances[0]?.phase).toBe("running");
    const readiness = createChannelExtensionReadiness(f.configuration, f.artifactDirectory);
    expect((await readiness(f.log())).channels).toEqual(["my-app"]);
    await rm(join(f.artifactDirectory, original.binding.manifest.digest, original.binding.manifest.entry));
    await expect(readiness(f.log())).rejects.toThrow();
  });

  it.each(["update", "repair"] as const)("runs %s through preparation, archived source, isolated handover and fresh round-trip verification", async action => {
    const f = await fixture(); const original = await ready(f);
    await f.api.command(extensionManage, { action, id: "maintenance", instanceId: "my-app", source: f.request.source });
    expect((await f.api.query(extensionList, undefined)).instances[0]?.generation).toBe(original.generation);
    expect((await f.api.command(extensionManage, { action: "candidate", id: "maintenance" })).result.candidate).toEqual(f.candidate);
    expect((await f.system.delivery.send({ channelId: "my-app", to: "owner" }, { text: "still available during preparation" })).success).toBe(true);
    const candidate = version(f.candidate, action);
    await f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: 1, candidate });
    await expect.poll(async () => (await f.api.query(extensionList, undefined)).instances[0]?.phase).toBe("running");
    await expect.poll(async () => {
      try { return JSON.parse((await f.http()).body).lastReply; } catch { return ""; }
    }).toContain("换版");
    await expect(f.system.delivery.send({ channelId: "my-app", to: "owner" }, { text: "not yet admitted" })).resolves.toMatchObject({ success: false, retryable: true, attempted: false, error: "连接尚未通过收发验证" });
    expect((await f.http({ from: "owner", text: "ordinary request", messageId: "no-business" })).status).toBe(503);
    const confirm = /确认 [a-f0-9]{32}/.exec(JSON.parse((await f.http()).body).lastReply)![0];
    expect((await f.http({ from: "intruder", text: confirm, messageId: "wrong-owner" })).status).toBe(503);
    expect((await f.http({ from: "owner", text: confirm, messageId: "new-confirmation" })).status).toBe(200);
    const state = await f.api.query(extensionList, undefined);
    expect(state.instances[0]?.binding.manifest.digest).toBe(candidate.manifest.digest);
    expect(state.instances[0]?.binding.exclusiveKey).toBe(original.binding.exclusiveKey);
    expect(state.operations?.find(op => op.id === "maintenance")?.phase).toBe("ready");
    expect((await f.system.delivery.send({ channelId: "my-app", to: "owner" }, { text: "restored" })).success).toBe(true);
    expect((await f.http({ from: "owner", text: "normal work", messageId: "after-update" })).status).toBe(200);
    expect(f.received).toHaveLength(1);
  });

  it.each(["cancel", "disable"] as const)("honors %s during verification and fences late proof across restart", async action => {
    const f = await fixture(); const original = await ready(f);
    await f.api.command(extensionManage, { action: "update", id: "maintenance", instanceId: "my-app", source: f.request.source });
    await f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: 1, candidate: version(f.candidate, action) });
    await expect.poll(async () => (await f.api.query(extensionList, undefined)).instances[0]?.phase).toBe("running");
    const operation = (await f.api.query(extensionList, undefined)).operations!.find(op => op.id === "maintenance")!;
    await f.api.command(extensionManage, action === "cancel" ? { action, id: operation.id, expectedRevision: operation.revision } : { action, instanceId: "my-app" });
    await f.system.dispose(); systems.splice(systems.indexOf(f.system), 1);
    const reopened = await f.open();
    const state = await reopened.api.query(extensionList, undefined);
    expect(state.instances[0]?.binding).toEqual(original.binding);
    expect(state.instances[0]?.enabled).toBe(action === "cancel");
    expect(state.operations?.find(op => op.id === "maintenance")?.phase).toBe("cancelled");
    if (action === "cancel") {
      await expect.poll(() => reopened.system.delivery.status("my-app")).toBe("connected");
      expect((await reopened.system.delivery.send({ channelId: "my-app", to: "owner" }, { text: "old version survives" })).success).toBe(true);
    }
  });

  it("automatically rolls back an unusable candidate and can repair it with a different fixed artifact", async () => {
    const f = await fixture(); const original = await ready(f);
    await f.api.command(extensionManage, { action: "repair", id: "maintenance", instanceId: "my-app", source: f.request.source });
    await f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: 1,
      candidate: version(f.candidate, "broken", 'throw new Error("broken fixture");') });
    await expect.poll(async () => (await f.api.query(extensionList, undefined)).operations?.find(op => op.id === "maintenance")?.phase, { timeout: 14000 }).toBe("blocked");
    await expect.poll(() => f.system.delivery.status("my-app")).toBe("connected");
    const failed = await f.api.query(extensionList, undefined);
    expect(failed.instances[0]?.binding).toEqual(original.binding);
    const candidate = version(f.candidate, "corrected");
    await f.api.command(extensionManage, { action: "connect", id: "maintenance", expectedRevision: failed.operations!.find(op => op.id === "maintenance")!.revision, candidate });
    await expect.poll(async () => {
      try { return JSON.parse((await f.http()).body).lastReply; } catch { return ""; }
    }).toContain("换版");
    await f.http({ from: "owner", text: /确认 [a-f0-9]{32}/.exec(JSON.parse((await f.http()).body).lastReply)![0], messageId: "repaired-proof" });
    expect((await f.api.query(extensionList, undefined)).instances[0]?.binding.manifest.digest).toBe(candidate.manifest.digest);
    expect((await f.system.delivery.send({ channelId: "my-app", to: "owner" }, { text: "fixed" })).success).toBe(true);
  });

  it.each([false, true])("invalidates the previous account verification when configuration changes (already ready: %s)", async ready => {
    const f = await fixture();
    await f.api.command(extensionManage, f.request);
    await f.api.command(extensionManage, { action: "connect", id: "operation", expectedRevision: 1, candidate: f.candidate });
    await f.configure();
    const command = /连接 [a-f0-9]{32}/.exec((await f.api.query(extensionLocalSetup, undefined))["my-app"]!)![0];
    await f.http({ from: "owner", text: command, messageId: "verify-a-1" });
    const oldReply = JSON.parse((await f.http()).body);
    const oldConfirm = /确认 [a-f0-9]{32}/.exec(oldReply.lastReply)![0];
    if (ready) await f.http({ from: "owner", text: oldConfirm, messageId: "verify-a-2" });
    const before = (await f.api.query(extensionList, undefined)).instances[0]!;
    const config = { messaging: { "my-app": { type: "new-platform" } } };
    const credentials = { channels: { "my-app": { account: "different-account", token: "fixture-b-token" } } };
    await f.configuration.stage(["my-app"], config, credentials, { "my-app": before }, { "my-app": true });
    await writeConfig(config, { configPath: f.configPath }); await writeCredentials(credentials, { store: f.store });
    await f.api.command(extensionApplyConfiguration, { ids: ["my-app"] });
    await expect.poll(async () => {
      const current = (await f.api.query(extensionList, undefined)).instances[0]!;
      return current.phase === "running" && current.generation !== before.generation;
    }).toBe(true);
    expect((await f.http({ from: "owner", text: oldConfirm, messageId: "late-confirm-a" })).status).toBe(503);
    expect((await f.http({ from: "owner", text: "business", messageId: "unverified-b" })).status).toBe(503);
    await expect(f.system.delivery.send({ channelId: "my-app", to: "owner" }, { text: "business" })).resolves.toMatchObject({ success: false, retryable: true, attempted: false, error: "连接尚未通过收发验证" });
    expect((await f.api.query(extensionList, undefined)).instances[0]?.admission?.ready).toBe(false);
    expect(f.received).toHaveLength(0);
    expect((await f.http({ from: "owner", text: command, messageId: "late-connect-a" })).status).toBe(503);
    const newCommand = /连接 [a-f0-9]{32}/.exec((await f.api.query(extensionLocalSetup, undefined))["my-app"]!)![0];
    expect(newCommand).not.toBe(command);
    await f.http({ from: "owner", text: newCommand, messageId: "verify-b-1" });
    const newReply = JSON.parse((await f.http()).body);
    const newConfirm = /确认 [a-f0-9]{32}/.exec(newReply.lastReply)![0];
    expect(newReply.lastKey).not.toBe(oldReply.lastKey);
    expect(newConfirm).not.toBe(oldConfirm);
    expect((await f.http({ from: "owner", text: newConfirm, messageId: "verify-b-2" })).status).toBe(200);
    expect((await f.api.query(extensionList, undefined)).instances[0]?.admission?.ready).toBe(true);
  });

  it("keeps each instance's exact fields and sensitivity when another version is being installed", async () => {
    const f = await fixture();
    const a = f.candidate.manifest;
    const declaration = a.declaration as { requiredFields: Array<{ id: string; sensitive: boolean }> };
    const b = { ...a, version: "2.0.0", digest: "b".repeat(64), declaration: { ...declaration,
      requiredFields: declaration.requiredFields.map(field => field.id === "token" ? { ...field, sensitive: false } : field) } };
    const catalog = listSupportedChannels({ instances: [{ id: "instance-a", binding: { manifest: a } } as never],
      operations: [{ instanceId: "instance-b", phase: "configuration", candidate: b } as never] });
    const state = { config: { messaging: { "instance-a": { type: a.id }, "instance-b": { type: b.id } } },
      credentials: { channels: { "instance-a": { account: "A", token: "synthetic-secret" }, "instance-b": { account: "B", token: "public-value" } } },
      inputBuffer: "", channelCatalog: catalog };
    const render = (id: string, entity = false, buffer = "") => {
      let output = "";
      const renderer = new Renderer({ columns: 100, write: (chunk: string) => { output += chunk; return true; } } as unknown as NodeJS.WritableStream);
      if (entity) renderEntityPanel(state, { kind: "channel-config", channelId: id }, { index: 0 }, renderer);
      else renderInputPanel({ ...state, inputBuffer: buffer }, { kind: "input", fieldId: `channel-field:${id}:token` }, renderer);
      renderer.flush();
      return output;
    };
    expect(render("instance-a")).not.toContain("synthetic-secret");
    expect(render("instance-a", true)).not.toContain("synthetic-secret");
    expect(render("instance-a", false, "new-secret")).not.toContain("new-secret");
    expect(render("instance-b")).toContain("public-value");
    expect(render("instance-b", true)).toContain("public-value");
    expect(checkMessaging(state.config, state.credentials, undefined, catalog)).toEqual([]);
    const changedFields = { ...b, declaration: { ...declaration, requiredFields: declaration.requiredFields.map(field => field.id === "token" ? { ...field, id: "v2-field" } : field) } };
    const independent = listSupportedChannels({ instances: [{ id: "instance-a", binding: { manifest: a } } as never],
      operations: [{ instanceId: "instance-b", phase: "configuration", candidate: changedFields } as never] });
    expect(checkMessaging(state.config, state.credentials, undefined, independent).map(issue => [issue.channelId, issue.field])).toEqual([["instance-b", "v2-field"]]);
  });

  it("automatically reports exhausted trial startup without a query or resetting its retry budget", async () => {
    const f = await fixture();
    const brokenCode = 'throw new Error("fixture startup failure");';
    const broken = { ...f.candidate, code: brokenCode, manifest: { ...f.candidate.manifest, digest: createHash("sha256").update(brokenCode).digest("hex") } };
    await f.api.command(extensionManage, f.request);
    await f.api.command(extensionManage, { action: "connect", id: "operation", expectedRevision: 1, candidate: broken });
    await f.configure(f.api, false);
    await expect.poll(() => f.notifications.some(operation => operation.phase === "blocked"), { timeout: 14000 }).toBe(true);
    const failed = await f.api.query(extensionList, undefined);
    expect(failed.operations![0]!.phase).toBe("blocked");
    expect(failed.instances[0]!.admission?.ready).toBe(false);
    await f.api.command(extensionManage, { action: "status" });
    expect((await f.api.query(extensionList, undefined)).instances[0]!.generation).toBe(failed.instances[0]!.generation);
    expect(f.notifications.filter(operation => operation.phase === "blocked")).toHaveLength(1);
    await f.api.command(extensionManage, { action: "repair", id: "correct-first-trial", instanceId: "my-app", source: f.request.source });
    expect(f.notifications.some(operation => operation.id === "correct-first-trial" && operation.phase === "preparing")).toBe(true);
    const archived = (await f.api.command(extensionManage, { action: "candidate", id: "correct-first-trial" })).result.candidate!;
    expect(archived.manifest.digest).toBe(broken.manifest.digest);
    let correctionRevision = 1;
    for (const declaration of [
      { ...f.candidate.manifest.declaration as object, capabilities: { ...(f.candidate.manifest.declaration as { capabilities: object }).capabilities, media: true } },
      { ...f.candidate.manifest.declaration as object, requiredFields: [...(f.candidate.manifest.declaration as { requiredFields: object[] }).requiredFields,
        { id: "newField", label: "新字段", hint: "", example: "", sensitive: false }] },
    ]) {
      const incompatible = version(f.candidate, `incompatible-${correctionRevision}`);
      await f.api.command(extensionManage, { action: "connect", id: "correct-first-trial", expectedRevision: correctionRevision,
        candidate: { ...incompatible, manifest: { ...incompatible.manifest, declaration } } });
      const rejected = await f.api.query(extensionList, undefined);
      const operation = rejected.operations!.find(op => op.id === "correct-first-trial")!;
      expect(operation.phase).toBe("blocked");
      expect(rejected.instances[0]!.binding).toEqual(failed.instances[0]!.binding);
      correctionRevision = operation.revision;
    }
    await f.api.command(extensionManage, { action: "connect", id: "correct-first-trial", expectedRevision: correctionRevision, candidate: f.candidate });
    await expect.poll(async () => (await f.api.query(extensionList, undefined)).instances[0]?.phase).toBe("running");
    const corrected = (await f.api.query(extensionList, undefined)).instances[0]!;
    expect(corrected.id).toBe("my-app");
    expect(corrected.binding.projectionRevision).toBe(failed.instances[0]!.binding.projectionRevision);
    expect(corrected.admission?.ready).toBe(false);
    const command = /连接 [a-f0-9]{32}/.exec((await f.api.query(extensionLocalSetup, undefined))["my-app"]!)![0];
    await f.http({ from: "owner", text: command, messageId: "corrected-connect" });
    await f.http({ from: "owner", text: /确认 [a-f0-9]{32}/.exec(JSON.parse((await f.http()).body).lastReply)![0], messageId: "corrected-confirm" });
    expect((await f.api.query(extensionList, undefined)).instances[0]?.admission?.ready).toBe(true);
  });

  it.each(["update", "repair"] as const)("starts a fresh verification after completed %s and later public configuration changes", async action => {
    const f = await fixture(); await ready(f);
    await f.api.command(extensionManage, { action, id: "completed-change", instanceId: "my-app", source: f.request.source });
    const candidate = version(f.candidate, "completed-change");
    await f.api.command(extensionManage, { action: "connect", id: "completed-change", expectedRevision: 1, candidate });
    await expect.poll(async () => { try { return JSON.parse((await f.http()).body).lastReply; } catch { return ""; } }).toContain("换版");
    const oldConfirm = /确认 [a-f0-9]{32}/.exec(JSON.parse((await f.http()).body).lastReply)![0];
    await f.http({ from: "owner", text: oldConfirm, messageId: "complete-update" });
    const before = (await f.api.query(extensionList, undefined)).instances[0]!;
    expect(await f.configuration.pending("my-app")).toBe(false);
    const config = { messaging: { "my-app": { type: "new-platform", ...(action === "repair" ? { options: { locale: "new" } } : {}) } } };
    const credentials = { channels: { "my-app": { account: action === "update" ? "account-B" : "owner-account", token: "private-fixture-token" } } };
    await f.configuration.stage(["my-app"], config, credentials, { "my-app": before }, action === "update" ? { "my-app": true } : {});
    await writeConfig(config, { configPath: f.configPath }); await writeCredentials(credentials, { store: f.store });
    await f.api.command(extensionApplyConfiguration, { ids: ["my-app"] });
    await expect.poll(async () => (await f.api.query(extensionList, undefined)).instances[0]?.phase).toBe("running");
    const current = (await f.api.query(extensionList, undefined)).instances[0]!;
    expect(current.admission?.operationId).not.toBe("completed-change");
    expect(current.admission?.ready).toBe(false);
    expect(current.binding.manifest.digest).toBe(candidate.manifest.digest);
    expect((await f.api.query(extensionList, undefined)).operations!.find(op => op.id === "completed-change")?.phase).toBe("ready");
    expect(JSON.parse((await f.http()).body).lastReply).toBeFalsy();
    expect((await f.http({ from: "owner", text: oldConfirm, messageId: "late-old-confirm" })).status).toBe(503);
    const command = /连接 [a-f0-9]{32}/.exec((await f.api.query(extensionLocalSetup, undefined))["my-app"]!)![0];
    await f.http({ from: "new-owner", text: command, messageId: "new-config-connect" });
    const confirm = /确认 [a-f0-9]{32}/.exec(JSON.parse((await f.http()).body).lastReply)![0];
    await f.system.dispose(); systems.splice(systems.indexOf(f.system), 1);
    const reopened = await f.open();
    await expect.poll(async () => (await reopened.api.query(extensionList, undefined)).instances[0]?.phase).toBe("running");
    expect((await reopened.api.query(extensionList, undefined)).instances[0]?.admission?.operationId).toBe(current.admission!.operationId);
    expect((await f.http({ from: "new-owner", text: confirm, messageId: "new-config-confirm" })).status).toBe(200);
    expect((await reopened.api.query(extensionList, undefined)).instances[0]?.binding).toEqual(current.binding);
    expect((await reopened.api.query(extensionList, undefined)).instances[0]?.admission?.ready).toBe(true);
  });

  it.each(["existing", "authored"] as const)("admits a %s artifact only after safe configuration and real process bidirectional verification", async kind => {
    const f = await fixture(kind);
    await f.api.command(extensionManage, f.request);
    await f.api.command(extensionManage, f.request);
    expect(f.notifications).toHaveLength(1);
    expect(extensionContinuationText(f.notifications[0]!, "device")).toContain("加载“外部能力接入”");
    await f.api.command(extensionManage, { action: "connect", id: "operation", expectedRevision: 1, candidate: f.candidate });
    const waiting = await f.api.query(extensionList, undefined);
    expect(waiting.operations?.[0]?.phase).toBe("configuration");
    expect(listSupportedChannels(waiting).map(item => item.id)).toContain("new-platform");
    expect(checkMessaging({ messaging: { "my-app": { type: "new-platform" } } }, { channels: {} }, undefined, listSupportedChannels(waiting))).toHaveLength(2);
    expect(messagingSection.entries({ config: {}, credentials: {}, inputBuffer: "", channelCatalog: listSupportedChannels(waiting),
      channelStates: { "my-app": { enabled: false, revision: 0, intentRevision: 0, type: "new-platform" } } })).toHaveLength(1);
    await f.configure();
    expect(f.system.delivery.status("my-app")).toBe("disconnected");
    await expect(f.system.delivery.send({ channelId: "my-app", to: "user" }, { text: "business" })).resolves.toMatchObject({ success: false, retryable: true, attempted: false, error: "连接尚未通过收发验证" });
    const instructions = (await f.api.query(extensionLocalSetup, undefined))["my-app"]!;
    const command = /连接 ([a-f0-9]{32})/.exec(instructions)![0];
    expect(JSON.stringify(await f.api.query(extensionList, undefined))).not.toContain(command);
    expect((await f.http({ from: "owner", text: "hello", messageId: "unverified" })).status).toBe(503);
    expect((await f.http({ from: "owner", text: command, messageId: "verify-1" })).status).toBe(200);
    const reply = JSON.parse((await f.http()).body).lastReply as string;
    const confirm = /确认 [a-f0-9]{32}/.exec(reply)![0];
    expect((await f.http({ from: "other-user", text: confirm, messageId: "not-owner" })).status).toBe(503);
    expect((await f.http({ from: "owner", text: confirm, messageId: "verify-2" })).status).toBe(200);
    await expect.poll(() => f.system.delivery.status("my-app")).toBe("connected");
    expect((await f.api.query(extensionList, undefined)).operations?.[0]?.phase).toBe("ready");
    const receipt = JSON.parse((await f.http()).body);
    expect(receipt.lastReply).toBe("连接验证已完成，已确认本人身份和双向收发。");
    expect(receipt.lastKey).toMatch(/^extension-verified:operation:/);
    await f.http({ from: "owner", text: confirm, messageId: "verify-2" });
    expect(JSON.parse((await f.http()).body).lastKey).toBe(receipt.lastKey);
    expect(f.received).toHaveLength(0);
    expect((await f.http({ from: "owner", text: "真实业务", messageId: "business" })).status).toBe(200);
    expect(f.received).toHaveLength(1);
    expect(JSON.stringify(await f.api.query(extensionList, undefined))).not.toContain("private-fixture-token");
    await expect.poll(() => f.notifications.some(op => op.phase === "ready")).toBe(true);
  });

  it("retries a failed completion receipt without revoking the committed verification", async () => {
    const f = await fixture();
    const candidate = version(f.candidate, "receipt-retry", f.candidate.code.replace(
      "lastKey = meta?.idempotencyKey;",
      'lastKey = meta?.idempotencyKey; if (content.text.startsWith("连接验证已完成") && !globalThis.receiptFailed) { globalThis.receiptFailed = true; return { success: false, retryable: true, attempted: false }; }',
    ));
    await f.api.command(extensionManage, f.request);
    await f.api.command(extensionManage, { action: "connect", id: "operation", expectedRevision: 1, candidate });
    await f.configure();
    const command = /连接 [a-f0-9]{32}/.exec((await f.api.query(extensionLocalSetup, undefined))["my-app"]!)![0];
    await f.http({ from: "owner", text: command, messageId: "verify-1" });
    const confirm = /确认 [a-f0-9]{32}/.exec(JSON.parse((await f.http()).body).lastReply)![0];
    expect((await f.http({ from: "owner", text: confirm, messageId: "verify-2" })).status).toBe(503);
    const failedReceipt = JSON.parse((await f.http()).body);
    const committed = await f.api.query(extensionList, undefined);
    expect(committed.instances[0]?.admission?.ready).toBe(true);
    expect(committed.operations?.[0]?.phase).toBe("ready");
    expect((await f.http({ from: "owner", text: confirm, messageId: "verify-2" })).status).toBe(200);
    const retriedReceipt = JSON.parse((await f.http()).body);
    expect(retriedReceipt.lastKey).toBe(failedReceipt.lastKey);
    expect(retriedReceipt.lastReply).toBe("连接验证已完成，已确认本人身份和双向收发。");
    expect((await f.api.query(extensionList, undefined)).operations?.[0]?.revision).toBe(committed.operations?.[0]?.revision);
    expect(f.received).toHaveLength(0);
  });

  it("continues the same candidate after restart and keeps verification proof across process generations", async () => {
    const f = await fixture();
    await f.api.command(extensionManage, f.request);
    await f.api.command(extensionManage, { action: "connect", id: "operation", expectedRevision: 1, candidate: f.candidate });
    await f.system.dispose();
    const reopened = await f.open();
    expect(f.notifications.filter(op => op.phase === "preparing")).toHaveLength(1);
    await f.configure(reopened.api);
    const command = /连接 [a-f0-9]{32}/.exec((await reopened.api.query(extensionLocalSetup, undefined))["my-app"]!)![0];
    await f.http({ from: "owner", text: command, messageId: "verify-1" });
    const confirm = /确认 [a-f0-9]{32}/.exec(JSON.parse((await f.http()).body).lastReply)![0];
    await reopened.system.dispose();
    await createChannelExtensionReadiness(f.configuration, f.artifactDirectory)(f.log());
    const recovered = await f.open();
    await expect.poll(async () => (await recovered.api.query(extensionList, undefined)).instances[0]?.phase).toBe("running");
    expect((await f.http({ from: "owner", text: confirm, messageId: "verify-2" })).status).toBe(200);
    expect((await recovered.api.query(extensionList, undefined)).operations?.[0]?.phase).toBe("ready");
  });

  it("does not activate a cancelled candidate after late credential publication or restart", async () => {
    const f = await fixture();
    await f.api.command(extensionManage, f.request);
    await f.api.command(extensionManage, { action: "connect", id: "operation", expectedRevision: 1, candidate: f.candidate });
    const operation = (await f.api.query(extensionList, undefined)).operations![0]!;
    await f.api.command(extensionManage, { action: "cancel", id: operation.id, expectedRevision: operation.revision });
    const config = { messaging: { "my-app": { type: "new-platform" } } };
    const credentials = { channels: { "my-app": { account: "owner-account", token: "late-fixture-token" } } };
    await f.configuration.stage(["my-app"], config, credentials, {}, { "my-app": true });
    await writeConfig(config, { configPath: f.configPath }); await writeCredentials(credentials, { store: f.store });
    await f.api.command(extensionApplyConfiguration, { ids: ["my-app"] });
    await f.system.dispose();
    const recovered = await f.open();
    expect((await recovered.api.query(extensionList, undefined)).instances).toEqual([]);
    expect((await recovered.api.query(extensionList, undefined)).operations![0]!.phase).toBe("cancelled");
    expect(recovered.system.delivery.status("my-app")).toBe("disconnected");
  });

  it("verifies group/thread replies against the same authenticated person and exact reply route", async () => {
    const f = await fixture();
    await f.api.command(extensionManage, f.request);
    await f.api.command(extensionManage, { action: "connect", id: "operation", expectedRevision: 1, candidate: f.candidate });
    await f.configure();
    const command = /连接 [a-f0-9]{32}/.exec((await f.api.query(extensionLocalSetup, undefined))["my-app"]!)![0];
    const route = { from: "owner", groupId: "group", threadId: "thread", chatType: "thread" };
    await f.http({ ...route, text: command, messageId: "verify-1" });
    const reply = JSON.parse((await f.http()).body);
    expect(reply.lastTarget).toEqual({ channelId: "my-app", to: "group", threadId: "thread" });
    const confirm = /确认 [a-f0-9]{32}/.exec(reply.lastReply)![0];
    expect((await f.http({ ...route, threadId: "different", text: confirm, messageId: "wrong-route" })).status).toBe(503);
    expect((await f.http({ ...route, text: confirm, messageId: "verify-2" })).status).toBe(200);
    expect((await f.api.query(extensionList, undefined)).operations![0]!.phase).toBe("ready");
  });
});
