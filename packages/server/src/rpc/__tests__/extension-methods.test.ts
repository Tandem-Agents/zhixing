import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { ExtensionApplication, EXTENSION_PRODUCT_API_EXACT_SET } from "@zhixing/core/extensions/application";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
import { buildExtensionMethods } from "../methods/extensions.js";

vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(loopback = true) {
  const root = await mkdtemp(join(tmpdir(), "zhixing-extension-rpc-")); roots.push(root);
  const log = new FileAuthorityCommitLog(root, new FileArtifactStore(join(root, "artifacts")));
  const application = new ExtensionApplication({ log: () => log, assertOwner() {} });
  const effects = {
    changed: vi.fn(async () => {}),
    refresh: vi.fn(async (id: string) => (await application.get(id))!),
    applyConfiguration: vi.fn(async () => application.list()),
  };
  const productApi = new ProductApiDispatcher(EXTENSION_PRODUCT_API_EXACT_SET, [application.contribution(effects)]);
  const context = { server: { productApi }, connection: { loopback } } as never;
  const methods = buildExtensionMethods();
  const call = (name: string, input: unknown) => methods.find((method) => method.name === name)!.handler(input, context);
  return { application, effects, methods, call };
}

describe("extension management RPC binding", () => {
  it("publishes only authenticated fixed operations and remains available without instances", async () => {
    const f = await fixture();
    expect(f.methods.map((method) => method.name).sort()).toEqual([
      "extensions.apply-configuration", "extensions.list", "extensions.refresh", "extensions.set-enabled",
    ]);
    expect(f.methods.every((method) => method.requiresAuth)).toBe(true);
    expect(await f.call("extensions.list", {})).toEqual({ instances: [] });
  });

  it("commits disable through the same application and rejects a stale revision", async () => {
    const f = await fixture();
    await f.application.adopt("one", {
      manifest: { id: "fixture", version: "1.0.0", digest: "a".repeat(64), runtime: "node24", entry: "extension.mjs", protocol: 1, type: "fixture", contract: 1, declaration: {} },
      configurationRevision: "config", secretRevision: "secret-ref", projectionRevision: "projection",
    });
    expect(await f.call("extensions.set-enabled", { id: "one", enabled: false, expectedRevision: 1 })).toMatchObject({ enabled: false, revision: 2 });
    expect(f.effects.changed).toHaveBeenCalledOnce();
    await expect(f.call("extensions.set-enabled", { id: "one", enabled: true, expectedRevision: 1 })).rejects.toThrow("revision conflict");
    expect((await f.application.get("one"))!.enabled).toBe(false);
  });

  it("keeps credential projection changes at the target-device configuration entrance", async () => {
    const f = await fixture(false);
    await expect(f.call("extensions.refresh", { id: "one", expectedRevision: 1 })).rejects.toBeDefined();
    await expect(f.call("extensions.apply-configuration", { ids: ["one"] })).rejects.toBeDefined();
    expect(f.effects.refresh).not.toHaveBeenCalled();
    expect(f.effects.applyConfiguration).not.toHaveBeenCalled();
    const local = await fixture();
    await expect(local.call("extensions.apply-configuration", { ids: ["../escape"] })).rejects.toBeDefined();
    expect(local.effects.applyConfiguration).not.toHaveBeenCalled();
  });
});
