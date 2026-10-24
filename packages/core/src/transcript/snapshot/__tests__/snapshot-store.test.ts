/**
 * SnapshotStore 契约：登记与选取、故障收束、读侧降级、保留期、早期本地测试资料一次性转换、
 * 以及启动选取的工作量与快照数量无关。
 *
 * 选取语义的基准是早期实现（列出全部快照、按 createdAt 降序、遇第一份退役即停、取第一份
 * coverage < E 的），用构造集合与随机集合逐例对照。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { SnapshotStore } from "../store.js";
import { SnapshotAnchorInvariantError, SnapshotIndexDamagedError, type SegmentSnapshotFile } from "../types.js";

// ─── 辅助 ───

const T0 = Date.UTC(2026, 0, 1);
let clock = T0;
let convDir: string;
let store: SnapshotStore;
const dirOf = (id: string) => path.join(convDir, id, "snapshots");
const fileOf = (id: string, name: string) => path.join(dirOf(id), name);
const nameOf = (ms: number) => `${new Date(ms).toISOString().replace(/[:.]/g, "-")}.json`;

beforeEach(async () => {
  const tmp = await createTempDir("snapshot-store");
  convDir = path.join(tmp, "conversations");
  clock = T0;
  store = new SnapshotStore(convDir, { now: () => clock });
});

const input = (covered: number) => ({
  coveredThroughRunIndex: covered,
  structuredSummary: { facts: `f${covered}`, state: "s", active: "a" },
  tokensBefore: 1000,
  tokensAfter: 100,
});

async function writeAt(id: string, ms: number, covered: number, writer = store): Promise<SegmentSnapshotFile | undefined> {
  clock = ms;
  return await writer.write(id, input(covered));
}

async function select(id: string, earliest: number, lastClearAt?: string, reader = store) {
  return await (await reader.openSelection(id)).select(earliest, lastClearAt);
}

/** 早期实现的选取：按 createdAt 降序，遇第一份退役即停，取第一份 coverage < E 的 */
function oldPick(all: readonly SegmentSnapshotFile[], earliest: number, lastClearAt?: string): SegmentSnapshotFile | null {
  const sorted = [...all].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  for (const snapshot of sorted) {
    if (lastClearAt !== undefined && snapshot.createdAt <= lastClearAt) return null;
    if (snapshot.coveredThroughRunIndex < earliest) return snapshot;
  }
  return null;
}

async function jsonFiles(id: string): Promise<string[]> {
  try {
    return (await fs.readdir(dirOf(id))).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

/** 早期本地测试资料：只有快照文件，没有索引 */
async function writeLegacy(id: string, items: Array<{ ms: number; covered: number; conversationId?: string; name?: string }>) {
  await fs.mkdir(dirOf(id), { recursive: true });
  const written: SegmentSnapshotFile[] = [];
  for (const item of items) {
    const snapshot: SegmentSnapshotFile = {
      version: 1,
      conversationId: item.conversationId ?? id,
      createdAt: new Date(item.ms).toISOString(),
      ...input(item.covered),
    };
    await fs.writeFile(fileOf(id, item.name ?? nameOf(item.ms)), JSON.stringify(snapshot, null, 2));
    written.push(snapshot);
  }
  return written;
}

/** 确定性伪随机 */
function lcg(seed: number) {
  let state = seed >>> 0;
  return (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

/** clear 时刻只取有区分度的边界：无 clear、恰在某份 createdAt、紧随其后 */
function clearsFor(all: readonly SegmentSnapshotFile[]): Array<string | undefined> {
  const out: Array<string | undefined> = [undefined];
  for (const s of all) {
    const ms = Date.parse(s.createdAt);
    out.push(new Date(ms).toISOString(), new Date(ms + 1).toISOString());
  }
  return out;
}

/** E 只取有区分度的边界：0、每个覆盖边界及其后一位 */
function earliestFor(all: readonly SegmentSnapshotFile[]): number[] {
  return [...new Set([0, ...all.flatMap((s) => [s.coveredThroughRunIndex, s.coveredThroughRunIndex + 1])])];
}

/** fs 计数：按文件类别与操作累计 */
function meterFs() {
  const counts: Record<string, number> = {};
  const add = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  const category = (file: unknown) => {
    const base = path.basename(String(file));
    if (base === "index.bin") return "index";
    if (base.startsWith("entries-")) return "entries";
    if (base.endsWith(".json")) return "body";
    if (base.endsWith(".tmp")) return "tmp";
    return "other";
  };
  const open = fs.open.bind(fs), readFile = fs.readFile.bind(fs), readdir = fs.readdir.bind(fs), stat = fs.stat.bind(fs);
  const spies = [
    vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
      add(`open:${category(file)}:${flags ?? "r"}`);
      return open(file, flags, mode);
    }) as typeof fs.open),
    vi.spyOn(fs, "readFile").mockImplementation((async (file: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
      add(`readFile:${category(file)}`);
      return (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.readFile),
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
      add("readdir");
      return (readdir as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof fs.readdir),
    vi.spyOn(fs, "stat").mockImplementation((async (file: Parameters<typeof fs.stat>[0]) => {
      add(`stat:${category(file)}`);
      return stat(file);
    }) as typeof fs.stat),
  ];
  return { counts, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

/** 匹配的打开一律失败（次数用尽后恢复正常） */
function failOpen(match: (base: string, flags?: string) => boolean, times = Number.POSITIVE_INFINITY) {
  const open = fs.open.bind(fs);
  let left = times;
  return vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
    if (left > 0 && match(path.basename(String(file)), flags)) {
      left--;
      throw Object.assign(new Error("injected open failure"), { code: "EIO" });
    }
    return open(file, flags, mode);
  }) as typeof fs.open);
}

/** 匹配的文件每次打开后的第一次写入只写出一半 */
function shortWrites(match: (base: string) => boolean) {
  const open = fs.open.bind(fs);
  const state = { injected: 0 };
  const spy = vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
    const handle = await open(file, flags, mode);
    if (match(path.basename(String(file)))) {
      const write = handle.write.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesWritten: number }>;
      let first = true;
      (handle as unknown as { write: typeof write }).write = async (buffer, offset, length, position) => {
        if (!first || length < 2) return await write(buffer, offset, length, position);
        first = false;
        state.injected++;
        return await write(buffer, offset, Math.floor(length / 2), position);
      };
    }
    return handle;
  }) as typeof fs.open);
  return { state, restore: () => spy.mockRestore() };
}

// ─── 登记与选取 ───

describe("登记与选取", () => {
  it("写读往返保真；每份快照一个正文文件", async () => {
    const written = (await writeAt("c1", T0, 5))!;
    expect(written).toMatchObject({ version: 1, conversationId: "c1", coveredThroughRunIndex: 5, createdAt: new Date(T0).toISOString() });
    expect(await jsonFiles("c1")).toEqual([nameOf(T0)]);
    expect(await store.list("c1")).toEqual([written]);
    expect(await select("c1", 6)).toEqual(written);
    expect(await select("c1", 5)).toBeNull();
  });

  it("没有快照目录：没有候选、选取为 null，不建目录", async () => {
    const selection = await store.openSelection("none");
    expect(selection.hasCandidates).toBe(false);
    expect(await selection.select(10, undefined)).toBeNull();
    await store.prepare("none");
    await expect(fs.access(dirOf("none"))).rejects.toThrow();
  });

  it("选取 = coverage < E 中 createdAt 最大、且晚于 lastClearAt 的一份：随机集合与早期算法逐例一致", async () => {
    const rand = lcg(7);
    let compared = 0;
    for (let trial = 0; trial < 24; trial++) {
      const id = `r${trial}`;
      const all: SegmentSnapshotFile[] = [];
      let ms = T0, covered = rand(3);
      for (let i = 0, n = 1 + rand(8); i < n; i++) {
        ms += 1 + rand(5000);
        covered += 1 + rand(3);
        all.push((await writeAt(id, ms, covered))!);
      }
      const selection = await store.openSelection(id);
      expect(selection.hasCandidates).toBe(true);
      for (const e of earliestFor(all)) {
        for (const clear of clearsFor(all)) {
          expect((await selection.select(e, clear))?.createdAt ?? null).toBe(oldPick(all, e, clear)?.createdAt ?? null);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  }, 60_000);

  it("覆盖边界不前进 → 报锚点不变量异常，不写正文、不登记", async () => {
    const first = (await writeAt("a", T0, 3))!;
    await expect(writeAt("a", T0 + 1000, 3)).rejects.toBeInstanceOf(SnapshotAnchorInvariantError);
    await expect(writeAt("a", T0 + 2000, 2)).rejects.toBeInstanceOf(SnapshotAnchorInvariantError);
    expect(await jsonFiles("a")).toEqual([nameOf(T0)]);
    expect(await store.list("a")).toEqual([first]);
  });

  it("墙钟回拨或同一毫秒 → 不写、不覆盖已有正文；时钟前进后照常登记", async () => {
    await writeAt("k", T0, 1);
    const before = await fs.readFile(fileOf("k", nameOf(T0)), "utf-8");
    expect(await writeAt("k", T0, 2)).toBeUndefined();
    expect(await writeAt("k", T0 - 1000, 2)).toBeUndefined();
    expect(await fs.readFile(fileOf("k", nameOf(T0)), "utf-8")).toBe(before);
    expect(await jsonFiles("k")).toEqual([nameOf(T0)]);
    const next = (await writeAt("k", T0 + 1, 2))!;
    expect(await select("k", 10)).toEqual(next);
  });
});

// ─── 登记的故障收束 ───

describe("登记的故障收束", () => {
  it("正文已改名、根发布失败 → 本次调用内删掉正文、清零意图；之后照常登记", async () => {
    await writeAt("p", T0, 1);
    const failing = failOpen((base, flags) => base === "index.bin" && flags === "r+", 1);
    try {
      await expect(writeAt("p", T0 + 1000, 2)).rejects.toThrow("injected open failure");
    } finally { failing.mockRestore(); }
    expect(await jsonFiles("p")).toEqual([nameOf(T0)]);
    expect((await fs.readdir(dirOf("p"))).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect((await select("p", 10))?.coveredThroughRunIndex).toBe(1);
    await writeAt("p", T0 + 2000, 2);
    expect((await select("p", 10))?.coveredThroughRunIndex).toBe(2);
  });

  it("临时落点写入失败 → 无残留", async () => {
    const failing = failOpen((base, flags) => base.endsWith(".json.tmp") && flags === "w+", 1);
    try {
      await expect(writeAt("t", T0, 1)).rejects.toThrow("injected open failure");
    } finally { failing.mockRestore(); }
    expect(await jsonFiles("t")).toEqual([]);
    expect((await store.openSelection("t")).hasCandidates).toBe(false);
  });

  it("崩溃在发布之前（意图与正文已落盘）→ 下次打开放弃意图并删掉正文", async () => {
    await writeAt("c", T0, 1);
    const root = await fs.readFile(fileOf("c", "index.bin"));
    await writeAt("c", T0 + 1000, 2);
    await fs.writeFile(fileOf("c", "index.bin"), root); // 发布没有发生
    expect(await jsonFiles("c")).toHaveLength(2);
    const reopened = new SnapshotStore(convDir, { now: () => clock });
    await reopened.prepare("c");
    expect(await jsonFiles("c")).toEqual([nameOf(T0)]);
    expect((await select("c", 10, undefined, reopened))?.coveredThroughRunIndex).toBe(1);
    await writeAt("c", T0 + 2000, 2, reopened);
    expect((await select("c", 10, undefined, reopened))?.coveredThroughRunIndex).toBe(2);
  });

  it("放弃意图时删除失败 → 意图保留，故障消除后续做", async () => {
    await writeAt("d", T0, 1);
    const root = await fs.readFile(fileOf("d", "index.bin"));
    await writeAt("d", T0 + 1000, 2);
    await fs.writeFile(fileOf("d", "index.bin"), root);
    const unlink = fs.unlink.bind(fs);
    const failing = vi.spyOn(fs, "unlink").mockImplementation((async (file: Parameters<typeof fs.unlink>[0]) => {
      if (path.basename(String(file)) === nameOf(T0 + 1000)) throw Object.assign(new Error("injected unlink failure"), { code: "EBUSY" });
      return unlink(file);
    }) as typeof fs.unlink);
    try {
      await expect(store.prepare("d")).rejects.toThrow("injected unlink failure");
    } finally { failing.mockRestore(); }
    expect(await jsonFiles("d")).toHaveLength(2);
    await store.prepare("d");
    expect(await jsonFiles("d")).toEqual([nameOf(T0)]);
  });

  it("定长项、临时落点、根的写入都只写出一半 → 循环写满，选取读到完整记录", async () => {
    await writeAt("s", T0, 1);
    const short = shortWrites((base) => base.startsWith("entries-") || base.endsWith(".json.tmp") || base === "index.bin");
    let written: SegmentSnapshotFile | undefined;
    try {
      written = await writeAt("s", T0 + 1000, 2);
    } finally { short.restore(); }
    expect(short.state.injected).toBeGreaterThanOrEqual(3);
    const reopened = new SnapshotStore(convDir);
    expect(await select("s", 10, undefined, reopened)).toEqual(written);
  });
});

// ─── 读侧降级 ───

describe("读侧降级（只读、不写盘）", () => {
  it("命中正文缺失 → 按固定次数向更早的已登记项降级，不报错", async () => {
    for (let i = 1; i <= 5; i++) await writeAt("g", T0 + i * 1000, i);
    await fs.unlink(fileOf("g", nameOf(T0 + 5000)));
    expect((await select("g", 10))?.coveredThroughRunIndex).toBe(4);
    await fs.unlink(fileOf("g", nameOf(T0 + 4000)));
    await fs.writeFile(fileOf("g", nameOf(T0 + 3000)), "{ broken");
    const meter = meterFs();
    try {
      expect(await select("g", 10)).toBeNull();
      expect(meter.counts["readFile:body"]).toBe(3);
    } finally { meter.restore(); }
  });

  it("索引根两半都损坏 → 没有候选；读者不写盘；写入方报索引不可用", async () => {
    await writeAt("x", T0, 1);
    const garbage = Buffer.alloc(1024, 0x33);
    await fs.writeFile(fileOf("x", "index.bin"), garbage);
    const selection = await store.openSelection("x");
    expect(selection.hasCandidates).toBe(false);
    expect(await selection.select(10, undefined)).toBeNull();
    expect((await fs.readFile(fileOf("x", "index.bin"))).equals(garbage)).toBe(true);
    await expect(writeAt("x", T0 + 1000, 2)).rejects.toBeInstanceOf(SnapshotIndexDamagedError);
  });

  it("定长项损坏 → 选取返回 null", async () => {
    await writeAt("y", T0, 1);
    await writeAt("y", T0 + 1000, 2);
    const segment = fileOf("y", "entries-000000.bin");
    const bytes = await fs.readFile(segment);
    bytes.fill(0x44, 64 + 40, 64 + 48);
    await fs.writeFile(segment, bytes);
    expect(await select("y", 10)).toBeNull();
  });
});

// ─── 保留期 ───

describe("正文结构与维护占用", () => {
  it("命中正文的摘要结构不合格（null、数组、字段类型错）→ 当作读不出，回退到更早的合格摘要", async () => {
    for (let i = 1; i <= 4; i++) await writeAt("n", T0 + i * 1000, i);
    const corrupt = async (ms: number, summary: unknown) => {
      const file = fileOf("n", nameOf(ms));
      const body = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
      await fs.writeFile(file, JSON.stringify({ ...body, structuredSummary: summary }));
    };
    await corrupt(T0 + 4000, null);
    expect((await select("n", 10))?.coveredThroughRunIndex).toBe(3);
    await corrupt(T0 + 3000, ["facts"]);
    expect((await select("n", 10))?.coveredThroughRunIndex).toBe(2);
    await corrupt(T0 + 2000, { facts: "f", state: 1, active: "a" });
    expect(await select("n", 10)).toBeNull(); // 固定尝试次数用尽，不再往更早读
    expect((await select("n", 2))?.coveredThroughRunIndex).toBe(1);
    expect(await store.list("n")).toHaveLength(1);
  });

  it("转换时摘要结构不合格的旧文件不登记", async () => {
    await writeLegacy("nl", [{ ms: T0 + 1000, covered: 1 }, { ms: T0 + 2000, covered: 2 }]);
    const file = fileOf("nl", nameOf(T0 + 2000));
    const body = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    await fs.writeFile(file, JSON.stringify({ ...body, structuredSummary: { facts: "f" } }));
    await store.prepare("nl");
    expect((await select("nl", 10))?.coveredThroughRunIndex).toBe(1);
  });

  it("维护已排队或进行中 → 登记直接跳过，不排在维护之后等待", async () => {
    await writeLegacy("mt", [{ ms: T0 + 1000, covered: 1 }]);
    const readFile = fs.readFile.bind(fs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = vi.spyOn(fs, "readFile").mockImplementation((async (file: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
      await gate;
      return (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.readFile);
    try {
      const maintenance = store.retainSnapshots("mt", new Date(T0).toISOString(), undefined);
      await expect(writeAt("mt", T0 + 2000, 2)).resolves.toBeUndefined();
      release();
      await maintenance;
    } finally { slow.mockRestore(); }
    expect((await select("mt", 10))?.coveredThroughRunIndex).toBe(1);
    expect((await writeAt("mt", T0 + 3000, 2))?.coveredThroughRunIndex).toBe(2);
  });

  it("早期本地测试资料尚未由维护转换 → 登记不写、不在登记路径上转换", async () => {
    await writeLegacy("lw", [{ ms: T0 + 1000, covered: 1 }]);
    expect(await writeAt("lw", T0 + 2000, 2)).toBeUndefined();
    await expect(fs.access(fileOf("lw", "index.bin"))).rejects.toThrow();
    expect(await jsonFiles("lw")).toEqual([nameOf(T0 + 1000)]);
    await store.prepare("lw");
    expect((await writeAt("lw", T0 + 3000, 2))?.coveredThroughRunIndex).toBe(2);
  });
});

describe("保留期：前缀撤可见、续删、整段回收", () => {
  const cutoff = new Date(T0 + 10_000).toISOString();

  it("超期的删除，最新且未退役的保留；清空退役的超期末代被收走；窗内的退役项保留", async () => {
    await writeAt("r1", T0 + 1000, 1);
    await writeAt("r1", T0 + 2000, 2);
    await expect(store.retainSnapshots("r1", cutoff, undefined)).resolves.toMatchObject({ deleted: 1 });
    expect(await jsonFiles("r1")).toEqual([nameOf(T0 + 2000)]);
    expect((await select("r1", 10))?.coveredThroughRunIndex).toBe(2);

    await writeAt("r2", T0 + 1000, 1);
    await expect(store.retainSnapshots("r2", cutoff, new Date(T0 + 5000).toISOString())).resolves.toMatchObject({ deleted: 1 });
    expect(await jsonFiles("r2")).toEqual([]);
    expect((await store.openSelection("r2")).hasCandidates).toBe(false);

    await writeAt("r3", T0 + 20_000, 1);
    await expect(store.retainSnapshots("r3", cutoff, new Date(T0 + 30_000).toISOString())).resolves.toMatchObject({ deleted: 0 });
    expect(await jsonFiles("r3")).toHaveLength(1);
  });

  it("删除遇占用停下，下一步续做；第二轮零删除", async () => {
    for (let i = 1; i <= 4; i++) await writeAt("b", T0 + i * 1000, i);
    const unlink = fs.unlink.bind(fs);
    const failing = vi.spyOn(fs, "unlink").mockImplementation((async (file: Parameters<typeof fs.unlink>[0]) => {
      if (path.basename(String(file)) === nameOf(T0 + 2000)) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return unlink(file);
    }) as typeof fs.unlink);
    try {
      const first = await store.retainSnapshots("b", cutoff, undefined);
      expect(first.deleted).toBe(1);
      expect(first.warnings).toHaveLength(1);
    } finally { failing.mockRestore(); }
    expect((await store.retainSnapshots("b", cutoff, undefined)).deleted).toBe(2);
    expect((await store.retainSnapshots("b", cutoff, undefined)).deleted).toBe(0);
    expect(await jsonFiles("b")).toEqual([nameOf(T0 + 4000)]);
  });

  it("定长项按段回收：段内全部文件删除后整段删除，选取照常", async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ ms: T0 + (i + 1) * 1000, covered: i + 1 }));
    await writeLegacy("seg", items);
    await store.prepare("seg");
    const late = new Date(T0 + 280_500).toISOString();
    let total = 0;
    for (let step = 0; step < 10; step++) {
      const report = await store.retainSnapshots("seg", late, undefined);
      total += report.deleted;
      if (report.deleted === 0) break;
    }
    expect(total).toBe(280);
    await expect(fs.access(fileOf("seg", "entries-000000.bin"))).rejects.toThrow();
    await fs.access(fileOf("seg", "entries-000001.bin"));
    expect((await select("seg", 1_000))?.coveredThroughRunIndex).toBe(300);
    expect((await select("seg", 290))?.coveredThroughRunIndex).toBe(289);
    expect(await select("seg", 281)).toBeNull();
  }, 60_000);

  it("读者取视图后 retention 删掉命中正文 → 读者降级、不报错", async () => {
    await writeAt("v", T0 + 1000, 1);
    await writeAt("v", T0 + 2000, 2);
    const selection = await store.openSelection("v");
    await store.retainSnapshots("v", cutoff, new Date(T0 + 5000).toISOString());
    expect(await selection.select(10, undefined)).toBeNull();
  });

  it("索引损坏 → 保留期由快照文件重建，之后照常选取与登记", async () => {
    await writeAt("h", T0 + 20_000, 1);
    await writeAt("h", T0 + 21_000, 2);
    await fs.writeFile(fileOf("h", "index.bin"), Buffer.alloc(1024, 0x22));
    const report = await store.retainSnapshots("h", cutoff, undefined);
    expect(report.warnings.join(" ")).toContain("rebuilt");
    expect((await select("h", 10))?.coveredThroughRunIndex).toBe(2);
    await writeAt("h", T0 + 22_000, 3);
    expect((await select("h", 10))?.coveredThroughRunIndex).toBe(3);
  });
});

// ─── 早期本地测试资料 ───

describe("早期本地测试资料一次性转换", () => {
  it("按支配链登记：任意覆盖边界的旧集合，选取与早期算法逐例一致", async () => {
    const rand = lcg(11);
    let compared = 0;
    for (let trial = 0; trial < 24; trial++) {
      const id = `l${trial}`;
      const items: Array<{ ms: number; covered: number }> = [];
      let ms = T0;
      for (let i = 0, n = 1 + rand(8); i < n; i++) {
        ms += 1 + rand(5000);
        items.push({ ms, covered: rand(8) });
      }
      const all = await writeLegacy(id, items);
      await store.prepare(id);
      const selection = await store.openSelection(id);
      for (const e of earliestFor(all)) {
        for (const clear of clearsFor(all)) {
          expect((await selection.select(e, clear))?.createdAt ?? null).toBe(oldPick(all, e, clear)?.createdAt ?? null);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  }, 60_000);

  it("字段或会话身份不符的文件不登记；不在支配链上的文件原样保留；转换之后不再列目录", async () => {
    await writeLegacy("m", [
      { ms: T0 + 1000, covered: 5 },
      { ms: T0 + 2000, covered: 3 },
      { ms: T0 + 3000, covered: 1, conversationId: "other" },
      { ms: T0 + 4000, covered: 0, name: "renamed.json" },
    ]);
    await fs.writeFile(fileOf("m", "broken.json"), "{ not json");
    await store.prepare("m");
    expect((await select("m", 10))?.coveredThroughRunIndex).toBe(3);
    expect((await select("m", 3))).toBeNull();
    expect(await jsonFiles("m")).toHaveLength(5);
    const meter = meterFs();
    try {
      await store.prepare("m");
      await select("m", 10);
      expect(meter.counts.readdir ?? 0).toBe(0);
    } finally { meter.restore(); }
  });

  it("有索引分段却没有根 → 不当作旧资料转换：读者无候选、写入报不可用，保留期修复", async () => {
    await writeAt("q", T0 + 20_000, 1);
    await fs.unlink(fileOf("q", "index.bin"));
    await store.prepare("q");
    await expect(fs.access(fileOf("q", "index.bin"))).rejects.toThrow();
    expect((await store.openSelection("q")).hasCandidates).toBe(false);
    await expect(writeAt("q", T0 + 21_000, 2)).rejects.toBeInstanceOf(SnapshotIndexDamagedError);
    await store.retainSnapshots("q", new Date(T0).toISOString(), undefined);
    expect((await select("q", 10))?.coveredThroughRunIndex).toBe(1);
  });
});

// ─── 工作量 ───

describe("工作量计量（8 / 32 / 128 份）", () => {
  it("启动选取：根 1 次、定长项按对数、正文 1 份、零列目录；登记的计数与规模无关", async () => {
    const rows: Array<{ n: number; select: Record<string, number>; write: Record<string, number> }> = [];
    for (const n of [8, 32, 128]) {
      const id = `w${n}`;
      await writeLegacy(id, Array.from({ length: n }, (_, i) => ({ ms: T0 + (i + 1) * 1000, covered: i + 1 })));
      await store.prepare(id);
      let meter = meterFs();
      const hit = await select(id, Math.floor(n / 2));
      const selectCounts = { ...meter.counts };
      meter.restore();
      expect(hit?.coveredThroughRunIndex).toBe(Math.floor(n / 2) - 1);
      meter = meterFs();
      await writeAt(id, T0 + (n + 10) * 1000, n + 1);
      const writeCounts = { ...meter.counts };
      meter.restore();
      // 保留期一步（没有超期项）：定位撤可见边界只按对数读项，不读正文、不列目录
      meter = meterFs();
      await store.retainSnapshots(id, new Date(T0).toISOString(), undefined);
      const retainCounts = { ...meter.counts };
      meter.restore();
      expect(retainCounts.readdir ?? 0).toBe(0);
      expect(retainCounts["readFile:body"] ?? 0).toBe(0);
      expect(retainCounts["open:entries:r"]).toBeLessThanOrEqual(Math.ceil(Math.log2(n + 1)) + 3);
      rows.push({ n, select: selectCounts, write: writeCounts });
    }
    for (const row of rows) {
      expect(row.select.readdir ?? 0).toBe(0);
      expect(row.select["open:index:r"]).toBe(1);
      expect(row.select["readFile:body"]).toBe(1);
      expect(row.select["open:entries:r"]).toBeLessThanOrEqual(Math.ceil(Math.log2(row.n)) + 1);
      expect(row.write).toEqual(rows[0]!.write);
      expect(row.write.readdir ?? 0).toBe(0);
    }
  }, 60_000);
});
