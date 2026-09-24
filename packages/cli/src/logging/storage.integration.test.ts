import { afterEach, describe, expect, it } from "vitest";
import { createLogWriterProbe } from "./writers.js";
import { readdir, readFile, stat, rm, open, writeFile, link, rename } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  LocalLogStore,
  logDigest,
  type LogStoreSnapshot,
} from "../../../core/src/logging/storage.js";
import { LogRecorder } from "../../../core/src/logging/recorder.js";
import { LogApplication, formatLogAddress } from "../../../core/src/logging/application.js";
import { bindLogSource, captureLog } from "../../../core/src/logging/capture.js";
import { DEFAULT_LOG_POLICY } from "../../../core/src/logging/policy.js";
import type { LogCapture, LogReadContext } from "../../../core/src/logging/contracts.js";
import { createDeviceCapacityRuntime } from "../__tests__/device-capacity-fixture.js";
import { LogFilesProcess } from "./files-process.js";

const policy = {
  ...DEFAULT_LOG_POLICY,
  maxFiles: 32,
  governanceBytes: 65536,
  maxBytes: 262144,
  segmentBytes: 8192,
  recordBytes: 2048,
  attachmentBytes: 16384,
  criticalTtlMs: 100_000,
  detailTtlMs: 50_000,
  attachmentTtlMs: 20_000,
  queryRecords: 3,
  queryScanBytes: 262144,
  queryResultBytes: 8192,
};
const source = bindLogSource({
  id: "fixture",
  version: 1,
  events: {
    event: {
      message: "fixture evidence",
      level: "error",
      tier: "critical",
      fields: { number: "number", text: "text" },
    },
  },
});
const owner: LogReadContext = {
  subject: "owner",
  revision: "1",
  manageStorage: true,
  scopes: [],
};
const stores: LocalLogStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
async function setup(overrides: Partial<typeof policy> = {}) {
  const home = await createTempDir("runtime-log");
  let time = Date.now(),
    seq = 0;
  const processId = randomUUID(),
    files = new LogFilesProcess(home);
  const capacity = createDeviceCapacityRuntime(home, {
    createDirectory: false,
  });
  const store = new LocalLogStore({
    files,
    capacity: capacity.arbiter,
    initialPolicy: { ...policy, ...overrides },
    now: () => time,
  });
  stores.push(store);
  const app = new LogApplication(store, () => owner, ["fixture:1"]);
  const capture = (text = "value", scope = "storage"): LogCapture =>
    captureLog(
      source,
      { scope },
      {
        event: "event",
        data: { number: ++seq, text },
        refs: [{ kind: "run", id: "run-1" }],
      },
      { ...policy, ...overrides },
      processId,
      seq,
    );
  const root = path.join(home, "logs", "runtime");
  const snapshot = async (): Promise<LogStoreSnapshot> => {
    const name = (await readdir(root))
      .filter((name) => /^state-\d+\.json$/u.test(name))
      .sort()
      .at(-1)!;
    return JSON.parse(await readFile(path.join(root, name), "utf8")).state as LogStoreSnapshot;
  };
  return {
    home,
    root,
    store,
    files,
    app,
    capture,
    snapshot,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
async function listing(root: string): Promise<unknown> {
  return Promise.all(
    (await readdir(root)).sort().map(async (name) => {
      const info = await stat(path.join(root, name));
      return { name, size: info.size, mtime: info.mtimeMs };
    }),
  );
}

describe("runtime log Store using real isolated processes and filesystem", () => {
  it("converges two native writers on one root without reporting normal lock contention as unavailable", async () => {
    const home = await createTempDir("logging-shared-writers");
    const notices: string[] = [];
    const writers = [1, 2].map(number => {
      const store = new LocalLogStore({ files: new LogFilesProcess(home), capacity: createDeviceCapacityRuntime(home).arbiter, observeWriters: createLogWriterProbe(home) });
      const recorder = new LogRecorder(store, { onHealth: health => { if (health.state === "degraded") notices.push(health.lastFailure!); } });
      recorder.bind({ id: `writer-${number}`, version: 1, events: { observed: { message: "shared native writer", tier: "critical", level: "info", fields: {} } } }, { scope: "storage" }).record({ event: "observed" });
      return { store, recorder };
    });
    try {
      await Promise.all(writers.map(({ recorder }) => recorder.flush(15000)));
      for (const { recorder } of writers) expect(recorder.health()).toMatchObject({ state: "ready", queued: 0, lost: 0, unconfirmed: 0 });
      expect(notices).toEqual([]);
      const app = new LogApplication(writers[0]!.store, () => owner, []);
      for (const number of [1, 2]) expect((await app.search({ source: `writer-${number}` })).records).toHaveLength(1);
    } finally { await Promise.all(writers.map(({ recorder }) => recorder.close(5000))); }
  }, 25_000);

  it.each([false, true])("reports a known gap after the health write is unconfirmed (published=%s)", async (published) => {
    const h = await setup();
    await h.store.initialize();
    const write = h.files.write.bind(h.files), sync = h.files.sync.bind(h.files);
    let segmentAttempts = 0, failPublishedBarrier = false;
    h.files.write = async (name, bytes) => {
      if (name.startsWith("segment-")) {
        segmentAttempts++;
        if (segmentAttempts === 1 || (segmentAttempts === 2 && !published))
          throw Error("injected unavailable segment write");
      }
      await write(name, bytes);
      if (published && segmentAttempts === 2 && name.startsWith("published-"))
        failPublishedBarrier = true;
    };
    h.files.sync = async () => {
      await sync();
      if (failPublishedBarrier) {
        failPublishedBarrier = false;
        throw Error("injected lost publication acknowledgement");
      }
    };
    const recorder = new LogRecorder(h.store, { policy });
    try {
      recorder.bind(source, { scope: "storage" }).record({ event: "event", data: { number: 1 } });
      await recorder.flush(5000);
      expect(recorder.health()).toMatchObject({ state: "ready", queued: 0, lost: 0, unconfirmed: 1 });
      expect(segmentAttempts).toBe(4); // Includes the separate confirmed recovery record.
    } finally {
      await recorder.close(1000);
    }
    // Read from a new physical owner after the recording process lifetime ends.
    const reader = new LocalLogStore({ files: new LogFilesProcess(h.home), capacity: createDeviceCapacityRuntime(h.home).arbiter });
    stores.push(reader);
    const app = new LogApplication(reader, () => owner, ["logging:1", "fixture:1"]);
    const page = await app.search();
    expect(page.records).toHaveLength(published ? 3 : 2);
    expect(page.records.every(record => record.source === "logging")).toBe(true);
    expect(page.records.filter(record => record.event === "degraded").every(record => record.data.unconfirmed === 1)).toBe(true);
    expect(page.records.filter(record => record.event === "recovered")).toHaveLength(1);
    expect(new Set(page.records.map(record => record.id)).size).toBe(page.records.length);
    expect(page.coverage.complete).toBe(true);
  }, 15000);

  it("keeps a sequence lower bound inside one segment across query pages", async () => {
    const h = await setup({ segmentBytes: 16384 });
    await h.store.initialize();
    await h.store.append(Array.from({ length: 8 }, () => h.capture()));
    expect((await h.snapshot()).segments).toHaveLength(1);
    const first = await h.app.search({ afterSequence: 4 });
    expect(first.records.map(record => record.data.number)).toEqual([5, 6, 7]);
    expect(first.cursor).toBeTruthy();
    const second = await h.app.search({ afterSequence: 4 }, first.cursor);
    expect(second.records.map(record => record.data.number)).toEqual([8]);
    expect(second.coverage.complete).toBe(true);
    expect((await h.app.search({ afterSequence: 8 })).records).toHaveLength(0);
    expect((await h.app.search({ afterSequence: 0 })).records.map(record => record.data.number)).toEqual([1, 2, 3]);
  }, 20000);

  it("completes maintenance and append for a legal large published inventory within the normal I/O quantum", async () => {
    const h = await setup({ maxFiles: 4096, governanceBytes: 12 * 1024 * 1024, maxBytes: 256 * 1024 * 1024 });
    const status = await h.store.initialize();
    await h.store.close();
    const state = await h.snapshot(), count = 3000, now = Date.now();
    // A valid historical layout fixture, not a benchmark of thousands of appends.
    for (let first = 0; first < count; first += 100) {
      const writes: Promise<void>[] = [];
      for (let i = first; i < first + 100; i++) {
        const record = { ...h.capture().record, storeId: status.storeId, receivedAt: now };
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`), name = `segment-${randomUUID()}.jsonl`;
        state.segments.push({ name, bytes: bytes.length, start: i + 1, end: i + 1, receivedAt: now, tier: "critical", recordIds: [record.id], access: [{ scope: "storage", offset: 0, bytes: bytes.length }], attachments: [] });
        writes.push(writeFile(path.join(h.root, name), bytes));
      }
      await Promise.all(writes);
    }
    state.upper = count;
    const stateName = (await readdir(h.root)).filter(name => /^published-\d{12}\.head$/u.test(name)).sort().at(-1)!.replace("published-", "state-").replace(/head$/u, "json");
    await writeFile(path.join(h.root, stateName), JSON.stringify({ digest: logDigest(JSON.stringify(state)), state }) + "\n");
    const self = { pid: process.pid, birth: "inventory-fixture" };
    const store = new LocalLogStore({ files: new LogFilesProcess(h.home), capacity: createDeviceCapacityRuntime(h.home).arbiter,
      observeWriters: async () => ({ complete: true, at: Date.now(), self, candidates: [self] }) });
    stores.push(store);
    expect((await store.maintain()).upper).toBe(count);
    await store.append([h.capture()]);
    const current = await store.maintain();
    expect(current.upper).toBe(count + 1);
    expect(current.files).toBeLessThanOrEqual(4096);
    expect(current.bytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  }, 60000);

  it("accounts for a detail write that changes disk before rejecting and recovers on the next step", async () => {
    const h = await setup();
    await h.store.initialize();
    const write = h.files.write.bind(h.files);
    let failed = false;
    h.files.write = async (name, bytes) => {
      await write(name, bytes);
      if (!failed && name.startsWith("detail-")) { failed = true; throw Error("partial detail write"); }
    };
    await h.store.append([h.capture("detail evidence ".repeat(600))]);
    expect(failed).toBe(true);
    const current = await h.store.status();
    const actual = await Promise.all((await readdir(h.root)).map(async name => (await stat(path.join(h.root, name))).size));
    expect(current.bytes).toBe(actual.reduce((sum, bytes) => sum + bytes, 0));
    expect(current.bytes).toBeLessThanOrEqual(policy.maxBytes);
    expect((await h.app.search()).records).toHaveLength(1);
    await h.store.maintain();
    expect((await readdir(h.root)).some(name => name.startsWith("detail-"))).toBe(false);
  }, 20000);

  it("persists, pages at a fixed upper bound, reads detail and resumes the same Store", async () => {
    const h = await setup();
    const initialized = await h.store.initialize();
    const first = h.capture("large ".repeat(1000));
    await h.store.append([first, h.capture(), h.capture(), h.capture(), h.capture()]);
    const page1 = await h.app.search();
    expect(page1.records).toHaveLength(3);
    expect(page1.cursor).toBeDefined();
    await h.store.append([h.capture("late")]);
    const page2 = await h.app.search({}, page1.cursor);
    expect(page2.records).toHaveLength(2);
    expect(page2.coverage.upper).toBe(5);
    const detail = await h.app.read(
      formatLogAddress({
        storeId: initialized.storeId,
        kind: "record",
        id: first.record.id,
      }),
      "detail",
    );
    expect(detail.detail).toMatchObject({ text: "large ".repeat(1000) });
    await h.store.rebuildIndex();
    const before = await listing(h.root);
    await h.app.search();
    expect(await listing(h.root)).toEqual(before);
    await h.store.close();
    const reopened = new LocalLogStore({
      files: new LogFilesProcess(h.home),
      capacity: createDeviceCapacityRuntime(h.home).arbiter,
      initialPolicy: { ...policy, maxBytes: policy.maxBytes * 2 },
    });
    stores.push(reopened);
    const resumed = await reopened.initialize();
    expect(resumed.storeId).toBe(initialized.storeId);
    expect(resumed.policy.effective.maxBytes).toBe(policy.maxBytes);
  }, 20_000);

  it("keeps hard byte/file budgets under pressure and retires held files before crediting space", async () => {
    const h = await setup();
    await h.store.initialize();
    await h.store.append([h.capture("first")]);
    const segment = (await h.snapshot()).segments[0]!;
    const held = await open(path.join(h.root, segment.name), "r");
    try {
      for (let n = 0; n < 36; n++) {
        try {
          await h.store.append([h.capture("x".repeat(9000))]);
        } catch {
          await h.store.maintain();
        }
        const status = await h.store.status();
        expect(status.bytes).toBeLessThanOrEqual(policy.maxBytes);
        expect(status.files).toBeLessThanOrEqual(policy.maxFiles);
      }
      h.advance(policy.criticalTtlMs + 1);
      for (let n = 0; n < 12 && (await h.store.status()).retainedSegments; n++)
        await h.store.maintain();
      expect((await held.stat()).size).toBe(0);
      expect((await h.store.status()).retainedSegments).toBe(0);
    } finally {
      await held.close();
    }
  }, 30_000);

  it("reclaims attachments independently and never lets a long-running reference pin old segments", async () => {
    const h = await setup();
    await h.store.initialize();
    await h.store.append([h.capture("a".repeat(8000))]);
    expect((await h.snapshot()).segments[0]!.attachments).toHaveLength(1);
    h.advance(policy.attachmentTtlMs + 1);
    await h.store.maintain();
    expect((await h.snapshot()).segments[0]!.attachments).toHaveLength(0);
    await h.store.append([h.capture("same run, later")]);
    h.advance(policy.criticalTtlMs);
    await h.store.maintain();
    expect((await h.store.status()).retainedSegments).toBe(0);
  }, 20_000);

  it("does not expose other scopes and rejects continuation after permissions change", async () => {
    const h = await setup();
    await h.store.initialize();
    const hidden = h.capture("private", "other");
    await h.store.append([
      h.capture("one", "mine"),
      hidden,
      h.capture("two", "mine"),
      h.capture("three", "mine"),
      h.capture("four", "mine"),
    ]);
    let context: LogReadContext = {
      subject: "reader",
      revision: "1",
      manageStorage: false,
      scopes: ["mine"],
    };
    const app = new LogApplication(h.store, () => context, ["fixture:1"]);
    const page = await app.search();
    expect(page.records).toHaveLength(3);
    expect(JSON.stringify(page)).not.toContain("private");
    expect(page.records.every((record) => record.refs.length === 0)).toBe(true);
    expect((await app.search({ id: hidden.record.id })).gaps).toEqual([]);
    context = { ...context, revision: "2", scopes: [] };
    await expect(app.search({}, page.cursor)).rejects.toThrow("权限");
    await expect(app.status()).rejects.toThrow("授权");
  }, 20_000);

  it("keeps the entire restricted response independent of hidden records and physical offsets", async () => {
    const h = await setup();
    const initialized = await h.store.initialize();
    const context = { subject: "reader", revision: "1", manageStorage: false, scopes: ["mine"] };
    const app = new LogApplication(h.store, () => context, ["fixture:1"]);
    const empty = await app.search();
    const hidden = h.capture("hidden ".repeat(1000), "other");
    await h.store.append([
      hidden,
      ...Array.from({ length: 7 }, () => h.capture("private", "other")),
    ]);
    expect(await app.search()).toEqual(empty);
    const address = (id: string) =>
      formatLogAddress({ storeId: initialized.storeId, kind: "record", id });
    const missing = randomUUID();
    for (const view of ["overview", "timeline", "detail"] as const)
      expect(await app.read(address(hidden.record.id), view)).toEqual(
        await app.read(address(missing), view),
      );
    expect(await app.search({ id: hidden.record.id })).toEqual(await app.search({ id: missing }));
    const operation = (id: string) =>
      formatLogAddress({
        storeId: initialized.storeId,
        kind: "operation",
        ref: { kind: "run", id },
      });
    expect(await app.read(operation("run-1"))).toEqual(await app.read(operation("absent")));
    await h.store.append([
      h.capture("visible-one", "mine"),
      h.capture("mixed-private", "other"),
      h.capture("visible-two", "mine"),
      h.capture("visible-three", "mine"),
      h.capture("visible-four", "mine"),
    ]);
    const first = await app.search();
    expect(first.records).toHaveLength(3);
    expect(first.coverage.upper).toBe(4);
    const cursor = JSON.parse(Buffer.from(first.cursor!, "base64url").toString("utf8"));
    expect(cursor.upper).toBe(4);
    expect(cursor.position).toBe(4);
    expect(JSON.stringify(cursor)).not.toContain(hidden.record.id);
    await h.store.append([h.capture("another-private", "other")]);
    expect(await app.search()).toEqual(first);
    await h.store.append([h.capture("later-visible", "mine")]);
    const next = await app.search({}, first.cursor);
    expect(next.coverage.upper).toBe(4);
    expect(next.coverage.complete).toBe(true);
    expect(next.records.map((record) => record.data.text)).toEqual(["visible-four"]);
    h.advance(policy.criticalTtlMs + 1);
    await h.store.maintain();
    await expect(app.search({}, first.cursor)).rejects.toThrow("覆盖证据不足");
  }, 20_000);

  it("upgrades old access projections one segment per maintenance without a read-side write", async () => {
    const h = await setup();
    await h.store.initialize();
    await h.store.append([h.capture("old-one", "mine")]);
    await h.store.append([h.capture("old-two", "mine")]);
    const before = await h.snapshot();
    const ids = before.segments.flatMap((segment) => segment.recordIds);
    const original = await Promise.all(
      before.segments.map((segment) => readFile(path.join(h.root, segment.name))),
    );
    before.segments = before.segments.map(({ access: _access, ...segment }) => segment);
    const name = `state-${String(before.generation).padStart(12, "0")}.json`;
    await writeFile(
      path.join(h.root, name),
      JSON.stringify({ state: before, digest: logDigest(JSON.stringify(before)) }),
    );
    const app = new LogApplication(
      h.store,
      () => ({ subject: "reader", revision: "1", manageStorage: false, scopes: ["mine"] }),
      ["fixture:1"],
    );
    const listingBefore = await listing(h.root);
    await expect(app.search()).rejects.toThrow("访问投影尚未就绪");
    expect(await listing(h.root)).toEqual(listingBefore);
    expect((await h.app.search()).records.map((record) => record.id)).toEqual(ids);
    await h.store.maintain();
    expect((await h.snapshot()).segments.filter((segment) => segment.access)).toHaveLength(1);
    await expect(app.search()).rejects.toThrow("访问投影尚未就绪");
    await h.store.maintain();
    expect((await app.search()).records.map((record) => record.id)).toEqual(ids);
    expect(
      await Promise.all(
        before.segments.map((segment) => readFile(path.join(h.root, segment.name))),
      ),
    ).toEqual(original);
  }, 20_000);

  it("isolates a damaged legacy projection from healthy writes and retains the damaged evidence", async () => {
    const h = await setup();
    await h.store.initialize();
    await h.store.append([h.capture("legacy", "mine")]);
    const state = await h.snapshot();
    const segment = state.segments[0]!;
    state.segments = state.segments.map(({ access: _access, ...item }) => item);
    const name = `state-${String(state.generation).padStart(12, "0")}.json`;
    await writeFile(
      path.join(h.root, name),
      JSON.stringify({ state, digest: logDigest(JSON.stringify(state)) }),
    );
    const bytes = await readFile(path.join(h.root, segment.name));
    bytes[0] = 33; // Invalid JSON of unchanged length; old evidence must not be guessed or erased.
    await writeFile(path.join(h.root, segment.name), bytes);
    const healthy = h.capture("new evidence", "mine");
    await h.store.append([healthy]);
    const page = await h.app.search();
    expect(page.records.map((record) => record.id)).toEqual([healthy.record.id]);
    expect(page.gaps).toContainEqual({ kind: "insufficient", reason: "record-corrupt" });
    expect(await readFile(path.join(h.root, segment.name))).toEqual(bytes);
    const restricted = new LogApplication(h.store, () => ({
      subject: "reader",
      revision: "1",
      manageStorage: false,
      scopes: ["mine"],
    }));
    await expect(restricted.search()).rejects.toThrow("访问投影尚未就绪");
  }, 20_000);

  it("does not evict retained evidence when an old access projection fits the governance budget", async () => {
    const h = await setup();
    await h.store.initialize();
    await h.store.append(Array.from({ length: 8 }, () => h.capture("legacy", "mine")));
    const state = await h.snapshot();
    const ids = state.segments.flatMap((segment) => segment.recordIds);
    // A valid older governance snapshot near the reserve: upgrading replaces its
    // descriptor; counting old and upgraded descriptors together would evict it.
    state.policy = {
      ...state.policy,
      blocked: "old-maintenance-" + "x".repeat(13400 - Buffer.byteLength(JSON.stringify(state)) - 40),
    };
    state.segments = state.segments.map(({ access: _access, ...segment }) => segment);
    const name = `state-${String(state.generation).padStart(12, "0")}.json`;
    await writeFile(
      path.join(h.root, name),
      JSON.stringify({ state, digest: logDigest(JSON.stringify(state)) }),
    );
    await h.store.maintain();
    const after = await h.snapshot();
    expect(after.segments.flatMap((segment) => segment.recordIds)).toEqual(ids);
    expect(after.segments.every((segment) => segment.access)).toBe(true);
    expect((await h.store.status()).bytes).toBeLessThanOrEqual(policy.maxBytes);
  }, 20_000);

  it("reports authorized projection mismatches as missing evidence rather than a complete empty result", async () => {
    const h = await setup();
    await h.store.initialize();
    const entry = h.capture("evidence", "mine");
    await h.store.append([entry]);
    const segment = (await h.snapshot()).segments[0]!;
    const file = path.join(h.root, segment.name);
    const bytes = await readFile(file, "utf8");
    await writeFile(file, bytes.replace(entry.record.id, randomUUID()));
    const app = new LogApplication(
      h.store,
      () => ({ subject: "reader", revision: "1", manageStorage: false, scopes: ["mine"] }),
      ["fixture:1"],
    );
    const page = await app.search();
    expect(page.records).toEqual([]);
    expect(page.gaps).toContainEqual({ kind: "insufficient", reason: "record-corrupt" });
  }, 20_000);

  it("rechecks storage management authority after asynchronous status and policy work", async () => {
    const h = await setup();
    await h.store.initialize();
    let context: LogReadContext = { ...owner };
    const app = new LogApplication(h.store, () => context);
    const actualStat = h.files.stat.bind(h.files);
    h.files.stat = async (name) => {
      const result = await actualStat(name);
      context = { ...owner, manageStorage: false, revision: "revoked" };
      return result;
    };
    await expect(app.status()).rejects.toThrow("权限发生变化");
    context = { ...owner };
    await expect(app.applyPolicy({ ...policy, queryRecords: 2 }, 1)).rejects.toThrow(
      "权限发生变化",
    );
    // Revocation while loading the state precedes the policy admission fence: nothing commits.
    expect((await h.store.status()).policy.effective.queryRecords).toBe(policy.queryRecords);
    h.files.stat = actualStat;
    context = { ...owner };
    const actualWrite = h.files.write.bind(h.files);
    h.files.write = async (name, bytes) => {
      await actualWrite(name, bytes);
      context = { ...owner, manageStorage: false, revision: "revoked-after-admission" };
    };
    await expect(app.applyPolicy({ ...policy, queryRecords: 2 }, 1)).rejects.toThrow("权限发生变化");
    // After admission, completion remains durable; later revocation suppresses only the private response.
    expect((await h.store.status()).policy.effective.queryRecords).toBe(2);
  }, 20_000);

  it("reads without indexes, does not create a missing store, and rejects hard-link reclaim targets", async () => {
    const h = await setup();
    await expect(h.app.search()).rejects.toThrow();
    expect(await readdir(h.home)).toEqual([]);
    await h.store.initialize();
    await h.store.append([h.capture()]);
    const before = await listing(h.root);
    const result = await h.app.search();
    expect(result.records).toHaveLength(1);
    expect(await listing(h.root)).toEqual(before);
    const outside = path.join(h.home, "business.txt");
    await writeFile(outside, "business evidence");
    const malicious = `detail-${randomUUID()}.json`;
    await link(outside, path.join(h.root, malicious));
    await expect(h.store.maintain()).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("business evidence");
  }, 20_000);

  it("recovers unpublished segment/detail remnants without treating a complete line as durable", async () => {
    const h = await setup();
    const initialized = await h.store.initialize();
    let fail = true;
    const actualWrite = h.files.write.bind(h.files);
    h.files.write = async (name, bytes) => {
      await actualWrite(name, bytes);
      if (fail && name.startsWith("segment-")) {
        fail = false;
        throw Error("simulated writer crash after file sync");
      }
    };
    await expect(h.store.append([h.capture("details ".repeat(700))])).rejects.toThrow();
    expect((await h.app.search()).records).toHaveLength(0);
    await h.store.maintain();
    expect((await h.store.status()).storeId).toBe(initialized.storeId);
    expect((await readdir(h.root)).filter((name) => /^(segment|detail)-/u.test(name))).toEqual([]);
  }, 20_000);

  it("serializes policy CAS and shrink, while startup defaults cannot overwrite an applied version", async () => {
    const h = await setup();
    await h.store.initialize();
    for (let n = 0; n < 10; n++) await h.store.append([h.capture("budget ".repeat(800))]);
    const changed = await h.app.applyPolicy({ ...policy, maxBytes: 196608, maxFiles: 24 }, 1);
    expect(changed.policy.version).toBe(2);
    expect(changed.bytes).toBeLessThanOrEqual(196608);
    expect(changed.files).toBeLessThanOrEqual(24);
    await expect(h.app.applyPolicy(policy, 1)).rejects.toThrow("已变化");
    await h.store.initialize();
    expect((await h.store.status()).policy.version).toBe(2);
  }, 20_000);

  it("keeps concurrent OS owners within both limits throughout writes and a concurrent shrink", async () => {
    const h = await setup();
    await h.store.initialize();
    const second = new LocalLogStore({
      files: new LogFilesProcess(h.home),
      capacity: createDeviceCapacityRuntime(h.home).arbiter,
      initialPolicy: policy,
    });
    stores.push(second);
    await second.initialize();
    const retry = async (work: () => Promise<unknown>): Promise<void> => {
      let last: unknown;
      for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
        try {
          await work();
          return;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/正在维护|资源暂不可用|回收仍在进行/u.test(error.message)
          )
            throw error;
          last = error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      throw last;
    };
    const samples: { bytes: number; files: number }[] = [];
    let sampleBusy = false;
    const timer = setInterval(() => {
      if (sampleBusy) return;
      sampleBusy = true;
      void readdir(h.root)
        .then(async (names) => {
          const sizes = await Promise.all(
            names.map(
              async (name) =>
                (await stat(path.join(h.root, name)).catch(() => undefined))?.size ?? 0,
            ),
          );
          samples.push({
            bytes: sizes.reduce((sum, value) => sum + value, 0),
            files: names.length,
          });
        })
        .finally(() => {
          sampleBusy = false;
        });
    }, 5);
    try {
      await Promise.all([
        (async () => {
          for (let n = 0; n < 15; n++) {
            const capture = h.capture(`a${n}${"x".repeat(6000)}`);
            await retry(() => h.store.append([capture]));
          }
        })(),
        (async () => {
          for (let n = 0; n < 15; n++) {
            const capture = h.capture(`b${n}${"y".repeat(6000)}`);
            await retry(() => second.append([capture]));
          }
        })(),
      ]);
      await Promise.all([
        retry(() => h.store.applyPolicy({ ...policy, maxBytes: 196608, maxFiles: 24 }, 1)),
        retry(() => second.append([h.capture("during shrink")])),
      ]);
      // Reclamation is bounded per step. A requested shrink may need later maintenance.
      for (let step = 0; step < 8; step++) {
        const current = await second.status();
        if (current.policy.version === 2) break;
        expect(current.policy.effective.maxFiles).toBe(policy.maxFiles);
        expect(current.policy.desired?.maxFiles).toBe(24);
        expect(current.policy.blocked).toBe("reclaim-pending");
        await retry(() => second.maintain());
      }
    } finally {
      clearInterval(timer);
      while (sampleBusy) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(samples.length).toBeGreaterThan(0);
    expect(
      samples.every((sample) => sample.bytes <= policy.maxBytes && sample.files <= policy.maxFiles),
    ).toBe(true);
    expect((await second.status()).policy.version).toBe(2);
    expect((await h.store.status()).files).toBeLessThanOrEqual(24);
  }, 40_000);

  it("maintains expiration during idle without another log call", async () => {
    const h = await setup();
    const idlePolicy = {
      ...policy,
      criticalTtlMs: 200,
      detailTtlMs: 150,
      attachmentTtlMs: 100,
      maintenanceMs: 50,
    };
    const store = new LocalLogStore({
      files: new LogFilesProcess(h.home),
      capacity: createDeviceCapacityRuntime(h.home).arbiter,
      initialPolicy: idlePolicy,
    });
    stores.push(store);
    const recorder = new LogRecorder(store, { policy: idlePolicy });
    recorder.bind(source, { scope: "storage" }).record({ event: "event", data: { number: 1 } });
    await recorder.flush(2000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await recorder.close();
    const reader = new LocalLogStore({
      files: new LogFilesProcess(h.home),
      capacity: createDeviceCapacityRuntime(h.home).arbiter,
    });
    stores.push(reader);
    expect((await reader.status()).retainedSegments).toBe(0);
  }, 20_000);

  it("resumes retirement after confirmed truncation and reports a paging gap", async () => {
    const h = await setup();
    await h.store.initialize();
    await h.store.append([h.capture(), h.capture(), h.capture(), h.capture()]);
    const page = await h.app.search();
    expect(page.cursor).toBeDefined();
    const truncate = h.files.truncate.bind(h.files);
    let interrupted = false;
    h.files.truncate = async (name, identity, bytes) => {
      await truncate(name, identity, bytes);
      if (name.startsWith("segment-") && !interrupted) {
        interrupted = true;
        throw Error("crash after truncate sync");
      }
    };
    h.advance(policy.criticalTtlMs + 1);
    await expect(h.store.maintain()).rejects.toThrow();
    expect((await h.snapshot()).pending.length).toBeGreaterThan(0);
    await h.store.maintain();
    const next = await h.app.search({}, page.cursor);
    expect(next.records).toHaveLength(0);
    expect(next.gaps.some((gap) => gap.kind === "expired")).toBe(true);
    expect((await h.store.status()).pendingReclaims).toBe(0);
  }, 20_000);
  it.each([false, true])("recognizes adjacent retirement evidence with a retained tail=%s", async (keepTail) => {
    const h = await setup();
    await h.store.initialize();
    await h.store.append([h.capture(), h.capture(), h.capture(), h.capture()]);
    await h.store.append([h.capture(), h.capture()]);
    h.advance(policy.criticalTtlMs - 1);
    const tail = h.capture("retained-tail");
    if (keepTail) await h.store.append([tail]);
    const page = await h.app.search();
    expect(page.cursor).toBeDefined();
    h.advance(2);
    await h.store.maintain();
    const snapshot = await h.snapshot();
    expect(snapshot.retired.map(({ start, end }) => [start, end])).toEqual([[1, 4], [5, 6]]);
    // Capacity reclamation need not register ranges in ordinal order.
    snapshot.retired.reverse();
    await writeFile(
      path.join(h.root, `state-${String(snapshot.generation).padStart(12, "0")}.json`),
      JSON.stringify({ state: snapshot, digest: logDigest(JSON.stringify(snapshot)) }),
    );
    const next = await h.app.search({}, page.cursor);
    expect(next.records.map((record) => record.id)).toEqual(keepTail ? [tail.record.id] : []);
    expect(next.gaps).toEqual([{ kind: "expired", reason: "records-not-retained" }]);
    expect(next.coverage.complete).toBe(true);
  }, 20_000);

  it("keeps insufficient when retirement evidence has a real internal hole", async () => {
    const h = await setup();
    await h.store.initialize();
    await h.store.append([h.capture(), h.capture(), h.capture(), h.capture()]);
    await h.store.append([h.capture(), h.capture()]);
    await h.store.append([h.capture(), h.capture()]);
    const page = await h.app.search();
    h.advance(policy.criticalTtlMs + 1);
    await h.store.maintain();
    const snapshot = await h.snapshot();
    expect(snapshot.retired).toHaveLength(3);
    // Model bounded governance having forgotten one range; no record evidence is fabricated.
    snapshot.retired.splice(1, 1);
    await writeFile(
      path.join(h.root, `state-${String(snapshot.generation).padStart(12, "0")}.json`),
      JSON.stringify({ state: snapshot, digest: logDigest(JSON.stringify(snapshot)) }),
    );
    const next = await h.app.search({}, page.cursor);
    expect(next.records).toHaveLength(0);
    expect(next.gaps).toEqual([{ kind: "insufficient", reason: "records-not-retained" }]);
  }, 20_000);

  it("publishes only after the snapshot barrier and recovers after namespace rollback", async () => {
    const h = await setup();
    const initial = await h.store.initialize();
    const capture = h.capture();
    const reader = new LocalLogStore({
      files: new LogFilesProcess(h.home),
      capacity: createDeviceCapacityRuntime(h.home).arbiter,
    });
    stores.push(reader);
    const move = h.files.rename.bind(h.files),
      sync = h.files.sync.bind(h.files);
    let candidate: string | undefined,
      failed = false;
    h.files.rename = async (from, to) => {
      await move(from, to);
      if (to.startsWith("state-")) candidate = to;
    };
    h.files.sync = async () => {
      if (candidate && !failed) {
        failed = true;
        expect((await reader.status()).upper).toBe(0);
        throw Error("directory barrier failed");
      }
      await sync();
    };
    await expect(h.store.append([capture])).rejects.toThrow("保存状态不确定");
    expect((await reader.status()).upper).toBe(0);
    await rename(
      path.join(h.root, candidate!),
      path.join(h.root, candidate!.replace(/json$/u, "new")),
    );
    h.files.rename = move;
    h.files.sync = sync;
    const recovered = await h.store.initialize();
    expect(recovered.storeId).toBe(initial.storeId);
    expect(recovered.upper).toBe(1);
    expect((await h.app.search()).records[0]!.id).toBe(capture.record.id);
  }, 20_000);

  it("recovers only an unpublished first torn snapshot without resetting a published Store", async () => {
    const h = await setup();
    await h.files.open(false);
    await h.files.write("state-000000000001.new", Buffer.from('{"digest":'));
    const status = await h.store.initialize();
    expect(status.upper).toBe(0);
    const name = (await readdir(h.root))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .at(-1)!;
    await writeFile(path.join(h.root, name), "broken");
    await expect(h.store.initialize()).rejects.toThrow();
    expect(await readFile(path.join(h.root, name), "utf8")).toBe("broken");
  }, 20_000);

  it("makes metadata room before many small segments at the minimum governance budget", async () => {
    const h = await setup();
    await h.store.initialize();
    for (let n = 0; n < 60; n++) await h.store.append([h.capture(`small-${n}`)]);
    const snapshot = await h.snapshot(),
      status = await h.store.status();
    expect(snapshot.retired.length).toBeGreaterThan(0);
    expect(status.upper).toBe(60);
    expect(status.bytes).toBeLessThanOrEqual(policy.maxBytes);
    expect(status.files).toBeLessThanOrEqual(policy.maxFiles);
    expect((await h.app.search()).records.length).toBeGreaterThan(0);
  }, 30_000);

  it("reads retained larger records after shrink and preserves unknown source envelopes", async () => {
    const h = await setup();
    const oldPolicy = {
      ...policy,
      recordBytes: 8192,
      segmentBytes: 16384,
      queryResultBytes: 16384,
    };
    const old = new LocalLogStore({
      files: new LogFilesProcess(h.home),
      capacity: createDeviceCapacityRuntime(h.home).arbiter,
      initialPolicy: oldPolicy,
    });
    stores.push(old);
    await old.initialize();
    const entry = captureLog(
      source,
      { scope: "storage" },
      { event: "event", data: { number: 1, text: "old-value".repeat(500) } },
      oldPolicy,
      randomUUID(),
      1,
    );
    await old.append([entry]);
    await old.applyPolicy(policy, 1);
    const known = new LogApplication(old, () => owner, ["fixture:1"]),
      unknown = new LogApplication(old, () => owner, []);
    const page = await known.search();
    expect(page.records[0]?.id).toBe(entry.record.id);
    expect(page.records[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(policy.queryResultBytes);
    const projected = (await unknown.search()).records[0]!;
    expect(projected.message).toBe("fixture evidence");
    expect(projected.data).toEqual({});
    expect(projected.gaps?.[0]?.reason).toBe("unknown-source-content");
  }, 20_000);

  it("uses disposable record offsets and falls back safely after index corruption", async () => {
    const h = await setup();
    const initial = await h.store.initialize();
    const entries = Array.from({ length: 5 }, () => h.capture());
    await h.store.append(entries);
    await h.store.applyPolicy({ ...policy, queryScanBytes: 1024 * 1024 }, 1);
    await h.store.rebuildIndex();
    const address = formatLogAddress({
      storeId: initial.storeId,
      kind: "record",
      id: entries[3]!.record.id,
    });
    const read = h.files.read.bind(h.files),
      offsets: number[] = [];
    h.files.read = async (name, size, offset, limit) => {
      if (name.startsWith("segment-")) offsets.push(offset);
      return read(name, size, offset, limit);
    };
    expect((await h.app.read(address)).records[0]?.id).toBe(entries[3]!.record.id);
    expect(offsets.some((offset) => offset > 0)).toBe(true);
    const index = (await readdir(h.root)).find((name) => name.startsWith("index-"))!;
    await writeFile(path.join(h.root, index), '{"schema":1,"offsets":[0,0,0,1,0]}');
    offsets.length = 0;
    expect((await h.app.read(address)).records[0]?.id).toBe(entries[3]!.record.id);
    expect(offsets).toContain(0);
  }, 20_000);

  it("preserves a durable acknowledgement when unlock fails", async () => {
    const h = await setup();
    await h.store.initialize();
    const unlock = h.files.unlock.bind(h.files);
    h.files.unlock = async () => {
      await unlock();
      throw Error("unlock acknowledgement lost");
    };
    const receipt = await h.store.append([h.capture()]);
    expect(receipt.storageDegraded).toBe(true);
    h.files.unlock = unlock;
    expect((await h.store.status()).upper).toBe(1);
    const write = h.files.write.bind(h.files);
    h.files.write = async (name, bytes) => {
      await write(name, bytes);
      if (name.startsWith("segment-")) throw Error("unconfirmed write");
    };
    h.files.unlock = async () => {
      await unlock();
      throw Error("secondary unlock failure");
    };
    await expect(h.store.append([h.capture()])).rejects.toThrow("保存状态不确定");
    h.files.unlock = unlock;
    h.files.write = write;
    await h.store.initialize();
    expect((await h.store.status()).upper).toBe(1);
  }, 20_000);

  it("reauthorizes detail failures and reports concurrent retirement of an already authorized record", async () => {
    const h = await setup();
    const initial = await h.store.initialize();
    const entry = h.capture("large ".repeat(1000), "mine");
    await h.store.append([entry]);
    let context: LogReadContext = {
      subject: "reader",
      revision: "1",
      manageStorage: false,
      scopes: ["mine"],
    };
    const app = new LogApplication(h.store, () => context, ["fixture:1"]);
    const read = h.files.read.bind(h.files);
    h.files.read = async (name, size, offset, limit) => {
      if (name.startsWith("detail-")) {
        context = { ...context, revision: "2", scopes: [] };
        throw Error("detail I/O failed after revocation");
      }
      return read(name, size, offset, limit);
    };
    await expect(
      app.read(
        formatLogAddress({ storeId: initial.storeId, kind: "record", id: entry.record.id }),
        "detail",
      ),
    ).rejects.toThrow("权限发生变化");
    context = { ...context, revision: "3", scopes: ["mine"] };
    const reclaimer = new LocalLogStore({
      files: new LogFilesProcess(h.home),
      capacity: createDeviceCapacityRuntime(h.home).arbiter,
      now: () => Date.now() + policy.criticalTtlMs + 1,
    });
    stores.push(reclaimer);
    let retired = false;
    h.files.read = async (name, size, offset, limit) => {
      const bytes = await read(name, size, offset, limit);
      if (name.startsWith("segment-") && !retired) {
        retired = true;
        await reclaimer.maintain();
      }
      return bytes;
    };
    const result = await app.search();
    expect(result.records).toEqual([]);
    expect(result.gaps.some((gap) => gap.reason === "retired-during-query")).toBe(true);
  }, 20_000);

  it("shares detail scan limits and rejects concurrent response-budget changes", async () => {
    const h = await setup();
    const largePolicy = {
      ...policy,
      maxBytes: 4 * 1024 * 1024,
      attachmentBytes: 1024 * 1024,
      queryResultBytes: 1024 * 1024,
    };
    const store = new LocalLogStore({
      files: h.files,
      capacity: createDeviceCapacityRuntime(h.home).arbiter,
      initialPolicy: largePolicy,
    });
    stores.push(store);
    const initial = await store.initialize();
    const entry = captureLog(
      source,
      { scope: "storage" },
      { event: "event", data: { text: "a".repeat(500_000) } },
      largePolicy,
      randomUUID(),
      1,
    );
    await store.append([entry]);
    const app = new LogApplication(store, () => owner, ["fixture:1"]),
      address = formatLogAddress({ storeId: initial.storeId, kind: "record", id: entry.record.id });
    const read = h.files.read.bind(h.files);
    let detailReads = 0;
    h.files.read = async (name, size, offset, limit) => {
      if (name.startsWith("detail-")) detailReads++;
      return read(name, size, offset, limit);
    };
    const limited = await app.read(address, "detail");
    expect(limited.detail).toBeUndefined();
    expect(detailReads).toBe(0);
    expect(limited.coverage.scannedBytes).toBeLessThanOrEqual(largePolicy.queryScanBytes);
    await store.applyPolicy({ ...largePolicy, queryScanBytes: 1024 * 1024 }, 1);
    const changer = new LocalLogStore({
      files: new LogFilesProcess(h.home),
      capacity: createDeviceCapacityRuntime(h.home).arbiter,
    });
    stores.push(changer);
    h.files.read = async (name, size, offset, limit) => {
      const bytes = await read(name, size, offset, limit);
      if (name.startsWith("detail-"))
        await changer.applyPolicy({ ...largePolicy, queryResultBytes: 4096 }, 2);
      return bytes;
    };
    await expect(app.read(address, "detail")).rejects.toThrow("已变化");
  }, 20_000);
});
