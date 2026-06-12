/**
 * server 会话链路的窗口同形性护栏 —— 真实注意力窗口（ManagedSession 持有）×
 * 真实 ConversationManager 接受协议。
 *
 * REPL 侧的"窗口 × 持久化分层契约"由 core 的等价测试守护；本文件守
 * server 侧特有的两段接缝：
 *   - manager 的窗口接受协议与 getHistory 投影（窗口归 manager,adapter 是纯执行体）
 *   - ConversationManager ephemeral 分支的 pending 簿记（append-only 镜像，
 *     不因窗口折叠截断）与窗口蒸馏视图的有意分叉
 */

import { describe, expect, it } from "vitest";
import {
  buildCompactSummaryPair,
  buildStartupBootstrapPair,
  type Message,
  type RunRecordInput,
  type WindowCompact,
} from "@zhixing/core";
import { ConversationManager } from "@zhixing/server";
import type { RuntimeFactory } from "@zhixing/server";
import type { AgentRuntime } from "@zhixing/orchestrator/runtime";
import { createServerRuntimeAdapter } from "../session-adapter.js";

// ─── 辅助 ───

function pairMessages(index: number): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: `u${index}` }] },
    { role: "assistant", content: [{ type: "text", text: `a${index}` }] },
  ];
}

function makeRecord(index: number): RunRecordInput {
  return {
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
    messages: pairMessages(index),
  };
}

function makeCompact(pairsCompacted: number, summary: string): WindowCompact {
  return {
    summary,
    pairsCompacted,
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
    async create(sessionId) {
      return createServerRuntimeAdapter(sessionId, stubAgentRuntime());
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
  it("persistent：windowCompact 只折叠窗口，持久化 append-only 原文不收折叠", async () => {
    const appended: RunRecordInput[] = [];
    const mgr = new ConversationManager(windowFactory(), config, {
      appendRun: async (_cid, record) => {
        appended.push(record);
        return { runIndex: appended.length - 1, shardId: "000001" };
      },
    });

    await mgr.getOrCreate("c1");
    await mgr.recordTurn("c1", makeRecord(0));
    await mgr.recordTurn("c1", makeRecord(1));
    const compact = makeCompact(1, "首轮摘要");
    await mgr.recordTurn("c1", makeRecord(2), compact);

    // 窗口：蒸馏视图（摘要对 + 保留配对 1 + 新配对 2）
    expect(mgr.getHistory("c1")).toEqual([
      ...buildCompactSummaryPair("首轮摘要"),
      ...pairMessages(1),
      ...pairMessages(2),
    ]);
    // 持久化：3 条原始 run 全部追加，原文完整（折叠从不经持久化回调）
    expect(appended).toHaveLength(3);
    expect(appended.map((r) => r.messages)).toEqual([
      pairMessages(0),
      pairMessages(1),
      pairMessages(2),
    ]);
    mgr.disposeAll();
  });

  it("ephemeral：pending 是 append-only 镜像（不因折叠截断），promote 平铺落盘", async () => {
    const appended: RunRecordInput[] = [];
    const mgr = new ConversationManager(windowFactory(), config, {
      appendRun: async (_cid, record) => {
        appended.push(record);
        return { runIndex: appended.length - 1, shardId: "000001" };
      },
      initTranscript: async () => {},
    });

    const session = await mgr.getOrCreate("e1", { ephemeral: true });

    await mgr.recordTurn("e1", makeRecord(0));
    // 无折叠时窗口 == pending 镜像的蒸馏投影
    expect(mgr.getHistory("e1")).toEqual(
      session.pendingRuns.list().flatMap(({ record }) => [
        record.messages[0]!,
        record.messages[record.messages.length - 1]!,
      ]),
    );

    // 第二轮携 windowCompact（窗口摘掉第一轮）→ 触发 auto-promote
    const compact = makeCompact(1, "ephemeral 摘要");
    await mgr.recordTurn("e1", makeRecord(1), compact);

    // promote 平铺落盘：两条原始 run 依序追加、原文完整
    expect(session.ephemeral).toBe(false);
    expect(appended).toHaveLength(2);
    expect(appended.map((r) => r.messages)).toEqual([
      pairMessages(0),
      pairMessages(1),
    ]);

    // 窗口：蒸馏视图（摘要对 + 配对 1），与全量持久化有意分叉
    expect(mgr.getHistory("e1")).toEqual([
      ...buildCompactSummaryPair("ephemeral 摘要"),
      ...pairMessages(1),
    ]);
    mgr.disposeAll();
  });

  it("恢复历史：启动装填对作为窗口起始条目，manager.getHistory 投影一致", async () => {
    const bootstrapPair = buildStartupBootstrapPair("此前对话回顾");
    const mgr = new ConversationManager(windowFactory(), config, {
      loadHistory: async () => ({ bootstrap: bootstrapPair, turnCount: 3 }),
      appendRun: async () => ({ runIndex: 0, shardId: "000001" }),
    });

    const session = await mgr.getOrCreate("s1");
    expect(session.turnCount).toBe(3);
    expect(mgr.getHistory("s1")).toEqual([...bootstrapPair]);
    expect(mgr.getHistory("s1", 1)).toEqual([bootstrapPair[1]]);
    mgr.disposeAll();
  });
});
