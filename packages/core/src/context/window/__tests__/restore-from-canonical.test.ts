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

describe("restore · tailGuard 保尾护栏", () => {
  // 确定性估算：每条消息计 10 token → 一个配对 20、摘要对 20
  const est = { estimateMessages: (m: readonly unknown[]) => m.length * 10 };

  function canonicalWithSummary(pairCount: number) {
    const [s, ack] = buildCompactSummaryPair("旧摘要");
    const msgs = [s, ack];
    for (let i = 0; i < pairCount; i++) {
      msgs.push(userMessage(`u${i}`), assistantMessage(`a${i}`));
    }
    return msgs;
  }

  it("预算充足 → 原样保留", () => {
    const canonical = canonicalWithSummary(3);
    const w = restoreAttentionWindowFromCanonical(canonical, {
      tailGuard: { maxTokens: 1000, ...est },
    });
    expect(w.getMessages()).toEqual(canonical);
  });

  it("超预算 → 从尾部保配对，摘要对放得下则保留", () => {
    // 预算 60：尾部 2 配对(40) + 摘要对(20) 恰好放下，最旧配对被丢
    const canonical = canonicalWithSummary(3);
    const w = restoreAttentionWindowFromCanonical(canonical, {
      tailGuard: { maxTokens: 60, ...est },
    });
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toHaveLength(6);
    expect(texts[0]).toContain("旧摘要");
    expect(texts.slice(2)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("摘要优先占额度：余额只够一个配对时，保摘要 + 最新配对", () => {
    // 预算 45：摘要对(20) 先占 → 余 25 → 只装得下最新配对(20)
    const canonical = canonicalWithSummary(3);
    const w = restoreAttentionWindowFromCanonical(canonical, {
      tailGuard: { maxTokens: 45, ...est },
    });
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain("旧摘要");
    expect(texts.slice(2)).toEqual(["u2", "a2"]);
  });

  it("摘要会挤掉末配对的空间时 → 放弃摘要（硬上限优先于摘要保留）", () => {
    // 预算 30：末配对(20) 必保 → 余 10，摘要对(20) 放不下 → 丢弃
    const canonical = canonicalWithSummary(3);
    const w = restoreAttentionWindowFromCanonical(canonical, {
      tailGuard: { maxTokens: 30, ...est },
    });
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toEqual(["u2", "a2"]);
  });

  it("末配对单独超限 → 截断降级（保头保尾），预算硬上限不破", () => {
    // 字符线性估算器：token = 文本总字符数
    const charEst = {
      estimateMessages: (msgs: readonly Message[]) =>
        msgs.reduce(
          (sum, m) =>
            sum +
            m.content.reduce(
              (s, b) => s + (b.type === "text" ? b.text.length : 0),
              0,
            ),
          0,
        ),
    };
    const canonical = [
      ...buildCompactSummaryPair("旧摘要"),
      userMessage("Q".repeat(300)),
      assistantMessage("A".repeat(300)),
    ];
    const w = restoreAttentionWindowFromCanonical(canonical, {
      tailGuard: { maxTokens: 120, ...charEst },
    });
    const msgs = w.getMessages();
    // 摘要被放弃，仅剩截断后的末配对，且真在预算之内
    expect(msgs).toHaveLength(2);
    expect(charEst.estimateMessages(msgs)).toBeLessThanOrEqual(120);
    const userText = extractFirstText(msgs[0]!);
    const assistantText = extractFirstText(msgs[1]!);
    expect(userText.startsWith("QQQ")).toBe(true); // 用户消息保开头（意图）
    expect(assistantText.endsWith("AAA")).toBe(true); // 回复保结尾（结论）
    expect(userText).toContain("截断");
    expect(assistantText).toContain("截断");
  });

  it("预算极端小 → 退化为仅剩截断标注的占位对（循环必终止）", () => {
    // count 估算器对截断不敏感（恒 20）——细化循环把保留长度收敛到 0 后退出
    const canonical = [userMessage("很长的问题"), assistantMessage("很长的回答")];
    const w = restoreAttentionWindowFromCanonical(canonical, {
      tailGuard: { maxTokens: 1, ...est },
    });
    const msgs = w.getMessages();
    expect(msgs).toHaveLength(2);
    expect(extractFirstText(msgs[0]!)).toContain("截断");
    expect(extractFirstText(msgs[1]!)).toContain("截断");
    expect(extractFirstText(msgs[0]!)).not.toContain("很长的问题");
  });

  it("截断后窗口照常折叠 / 接受（条目语义完好）", () => {
    const canonical = canonicalWithSummary(3);
    const w = restoreAttentionWindowFromCanonical(canonical, {
      tailGuard: { maxTokens: 60, ...est },
    });
    // 折叠 1 个配对：被折的是保留下来的最旧配对 u1/a1
    const outcome = w.applyCompact(compact(1));
    expect(outcome.coveredThroughRunIndex).toBeUndefined(); // restore 配对无 runIndex
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toHaveLength(4); // 新摘要对 + u2/a2
    expect(texts.slice(2)).toEqual(["u2", "a2"]);
  });
});

describe("createAttentionWindow 与 restore 的等价性", () => {
  it("空 canonical 还原 ≡ 新建空窗", () => {
    const restored = restoreAttentionWindowFromCanonical([]);
    const fresh = createAttentionWindow();
    expect(restored.getMessages()).toEqual(fresh.getMessages());
  });
});
