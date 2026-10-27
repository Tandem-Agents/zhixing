import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile, readFile, readdir, stat, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { CheckpointDirectoryHandle } from "@zhixing/mesh/filesystem";
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
import { LegacyLogFiles } from "./legacy-files.js";
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
  it.each(["incomplete", "unknown", "fault"] as const)("retains the %s admission cause without admitting an unproven writer", async kind => {
    let recovered = false;
    const unknown = Array.from({ length: 10 }, (_, index) => ({ pid: 100 + index, birth: `unknown-${index}` }));
    const h = await setup("", () => {
      if (recovered) return proof();
      if (kind === "fault") throw Object.assign(Error("private inventory path"), { code: "EACCES" });
      return kind === "unknown" ? { ...proof(), candidates: [self, ...unknown] } : { ...proof(), complete: false };
    });
    expect((await h.store.initialize()).migration?.state).toBe("blocked");
    await expect(h.store.append([])).rejects.toMatchObject({ code: "migration-blocked", evidence:
      kind === "fault" ? { category: "system", code: "EACCES", operation: "writers.inventory" } :
      { category: "writer-admission", code: kind === "unknown" ? "old-or-unknown-writer" : "writer-inventory-unavailable", operation: "writers.admission",
        ...(kind === "unknown" ? { writerCount: 10, writerPids: unknown.slice(0, 8).map(writer => writer.pid) } : {}) } });
    recovered = true;
    await expect(h.store.append([])).resolves.toBeDefined();
  });
  it("keeps confirmed writers admitted while a peer-proven newcomer registers, but not after PID reuse", async () => {
    let observation = proof();
    const h = await setup("", () => observation);
    expect((await h.store.initialize()).migration?.state).toBe("confirmed");
    const newcomer = { pid: 18, birth: "new-instance" };
    observation = { ...proof(), candidates: [self, newcomer], compatible: [newcomer] };
    expect((await h.store.maintain()).migration?.state).toBe("confirmed");
    observation = { ...proof(), candidates: [self, { ...newcomer, birth: "reused-pid" }] };
    expect((await h.store.maintain()).migration?.state).toBe("blocked");
    observation = proof();
    expect((await h.store.maintain()).migration?.state).toBe("confirmed");
  });
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
      // 新实例（以及阻塞 → 兼容）从头有限重扫：已登记的不丢、不重复，扫过已登记的前缀后继续登记新的
      expect(initialized.migration!.legacyFiles).toBeGreaterThanOrEqual(Math.max(1, previousCount));
      let maintained = await store.maintain();
      for (let step = 0; maintained.migration!.legacyFiles <= Math.max(previousCount, initialized.migration!.legacyFiles) && step < 16; step++)
        maintained = await store.maintain();
      expect(maintained.migration!.legacyFiles).toBeGreaterThan(Math.max(previousCount, initialized.migration!.legacyFiles));
      expect(maintained.files).toBeLessThanOrEqual(initialPolicy.maxFiles);
      expect(maintained.bytes).toBeLessThanOrEqual(initialPolicy.maxBytes);
      previousCount = maintained.migration!.legacyFiles;
      await store.close();
    }
    expect(await readdir(directory)).toHaveLength(4000);
  }, 60000);
  // C23：历史日志积压不让每个写步骤逐个 stat 或反复重列（实测 4000 份时每步 8009 次 stat、约 3.5 秒）
  // C23：历史日志每步至多原生续读一块（4096B 目录项），发现完成后普通步骤不再碰历史目录。计量四项：跨文件端口返回的
  // 名字数与字节、原生续读次数与实际扫描的目录项/字节（含不匹配与已登记的项）、stat 个数、写入次数与字节，另计读入字节。
  // 总控反例：修前 40/320 份时每步返回 45/325 个名字。
  async function legacyWork(backlog: number, initialPolicy: typeof DEFAULT_LOG_POLICY, options: { restartAfter?: number; between?: (directory: string) => Promise<void> } = {}) {
    const home = await createTempDir(`legacy-work-${backlog}`), directory = path.join(home, "logs", "llm-error");
    await mkdir(directory, { recursive: true });
    for (let first = 0; first < backlog; first += 64) {
      await Promise.all(Array.from({ length: Math.min(64, backlog - first) }, (_, index) => writeFile(path.join(directory, `llm-error-${first + index + 1}-2026-09-24T01-00-00-000Z.log`), "legacy evidence\n")));
    }
    const zero = () => ({ lists: 0, names: 0, nameBytes: 0, scans: 0, scanned: 0, scanBytes: 0, stats: 0, writes: 0, writeBytes: 0, readBytes: 0 });
    let work = zero();
    const open = () => {
      const files = new LogFilesProcess(home);
      const list = files.list.bind(files), scanLegacy = files.scanLegacy.bind(files), statMany = files.statMany!.bind(files),
        stat = files.stat.bind(files), statLegacy = files.statLegacy.bind(files), write = files.write.bind(files), read = files.read.bind(files);
      files.list = async (limit) => { const names = await list(limit); work.lists++; work.names += names.length; work.nameBytes += Buffer.byteLength(JSON.stringify(names)); return names; };
      files.scanLegacy = async (restart, budget) => { const chunk = await scanLegacy(restart, budget); work.scans++; work.scanned += chunk.scanned; work.scanBytes += chunk.bytes; return chunk; };
      files.statMany = async (names) => { work.stats += names.length; return statMany(names); };
      files.stat = async (name) => { work.stats++; return stat(name); };
      files.statLegacy = async (entries) => { work.stats += entries.length; return statLegacy(entries); };
      files.write = async (name, bytes) => { work.writes++; work.writeBytes += bytes.byteLength; return write(name, bytes); };
      files.read = async (...args) => { const bytes = await read(...args); work.readBytes += bytes.byteLength; return bytes; };
      const store = new LocalLogStore({ files, capacity: createDeviceCapacityRuntime(home).arbiter, initialPolicy, observeWriters: async () => proof() });
      stores.push(store);
      return store;
    };
    let store = open();
    const discovery: ReturnType<typeof zero>[] = [];
    const measure = async (step: () => Promise<Awaited<ReturnType<LocalLogStore["maintain"]>>>) => { work = zero(); const status = await step(); return { status, work }; };
    let { status, work: first } = await measure(() => store.initialize());
    discovery.push(first);
    let restartedAt: number | undefined;
    while (status.migration?.state !== "confirmed" && discovery.length < 400) {
      if (discovery.length === options.restartAfter) {
        // 冷重启：新的存储实例与新的文件进程，续读位置随旧进程丢失，从头有限重扫
        await store.close();
        await options.between?.(directory);
        store = open();
        restartedAt = discovery.length;
      }
      const next = await measure(() => store.maintain());
      status = next.status; discovery.push(next.work);
    }
    const ordinary = (await measure(() => store.maintain())).work;
    return { discovery, ordinary, status, restartedAt, remaining: (await readdir(directory)).length };
  }
  const withinChunk = (step: { scans: number; scanBytes: number }) => {
    expect(step.scans).toBeLessThanOrEqual(1);
    expect(step.scanBytes).toBeLessThanOrEqual(4096 + 512);
  };
  it("discovers a legacy backlog one native chunk per step and leaves ordinary steps without legacy work", async () => {
    const initialPolicy = { ...DEFAULT_LOG_POLICY, maxFiles: 4096, governanceBytes: 12 * 1024 * 1024 };
    const [small, large] = [await legacyWork(128, initialPolicy), await legacyWork(512, initialPolicy)];
    for (const run of [small, large]) {
      expect(run.status.migration?.state).toBe("confirmed");
      expect(run.status.migration?.legacyFiles).toBe(run === small ? 128 : 512);
      // 发现期：每步至多一块原生续读、至多登记一批；受管根清点不返回历史文件
      for (const step of run.discovery) {
        withinChunk(step);
        expect(step.stats).toBeLessThanOrEqual(32 + 16);
      }
      // 发现完成后：不再续读历史目录
      expect(run.ordinary.scans).toBe(0);
    }
    // 普通步骤的端口返回、扫描、stat、写入与积压无关；步数随积压成比例
    const portWork = ({ lists, names, nameBytes, scans, scanned, scanBytes, stats, writes, writeBytes }: typeof small.ordinary) => ({ lists, names, nameBytes, scans, scanned, scanBytes, stats, writes, writeBytes });
    expect(portWork(large.ordinary)).toEqual(portWork(small.ordinary));
    expect(Math.max(...large.discovery.map((step) => step.names))).toBe(Math.max(...small.discovery.map((step) => step.names)));
    expect(large.discovery.length / small.discovery.length).toBeGreaterThan(2.5);
    expect(large.discovery.length / small.discovery.length).toBeLessThan(5.5);
    expect([small.remaining, large.remaining]).toEqual([128, 512]);
  }, 180000);
  it("rescans from the start after a cold restart without redoing registrations or exceeding a chunk", async () => {
    const initialPolicy = { ...DEFAULT_LOG_POLICY, maxFiles: 4096, governanceBytes: 12 * 1024 * 1024 };
    const run = await legacyWork(256, initialPolicy, { restartAfter: 4 });
    expect(run.restartedAt).toBe(4);
    for (const step of run.discovery) withinChunk(step);
    expect(run.status.migration?.state).toBe("confirmed");
    expect(run.status.migration?.legacyFiles).toBe(256);
    expect(run.remaining).toBe(256);
  }, 180000);
  it("does not take a legacy directory replaced mid-scan for a finished discovery", async () => {
    const initialPolicy = { ...DEFAULT_LOG_POLICY, maxFiles: 4096, governanceBytes: 12 * 1024 * 1024 };
    const home = await createTempDir("legacy-replaced-mid-scan"), directory = path.join(home, "logs", "llm-error");
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(path.join(directory, `llm-error-${index + 1}-2026-09-24T01-00-00-000Z.log`), "legacy evidence\n")));
    const store = new LocalLogStore({ files: new LogFilesProcess(home), capacity: createDeviceCapacityRuntime(home).arbiter, initialPolicy, observeWriters: async () => proof() });
    stores.push(store);
    // 走到正在读这个目录：已登记了其中一部分、这一轮还没走完
    let status = await store.initialize();
    for (let step = 0; !status.migration?.legacyFiles && step < 16; step++) status = await store.maintain();
    expect(status.migration?.legacyFiles).toBeGreaterThan(0);
    expect(status.migration?.legacyFiles).toBeLessThan(128);
    await rename(directory, path.join(home, "logs", "retained-directory"));
    await mkdir(directory);
    await expect(store.maintain()).rejects.toThrow();
    expect((await store.status()).migration?.state).not.toBe("confirmed");
  }, 60000);
  it("keeps each step's state reads and writes bounded by policy once registered legacy fills the file budget", async () => {
    const initialPolicy = { ...DEFAULT_LOG_POLICY, maxFiles: 64, governanceBytes: 1024 * 1024 };
    const [small, large] = [await legacyWork(256, initialPolicy), await legacyWork(1024, initialPolicy)];
    for (const run of [small, large]) {
      expect(run.status.migration?.state).toBe("confirmed");
      expect(run.status.files).toBeLessThanOrEqual(64);
      expect(run.remaining).toBeLessThanOrEqual(64);
      for (const step of run.discovery) withinChunk(step);
    }
    // 登记的历史条目受 maxFiles 约束：饱和后每步读入、写回的峰值不随积压增长
    const peak = (run: typeof small, key: "writeBytes" | "readBytes") => Math.max(...run.discovery.map((step) => step[key]));
    expect(peak(large, "writeBytes")).toBeLessThanOrEqual(peak(small, "writeBytes") * 1.05);
    expect(peak(large, "readBytes")).toBeLessThanOrEqual(peak(small, "readBytes") * 1.05);
    // 普通步骤：端口返回、扫描、stat、写入相同；读入的状态只差计数器的位数
    const { readBytes: largeRead, ...largeRest } = large.ordinary, { readBytes: smallRead, ...smallRest } = small.ordinary;
    expect(largeRest).toEqual(smallRest);
    expect(largeRead).toBeLessThanOrEqual(smallRead * 1.05);
  }, 240000);
  it("keeps working past 4096 legacy files instead of refusing the whole inventory", async () => {
    const initialPolicy = { ...DEFAULT_LOG_POLICY, maxFiles: 4096, governanceBytes: 12 * 1024 * 1024 };
    const run = await legacyWork(4200, initialPolicy);
    expect(run.status.migration?.state).toBe("confirmed");
    expect(run.status.files).toBeLessThanOrEqual(4096);
    for (const step of run.discovery) withinChunk(step);
    expect(run.ordinary.scans).toBe(0);
  }, 600000);

  // 名字绑定只为正在处理的一批存在：发现不建绑定，回收或缺失即移出，另有硬上限（总控取证：128/512 份全部回收后仍保留 128/512 个）
  it("keeps no name bindings for discovered, retired or vanished legacy files", async () => {
    const home = await createTempDir("legacy-bindings"), directory = path.join(home, "logs", "llm-error");
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(path.join(directory, `llm-error-${index + 1}-2026-09-24T01-00-00-000Z.log`), "legacy evidence\n")));
    const session = process.platform === "win32" ? CheckpointDirectoryHandle.createWindowsSession() : undefined;
    const legacy = new LegacyLogFiles(home, (root, create, readOnly) => session?.openPath(root, create, readOnly) ?? CheckpointDirectoryHandle.openPath(root, create, readOnly), false, 100_000);
    try {
      let peak = 0;
      for (let restart = true; ; restart = false) {
        const chunk = await legacy.scan(restart, 4096);
        expect(legacy.bindings).toBe(0);
        const infos = await legacy.stat(chunk.entries);
        peak = Math.max(peak, legacy.bindings);
        for (const [index, entry] of chunk.entries.entries()) {
          // 与产品回收同序：先截断确认空间，再按身份删除
          const bound = legacy.resolve(entry.name);
          await bound.directory.truncateFile(bound.name, infos[index]!.identity, 0);
          await bound.directory.removeRetired(bound.name, infos[index]!.identity);
          legacy.forget(entry.name);
        }
        expect(legacy.bindings).toBe(0);
        if (chunk.end) break;
      }
      expect(peak).toBeLessThanOrEqual(32);
      expect(await readdir(directory)).toHaveLength(0);
      // 外部删除：再按位置 stat 得到 null，同时移出绑定
      await writeFile(path.join(directory, "llm-error-1-2026-09-24T01-00-00-000Z.log"), "again\n");
      const [located] = (await legacy.scan(true, 4096)).entries;
      expect((await legacy.stat([located!]))[0]).toBeTruthy();
      expect(legacy.bindings).toBe(1);
      await rm(path.join(directory, "llm-error-1-2026-09-24T01-00-00-000Z.log"));
      expect(await legacy.stat([located!])).toEqual([null]);
      expect(legacy.bindings).toBe(0);
      expect(() => legacy.resolve(located!.name)).toThrow();
    } finally { await legacy.close(); await session?.close(); }
  }, 60000);
  it("caps name bindings and evicts the least recently used one", async () => {
    // 只为核对上限：族目录句柄用最小替身，stat 总是成功
    const handle = { identity: "fake-directory", assertIdentity: async () => undefined, close: async () => undefined,
      statFile: async () => ({ bytes: 1, identity: "fake-file" }) } as unknown as CheckpointDirectoryHandle;
    const legacy = new LegacyLogFiles("E:/fake-home", async () => handle, true);
    const located = Array.from({ length: 4100 }, (_, index) => {
      const name = `llm-error-${index + 1}-2026-09-24T01-00-00-000Z.log`;
      return { name: `legacy-${createHash("sha256").update(`logs/llm-error/${name}`).digest("hex")}.log`, path: `logs/llm-error/${name}` };
    });
    for (let first = 0; first < located.length; first += 512) await legacy.stat(located.slice(first, first + 512));
    expect(legacy.bindings).toBe(4096);
    expect(() => legacy.resolve(located[0]!.name)).toThrow();
    expect(legacy.resolve(located.at(-1)!.name).name).toBe("llm-error-4100-2026-09-24T01-00-00-000Z.log");
  });
  it("re-registers a legacy file replaced after registration instead of retiring it on old facts", async () => {
    const home = await createTempDir("legacy-replaced");
    const file = path.join(home, "server.log");
    await writeFile(file, "Legacy evidence from previous version\n");
    let now = Date.now();
    const store = new LocalLogStore({ files: new LogFilesProcess(home), capacity: createDeviceCapacityRuntime(home).arbiter,
      initialPolicy: { ...policy, detailTtlMs: 1000 }, now: () => now, observeWriters: async () => proof() });
    stores.push(store);
    expect((await store.initialize()).migration?.legacyFiles).toBe(1);
    await rename(file, `${file}.previous`);
    await writeFile(file, "Replacement written after registration\n");
    // 到期回收时发现与登记不符：不按旧事实删除，也不让维护失败
    now += 2000;
    await expect(store.maintain()).resolves.toBeDefined();
    const status = await store.maintain();
    expect(status.migration?.legacyFiles).toBe(1);
    expect((await readFile(file, "utf8"))).toBe("Replacement written after registration\n");
  }, 30000);

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
      // 写步骤不再逐条重核已登记的历史日志：被替换的文件由读取时的身份核对拦下（登记仍在，内容已变）
      expect(page.gaps).toContainEqual(change === "retirement-pending"
        ? { kind: "expired", reason: "legacy-retired-during-query" }
        : change === "replacement"
          ? { kind: "insufficient", reason: "legacy-missing-or-changed" }
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
    // 发现逐步推进：先走到该目录已被发现（句柄已打开）再替换
    let status = await store.initialize();
    for (let step = 0; status.migration?.state !== "confirmed" && step < 16; step++) status = await store.maintain();
    expect(status.migration?.legacyFiles).toBe(1);
    await rename(path.join(home, "logs", "llm-error"), path.join(home, "logs", "retained-directory"));
    await mkdir(path.join(home, "logs", "llm-error"));
    await expect(store.maintain()).rejects.toThrow();
  }, 30000);
  it("binds native reads and final retirement to the original physical identity", async () => {
    const { home, file } = await setup("old body");
    const files = new LogFilesProcess(home);
    try {
      await files.open(false);
      // 历史文件只经分页发现，受管根清点不再返回它
      expect((await files.list(100)).some((value) => value.startsWith("legacy-"))).toBe(false);
      const located = (await files.listLegacy("", 100)).entries.find((entry) => entry.name.startsWith("legacy-"))!, name = located.name;
      // 列举只给位置，不建绑定：按位置 stat 之后才能读、截断、删除
      await expect(files.stat(name)).rejects.toThrow();
      expect((await files.statLegacy([located]))[0]).toBeTruthy();
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
      const proof = await probeWriters(home);
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
    const result = await probeWriters(home);
    expect(result.complete).toBe(true);
    expect(result.self?.pid).toBe(process.pid);
    expect(result.self?.birth).toMatch(/^[a-zA-Z0-9_.:-]+$/u);
    expect(Object.keys(result).sort()).toEqual(["at", "candidates", "compatible", "complete", "self"]);
  }, 10000);
});

async function probeWriters(home: string) {
  const files = new LogFilesProcess(home);
  try {
    await files.open(true);
    return await createLogWriterProbe(home, files)();
  } finally { await files.close(); }
}
