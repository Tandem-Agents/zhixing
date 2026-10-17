import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog, MAX_INLINE_LOGICAL_RECORD_BYTES } from "../commit-log.js";
import { AuthorityCacheIntegrity } from "../startup-proofs.js";
import { AUTHORITY_RECOVERY_BUDGET, authorityTailNeedsFlush } from "../recovery-work.js";
import { durableProjectionDirectoryName } from "../durable-projection-index.js";

const logs: FileAuthorityCommitLog[] = [];
const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 71));
afterEach(async () => { await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance())); vi.restoreAllMocks(); });
function open(root: string, readOnly = false, key = integrity) {
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")),
    { integrity: key, readOnly, lockSessionLingerMs: 0 });
  logs.push(log); return log;
}
const definition = (reduce = vi.fn((envelope: { lsn: number }) => [{ kind: "put" as const, key: "last", value: envelope.lsn }])) =>
  ({ projectionId: "recovery-test", reducerVersion: 1, authenticated: true, inputs: { streams: ["control"] }, reduce });

it("uses an existing authenticated proof for a read-only exact lookup without rewriting any file or rereading history", async () => {
  const root = await createTempDir("b2-readonly-authenticated");
  const writer = open(root);
  writer.durableProjection(definition());
  for (let n = 0; n < 40; n++) await writer.append([{ stream: "control", body: { n, text: "x".repeat(16 * 1024) } }]);
  await writer.stopStorageMaintenance();
  async function fingerprint() {
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    return Promise.all(files.filter(file => file.isFile()).map(async file => {
      const name = path.join(file.parentPath, file.name);
      return path.relative(root, name) + ":" + createHash("sha256").update(await readFile(name)).digest("hex");
    })).then(values => values.sort());
  }
  const before = await fingerprint();
  const work: number[] = [];
  const reader = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")),
    { integrity, readOnly: true, owner: false, records: { record(draft) {
      const value = typeof draft === "function" ? draft() : draft;
      if (value.event === "work") work.push(Number(value.data?.readBytes ?? 0));
    } } });
  logs.push(reader);
  const reduce = definition();
  expect(await reader.durableProjection(reduce).get("last")).toBe(40);
  expect(reduce.reduce).not.toHaveBeenCalled();
  await reader.stopStorageMaintenance();
  // The seal/head check may fetch its whole inline frame. Its fixed work is
  // still below two inline-record budgets, independent of forty old frames.
  expect(work.reduce((a, b) => a + b, 0)).toBeLessThan(2 * MAX_INLINE_LOGICAL_RECORD_BYTES);
  expect(await fingerprint()).toEqual(before);
}, 60_000);

it("maintains registered idle projections before a new instance's first unrelated append", async () => {
  const root = await createTempDir("b2-idle");
  const first = open(root), def = definition();
  first.durableProjection(def);
  await first.append([{ stream: "control", body: { n: 0 } }]);
  await first.stopStorageMaintenance();
  const second = open(root), secondDef = definition();
  second.durableProjection(secondDef);
  for (let n = 0; n < AUTHORITY_RECOVERY_BUDGET.hardFrames + 2; n++) {
    await second.append([{ stream: "job:unrelated", body: { n } }]);
  }
  // Do not stop second: published debt must already be bounded after a crash.
  const file = path.join(root, "authority", "projections", durableProjectionDirectoryName(def.projectionId) + ".v1", "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  expect(manifest.checkpoints.authority.lsn).toBeGreaterThan(1);
  expect((await second.checkpoint()).lsn - manifest.checkpoints.authority.lsn).toBeLessThanOrEqual(AUTHORITY_RECOVERY_BUDGET.hardFrames);
  const third = open(root), thirdDef = definition();
  const index = third.durableProjection(thirdDef);
  expect(await index.get("last")).toBe(1);
  expect(thirdDef.reduce).not.toHaveBeenCalled();
  expect(secondDef.reduce).not.toHaveBeenCalled();
}, 60_000);

it("keeps new unrelated candidates non-ready while allowing unrelated commits", async () => {
  const root = await createTempDir("b2-candidate");
  const log = open(root);
  for (let n = 0; n < 80; n++) await log.append([{ stream: "control", body: { n } }]);
  const def = definition(), index = log.durableProjection(def);
  await log.append([{ stream: "job:unrelated", body: {} }]);
  expect(def.reduce).not.toHaveBeenCalled();
  await log.prepareProjections([def.projectionId]);
  expect(await index.get("last")).toBe(80);
  expect((await index.checkpoints()).authority?.lsn).toBe(81);
  expect(def.reduce).toHaveBeenCalledTimes(80);
}, 60_000);

it("adopts another owner's recovery generation even when the WAL head has not changed", async () => {
  const root = await createTempDir("b2-same-head-generation");
  const first = open(root), firstDefinition = definition();
  const index = first.durableProjection(firstDefinition);
  await first.append([{ stream: "control", body: {} }]);
  await index.flushCheckpoint?.();
  expect(await index.get("last")).toBe(1);
  firstDefinition.reduce.mockClear();
  const second = open(root);
  const broken = second.durableProjection({ ...definition(), reduce() { throw new TypeError("interrupted replacement reducer"); } });
  await expect(broken.rebuild()).rejects.toThrow("interrupted replacement reducer");
  // A same-head manifest reset cannot leave the first owner's old ready flag
  // alive: it must rebuild the now-unready generation before answering.
  expect(await index.get("last")).toBe(1);
  expect(firstDefinition.reduce).toHaveBeenCalledTimes(1);
});

it("does not retry a permanent replay failure and still permits unrelated commits", async () => {
  const root = await createTempDir("b2-invalid");
  const log = open(root);
  await log.append([{ stream: "control", body: {} }]);
  const failure = new TypeError("invalid historical control fact");
  const reduce = vi.fn(() => { throw failure; });
  const index = log.durableProjection({ ...definition(), reduce });
  await expect(index.get("last")).rejects.toBe(failure);
  await expect(index.get("last")).rejects.toBe(failure);
  expect(reduce).toHaveBeenCalledTimes(1);
  await expect(log.append([{ stream: "job:unrelated", body: {} }])).resolves.toMatchObject({ lsn: 2 });
  await expect(log.append([{ stream: "control", body: {} }])).rejects.toBe(failure);
});

it.each([8, AUTHORITY_RECOVERY_BUDGET.hardFrames + 4].flatMap(tail =>
  [false, true].map(relatedFirst => ({ tail, relatedFirst }))))(
  "isolates the first discovered maintenance failure (tail=$tail, relatedFirst=$relatedFirst)",
  async ({ tail, relatedFirst }) => {
    const root = await createTempDir("b2-first-failure-isolation");
    const original = open(root);
    original.durableProjection(definition());
    await original.append([{ stream: "control", body: { n: 0 } }]);
    await original.stopStorageMaintenance();
    const compatibleWriter = open(root);
    for (let n = 1; n <= tail; n++) await compatibleWriter.append([{ stream: "control", body: { n } }]);
    await compatibleWriter.stopStorageMaintenance();
    const current = open(root), failure = new TypeError("synthetic permanent control projection failure");
    const reduce = vi.fn(() => { throw failure; });
    const broken = current.durableProjection({ ...definition(), reduce });
    const head = (await current.checkpoint()).lsn;
    if (relatedFirst) {
      await expect(current.append([{ stream: "control", body: { related: true } }])).rejects.toBe(failure);
      expect((await current.checkpoint()).lsn).toBe(head);
    }
    // The very first unrelated write must succeed even if it is the operation
    // which discovers the permanent failure. A second attempt cannot repair it.
    await expect(current.append([{ stream: "job:unrelated", body: { n: 1 } }])).resolves.toMatchObject({ lsn: head + 1 });
    await expect(current.append([{ stream: "job:unrelated", body: { n: 2 } }])).resolves.toMatchObject({ lsn: head + 2 });
    await expect(broken.get("last")).rejects.toBe(failure);
    await expect(current.append([{ stream: "control", body: { related: true } }])).rejects.toBe(failure);
    expect((await current.checkpoint()).lsn).toBe(head + 2);
    expect(reduce).toHaveBeenCalledTimes(1);
  }, 60_000,
);

it("strictly recovers with a different key in read-only mode without modifying the directory", async () => {
  const root = await createTempDir("b2-readonly");
  const writer = open(root), def = definition();
  writer.durableProjection(def);
  await writer.append([{ stream: "control", body: {} }]);
  await writer.stopStorageMaintenance();
  async function tree(): Promise<string[]> {
    const base = path.join(root, "authority");
    const files = await readdir(base, { recursive: true, withFileTypes: true });
    const values: string[] = [];
    for (const file of files) if (file.isFile()) {
      const absolute = path.join(file.parentPath, file.name);
      values.push(path.relative(base, absolute) + ":" + (await readFile(absolute)).toString("base64"));
    }
    return values.sort();
  }
  const before = await tree();
  const reader = open(root, true, new AuthorityCacheIntegrity(Buffer.alloc(32, 72)));
  const index = reader.durableProjection(definition());
  expect(await index.get("last")).toBe(1);
  await expect(reader.append([{ stream: "control", body: {} }])).rejects.toThrow("read-only");
  await reader.stopStorageMaintenance();
  expect(await tree()).toEqual(before);
});

it("admits a legal oversized frame only with zero prior recovery debt", () => {
  const origin = { logId: "test", lsn: 0, frameEndOffset: 64, prefixDigest: "test" };
  const head = { ...origin, lsn: 1, frameEndOffset: 128 };
  expect(authorityTailNeedsFlush(origin, origin, AUTHORITY_RECOVERY_BUDGET.hardBytes + 1)).toBe(false);
  expect(authorityTailNeedsFlush(origin, head, AUTHORITY_RECOVERY_BUDGET.hardBytes + 1)).toBe(true);
  expect(authorityTailNeedsFlush(origin, { ...head, lsn: AUTHORITY_RECOVERY_BUDGET.hardFrames }, 1)).toBe(true);
});
