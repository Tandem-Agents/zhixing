/**
 * 分片化 transcript store 契约测试。
 *
 * 覆盖：append-only 写入与 runIndex 单调性、完整协议消息往返保真、换片、清空事件、倒读原语
 * （跨分片 / 游标分页）、owner 物化幂等与来源绑定、local-turn 的 expectedRunIndex、重驱定位、
 * 恢复 R 的各崩溃点与同实例失败、retention（前缀撤可见、物理删除续做）、只读视图、损坏分类、
 * 旧测试格式一次性转换、以及打开 / 新提交 / 重驱的工作量与历史规模无关。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { Message } from "../../../types/messages.js";
import { ShardedTranscriptStore } from "../store.js";
import { countRuns, readRunsReverse } from "../reader.js";
import { decodePositionEntry, encodePositionEntry, POSITION_RECORD_BYTES } from "../position-file.js";
import { sha256, ZERO_SHA256 } from "../directory-root.js";
import {
  TranscriptDirectoryDamagedError,
  TranscriptOutcomeUnknownError,
  TranscriptViewBusyError,
  type RunRecordInput,
  type TranscriptRunRecord,
} from "../types.js";

// ─── 辅助 ───

let clock = Date.now();
function runInput(text: string, extra?: Partial<RunRecordInput>): RunRecordInput {
  clock += 1000;
  return {
    timestamp: new Date(clock).toISOString(),
    messages: [
      { role: "user", content: [{ type: "text", text }] },
      { role: "assistant", content: [{ type: "text", text: `re:${text}` }] },
    ],
    ...extra,
  };
}

/** 已提交 run：同一 runIndex 每次构造都得到同一条记录（重驱必须是同一事实） */
function committed(runIndex: number, text = `run-${runIndex}`, runId = `r-${runIndex}`): TranscriptRunRecord {
  return {
    type: "run",
    runId,
    runIndex,
    timestamp: new Date(Date.UTC(2026, 0, 1) + runIndex * 1000).toISOString(),
    messages: [
      { role: "user", content: [{ type: "text", text }] },
      { role: "assistant", content: [{ type: "text", text: `re:${text}` }] },
    ],
  };
}

const source = (runIndex: number) => ({ assignmentId: `a-${runIndex}`, commitRevision: runIndex + 1, digest: `sha256:${runIndex}` });

async function collect(store: ShardedTranscriptStore, id: string, before?: { shardId: string; runIndex: number }) {
  const out: Array<{ runIndex: number; shardId: string }> = [];
  for await (const { record, shardId } of readRunsReverse(store, id, { before })) {
    out.push({ runIndex: record.runIndex, shardId });
  }
  return out;
}

let convDir: string;
let store: ShardedTranscriptStore;
const dirOf = (id: string) => path.join(convDir, id, "transcript");
const fileOf = (id: string, name: string) => path.join(dirOf(id), name);

beforeEach(async () => {
  const tmp = await createTempDir("shard-store");
  convDir = path.join(tmp, "conversations");
  store = new ShardedTranscriptStore(convDir);
});

/**
 * 模拟“发布未发生”的崩溃：操作后只把根的 A / B 两半还原到操作前（意图区保留，
 * 与真实崩溃一致：A1 写下的意图已落盘，只有 A3 的发布没有发生）。
 */
async function withRootRolledBack(id: string, action: () => Promise<unknown>): Promise<void> {
  await new ShardedTranscriptStore(convDir).init(id);
  const before = await fs.readFile(fileOf(id, "root.bin"));
  await action();
  const after = await fs.readFile(fileOf(id, "root.bin"));
  before.copy(after, 0, 0, 1024);
  await fs.writeFile(fileOf(id, "root.bin"), after);
}

/** fs.open 计数器：按文件类别与打开方式累计；同时计 stat / readFile / readdir */
function meterFs() {
  const counts: Record<string, number> = {};
  const add = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  const category = (file: unknown) => {
    const base = path.basename(String(file));
    if (base === "root.bin") return "root";
    if (base.endsWith(".pos")) return "pos";
    if (base.endsWith(".jsonl")) return "shard";
    return "other";
  };
  const open = fs.open.bind(fs), stat = fs.stat.bind(fs), readFile = fs.readFile.bind(fs), readdir = fs.readdir.bind(fs);
  const spies = [
    vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
      add(`open:${category(file)}:${flags ?? "r"}`);
      return open(file, flags, mode);
    }) as typeof fs.open),
    vi.spyOn(fs, "stat").mockImplementation((async (file: Parameters<typeof fs.stat>[0]) => {
      add(`stat:${category(file)}`);
      return stat(file);
    }) as typeof fs.stat),
    vi.spyOn(fs, "readFile").mockImplementation((async (file: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
      add(`readFile:${category(file)}`);
      return (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.readFile),
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
      add("readdir");
      return (readdir as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof fs.readdir),
  ];
  return { counts, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

/** 让第 n 次对 root.bin 的 "r+" 打开失败（模拟发布写失败） */
function failRootWrites(times: number) {
  const open = fs.open.bind(fs);
  let left = times;
  return vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
    if (path.basename(String(file)) === "root.bin" && flags === "r+" && left > 0) {
      left--;
      throw Object.assign(new Error("injected root write failure"), { code: "EIO" });
    }
    return open(file, flags, mode);
  }) as typeof fs.open);
}

async function history(id: string, count: number, options?: { maxShardBytes?: number }) {
  const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: options?.maxShardBytes ?? 1 });
  for (let i = 0; i < count; i++) await writer.appendCommittedRunRecord(id, committed(i), source(i));
  return writer;
}

// ─── 基础写入 ───

describe("写入与 runIndex", () => {
  it("init 幂等；exists 反映会话存在性", async () => {
    expect(await store.exists("c1")).toBe(false);
    await store.init("c1");
    await store.init("c1");
    expect(await store.exists("c1")).toBe(true);
    expect((await store.readView("c1"))!.nextRunIndex).toBe(0);
  });

  it("append 自动初始化；runIndex 由 store 分配、单调递增", async () => {
    expect((await store.appendRunRecord("c2", runInput("a"))).runIndex).toBe(0);
    expect((await store.appendRunRecord("c2", runInput("b"))).runIndex).toBe(1);
    expect((await collect(store, "c2")).map((r) => r.runIndex)).toEqual([1, 0]);
  });

  it("幂等物化 committed run，并拒绝跳号或同位置异载荷", async () => {
    const first = committed(0);
    await expect(store.appendCommittedRunRecord("p", first, source(0))).resolves.toMatchObject({ runIndex: 0, appended: true });
    await expect(store.appendCommittedRunRecord("p", first, source(0))).resolves.toMatchObject({ runIndex: 0, appended: false });
    await expect(store.appendCommittedRunRecord("p", committed(2), source(2))).rejects.toThrow("not contiguous");
    await expect(store.appendCommittedRunRecord("p", { ...first, messages: [] }, source(0))).rejects.toThrow("conflicts");
    await expect(store.appendCommittedRunRecord("p", first, { ...source(0), commitRevision: 99 })).rejects.toThrow("conflicts");
    expect(await countRuns(store, "p")).toBe(1);
  });

  it("committed 序号跨 clear、换片与重开保持单调", async () => {
    const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
    await writer.appendCommittedRunRecord("m", committed(0), source(0));
    await writer.appendClear("m");
    await writer.appendCommittedRunRecord("m", committed(1), source(1));
    const reopened = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
    await expect(reopened.appendCommittedRunRecord("m", committed(3), source(3))).rejects.toThrow("not contiguous");
    await expect(reopened.appendCommittedRunRecord("m", committed(2), source(2))).resolves.toMatchObject({ runIndex: 2, appended: true });
    expect(await countRuns(reopened, "m")).toBe(2);
  });

  it("比较的是持久化后的 JSON 合同，省略的可选字段不算冲突", async () => {
    const record = { ...committed(0), usage: undefined };
    await store.appendCommittedRunRecord("o", record, source(0));
    await expect(store.appendCommittedRunRecord("o", record, source(0))).resolves.toMatchObject({ appended: false });
  });

  it("完整协议消息序列往返保真（含工具轮）", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "读文件" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { p: 1 } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "body" }] },
      { role: "assistant", content: [{ type: "text", text: "读完了" }] },
    ];
    await store.appendRunRecord("c3", { timestamp: new Date().toISOString(), messages, usage: { inputTokens: 3, outputTokens: 4 } });
    const [only] = await (async () => { const out = []; for await (const item of readRunsReverse(store, "c3")) out.push(item); return out; })();
    expect(only!.record.messages).toEqual(messages);
    expect(only!.record.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it("重开 store 实例后从已发布水位继续单调", async () => {
    await store.appendRunRecord("c4", runInput("a"));
    await store.appendRunRecord("c4", runInput("b"));
    const reopened = new ShardedTranscriptStore(convDir);
    expect((await reopened.appendRunRecord("c4", runInput("c"))).runIndex).toBe(2);
  });

  it("超过阈值后新 run 进新分片，runIndex 跨片连续；clear 同样先判断换片", async () => {
    const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
    await writer.appendRunRecord("r", runInput("a"));
    await writer.appendClear("r");
    await writer.appendClear("r");
    await writer.appendRunRecord("r", runInput("b"));
    const view = (await writer.readView("r"))!;
    expect(view.activeSeq).toBe(4);
    expect(await collect(writer, "r")).toEqual([{ runIndex: 1, shardId: "000004" }]);
  });
});

// ─── 清空 ───

describe("清空事件", () => {
  it("clear 后倒读与计数为空；其前数据物理仍在；继续追加只见新内容", async () => {
    await store.appendRunRecord("k", runInput("before"));
    await store.appendClear("k");
    expect(await collect(store, "k")).toEqual([]);
    expect(await countRuns(store, "k")).toBe(0);
    const lines = (await store.readShardLines("k", { seq: 1 }))!;
    expect(lines.filter((line) => line.type === "run")).toHaveLength(1);
    await store.appendRunRecord("k", runInput("after"));
    expect((await collect(store, "k")).map((r) => r.runIndex)).toEqual([1]);
    expect((await store.readView("k"))!.lastClearAt).toBeDefined();
  });

  it("ClearRecord 已写、根未发布（崩溃）→ 重开时按意图发布", async () => {
    await store.appendRunRecord("kc", runInput("a"));
    await withRootRolledBack("kc", () => store.appendClear("kc"));
    const reopened = new ShardedTranscriptStore(convDir);
    await reopened.init("kc");
    const view = (await reopened.readView("kc"))!;
    expect(view.lastClearAt).toBeDefined();
    expect(await collect(reopened, "kc")).toEqual([]);
  });
});

// ─── 倒读原语 ───

describe("倒读原语：游标分页", () => {
  it("before 游标从该位置之前继续（跨分片）", async () => {
    const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
    for (let i = 0; i < 4; i++) await writer.appendRunRecord("g", runInput(`t${i}`));
    const all = await collect(writer, "g");
    expect(all.map((r) => r.runIndex)).toEqual([3, 2, 1, 0]);
    expect((await collect(writer, "g", all[1])).map((r) => r.runIndex)).toEqual([1, 0]);
  });

  it("游标所指分片已撤可见 → 产出为空", async () => {
    await history("gv", 4);
    const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1, now: () => Date.now() + 365 * 86_400_000 });
    await writer.retainShards("gv", new Date(Date.now() + 30 * 86_400_000).toISOString());
    expect(await collect(writer, "gv", { shardId: "000001", runIndex: 0 })).toEqual([]);
  });

  it("读者取视图后 retention 撤可见并删除旧片：读到撤可见区间即安静结束，不报损坏", async () => {
    let now = Date.UTC(2026, 0, 1);
    const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1, now: () => now });
    for (let i = 0; i < 5; i++) { now += 86_400_000; await writer.appendCommittedRunRecord("rr", committed(i), source(i)); }
    const reader = readRunsReverse(writer, "rr");
    const first = await reader.next();
    expect(first.value?.record.runIndex).toBe(4);
    await writer.retainShards("rr", new Date(Date.UTC(2026, 0, 30)).toISOString());
    const rest: number[] = [];
    for (let item = await reader.next(); !item.done; item = await reader.next()) rest.push(item.value.record.runIndex);
    expect(rest).toEqual([]);
  });

  it("只读已发布前缀：根之后追加的字节对读者不可见", async () => {
    await store.appendRunRecord("u", runInput("a"));
    await fs.appendFile(fileOf("u", "000001.jsonl"), `${JSON.stringify({ type: "run", runIndex: 1, timestamp: "x", messages: [] })}\n`);
    expect((await collect(store, "u")).map((r) => r.runIndex)).toEqual([0]);
  });
});

// ─── local-turn 的 expectedRunIndex ───

describe("local-turn 重试的稳定身份", () => {
  it("expectedRunIndex 小于水位时核对已发布记录：相同不追加，不同报冲突，超前报不连续", async () => {
    const input = runInput("pending");
    await expect(store.appendRunRecord("e", input, { expectedRunIndex: 0 })).resolves.toMatchObject({ runIndex: 0, appended: true });
    await expect(store.appendRunRecord("e", input, { expectedRunIndex: 0 })).resolves.toMatchObject({ runIndex: 0, appended: false });
    await expect(store.appendRunRecord("e", runInput("other"), { expectedRunIndex: 0 })).rejects.toThrow("conflicts");
    await expect(store.appendRunRecord("e", runInput("ahead"), { expectedRunIndex: 5 })).rejects.toThrow("not contiguous");
    expect(await countRuns(store, "e")).toBe(1);
  });

  it("发布写失败后本调用内恢复成功：promote 重试同一队首不重复，位置对齐", async () => {
    const input = runInput("head");
    const failing = failRootWrites(1);
    await expect(store.appendRunRecord("pr", input, { expectedRunIndex: 0 })).resolves.toMatchObject({ runIndex: 0 });
    failing.mockRestore();
    await expect(store.appendRunRecord("pr", input, { expectedRunIndex: 0 })).resolves.toMatchObject({ appended: false });
    expect((await collect(store, "pr")).map((r) => r.runIndex)).toEqual([0]);
  });
});

// ─── 恢复 R ───

describe("恢复：崩溃点与同实例失败", () => {
  it("A1 后崩溃（只写了位置项）→ 重开放弃意图，同一位置可重新追加", async () => {
    await store.appendCommittedRunRecord("a1", committed(0), source(0));
    const shard = fileOf("a1", "000001.jsonl");
    const size = (await fs.stat(shard)).size;
    await withRootRolledBack("a1", () => store.appendCommittedRunRecord("a1", committed(1), source(1)));
    await fs.truncate(shard, size);
    const reopened = new ShardedTranscriptStore(convDir);
    await expect(reopened.appendCommittedRunRecord("a1", committed(1), source(1))).resolves.toMatchObject({ runIndex: 1, appended: true });
    expect(await countRuns(reopened, "a1")).toBe(2);
  });

  it("A2 写了一半 → 重开截断回意图起点，之后追加不拼出坏行", async () => {
    await store.appendCommittedRunRecord("a2", committed(0), source(0));
    const shard = fileOf("a2", "000001.jsonl");
    const size = (await fs.stat(shard)).size;
    await withRootRolledBack("a2", () => store.appendCommittedRunRecord("a2", committed(1), source(1)));
    await fs.truncate(shard, size + 10);
    const reopened = new ShardedTranscriptStore(convDir);
    await reopened.appendCommittedRunRecord("a2", committed(1), source(1));
    const text = await fs.readFile(shard, "utf-8");
    expect(text.trimEnd().split("\n").every((line) => { JSON.parse(line); return true; })).toBe(true);
    expect(await countRuns(reopened, "a2")).toBe(2);
  });

  it("A2 写完、A3 未发布（owner）→ 重开按意图发布，重驱返回已投影", async () => {
    await withRootRolledBack("a3", () => store.appendCommittedRunRecord("a3", committed(0), source(0)));
    const reopened = new ShardedTranscriptStore(convDir);
    await expect(reopened.appendCommittedRunRecord("a3", committed(0), source(0))).resolves.toMatchObject({ runIndex: 0, appended: false });
    expect(await countRuns(reopened, "a3")).toBe(1);
  });

  it("A2 写完、A3 未发布（local-turn）→ 以后的恢复截断放弃，先前报告的失败成立", async () => {
    await withRootRolledBack("lt", () => store.appendRunRecord("lt", runInput("lost")));
    const reopened = new ShardedTranscriptStore(convDir);
    await reopened.init("lt");
    expect(await countRuns(reopened, "lt")).toBe(0);
    await expect(reopened.appendRunRecord("lt", runInput("again"))).resolves.toMatchObject({ runIndex: 0 });
  });

  it("A3 写撕裂（新的一半校验失败）→ 旧的一半仍是当前根，按意图发布", async () => {
    await store.appendCommittedRunRecord("tr", committed(0), source(0));
    await store.appendCommittedRunRecord("tr", committed(1), source(1));
    // 当前根在 A 半（pub 3）；让下一次发布写进 B 半后把 B 半写坏
    const before = await fs.readFile(fileOf("tr", "root.bin"));
    await store.appendCommittedRunRecord("tr", committed(2), source(2));
    const after = await fs.readFile(fileOf("tr", "root.bin"));
    const torn = Buffer.from(after);
    const changedHalf = after.subarray(0, 512).equals(before.subarray(0, 512)) ? 512 : 0;
    before.subarray(changedHalf, changedHalf + 512).copy(torn, changedHalf);
    torn.fill(0x55, changedHalf + 100, changedHalf + 200);
    await fs.writeFile(fileOf("tr", "root.bin"), torn);
    const reopened = new ShardedTranscriptStore(convDir);
    await expect(reopened.appendCommittedRunRecord("tr", committed(2), source(2))).resolves.toMatchObject({ appended: false });
    expect(await countRuns(reopened, "tr")).toBe(3);
  });

  it("换片只写了 .pos、正文尚未创建 → 正常崩溃点，放弃后照常追加", async () => {
    const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
    await writer.appendCommittedRunRecord("rp", committed(0), source(0));
    await withRootRolledBack("rp", () => writer.appendCommittedRunRecord("rp", committed(1), source(1)));
    await fs.unlink(fileOf("rp", "000002.jsonl"));
    const reopened = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
    await expect(reopened.appendCommittedRunRecord("rp", committed(1), source(1))).resolves.toMatchObject({ runIndex: 1, appended: true });
    expect((await collect(reopened, "rp")).map((r) => r.runIndex)).toEqual([1, 0]);
  });

  it("放弃的 run 意图之后发生 clear：旧意图不会被当作有效意图", async () => {
    await store.appendRunRecord("ab", runInput("a"));
    const shard = fileOf("ab", "000001.jsonl");
    const size = (await fs.stat(shard)).size;
    await withRootRolledBack("ab", () => store.appendRunRecord("ab", runInput("abandoned")));
    await fs.truncate(shard, size);
    const reopened = new ShardedTranscriptStore(convDir);
    await reopened.appendClear("ab");
    await reopened.appendRunRecord("ab", runInput("b"));
    const again = new ShardedTranscriptStore(convDir);
    expect((await collect(again, "ab")).map((r) => r.runIndex)).toEqual([1]);
    expect(await countRuns(again, "ab")).toBe(1);
  });

  it("同实例 A2 写入失败 → 本调用内放弃，确定失败；重试只追加一次", async () => {
    await store.appendRunRecord("w2", runInput("a"));
    const open = fs.open.bind(fs);
    let left = 1;
    const failing = vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
      if (String(file).endsWith(".jsonl") && flags === "r+" && left > 0) {
        left--;
        throw Object.assign(new Error("injected shard write failure"), { code: "EIO" });
      }
      return open(file, flags, mode);
    }) as typeof fs.open);
    const input = runInput("b");
    try {
      await expect(store.appendRunRecord("w2", input)).rejects.toThrow("injected shard write failure");
    } finally { failing.mockRestore(); }
    await expect(store.appendRunRecord("w2", input)).resolves.toMatchObject({ runIndex: 1, appended: true });
    expect((await collect(store, "w2")).map((r) => r.runIndex)).toEqual([1, 0]);
  });

  it("恢复本身也失败 → 抛出结果未知；之后的操作先恢复，不重复追加", async () => {
    const failing = failRootWrites(2);
    await expect(store.appendCommittedRunRecord("uk", committed(0), source(0))).rejects.toBeInstanceOf(TranscriptOutcomeUnknownError);
    failing.mockRestore();
    await expect(store.appendCommittedRunRecord("uk", committed(0), source(0))).resolves.toMatchObject({ runIndex: 0, appended: false });
    expect(await countRuns(store, "uk")).toBe(1);
  });

  it("活跃片有未经意图解释的字节 → 失败关闭，不截断", async () => {
    await store.appendRunRecord("ex", runInput("a"));
    await fs.appendFile(fileOf("ex", "000001.jsonl"), "garbage");
    await expect(new ShardedTranscriptStore(convDir).appendRunRecord("ex", runInput("b"))).rejects.toBeInstanceOf(TranscriptDirectoryDamagedError);
    expect((await fs.readFile(fileOf("ex", "000001.jsonl"), "utf-8")).endsWith("garbage")).toBe(true);
  });
});

// ─── 重驱定位 ───

describe("重驱定位", () => {
  it("最近一条走根里的精确位置，更早的按位置文件头二分，只读自身字节", async () => {
    await history("rd", 16);
    const reopened = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
    await reopened.init("rd");
    const meter = meterFs();
    try {
      await expect(reopened.appendCommittedRunRecord("rd", committed(15), source(15))).resolves.toMatchObject({ appended: false });
      expect(meter.counts["readFile:shard"] ?? 0).toBe(0);
      await expect(reopened.appendCommittedRunRecord("rd", committed(3), source(3))).resolves.toMatchObject({ runIndex: 3, shardId: "000004", appended: false });
      expect(meter.counts["readFile:shard"] ?? 0).toBe(0);
      expect(meter.counts["open:shard:r"]).toBe(2);
      expect(meter.counts["open:pos:r"]).toBeLessThanOrEqual(Math.ceil(Math.log2(16)) + 2);
    } finally { meter.restore(); }
  });

  it("同片中有一条无关的大 run，重驱读量不受影响", async () => {
    const writer = new ShardedTranscriptStore(convDir);
    await writer.appendCommittedRunRecord("big", committed(0, "small"), source(0));
    await writer.appendCommittedRunRecord("big", committed(1, "x".repeat(2_000_000)), source(1));
    await writer.appendCommittedRunRecord("big", committed(2, "tail"), source(2));
    const reopened = new ShardedTranscriptStore(convDir);
    await reopened.init("big");
    const read = vi.spyOn(fs, "open");
    try {
      await expect(reopened.appendCommittedRunRecord("big", committed(0, "small"), source(0))).resolves.toMatchObject({ appended: false });
      expect(read.mock.calls.filter(([file]) => String(file).endsWith(".jsonl"))).toHaveLength(1);
    } finally { read.mockRestore(); }
  });

  it("已撤可见的目标零文件读取即判退役；可见片中的位置字节被改判损坏", async () => {
    await history("rt", 6);
    const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1, now: () => Date.now() + 365 * 86_400_000 });
    await writer.retainShards("rt", new Date(Date.now() + 30 * 86_400_000).toISOString());
    const view = (await writer.readView("rt"))!;
    expect(view.fromSeq).toBeGreaterThan(1);
    const meter = meterFs();
    try {
      await expect(writer.appendCommittedRunRecord("rt", committed(0), source(0))).resolves.toMatchObject({ appended: false, evidence: "retired" });
      expect(Object.keys(meter.counts).filter((key) => key.includes("shard") || key.includes("pos"))).toEqual([]);
    } finally { meter.restore(); }
    const live = path.join(dirOf("rt"), `${String(view.fromSeq).padStart(6, "0")}.jsonl`);
    const text = await fs.readFile(live, "utf-8");
    await fs.writeFile(live, text.replace("run-", "RUN-"));
    await expect(writer.appendCommittedRunRecord("rt", committed(view.fromRunIndex), source(view.fromRunIndex))).rejects.toBeInstanceOf(TranscriptDirectoryDamagedError);
  });
});

// ─── 工作量与历史规模无关 ───

describe("工作量计量（8 / 32 / 128 片）", () => {
  it("打开、新提交、重驱最近一条的计数与历史规模无关；更早一条只按对数增长", async () => {
    const rows: Array<{ n: number; open: Record<string, number>; commit: Record<string, number>; last: Record<string, number>; early: Record<string, number> }> = [];
    for (const n of [8, 32, 128]) {
      const id = `scale-${n}`;
      await history(id, n);
      const cold = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
      let meter = meterFs();
      await cold.init(id);
      const open = { ...meter.counts }; meter.restore();
      meter = meterFs();
      await cold.appendCommittedRunRecord(id, committed(n), source(n));
      const commit = { ...meter.counts }; meter.restore();
      meter = meterFs();
      await cold.appendCommittedRunRecord(id, committed(n), source(n));
      const last = { ...meter.counts }; meter.restore();
      meter = meterFs();
      await cold.appendCommittedRunRecord(id, committed(1), source(1));
      const early = { ...meter.counts }; meter.restore();
      rows.push({ n, open, commit, last, early });
    }
    for (const row of rows) {
      expect(row.open).toEqual(rows[0]!.open);
      expect(row.commit).toEqual(rows[0]!.commit);
      expect(row.last).toEqual(rows[0]!.last);
      expect(row.open.readdir ?? 0).toBe(0);
      expect(row.commit["readFile:shard"] ?? 0).toBe(0);
      expect(row.commit["open:shard:r"] ?? 0).toBe(0);
      expect(row.early["open:pos:r"]).toBeLessThanOrEqual(Math.ceil(Math.log2(row.n)) + 2);
      expect(row.early["open:shard:r"]).toBe(1);
    }
  }, 60_000);
});

// ─── retention ───

describe("retention：前缀撤可见、物理删除可续做", () => {
  it("撤可见到第一个未过期片为止；永不删活跃片；物理删除遇占用停下、下次续做", async () => {
    let now = Date.UTC(2026, 0, 1);
    const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1, now: () => now });
    for (let i = 0; i < 6; i++) {
      now += 86_400_000;
      await writer.appendCommittedRunRecord("ret", committed(i), source(i));
    }
    // 后继创建时刻 < cutoff 的片：1、2、3（后继 2、3、4 分别创建于第 2、3、4 天）
    const cutoff = new Date(Date.UTC(2026, 0, 5) + 1).toISOString();
    const unlink = fs.unlink.bind(fs);
    const busy = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (path.basename(String(file)) === "000002.jsonl") throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return unlink(file);
    });
    const first = await writer.retainShards("ret", cutoff);
    busy.mockRestore();
    expect(first.retired).toBe(3);
    expect(first.deleted).toBe(1);
    expect(first.warnings).toHaveLength(1);
    expect((await writer.readView("ret"))!.fromSeq).toBe(4);
    expect(await collect(writer, "ret")).toEqual([3, 4, 5].reverse().map((runIndex) => ({ runIndex, shardId: String(runIndex + 1).padStart(6, "0") })));
    const second = await writer.retainShards("ret", cutoff);
    expect(second).toMatchObject({ retired: 0, deleted: 2 });
    const files = (await fs.readdir(dirOf("ret"))).filter((file) => file.endsWith(".jsonl")).sort();
    expect(files).toEqual(["000004.jsonl", "000005.jsonl", "000006.jsonl"]);
  });

  it("时钟回拨：遇到第一个未过期片即停，不越过删除", async () => {
    const times = [1, 2, 9, 3, 4].map((day) => Date.UTC(2026, 0, day));
    let index = 0;
    const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1, now: () => times[Math.min(index, times.length - 1)]! });
    for (let i = 0; i < 5; i++) { index = i; await writer.appendCommittedRunRecord("skew", committed(i), source(i)); }
    const report = await writer.retainShards("skew", new Date(Date.UTC(2026, 0, 5)).toISOString());
    // 片 1 的后继（第 2 天）过期；片 2 的后继（第 9 天）未过期 → 停，片 3、4 虽后继过期也不越过
    expect(report.retired).toBe(1);
    expect((await writer.readView("skew"))!.fromSeq).toBe(2);
  });

  it("只有一个分片时不删", async () => {
    const writer = new ShardedTranscriptStore(convDir, { now: () => Date.UTC(2020, 0, 1) });
    await writer.appendRunRecord("one", runInput("a"));
    expect(await writer.retainShards("one", new Date().toISOString())).toMatchObject({ retired: 0, deleted: 0 });
  });
});

// ─── 读视图与损坏分类 ───

describe("只读视图与损坏分类", () => {
  it("根的两半同时无效：只读者有界重读后报可重试，写者失败关闭", async () => {
    await store.appendRunRecord("rv", runInput("a"));
    await fs.writeFile(fileOf("rv", "root.bin"), Buffer.alloc(1536, 0x11));
    await expect(store.readView("rv")).rejects.toBeInstanceOf(TranscriptViewBusyError);
    await expect(new ShardedTranscriptStore(convDir).appendRunRecord("rv", runInput("b"))).rejects.toBeInstanceOf(TranscriptDirectoryDamagedError);
  });

  it("根读取 EIO 照常抛出，不当作缺失或重建", async () => {
    await store.appendRunRecord("io", runInput("a"));
    const open = fs.open.bind(fs);
    const failing = vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
      if (path.basename(String(file)) === "root.bin") throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      return open(file, flags, mode);
    }) as typeof fs.open);
    try {
      await expect(new ShardedTranscriptStore(convDir).appendRunRecord("io", runInput("b"))).rejects.toThrow("injected EIO");
    } finally { failing.mockRestore(); }
    expect(await countRuns(store, "io")).toBe(1);
  });

  it("已有分片却既无根也无 v1 索引 → 失败关闭，不覆盖已有资料", async () => {
    await fs.mkdir(dirOf("orphan"), { recursive: true });
    await fs.writeFile(fileOf("orphan", "000001.jsonl"), "{}\n");
    await expect(store.appendRunRecord("orphan", runInput("a"))).rejects.toBeInstanceOf(TranscriptDirectoryDamagedError);
    expect(await fs.readFile(fileOf("orphan", "000001.jsonl"), "utf-8")).toBe("{}\n");
  });
});

// ─── 公共原语反例 ───

/** 匹配的文件每次打开后的第一次写入只写出一半（模拟成功返回的短写） */
function shortWrites(match: (base: string, flags?: string) => boolean) {
  const open = fs.open.bind(fs);
  const state = { injected: 0 };
  const spy = vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
    const handle = await open(file, flags, mode);
    if (match(path.basename(String(file)), flags)) {
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

/** root.bin 的 "r+" 打开之后 fsync 一律失败（写入已进入页缓存、耐久未确认） */
function failRootSync() {
  const open = fs.open.bind(fs);
  const state = { attempts: 0 };
  const spy = vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
    const handle = await open(file, flags, mode);
    if (path.basename(String(file)) === "root.bin" && flags === "r+") {
      (handle as unknown as { sync: () => Promise<void> }).sync = async () => {
        state.attempts++;
        throw Object.assign(new Error("injected root sync failure"), { code: "EIO" });
      };
    }
    return handle;
  }) as typeof fs.open);
  return { state, restore: () => spy.mockRestore() };
}

/** 用严格读取把每个可见片读一遍：已发布范围内任何坏行都会报损坏 */
async function readAllStrict(reader: ShardedTranscriptStore, id: string) {
  const view = (await reader.readView(id))!;
  for (let seq = view.fromSeq; seq <= view.activeSeq; seq++) await reader.readShardLines(id, { seq, view });
}

describe("公共原语反例：短写、待确认发布、旧游标、已发布范围截断", () => {
  it("正文、位置项、根的写入都只写出一半：循环写满，确认的记录完整", async () => {
    await store.appendRunRecord("sw", runInput("a"));
    const short = shortWrites((base, flags) => flags === "r+" && (base.endsWith(".jsonl") || base.endsWith(".pos") || base === "root.bin"));
    try {
      await store.appendRunRecord("sw", runInput("b"));
      await store.appendClear("sw");
      await store.appendRunRecord("sw", runInput("c"));
    } finally { short.restore(); }
    expect(short.state.injected).toBeGreaterThanOrEqual(7);
    const reopened = new ShardedTranscriptStore(convDir);
    await reopened.prepareRead("sw");
    expect((await collect(reopened, "sw")).map((r) => r.runIndex)).toEqual([2]);
    expect(await countRuns(reopened, "sw")).toBe(1);
    await readAllStrict(reopened, "sw");
  });

  it("恢复重写字节时也是短写：同样写满后才发布", async () => {
    await store.appendCommittedRunRecord("sr", committed(0), source(0));
    const failing = failRootWrites(1);
    const short = shortWrites((base, flags) => flags === "r+" && base.endsWith(".jsonl"));
    try {
      await expect(store.appendCommittedRunRecord("sr", committed(1), source(1))).resolves.toMatchObject({ runIndex: 1, appended: true });
    } finally { short.restore(); failing.mockRestore(); }
    // 正文写入一次、恢复重写一次，各自都被截成一半
    expect(short.state.injected).toBe(2);
    const reopened = new ShardedTranscriptStore(convDir);
    await expect(reopened.appendCommittedRunRecord("sr", committed(1), source(1))).resolves.toMatchObject({ appended: false });
    await readAllStrict(reopened, "sr");
  });

  it("根 fsync 持续失败：本次报结果未知，之后的恢复同样不能确认；故障消除后恢复确认、不重复追加", async () => {
    await store.appendRunRecord("fs", runInput("a"));
    const input = runInput("b");
    const failing = failRootSync();
    try {
      await expect(store.appendRunRecord("fs", input, { expectedRunIndex: 1 })).rejects.toBeInstanceOf(TranscriptOutcomeUnknownError);
      const before = failing.state.attempts;
      await expect(store.prepareRead("fs")).rejects.toThrow("injected root sync failure");
      expect(failing.state.attempts).toBeGreaterThan(before);
    } finally { failing.restore(); }
    await store.prepareRead("fs");
    await expect(store.appendRunRecord("fs", input, { expectedRunIndex: 1 })).resolves.toMatchObject({ runIndex: 1, appended: false });
    expect((await collect(new ShardedTranscriptStore(convDir), "fs")).map((r) => r.runIndex)).toEqual([1, 0]);
  });

  it("retention 撤可见的发布 fsync 失败：读者已看到撤可见，之后的写入不复活旧前缀", async () => {
    const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1, now: () => Date.UTC(2020, 0, 1) });
    for (let i = 0; i < 3; i++) await writer.appendRunRecord("rr", runInput(String(i)));
    const failing = failRootSync();
    try {
      await expect(writer.retainShards("rr", "2026-01-01T00:00:00.000Z")).rejects.toThrow("injected root sync failure");
    } finally { failing.restore(); }
    const observed = (await writer.readView("rr"))!.fromSeq;
    expect(observed).toBeGreaterThan(1);
    await writer.appendRunRecord("rr", runInput("new"));
    expect((await writer.readView("rr"))!.fromSeq).toBe(observed);
    expect((await collect(writer, "rr")).every((r) => Number.parseInt(r.shardId, 10) >= observed)).toBe(true);
  });

  it("打开时盘上的根由更早的实例发布：重驱确认已投影之前先把根重写并 fsync，之后不再重复", async () => {
    await history("cf", 4);
    const reopened = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
    await reopened.prepareRead("cf");
    const meter = meterFs();
    try {
      await expect(reopened.appendCommittedRunRecord("cf", committed(3), source(3))).resolves.toMatchObject({ appended: false });
      expect(meter.counts["open:root:r+"]).toBe(1);
      await expect(reopened.appendCommittedRunRecord("cf", committed(1), source(1))).resolves.toMatchObject({ appended: false });
      expect(meter.counts["open:root:r+"]).toBe(1);
    } finally { meter.restore(); }
  });

  it("清空之前取得的游标读不穿清空点：跨片、同片、冷读", async () => {
    const crossing = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
    await crossing.appendRunRecord("oc", runInput("a"));
    const old = await crossing.appendRunRecord("oc", runInput("b"));
    await crossing.appendClear("oc");
    expect(await collect(crossing, "oc", { shardId: old.shardId, runIndex: old.runIndex })).toEqual([]);
    expect(await collect(new ShardedTranscriptStore(convDir), "oc", { shardId: old.shardId, runIndex: old.runIndex })).toEqual([]);

    await store.appendRunRecord("os", runInput("a"));
    const same = await store.appendRunRecord("os", runInput("b"));
    await store.appendClear("os");
    await store.appendRunRecord("os", runInput("c"));
    expect(await collect(store, "os", { shardId: same.shardId, runIndex: same.runIndex })).toEqual([]);
    expect((await collect(store, "os")).map((r) => r.runIndex)).toEqual([2]);
  });

  it("已发布范围被截断：活跃片截在行边界或行中、封存片截在行边界，都报损坏而不是空历史", async () => {
    const headerOnly = async (file: string) => {
      const text = await fs.readFile(file, "utf-8");
      await fs.writeFile(file, text.slice(0, text.indexOf("\n") + 1));
    };
    await store.appendRunRecord("ta", runInput("a"));
    await headerOnly(fileOf("ta", "000001.jsonl"));
    await expect(collect(store, "ta")).rejects.toBeInstanceOf(TranscriptDirectoryDamagedError);

    await store.appendRunRecord("tm", runInput("a"));
    const mid = fileOf("tm", "000001.jsonl");
    await fs.truncate(mid, (await fs.stat(mid)).size - 10);
    await expect(collect(store, "tm")).rejects.toBeInstanceOf(TranscriptDirectoryDamagedError);

    // 三片：活跃片的前一片按根里的封片长度核对，更早的片按后继片位置文件头里的封片长度核对
    for (const victim of ["000001.jsonl", "000002.jsonl"]) {
      const id = `ts-${victim.slice(5, 6)}`;
      const writer = new ShardedTranscriptStore(convDir, { maxShardBytes: 1 });
      for (let i = 0; i < 3; i++) await writer.appendRunRecord(id, runInput(String(i)));
      await headerOnly(fileOf(id, victim));
      await expect(collect(writer, id)).rejects.toBeInstanceOf(TranscriptDirectoryDamagedError);
    }
  });

  it("严格区内的坏行报损坏；旧测试格式转换来的坏行照旧跳过", async () => {
    await store.appendRunRecord("bl", runInput("a"));
    const shard = fileOf("bl", "000001.jsonl");
    await fs.writeFile(shard, (await fs.readFile(shard, "utf-8")).replace('"messages"', '"messagez"'));
    await expect(collect(store, "bl")).rejects.toBeInstanceOf(TranscriptDirectoryDamagedError);

    // 旧格式：封存片尾部有撕裂行（转换后容忍），活跃片完好；转换后追加的字节进入严格区
    await fs.mkdir(dirOf("lb"), { recursive: true });
    const legacyLine = (runIndex: number) => JSON.stringify({ type: "run", runIndex, timestamp: "2026-01-01T00:00:00.000Z", messages: [] });
    const legacyHeader = (seq: number) => JSON.stringify({ type: "header", version: 1, conversationId: "lb", shardId: `00000${seq}`, createdAt: "2026-01-01T00:00:00.000Z" });
    await fs.writeFile(fileOf("lb", "000001.jsonl"), `${legacyHeader(1)}\n${legacyLine(0)}\n{"type":"run","ru`);
    await fs.writeFile(fileOf("lb", "000002.jsonl"), `${legacyHeader(2)}\n${legacyLine(1)}\n`);
    await fs.writeFile(fileOf("lb", "index.json"), JSON.stringify({
      version: 1, conversationId: "lb", activeShardId: "000002",
      shards: [1, 2].map((seq) => ({ id: `00000${seq}`, file: `00000${seq}.jsonl`, createdAt: "2026-01-01T00:00:00.000Z", isActive: seq === 2 })),
    }));
    await store.appendRunRecord("lb", runInput("new"));
    expect((await collect(store, "lb")).map((r) => r.runIndex)).toEqual([2, 1, 0]);
    const active = fileOf("lb", "000002.jsonl");
    await fs.writeFile(active, (await fs.readFile(active, "utf-8")).replace(/"messages":\[\{/u, '"messagez":[{'));
    await expect(collect(store, "lb")).rejects.toBeInstanceOf(TranscriptDirectoryDamagedError);
  });
});

// ─── 旧测试格式一次性转换 ───

describe("旧测试格式（v1 index.json）一次性转换", () => {
  async function writeLegacy(id: string, shards: Array<{ seq: number; lines: object[]; createdAt?: string; raw?: string }>, extra?: { lastClearAt?: string; activeSeq?: number }) {
    await fs.mkdir(dirOf(id), { recursive: true });
    for (const shard of shards) {
      const body = shard.lines.map((line) => JSON.stringify(line)).join("\n") + (shard.lines.length ? "\n" : "") + (shard.raw ?? "");
      await fs.writeFile(fileOf(id, `${String(shard.seq).padStart(6, "0")}.jsonl`), body);
    }
    const ids = shards.map((s) => String(s.seq).padStart(6, "0"));
    const active = String(extra?.activeSeq ?? shards.at(-1)!.seq).padStart(6, "0");
    await fs.writeFile(fileOf(id, "index.json"), JSON.stringify({
      version: 1, conversationId: id, activeShardId: active,
      ...(extra?.lastClearAt ? { lastClearAt: extra.lastClearAt } : {}),
      shards: ids.map((sid, i) => ({ id: sid, file: `${sid}.jsonl`, createdAt: shards[i]!.createdAt ?? "2026-01-01T00:00:00.000Z", isActive: sid === active })),
    }));
  }
  const header = (seq: number) => ({ type: "header", version: 1, conversationId: "x", shardId: String(seq).padStart(6, "0"), createdAt: "2026-01-01T00:00:00.000Z" });
  const legacyRun = (runIndex: number, runId?: string) => ({ type: "run", runIndex, timestamp: "2026-01-01T00:00:00.000Z", messages: [{ role: "user", content: [{ type: "text", text: `L${runIndex}` }] }], ...(runId ? { runId } : {}) });

  it("转换后可读、可追加、可重驱；clear 边界与计数正确；原件保留", async () => {
    await writeLegacy("lg", [
      { seq: 1, lines: [header(1), legacyRun(0, "r-0"), legacyRun(1, "r-1")] },
      { seq: 2, lines: [header(2), { type: "clear", timestamp: "2026-01-02T00:00:00.000Z" }, legacyRun(2, "r-2")] },
    ], { lastClearAt: "2026-01-02T00:00:00.000Z" });
    expect((await collect(store, "lg")).map((r) => r.runIndex)).toEqual([2]);
    await store.prepareRead("lg");
    expect(await countRuns(store, "lg")).toBe(1);
    const legacy = legacyRun(1, "r-1") as unknown as TranscriptRunRecord;
    await expect(store.appendCommittedRunRecord("lg", legacy, source(1))).resolves.toMatchObject({ runIndex: 1, appended: false });
    await expect(store.appendCommittedRunRecord("lg", committed(3), source(3))).resolves.toMatchObject({ runIndex: 3, appended: true });
    expect(await fs.readFile(fileOf("lg", "index.json"), "utf-8")).toContain('"version":1');
  });

  it("活跃片尾部有撕裂行：转换后换到新片继续追加，原片保持原样", async () => {
    await writeLegacy("lt2", [{ seq: 1, lines: [header(1), legacyRun(0)], raw: '{"type":"run","run' }]);
    const before = await fs.readFile(fileOf("lt2", "000001.jsonl"), "utf-8");
    await expect(store.appendRunRecord("lt2", runInput("next"))).resolves.toMatchObject({ runIndex: 1, shardId: "000002" });
    expect(await fs.readFile(fileOf("lt2", "000001.jsonl"), "utf-8")).toBe(before);
    expect((await collect(store, "lt2")).map((r) => r.runIndex)).toEqual([1, 0]);
  });

  it("现存片之间缺片：失败关闭（不推断、不隐藏）", async () => {
    await writeLegacy("lh", [
      { seq: 1, lines: [header(1), legacyRun(0)] },
      { seq: 2, lines: [header(2), legacyRun(1)] },
      { seq: 3, lines: [header(3), legacyRun(2)] },
    ]);
    await fs.unlink(fileOf("lh", "000002.jsonl"));
    await expect(store.appendRunRecord("lh", runInput("x"))).rejects.toBeInstanceOf(TranscriptDirectoryDamagedError);
  });
});

// ─── 编码边界 ───

describe("位置项编码边界", () => {
  it("480 个需转义字符的 runId、2^53−1 的序号与偏移都能定长编码且可逆", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const runId = "\u0001\"\\".repeat(160);
    const entry = {
      runIndex: max, seq: 1, offset: max, length: max, lineSha256: sha256("line"),
      source: { kind: "owner" as const, runIdSha256: sha256(runId), assignmentSha256: sha256("a"), digestSha256: sha256("d"), commitRevision: max },
      epoch: Buffer.alloc(16, 7), forPub: max, newShard: true,
    };
    const buf = encodePositionEntry(entry);
    expect(buf.length).toBe(POSITION_RECORD_BYTES);
    const decoded = decodePositionEntry(buf, 1)!;
    expect(decoded.runIndex).toBe(max);
    expect(decoded.source.runIdSha256.equals(sha256(runId))).toBe(true);
    expect(decoded.newShard).toBe(true);
    const torn = Buffer.from(buf); torn.fill(0, 128);
    expect(decodePositionEntry(torn, 1)).toBeUndefined();
    expect(() => encodePositionEntry({ ...entry, runIndex: max + 1 })).toThrow(RangeError);
    expect(entry.source.assignmentSha256.equals(ZERO_SHA256)).toBe(false);
  });
});

// ─── 并发 ───

describe("并发", () => {
  it("同对话并发 append 串行化，runIndex 不重号", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.appendRunRecord("cc", runInput(`p${i}`))));
    expect(results.map((r) => r.runIndex).sort((a, b) => a - b)).toEqual([...Array(10).keys()]);
  });

  it("跨对话并发互不阻塞且各自独立编号", async () => {
    const [a, b] = await Promise.all([store.appendRunRecord("x1", runInput("a")), store.appendRunRecord("x2", runInput("b"))]);
    expect(a.runIndex).toBe(0);
    expect(b.runIndex).toBe(0);
  });
});
