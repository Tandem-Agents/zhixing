/**
 * run records → 窗口重建（过渡期桥）的契约测试。
 *
 * 重点：配对派生与运行期接受协议同一规则（[首条用户原文, 末条 assistant]），
 * runIndex 随配对落进元数据（折叠覆盖锚点在恢复路径成立）；保尾护栏是
 * 硬上限（末配对超限即截断降级，决不硬塞）。
 */

import { describe, expect, it } from "vitest";
import type { Message } from "../../../types/messages.js";
import {
  assistantMessage,
  extractFirstText,
  userMessage,
} from "../../../types/messages.js";
import { restoreAttentionWindowFromRecords } from "../attention-window.js";
import type { WindowCompact } from "../types.js";

const compact = (pairsCompacted: number): WindowCompact => ({
  summary: "新摘要",
  pairsCompacted,
  tokensBefore: 100,
  tokensAfter: 10,
});

function record(runIndex: number, text: string, extra: Message[] = []) {
  return {
    runIndex,
    messages: [userMessage(text), ...extra, assistantMessage(`re:${text}`)],
  };
}

// 确定性估算：每条消息计 10 token → 一个配对 20
const est = {
  estimateMessages: (m: readonly unknown[]) => m.length * 10,
};

describe("restoreAttentionWindowFromRecords", () => {
  it("空 records → 空窗", () => {
    const w = restoreAttentionWindowFromRecords([]);
    expect(w.getMessages()).toEqual([]);
  });

  it("逐条蒸馏为配对：完整协议序列取 [首条, 末条 assistant]", () => {
    const w = restoreAttentionWindowFromRecords([
      record(0, "读文件", [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "Read", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "t", content: "body" }],
        },
      ]),
      record(1, "继续"),
    ]);
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toEqual(["读文件", "re:读文件", "继续", "re:继续"]);
  });

  it("无 assistant 的 record → 空 assistant 兜底成对", () => {
    const w = restoreAttentionWindowFromRecords([
      { runIndex: 0, messages: [userMessage("刚发就崩")] },
    ]);
    const msgs = w.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual({ role: "assistant", content: [] });
  });

  it("runIndex 落进配对元数据 —— 折叠覆盖锚点在恢复路径成立", () => {
    const w = restoreAttentionWindowFromRecords([
      record(7, "旧"),
      record(9, "新"),
    ]);
    const outcome = w.applyCompact(compact(1));
    expect(outcome.coveredThroughRunIndex).toBe(7);
  });

  it("畸形：首条非用户消息 → 抛错（持久化契约破坏即暴露）", () => {
    expect(() =>
      restoreAttentionWindowFromRecords([
        { runIndex: 0, messages: [assistantMessage("孤儿")] },
      ]),
    ).toThrow(/首条必须是用户/);
  });
});

describe("restore · tailGuard 保尾护栏（硬上限）", () => {
  const records = [record(0, "零"), record(1, "一"), record(2, "二")];

  it("预算充足 → 原样保留", () => {
    const w = restoreAttentionWindowFromRecords(records, {
      tailGuard: { maxTokens: 1000, ...est },
    });
    expect(w.getMessages()).toHaveLength(6);
  });

  it("超预算 → 从尾部保配对，装满即止", () => {
    // 预算 45：末配对(20) 必保 → 余 25 → 再装一个(20) → 余 5 → 停
    const w = restoreAttentionWindowFromRecords(records, {
      tailGuard: { maxTokens: 45, ...est },
    });
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toEqual(["一", "re:一", "二", "re:二"]);
  });

  it("末配对单独超限 → 截断降级（保头保尾），预算硬上限不破", () => {
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
    const w = restoreAttentionWindowFromRecords(
      [
        {
          runIndex: 3,
          messages: [
            userMessage("Q".repeat(300)),
            assistantMessage("A".repeat(300)),
          ],
        },
      ],
      { tailGuard: { maxTokens: 120, ...charEst } },
    );
    const msgs = w.getMessages();
    expect(msgs).toHaveLength(2);
    expect(charEst.estimateMessages(msgs)).toBeLessThanOrEqual(120);
    expect(extractFirstText(msgs[0]!).startsWith("QQQ")).toBe(true);
    expect(extractFirstText(msgs[1]!).endsWith("AAA")).toBe(true);
    expect(extractFirstText(msgs[0]!)).toContain("截断");
  });

  it("预算极端小 → 退化为仅剩截断标注的占位对（循环必终止）", () => {
    const w = restoreAttentionWindowFromRecords([record(0, "很长的问题")], {
      tailGuard: { maxTokens: 1, ...est },
    });
    const msgs = w.getMessages();
    expect(msgs).toHaveLength(2);
    expect(extractFirstText(msgs[0]!)).toContain("截断");
    expect(extractFirstText(msgs[0]!)).not.toContain("很长的问题");
  });

  it("截断后窗口照常折叠 / 接受（条目语义完好）", () => {
    const w = restoreAttentionWindowFromRecords(records, {
      tailGuard: { maxTokens: 45, ...est },
    });
    w.acceptRun({
      runMessages: [userMessage("新"), assistantMessage("答")],
      runIndex: 3,
      windowCompact: compact(2),
    });
    const outcome = w.applyCompact(compact(1));
    // 上一折叠后仅剩新配对(runIndex=3)，本次折叠覆盖到它
    expect(outcome.coveredThroughRunIndex).toBe(3);
  });
});
