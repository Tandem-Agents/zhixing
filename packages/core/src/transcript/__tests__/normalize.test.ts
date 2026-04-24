import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TranscriptStore } from "../store.js";
import { loadRecords, writeHeader, appendRecord } from "../serializer.js";
import type { CompactMarker, Turn } from "../types.js";

// ─── 辅助 ───

function makeTurn(index: number, timestamp: string): Turn {
  return {
    type: "turn",
    turnIndex: index,
    timestamp,
    userMessage: { role: "user", content: [{ type: "text", text: `u${index}` }] },
    assistantMessage: {
      role: "assistant",
      content: [{ type: "text", text: `a${index}` }],
    },
  };
}

function makeCompact(
  timestamp: string,
  summary: string,
  turnsCompacted = 3,
): CompactMarker {
  return {
    type: "compact",
    timestamp,
    summary,
    turnsCompacted,
    tokensBefore: 10000,
    tokensAfter: 2000,
  };
}

// ─── 临时目录 ───

let tmpDir: string;
let convDir: string;
let store: TranscriptStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-normalize-test-"));
  convDir = path.join(tmpDir, "conversations");
  store = new TranscriptStore(convDir, "/test/project", { platform: "linux" });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Lazy normalize ───

describe("Lazy normalize（ADR-TR-5：老文件首次 load 同步归一化）", () => {
  it("多 compact 老格式 → load 后只剩最后 1 个 compact，文件被重写", async () => {
    await store.init("c1", { model: "m", provider: "p" });

    const file = path.join(convDir, "c1", "transcript.jsonl");
    // 绕开 commitTurn 直接 append 两个 compact（模拟老格式）
    await appendRecord(file, makeCompact("2026-01-01T00:00:00Z", "旧摘要"));
    await appendRecord(
      file,
      makeTurn(0, "2026-01-01T00:05:00Z"),
    );
    await appendRecord(file, makeCompact("2026-01-01T00:10:00Z", "新摘要"));

    await store.load("c1");

    // 归一化后文件只剩 header + 最后一个 compact（turn 在它之前所以被丢弃）
    const raw = await loadRecords(file);
    expect(raw.compacts).toHaveLength(1);
    expect(raw.compacts[0]!.summary).toBe("新摘要");
    expect(raw.turns).toHaveLength(0); // 旧 turn 时间戳早于最后 compact → 丢弃
  });

  it("§1.3 bug 老格式：turn.ts < compact.ts → load 后 turn 被归一化丢弃，文件干净", async () => {
    // 场景复现：老 REPL 先 appendTurn（turnA.ts=0）再 appendCompact（compact.ts=5）
    // 即使逻辑上 turnA 应该是 post-compact，但 ts 反了 → normalize 丢弃 turnA
    await store.init("c2", { model: "m", provider: "p" });

    const file = path.join(convDir, "c2", "transcript.jsonl");
    await appendRecord(file, makeTurn(0, "2026-01-01T00:00:00Z"));
    await appendRecord(file, makeCompact("2026-01-01T00:05:00Z", "s"));

    await store.load("c2");

    const raw = await loadRecords(file);
    expect(raw.turns).toHaveLength(0); // bug 遗物被清理
    expect(raw.compacts).toHaveLength(1);
  });

  it("归一化后再次 load 不重复归一化（幂等）", async () => {
    await store.init("c3", { model: "m", provider: "p" });

    const file = path.join(convDir, "c3", "transcript.jsonl");
    await appendRecord(file, makeTurn(0, "2026-01-01T00:00:00Z"));
    await appendRecord(file, makeCompact("2026-01-01T00:05:00Z", "s"));

    // 第一次 load：触发归一化
    await store.load("c3");
    const mtime1 = (await fs.stat(file)).mtimeMs;

    // 手动等几毫秒保证 mtime 可区分
    await new Promise((r) => setTimeout(r, 20));

    // 第二次 load：不应再写入
    await store.load("c3");
    const mtime2 = (await fs.stat(file)).mtimeMs;

    expect(mtime2).toBe(mtime1);
  });

  it("干净文件（无需归一化）→ load 不重写，mtime 不变", async () => {
    await store.init("c4", { model: "m", provider: "p" });
    await store.commitTurn("c4", { turn: makeTurn(0, "2026-01-01T00:00:00Z") });
    const file = path.join(convDir, "c4", "transcript.jsonl");
    const mtime1 = (await fs.stat(file)).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    await store.load("c4");
    const mtime2 = (await fs.stat(file)).mtimeMs;

    expect(mtime2).toBe(mtime1);
  });

  it("归一化后 turnCount 反映 active 段（§4.1 新语义）", async () => {
    await store.init("c5", { model: "m", provider: "p" });

    const file = path.join(convDir, "c5", "transcript.jsonl");
    // 老格式：3 个旧 turn + 1 个 compact + 2 个 post-compact turn
    await appendRecord(file, makeTurn(0, "2026-01-01T00:00:00Z"));
    await appendRecord(file, makeTurn(1, "2026-01-01T00:01:00Z"));
    await appendRecord(file, makeTurn(2, "2026-01-01T00:02:00Z"));
    await appendRecord(file, makeCompact("2026-01-01T00:05:00Z", "s"));
    await appendRecord(file, makeTurn(3, "2026-01-01T00:10:00Z"));
    await appendRecord(file, makeTurn(4, "2026-01-01T00:11:00Z"));

    const loaded = await store.load("c5");
    expect(loaded.turnCount).toBe(2); // 只有 post-compact 的 turn3/turn4
  });
});
