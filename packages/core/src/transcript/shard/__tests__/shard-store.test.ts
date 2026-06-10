/**
 * 分片化 transcript store 契约测试。
 *
 * 覆盖：append-only 写入与 runIndex 单调性、完整协议消息往返保真、
 * rollover（索引先行 / 文件惰性创建）、清空事件（读边界 + 元数据投影）、
 * 倒读原语（跨分片 / 游标分页）、四形态崩溃恢复、并发串行化。
 */

import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { Message } from "../../../types/messages.js";
import { ShardedTranscriptStore } from "../store.js";
import { countRuns, readRunsReverse } from "../reader.js";
import type { RunRecordInput, TranscriptIndex } from "../types.js";

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

async function collect(
  store: ShardedTranscriptStore,
  id: string,
  before?: { shardId: string; runIndex: number },
) {
  const out: Array<{ runIndex: number; shardId: string }> = [];
  for await (const { record, shardId } of readRunsReverse(store, id, { before })) {
    out.push({ runIndex: record.runIndex, shardId });
  }
  return out;
}

let convDir: string;
let store: ShardedTranscriptStore;

beforeEach(async () => {
  const tmp = await createTempDir("shard-store");
  convDir = path.join(tmp, "conversations");
  store = new ShardedTranscriptStore(convDir, { platform: "linux" });
});

// ─── 基础写入 ───

describe("写入与 runIndex", () => {
  it("init 幂等；exists 反映索引存在性", async () => {
    expect(await store.exists("c1")).toBe(false);
    await store.init("c1");
    await store.init("c1");
    expect(await store.exists("c1")).toBe(true);
    const index = await store.readIndex("c1");
    expect(index!.shards).toHaveLength(1);
    expect(index!.activeShardId).toBe("000001");
  });

  it("append 自动初始化；runIndex 由 store 分配、单调递增", async () => {
    const r0 = await store.appendRunRecord("c2", runInput("一"));
    const r1 = await store.appendRunRecord("c2", runInput("二"));
    expect(r0).toEqual({ runIndex: 0, shardId: "000001" });
    expect(r1.runIndex).toBe(1);
  });

  it("完整协议消息序列往返保真（含工具轮）", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "读文件" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { p: 1 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", content: "body" }],
      },
      { role: "assistant", content: [{ type: "text", text: "读完了" }] },
    ];
    clock += 1000;
    await store.appendRunRecord("c3", {
      timestamp: new Date(clock).toISOString(),
      messages,
      usage: { inputTokens: 5, outputTokens: 7 },
      source: "interactive",
    });

    const got = await collect(store, "c3");
    expect(got).toHaveLength(1);
    const index = await store.readIndex("c3");
    const lines = await store.readShardLines("c3", index!.shards[0]!);
    const run = lines.find((l) => l.type === "run")!;
    expect(run.type === "run" && run.messages).toEqual(messages);
    expect(run.type === "run" && run.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
    });
  });

  it("重开 store 实例：从分片尾行推导 nextRunIndex 继续单调", async () => {
    await store.appendRunRecord("c4", runInput("一"));
    await store.appendRunRecord("c4", runInput("二"));

    const reopened = new ShardedTranscriptStore(convDir, { platform: "linux" });
    const r = await reopened.appendRunRecord("c4", runInput("三"));
    expect(r.runIndex).toBe(2);
  });
});

// ─── rollover ───

describe("rollover（索引先行、文件惰性创建）", () => {
  it("超过字节上限后新 run 进新分片，runIndex 跨片连续", async () => {
    const small = new ShardedTranscriptStore(convDir, {
      platform: "linux",
      maxShardBytes: 200, // 一条记录即超限
    });
    await small.appendRunRecord("r1", runInput("第一条"));
    const second = await small.appendRunRecord("r1", runInput("第二条"));
    expect(second).toEqual({ runIndex: 1, shardId: "000002" });

    const index = await small.readIndex("r1");
    expect(index!.shards.map((s) => [s.id, s.isActive])).toEqual([
      ["000001", false],
      ["000002", true],
    ]);
    // 倒读跨分片连续
    expect(await collect(small, "r1")).toEqual([
      { runIndex: 1, shardId: "000002" },
      { runIndex: 0, shardId: "000001" },
    ]);
  });

  it("索引记录被剔除后 rollover 不撞号（序号取现存最大 id + 1）", async () => {
    const small = new ShardedTranscriptStore(convDir, {
      platform: "linux",
      maxShardBytes: 200,
    });
    // 三次追加 → 三个分片（每条记录都超 200 字节上限）
    for (const t of ["一", "二", "三"]) {
      await small.appendRunRecord("r3", runInput(t));
    }
    // 模拟清理时代的死记录剔除：从索引移除最老分片条目（文件去留无关紧要）
    const indexFile = path.join(convDir, "r3", "transcript", "index.json");
    const index = JSON.parse(
      await fs.readFile(indexFile, "utf-8"),
    ) as TranscriptIndex;
    index.shards = index.shards.filter((s) => s.id !== "000001");
    await fs.writeFile(indexFile, JSON.stringify(index), "utf-8");

    // 重开并触发 rollover：新分片必须是 000004，不得与现存 000003 撞号
    const reopened = new ShardedTranscriptStore(convDir, {
      platform: "linux",
      maxShardBytes: 200,
    });
    const r = await reopened.appendRunRecord("r3", runInput("四"));
    expect(r.shardId).toBe("000004");
  });

  it("崩溃形态：索引已指新片、文件尚未创建 → 读容错为空分片，append 补建", async () => {
    const small = new ShardedTranscriptStore(convDir, {
      platform: "linux",
      maxShardBytes: 200,
    });
    await small.appendRunRecord("r2", runInput("旧"));
    await small.appendRunRecord("r2", runInput("触发 rollover"));
    // 模拟"rollover 后、append 前崩溃"：删掉新片文件，索引仍指向它
    await fs.unlink(path.join(convDir, "r2", "transcript", "000002.jsonl"));

    const reopened = new ShardedTranscriptStore(convDir, {
      platform: "linux",
      maxShardBytes: 200,
    });
    // 读容错：新片视为空，倒读只见旧片
    expect(await collect(reopened, "r2")).toEqual([
      { runIndex: 0, shardId: "000001" },
    ]);
    // append 补建文件（header + 记录），runIndex 从旧片尾继续
    const r = await reopened.appendRunRecord("r2", runInput("恢复"));
    expect(r).toEqual({ runIndex: 1, shardId: "000002" });
  });
});

// ─── 崩溃截断 ───

describe("崩溃形态：append 尾行截断", () => {
  it("坏尾行被读路径丢弃；重开实例推导 nextRunIndex 跳过坏行", async () => {
    await store.appendRunRecord("t1", runInput("好的一条"));
    const file = path.join(convDir, "t1", "transcript", "000001.jsonl");
    await fs.appendFile(file, '{"type":"run","runIndex":1,"mess', "utf-8");

    const reopened = new ShardedTranscriptStore(convDir, { platform: "linux" });
    expect(await collect(reopened, "t1")).toEqual([
      { runIndex: 0, shardId: "000001" },
    ]);
    const r = await reopened.appendRunRecord("t1", runInput("继续"));
    expect(r.runIndex).toBe(1); // 坏行不占号
  });
});

// ─── 清空事件 ───

describe("清空事件（读边界 + 元数据投影）", () => {
  it("clear 后倒读与计数为空；其前数据物理仍在；继续追加只见新内容", async () => {
    await store.appendRunRecord("e1", runInput("清空前"));
    await store.appendClear("e1");

    expect(await collect(store, "e1")).toEqual([]);
    expect(await countRuns(store, "e1")).toBe(0);

    // 物理仍在（append-only：清空是事件，不是销毁）
    const index = await store.readIndex("e1");
    const lines = await store.readShardLines("e1", index!.shards[0]!);
    expect(lines.filter((l) => l.type === "run")).toHaveLength(1);
    expect(lines.filter((l) => l.type === "clear")).toHaveLength(1);
    expect(index!.lastClearAt).toBeDefined();

    // 清空后继续对话
    const r = await store.appendRunRecord("e1", runInput("清空后"));
    expect(r.runIndex).toBe(1); // runIndex 连续——清空不重置事实流编号
    expect(await collect(store, "e1")).toEqual([
      { runIndex: 1, shardId: "000001" },
    ]);
    expect(await countRuns(store, "e1")).toBe(1);
  });

  it("崩溃形态：ClearRecord 已落分片、lastClearAt 未更新 → 打开时补写", async () => {
    await store.appendRunRecord("e2", runInput("x"));
    await store.appendClear("e2");

    // 模拟两步写之间崩溃：索引的 lastClearAt 回退为缺失
    const indexFile = path.join(convDir, "e2", "transcript", "index.json");
    const index = JSON.parse(await fs.readFile(indexFile, "utf-8")) as TranscriptIndex;
    delete index.lastClearAt;
    await fs.writeFile(indexFile, JSON.stringify(index), "utf-8");

    // 重开实例做任意写入触达 → 打开时校核补写（修复先于新写入）
    const reopened = new ShardedTranscriptStore(convDir, { platform: "linux" });
    await reopened.init("e2");
    const repaired = await reopened.readIndex("e2");
    expect(repaired!.lastClearAt).toBeDefined();
  });
});

// ─── 倒读分页 ───

describe("倒读原语：游标分页", () => {
  it("before 游标从该位置之前继续（跨分片）", async () => {
    const small = new ShardedTranscriptStore(convDir, {
      platform: "linux",
      maxShardBytes: 200,
    });
    for (const t of ["零", "一", "二", "三"]) {
      await small.appendRunRecord("p1", runInput(t));
    }
    const all = await collect(small, "p1");
    expect(all.map((r) => r.runIndex)).toEqual([3, 2, 1, 0]);

    // 第一页取 2 条后，用最早一条作游标续读
    const cursor = all[1]!; // runIndex 2
    const nextPage = await collect(small, "p1", {
      shardId: cursor.shardId,
      runIndex: cursor.runIndex,
    });
    expect(nextPage.map((r) => r.runIndex)).toEqual([1, 0]);
  });

  it("游标所指分片已不存在 → 产出为空（更早内容已被清理）", async () => {
    await store.appendRunRecord("p2", runInput("x"));
    expect(
      await collect(store, "p2", { shardId: "999999", runIndex: 5 }),
    ).toEqual([]);
  });
});

// ─── 并发 ───

describe("并发", () => {
  it("同对话并发 append 串行化，runIndex 不重号", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.appendRunRecord("cc1", runInput(`并发${i}`)),
      ),
    );
    const indexes = results.map((r) => r.runIndex).sort((a, b) => a - b);
    expect(indexes).toEqual([0, 1, 2, 3, 4]);
  });

  it("跨对话并发互不阻塞且各自独立编号", async () => {
    const [a, b] = await Promise.all([
      store.appendRunRecord("cc2", runInput("a")),
      store.appendRunRecord("cc3", runInput("b")),
    ]);
    expect(a.runIndex).toBe(0);
    expect(b.runIndex).toBe(0);
  });
});
