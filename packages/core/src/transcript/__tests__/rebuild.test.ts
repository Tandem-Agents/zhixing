import { describe, expect, it } from "vitest";
import {
  needsNormalize,
  normalize,
  rebuildCanonicalMessages,
} from "../rebuild.js";
import { detectSystemMetaKind } from "../../context/system-meta.js";
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

function makeCompact(timestamp: string, summary: string): CompactMarker {
  return {
    type: "compact",
    timestamp,
    summary,
    turnsCompacted: 3,
    tokensBefore: 10000,
    tokensAfter: 2000,
  };
}

// ─── rebuildCanonicalMessages ───

describe("rebuildCanonicalMessages", () => {
  it("无 compact + 无 turns → 空数组", () => {
    expect(rebuildCanonicalMessages([], [])).toEqual([]);
  });

  it("无 compact + N turns → 2N 条消息（user+assistant 交替）", () => {
    const turns = [
      makeTurn(0, "2026-01-01T00:00:00Z"),
      makeTurn(1, "2026-01-01T00:01:00Z"),
    ];
    const messages = rebuildCanonicalMessages(turns, []);
    expect(messages).toHaveLength(4);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[2]!.role).toBe("user");
    expect(messages[3]!.role).toBe("assistant");
  });

  it("有 compact + N turns → 前置 summaryPair + 2N 条消息", () => {
    const turns = [makeTurn(3, "2026-01-01T00:10:00Z")];
    const compact = makeCompact("2026-01-01T00:00:00Z", "## 核心目标\n测试");
    const messages = rebuildCanonicalMessages(turns, [compact]);

    expect(messages).toHaveLength(4); // summaryPair (2) + 1 turn (2)
    // 前 2 条是 system-meta summary + ack
    expect(detectSystemMetaKind(messages[0]!)).toBe("compact-summary");
    expect(detectSystemMetaKind(messages[1]!)).toBe("ack");
    // 之后是 turns 展开
    expect(messages[2]!.role).toBe("user");
    expect(messages[3]!.role).toBe("assistant");
  });

  it("多 compact（反常情况）取 array 最后一个", () => {
    // 契约：rebuildCanonicalMessages 假设输入已归一化，若调用方违约传多 compact
    // 则用最后一个作 summary（符合"覆盖式记录"的默认语义）
    const compacts = [
      makeCompact("2026-01-01T00:00:00Z", "## 旧摘要"),
      makeCompact("2026-01-01T00:05:00Z", "## 新摘要"),
    ];
    const messages = rebuildCanonicalMessages([], compacts);
    const summaryText = (messages[0]!.content[0] as { text: string }).text;
    expect(summaryText).toContain("新摘要");
    expect(summaryText).not.toContain("旧摘要");
  });
});

// ─── needsNormalize ───

describe("needsNormalize", () => {
  it("无 compact → false（干净 append-only 流不需要归一化）", () => {
    expect(
      needsNormalize({
        turns: [makeTurn(0, "2026-01-01T00:00:00Z")],
        compacts: [],
      }),
    ).toBe(false);
  });

  it("1 compact + 所有 turns 都 post-compact（时间 > compact.ts）→ false", () => {
    expect(
      needsNormalize({
        turns: [makeTurn(0, "2026-01-01T00:10:00Z")],
        compacts: [makeCompact("2026-01-01T00:00:00Z", "s")],
      }),
    ).toBe(false);
  });

  it("多 compact → true（老格式可能累积多 marker）", () => {
    expect(
      needsNormalize({
        turns: [],
        compacts: [
          makeCompact("2026-01-01T00:00:00Z", "s1"),
          makeCompact("2026-01-01T00:05:00Z", "s2"),
        ],
      }),
    ).toBe(true);
  });

  it("1 compact + 存在 turn.ts <= compact.ts → true（§1.3 bug 遗物）", () => {
    expect(
      needsNormalize({
        turns: [
          makeTurn(0, "2026-01-01T00:00:00Z"), // = compact.ts
          makeTurn(1, "2026-01-01T00:10:00Z"), // > compact.ts
        ],
        compacts: [makeCompact("2026-01-01T00:00:00Z", "s")],
      }),
    ).toBe(true);
  });
});

// ─── normalize ───

describe("normalize", () => {
  it("无 compact → 原样返回（带拷贝不共享引用）", () => {
    const turns = [makeTurn(0, "2026-01-01T00:00:00Z")];
    const result = normalize({ turns, compacts: [] });
    expect(result.turns).toEqual(turns);
    expect(result.turns).not.toBe(turns); // 新数组
    expect(result.compacts).toEqual([]);
  });

  it("多 compact → 只留最后一个", () => {
    const c1 = makeCompact("2026-01-01T00:00:00Z", "s1");
    const c2 = makeCompact("2026-01-01T00:05:00Z", "s2");
    const result = normalize({ turns: [], compacts: [c1, c2] });
    expect(result.compacts).toEqual([c2]);
  });

  it("丢弃 timestamp <= compact 的 turns（§1.3 遗物清理）", () => {
    const preCompactTurn = makeTurn(0, "2026-01-01T00:00:00Z");
    const postCompactTurn = makeTurn(1, "2026-01-01T00:10:00Z");
    const compact = makeCompact("2026-01-01T00:00:00Z", "s");

    const result = normalize({
      turns: [preCompactTurn, postCompactTurn],
      compacts: [compact],
    });
    expect(result.turns).toEqual([postCompactTurn]);
  });

  it("归一化结果满足不变量（post-normalize 再次 needsNormalize 返回 false）", () => {
    const noisy = {
      turns: [
        makeTurn(0, "2026-01-01T00:00:00Z"),
        makeTurn(1, "2026-01-01T00:10:00Z"),
      ],
      compacts: [
        makeCompact("2026-01-01T00:00:00Z", "s1"),
        makeCompact("2026-01-01T00:05:00Z", "s2"),
      ],
    };
    const normalized = normalize(noisy);
    expect(needsNormalize(normalized)).toBe(false);
  });
});
