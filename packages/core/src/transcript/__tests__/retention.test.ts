/**
 * runRetentionSweep 单元测试 —— 物理层清理的验收锚。
 *
 * fixture 直接手写物理文件（index.json / 分片 / 快照）：清理只认文件物理量，
 * 操纵物理文件正是其语义粒度；时钟经 now 注入锚定，createdAt 全为显式常量。
 *
 * 验收覆盖：超期非活跃片删 / 活跃片永存 / 单片不删 / 全程零索引写；
 * 快照单一判据（超期 && 非(最新 && 未退役)）、退役不提前删；
 * 损坏单点仅 warning 不拖垮整轮；幂等。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RETENTION_DAYS, runRetentionSweep } from "../retention.js";

const NOW = new Date("2026-06-11T00:00:00.000Z");
/** 窗内时刻（1 天前） */
const FRESH = "2026-06-10T00:00:00.000Z";
/** 超期时刻（40 天前，远超默认 27 天窗） */
const STALE = "2026-05-02T00:00:00.000Z";
/** 更早的超期时刻 */
const STALE_OLDER = "2026-04-20T00:00:00.000Z";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retention-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ─── fixture 构造 ───

interface ShardSpec {
  id: string;
  createdAt: string;
  isActive: boolean;
}

async function writeConversation(
  root: string,
  convId: string,
  opts: {
    shards?: ShardSpec[];
    lastClearAt?: string;
    snapshots?: { createdAt: string }[];
    rawIndex?: string;
  },
): Promise<string> {
  const convDir = path.join(root, convId);
  if (opts.shards || opts.rawIndex !== undefined) {
    const tDir = path.join(convDir, "transcript");
    await fs.mkdir(tDir, { recursive: true });
    if (opts.rawIndex !== undefined) {
      await fs.writeFile(path.join(tDir, "index.json"), opts.rawIndex);
    } else {
      const shards = opts.shards!;
      const index = {
        version: 1,
        conversationId: convId,
        activeShardId: shards.find((s) => s.isActive)?.id ?? shards[0]!.id,
        ...(opts.lastClearAt ? { lastClearAt: opts.lastClearAt } : {}),
        shards: shards.map((s) => ({
          id: s.id,
          file: `${s.id}.jsonl`,
          createdAt: s.createdAt,
          isActive: s.isActive,
        })),
      };
      await fs.writeFile(
        path.join(tDir, "index.json"),
        JSON.stringify(index, null, 2),
      );
      for (const s of shards) {
        await fs.writeFile(
          path.join(tDir, `${s.id}.jsonl`),
          `{"type":"header","version":1,"conversationId":"${convId}","shardId":"${s.id}","createdAt":"${s.createdAt}"}\n`,
        );
      }
    }
  }
  if (opts.snapshots) {
    const sDir = path.join(convDir, "snapshots");
    await fs.mkdir(sDir, { recursive: true });
    for (const snap of opts.snapshots) {
      await fs.writeFile(
        path.join(sDir, `${snap.createdAt.replace(/[:.]/g, "-")}.json`),
        JSON.stringify({
          version: 1,
          conversationId: convId,
          createdAt: snap.createdAt,
          coveredThroughRunIndex: 0,
          structuredSummary: { facts: "f", state: "s", active: "a" },
          tokensBefore: 100,
          tokensAfter: 10,
        }),
      );
    }
  }
  return convDir;
}

async function listShardFiles(convDir: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(convDir, "transcript"));
  return entries.filter((e) => e.endsWith(".jsonl")).sort();
}

async function listSnapshotFiles(convDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(convDir, "snapshots"))).sort();
  } catch {
    return [];
  }
}

// ─── 分片清理 ───

describe("runRetentionSweep — 分片三铁律", () => {
  it("封笔已出窗的非活跃片删除，封笔在窗内的与活跃片保留", async () => {
    // 片的封笔时刻 = 后继片 createdAt：000001 封笔于 STALE（超期）→ 删；
    // 000002 封笔于 FRESH（窗内）→ 留
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      shards: [
        { id: "000001", createdAt: STALE_OLDER, isActive: false },
        { id: "000002", createdAt: STALE, isActive: false },
        { id: "000003", createdAt: FRESH, isActive: true },
      ],
    });

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    expect(report.shardsDeleted).toBe(1);
    expect(await listShardFiles(convDir)).toEqual([
      "000002.jsonl",
      "000003.jsonl",
    ]);
    expect(report.warnings).toEqual([]);
  });

  it("片龄超期但封笔仍在窗内（昨天才 rollover）→ 不删：保留窗以数据时刻为准", async () => {
    // 40 天前创建、一直写到昨天才滚满——片内含窗内数据，绝不能整片删
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      shards: [
        { id: "000001", createdAt: STALE, isActive: false },
        { id: "000002", createdAt: FRESH, isActive: true },
      ],
    });

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    expect(report.shardsDeleted).toBe(0);
    expect(await listShardFiles(convDir)).toEqual([
      "000001.jsonl",
      "000002.jsonl",
    ]);
  });

  it("活跃片即使超期也永不删", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      shards: [
        { id: "000001", createdAt: STALE, isActive: false },
        { id: "000002", createdAt: STALE, isActive: true },
      ],
    });

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    expect(report.shardsDeleted).toBe(1);
    expect(await listShardFiles(convDir)).toEqual(["000002.jsonl"]);
  });

  it("对话只剩一个分片即使标记异常且超期也不删", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      // 防御异常态：单片但 isActive 标记错乱
      shards: [{ id: "000001", createdAt: STALE, isActive: false }],
    });

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    expect(report.shardsDeleted).toBe(0);
    expect(await listShardFiles(convDir)).toEqual(["000001.jsonl"]);
  });

  it("全程零索引写：sweep 前后 index.json 字节不变（含删除发生时）", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      shards: [
        { id: "000001", createdAt: STALE_OLDER, isActive: false },
        { id: "000002", createdAt: STALE, isActive: true },
      ],
    });
    const indexFile = path.join(convDir, "transcript", "index.json");
    const before = await fs.readFile(indexFile, "utf-8");

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    expect(report.shardsDeleted).toBe(1);
    expect(await fs.readFile(indexFile, "utf-8")).toBe(before);
  });

  it("retentionDays 可配：窗口收紧后原本窗内的片被收走", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      shards: [
        // 封笔时刻 = 后继 createdAt = 1 天前：默认 27 天窗内、0.5 天窗外
        { id: "000001", createdAt: FRESH, isActive: false },
        { id: "000002", createdAt: FRESH, isActive: true },
      ],
    });

    const wide = await runRetentionSweep({ roots: [tmpRoot], now: NOW });
    expect(wide.shardsDeleted).toBe(0);

    const tight = await runRetentionSweep({
      roots: [tmpRoot],
      retentionDays: 0.5,
      now: NOW,
    });
    expect(tight.shardsDeleted).toBe(1);
    expect(await listShardFiles(convDir)).toEqual(["000002.jsonl"]);
  });
});

// ─── 快照清理 ───

describe("runRetentionSweep — 快照单一判据", () => {
  it("超期且被换代的快照删除；最新快照即使超期也保留（未退役 = 在用）", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      shards: [{ id: "000001", createdAt: FRESH, isActive: true }],
      snapshots: [{ createdAt: STALE_OLDER }, { createdAt: STALE }],
    });

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    expect(report.snapshotsDeleted).toBe(1);
    const left = await listSnapshotFiles(convDir);
    expect(left).toHaveLength(1);
    expect(left[0]).toContain("2026-05-02"); // 最新者（STALE）保留
  });

  it("clear 使更早快照退役：超期的末代快照不再受在用豁免、被收走", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      shards: [{ id: "000001", createdAt: FRESH, isActive: true }],
      lastClearAt: FRESH, // clear 晚于全部快照 → 全部退役
      snapshots: [{ createdAt: STALE }],
    });

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    expect(report.snapshotsDeleted).toBe(1);
    expect(await listSnapshotFiles(convDir)).toEqual([]);
  });

  it("退役不提前删：窗内的退役快照保留到自然老化", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      shards: [{ id: "000001", createdAt: FRESH, isActive: true }],
      lastClearAt: NOW.toISOString(), // 刚 clear → 快照已退役
      snapshots: [{ createdAt: FRESH }], // 但还在窗内
    });

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    expect(report.snapshotsDeleted).toBe(0);
    expect(await listSnapshotFiles(convDir)).toHaveLength(1);
  });

  it("索引缺失（从未写入的对话）不阻塞快照清理：lastClearAt 缺省按未退役判", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      snapshots: [{ createdAt: STALE_OLDER }, { createdAt: STALE }],
    });

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    // 被换代的删；最新的虽超期但未退役 → 在用豁免
    expect(report.snapshotsDeleted).toBe(1);
    expect(await listSnapshotFiles(convDir)).toHaveLength(1);
  });

  it("损坏快照文件不动（无 createdAt 判据，宁留勿删）也不参与最新判定", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      snapshots: [{ createdAt: STALE }],
    });
    await fs.writeFile(
      path.join(convDir, "snapshots", "zzz-broken.json"),
      "not json{{",
    );

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    // STALE 是唯一可判定项 → 最新在用，保留；坏文件原样不动
    expect(report.snapshotsDeleted).toBe(0);
    expect(await listSnapshotFiles(convDir)).toHaveLength(2);
  });
});

// ─── 健壮性与幂等 ───

describe("runRetentionSweep — 健壮性", () => {
  it("损坏索引仅 warning 跳过该对话分片，其余对话照常清理", async () => {
    await writeConversation(tmpRoot, "conv-broken", { rawIndex: "{{{not json" });
    const okDir = await writeConversation(tmpRoot, "conv-ok", {
      shards: [
        { id: "000001", createdAt: STALE_OLDER, isActive: false },
        { id: "000002", createdAt: STALE, isActive: true },
      ],
    });

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    expect(report.shardsDeleted).toBe(1);
    expect(await listShardFiles(okDir)).toEqual(["000002.jsonl"]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("index.json");
  });

  it("索引指向已不存在的分片（死记录）→ 幂等跳过、零 warning", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      shards: [
        { id: "000001", createdAt: STALE_OLDER, isActive: false },
        { id: "000002", createdAt: STALE, isActive: true },
      ],
    });
    await fs.unlink(path.join(convDir, "transcript", "000001.jsonl"));

    const report = await runRetentionSweep({ roots: [tmpRoot], now: NOW });

    expect(report.shardsDeleted).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  it("幂等：连续两轮，第二轮零删除、结果状态不变", async () => {
    const convDir = await writeConversation(tmpRoot, "conv-a", {
      shards: [
        { id: "000001", createdAt: STALE_OLDER, isActive: false },
        { id: "000002", createdAt: STALE, isActive: true },
      ],
      snapshots: [{ createdAt: STALE_OLDER }, { createdAt: FRESH }],
    });

    const first = await runRetentionSweep({ roots: [tmpRoot], now: NOW });
    expect(first.shardsDeleted).toBe(1);
    expect(first.snapshotsDeleted).toBe(1);

    const second = await runRetentionSweep({ roots: [tmpRoot], now: NOW });
    expect(second.shardsDeleted).toBe(0);
    expect(second.snapshotsDeleted).toBe(0);
    expect(await listShardFiles(convDir)).toEqual(["000002.jsonl"]);
    expect(await listSnapshotFiles(convDir)).toHaveLength(1);
  });

  it("多根（用户域 + 工作场景域形态）一轮全覆盖", async () => {
    const rootA = path.join(tmpRoot, "user-conversations");
    const rootB = path.join(tmpRoot, "scene-x", "conversations");
    await fs.mkdir(rootA, { recursive: true });
    await fs.mkdir(rootB, { recursive: true });
    await writeConversation(rootA, "conv-a", {
      shards: [
        { id: "000001", createdAt: STALE_OLDER, isActive: false },
        { id: "000002", createdAt: STALE, isActive: true },
      ],
    });
    await writeConversation(rootB, "conv-b", {
      shards: [
        { id: "000001", createdAt: STALE_OLDER, isActive: false },
        { id: "000002", createdAt: STALE, isActive: true },
      ],
    });

    const report = await runRetentionSweep({
      roots: [rootA, rootB, path.join(tmpRoot, "nonexistent")],
      now: NOW,
    });

    expect(report.conversationsScanned).toBe(2);
    expect(report.shardsDeleted).toBe(2);
    expect(report.warnings).toEqual([]);
  });

  it("默认保留窗为 27 天", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(27);
  });
});
