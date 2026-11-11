import { describe, expect, it } from "vitest";
import type { RubricContractDraftSnapshot } from "@zhixing-ai/core/contracts";
import {
  ADVANCEMENT_PROPOSAL_TOOL,
  advancementProposalId,
  advancementProposalSessionId,
} from "@zhixing-ai/core/advancement";
import { DURABLE_IO_TEST_TIMEOUT_MS } from "./durable-io-test-support.js";
import {
  PROPOSAL, PROPOSAL_CONVERSATION as CONVERSATION, PROPOSAL_NOW as NOW,
  commitProposalRun as commitRun, createProposalOwnerHarness as createHarness, hostCtx, task,
} from "./advancement-proposal-fixture.js";

/**
 * 推进提议经真实 owner 提交：接纳带启用标记的输入、提交带提议意图的运行记录，协议校验（turnOrigin、提交摘要）、
 * 提交时的启用核对、G08 义务登记与原任务还原走生产路径。之后的接受与起草事件在这里直接写入，只证明它们的耐久
 * 持久化与 G08 投影规则；提交后自动触发接受与起草的接线由接入面的提议装配用例证明。
 */

function draft(originalTurnId: string): RubricContractDraftSnapshot {
  return {
    draftId: "draft-proposal", originalTurnId, source: "generated", candidateRubricIds: [],
    title: "测试推进准则", description: "测试全绿即可验收",
    content: {
      passCriteria: ["测试全绿"], evidenceRequirements: [],
      failureHandling: [{ id: "continue", scenario: "测试未通过", reply: "继续修复测试。" }],
    },
    createdAt: NOW,
  };
}

describe("推进提议经真实 owner 提交", () => {
  it("启用标记随耐久接纳通过协议校验；带提议的提交登记义务、还原原任务；接受与起草事件的投影推进到待确认", async () => {
    const h = await createHarness();
    const outcome = await commitRun(h, {
      runId: "run-proposal", turnId: "turn-proposal", text: "把测试修到全绿，盯到验收通过",
      enabledControls: [ADVANCEMENT_PROPOSAL_TOOL], postTurnControl: PROPOSAL,
    });
    if (!outcome.committed) throw new Error(`proposal commit rejected: ${outcome.error.message}`);

    // 义务行与运行提交同一提交可见；读口给出 R1、X 与只取 X 的原任务
    expect(await h.proposals()).toEqual([
      { runId: "run-proposal", originalTurnId: "turn-proposal", originalUserTask: task("把测试修到全绿，盯到验收通过") },
    ]);
    expect(await h.pendingConversations()).toEqual([CONVERSATION]);

    const proposalId = advancementProposalId(CONVERSATION, "run-proposal");
    const sessionId = advancementProposalSessionId(proposalId);
    await h.write([{
      type: "proposal_accepted", timestamp: NOW, sessionId, conversationId: CONVERSATION, proposalId,
      runId: "run-proposal", originalTurnId: "turn-proposal", originalUserTask: task("把测试修到全绿，盯到验收通过"),
    }]);
    expect(await h.proposals()).toEqual([]);
    expect(await h.pendingConversations()).toEqual([CONVERSATION]);
    expect(await h.adapter.readAdvancementState(CONVERSATION, hostCtx("proposed"))).toMatchObject({ id: sessionId, status: "proposed" });

    await h.write([{ type: "draft_attempt_transitioned", timestamp: NOW, sessionId, attempt: { generation: 1, revision: 0, phase: "invoking" } }]);
    expect(await h.pendingConversations()).toEqual([CONVERSATION]);
    await h.write([
      { type: "draft_attempt_transitioned", timestamp: NOW, sessionId, attempt: { generation: 1, revision: 0, phase: "consumed" } },
      { type: "proposal_drafted", timestamp: NOW, sessionId, revision: 0, pendingRubricDraft: draft("turn-proposal") },
    ]);
    expect(await h.adapter.readAdvancementState(CONVERSATION, hostCtx("awaiting"))).toMatchObject({
      id: sessionId, status: "awaiting-rubric-confirmation", pendingRubricDraft: { draftId: "draft-proposal" },
    });
    // 待确认等用户，不是待办
    expect(await h.pendingConversations()).toEqual([]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("本次运行没有启用提议时，带提议意图的提交被拒，不登记义务", async () => {
    const h = await createHarness();
    const outcome = await commitRun(h, {
      runId: "run-unenabled", turnId: "turn-unenabled", text: "直接回答一个问题", postTurnControl: PROPOSAL,
    });
    expect(outcome.committed).toBe(false);
    if (!outcome.committed) expect(outcome.error.message).toContain("Advancement proposal was not enabled");
    expect(await h.proposals()).toEqual([]);
    expect(await h.pendingConversations()).toEqual([]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it.each([
    { sessionId: "session-a", mode: "advancement" as const, draftId: "draft-1" },
    { sessionId: "session-a", mode: "direct" as const },
  ])("执行运行的耐久 ingress 带推进执行标记（$mode）经真实接纳、指派与提交", async (advancementExecution) => {
    const h = await createHarness();
    const outcome = await commitRun(h, {
      runId: `run-exec-${advancementExecution.mode}`, turnId: `turn-1:${advancementExecution.mode}`,
      text: "用户已确认 Rubric，开始执行上面提出的原任务。", advancementExecution,
    });
    if (!outcome.committed) throw new Error(`execution commit rejected: ${outcome.error.message}`);
    expect(await h.proposals()).toEqual([]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("启用了提议但运行没有提出时照常提交，不登记义务", async () => {
    const h = await createHarness();
    const outcome = await commitRun(h, {
      runId: "run-plain", turnId: "turn-plain", text: "帮我看看这段代码", enabledControls: [ADVANCEMENT_PROPOSAL_TOOL],
    });
    if (!outcome.committed) throw new Error(`plain commit rejected: ${outcome.error.message}`);
    expect(await h.proposals()).toEqual([]);
    expect(await h.pendingConversations()).toEqual([]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);
});
