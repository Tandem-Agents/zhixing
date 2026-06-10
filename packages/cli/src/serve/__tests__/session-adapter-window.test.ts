/**
 * server 会话链路的窗口同形性护栏 —— 真实 adapter（注意力窗口）× 真实
 * ConversationManager 接受协议。
 *
 * REPL 侧的"窗口 × transcript 双应用同形"由 core 的等价测试守护；本文件守
 * server 侧特有的两段接缝：
 *   - adapter 的 acceptRun 委托与 getHistory 投影
 *   - ConversationManager ephemeral 分支的 pending 簿记与窗口同形
 *     （窗口折叠 ≡ pendingTurns 截断 + pendingCompact 的 canonical 重建）
 */

import { describe, expect, it } from "vitest";
import {
  rebuildCanonicalMessages,
  userMessage,
  type CompactMarker,
  type Message,
  type Turn,
} from "@zhixing/core";
import { ConversationManager } from "@zhixing/server";
import type { RuntimeFactory } from "@zhixing/server";
import type { AgentRuntime } from "@zhixing/orchestrator/runtime";
import { createServerRuntimeAdapter } from "../session-adapter.js";

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

function makeCompact(turnsCompacted: number, summary: string): CompactMarker {
  return {
    type: "compact",
    timestamp: new Date().toISOString(),
    summary,
    turnsCompacted,
    tokensBefore: 1000,
    tokensAfter: 100,
  };
}

/** 最小 AgentRuntime stub —— 本测试只走 recordTurn 协议，不驱动真实 run */
function stubAgentRuntime(): AgentRuntime {
  return {
    dispose: async () => {},
  } as unknown as AgentRuntime;
}

function windowFactory(): RuntimeFactory {
  return {
    async create(sessionId, initialMessages) {
      return createServerRuntimeAdapter(
        sessionId,
        stubAgentRuntime(),
        initialMessages,
      );
    },
  };
}

const config = {
  graceTimeoutMs: 60_000,
  idleTimeoutMs: 30 * 60_000,
  idleCheckIntervalMs: 999_999,
};

// ─── 等价性 ───

describe("server 会话 × 注意力窗口同形性", () => {
  it("persistent：recordTurn 携 compactBefore → 窗口折叠 + 追加，与磁盘 canonical 形态同构", async () => {
    const committed: Array<{ turn?: Turn; compactBefore?: CompactMarker }> = [];
    const mgr = new ConversationManager(windowFactory(), config, {
      commitTurn: async (_cid, payload) => {
        committed.push(payload);
        return [];
      },
    });

    await mgr.getOrCreate("c1");
    await mgr.recordTurn("c1", makeTurn(0));
    await mgr.recordTurn("c1", makeTurn(1));
    const marker = makeCompact(1, "首轮摘要");
    await mgr.recordTurn("c1", makeTurn(2), marker);

    // 与磁盘同款形态：summaryPair + 保留配对(t1) + 新配对(t2)
    const expected = rebuildCanonicalMessages(
      [makeTurn(1), makeTurn(2)],
      [marker],
    );
    // timestamp 字段不进消息，逐条消息内容应相等
    expect(mgr.get("c1")!.getHistory()).toEqual(expected);
    expect(committed).toHaveLength(3);
    expect(committed[2]!.compactBefore).toBe(marker);
    mgr.disposeAll();
  });

  it("ephemeral：窗口与 pending 簿记保持同形（折叠 ≡ 截断+重建），promote 落盘原料正确", async () => {
    const committed: Array<{ turn?: Turn; compactBefore?: CompactMarker }> = [];
    const mgr = new ConversationManager(windowFactory(), config, {
      commitTurn: async (_cid, payload) => {
        committed.push(payload);
        return [];
      },
      initTranscript: async () => {},
    });

    const session = await mgr.getOrCreate("e1", { ephemeral: true });

    await mgr.recordTurn("e1", makeTurn(0));
    // 窗口 == rebuild(pending)
    expect(mgr.get("e1")!.getHistory()).toEqual(
      rebuildCanonicalMessages(session.pendingTurns, []),
    );

    // 第二轮携 compactBefore（摘掉第一轮）→ 触发 auto-promote
    const marker = makeCompact(1, "ephemeral 摘要");
    await mgr.recordTurn("e1", makeTurn(1), marker);

    // promote 已落盘：头 turn 携 compactBefore
    expect(session.ephemeral).toBe(false);
    expect(committed).toHaveLength(1);
    expect(committed[0]!.turn?.turnIndex).toBe(1);
    expect(committed[0]!.compactBefore).toBe(marker);

    // 窗口形态 == 落盘后 canonical 形态（summaryPair + t1 配对）
    expect(mgr.get("e1")!.getHistory()).toEqual(
      rebuildCanonicalMessages([makeTurn(1)], [marker]),
    );
    mgr.disposeAll();
  });

  it("adapter 恢复历史：initialMessages（canonical）重建窗口，getHistory 投影一致", async () => {
    const history: Message[] = [
      userMessage("旧问题"),
      { role: "assistant", content: [{ type: "text", text: "旧回答" }] },
    ];
    const adapter = createServerRuntimeAdapter("s1", stubAgentRuntime(), history);
    expect(adapter.getHistory()).toEqual(history);
    expect(adapter.getHistory(1)).toEqual([history[1]]);
  });
});
