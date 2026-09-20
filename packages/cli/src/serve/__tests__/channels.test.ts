import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import ts from "typescript";
import { FileAuthorityCommitLog, FileArtifactStore, DeviceLifecycleJournal } from "@zhixing/core/authority";
import { protocolDigest } from "@zhixing/core/protocol";
import { HostStopCoordinator, freezeHostStopAcceptedWork, settleHostStopAcceptedWork, type HostStopAcceptedWorkPorts } from "../host-stop-lifecycle.js";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
import { ExtensionApplication, EXTENSION_PRODUCT_API_EXACT_SET, extensionApplyConfiguration, extensionList, extensionRefresh, extensionSetEnabled } from "@zhixing/core/extensions/application";
import { validateExtensionManifest } from "@zhixing/core/extensions/contracts";
import { EncryptedVaultSecretStore } from "@zhixing/secrets";
import { writeConfig, writeCredentials } from "@zhixing/providers";
import { setupChannels, type SetupChannelsResult, type ConfiguredChannelConsumers } from "../channels.js";
import { ChannelConfiguration } from "../../runtime/extensions/channel-configuration.js";
import { createChannelExtensionReadiness } from "../../runtime/extensions/channel-readiness.js";
import { messagingSection } from "../../config-editor/sections/messaging.js";
import { disableMessaging, enableMessaging } from "../../config-editor/state.js";
import { handleConfigCommand } from "../../runtime/config-command.js";

const catalog = vi.hoisted(() => ({ seeds: [] as unknown[] }));
const editor = vi.hoisted(() => ({ run: vi.fn(), store: undefined as unknown }));
vi.mock("../../runtime/extensions/catalog.js", () => ({ packagedExtensions: () => catalog.seeds }));
vi.mock("../../config-editor/runner.js", () => ({ runEventLoop: editor.run }));
vi.mock("../../commands/command-visibility.js", () => ({ requireChrome: () => true }));
vi.mock("@zhixing/secrets", async (original) => ({ ...await original<typeof import("@zhixing/secrets")>(), createPlatformSecretStore: () => editor.store }));
const roots: string[] = [];
const systems: SetupChannelsResult[] = [];
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const outbound: ConfiguredChannelConsumers = { inbound: { kind: "absent", reason: "outbound-only" }, onChallengeAction: async () => {} };
let bytes: Uint8Array;
let compile: (source: string) => string;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build, transformSync } = createRequire(require.resolve("tsup"))("esbuild");
  compile = (source) => transformSync(source, { loader: "ts", target: "node24" }).code;
  const result = await build({ entryPoints: [fileURLToPath(new URL("./fixtures/channel-extension.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", target: "node24", format: "esm", logLevel: "silent" });
  bytes = result.outputFiles[0].contents;
});
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  catalog.seeds = [];
  editor.run.mockReset(); editor.store = undefined;
});

async function fixture(ids = ["one"], options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "zhixing-channel-extension-")); roots.push(root);
  const configPath = join(root, "config.jsonc");
  const manifest = validateExtensionManifest({ id: "fixture", version: "1.0.0",
    digest: createHash("sha256").update(bytes).digest("hex"), runtime: "node24", entry: "extension.mjs",
    protocol: 1, type: "channel", contract: 1, declaration: { label: "测试连接", identityFields: ["account"], requiredFields: [
      { id: "account", label: "账号", hint: "", example: "", sensitive: false },
      { id: "token", label: "密钥", hint: "", example: "", sensitive: true },
    ], capabilities: { chatTypes: ["dm"], media: false, edit: false, streaming: false } } });
  const { ExtensionArtifacts } = await import("@zhixing/core/extensions/artifacts");
  const seedDirectory = join(root, "seed");
  const seedEntry = await new ExtensionArtifacts(seedDirectory).import(manifest, bytes);
  catalog.seeds = [{ manifest, directory: join(seedEntry, "..") }];
  const key = randomBytes(32);
  const store = new EncryptedVaultSecretStore({ vaultPath: join(root, "vault.json"), masterKey: {
    state: async () => "unlocked", loadExisting: async () => Buffer.from(key), loadOrCreate: async () => Buffer.from(key),
  } });
  const config = { messaging: Object.fromEntries(ids.map((id) => [id, { type: "fixture", options }])) };
  const credentials = { channels: Object.fromEntries(ids.map((id) => [id, { account: id, token: "fixture-only-secret" }])) };
  await writeConfig(config, { configPath }); await writeCredentials(credentials, { store });
  const configuration = new ChannelConfiguration(configPath, store);
  const artifactDirectory = join(root, "extensions", "artifacts");
  const log = new FileAuthorityCommitLog(join(root, "authority"), new FileArtifactStore(join(root, "authority-artifacts")));
  let owner = true;
  const routes = new Map();
  const make = async () => {
    const system = await setupChannels({ authorityLog: () => log, configuration, artifactDirectory,
      isCurrentOwner: () => owner, httpRoutes: routes, logger });
    systems.push(system);
    return { system, api: new ProductApiDispatcher(EXTENSION_PRODUCT_API_EXACT_SET, [system.productApi]) };
  };
  const made = await make();
  const current = async (id = ids[0]!) => (await made.api.query(extensionList, undefined)).instances.find((instance) => instance.id === id)!;
  return { ...made, root, manifest, store, config, credentials, configPath, configuration, artifactDirectory, log, routes, make, current,
    setOwner: (value: boolean) => { owner = value; } };
}
async function connect(f: Awaited<ReturnType<typeof fixture>>, consumers = outbound) {
  await f.system.connectConfigured(consumers);
  expect(f.system.delivery.status("one")).toBe("disconnected");
  await f.system.activate();
  await expect.poll(() => f.system.delivery.status("one")).toBe("connected");
}

// Execute the actual composition-root callbacks, not a second copy of their order
// or read-back predicates. Unrelated owners are idle; Authority and Channel are real.
async function lifecycleBindings(ports: Record<string, unknown>) {
  const source = ts.createSourceFile("command.ts", await readFile(new URL("../command.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.VariableDeclaration | ts.FunctionDeclaration>();
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const declaration = (name: string) => {
    const node = declarations.get(name)!;
    if (!node) throw new Error(`Missing production declaration: ${name}`);
    return ts.isFunctionDeclaration(node) ? node.getText(source) : `const ${node.getText(source)};`;
  };
  const property = (node: ts.Node, name: string): ts.Expression => {
    if (!ts.isObjectLiteralExpression(node)) throw new Error("Expected production object literal");
    const found = node.properties.find((p) => p.name?.getText(source) === name);
    if (!found || !ts.isPropertyAssignment(found)) throw new Error(`Missing production property: ${name}`);
    return found.initializer;
  };
  const stop = (declarations.get("stopCoordinator") as ts.VariableDeclaration).initializer as ts.NewExpression;
  const close = property(property(stop.arguments![0]!, "runtime"), "closeAdmission").getText(source);
  const removal = (declarations.get("deviceRemovalLifecycle") as ts.VariableDeclaration).initializer as ts.CallExpression;
  const external = ["closeAdmission", "captureAcceptedWork", "settleAcceptedWork", "releaseAdmission"]
    .map((name) => `${name}: ${property(removal.arguments[0]!, name).getText(source)}`).join(",");
  const body = ["let managedHostStopping = false; let removalAdmissionOperationId;",
    ...["assertAcceptedWorkSubset", "deliveryLifecycleSourcesFromOwnerItems", "captureStopAcceptedWork", "assertStopAcceptedWorkSettled", "stopPort", "acceptedWork", "captureExternal"].map(declaration),
    `return { acceptedWork, close: ${close}, removal: {${external}} };`].join("\n");
  const script = compile(`function create(){${body}}`);
  return new Function(...Object.keys(ports), `${script}; return create();`)(...Object.values(ports)) as {
    acceptedWork: HostStopAcceptedWorkPorts; close(id: string): Promise<void>;
    removal: { closeAdmission(id: string): Promise<void>; captureAcceptedWork(id: string): Promise<unknown[]>;
      settleAcceptedWork(input: unknown): Promise<void>; releaseAdmission(id: string): Promise<void> };
  };
}

describe("managed Channel production composition", () => {
  it("keeps management available with zero extensions", async () => {
    const f = await fixture([]);
    await f.system.activate();
    expect(await f.api.query(extensionList, undefined)).toEqual({ instances: [] });
  });

  it("migrates original identities once, passes delivery evidence, and isolates instances", async () => {
    const f = await fixture(["one", "two"]);
    await connect(f);
    await expect.poll(() => f.system.delivery.status("two")).toBe("connected");
    const two = await f.current("two");
    const before = await f.current();
    const result = await f.system.delivery.send({ channelId: "one", to: "user" }, { text: "hello" }, { idempotencyKey: "logical-item", deliveryAttempt: { itemId: "item", attempt: 1 } });
    expect(result).toMatchObject({ success: true, messageId: "logical-item:one" });
    expect(JSON.parse(Buffer.from(result!.receiptBytes!).toString())).toEqual({ itemId: "item", attempt: 1 });
    await expect(f.system.delivery.send({ channelId: "one", to: "user" }, { text: "malformed" })).rejects.toThrow("Invalid Channel delivery evidence");
    expect(f.routes.has("/channels/one/challenge")).toBe(true);
    let httpBody = "";
    const response = { writeHead: vi.fn(), end: (body: Buffer) => { httpBody = body.toString(); } };
    await f.routes.get("/channels/one/challenge")!(Object.assign(Readable.from([Buffer.from("callback")]), { method: "POST", headers: {} }), response);
    expect(response.writeHead).toHaveBeenCalledWith(200, {});
    expect(httpBody).toBe("fixture");
    await f.api.command(extensionSetEnabled, { id: "one", expectedRevision: before.revision, enabled: false });
    expect(f.system.delivery.status("one")).toBe("disconnected");
    expect(f.routes.has("/channels/one/challenge")).toBe(false);
    expect((await f.current("two")).generation).toBe(two.generation);
    expect(f.system.delivery.status("two")).toBe("connected");
    expect(JSON.stringify(await f.api.query(extensionList, undefined))).not.toContain("fixture-only-secret");
    await f.system.dispose();
    const reopened = await f.make();
    await reopened.system.connectConfigured(outbound); await reopened.system.activate();
    expect((await reopened.api.query(extensionList, undefined)).instances.find((i) => i.id === "one")?.enabled).toBe(false);
    expect(reopened.system.delivery.status("one")).toBe("disconnected");
    await expect.poll(() => reopened.system.delivery.status("two")).toBe("connected");
  });

  it("holds startup callbacks for durable admission without blocking other connections or control", async () => {
    const f = await fixture(["one", "two"], { eager: true });
    let admit!: () => void;
    const gate = new Promise<void>((resolve) => { admit = resolve; });
    const messages: string[] = [];
    await f.system.connectConfigured({ inbound: { kind: "router", handleMessage: async (message) => {
      messages.push(message.channelId);
      if (message.channelId === "one") await gate;
    } }, onChallengeAction: async () => {} });
    await f.system.activate();
    await expect.poll(() => messages.sort()).toEqual(["one", "two"]);
    expect(f.system.delivery.status("one")).toBe("disconnected");
    await expect.poll(() => f.system.delivery.status("two")).toBe("connected");
    const pending = await f.current();
    await f.api.command(extensionSetEnabled, { id: "one", expectedRevision: pending.revision, enabled: false });
    admit();
    expect(f.system.delivery.status("one")).toBe("disconnected");
    expect(f.system.delivery.status("two")).toBe("connected");
  });

  it("keeps the previous immutable projection when credentials are incomplete; refreshes only the selected instance", async () => {
    const f = await fixture(["one", "two"]); await connect(f);
    await expect.poll(() => f.system.delivery.status("two")).toBe("connected");
    const before = await f.current();
    const other = await f.current("two");
    await writeCredentials({ channels: { ...f.credentials.channels, one: { account: "one" } } }, { store: f.store });
    await expect(f.api.command(extensionRefresh, { id: "one", expectedRevision: before.revision })).rejects.toThrow("Missing Channel field");
    expect((await f.current()).generation).toBe(before.generation);
    expect(f.system.delivery.status("one")).toBe("connected");
    expect((await f.configuration.read(before)).config.credentials.token).toBe("fixture-only-secret");
    await writeCredentials({ channels: { ...f.credentials.channels, one: { account: "one", token: "replacement-fixture" } } }, { store: f.store });
    await f.api.command(extensionApplyConfiguration, { ids: ["one"] });
    await expect.poll(() => f.system.delivery.status("one")).toBe("connected");
    expect((await f.current()).generation).not.toBe(before.generation);
    expect((await f.current("two")).generation).toBe(other.generation);
    expect((await f.configuration.read(await f.current())).config.credentials.token).toBe("replacement-fixture");
  });

  it("fences owner loss and rejects reopen after close", async () => {
    const f = await fixture(); await connect(f);
    f.setOwner(false);
    await expect(f.system.delivery.send({ channelId: "one", to: "user" }, { text: "no" })).rejects.toThrow();
    await expect(f.api.command(extensionSetEnabled, { id: "one", expectedRevision: (await f.current()).revision, enabled: false })).rejects.toThrow("current owner");
    await f.system.suspendConfigured(); await f.system.dispose();
    await expect(f.system.resumeConfigured(outbound)).rejects.toThrow("closed");
  });

  it("rejects a duplicate account without replacing either running binding", async () => {
    const f = await fixture(["one", "two"]); await connect(f);
    await expect.poll(() => f.system.delivery.status("two")).toBe("connected");
    const before = await f.current("two");
    await writeCredentials({ channels: { ...f.credentials.channels, two: f.credentials.channels.one! } }, { store: f.store });
    await expect(f.api.command(extensionRefresh, { id: "two", expectedRevision: before.revision })).rejects.toThrow("already claimed");
    expect((await f.current("two")).binding).toEqual(before.binding);
    expect(f.system.delivery.status("one")).toBe("connected");
    expect(f.system.delivery.status("two")).toBe("connected");
  });

  it("requires matching local artifacts and account material for duty readiness", async () => {
    const f = await fixture(); await connect(f);
    const readiness = createChannelExtensionReadiness(f.configuration, f.artifactDirectory);
    expect((await readiness(f.log)).channels).toEqual(["one"]);
    const current = await f.current();
    await f.configuration.discard("one", current.binding);
    await writeCredentials({ channels: { one: { account: "different-account", token: "fixture-other-secret" } } }, { store: f.store });
    await expect(readiness(f.log)).rejects.toThrow("does not match");
  });

  it("keeps management disable authoritative through editing and restarts; explicit enable resumes", async () => {
    const f = await fixture(); await connect(f);
    let current = await f.current();
    await f.api.command(extensionSetEnabled, { id: "one", enabled: false, expectedRevision: current.revision });
    current = await f.current();
    const state = { config: f.config, credentials: f.credentials, inputBuffer: "", channelStates: { one: current } };
    expect(messagingSection.entries(state).find((entry) => entry.enterTarget?.kind === "channel-config" && entry.enterTarget.channelId === "one")?.state.statusText).toBe("未启用");
    expect(disableMessaging(state, "one").config.messaging).toEqual(f.config.messaging);
    const nextCredentials = { channels: { one: { account: "one", token: "fixture-v2" } } };
    await f.configuration.stage(["one"], f.config, nextCredentials, { one: current });
    await writeCredentials(nextCredentials, { store: f.store });
    await f.api.command(extensionApplyConfiguration, { ids: ["one"] });
    expect((await f.current()).enabled).toBe(false);
    expect(f.system.delivery.status("one")).toBe("disconnected");
    current = await f.current();
    const edited = enableMessaging({ ...state, channelStates: { one: current } }, "one");
    await f.configuration.stage(["one"], f.config, nextCredentials, { one: current }, edited.channelIntents);
    await f.system.dispose();
    const reopened = await f.make();
    await reopened.system.connectConfigured(outbound); await reopened.system.activate();
    await expect.poll(() => reopened.system.delivery.status("one")).toBe("connected");
    const restored = (await reopened.api.query(extensionList, undefined)).instances[0]!;
    expect((await f.configuration.read(restored)).config.credentials.token).toBe("fixture-v2");
    expect(await f.configuration.publication("one")).toBeUndefined();
  });

  it("the real config command publishes before saving and recovers after its apply RPC is lost", async () => {
    const f = await fixture(); await connect(f);
    const before = await f.current();
    await f.api.command(extensionSetEnabled, { id: "one", enabled: false, expectedRevision: before.revision });
    editor.store = f.store;
    editor.run.mockImplementation(async (context) => {
      expect(context.channelStates.one.enabled).toBe(false);
      const enabled = enableMessaging({ config: context.initialConfig, credentials: context.initialCredentials,
        inputBuffer: "", channelStates: context.channelStates }, "one");
      return { kind: "completed", config: enabled.config, credentials: { channels: { one: { account: "one", token: "fixture-editor-v2" } } },
        channelIntents: enabled.channelIntents };
    });
    const apply = vi.fn(async () => { throw new Error("fixture RPC lost"); });
    const reload = vi.fn();
    await handleConfigCommand({ zhixingHome: f.root, configPath: f.configPath,
      rl: { pause() {}, resume() {} } as never, renderer: { stop() {} }, writer: { line() {} } as never,
      screen: { reassertCursorHidden() {} } as never, state: { activeTurnPromise: null },
      requestHostReload: reload, readExtensions: () => f.api.query(extensionList, undefined), applyExtensionConfiguration: apply });
    expect(apply).toHaveBeenCalledWith(["one"]);
    expect(reload).not.toHaveBeenCalled();
    expect((await f.current()).enabled).toBe(false);
    expect((await f.configuration.publication("one"))?.intent?.enabled).toBe(true);
    await f.system.dispose();
    const reopened = await f.make(); await reopened.system.connectConfigured(outbound); await reopened.system.activate();
    await expect.poll(() => reopened.system.delivery.status("one")).toBe("connected");
    const recovered = (await reopened.api.query(extensionList, undefined)).instances[0]!;
    expect((await f.configuration.read(recovered)).config.credentials.token).toBe("fixture-editor-v2");
    expect(await f.configuration.publication("one")).toBeUndefined();
  });

  it("recovers a complete publication after lost apply; incomplete/unpublished sources retain the previous pair", async () => {
    const f = await fixture(); await connect(f);
    const before = await f.current();
    const config = { messaging: { one: { type: "fixture", options: { changed: true } } } };
    const credentials = { channels: { one: { account: "one", token: "fixture-v2" } } };
    await f.configuration.stage(["one"], config, credentials, { one: before });
    await writeConfig(config, { configPath: f.configPath });
    await f.system.dispose();
    const partial = await f.make(); await partial.system.connectConfigured(outbound); await partial.system.activate();
    await expect.poll(() => partial.system.delivery.status("one")).toBe("connected");
    const unchanged = (await partial.api.query(extensionList, undefined)).instances[0]!;
    expect(unchanged.binding).toEqual(before.binding);
    expect(unchanged.configurationIssue).toContain("配置尚未应用");
    await partial.system.dispose();
    await writeCredentials(credentials, { store: f.store });
    const complete = await f.make(); await complete.system.connectConfigured(outbound); await complete.system.activate();
    await expect.poll(() => complete.system.delivery.status("one")).toBe("connected");
    const committed = (await complete.api.query(extensionList, undefined)).instances[0]!;
    expect((await f.configuration.read(committed)).config.credentials.token).toBe("fixture-v2");
    expect(committed.configurationIssue).toBeUndefined();
    await complete.system.dispose();
    await writeConfig({ messaging: { one: { type: "fixture", options: { unpaired: true } } } }, { configPath: f.configPath });
    const unpaired = await f.make(); await unpaired.system.connectConfigured(outbound); await unpaired.system.activate();
    expect((await unpaired.api.query(extensionList, undefined)).instances[0]!.binding).toEqual(committed.binding);
    expect((await unpaired.api.query(extensionList, undefined)).instances[0]!.configurationIssue).toContain("配置尚未应用");
  });

  it("recovers a published deletion and rejects a delayed enable after a newer stop", async () => {
    const f = await fixture(); await connect(f);
    let current = await f.current();
    await f.configuration.stage(["one"], f.config, f.credentials, { one: current }, { one: true });
    await f.api.command(extensionSetEnabled, { id: "one", enabled: false, expectedRevision: current.revision });
    await expect(f.api.command(extensionApplyConfiguration, { ids: ["one"] })).rejects.toThrow("连接状态在编辑期间已变更");
    expect((await f.current()).enabled).toBe(false);
    expect(await f.configuration.publication("one")).toBeUndefined();
    current = await f.current();
    await f.configuration.stage(["one"], { messaging: {} }, f.credentials, { one: current }, { one: false });
    await writeConfig({ messaging: {} }, { configPath: f.configPath });
    await f.system.dispose();
    const reopened = await f.make(); await reopened.system.connectConfigured(outbound); await reopened.system.activate();
    expect((await reopened.api.query(extensionList, undefined)).instances[0]!.enabled).toBe(false);
    expect(await f.configuration.publication("one")).toBeUndefined();
    expect(reopened.system.delivery.status("one")).toBe("disconnected");
  });

  it.each(["disconnect", "suspend", "dispose"])("a delayed preparation cannot undo %s", async (action) => {
    const f = await fixture();
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void; const entered = new Promise<void>((resolve) => { reached = resolve; });
    const prepare = f.configuration.prepare.bind(f.configuration);
    vi.spyOn(f.configuration, "prepare").mockImplementation(async (...args) => { reached(); await gate; return prepare(...args); });
    await f.system.connectConfigured(outbound);
    const activation = f.system.activate(); await entered;
    if (action === "disconnect") await f.system.disconnectConfigured();
    else if (action === "suspend") await f.system.suspendConfigured();
    else await f.system.dispose();
    release(); await activation;
    expect(f.system.delivery.status("one")).toBe("disconnected");
    expect((await f.current()).generation).toBeNull();
  });

  it("refuses new work but preserves an in-flight receipt during drain; terminal close settles unknown", async () => {
    const f = await fixture();
    let started!: () => void; let gate = new Promise<void>((resolve) => { started = resolve; });
    await connect(f, { inbound: { kind: "router", handleMessage: async () => { started(); } }, onChallengeAction: async () => {} });
    const attempt = { idempotencyKey: "draining-item", deliveryAttempt: { itemId: "draining-item", attempt: 1 } };
    const pending = f.system.delivery.send({ channelId: "one", to: "user" }, { text: "held" }, attempt);
    await gate; await f.system.suspendConfigured();
    await expect(f.system.delivery.send({ channelId: "one", to: "user" }, { text: "new" })).rejects.toThrow("admission is paused");
    const result = await pending;
    expect(result!.messageId).toBe("draining-item:one");
    expect(JSON.parse(Buffer.from(result!.receiptBytes!).toString())).toEqual(attempt.deliveryAttempt);
    gate = new Promise<void>((resolve) => { started = resolve; });
    const stuck = f.system.delivery.send({ channelId: "one", to: "user" }, { text: "never" }, attempt).catch((error: Error) => error);
    await gate; await f.system.disconnectConfigured();
    expect(await stuck).toBeInstanceOf(Error);
    expect((await stuck as Error).message).toContain("outcome may be unknown");
  });

  it.each([false, true])("explicit disable survives invalid credentials (lost apply: %s)", async (lostApply) => {
    const f = await fixture(); await connect(f); editor.store = f.store;
    editor.run.mockImplementation(async (context) => ({ kind: "completed", config: context.initialConfig,
      credentials: { channels: { one: { account: "one", token: "" } } }, channelIntents: { one: false } }));
    const apply = vi.fn(async (ids) => {
      if (lostApply) throw new Error("fixture RPC lost");
      return f.api.command(extensionApplyConfiguration, { ids });
    });
    await handleConfigCommand({ zhixingHome: f.root, configPath: f.configPath,
      rl: { pause() {}, resume() {} } as never, renderer: { stop() {} }, writer: { line() {} } as never,
      screen: { reassertCursorHidden() {} } as never, state: { activeTurnPromise: null },
      requestHostReload: vi.fn(), readExtensions: () => f.api.query(extensionList, undefined), applyExtensionConfiguration: apply });
    expect(apply).toHaveBeenCalledWith(["one"]);
    if (!lostApply) expect((await f.current()).enabled).toBe(false);
    await f.system.dispose();
    const reopened = await f.make(); await reopened.system.connectConfigured(outbound); await reopened.system.activate();
    const current = (await reopened.api.query(extensionList, undefined)).instances[0]!;
    expect(current.enabled).toBe(false);
    expect(current.configurationIssue).toContain("配置尚未应用");
    expect(reopened.system.statusSnapshot()[0]?.state).toBe("disconnected");
    expect(await f.configuration.publication("one")).toBeUndefined();
    await f.configuration.stage(["one"], f.config, f.credentials, { one: current });
    await writeCredentials(f.credentials, { store: f.store });
    await reopened.api.command(extensionApplyConfiguration, { ids: ["one"] });
    expect((await reopened.api.query(extensionList, undefined)).instances[0]!.enabled).toBe(false);
  });

  it.each([false, true])("reopening unchanged pending config retries its original intent (newer stop: %s)", async (newerStop) => {
    const f = await fixture(); await connect(f); editor.store = f.store;
    await f.api.command(extensionSetEnabled, { id: "one", enabled: false, expectedRevision: (await f.current()).revision });
    let first = true;
    editor.run.mockImplementation(async (context) => {
      if (first) return { kind: "completed", config: context.initialConfig, credentials: context.initialCredentials, channelIntents: { one: true } };
      expect(context.channelStates.one.configurationIssue).toContain("待应用");
      return { kind: "completed", config: context.initialConfig, credentials: context.initialCredentials };
    });
    const apply = vi.fn(async (ids) => {
      if (first) throw new Error("fixture RPC lost");
      return f.api.command(extensionApplyConfiguration, { ids });
    });
    const deps = { zhixingHome: f.root, configPath: f.configPath,
      rl: { pause() {}, resume() {} } as never, renderer: { stop() {} }, writer: { line() {} } as never,
      screen: { reassertCursorHidden() {} } as never, state: { activeTurnPromise: null },
      requestHostReload: vi.fn(), readExtensions: () => f.api.query(extensionList, undefined), applyExtensionConfiguration: apply };
    await handleConfigCommand(deps);
    expect(await f.configuration.publication("one")).toBeDefined();
    if (newerStop) await f.api.command(extensionSetEnabled, { id: "one", enabled: false, expectedRevision: (await f.current()).revision });
    first = false; await handleConfigCommand(deps);
    expect(apply).toHaveBeenCalledTimes(2);
    expect((await f.current()).enabled).toBe(!newerStop);
    expect(await f.configuration.publication("one")).toBeUndefined();
    expect(deps.requestHostReload).not.toHaveBeenCalled();
  });

  it.each([false, true])("CAS conflict cleans only a new candidate, never the committed projection (invalid: %s)", async (invalid) => {
    const f = await fixture(); await connect(f);
    const before = await f.current();
    const credentials = { channels: { one: { account: "one", token: invalid ? "" : "fixture-new" } } };
    await f.configuration.stage(["one"], f.config, credentials, { one: before }, { one: false });
    await writeCredentials(credentials, { store: f.store });
    let candidate!: string;
    const refresh = ExtensionApplication.prototype.refresh;
    const intercept = vi.spyOn(ExtensionApplication.prototype, "refresh").mockImplementationOnce(async function (this: ExtensionApplication, ...args) {
      candidate = args[1].projectionRevision;
      await f.api.command(extensionSetEnabled, { id: "one", enabled: false, expectedRevision: (await f.current()).revision });
      return refresh.apply(this, args);
    });
    try {
      await expect(f.api.command(extensionApplyConfiguration, { ids: ["one"] })).rejects.toThrow("revision conflict");
    } finally { intercept.mockRestore(); }
    const current = await f.current();
    expect(current.enabled).toBe(false);
    expect(current.binding.projectionRevision).toBe(before.binding.projectionRevision);
    expect((await f.configuration.read(current)).config.credentials.token).toBe("fixture-only-secret");
    const encoded = await f.store.get({ kind: "channel", bindingId: `extension-projections/one/${candidate}` });
    expect(Boolean(encoded)).toBe(invalid);
  });

  it("projects physical connection independently from enabled intent and configuration issues", async () => {
    const f = await fixture(); await connect(f);
    await writeCredentials({ channels: { one: { account: "one" } } }, { store: f.store });
    await expect(f.api.command(extensionApplyConfiguration, { ids: ["one"] })).rejects.toThrow();
    await expect.poll(() => f.system.statusSnapshot()[0]).toMatchObject({ state: "connected", configurationIssue: expect.any(String) });
    await f.system.disconnectConfigured();
    expect((await f.current()).enabled).toBe(true);
    expect(f.system.statusSnapshot()[0]).toMatchObject({ state: "disconnected", configurationIssue: expect.any(String) });
    await f.api.command(extensionSetEnabled, { id: "one", enabled: false, expectedRevision: (await f.current()).revision });
    expect(f.system.statusSnapshot()[0]?.state).toBe("disconnected");
  });

  it.each(["host-stop", "current-removal", "paired-removal"])("production %s settles the accepted receipt before physical close and read-back", async (kind) => {
    const f = await fixture();
    let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; });
    await connect(f, { inbound: { kind: "router", handleMessage: async () => { started(); } }, onChallengeAction: async () => {} });
    const pending = f.system.delivery.send({ channelId: "one", to: "user" }, { text: "held" },
      { idempotencyKey: "held", deliveryAttempt: { itemId: "held", attempt: 1 } });
    void pending.catch(() => {});
    await entered;
    const order: string[] = []; let settled = false;
    const capture = async () => settled ? [] : [{ id: "held", revision: "1" }];
    const delivery = { capture, read: capture, install: async () => {}, close() {}, seal: async () => {},
      settle: async () => { const result = await pending; expect(result?.messageId).toBe("held:one");
        expect(f.system.delivery.status("one")).toBe("connected"); settled = true; order.push("receipt"); },
      release: async () => {}, resume: async () => {} };
    const channel = { statuses: f.system.statusSnapshot, suspendConfigured: () => f.system.suspendConfigured(),
      disconnectConfigured: async () => { order.push("disconnect"); await f.system.disconnectConfigured(); },
      resumeConfigured: () => f.system.resumeConfigured(outbound) };
    const schedulerApplication = { captureAcceptedWork: async () => [], assertAcceptedWorkSettled: async () => {}, closeAdmission() {}, resumeAdmission() {} };
    const jobOwner = { acceptedWorkItems: async () => [], pauseAccepting() {}, drain: async () => {}, resumeAccepting() {} };
    const inbound = { refuseNewMessages() {}, drainAcceptedMessages: async () => {}, resumeNewMessages() {} };
    const authority = { resourceGovernor: { coordinate: async (fn: () => Promise<void>) => fn() } };
    const binding = await lifecycleBindings({ protocolDigest, boundLocalConversationOwner: undefined, boundConversations: undefined,
      boundJobRelayObligations: undefined, boundExecutorJobOwner: undefined, boundConversationProtocol: undefined,
      boundInboundRouter: inbound, boundAuthorityRuntime: authority, boundDeliveryStack: { lifecycle: delivery },
      boundChannelStatuses: channel.statuses, boundChannelConnections: channel,
      schedulerApplication, settleScheduleForTransfer: async () => {}, channel, delivery, inbound, jobOwner,
      jobRelays: { listOpen: async () => [] }, recoverFrozenOwners: async () => {}, authority, removalBootstrapAdmissionClosed: false });
    if (kind === "paired-removal") {
      await binding.removal.closeAdmission("removal");
      const ownerItems = await binding.removal.captureAcceptedWork("removal");
      await binding.removal.settleAcceptedWork({ operationId: "removal", ownerItems });
    } else if (kind === "current-removal") {
      await binding.close("removal");
      const { snapshot } = await freezeHostStopAcceptedWork("removal", binding.acceptedWork, new FileArtifactStore(join(f.root, "authority-artifacts")));
      await settleHostStopAcceptedWork({ operationId: "removal", strategy: "drain", timeoutMs: 3_000, snapshot, ports: binding.acceptedWork });
    } else {
      const coordinator = new HostStopCoordinator({ journal: new DeviceLifecycleJournal(f.log),
        homeId: (await f.log.originCheckpoint()).logId, localDeviceId: "fixture", host: { kind: "foreground", processId: process.pid, startedAt: new Date().toISOString() },
        acceptedWork: binding.acceptedWork, artifactStore: new FileArtifactStore(join(f.root, "authority-artifacts")),
        runtime: { closeAdmission: binding.close, settleImmediate: async () => {}, drainAcceptedWork: async () => {}, cancelAcceptedWork: async () => {},
          flushDurableState: async () => [], settlePhysicalSteps: async () => {} } });
      expect((await coordinator.prepare({ requestId: "stop", reason: "fixture", strategy: "drain", timeoutMs: 3_000 })).phase).toBe("ready-to-stop");
    }
    expect(order).toEqual(["receipt", "disconnect"]);
    expect(f.system.statusSnapshot()[0]?.state).toBe("disconnected");
    expect(f.routes.size).toBe(0);
    expect((await f.current()).enabled).toBe(true);
  });
});
