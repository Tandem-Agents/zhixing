/**
 * 窗口 × 持久化的分层契约 —— 回归护栏。
 *
 * 契约：持久化是 append-only 原文（只增不减，压缩永不触碰磁盘）；注意力
 * 窗口是唯一的压缩视图（折叠只发生在内存）。两者在无压缩时同形，发生
 * 压缩后**有意分叉**——磁盘保留全量、窗口持有蒸馏。
 *
 * 用真实 TranscriptStore（临时目录）驱动接受协议（先盘后窗），机械检查：
 *   - 磁盘 turn 数单调不减、load 回的 canonical 含全部原文
 *   - 窗口折叠形态正确（与折叠算法的期望形一致）
 *   - 用户主权清空（compactAll）是唯一的物理清除路径
 *   - 重启全量加载 + 保尾护栏的端到端行为
 */

import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { TranscriptStore } from "../../../transcript/store.js";
import { rebuildCanonicalMessages } from "../../../transcript/rebuild.js";
import type { CompactMarker, Turn } from "../../../transcript/types.js";
import type { AttentionWindowState } from "../types.js";
import {
  createAttentionWindow,
  restoreAttentionWindowFromCanonical,
} from "../attention-window.js";
import { windowCompactFromMarker } from "../compact-marker-bridge.js";

// ─── 辅助 ───

let clock = Date.now();
function makeTurn(index: number): Turn {
  clock += 1000;
  return {
    type: "turn",
    turnIndex: index,
    timestamp: new Date(clock).toISOString(),
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

function makeCompact(turnsCompacted: number, summary: string): CompactMarker {
  clock += 1000;
  return {
    type: "compact",
    timestamp: new Date(clock).toISOString(),
    summary,
    turnsCompacted,
    tokensBefore: 10_000,
    tokensAfter: 1_000,
  };
}

/** 接受协议：持久化只追加原始 turn；compactBefore 只驱动窗口折叠 */
async function acceptViaProtocol(
  store: TranscriptStore,
  window: AttentionWindowState,
  conversationId: string,
  turn: Turn,
  compactBefore?: CompactMarker,
) {
  await store.commitTurn(conversationId, { turn });
  window.acceptRun({
    runMessages: [turn.userMessage, turn.assistantMessage],
    windowCompact: compactBefore
      ? windowCompactFromMarker(compactBefore)
      : undefined,
  });
}

let store: TranscriptStore;

beforeEach(async () => {
  const tmpDir = await createTempDir("window-persistence");
  store = new TranscriptStore(path.join(tmpDir, "conversations"), {
    platform: "linux",
  });
});

// ─── 契约 ───

describe("窗口 × 持久化分层契约", () => {
  it("无压缩：窗口与磁盘 canonical 同形", async () => {
    await store.init("c1", { model: "m", provider: "p" });
    const window = createAttentionWindow({ conversationId: "c1" });

    for (let i = 0; i < 3; i++) {
      await acceptViaProtocol(store, window, "c1", makeTurn(i));
    }
    const loaded = await store.load("c1");
    expect(window.getMessages()).toEqual(loaded.messages);
  });

  it("窗口折叠后：磁盘保留全部原文（只增不减），窗口持有蒸馏形", async () => {
    await store.init("c2", { model: "m", provider: "p" });
    const window = createAttentionWindow({ conversationId: "c2" });

    const turns = [makeTurn(0), makeTurn(1), makeTurn(2)];
    for (const t of turns.slice(0, 2)) {
      await acceptViaProtocol(store, window, "c2", t);
    }

    // 第三个 run 携窗口折叠指令（摘掉前 2 个配对）
    const marker = makeCompact(2, "前两轮的摘要");
    await acceptViaProtocol(store, window, "c2", turns[2]!, marker);

    // 磁盘：全部 3 个原始 turn 完好，无 marker，canonical 不变短
    expect(await store.countTurns("c2")).toBe(3);
    const loaded = await store.load("c2");
    expect(loaded.messages).toEqual(rebuildCanonicalMessages(turns, []));

    // 窗口：摘要对 + 新配对（蒸馏视图，与磁盘有意分叉）
    expect(window.getMessages()).toEqual(
      rebuildCanonicalMessages([turns[2]!], [marker]),
    );

    // 折叠后继续追加：磁盘继续全量增长，窗口继续蒸馏演进
    const t3 = makeTurn(3);
    await acceptViaProtocol(store, window, "c2", t3);
    expect(await store.countTurns("c2")).toBe(4);
    expect(window.getMessages()).toEqual(
      rebuildCanonicalMessages([turns[2]!, t3], [marker]),
    );
  });

  it("用户主权清空（compactAll）是唯一物理清除路径，restore 重建后同形", async () => {
    await store.init("c3", { model: "m", provider: "p" });
    let window = createAttentionWindow({ conversationId: "c3" });

    await acceptViaProtocol(store, window, "c3", makeTurn(0));
    await acceptViaProtocol(store, window, "c3", makeTurn(1));

    const cleared = await store.compactAll("c3", "(用户已清空对话历史)");
    window = restoreAttentionWindowFromCanonical(cleared, {
      conversationId: "c3",
    });
    expect(window.getMessages()).toEqual(cleared);
    expect(await store.countTurns("c3")).toBe(0);

    // 清空后继续对话照常
    await acceptViaProtocol(store, window, "c3", makeTurn(2));
    expect(await store.countTurns("c3")).toBe(1);
  });

  it("重启全量加载：磁盘是全量原文，保尾护栏负责截到风险上限以下", async () => {
    await store.init("c4", { model: "m", provider: "p" });
    const w1 = createAttentionWindow({ conversationId: "c4" });

    // 会话期发生过窗口折叠——磁盘仍保留全部 4 个 turn
    const turns = [makeTurn(0), makeTurn(1), makeTurn(2), makeTurn(3)];
    await acceptViaProtocol(store, w1, "c4", turns[0]!);
    await acceptViaProtocol(store, w1, "c4", turns[1]!, makeCompact(1, "摘"));
    await acceptViaProtocol(store, w1, "c4", turns[2]!);
    await acceptViaProtocol(store, w1, "c4", turns[3]!);

    // 重启：load 回全量原文（窗口期的折叠不影响磁盘）
    const loaded = await store.load("c4");
    expect(loaded.messages).toEqual(rebuildCanonicalMessages(turns, []));

    // 护栏：每条消息计 10，预算 45 → 保最新 2 个配对（无摘要对可保）
    const w2 = restoreAttentionWindowFromCanonical(loaded.messages, {
      conversationId: "c4",
      tailGuard: {
        maxTokens: 45,
        estimateMessages: (m) => m.length * 10,
      },
    });
    const texts = w2
      .getMessages()
      .map((m) => (m.content[0] as { text: string }).text);
    expect(texts).toEqual(["u2", "a2", "u3", "a3"]);
  });
});
