/**
 * canonical → 窗口重建（过渡期桥）与 marker → WindowCompact 映射的契约测试。
 *
 * 重点：条目类型还原必须准确——summaryPair 必须落成 summary 条目而非普通
 * 配对，否则后续折叠的 pairsCompacted 计数错位。
 */

import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  extractFirstText,
  userMessage,
} from "../../../types/messages.js";
import { buildCompactSummaryPair } from "../../system-meta.js";
import {
  createAttentionWindow,
  restoreAttentionWindowFromCanonical,
} from "../attention-window.js";
import { windowCompactFromMarker } from "../compact-marker-bridge.js";
import type { WindowCompact } from "../types.js";

const compact = (pairsCompacted: number): WindowCompact => ({
  summary: "新摘要",
  pairsCompacted,
  tokensBefore: 100,
  tokensAfter: 10,
});

describe("restoreAttentionWindowFromCanonical", () => {
  it("空 canonical → 空窗", () => {
    const w = restoreAttentionWindowFromCanonical([]);
    expect(w.getMessages()).toEqual([]);
  });

  it("纯配对 canonical → 逐对还原，getMessages byte-equal", () => {
    const canonical = [
      userMessage("u0"),
      assistantMessage("a0"),
      userMessage("u1"),
      assistantMessage("a1"),
    ];
    const w = restoreAttentionWindowFromCanonical(canonical, {
      conversationId: "c1",
    });
    expect(w.getMessages()).toEqual(canonical);
    expect(w.conversationId).toBe("c1");
  });

  it("summaryPair 起首 → 还原为 summary 条目（不参与折叠计数）", () => {
    const [s, ack] = buildCompactSummaryPair("旧摘要");
    const canonical = [s, ack, userMessage("u0"), assistantMessage("a0")];
    const w = restoreAttentionWindowFromCanonical(canonical);
    expect(w.getMessages()).toEqual(canonical);

    // 折叠 1 个配对：若 summaryPair 被误标为配对，这里截掉的会是它而不是 u0/a0
    w.applyCompact(compact(1));
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toHaveLength(2); // 只剩新摘要对——u0/a0 被折、旧摘要被取代
    expect(texts[0]).toContain("新摘要");
    expect(texts.join()).not.toContain("u0");
  });

  it("还原后接 acceptRun：行为与常规窗口一致", () => {
    const w = restoreAttentionWindowFromCanonical([
      userMessage("旧"),
      assistantMessage("史"),
    ]);
    w.acceptRun({
      runMessages: [userMessage("新"), assistantMessage("答")],
    });
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toEqual(["旧", "史", "新", "答"]);
  });

  it("畸形：角色错位 → 抛错", () => {
    expect(() =>
      restoreAttentionWindowFromCanonical([
        assistantMessage("孤儿 assistant"),
      ]),
    ).toThrow(/不是 \[user, assistant\] 配对/);
  });

  it("畸形：奇数尾 → 抛错", () => {
    expect(() =>
      restoreAttentionWindowFromCanonical([
        userMessage("u0"),
        assistantMessage("a0"),
        userMessage("没有回复的尾巴"),
      ]),
    ).toThrow(/不是 \[user, assistant\] 配对/);
  });
});

describe("windowCompactFromMarker", () => {
  it("字段一一映射，turnsCompacted → pairsCompacted", () => {
    const wc = windowCompactFromMarker({
      type: "compact",
      timestamp: "2026-06-10T00:00:00.000Z",
      summary: "摘要",
      turnsCompacted: 3,
      tokensBefore: 900,
      tokensAfter: 90,
      segmentId: "seg-1",
      structuredSummary: { facts: "f", state: "s", active: "a" },
    });
    expect(wc).toEqual({
      summary: "摘要",
      structuredSummary: { facts: "f", state: "s", active: "a" },
      segmentId: "seg-1",
      pairsCompacted: 3,
      tokensBefore: 900,
      tokensAfter: 90,
    });
  });
});

describe("createAttentionWindow 与 restore 的等价性", () => {
  it("空 canonical 还原 ≡ 新建空窗", () => {
    const restored = restoreAttentionWindowFromCanonical([]);
    const fresh = createAttentionWindow();
    expect(restored.getMessages()).toEqual(fresh.getMessages());
  });
});
