import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile, readFile, readdir, stat, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { LocalLogStore, type LogWriterObservation } from "../../../core/src/logging/storage.js";
import { LogApplication } from "../../../core/src/logging/application.js";
import { DEFAULT_LOG_POLICY } from "../../../core/src/logging/policy.js";
import { createDeviceCapacityRuntime } from "../__tests__/device-capacity-fixture.js";
import { LogFilesProcess } from "./files-process.js";
import { createLogWriterProbe } from "./writers.js";

const stores: LocalLogStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
const policy = { ...DEFAULT_LOG_POLICY, maxFiles: 32, governanceBytes: 65536, maxBytes: 262144, segmentBytes: 8192, recordBytes: 2048, attachmentBytes: 16384 };
const owner = { subject: "owner", revision: "1", manageStorage: true, scopes: [] };
const self = { pid: 17, birth: "birth-a" };
const proof = (): LogWriterObservation => ({ complete: true, at: Date.now(), self, candidates: [self] });
async function setup(text: string, observation: () => LogWriterObservation = proof) {
  const home = await createTempDir("legacy-logs");
  await mkdir(path.join(home, "logs", "llm-error"), { recursive: true });
  const file = path.join(home, "logs", "llm-error", "llm-error-17-2026-09-24T01-00-00-000Z.log");
  await writeFile(file, text);
  const store = new LocalLogStore({ files: new LogFilesProcess(home), capacity: createDeviceCapacityRuntime(home, { createDirectory: false }).arbiter, initialPolicy: policy, observeWriters: async () => observation() });
  stores.push(store);
  return { home, file, store, app: new LogApplication(store, () => owner) };
}

describe("legacy log adoption on native files", () => {
  it("does not erase a writer registered after an older process inventory", async () => {
    const home = await createTempDir("legacy-writer-registration-race");
    let now = Date.now();
    const other = { pid: self.pid + 1, birth: "later-process" };
    let firstProof: LogWriterObservation = { complete: true, at: now, self, candidates: [self] };
    const capacity = createDeviceCapacityRuntime(home);
    const first = new LocalLogStore({ files: new LogFilesProcess(home), capacity: capacity.arbiter,
      now: () => now, observeWriters: async () => firstProof });
    const second = new LocalLogStore({ files: new LogFilesProcess(home), capacity: capacity.arbiter,
      now: () => now, observeWriters: async () => ({ complete: true, at: now, self: other, candidates: [self, other] }) });
    stores.push(first, second);
    await first.initialize();
    now += 10;
    expect((await second.initialize()).migration?.state).toBe("confirmed");
    // Scan order and store lock order may differ. An old scan cannot undo a
    // registration that committed later, even if the new writer is now idle.
    await first.maintain();
    firstProof = { complete: true, at: now + 10, self, candidates: [self, other] };
    now += 10;
    expect((await first.maintain()).migration?.state).toBe("confirmed");
  });
  it("advances a legal high legacy inventory with both unknown and compatible writers", async () => {
    const home = await createTempDir("legacy-large-inventory"), directory = path.join(home, "logs", "llm-error");
    await mkdir(directory, { recursive: true });
    for (let first = 0; first < 4000; first += 100) await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(path.join(directory, `llm-error-${first + index + 1}-2026-09-24T01-00-00-000Z.log`), "legacy evidence\n")));
    const initialPolicy = { ...DEFAULT_LOG_POLICY, maxFiles: 4096, governanceBytes: 12 * 1024 * 1024 };
    let previousCount = 0;
    for (const complete of [false, true]) {
      const store = new LocalLogStore({ files: new LogFilesProcess(home), capacity: createDeviceCapacityRuntime(home).arbiter,
        initialPolicy, observeWriters: async () => ({ ...proof(), complete }) });
      stores.push(store);
      const initialized = await store.initialize();
      expect(initialized.migration?.state).toBe(complete ? "pending" : "blocked");
      expect(initialized.migration!.legacyFiles).toBeGreaterThan(previousCount);
      const maintained = await store.maintain();
      expect(maintained.migration!.legacyFiles).toBeGreaterThan(initialized.migration!.legacyFiles);
      expect(maintained.files).toBeLessThanOrEqual(initialPolicy.maxFiles);
      expect(maintained.bytes).toBeLessThanOrEqual(initialPolicy.maxBytes);
      previousCount = maintained.migration!.legacyFiles;
      await store.close();
    }
    expect(await readdir(directory)).toHaveLength(4000);
  }, 60000);
  it.each(["retirement", "retirement-pending", "replacement", "policy"] as const)("rechecks %s after legacy content has been read", async (change) => {
    const home = await createTempDir("legacy-read-race");
    const file = path.join(home, "server.log");
    await writeFile(file, "Legacy evidence from previous version\n");
    let now = Date.now();
    const initialPolicy = { ...policy, detailTtlMs: 1000 };
    const writerFiles = new LogFilesProcess(home);
    const writer = new LocalLogStore({ files: writerFiles, capacity: createDeviceCapacityRuntime(home).arbiter, initialPolicy, now: () => now, observeWriters: async () => proof() });
    stores.push(writer);
    const initial = await writer.initialize();
    const writerApp = new LogApplication(writer, () => owner);
    const catalog = await writerApp.read(initial.migration!.catalog);
    const address = (catalog.detail as { entries: { address: string }[] }).entries[0]!.address;
    const files = new LogFilesProcess(home), read = files.read.bind(files);
    let changed = false;
    files.read = async (...args) => {
      const bytes = await read(...args);
      if (!changed && args[0].startsWith("legacy-")) {
        changed = true;
        if (change === "retirement") { now += 2000; await writer.maintain(); }
        else if (change === "retirement-pending") {
          const truncate = writerFiles.truncate.bind(writerFiles);
          writerFiles.truncate = async (...values) => { if (values[0].startsWith("legacy-")) throw Error("held legacy file"); await truncate(...values); };
          now += 2000;
          await expect(writer.maintain()).rejects.toThrow("held legacy file");
        }
        else if (change === "replacement") { await rename(file, `${file}.previous`); await writeFile(file, "Replacement legacy evidence\n"); await writer.maintain(); }
        else await writer.applyPolicy({ ...initialPolicy, queryResultBytes: 4096 }, 1);
      }
      return bytes;
    };
    const reader = new LocalLogStore({ files, capacity: createDeviceCapacityRuntime(home).arbiter });
    stores.push(reader);
    const reading = new LogApplication(reader, () => owner).read(address, "detail");
    if (change === "policy") await expect(reading).rejects.toThrow("策略已变化");
    else {
      const page = await reading;
      expect(page.detail).toBeUndefined();
      expect(page.cursor).toBeUndefined();
      expect(page.gaps).toContainEqual(change === "retirement-pending"
        ? { kind: "expired", reason: "legacy-retired-during-query" }
        : { kind: "insufficient", reason: "legacy-not-retained-or-changed" });
      expect(page.coverage.complete).toBe(false);
      if (change === "retirement") await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      else expect((await stat(file)).size).toBeGreaterThan(0);
    }
    expect(changed).toBe(true);
  }, 30000);
  it("reads unregistered files through the same app without creating a runtime directory", async () => {
    const { home, store, app } = await setup(Array.from({ length: 1800 }, (_, i) => `failure row ${i}\n`).join(""));
    const catalog = await app.read("zxlog-local:legacy/catalog");
    expect(catalog.detail).toMatchObject({ registration: "unregistered" });
    const address = (catalog.detail as { entries: { address: string }[] }).entries[0]!.address;
    const first = await app.read(address, "detail");
    expect(first.cursor).toBeTruthy();
    const second = await app.read(address, "detail", first.cursor);
    expect((second.detail as { offset: number }).offset).toBeGreaterThan(0);
    expect(JSON.stringify(first.detail)).toContain("failure row 0");
    await expect(stat(path.join(home, "logs", "runtime"))).rejects.toMatchObject({ code: "ENOENT" });
    await store.initialize();
    await expect(app.read(address, "detail", first.cursor)).rejects.toThrow("登记已变化");
    const stable = await app.read("zxlog-local:legacy/catalog");
    expect((stable.detail as { entries: { address: string }[] }).entries[0]!.address).toMatch(/^zxlog:\/\//u);
  }, 30000);
  it("repairs only a torn first governance candidate while preserving the legacy file", async () => {
    const { home, file, store } = await setup("previous evidence");
    await mkdir(path.join(home, "logs", "runtime"));
    await writeFile(path.join(home, "logs", "runtime", "state-000000000001.new"), "{torn");
    expect((await store.initialize()).migration?.state).toBe("confirmed");
    expect(await readFile(file, "utf8")).toBe("previous evidence");
  }, 30000);
  it("rejects a replaced legacy directory even while its previous handle remains valid", async () => {
    const { home, store } = await setup("old evidence");
    await store.initialize();
    await rename(path.join(home, "logs", "llm-error"), path.join(home, "logs", "retained-directory"));
    await mkdir(path.join(home, "logs", "llm-error"));
    await expect(store.maintain()).rejects.toThrow();
  }, 30000);
  it("binds native reads and final retirement to the original physical identity", async () => {
    const { home, file } = await setup("old body");
    const files = new LogFilesProcess(home);
    try {
      await files.open(false);
      const name = (await files.list(100)).find((value) => value.startsWith("legacy-"))!;
      const info = await files.stat(name);
      await rename(file, `${file}.previous`); await writeFile(file, "new body");
      await expect(files.read(name, info.bytes, 0, info.bytes, info.identity)).rejects.toThrow();
      const replaced = await files.stat(name);
      await files.truncate(name, replaced.identity, 0);
      await rename(file, `${file}.empty`); await writeFile(file, "");
      await expect(files.remove(name, replaced.identity)).rejects.toThrow();
      expect((await stat(file)).size).toBe(0);
    } finally { await files.close(); }
  }, 30000);
  it("keeps empty legacy evidence readable", async () => {
    const { store, app } = await setup(""); const status = await store.initialize();
    const catalog = await app.read(status.migration!.catalog);
    const address = (catalog.detail as { entries: { address: string }[] }).entries[0]!.address;
    expect((await app.read(address, "detail")).detail).toMatchObject({ text: "", truncated: false });
  }, 30000);
  it.skipIf(process.platform !== "win32").each([
    { options: [] }, { options: ["--title", "legacy-writer"] },
    { options: ["--inspect-port", "0"] }, { options: ["--"] },
  ])("detects a second Node writer with relative entry and options $options", async ({ options }) => {
    const home = await createTempDir("legacy-process-proof");
    await mkdir(path.join(home, "packages", "cli", "src"), { recursive: true });
    await writeFile(path.join(home, "packages", "cli", "src", "index.ts"), "process.send('ready'); setInterval(() => {}, 1000);");
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const child = spawn(process.execPath, [`--import=${loader}`, ...options, "packages/cli/src/index.ts"], { cwd: home, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try {
      const ready = Promise.race([once(child, "message"), once(child, "exit").then(() => { throw Error("writer fixture exited"); })]);
      await ready;
      const proof = await createLogWriterProbe(home)();
      expect(proof.candidates.some((item) => item.pid === child.pid)).toBe(true);
    } finally { const closed = once(child, "close"); child.kill(); await closed; }
  }, 30000);
  it("keeps historical evidence explicitly unstructured, read-only and manager-only", async () => {
    const { file, home, store, app } = await setup("prior failure; token=test-secret-value");
    const status = await store.initialize();
    expect(status.migration?.state).toBe("confirmed");
    const filesBefore = await readdir(path.join(home, "logs", "runtime"));
    const catalog = await app.read(status.migration!.catalog);
    const entries = (catalog.detail as { entries: { address: string }[] }).entries;
    expect(entries).toHaveLength(1);
    const detail = await app.read(entries[0]!.address, "detail");
    expect(detail.records).toEqual([]);
    expect(JSON.stringify(detail.detail)).not.toContain("test-secret-value");
    expect((detail.detail as { format: string }).format).toBe("legacy");
    expect(await readFile(file, "utf8")).toContain("test-secret-value");
    expect(await readdir(path.join(home, "logs", "runtime"))).toEqual(filesBefore);
    const restricted = new LogApplication(store, () => ({ ...owner, manageStorage: false, scopes: ["conversation:x"] }));
    await expect(restricted.read(entries[0]!.address, "detail")).rejects.toThrow("管理授权");
  }, 30000);
  it("blocks cleanup while an old incarnation lives, then reclaims over-budget data", async () => {
    let old = true;
    const { store, file } = await setup("x".repeat(400000), () => ({ ...proof(), candidates: old ? [self, { pid: 18, birth: "old" }] : [self] }));
    const blocked = await store.initialize();
    expect(blocked.migration?.state).toBe("blocked");
    expect((await stat(file)).size).toBe(400000);
    expect(blocked.bytes).toBeGreaterThan(policy.maxBytes);
    old = false;
    const ready = await store.maintain();
    expect(ready.migration?.state).toBe("confirmed");
    expect(ready.bytes).toBeLessThanOrEqual(policy.maxBytes);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30000);
  it("does not treat a reused PID or failed scan as a compatible writer", async () => {
    let current = proof();
    const { store } = await setup("old evidence", () => current);
    await store.initialize();
    current = { ...proof(), self: undefined, candidates: [{ pid: self.pid, birth: "replacement" }] };
    expect((await store.maintain()).migration?.state).toBe("blocked");
    current = { complete: false, at: Date.now(), candidates: [] };
    expect((await store.maintain()).migration?.reason).toBe("writer-inventory-unavailable");
  }, 30000);
  it("only manages historical filenames and leaves business recovery material intact", async () => {
    const { home, store } = await setup("old evidence");
    const business = path.join(home, "logs", "llm-error", "authority.wal");
    await writeFile(business, "business-authority");
    await store.initialize();
    await store.maintain();
    expect(await readFile(business, "utf8")).toBe("business-authority");
  }, 30000);
  it("observes the current OS incarnation without returning raw command lines", async () => {
    const home = await createTempDir("log-writer-proof");
    const result = await createLogWriterProbe(home)();
    expect(result.complete).toBe(true);
    expect(result.self?.pid).toBe(process.pid);
    expect(result.self?.birth).toMatch(/^[a-zA-Z0-9_.:-]+$/u);
    expect(Object.keys(result).sort()).toEqual(["at", "candidates", "complete", "self"]);
  }, 10000);
});
