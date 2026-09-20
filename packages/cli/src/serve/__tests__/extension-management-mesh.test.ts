import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FileArtifactStore, FileAuthorityCommitLog, FileResumableArtifactReceiver } from "@zhixing/core/authority";
import { ExtensionApplication, extensionPublicSnapshot } from "@zhixing/core/extensions/application";
import { ExtensionArtifacts } from "@zhixing/core/extensions/artifacts";
import { ExtensionCandidates } from "@zhixing/core/extensions/candidate";
import { ExtensionOnboarding } from "@zhixing/core/extensions/onboarding";
import type { ExtensionCandidate } from "@zhixing/core/extensions/contracts";
import type { MeshServiceDefinition, MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type { MeshServiceClient } from "@zhixing/mesh";
import { createMeshExtensionManagement, registerExtensionManagementMesh } from "../extension-management-mesh.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "extension-mesh-")); roots.push(root);
  const artifacts = new FileArtifactStore(join(root, "artifacts"));
  const application = new ExtensionApplication({ log: () => new FileAuthorityCommitLog(join(root, "authority"), artifacts), assertOwner() {} });
  const archive = new ExtensionCandidates(join(root, "candidates"));
  const manager = new ExtensionOnboarding(application, new ExtensionArtifacts(join(root, "code")), archive, {
    validate() {}, configuration: async () => undefined, discard: async () => {}, changed: async () => {}, notify: async () => {}, isActive: () => true,
  });
  let service!: MeshServiceDefinition;
  const registry = { register: (_id: string, value: MeshServiceDefinition) => { service = value; return () => {}; } } as MeshServiceRegistry;
  const register = () => registerExtensionManagementMesh({ registry, artifacts,
    receiver: new FileResumableArtifactReceiver(artifacts, join(root, "partials"), { maxArtifactBytes: 24 * 1024 * 1024 }),
    authorizePeer: id => id === "executor", management: { invoke: async request => ({ snapshot: extensionPublicSnapshot(await manager.manage(request)), targetDeviceId: "anchor" }) },
  });
  register();
  let calls = 0; let failAfter = Infinity; let largest = 0; const offsets: number[] = [];
  const client = { request: async (_id: string, payload: Uint8Array) => {
    largest = Math.max(largest, payload.byteLength);
    if (payload.byteLength > 1024 * 1024) throw new Error("Mesh payload limit");
    if (++calls === failAfter) throw new Error("connection lost");
    const wire = JSON.parse(Buffer.from(payload).toString());
    if (wire.step === "append") offsets.push(wire.offset);
    return service.handler(payload, { peer: { deviceId: "executor" } } as never, new AbortController().signal);
  } } as unknown as MeshServiceClient;
  const remote = createMeshExtensionManagement(() => client);
  const code = `/*${"x".repeat(2 * 1024 * 1024)}*/ export const fixture = true;`;
  const candidate: ExtensionCandidate = { code, manifest: { id: "fixture", version: "1.0.0", digest: createHash("sha256").update(code).digest("hex"),
    runtime: "node24", entry: "adapter.mjs", protocol: 1, type: "fixture", contract: 1, declaration: {} },
    provenance: { url: "https://example.com/official", kind: "authored", revision: "v1" }, sources: { "adapter.mjs": code }, build: "Node 24" };
  await remote.invoke({ action: "prepare", id: "op", instanceId: "app", source: { conversationId: "scene", request: "接入" } });
  return { remote, application, archive, candidate, offsets, register, service: () => service,
    failIn: (n: number) => { failAfter = calls + n; }, largest: () => largest };
}

// Multi-MiB durable prefix fsync is real I/O, not an in-memory transport mock.
describe("extension candidate mesh transport", { timeout: 20_000 }, () => {
  it("resumes a multi-MiB candidate after interrupted transfer without exceeding the Mesh envelope", async () => {
    const f = await fixture();
    const request = { action: "connect" as const, id: "op", expectedRevision: 1, candidate: f.candidate };
    f.failIn(4);
    await expect(f.remote.invoke(request)).rejects.toThrow("connection lost");
    expect((await f.application.operation("op"))?.phase).toBe("preparing");
    expect(f.offsets).toEqual([0, 256 * 1024]);
    f.register();
    const result = await f.remote.invoke(request);
    expect(f.offsets[2]).toBe(512 * 1024);
    expect(f.largest()).toBeLessThan(1024 * 1024);
    expect(result).toMatchObject({ targetDeviceId: "anchor", snapshot: { operations: [{ id: "op", phase: "configuration" }] } });
    expect((await f.archive.read(f.candidate.manifest.digest)).code).toBe(f.candidate.code);
    expect(f.service().authorize?.({ peer: { deviceId: "unknown" } } as never)).toBe(false);
  });

  it("cannot finish an interrupted candidate after durable cancellation", async () => {
    const f = await fixture();
    const request = { action: "connect" as const, id: "op", expectedRevision: 1, candidate: f.candidate };
    f.failIn(3);
    await expect(f.remote.invoke(request)).rejects.toThrow();
    await f.remote.invoke({ action: "cancel", id: "op", expectedRevision: 1 });
    f.register();
    await expect(f.remote.invoke(request)).rejects.toThrow("未接纳");
    expect((await f.application.list()).instances).toEqual([]);
    expect((await f.application.operation("op"))?.phase).toBe("cancelled");
  });
});
