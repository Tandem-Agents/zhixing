import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FileAuthorityCommitLog } from "../authority/commit-log.js";
import { FileArtifactStore } from "../authority/artifact-store.js";
import { ExtensionApplication } from "./application.js";
import { ExtensionArtifacts } from "./artifacts.js";
import { ManagedExtensions } from "./runtime.js";
import { validateExtensionManifest, type ExtensionBinding } from "./contracts.js";
import { ExtensionPeer } from "./protocol.js";

const roots: string[] = [];
const runtimes: ManagedExtensions[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(mode = "normal", projection = async () => ({ mode })) {
  const root = await mkdtemp(join(tmpdir(), "zhixing-extensions-")); roots.push(root);
  const log = new FileAuthorityCommitLog(root, new FileArtifactStore(join(root, "authority-artifacts")));
  const application = new ExtensionApplication({ log: () => log, assertOwner() {} });
  const bytes = await readFile(new URL("./__fixtures__/worker.mjs", import.meta.url));
  const manifest = validateExtensionManifest({ id: "fixture", version: "1.0.0", digest: createHash("sha256").update(bytes).digest("hex"),
    runtime: "node24", entry: "worker.mjs", protocol: 1, type: "fixture", contract: 1, declaration: {} });
  const binding: ExtensionBinding = { manifest, configurationRevision: "configuration-1", secretRevision: "secrets-1", projectionRevision: "projection-1" };
  const artifacts = new ExtensionArtifacts(join(root, "extensions"));
  await artifacts.import(manifest, bytes);
  const runtime = new ManagedExtensions({ application, artifacts, isOwner: () => true,
    projection,
    binding: () => ({ type: "fixture", contract: 1, validate(m) { if (m.type !== "fixture") throw new Error("wrong type"); }, receive: async () => null, close() {} }),
  });
  runtimes.push(runtime);
  return { root, log, application, runtime, artifacts, binding, bytes };
}

describe("managed extensions", () => {
  it("persists identity, disabled intent and generation fences in the real Authority log", async () => {
    const f = await fixture();
    const adopted = await f.application.adopt("primary", f.binding);
    const started = await f.application.begin("primary", adopted.revision);
    const disabled = await f.application.setEnabled("primary", false, started.revision);
    expect(await f.application.observe("primary", started.generation!, "running")).toBe(false);
    const restarted = new ExtensionApplication({ log: () => new FileAuthorityCommitLog(f.root, new FileArtifactStore(join(f.root, "authority-artifacts"))), assertOwner() {} });
    expect(await restarted.adopt("primary", f.binding)).toEqual(disabled);
    await expect(restarted.setEnabled("primary", true, 1)).rejects.toThrow("revision conflict");
  });

  it("runs a real immutable process and stops only the selected instance", async () => {
    const f = await fixture();
    await f.application.adopt("one", f.binding);
    await f.application.adopt("two", f.binding);
    await f.runtime.resume();
    await expect.poll(() => Boolean(f.runtime.current("one") && f.runtime.current("two"))).toBe(true);
    expect(await f.runtime.current("one")!.call("fixture.echo", { result: 42 })).toEqual({ result: 42 });
    const one = (await f.application.get("one"))!;
    await f.runtime.reconcile(await f.application.setEnabled("one", false, one.revision));
    expect(f.runtime.current("one")).toBeUndefined();
    expect(await f.runtime.current("two")!.call("fixture.echo", "still running")).toBe("still running");
  });

  it("disable interrupts a stalled startup without waiting for its timeout", async () => {
    const f = await fixture("hang");
    await f.application.adopt("one", f.binding);
    await f.runtime.resume();
    const current = (await f.application.get("one"))!;
    const start = Date.now();
    await f.runtime.reconcile(await f.application.setEnabled("one", false, current.revision));
    expect(Date.now() - start).toBeLessThan(4_000);
    expect(f.runtime.current("one")).toBeUndefined();
    expect((await f.application.get("one"))!.enabled).toBe(false);
  });

  it.each(["enable", "resume", "refresh"])("waits for the old process close before concurrent %s", async (mode) => {
    const f = await fixture("slow-stop");
    await f.application.adopt("one", f.binding);
    await f.runtime.resume();
    await expect.poll(() => Boolean(f.runtime.current("one"))).toBe(true);
    const pid = await f.runtime.current("one")!.call("fixture.pid", null) as number;
    let pending: Promise<void>;
    if (mode === "resume") pending = f.runtime.suspend();
    else {
      const current = (await f.application.get("one"))!;
      const next = mode === "enable" ? await f.application.setEnabled("one", false, current.revision)
        : await f.application.refresh("one", { ...f.binding, projectionRevision: "2" }, current.revision);
      pending = f.runtime.reconcile(next);
    }
    await expect.poll(() => Boolean(f.runtime.current("one"))).toBe(false);
    if (mode === "resume") await f.runtime.resume();
    else {
      const current = (await f.application.get("one"))!;
      const next = mode === "enable" ? await f.application.setEnabled("one", true, current.revision)
        : await f.application.refresh("one", { ...f.binding, projectionRevision: "3" }, current.revision);
      await f.runtime.reconcile(next);
    }
    await expect.poll(() => Boolean(f.runtime.current("one"))).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    await pending;
  });

  it("rejects mutated artifacts and incompatible protocols before execution", async () => {
    const f = await fixture();
    await expect(f.artifacts.import(f.binding.manifest, Buffer.from("changed"))).rejects.toThrow("digest mismatch");
    expect(() => validateExtensionManifest({ ...f.binding.manifest, protocol: 2 })).toThrow();
    expect(() => validateExtensionManifest({ ...f.binding.manifest, entry: "../escape.mjs" })).toThrow();
  });

  it("converges after an obsolete begin wins the CAS without acquiring a process", async () => {
    const f = await fixture(); await f.application.adopt("one", f.binding);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let committed!: () => void; const complete = new Promise<void>((resolve) => { committed = resolve; });
    const begin = f.application.begin.bind(f.application);
    let calls = 0;
    vi.spyOn(f.application, "begin").mockImplementation(async (...args) => {
      const call = ++calls;
      if (call === 1) { await gate; const result = await begin(...args); committed(); return result; }
      if (call === 2) { release(); await complete; }
      return begin(...args);
    });
    const first = f.runtime.resume();
    await expect.poll(() => calls).toBe(1);
    await Promise.all([first, f.runtime.resume()]);
    await expect.poll(() => Boolean(f.runtime.current("one"))).toBe(true);
    expect(calls).toBe(3);
    expect((await f.application.get("one"))?.phase).toBe("running");
  });

  it.each(["projection", "running-commit"])("pause fences pending %s but resume can start again", async (stage) => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void; const entered = new Promise<void>((resolve) => { reached = resolve; });
    const f = await fixture("normal", async () => {
      if (stage === "projection") { reached(); await gate; }
      return { mode: "normal" };
    });
    if (stage === "running-commit") {
      const observe = f.application.observe.bind(f.application);
      vi.spyOn(f.application, "observe").mockImplementation(async (...args) => {
        if (args[2] === "running") { reached(); await gate; }
        return observe(...args);
      });
    }
    await f.application.adopt("one", f.binding); await f.runtime.resume(); await entered;
    f.runtime.pause(); release();
    await expect.poll(() => f.runtime.state("one")).toBe("stopped");
    expect(f.runtime.current("one")).toBeUndefined();
    await f.runtime.resume();
    await expect.poll(() => Boolean(f.runtime.current("one"))).toBe(true);
  });

  it("a late startup decision cannot resurrect an instance disabled during its commit", async () => {
    const f = await fixture();
    await f.application.adopt("one", f.binding);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const begin = f.application.begin.bind(f.application);
    const held = vi.spyOn(f.application, "begin").mockImplementation(async (...args) => {
      const result = await begin(...args);
      await gate;
      return result;
    });
    const start = f.runtime.resume();
    await expect.poll(async () => (await f.application.get("one"))?.phase).toBe("starting");
    const current = (await f.application.get("one"))!;
    await f.runtime.reconcile(await f.application.setEnabled("one", false, current.revision));
    release(); await start;
    expect(f.runtime.current("one")).toBeUndefined();
    expect((await f.application.get("one"))?.enabled).toBe(false);
    held.mockRestore();
  });

  it("a crashing process is retried finitely and stays stopped after recovery of disabled intent", async () => {
    const f = await fixture("crash");
    await f.application.adopt("one", f.binding);
    await f.runtime.resume();
    await expect.poll(async () => (await f.application.get("one"))?.revision, { timeout: 12_000 }).toBe(5);
    await expect.poll(async () => (await f.application.get("one"))?.phase).toBe("blocked");
    const current = (await f.application.get("one"))!;
    await f.runtime.reconcile(await f.application.setEnabled("one", false, current.revision));
    await f.runtime.suspend(); await f.runtime.resume();
    expect(f.runtime.current("one")).toBeUndefined();
    expect((await f.application.get("one"))?.revision).toBe(6);
  }, 15_000);

  it("transport receipts wait for admission while independent control requests keep flowing", async () => {
    let admit!: () => void;
    const gate = new Promise<void>((resolve) => { admit = resolve; });
    const a = new ExtensionPeer((frame) => b.accept(frame), async () => null);
    const b = new ExtensionPeer((frame) => a.accept(frame), async (method) => { if (method === "message") await gate; return method; });
    let accepted = false;
    const pending = a.call("message", {}).then(() => { accepted = true; });
    expect(await a.call("cancel", {})).toBe("cancel");
    expect(accepted).toBe(false);
    admit(); await pending;
    a.close(); b.close();
  });
});
