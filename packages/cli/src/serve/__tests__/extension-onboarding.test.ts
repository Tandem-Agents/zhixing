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
import { EXTENSION_PRODUCT_API_EXACT_SET, extensionManage, extensionApplyConfiguration, extensionList, extensionLocalSetup } from "@zhixing/core/extensions/application";
import type { ExtensionCandidate, ExtensionOperation } from "@zhixing/core/extensions/contracts";
import { EncryptedVaultSecretStore } from "@zhixing/secrets";
import { writeConfig, writeCredentials } from "@zhixing/providers";
import { setupChannels, type SetupChannelsResult } from "../channels.js";
import { ChannelConfiguration } from "../../runtime/extensions/channel-configuration.js";
import { createChannelExtensionReadiness } from "../../runtime/extensions/channel-readiness.js";
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

describe("published extension onboarding production path", { timeout: 20_000 }, () => {
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
    await expect(f.system.delivery.send({ channelId: "my-app", to: "owner" }, { text: "business" })).rejects.toThrow("尚未通过");
    expect((await f.api.query(extensionList, undefined)).instances[0]?.admission?.ready).toBe(false);
    expect(f.received).toHaveLength(0);
    await f.http({ from: "owner", text: command, messageId: "verify-b-1" });
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
    await expect(f.system.delivery.send({ channelId: "my-app", to: "user" }, { text: "business" })).rejects.toThrow("尚未通过");
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
    await f.http({ from: "owner", text: confirm, messageId: "verify-2" });
    expect(f.received).toHaveLength(0);
    expect((await f.http({ from: "owner", text: "真实业务", messageId: "business" })).status).toBe(200);
    expect(f.received).toHaveLength(1);
    expect(JSON.stringify(await f.api.query(extensionList, undefined))).not.toContain("private-fixture-token");
    await expect.poll(() => f.notifications.some(op => op.phase === "ready")).toBe(true);
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
