import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FileAuthorityCommitLog } from "../authority/commit-log.js";
import { FileArtifactStore } from "../authority/artifact-store.js";
import { ExtensionApplication, extensionPublicSnapshot } from "./application.js";
import { ExtensionArtifacts } from "./artifacts.js";
import { ExtensionCandidates, validateExtensionCandidate } from "./candidate.js";
import { ExtensionOnboarding } from "./onboarding.js";
import type { ExtensionBinding, ExtensionCandidate, ExtensionOperation } from "./contracts.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "extension-onboarding-")); roots.push(root);
  const log = () => new FileAuthorityCommitLog(join(root, "authority"), new FileArtifactStore(join(root, "facts")));
  const application = new ExtensionApplication({ log, assertOwner() {} });
  const code = "export const fixture = true;";
  const candidate: ExtensionCandidate = { manifest: { id: "fixture", version: "1.0.0", digest: createHash("sha256").update(code).digest("hex"),
    runtime: "node24", entry: "extension.mjs", protocol: 1, type: "fixture", contract: 1, declaration: {} }, code,
    provenance: { url: "https://example.com/adapter", revision: "v1.0.0", kind: "authored" }, sources: { "adapter.mjs": code }, build: "Node 24; no dependencies" };
  const binding: ExtensionBinding = { manifest: candidate.manifest, configurationRevision: "config", secretRevision: "secret-ref", projectionRevision: "local" };
  const archive = new ExtensionCandidates(join(root, "candidates"));
  const notifications: ExtensionOperation[] = [];
  const manager = new ExtensionOnboarding(application, new ExtensionArtifacts(join(root, "artifacts")), archive, {
    validate() {}, configuration: async () => undefined, discard: async () => {}, changed: async () => {},
    notify: async op => { notifications.push(op); }, isActive: () => true,
  });
  return { root, log, application, candidate, binding, archive, manager, notifications };
}

describe("durable extension onboarding", () => {
  it("deduplicates preparation, retains original intent and restores the same pending candidate", async () => {
    const f = await fixture();
    const request = { action: "prepare" as const, id: "operation", instanceId: "account", source: { conversationId: "conversation", request: "连接 APP" } };
    await f.manager.manage(request); await f.manager.manage(request);
    expect(f.notifications).toHaveLength(1);
    await f.manager.manage({ action: "connect", id: "operation", expectedRevision: 1, candidate: f.candidate });
    const restored = new ExtensionApplication({ log: f.log, assertOwner() {} });
    expect((await restored.operation("operation"))?.phase).toBe("configuration");
    expect((await restored.operation("operation"))?.source.request).toBe("连接 APP");
    expect(await f.archive.read(f.candidate.manifest.digest)).toEqual(f.candidate);
    await expect(restored.prepare("operation", "different", request.source)).rejects.toThrow("identity conflict");
  });

  it("commits trial and verification separately and hides type proof from public status", async () => {
    const f = await fixture();
    await f.application.prepare("op", "account", { conversationId: "scene", request: "接入", returnAddress: { channel: "rpc" } });
    await f.application.candidate("op", 1, f.candidate.manifest);
    const trial = await f.application.trial("op", 2, f.binding);
    expect(trial.admission?.ready).toBe(false);
    const running = await f.application.begin(trial.id, trial.revision);
    const proof = await f.application.checkpoint("op", 3, { challenge: "private-proof" });
    expect(JSON.stringify(extensionPublicSnapshot(await f.application.list()))).not.toContain("private-proof");
    await expect(f.application.complete("op", proof.revision, "old-generation")).rejects.toThrow();
    await f.application.complete("op", proof.revision, running.generation!);
    expect((await f.application.get("account"))?.admission?.ready).toBe(true);
  });

  it("fences cancelled candidates, disabled trials and late confirmations durably", async () => {
    const f = await fixture();
    await f.application.prepare("op", "account", { conversationId: "scene", request: "接入" });
    await f.application.candidate("op", 1, f.candidate.manifest);
    const trial = await f.application.trial("op", 2, f.binding);
    const running = await f.application.begin(trial.id, trial.revision);
    await f.application.setEnabled(trial.id, false, running.revision);
    expect((await f.application.operation("op"))?.phase).toBe("cancelled");
    await expect(f.application.complete("op", 3, running.generation!)).rejects.toThrow();
    const stopped = (await f.application.get(trial.id))!;
    await expect(f.manager.manage({ action: "connect", id: "op", expectedRevision: 1, candidate: f.candidate })).rejects.toThrow();
    // A fresh explicit enable is a new intent, never reuse the cancelled proof.
    const enabled = await f.application.setEnabled(trial.id, true, stopped.revision);
    expect(enabled.admission?.ready).toBe(false);
    expect((await f.application.operation("op"))?.phase).toBe("verifying");
    expect((await f.application.operation("op"))?.verification).toBeUndefined();
    await expect(f.application.complete("op", 3, running.generation!)).rejects.toThrow();
  });

  it("does not hold an Authority transaction across a waiting configuration and rejects late activation", async () => {
    const f = await fixture();
    await f.application.prepare("op", "account", { conversationId: "scene", request: "接入" });
    await f.application.candidate("op", 1, f.candidate.manifest);
    await f.application.cancel("op", 2);
    await expect(f.application.trial("op", 2, f.binding)).rejects.toThrow();
    expect((await f.application.list()).instances).toEqual([]);
  });

  it("rejects floating dependencies, missing source and unbundled code without executing it", async () => {
    const f = await fixture();
    expect(() => validateExtensionCandidate({ ...f.candidate, sources: {} })).toThrow();
    expect(() => validateExtensionCandidate({ ...f.candidate, sources: { "package.json": JSON.stringify({ dependencies: { sdk: "^1.0.0" } }) } })).toThrow();
    const code = 'import sdk from "third-party";';
    expect(() => validateExtensionCandidate({ ...f.candidate, code, manifest: { ...f.candidate.manifest, digest: createHash("sha256").update(code).digest("hex") } })).toThrow();
    expect(() => validateExtensionCandidate({ ...f.candidate, provenance: { ...f.candidate.provenance, url: "https://example.com/?token=secret" } })).toThrow();
  });

  it("records a bounded preparation result and does not repeatedly wake an ended preparation", async () => {
    const f = await fixture();
    let closed = false;
    const phases: string[] = [];
    const manager = new ExtensionOnboarding(f.application, new ExtensionArtifacts(join(f.root, "artifacts")), f.archive, {
      validate() {}, configuration: async () => undefined, discard: async () => {}, changed: async () => {},
      notify: async op => { phases.push(op.phase); return { kind: "turn", turnId: "prepared-turn" }; },
      preparationClosed: async op => { expect(op.continuation).toEqual({ kind: "turn", turnId: "prepared-turn" }); return closed; }, isActive: () => true,
    });
    await manager.manage({ action: "prepare", id: "op", instanceId: "app", source: { conversationId: "scene", request: "接入" } });
    closed = true;
    await manager.reconcile(); await manager.reconcile();
    expect(phases).toEqual(["preparing", "blocked"]);
    expect((await f.application.operation("op"))?.reason).toContain("尚未提交有效候选");
    expect(extensionPublicSnapshot(await f.application.list()).operations?.[0]?.continuation).toBeUndefined();
  });

  it("retains missing local candidates as a recoverable blocked operation instead of an empty waiting shell", async () => {
    const f = await fixture();
    await f.application.prepare("op", "app", { conversationId: "scene", request: "接入" });
    await f.application.candidate("op", 1, f.candidate.manifest);
    await f.manager.reconcile();
    expect((await f.application.operation("op"))?.phase).toBe("blocked");
    expect((await f.application.operation("op"))?.reason).toContain("制品缺失");
    await f.manager.manage({ action: "connect", id: "op", expectedRevision: 3, candidate: f.candidate });
    expect((await f.application.operation("op"))?.phase).toBe("configuration");
  });

  it("does not reset finite process retries on unrelated status/continuation observations", async () => {
    const f = await fixture();
    await f.application.prepare("op", "app", { conversationId: "scene", request: "接入" });
    await f.application.candidate("op", 1, f.candidate.manifest);
    const trial = await f.application.trial("op", 2, f.binding);
    const running = await f.application.begin("app", trial.revision);
    await f.application.observe("app", running.generation!, "blocked", "有限恢复失败");
    let changes = 0;
    const manager = new ExtensionOnboarding(f.application, new ExtensionArtifacts(join(f.root, "artifacts")), f.archive, {
      validate() {}, configuration: async () => undefined, discard: async () => {}, changed: async () => { changes++; }, notify: async () => {}, isActive: () => true,
    });
    await manager.manage({ action: "status" }); await manager.reconcile();
    expect(changes).toBe(0);
    expect((await f.application.get("app"))?.generation).toBe(running.generation);
  });
});
