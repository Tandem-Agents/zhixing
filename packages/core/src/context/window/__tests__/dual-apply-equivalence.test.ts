/**
 * 双应用等价 —— 注意力窗口与 transcript canonical 的同形性回归护栏。
 *
 * 过渡期接受协议是"窗口与磁盘双应用"：commitTurn 照旧写盘（含 compactBefore
 * 折叠），窗口同步 acceptRun / applyCompact / 重建。本测试用真实 TranscriptStore
 * （临时目录）逐步驱动两侧，断言每一步之后
 * `window.getMessages()` 与 store 返回的 canonical **深等**——把"内存与磁盘
 * 保持同形"的承诺从手推归纳变成机械检查。
 *
 * 覆盖三态：普通追加、compactBefore 折叠（含跨折叠继续追加）、compactAll
 * 清空重建（/clear 路径）。
 */

import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { TranscriptStore } from "../../../transcript/store.js";
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
  clock += 1000; // 严格递增时间戳，避免与 compact 同毫秒被 normalize 误判
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

/** 模拟 REPL 接受协议：先 commitTurn 落盘、后窗口 acceptRun（双应用） */
async function acceptViaProtocol(
  store: TranscriptStore,
  window: AttentionWindowState,
  conversationId: string,
  turn: Turn,
  compactBefore?: CompactMarker,
) {
  const canonical = await store.commitTurn(conversationId, {
    turn,
    compactBefore,
  });
  window.acceptRun({
    runMessages: [turn.userMessage, turn.assistantMessage],
    windowCompact: compactBefore
      ? windowCompactFromMarker(compactBefore)
      : undefined,
  });
  return canonical;
}

let store: TranscriptStore;

beforeEach(async () => {
  const tmpDir = await createTempDir("dual-apply");
  store = new TranscriptStore(path.join(tmpDir, "conversations"), {
    platform: "linux",
  });
});

// ─── 等价性 ───

describe("窗口 × transcript 双应用同形性", () => {
  it("普通追加：逐 run 后窗口与 canonical 深等", async () => {
    await store.init("c1", { model: "m", provider: "p" });
    const window = createAttentionWindow({ conversationId: "c1" });

    for (let i = 0; i < 4; i++) {
      const canonical = await acceptViaProtocol(store, window, "c1", makeTurn(i));
      expect(window.getMessages()).toEqual(canonical);
    }
  });

  it("compactBefore 折叠：折叠 run 与后续追加都保持同形", async () => {
    await store.init("c2", { model: "m", provider: "p" });
    const window = createAttentionWindow({ conversationId: "c2" });

    for (let i = 0; i < 3; i++) {
      await acceptViaProtocol(store, window, "c2", makeTurn(i));
    }

    // 携 compactBefore 的 run：摘掉前 2 个 turn
    const canonical = await acceptViaProtocol(
      store,
      window,
      "c2",
      makeTurn(3),
      makeCompact(2, "前两轮的摘要"),
    );
    expect(window.getMessages()).toEqual(canonical);

    // 折叠后继续普通追加，仍同形
    const after = await acceptViaProtocol(store, window, "c2", makeTurn(4));
    expect(window.getMessages()).toEqual(after);

    // 二次折叠（取代旧摘要，单 frontier 与磁盘 normalize 同语义）
    const second = await acceptViaProtocol(
      store,
      window,
      "c2",
      makeTurn(5),
      makeCompact(2, "更新后的摘要"),
    );
    expect(window.getMessages()).toEqual(second);
  });

  it("compactAll 清空重建（/clear 路径）：窗口从返回 canonical 还原后同形，且可继续追加", async () => {
    await store.init("c3", { model: "m", provider: "p" });
    let window = createAttentionWindow({ conversationId: "c3" });

    await acceptViaProtocol(store, window, "c3", makeTurn(0));
    await acceptViaProtocol(store, window, "c3", makeTurn(1));

    const cleared = await store.compactAll("c3", "(用户已清空对话历史)");
    window = restoreAttentionWindowFromCanonical(cleared, {
      conversationId: "c3",
    });
    expect(window.getMessages()).toEqual(cleared);

    const after = await acceptViaProtocol(store, window, "c3", makeTurn(2));
    expect(window.getMessages()).toEqual(after);
  });

  it("启动恢复路径：restore(load 结果) 后接受协议继续保持同形", async () => {
    await store.init("c4", { model: "m", provider: "p" });
    const w1 = createAttentionWindow({ conversationId: "c4" });
    await acceptViaProtocol(store, w1, "c4", makeTurn(0));
    await acceptViaProtocol(
      store,
      w1,
      "c4",
      makeTurn(1),
      makeCompact(1, "首轮摘要"),
    );

    // 模拟重启：从磁盘 load 重建窗口
    const loaded = await store.load("c4");
    const w2 = restoreAttentionWindowFromCanonical(loaded.messages, {
      conversationId: "c4",
    });
    expect(w2.getMessages()).toEqual(loaded.messages);

    // 重建后的窗口继续接受 run（含再次折叠），与磁盘同形
    const next = await acceptViaProtocol(
      store,
      w2,
      "c4",
      makeTurn(2),
      makeCompact(1, "重启后的摘要"),
    );
    expect(w2.getMessages()).toEqual(next);
  });
});
