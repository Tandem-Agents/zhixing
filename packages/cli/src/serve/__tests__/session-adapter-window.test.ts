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
    // 保尾护栏按模型解析风险上限——未知模型走保守兜底，足够本测试使用
    model: "test-model",
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
  it("persistent：compactBefore 只折叠窗口，持久化 append-only 不收 marker", async () => {
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

    // 窗口：蒸馏视图（摘要对 + 保留配对 t1 + 新配对 t2）
    const expected = rebuildCanonicalMessages(
      [makeTurn(1), makeTurn(2)],
      [marker],
    );
    expect(mgr.get("c1")!.getHistory()).toEqual(expected);
    // 持久化：3 条原始 turn 全部追加、任何 payload 不含 compactBefore
    expect(committed).toHaveLength(3);
    expect(committed.every((p) => p.compactBefore === undefined)).toBe(true);
    expect(committed.map((p) => p.turn?.turnIndex)).toEqual([0, 1, 2]);
    mgr.disposeAll();
  });

  it("ephemeral：pending 是 append-only 镜像（不因折叠截断），promote 平铺落盘", async () => {
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
    // 无折叠时窗口 == rebuild(pending)
    expect(mgr.get("e1")!.getHistory()).toEqual(
      rebuildCanonicalMessages(session.pendingTurns, []),
    );

    // 第二轮携 compactBefore（窗口摘掉第一轮）→ 触发 auto-promote
    const marker = makeCompact(1, "ephemeral 摘要");
    await mgr.recordTurn("e1", makeTurn(1), marker);

    // promote 平铺落盘：两条原始 turn 依序追加、均无 marker
    expect(session.ephemeral).toBe(false);
    expect(committed).toHaveLength(2);
    expect(committed.map((p) => p.turn?.turnIndex)).toEqual([0, 1]);
    expect(committed.every((p) => p.compactBefore === undefined)).toBe(true);

    // 窗口：蒸馏视图（摘要对 + t1 配对），与全量持久化有意分叉
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
