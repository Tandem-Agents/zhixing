import { afterEach, expect, it, vi } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { canonicalize } from "../../protocol/canonical.js";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { AuthorityCacheIntegrity } from "../startup-proofs.js";
import { durableProjectionVersionDirectoryName } from "../durable-projection-index.js";

const logs: FileAuthorityCommitLog[] = [];
afterEach(async () => {
  await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance()));
});

async function fixture(authenticated = true, count = 1) {
  const integrity = authenticated ? new AuthorityCacheIntegrity(Buffer.alloc(32, 19)) : undefined;
  const root = await createTempDir("authenticated-projection");
  const open = (unavailable = false) => {
    const log = new FileAuthorityCommitLog(path.join(root, "log"), new FileArtifactStore(path.join(root, "artifacts")), {
      startupProofs: true,
      integrity,
      runProjectionReadStep: async (_step, operation) => {
        if (unavailable) throw new Error("temporary storage unavailable");
        return operation();
      },
    });
    logs.push(log);
    const reduce = vi.fn((envelope: { entries: readonly { stream: string; body: unknown }[] }) =>
      envelope.entries.filter(entry => entry.stream === "control").map(entry => ({ kind: "put" as const,
        key: (entry.body as { key?: string }).key ?? "result", value: entry.body as { value: number } })));
    const index = log.durableProjection({ projectionId: "authenticated-result", reducerVersion: 1, authenticated: true, reduce });
    return { log, index, reduce };
  };
  const writer = open();
  await writer.log.append(Array.from({ length: count }, (_, index) => ({ stream: "control", body: {
    ...(count > 1 ? { key: `result-${index}` } : {}), value: 1,
  } })));
  await writer.index.flushCheckpoint!();
  await writer.log.stopStorageMaintenance();
  const projections = path.join(root, "log", "projections");
  const directory = path.join(projections, durableProjectionVersionDirectoryName("authenticated-result", 1));
  return { open, directory };
}

it("restores an authenticated index without replaying historical values", async () => {
  const h = await fixture();
  const cold = h.open();
  expect(await cold.index.get("result")).toEqual({ value: 1 });
  expect(cold.reduce).not.toHaveBeenCalled();
}, 30_000);

it("does not discard a valid publication when reading storage is temporarily unavailable", async () => {
  const h = await fixture();
  const manifest = path.join(h.directory, "manifest.json");
  const before = await readFile(manifest);
  await expect(h.open(true).index.get("result")).rejects.toThrow("temporary storage unavailable");
  expect(await readFile(manifest)).toEqual(before);
  const healthy = h.open();
  expect(await healthy.index.get("result")).toEqual({ value: 1 });
  expect(healthy.reduce).not.toHaveBeenCalled();
}, 30_000);

it("rebuilds an index whose manifest hides a still-authoritative value", async () => {
  const h = await fixture();
  const manifestFile = path.join(h.directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.deltaSegments = [];
  delete manifest.baseRoot;
  await writeFile(manifestFile, canonicalize(manifest));
  const cold = h.open();
  expect(await cold.index.get("result")).toEqual({ value: 1 });
  expect(cold.reduce).toHaveBeenCalled();
}, 30_000);

it("rejects a valid authenticated entry copied from an older immutable segment", async () => {
  const h = await fixture();
  const before = (await readdir(h.directory)).filter(name => name.endsWith(".data"));
  const oldBytes = await readFile(path.join(h.directory, before[0]!));
  const second = h.open();
  await second.log.append([{ stream: "control", body: { value: 2 } }]);
  await second.index.flushCheckpoint!();
  await second.log.stopStorageMaintenance();
  const newFile = (await readdir(h.directory)).find(name => name.endsWith(".data") && !before.includes(name));
  expect(newFile).toBeDefined();
  await writeFile(path.join(h.directory, newFile!), oldBytes);
  const cold = h.open();
  expect(await cold.index.get("result")).toEqual({ value: 2 });
  expect(cold.reduce).toHaveBeenCalled();
}, 30_000);

it("keeps an authenticated index in memory only when the integrity key is unavailable", async () => {
  const h = await fixture(false);
  // 没有密钥时认证索引从不落盘，也就没有可被采用的未认证磁盘状态。
  await expect(readFile(path.join(h.directory, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const cold = h.open();
  expect(await cold.index.get("result")).toEqual({ value: 1 });
  expect(cold.reduce).toHaveBeenCalled();
}, 30_000);

it("rebuilds a corrupted middle entry encountered inside an atomic decision before appending", async () => {
  const h = await fixture(true, 3);
  const file = (await readdir(h.directory)).find(name => name.endsWith(".data"))!;
  const bytes = await readFile(path.join(h.directory, file));
  const marker = Buffer.from('"key":"result-1","value":1');
  const offset = bytes.indexOf(marker);
  expect(offset).toBeGreaterThan(0);
  bytes[offset + marker.length - 1] = "2".charCodeAt(0);
  await writeFile(path.join(h.directory, file), bytes);
  const cold = h.open();
  const result = await cold.log.transactDurableProjection("authenticated-result", async current => ({
    kind: "return", value: await current.get("result-1"),
  }));
  expect(result.value).toEqual({ key: "result-1", value: 1 });
  expect(cold.reduce).toHaveBeenCalledOnce();
  expect((await cold.log.checkpoint()).lsn).toBe(1);
}, 30_000);
