import { describe, expect, it, vi } from "vitest";
import { createAdvancementModelProviderBinding } from "@zhixing-ai/orchestrator/advancement";
import { ADVANCEMENT_PROPOSAL_TOOL, advancementProposalId, advancementProposalSessionId } from "@zhixing-ai/core/advancement";
import { AdvancementAcceptedTurnApplicationService } from "@zhixing-ai/core/advancement/application";
import { createServeAdvancementApplications } from "../advancement-controller.js";
import { advancementProposalEvent } from "../advancement-proposal-events.js";
import {
  PROPOSAL, PROPOSAL_CONVERSATION as CONVERSATION, commitProposalRun, createProposalOwnerHarness, hostCtx, task,
  type ProposalOwnerHarness,
} from "../../../../owner-kernel/src/__tests__/advancement-proposal-fixture.js";

/**
 * 提议的自动推进接线：真实 owner 提交带提议的运行后，把已提交运行交给已接纳运行应用，由它触发提议应用
 * 接受、经推进控制调用起草、写入待确认（真实 owner 存储），并经生产的事件映射推送。不直接写入任何推进事件。
 * 替身与边界：模型与资源治理器是替身；触发由用例直接调用 acceptCommittedTurn，代替宿主的提交监听。
 * 所以本用例不证明真实治理器的结算、宿主监听已接通，也不是终端全链。
 */

const DRAFT = JSON.stringify({
  title: "测试全绿验收准则",
  description: "用于判断测试是否修到全绿。",
  passCriteria: ["相关测试全部通过"],
  evidenceRequirements: [{ id: "tests", kind: "test-result", description: "相关测试的运行结果。", required: false }],
  failureHandling: [{ id: "continue", scenario: "仍有失败测试", reply: "继续修复失败测试并说明验证结果。" }],
});

async function assemble(h: ProposalOwnerHarness, completion: { complete: ReturnType<typeof vi.fn> }) {
  const governor = {
    acquireRoot: vi.fn(async () => Object.freeze({ reservationId: "reservation:control" })),
    settle: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    settleAndRelease: vi.fn(async () => undefined),
  };
  const reviewer = { review: vi.fn() };
  const events: ReturnType<typeof advancementProposalEvent>[] = [];
  const applications = await createServeAdvancementApplications({
    modelProvider: { create: () => createAdvancementModelProviderBinding({ completion, reviewer }) },
    governor: () => governor as never,
    sessionState: h.adapter as never,
    recentContext: Object.freeze({ read: async () => undefined }),
    rubricScope: "local",
    // 与生产装配同一映射：提议事实 → 推进事件出口
    onProposalFact: (fact) => { events.push(advancementProposalEvent(fact)); },
  });
  // 与生产装配同形：已提交运行的监听交给已接纳运行应用，提议交给提议应用
  const catchUp = vi.fn(async () => ({ status: "no-active-session" as const }));
  const reviewAcceptedRun = vi.fn();
  const acceptedTurns = new AdvancementAcceptedTurnApplicationService({
    catchUp: { catchUpAcceptedTurn: catchUp },
    review: { reviewAcceptedRun },
    results: { projectReviewResult: vi.fn(async () => undefined) },
    proposals: applications.proposals,
  });
  return { acceptedTurns, events, catchUp, reviewAcceptedRun, reviewer, governor };
}

async function acceptCommitted(h: ProposalOwnerHarness, acceptedTurns: AdvancementAcceptedTurnApplicationService, runId: string, turnId: string) {
  const committed = await h.journal.committedRun(runId);
  if (!committed) throw new Error(`run ${runId} was not committed`);
  acceptedTurns.acceptCommittedTurn({
    conversationId: CONVERSATION, turnId, runIndex: committed.runRecord.runIndex, runRecord: committed.runRecord, ephemeral: false,
  });
}

describe("推进提议的自动推进接线", () => {
  it("带提议的运行提交后自动接受、起草并进入待确认，草案就绪沿推进事件推送", async () => {
    const h = await createProposalOwnerHarness();
    const outcome = await commitProposalRun(h, {
      runId: "run-proposal", turnId: "turn-proposal", text: "把测试修到全绿，盯到验收通过",
      enabledControls: [ADVANCEMENT_PROPOSAL_TOOL], postTurnControl: PROPOSAL,
    });
    if (!outcome.committed) throw new Error(`proposal commit rejected: ${outcome.error.message}`);
    const completion = { complete: vi.fn(async () => ({ ok: true as const, text: DRAFT })) };
    const wired = await assemble(h, completion);

    await acceptCommitted(h, wired.acceptedTurns, "run-proposal", "turn-proposal");
    await vi.waitFor(() => expect(wired.events).toHaveLength(1), { timeout: 15_000 });

    const sessionId = advancementProposalSessionId(advancementProposalId(CONVERSATION, "run-proposal"));
    expect(wired.events[0]).toMatchObject({
      conversationId: CONVERSATION, runId: "turn-proposal", event: "advancement:contract_draft",
      payload: { advancementSessionId: sessionId, rubricDraft: { originalTurnId: "turn-proposal", title: "测试全绿验收准则" } },
    });
    expect(await h.adapter.readAdvancementState(CONVERSATION, hostCtx("awaiting"))).toMatchObject({
      id: sessionId, status: "awaiting-rubric-confirmation",
      originalUserTask: task("把测试修到全绿，盯到验收通过"),
      proposal: { runId: "run-proposal", originalTurnId: "turn-proposal" },
      pendingRubricDraft: { originalTurnId: "turn-proposal" },
    });
    // 起草只调用一次主推理通道，提示里带着提议运行的原任务；义务已了结，待确认不是待办
    expect(completion.complete).toHaveBeenCalledTimes(1);
    const request = completion.complete.mock.calls[0]![0] as { role: string; messages: Array<{ content: Array<{ text?: string }> }> };
    expect(request.role).toBe("main");
    expect(JSON.stringify(request.messages)).toContain("把测试修到全绿，盯到验收通过");
    expect(wired.governor.settleAndRelease).toHaveBeenCalledTimes(1);
    expect(await h.proposals()).toEqual([]);
    expect(await h.pendingConversations()).toEqual([]);
    // 提议运行不是验收对象
    expect(wired.catchUp).not.toHaveBeenCalled();
    expect(wired.reviewAcceptedRun).not.toHaveBeenCalled();
  }, 60_000);

  it("起草失败时会话记为 draft-failed 并推送可继续的失败事件，原任务保留", async () => {
    const h = await createProposalOwnerHarness();
    const outcome = await commitProposalRun(h, {
      runId: "run-proposal", turnId: "turn-proposal", text: "把测试修到全绿",
      enabledControls: [ADVANCEMENT_PROPOSAL_TOOL], postTurnControl: PROPOSAL,
    });
    if (!outcome.committed) throw new Error(`proposal commit rejected: ${outcome.error.message}`);
    const completion = { complete: vi.fn(async () => ({ ok: false as const, error: { message: "模型不可用" } })) };
    const wired = await assemble(h, completion);

    await acceptCommitted(h, wired.acceptedTurns, "run-proposal", "turn-proposal");
    await vi.waitFor(() => expect(wired.events).toHaveLength(1), { timeout: 15_000 });

    expect(wired.events[0]).toMatchObject({
      runId: "turn-proposal", event: "advancement:proposal_draft_failed", payload: { outcome: "failed" },
    });
    expect(await h.adapter.readAdvancementState(CONVERSATION, hostCtx("failed"))).toMatchObject({
      status: "draft-failed", originalUserTask: task("把测试修到全绿"),
    });
    expect(await h.pendingConversations()).toEqual([]);
  }, 60_000);

  it("没有提出推进的运行照常进入验收路径，不起草、不建推进会话", async () => {
    const h = await createProposalOwnerHarness();
    const outcome = await commitProposalRun(h, {
      runId: "run-plain", turnId: "turn-plain", text: "帮我看看这段代码", enabledControls: [ADVANCEMENT_PROPOSAL_TOOL],
    });
    if (!outcome.committed) throw new Error(`plain commit rejected: ${outcome.error.message}`);
    const completion = { complete: vi.fn(async () => ({ ok: true as const, text: DRAFT })) };
    const wired = await assemble(h, completion);

    await acceptCommitted(h, wired.acceptedTurns, "run-plain", "turn-plain");
    await vi.waitFor(() => expect(wired.catchUp).toHaveBeenCalledTimes(1), { timeout: 15_000 });

    expect(completion.complete).not.toHaveBeenCalled();
    expect(wired.events).toEqual([]);
    expect(await h.adapter.readAdvancementState(CONVERSATION, hostCtx("none"))).toBeNull();
  }, 60_000);
});
