import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretRef } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { editConfiguration, loadConfigurationSnapshot } from "../configuration-edit.js";
import { addMcpServerConfiguration, loadConfig, writeConfig } from "../config-loader.js";
import { CONFIGURATION_EDIT_REF, inspectMcpCredentialBinding, loadCredentialSnapshot, writeCredentials } from "../credentials-loader.js";

const durability = vi.hoisted(() => ({ afterDirectorySync: undefined as undefined | ((directory: string) => Promise<void>) }));
vi.mock("@zhixing/core/persistence", async original => {
  const actual = await original<typeof import("@zhixing/core/persistence")>();
  return { ...actual, syncDirectory: async (directory: string) => {
    await actual.syncDirectory(directory);
    await durability.afterDirectorySync?.(directory);
  } };
});

class Store {
  values = new Map<string, string>();
  queue = Promise.resolve();
  fail: ((action: string, ref: SecretRef, value?: string) => void) | undefined;
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  async get(ref: SecretRef) { return this.values.get(`${ref.kind}/${ref.bindingId}`) ?? null; }
  async put(ref: SecretRef, value: string) { this.values.set(`${ref.kind}/${ref.bindingId}`, value); this.fail?.("put", ref, value); }
  async delete(ref: SecretRef) { this.fail?.("delete", ref); this.values.delete(`${ref.kind}/${ref.bindingId}`); }
  async list(prefix: string) { return [...this.values.keys()].filter(key => key.startsWith(prefix)).map(key => {
    const at = key.indexOf("/"); return { kind: key.slice(0, at) as SecretRef["kind"], bindingId: key.slice(at + 1) };
  }); }
  async unlockState() { return "unlocked" as const; }
}

async function fixture() {
  const configPath = path.join(await createTempDir("configuration-edit"), "config.jsonc");
  const store = new Store();
  await writeConfig({ mcp: { servers: { demo: { type: "http", url: "https://old.invalid/mcp" } } } }, { configPath });
  await writeCredentials({ providers: { main: { apiKey: "model-original" } },
    channels: { one: { token: "one-original" }, two: { token: "two-original" } }, mcp: { demo: { TOKEN: "old-token" } } }, { store });
  const options = { configPath, store };
  const baseline = await loadConfigurationSnapshot(options);
  const next = structuredClone(baseline);
  next.config.mcp!.servers!.demo!.url = "https://new.invalid/mcp";
  next.credentials.mcp!.demo!.TOKEN = "new-token";
  return { options, baseline, next };
}

afterEach(() => { vi.restoreAllMocks(); durability.afterDirectorySync = undefined; });
describe("configuration and credential save", () => {
  it("preserves independent rotations from concurrent editors across all credential families", async () => {
    const { options, baseline } = await fixture();
    const a = structuredClone(baseline), b = structuredClone(baseline), c = structuredClone(baseline);
    a.credentials.channels!.one!.token = "one-renewed";
    b.credentials.channels!.two!.token = "two-renewed";
    c.credentials.providers!.main!.apiKey = "model-renewed";
    await Promise.all([editConfiguration(baseline, a, options), editConfiguration(baseline, b, options), editConfiguration(baseline, c, options)]);
    expect((await loadConfigurationSnapshot(options)).credentials).toEqual({
      providers: { main: { apiKey: "model-renewed" } }, channels: { one: { token: "one-renewed" }, two: { token: "two-renewed" } }, mcp: baseline.credentials.mcp,
    });
  });
  it("rejects same-binding conflicts before changing public config or publication", async () => {
    const { options, baseline, next } = await fixture();
    const newer = structuredClone(baseline); newer.credentials.mcp!.demo!.TOKEN = "concurrent-token";
    await editConfiguration(baseline, newer, options);
    const prepare = vi.fn(async () => []);
    await expect(editConfiguration(baseline, next, { ...options, prepare })).rejects.toThrow("凭据在编辑期间");
    expect(prepare).not.toHaveBeenCalled();
    expect(loadConfig(options)).toEqual(baseline.config);
    expect(await options.store.get(CONFIGURATION_EDIT_REF)).toBeNull();
  });
  it("rejects old public edits without replacing a successfully saved pending stop", async () => {
    const { options, baseline } = await fixture();
    const ref: SecretRef = { kind: "channel", bindingId: "extension-edits/one" };
    const newer = structuredClone(baseline); newer.config.messaging = { one: { type: "fixture" } };
    await editConfiguration(baseline, newer, { ...options, prepare: async () => [{ ref, value: "stop" }] });
    await expect(editConfiguration(baseline, baseline, { ...options, prepare: async () => [{ ref, value: "enable" }] })).rejects.toThrow("配置在编辑期间");
    expect(await options.store.get(ref)).toBe("stop");
  });
  it("does not delete unread secrets, resurrect deleted bindings, or rotate a no-op generation", async () => {
    const { options, baseline } = await fixture();
    const limited = { config: baseline.config, credentials: { providers: baseline.credentials.providers } };
    const updated = structuredClone(limited); updated.credentials.providers!.main!.apiKey = "new-model";
    await editConfiguration(limited, updated, options);
    expect((await loadConfigurationSnapshot(options)).credentials.channels).toEqual(baseline.credentials.channels);
    const current = await loadConfigurationSnapshot(options), deleted = structuredClone(current);
    delete deleted.credentials.channels!.one;
    await editConfiguration(current, deleted, options);
    const generation = (await loadConfigurationSnapshot(options)).generation;
    await editConfiguration(current, current, options);
    const final = await loadConfigurationSnapshot(options);
    expect(final.credentials.channels!.one).toBeUndefined();
    expect(final.generation).toBe(generation);
  });
  it("MCP-scoped editing preserves concurrent unrelated configuration and credentials", async () => {
    const { options, baseline, next } = await fixture();
    const channel = structuredClone(baseline); channel.config.messaging = { one: { type: "fixture" } }; channel.credentials.channels!.one!.token = "renewed";
    await editConfiguration(baseline, channel, options);
    await editConfiguration(baseline, next, { ...options, scope: "mcp" });
    const final = await loadConfigurationSnapshot(options);
    expect(final.config.messaging).toEqual(channel.config.messaging);
    expect(final.credentials.channels).toEqual(channel.credentials.channels);
    expect(final.config.mcp).toEqual(next.config.mcp);
    expect(final.credentials.mcp).toEqual(next.credentials.mcp);
  });
  it("fences target MCP changes while allowing unrelated Channel and MCP rotations", async () => {
    const { options, baseline } = await fixture();
    const rotated = structuredClone(baseline); rotated.credentials.channels!.one!.token = "renewed"; rotated.credentials.mcp!.other = { TOKEN: "other" };
    await editConfiguration(baseline, rotated, options);
    expect(await inspectMcpCredentialBinding("demo", baseline.credentials.mcp!.demo, options)).toEqual({ exists: true, matches: true });
    const updated = structuredClone(rotated); updated.credentials.mcp!.demo!.TOKEN = "changed";
    await editConfiguration(rotated, updated, options);
    expect(await inspectMcpCredentialBinding("demo", baseline.credentials.mcp!.demo, options)).toEqual({ exists: true, matches: false });
  });

  it.each(["marker-before", "marker-after", "secret-committed", "public-before", "public-after", "marker-delete-before", "marker-delete-after", "plan-delete"])(
    "recovers paired sources after %s without exposing an intermediate source pair", async point => {
      const { options, baseline, next } = await fixture();
      const marker = `${options.configPath}.edit.pending`;
      const rename = fs.promises.rename.bind(fs.promises), unlink = fs.promises.unlink.bind(fs.promises);
      let failed = false;
      const fail = () => { failed = true; throw new Error("injected interruption"); };
      vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (!failed && ((point === "marker-before" && to === marker) || (point === "public-before" && to === options.configPath))) fail();
        await rename(from, to);
        if (!failed && ((point === "marker-after" && to === marker) || (point === "public-after" && to === options.configPath))) fail();
      });
      vi.spyOn(fs.promises, "unlink").mockImplementation(async file => {
        if (!failed && point === "marker-delete-before" && file === marker) fail();
        await unlink(file);
        if (!failed && point === "marker-delete-after" && file === marker) fail();
      });
      options.store.fail = (action, ref, value) => {
        if (failed) return;
        if (point === "secret-committed" && action === "put" && ref.bindingId.includes("generation-markers/") && JSON.parse(value!).state === "committed") fail();
        if (point === "plan-delete" && action === "delete" && ref.bindingId === CONFIGURATION_EDIT_REF.bindingId) fail();
      };
      await expect(editConfiguration(baseline, next, options)).rejects.toThrow();
      expect(failed).toBe(true);
      await expect(loadCredentialSnapshot(options)).rejects.toThrow("尚未收束");
      await expect(writeCredentials(baseline.credentials, options)).rejects.toThrow("尚未收束");
      if (fs.existsSync(marker)) {
        expect(Object.keys(JSON.parse(await fs.promises.readFile(marker, "utf8")))).toEqual(["id"]);
        await expect(writeConfig(baseline.config, options)).rejects.toThrow("尚未收束");
        await expect(addMcpServerConfiguration("other", { command: "node" }, options)).rejects.toThrow("尚未收束");
      }
      const recovered = await loadConfigurationSnapshot(options);
      expect(recovered.config).toEqual(point === "marker-before" ? baseline.config : next.config);
      expect(recovered.credentials).toEqual(point === "marker-before" ? baseline.credentials : next.credentials);
      expect(await options.store.get(CONFIGURATION_EDIT_REF)).toBeNull();
      expect(fs.existsSync(marker)).toBe(false);
    });

  it("recovers public-only intent and another config file sharing the same SecretStore", async () => {
    const { options, baseline } = await fixture();
    const ref: SecretRef = { kind: "channel", bindingId: "extension-edits/one" };
    let first = true;
    options.store.fail = (action, target) => { if (first && action === "put" && target.bindingId === ref.bindingId) { first = false; throw new Error("publication write lost"); } };
    await expect(editConfiguration(baseline, baseline, { ...options, prepare: async () => [{ ref, value: "stop" }] })).rejects.toThrow("已接纳");
    const otherPath = path.join(path.dirname(options.configPath), "other.jsonc");
    await writeConfig({ messaging: {} }, { configPath: otherPath });
    const other = await loadConfigurationSnapshot({ ...options, configPath: otherPath });
    expect(other.config).toEqual({ messaging: {} });
    expect(await options.store.get(ref)).toBe("stop");
    expect(other.generation).toBe(baseline.generation);
  });

  it.each(["marker-rename", "marker-synced", "credentials-committed", "config-rename", "config-synced",
    "marker-removed", "marker-removal-synced", "plan-deleted"])("recovers the last durable file state after %s", async point => {
    const { options, baseline, next } = await fixture();
    const marker = `${options.configPath}.edit.pending`, directory = path.dirname(marker);
    const persisted = new Map<string, string>([[options.configPath, await fs.promises.readFile(options.configPath, "utf8")]]);
    const syncedFiles = new Set<string>();
    const open = fs.promises.open.bind(fs.promises), rename = fs.promises.rename.bind(fs.promises), unlink = fs.promises.unlink.bind(fs.promises);
    let interrupted = false, removed = false;
    const interrupt = (boundary: string) => { if (point === boundary && !interrupted) { interrupted = true; throw new Error("simulated power interruption"); } };
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args), sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); syncedFiles.add(String(args[0])); });
      return handle;
    });
    vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === marker || to === options.configPath) {
        expect(syncedFiles.has(String(from))).toBe(true);
        interrupt(to === marker ? "marker-rename" : "config-rename");
      }
    });
    vi.spyOn(fs.promises, "unlink").mockImplementation(async file => {
      await unlink(file);
      if (file === marker) { removed = true; interrupt("marker-removed"); }
    });
    durability.afterDirectorySync = async dir => {
      if (dir !== directory) return;
      for (const file of [marker, options.configPath]) {
        if (fs.existsSync(file)) persisted.set(file, await fs.promises.readFile(file, "utf8"));
        else persisted.delete(file);
      }
      interrupt(removed ? "marker-removal-synced" : persisted.get(options.configPath) === JSON.stringify(next.config, null, 2) + "\n" ? "config-synced" : "marker-synced");
    };
    options.store.fail = (action, ref, value) => {
      if (action === "put" && ref.bindingId.includes("generation-markers/") && JSON.parse(value!).state === "committed") interrupt("credentials-committed");
    };
    const deleteSecret = options.store.delete.bind(options.store);
    vi.spyOn(options.store, "delete").mockImplementation(async ref => {
      await deleteSecret(ref);
      if (ref.bindingId === CONFIGURATION_EDIT_REF.bindingId) interrupt("plan-deleted");
    });
    await expect(editConfiguration(baseline, next, options)).rejects.toThrow();
    expect(interrupted).toBe(true);
    vi.restoreAllMocks(); durability.afterDirectorySync = undefined; options.store.fail = undefined;
    // A restart loses unsynced file contents and directory entries. Vault mutations
    // are already durable; restore only the separate public-config filesystem.
    for (const file of [marker, options.configPath]) {
      const value = persisted.get(file);
      if (value === undefined) await fs.promises.rm(file, { force: true });
      else await fs.promises.writeFile(file, value);
    }
    const recovered = await loadConfigurationSnapshot(options), expected = point === "marker-rename" ? baseline : next;
    expect(recovered.config).toEqual(expected.config);
    expect(recovered.credentials).toEqual(expected.credentials);
    expect(await options.store.get(CONFIGURATION_EDIT_REF)).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });
});
