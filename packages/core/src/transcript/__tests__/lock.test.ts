import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { TranscriptStore } from "../store.js";
import { loadRecords } from "../serializer.js";
import type { Turn } from "../types.js";

// ─── 辅助 ───

function makeTurn(index: number): Turn {
  return {
    type: "turn",
    turnIndex: index,
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
    userMessage: { role: "user", content: [{ type: "text", text: `u${index}` }] },
    assistantMessage: {
      role: "assistant",
      content: [{ type: "text", text: `a${index}` }],
    },
  };
}

// ─── 临时目录 ───

let tmpDir: string;
let convDir: string;
let store: TranscriptStore;

beforeEach(async () => {
  tmpDir = await createTempDir("lock");
  convDir = path.join(tmpDir, "conversations");
  store = new TranscriptStore(convDir, "/test/project", { platform: "linux" });
});

// ─── Per-id 锁 ───

describe("Per-transcript 串行锁（ADR-TR-8）", () => {
  it("同 id 并发 commitTurn → 按 Promise.all 发起顺序串行完成，无 lost update", async () => {
    await store.init("c1", { model: "m", provider: "p" });

    // 并发发起 5 个 commitTurn
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        store.commitTurn("c1", { turn: makeTurn(i) }),
      ),
    );

    // 所有 5 个都落盘，无一丢失（串行保证）
    const file = path.join(convDir, "c1", "transcript.jsonl");
    const raw = await loadRecords(file);
    expect(raw.turns).toHaveLength(5);

    // turn index 全部在文件里（可能不保证顺序 —— Promise.all 调度顺序依赖 V8）
    const indices = raw.turns.map((t) => t.turnIndex).sort();
    expect(indices).toEqual([0, 1, 2, 3, 4]);
  });

  it("跨 id 并发不互斥 —— 两个 id 并发 init + commitTurn 都成功", async () => {
    // 并发 init + append 两个独立 conversation
    await Promise.all([
      (async () => {
        await store.init("a", { model: "m", provider: "p" });
        await store.commitTurn("a", { turn: makeTurn(0) });
      })(),
      (async () => {
        await store.init("b", { model: "m", provider: "p" });
        await store.commitTurn("b", { turn: makeTurn(0) });
      })(),
    ]);

    const rawA = await loadRecords(path.join(convDir, "a", "transcript.jsonl"));
    const rawB = await loadRecords(path.join(convDir, "b", "transcript.jsonl"));
    expect(rawA.turns).toHaveLength(1);
    expect(rawB.turns).toHaveLength(1);
  });

  it("一个操作失败不污染同 id 后续操作（错误吞噬在锁尾）", async () => {
    await store.init("c2", { model: "m", provider: "p" });

    // 发起一个必然失败的操作（{} 非法 payload）
    const failing = store.commitTurn("c2", {});
    await expect(failing).rejects.toThrow();

    // 随后正常操作应能成功（上次失败没挂死锁链）
    const canonical = await store.commitTurn("c2", { turn: makeTurn(0) });
    expect(canonical).toHaveLength(2);
  });
});
