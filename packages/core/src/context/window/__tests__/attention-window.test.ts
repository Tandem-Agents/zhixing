/**
 * 注意力窗口运行态 —— 契约测试。
 *
 * 覆盖面：
 *   - 蒸馏对派生：完整协议序列 → [首条, 末条 assistant]；无 assistant 兜底空 assistant
 *   - 单 frontier 折叠：摘要对置首、取代 bootstrap / 旧摘要、按 pairsCompacted 截配对
 *   - 折叠与磁盘旧算法等价（keep = max(0, 总数 - N) 的 clamp 语义）
 *   - coveredThroughRunIndex 交出：被折最后配对的 runIndex / 无折叠时 undefined
 *   - bootstrap 起始条目与 reset
 */

import { describe, expect, it } from "vitest";
import type { Message } from "../../../types/messages.js";
import { assistantMessage, userMessage } from "../../../types/messages.js";
import { extractFirstText } from "../../../types/messages.js";
import { createAttentionWindow } from "../attention-window.js";
import type { WindowCompact } from "../types.js";

// ─── 工具 ───

function compact(overrides: Partial<WindowCompact> = {}): WindowCompact {
  return {
    summary: "摘要内容",
    pairsCompacted: 0,
    tokensBefore: 1000,
    tokensAfter: 100,
    ...overrides,
  };
}

/** 构造一个含工具轮的完整协议 run 序列：u → a(tool_use) → u(tool_result) → a(总结) */
function toolLoopRun(userText: string, finalText: string): Message[] {
  return [
    userMessage(userText),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "file body" }],
    },
    assistantMessage(finalText),
  ];
}

function bootstrapPair(): readonly [Message, Message] {
  return [userMessage("[装填] 之前聊到哪了"), assistantMessage("[装填] 收到")];
}

// ─── 空窗与 bootstrap ───

describe("createAttentionWindow · 初始形态", () => {
  it("空窗 getMessages 为空", () => {
    const w = createAttentionWindow();
    expect(w.getMessages()).toEqual([]);
  });

  it("bootstrap 对作为起始条目进入窗口", () => {
    const pair = bootstrapPair();
    const w = createAttentionWindow({ bootstrap: pair });
    expect(w.getMessages()).toEqual([pair[0], pair[1]]);
  });

  it("conversationId 透传", () => {
    const w = createAttentionWindow({ conversationId: "c1" });
    expect(w.conversationId).toBe("c1");
  });

  it("reset 清空全部条目（含 bootstrap）", () => {
    const w = createAttentionWindow({ bootstrap: bootstrapPair() });
    w.acceptRun({ runMessages: [userMessage("hi"), assistantMessage("yo")] });
    w.reset("clear");
    expect(w.getMessages()).toEqual([]);
  });
});

// ─── 蒸馏对派生 ───

describe("acceptRun · 蒸馏对派生", () => {
  it("简单 run：追加 [user, assistant] 配对", () => {
    const w = createAttentionWindow();
    w.acceptRun({ runMessages: [userMessage("你好"), assistantMessage("在")] });
    const msgs = w.getMessages();
    expect(msgs).toHaveLength(2);
    expect(extractFirstText(msgs[0]!)).toBe("你好");
    expect(extractFirstText(msgs[1]!)).toBe("在");
  });

  it("完整协议序列：派生 [首条, 末条 assistant]，工具轮消息不入窗", () => {
    const w = createAttentionWindow();
    w.acceptRun({ runMessages: toolLoopRun("读文件", "读完了") });
    const msgs = w.getMessages();
    expect(msgs).toHaveLength(2);
    expect(extractFirstText(msgs[0]!)).toBe("读文件");
    expect(extractFirstText(msgs[1]!)).toBe("读完了");
  });

  it("无 assistant 的 run：派生空 assistant 成对入窗（中断/错误路径不需特判）", () => {
    const w = createAttentionWindow();
    w.acceptRun({ runMessages: [userMessage("刚发就中断")] });
    const msgs = w.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual({ role: "assistant", content: [] });
  });

  it("runMessages 为空 → 抛错（编程错误，不静默）", () => {
    const w = createAttentionWindow();
    expect(() => w.acceptRun({ runMessages: [] })).toThrow(/runMessages 为空/);
  });

  it("多 run 顺序累积", () => {
    const w = createAttentionWindow();
    w.acceptRun({ runMessages: [userMessage("一"), assistantMessage("1")] });
    w.acceptRun({ runMessages: [userMessage("二"), assistantMessage("2")] });
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toEqual(["一", "1", "二", "2"]);
  });
});

// ─── 折叠 ───

describe("折叠 · 单 frontier 与 clamp", () => {
  function windowWithPairs(runIndexes: Array<number | undefined>) {
    const w = createAttentionWindow();
    runIndexes.forEach((runIndex, i) => {
      w.acceptRun({
        runMessages: [userMessage(`u${i}`), assistantMessage(`a${i}`)],
        runIndex,
      });
    });
    return w;
  }

  it("acceptRun 携 windowCompact：先折后追加，新配对不被折，返回值交出覆盖锚点", () => {
    const w = windowWithPairs([0, 1, 2]);
    const outcome = w.acceptRun({
      runMessages: [userMessage("新"), assistantMessage("答")],
      runIndex: 3,
      windowCompact: compact({ pairsCompacted: 2 }),
    });
    // owner 写派生快照走的就是这个返回值：被折最后配对（runIndex=1）
    expect(outcome.coveredThroughRunIndex).toBe(1);
    const texts = w.getMessages().map((m) => extractFirstText(m));
    // 摘要对(2) + 保留配对 u2/a2 + 新配对
    expect(texts).toHaveLength(6);
    expect(texts[0]).toContain('kind="compact-summary"');
    expect(texts[0]).toContain("摘要内容");
    expect(texts.slice(2)).toEqual(["u2", "a2", "新", "答"]);
  });

  it("acceptRun 无 windowCompact：返回值不含覆盖锚点", () => {
    const w = windowWithPairs([0]);
    const outcome = w.acceptRun({
      runMessages: [userMessage("新"), assistantMessage("答")],
      runIndex: 1,
    });
    expect(outcome.coveredThroughRunIndex).toBeUndefined();
  });

  it("折叠取代 bootstrap 与旧摘要（任何时刻至多一个摘要对）", () => {
    const w = createAttentionWindow({ bootstrap: bootstrapPair() });
    w.acceptRun({
      runMessages: [userMessage("u0"), assistantMessage("a0")],
      runIndex: 0,
    });
    w.applyCompact(compact({ summary: "第一次", pairsCompacted: 1 }));
    w.acceptRun({
      runMessages: [userMessage("u1"), assistantMessage("a1")],
      runIndex: 1,
    });
    w.applyCompact(compact({ summary: "第二次", pairsCompacted: 1 }));

    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toHaveLength(2); // 只剩新摘要对
    expect(texts[0]).toContain("第二次");
    expect(texts.join()).not.toContain("第一次");
    expect(texts.join()).not.toContain("装填");
  });

  it("pairsCompacted 超过现存配对数 → clamp（与磁盘旧算法 max(0, len-N) 等价）", () => {
    const w = windowWithPairs([0, 1]);
    const outcome = w.applyCompact(compact({ pairsCompacted: 99 }));
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toHaveLength(2); // 全折，只剩摘要对
    expect(outcome.coveredThroughRunIndex).toBe(1); // 被折最后配对的 runIndex
  });

  it("coveredThroughRunIndex：取被折最后配对；无折叠时 undefined", () => {
    const w = windowWithPairs([10, 11, 12]);
    expect(
      w.applyCompact(compact({ pairsCompacted: 2 })).coveredThroughRunIndex,
    ).toBe(11);
    // 再折 0 个：无折叠
    expect(
      w.applyCompact(compact({ pairsCompacted: 0 })).coveredThroughRunIndex,
    ).toBeUndefined();
  });

  it("被折最后配对缺 runIndex → undefined（保守缺省）", () => {
    const w = windowWithPairs([0, undefined]);
    expect(
      w.applyCompact(compact({ pairsCompacted: 2 })).coveredThroughRunIndex,
    ).toBeUndefined();
  });

  it("applyCompact 只折叠不追加（run 外手动压缩）", () => {
    const w = windowWithPairs([0, 1, 2]);
    w.applyCompact(compact({ pairsCompacted: 1 }));
    const texts = w.getMessages().map((m) => extractFirstText(m));
    expect(texts).toHaveLength(6); // 摘要对 + 两个保留配对
    expect(texts.slice(2)).toEqual(["u1", "a1", "u2", "a2"]);
  });
});
