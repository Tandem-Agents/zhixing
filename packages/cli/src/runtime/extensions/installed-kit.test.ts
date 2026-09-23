import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { ExtensionApplication } from "@zhixing/core/extensions/application";
import { ExtensionArtifacts } from "@zhixing/core/extensions/artifacts";
import { ExtensionCandidates } from "@zhixing/core/extensions/candidate";
import { ManagedExtensions } from "@zhixing/core/extensions/runtime";
import { FileAuthorityCommitLog, FileArtifactStore } from "@zhixing/core/authority";
import { extensionKitDirectory } from "./catalog.js";
import type { ExtensionCandidate } from "@zhixing/core/extensions/contracts";

const roots: string[] = [];
const runtimes: ManagedExtensions[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("official installed extension authoring kit", { timeout: 20_000 }, () => {
  it("can author, validate, archive and run an adapter outside the repository without importing product source", async () => {
    const root = await mkdtemp(join(tmpdir(), "zhixing-installed-kit-")); roots.push(root);
    const kit = join(root, "kit"); await cp(extensionKitDirectory(), kit, { recursive: true });
    expect(await readFile(join(kit, "authoring.md"), "utf8")).toContain("管理协议 1");
    expect(JSON.parse(await readFile(join(kit, "manifest.schema.json"), "utf8")).properties.protocol.const).toBe(1);
    const require = createRequire(import.meta.url);
    const { build, version } = createRequire(require.resolve("tsup"))("esbuild");
    const source = `import { serveChannelExtension } from "./kit/channel-sdk.mjs";
serveChannelExtension(id => ({ id, capabilities: { chatTypes: ["dm"], media: false, edit: false, streaming: false },
  async connect() {}, async disconnect() {}, health: () => "ready", async send() { return { success: true, retryable: false, messageId: "fixture" }; } }));`;
    await writeFile(join(root, "adapter.mjs"), source);
    const compiled = await build({ entryPoints: [join(root, "adapter.mjs")], write: false, bundle: true, format: "esm", platform: "node", target: "node24", logLevel: "silent" });
    const code = compiled.outputFiles[0].text as string;
    const candidate: ExtensionCandidate = { code, manifest: { id: "installed-kit", version: "1.0.0", digest: createHash("sha256").update(code).digest("hex"),
      runtime: "node24", entry: "adapter.mjs", protocol: 1, type: "channel", contract: 1,
      declaration: { label: "Installed fixture", identityFields: ["account"], requiredFields: [{ id: "account", label: "Account", hint: "", example: "", sensitive: false }],
        capabilities: { chatTypes: ["dm"], media: false, edit: false, streaming: false } } },
      provenance: { kind: "authored", url: "https://example.com/official-api", revision: "fixture-v1" },
      sources: { "adapter.mjs": source, "kit/channel-sdk.mjs": await readFile(join(kit, "channel-sdk.mjs"), "utf8") },
      build: `Node 24; esbuild ${version}, platform=node target=node24 format=esm bundle=true` };
    const path = join(root, "candidate.json"); await writeFile(path, JSON.stringify(candidate));
    const validation = spawnSync(process.execPath, [join(kit, "validate.mjs"), path], { encoding: "utf8", windowsHide: true, timeout: 15000, cwd: root, env: { ...process.env, NODE_PATH: "" } });
    expect(validation.stderr).toBe(""); expect(validation.status).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true, executed: false, digest: candidate.manifest.digest });
    const application = new ExtensionApplication({ log: () => new FileAuthorityCommitLog(join(root, "authority"), new FileArtifactStore(join(root, "facts"))), assertOwner() {} });
    const artifacts = new ExtensionArtifacts(join(root, "artifacts"));
    const archive = new ExtensionCandidates(join(root, "archive"));
    await application.prepare("install", "instance", { conversationId: "fixture", request: "接入" });
    await archive.save(candidate); await artifacts.import(candidate.manifest, Buffer.from(code));
    await application.candidate("install", 1, candidate.manifest);
    await application.trial("install", 2, { manifest: candidate.manifest, configurationRevision: "one", projectionRevision: "fixture" });
    const runtime = new ManagedExtensions({ application, artifacts, isOwner: () => true,
      projection: async () => ({ id: "instance", config: { type: "installed-kit", enabled: true, credentials: { account: "fixture" } } }),
      binding: () => ({ type: "channel", contract: 1, validate() {}, receive: async () => null, close() {} }) });
    runtimes.push(runtime); await runtime.resume();
    await expect.poll(() => Boolean(runtime.current("instance"))).toBe(true);
    expect(await runtime.current("instance")!.call("control.health", null)).toBe("ready");
    expect((await application.get("instance"))?.admission?.ready).toBe(false);
    expect((await archive.read(candidate.manifest.digest)).sources["kit/channel-sdk.mjs"]).toBeTruthy();
    // The SDK module itself has no package-resolution dependency after copying.
    const load = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(kit, "channel-sdk.mjs")).href)})`], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 });
    expect(load.status).toBe(0);
  });
});
