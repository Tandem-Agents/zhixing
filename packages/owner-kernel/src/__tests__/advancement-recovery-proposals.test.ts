import { describe, expect, it } from "vitest";
import type { DurableProjectionReadContext } from "@zhixing-ai/core/authority";
import type { AdvancementControlEvent } from "@zhixing-ai/core/advancement";
import {
  advancementPendingPrefix,
  advancementPendingProposals,
  advancementRecoveryRoot,
  foldAdvancementRecovery,
} from "../advancement-recovery-index.js";
import { conversationStateKeyHash } from "../conversation-state-key.js";
import { conversationCommitSummary } from "../conversation-commit-summary.js";
import { validateConversationCommitSummary } from "@zhixing-ai/core/contracts";

const NOW = "2026-10-30T00:00:00.000Z";

/** 内存视图：与投影归约同一读写形状，只为直接检验折叠规则。 */
function memory() {
  const rows = new Map<string, unknown>();
  const view: DurableProjectionReadContext = {
    get: async (key) => rows.get(key) as never,
    scan: async (range, limit) => {
      const keys = [...rows.keys()].sort().filter((key) =>
        ("gte" in range && range.gte !== undefined ? key >= range.gte : true) &&
        ("gt" in range && range.gt !== undefined ? key > range.gt : true) &&
        ("lt" in range && range.lt !== undefined ? key < range.lt : true));
      return { entries: keys.slice(0, limit).map((key) => ({ key, value: rows.get(key) as never })) };
    },
  };
  const fold = (input: Omit<Parameters<typeof foldAdvancementRecovery>[0], "id" | "view" | "put" | "drop">) =>
    foldAdvancementRecovery({
      id: "conv-1",
      view,
      put: (key, value) => { rows.set(key, value); },
      drop: (key) => { rows.delete(key); },
      ...input,
    });
  const pending = () => rows.has(advancementPendingPrefix + conversationStateKeyHash("conv-1"));
  return { rows, view, fold, pending };
}

const accepted = (runId = "run-1"): AdvancementControlEvent => ({
  type: "proposal_accepted",
  timestamp: NOW,
  sessionId: `session-${runId}`,
  conversationId: "conv-1",
  proposalId: `proposal-${runId}`,
  runId,
  originalTurnId: "turn-1",
  originalUserTask: { parts: [{ type: "text", text: "原任务" }] },
});

describe("提交摘要的提议标记", () => {
  it("只在运行记录带推进提议时出现，普通运行不带该字段", () => {
    const base = { runIndex: 3, timestamp: NOW };
    expect(conversationCommitSummary({ ...base, postTurnControl: { intent: { kind: "propose_advancement" } } } as never))
      .toMatchObject({ advancementProposal: true, controlRecovery: true });
    expect(Object.hasOwn(conversationCommitSummary(base as never), "advancementProposal")).toBe(false);
    expect(Object.hasOwn(conversationCommitSummary({ ...base, postTurnControl: { intent: { kind: "exit" } } } as never), "advancementProposal")).toBe(false);
  });

  it("协议校验接受带提议标记的摘要，标记只能为 true", () => {
    const summary = conversationCommitSummary({ runIndex: 3, timestamp: NOW, postTurnControl: { intent: { kind: "propose_advancement" } } } as never);
    expect(() => validateConversationCommitSummary(summary)).not.toThrow();
    expect(() => validateConversationCommitSummary({ ...summary, advancementProposal: false })).toThrow(/advancement proposal/);
  });
});

describe("推进待办目录：提议待接受", () => {
  it("带提议的提交登记义务并进入待办；重复登记幂等；接受后移除义务、proposed 仍是待办", async () => {
    const m = memory();
    await m.fold({ proposal: { runId: "run-1" } });
    await m.fold({ proposal: { runId: "run-1" } });
    expect(await advancementPendingProposals(m.view, "conv-1")).toEqual(["run-1"]);
    expect((await advancementRecoveryRoot(m.view, "conv-1")).proposals).toBe(1);
    expect(m.pending()).toBe(true);

    await m.fold({ event: accepted() });
    expect(await advancementPendingProposals(m.view, "conv-1")).toEqual([]);
    expect((await advancementRecoveryRoot(m.view, "conv-1")).active).toBe("session-run-1");
    expect(m.pending()).toBe(true);

    await m.fold({ event: { type: "draft_attempt_transitioned", timestamp: NOW, sessionId: "session-run-1", attempt: { generation: 1, revision: 0, phase: "invoking" } } });
    expect(m.pending()).toBe(true);
    await m.fold({ event: { type: "draft_attempt_transitioned", timestamp: NOW, sessionId: "session-run-1", attempt: { generation: 1, revision: 0, phase: "failed" } } });
    // 失败等待用户操作，不再是恢复待办
    expect(m.pending()).toBe(false);
    expect((await advancementRecoveryRoot(m.view, "conv-1")).active).toBe("session-run-1");
  });

  it("拒绝同样了结义务；会话删除后不再登记新的提议", async () => {
    const m = memory();
    await m.fold({ proposal: { runId: "run-1" } });
    await m.fold({ event: { ...(accepted() as Extract<AdvancementControlEvent, { type: "proposal_accepted" }>), type: "proposal_rejected", exit: { reason: "superseded", message: "未被接受", occurredAt: NOW } } });
    expect(await advancementPendingProposals(m.view, "conv-1")).toEqual([]);
    expect((await advancementRecoveryRoot(m.view, "conv-1")).active).toBeUndefined();
    expect(m.pending()).toBe(false);

    await m.fold({ lifecycle: "delete" });
    await m.fold({ proposal: { runId: "run-2" } });
    expect(await advancementPendingProposals(m.view, "conv-1")).toEqual([]);
    expect(m.pending()).toBe(false);
  });

  it("草案就绪进入待确认后不再是待办", async () => {
    const m = memory();
    await m.fold({ proposal: { runId: "run-1" } });
    await m.fold({ event: accepted() });
    await m.fold({ event: { type: "draft_attempt_transitioned", timestamp: NOW, sessionId: "session-run-1", attempt: { generation: 1, revision: 0, phase: "invoking" } } });
    await m.fold({ event: {
      type: "proposal_drafted", timestamp: NOW, sessionId: "session-run-1", revision: 0,
      pendingRubricDraft: { draftId: "d", originalTurnId: "turn-1", source: "generated", candidateRubricIds: [], title: "t", description: "d",
        content: { passCriteria: ["p"], failureHandling: [] }, createdAt: NOW },
    } });
    expect(m.pending()).toBe(false);
    expect((await advancementRecoveryRoot(m.view, "conv-1")).active).toBe("session-run-1");
  });
});
