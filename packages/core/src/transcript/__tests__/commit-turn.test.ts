import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { TranscriptStore } from "../store.js";
import { loadRecords } from "../serializer.js";
import type { CompactMarker, Turn } from "../types.js";
import { detectSystemMetaKind } from "../../context/system-meta.js";

// ─── 辅助 ───

function makeTurn(index: number, timestamp?: string): Turn {
  return {
    type: "turn",
    turnIndex: index,
    timestamp: timestamp ?? new Date(Date.now() + index * 1000).toISOString(),
    userMessage: { role: "user", content: [{ type: "text", text: `u${index}` }] },
    assistantMessage: {
      role: "assistant",
      content: [{ type: "text", text: `a${index}` }],
    },
  };
}

function makeCompact(
  timestamp: string,
  turnsCompacted: number,
  summary = "## 核心目标\n测试压缩",
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
let store: TranscriptStore;
let convDir: string;

beforeEach(async () => {
  tmpDir = await createTempDir("commit-turn");
  convDir = path.join(tmpDir, "conversations");
  // 显式锚定 platform 为 linux（测试默认走 POSIX 原子 rename）。
  // Windows fallback 路径在独立测试里用 platform: "win32" 锚定。
  store = new TranscriptStore(convDir, { platform: "linux" });
});

// ─── commitTurn 三形态 ───

describe("commitTurn — {turn} append 形态", () => {
  it("无现有 compact → 简单 append，返回 canonical = all turns 展开", async () => {
    await store.init("c1", { model: "m", provider: "p" });

    const t0 = makeTurn(0);
    const canonical1 = await store.commitTurn("c1", { turn: t0 });
    expect(canonical1).toHaveLength(2); // t0.user + t0.assistant

    const t1 = makeTurn(1);
    const canonical2 = await store.commitTurn("c1", { turn: t1 });
    expect(canonical2).toHaveLength(4); // 2 turns × 2 messages

    // 文件内容：header + t0 + t1（无 compact）
    const file = path.join(convDir, "c1", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.turns).toHaveLength(2);
    expect(raw.compacts).toHaveLength(0);
  });

  it("有现有 compact → append 不改 compact，canonical 含 summaryPair + turns", async () => {
    await store.init("c2", { model: "m", provider: "p" });

    // 先通过 commitTurn({compactBefore}) 建立 compact
    const compact = makeCompact(new Date().toISOString(), 0);
    await store.commitTurn("c2", { compactBefore: compact });

    // 再 append turn
    const canonical = await store.commitTurn("c2", {
      turn: makeTurn(0, new Date(Date.now() + 1000).toISOString()),
    });

    // canonical = summaryPair (2) + 1 turn (2) = 4
    expect(canonical).toHaveLength(4);
    expect(detectSystemMetaKind(canonical[0]!)).toBe("compact-summary");
  });
});

describe("commitTurn — {turn, compactBefore} 原子截断 + append", () => {
  it("keepCount 算法：turns.length=3, turnsCompacted=3 → 保留 0 个 + 追加新 turn", async () => {
    await store.init("c3", { model: "m", provider: "p" });
    await store.commitTurn("c3", { turn: makeTurn(0) });
    await store.commitTurn("c3", { turn: makeTurn(1) });
    await store.commitTurn("c3", { turn: makeTurn(2) });

    const compact = makeCompact(
      new Date(Date.now() + 10000).toISOString(),
      3, // 替代全部 3 个 turns
    );
    const newTurn = makeTurn(3, new Date(Date.now() + 20000).toISOString());
    const canonical = await store.commitTurn("c3", {
      turn: newTurn,
      compactBefore: compact,
    });

    // canonical = summaryPair (2) + 1 turn (2) = 4
    expect(canonical).toHaveLength(4);

    // 文件：header + compact + t3（老的 t0/t1/t2 被截断）
    const file = path.join(convDir, "c3", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.compacts).toHaveLength(1);
    expect(raw.turns).toHaveLength(1);
    expect(raw.turns[0]!.turnIndex).toBe(3);
  });

  it("keepCount 算法：turns.length=5, turnsCompacted=2 → 保留末尾 3 个 + 追加新 turn", async () => {
    await store.init("c4", { model: "m", provider: "p" });
    for (let i = 0; i < 5; i++) {
      await store.commitTurn("c4", { turn: makeTurn(i) });
    }

    const compact = makeCompact(
      new Date(Date.now() + 10000).toISOString(),
      2, // 只替代前 2 个
    );
    const newTurn = makeTurn(5, new Date(Date.now() + 20000).toISOString());
    const canonical = await store.commitTurn("c4", {
      turn: newTurn,
      compactBefore: compact,
    });

    // canonical = summaryPair (2) + 3 retained turns (6) + 1 new turn (2) = 10
    expect(canonical).toHaveLength(10);

    const file = path.join(convDir, "c4", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.turns.map((t) => t.turnIndex)).toEqual([2, 3, 4, 5]);
  });

  it("边界：turnsCompacted > turns.length（pre-flight 罕见路径）→ keepCount=0 不出错", async () => {
    await store.init("c5", { model: "m", provider: "p" });
    await store.commitTurn("c5", { turn: makeTurn(0) });

    const compact = makeCompact(
      new Date(Date.now() + 10000).toISOString(),
      99, // 超过实际 turns.length=1
    );
    const newTurn = makeTurn(1, new Date(Date.now() + 20000).toISOString());
    const canonical = await store.commitTurn("c5", {
      turn: newTurn,
      compactBefore: compact,
    });

    // Math.max(0, 1-99)=0 → retained=[], 只剩 new turn
    expect(canonical).toHaveLength(4); // summaryPair + 1 new turn
    const file = path.join(convDir, "c5", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.turns).toHaveLength(1);
    expect(raw.turns[0]!.turnIndex).toBe(1);
  });
});

describe("commitTurn — {compactBefore} 手动 /compact 形态（无新 turn）", () => {
  it("只带 compactBefore → 按 turnsCompacted 截断，文件只剩 header + compact + retained", async () => {
    await store.init("c6", { model: "m", provider: "p" });
    for (let i = 0; i < 4; i++) {
      await store.commitTurn("c6", { turn: makeTurn(i) });
    }

    const compact = makeCompact(
      new Date(Date.now() + 10000).toISOString(),
      2,
    );
    const canonical = await store.commitTurn("c6", { compactBefore: compact });

    // canonical = summaryPair (2) + 2 retained turns (4) = 6
    expect(canonical).toHaveLength(6);
    const file = path.join(convDir, "c6", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.compacts).toHaveLength(1);
    expect(raw.turns.map((t) => t.turnIndex)).toEqual([2, 3]);
  });
});

describe("commitTurn — 非法输入 & 错误路径", () => {
  it("{} 空 payload 抛错（非法契约）", async () => {
    await store.init("c7", { model: "m", provider: "p" });
    await expect(store.commitTurn("c7", {})).rejects.toThrow(
      "commitTurn requires at least turn or compactBefore",
    );
  });

  it("conversation 不存在 → 抛'不存在'错误（契约与 legacy 一致）", async () => {
    await expect(
      store.commitTurn("nonexistent", { turn: makeTurn(0) }),
    ).rejects.toThrow("不存在");
  });
});

describe("commitTurn — appendTurn / appendCompact legacy 薄别名", () => {
  it("appendTurn 完全等价于 commitTurn({turn})", async () => {
    await store.init("c8", { model: "m", provider: "p" });
    await store.appendTurn("c8", makeTurn(0));

    const loaded = await store.load("c8");
    expect(loaded.turnCount).toBe(1);
  });

  it("appendCompact 完全等价于 commitTurn({compactBefore})，返回 canonical", async () => {
    await store.init("c9", { model: "m", provider: "p" });
    await store.commitTurn("c9", { turn: makeTurn(0) });

    const compact = makeCompact(
      new Date(Date.now() + 10000).toISOString(),
      1,
    );
    const canonical = await store.appendCompact("c9", compact);

    // turnsCompacted=1 替代 1 个 turn → retained=0 → canonical = summaryPair (2)
    expect(canonical).toHaveLength(2);
    expect(detectSystemMetaKind(canonical[0]!)).toBe("compact-summary");
  });
});
