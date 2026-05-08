import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { TranscriptStore } from "../store.js";
import { loadRecords } from "../serializer.js";
import type { Turn } from "../types.js";
import { detectSystemMetaKind } from "../../context/system-meta.js";

// ─── 辅助 ───

function makeTurn(index: number): Turn {
  return {
    type: "turn",
    turnIndex: index,
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
    userMessage: {
      role: "user",
      content: [{ type: "text", text: `u${index}` }],
    },
    assistantMessage: {
      role: "assistant",
      content: [{ type: "text", text: `a${index}` }],
    },
  };
}

// ─── setup ───

let tmpDir: string;
let store: TranscriptStore;
let convDir: string;

beforeEach(async () => {
  tmpDir = await createTempDir("compact-all");
  convDir = path.join(tmpDir, "conversations");
  store = new TranscriptStore(convDir, "/test/project", { platform: "linux" });
});

// ─── compactAll 行为 ───

describe("compactAll — 折叠所有 turns 为单一 compact marker", () => {
  it("有 N 个 turns → compactAll 后磁盘仅 header + [marker]，0 retained turns", async () => {
    await store.init("c1", { model: "m", provider: "p" });
    await store.commitTurn("c1", { turn: makeTurn(0) });
    await store.commitTurn("c1", { turn: makeTurn(1) });
    await store.commitTurn("c1", { turn: makeTurn(2) });

    const canonical = await store.compactAll("c1", "(test)");

    // canonical = summaryPair（compact-summary + ack 两条）
    expect(canonical).toHaveLength(2);
    expect(detectSystemMetaKind(canonical[0]!)).toBe("compact-summary");
    expect(detectSystemMetaKind(canonical[1]!)).toBe("ack");

    // 磁盘文件：header + marker（0 turns）
    const file = path.join(convDir, "c1", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.turns).toHaveLength(0);
    expect(raw.compacts).toHaveLength(1);
    expect(raw.compacts[0]!.summary).toBe("(test)");
    // turnsCompacted 由 store 内部计算 = 当前磁盘 turns 数
    expect(raw.compacts[0]!.turnsCompacted).toBe(3);
  });

  it("空 turns（init 后未 commit）→ compactAll 写 marker，canonical 仍是 summaryPair", async () => {
    await store.init("c2", { model: "m", provider: "p" });

    const canonical = await store.compactAll("c2", "(empty)");

    expect(canonical).toHaveLength(2);
    const file = path.join(convDir, "c2", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.turns).toHaveLength(0);
    expect(raw.compacts).toHaveLength(1);
    expect(raw.compacts[0]!.turnsCompacted).toBe(0);
  });

  it("compactAll 后 commitTurn(turn) → canonical 起首 summaryPair + 新 turn 展开（老 turns 不回流）", async () => {
    await store.init("c3", { model: "m", provider: "p" });
    await store.commitTurn("c3", { turn: makeTurn(0) });
    await store.commitTurn("c3", { turn: makeTurn(1) });

    await store.compactAll("c3", "(cleared)");

    const canonical = await store.commitTurn("c3", { turn: makeTurn(2) });

    // [summaryMsg, ackMsg, t2.user, t2.assistant]
    expect(canonical).toHaveLength(4);
    expect(detectSystemMetaKind(canonical[0]!)).toBe("compact-summary");
    expect(detectSystemMetaKind(canonical[1]!)).toBe("ack");
    expect(canonical[2]!.role).toBe("user");
    expect(canonical[2]!.content).toEqual([{ type: "text", text: "u2" }]);
    expect(canonical[3]!.role).toBe("assistant");
    expect(canonical[3]!.content).toEqual([{ type: "text", text: "a2" }]);

    // 磁盘：marker + 1 turn (t2)
    const file = path.join(convDir, "c3", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.turns).toHaveLength(1);
    expect(raw.turns[0]!.turnIndex).toBe(2);
    expect(raw.compacts).toHaveLength(1);
  });

  it("多次 compactAll → 最后一次的 marker 取代之前所有", async () => {
    await store.init("c4", { model: "m", provider: "p" });
    await store.commitTurn("c4", { turn: makeTurn(0) });
    await store.compactAll("c4", "(first)");
    await store.commitTurn("c4", { turn: makeTurn(1) });
    const canonical = await store.compactAll("c4", "(second)");

    expect(canonical).toHaveLength(2);
    const file = path.join(convDir, "c4", "transcript.jsonl");
    const raw = await loadRecords(file);
    // 仅第二个 marker 保留，turns 全部清
    expect(raw.compacts).toHaveLength(1);
    expect(raw.compacts[0]!.summary).toBe("(second)");
    expect(raw.turns).toHaveLength(0);
  });

  it("传入 summary 字段被原样写入 marker", async () => {
    await store.init("c5", { model: "m", provider: "p" });
    await store.commitTurn("c5", { turn: makeTurn(0) });

    await store.compactAll("c5", "用户主动清空");

    const file = path.join(convDir, "c5", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.compacts[0]!.summary).toBe("用户主动清空");
  });

  it("未 init 的对话 compactAll → 抛错（与 commitTurn 行为一致）", async () => {
    await expect(
      store.compactAll("nonexistent", "(test)"),
    ).rejects.toThrow();
  });

  it("compactAll 与 commitTurn 同 id 跨调用 lock 串行——并发 compactAll + commitTurn 顺序确定", async () => {
    await store.init("c6", { model: "m", provider: "p" });
    await store.commitTurn("c6", { turn: makeTurn(0) });
    await store.commitTurn("c6", { turn: makeTurn(1) });

    // 并发触发 compactAll 与 commitTurn(turn)；lock 保证串行
    const [compactCanonical, commitCanonical] = await Promise.all([
      store.compactAll("c6", "(parallel)"),
      store.commitTurn("c6", { turn: makeTurn(2) }),
    ]);

    // 不论谁先执行，最终磁盘形态确定（marker + 末尾 turn 之一）
    const file = path.join(convDir, "c6", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.compacts).toHaveLength(1);

    // 可能顺序 1：compactAll 先 → marker + []，然后 commitTurn → marker + [t2]
    // 可能顺序 2：commitTurn 先 → 3 turns，然后 compactAll → marker + []
    // 两种最终都合法，验证 lock 没破坏
    const finalTurnCount = raw.turns.length;
    expect(finalTurnCount === 0 || finalTurnCount === 1).toBe(true);

    // 验证两个调用都返回了 canonical（不是 race fail）
    expect(compactCanonical.length).toBeGreaterThanOrEqual(2);
    expect(commitCanonical.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── appendCompact 别名仍工作（regression） ───

describe("appendCompact 别名 — commitTurn 重构后行为不变", () => {
  it("appendCompact 仍走 commitTurn → 与 commitTurn({compactBefore}) 等价", async () => {
    await store.init("c7", { model: "m", provider: "p" });
    await store.commitTurn("c7", { turn: makeTurn(0) });
    await store.commitTurn("c7", { turn: makeTurn(1) });

    const compact = {
      type: "compact" as const,
      timestamp: new Date().toISOString(),
      summary: "## 摘要",
      turnsCompacted: 1, // 保留末尾 1 个 turn
      tokensBefore: 1000,
      tokensAfter: 200,
    };
    const canonical = await store.appendCompact("c7", compact);

    // canonical = summaryPair + 末尾 1 个 turn（保留）
    expect(canonical).toHaveLength(2 + 2); // summaryPair + 1 turn 展开
    const file = path.join(convDir, "c7", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.compacts).toHaveLength(1);
    expect(raw.turns).toHaveLength(1); // 末尾 turn 保留
    expect(raw.turns[0]!.turnIndex).toBe(1);
  });
});
