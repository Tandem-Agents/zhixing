import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { AdvancementStore } from "../store.js";
import {
  AdvancementProposalApplicationService,
  type AdvancementPendingProposal,
  type AdvancementProposalFact,
  type AdvancementProposalMechanismPort,
} from "../proposal-application.js";
import { advancementProposalId, advancementProposalSessionId } from "../proposal-identity.js";
import type { RubricContractDraftSnapshot, UserTurnInput } from "../types.js";

const NOW = "2026-10-30T00:00:00.000Z";
const task = (text: string): UserTurnInput => ({ parts: [{ type: "text", text }] });

function draft(id: string, title = "准则"): RubricContractDraftSnapshot {
  return {
    draftId: id,
    originalTurnId: "turn-1",
    source: "generated",
    candidateRubricIds: [],
    title,
    description: "描述",
    content: { passCriteria: ["通过"], evidenceRequirements: [], failureHandling: [{ id: "f", scenario: "失败", reply: "修复" }] },
    createdAt: NOW,
  };
}

async function fixture(options: {
  build?: (abortSignal: AbortSignal) => Promise<RubricContractDraftSnapshot>;
  revise?: (supplements: readonly UserTurnInput[]) => Promise<RubricContractDraftSnapshot>;
} = {}) {
  const store = new AdvancementStore(path.join(await createTempDir("advancement-proposal"), "advancement"));
  const pending: AdvancementPendingProposal[] = [{ runId: "run-1", originalTurnId: "turn-1", originalUserTask: task("整理会议记录") }];
  const facts: AdvancementProposalFact[] = [];
  const build = vi.fn(async (input: { abortSignal: AbortSignal }) => (options.build ?? (async () => draft("draft-1")))(input.abortSignal));
  const revise = vi.fn(async ({ supplements }: { supplements: readonly UserTurnInput[] }) => (options.revise ?? (async () => draft("draft-2", "修订")))(supplements));
  const mechanism: AdvancementProposalMechanismPort = {
    listPendingProposals: async (conversationId) => {
      const accepted = new Set((await store.loadConversationSessions(conversationId)).map((s) => s.proposal?.runId));
      return pending.filter((p) => !accepted.has(p.runId));
    },
    acceptProposal: (input) => store.acceptProposal(input),
    loadLatestSession: async (conversationId) => (await store.loadConversationSessions(conversationId)).at(-1) ?? null,
    transitionDraftAttempt: (c, s, a) => store.transitionDraftAttempt(c, s, a),
    persistProposalDraft: (c, s, a, r, d) => store.persistProposalDraft(c, s, a, r, d),
    buildDraft: (input) => build(input),
    reviseDraft: (input) => revise(input),
  };
  const app = new AdvancementProposalApplicationService({ mechanism, facts: { publish: (fact) => { facts.push(fact); } } });
  const sessionId = advancementProposalSessionId(advancementProposalId("conv-1", "run-1"));
  return { store, app, facts, build, revise, pending, sessionId };
}

describe("AdvancementProposalApplicationService", () => {
  it("接受幂等，起一代草案进入待确认并发布草案事实；并发调用并入同一在途", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture({ build: async () => { await gate; return draft("draft-1"); } });
    const first = f.app.advance("conv-1");
    const second = f.app.advance("conv-1");
    await vi.waitFor(async () => expect((await f.store.loadSession("conv-1", f.sessionId))?.status).toBe("drafting"));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a?.status).toBe("awaiting-rubric-confirmation");
    expect(b?.id).toBe(a?.id);
    expect(f.build).toHaveBeenCalledTimes(1);
    expect(f.facts.map((fact) => fact.kind)).toEqual(["advancement-proposal-drafted"]);
    await f.app.advance("conv-1");
    expect((await f.store.loadConversationSessions("conv-1"))).toHaveLength(1);
  });

  it("起草期间收到补充：按修订语义并入后再进入待确认，修订数为补充条数", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture({ build: async () => { await gate; return draft("draft-1"); } });
    const flight = f.app.advance("conv-1");
    await vi.waitFor(async () => expect((await f.store.loadSession("conv-1", f.sessionId))?.status).toBe("drafting"));
    await f.store.supplementProposal("conv-1", f.sessionId, task("只看本周"));
    release();
    const session = await flight;
    expect(session?.status).toBe("awaiting-rubric-confirmation");
    expect(session?.pendingRubricDraft?.draftId).toBe("draft-2");
    expect(f.revise).toHaveBeenCalledWith(expect.objectContaining({ supplements: [task("只看本周")] }));
  });

  it("只有图片的补充原样交给修订，图片不丢", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture({ build: async () => { await gate; return draft("draft-1"); } });
    const flight = f.app.advance("conv-1");
    await vi.waitFor(async () => expect((await f.store.loadSession("conv-1", f.sessionId))?.status).toBe("drafting"));
    const imageOnly: UserTurnInput = { parts: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" } }] };
    await f.store.supplementProposal("conv-1", f.sessionId, imageOnly);
    release();
    expect((await flight)?.status).toBe("awaiting-rubric-confirmation");
    expect(f.revise.mock.calls[0]![0].supplements).toEqual([imageOnly]);
  });

  it("排空中止在途模型调用：本代记结果不明并发布，排空期间不起新尝试，恢复后也不重放", async () => {
    const f = await fixture({
      build: (abortSignal) => new Promise((_, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })),
    });
    const flight = f.app.advance("conv-1");
    await vi.waitFor(() => expect(f.build).toHaveBeenCalledTimes(1));
    const started = Date.now();
    await f.app.beginDrain();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await flight)?.status).toBe("draft-uncertain");
    expect(f.facts).toMatchObject([{ kind: "advancement-proposal-draft-failed", outcome: "uncertain" }]);
    // 排空期间与恢复之后都不重放本代调用
    await f.app.advance("conv-1");
    f.app.resume();
    await f.app.advance("conv-1");
    expect(f.build).toHaveBeenCalledTimes(1);
  });

  it("排空期间提交的提议只接受、不起草；恢复后由下一次推进起草", async () => {
    const f = await fixture();
    await f.app.beginDrain();
    expect((await f.app.advance("conv-1"))?.status).toBe("proposed");
    expect(f.build).not.toHaveBeenCalled();
    f.app.resume();
    expect((await f.app.advance("conv-1"))?.status).toBe("awaiting-rubric-confirmation");
  });

  it("删除取消会话后中止在途调用：迟到结果作废，不写结果不明也不发布", async () => {
    const f = await fixture({
      build: (abortSignal) => new Promise((_, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })),
    });
    const flight = f.app.advance("conv-1");
    await vi.waitFor(() => expect(f.build).toHaveBeenCalledTimes(1));
    await f.store.cancelSession("conv-1", f.sessionId, { reason: "user-cancelled", message: "原始对话已删除", occurredAt: NOW });
    await f.app.cancel("conv-1");
    expect((await flight)?.status).toBe("cancelled");
    expect(f.facts).toEqual([]);
    expect((await f.store.loadSession("conv-1", f.sessionId))?.proposal?.draftAttempt?.phase).toBe("invoking");
  });

  it("起草失败记 draft-failed 并发布失败事实；不重试", async () => {
    const f = await fixture({ build: async () => { throw new Error("model down"); } });
    const session = await f.app.advance("conv-1");
    expect(session?.status).toBe("draft-failed");
    expect(f.facts).toMatchObject([{ kind: "advancement-proposal-draft-failed", outcome: "failed" }]);
    await f.app.advance("conv-1");
    expect(f.build).toHaveBeenCalledTimes(1);
  });

  it("本实例无在途而耐久为 invoking：记为结果不明，不再调模型", async () => {
    const f = await fixture();
    await f.app.acceptPending("conv-1");
    await f.store.transitionDraftAttempt("conv-1", f.sessionId, { generation: 1, revision: 0, phase: "invoking" });
    const session = await f.app.advance("conv-1");
    expect(session?.status).toBe("draft-uncertain");
    expect(f.build).not.toHaveBeenCalled();
    expect(f.facts).toMatchObject([{ kind: "advancement-proposal-draft-failed", outcome: "uncertain" }]);
  });

  it("起草期间会话被取消：迟到结果只作废，不写草案也不发布", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture({ build: async () => { await gate; return draft("draft-1"); } });
    const flight = f.app.advance("conv-1");
    await vi.waitFor(async () => expect((await f.store.loadSession("conv-1", f.sessionId))?.status).toBe("drafting"));
    await f.store.cancelSession("conv-1", f.sessionId, { reason: "user-cancelled", message: "取消", occurredAt: NOW });
    release();
    const session = await flight;
    expect(session?.status).toBe("cancelled");
    expect(session?.pendingRubricDraft).toBeUndefined();
    expect(f.facts).toEqual([]);
  });

  it("已有未终结会话时待接受提议记为未被接受（建会话并同批取消）", async () => {
    const f = await fixture();
    await f.app.acceptPending("conv-1");
    f.pending.push({ runId: "run-2", originalTurnId: "turn-2", originalUserTask: task("另一件事") });
    await f.app.acceptPending("conv-1");
    const second = await f.store.loadSession("conv-1", advancementProposalSessionId(advancementProposalId("conv-1", "run-2")));
    expect(second?.status).toBe("cancelled");
    expect(second?.exit?.reason).toBe("superseded");
  });
});
