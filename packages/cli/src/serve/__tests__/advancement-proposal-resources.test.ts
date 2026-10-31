import { describe, expect, it, vi } from "vitest";
import { createControlCompletionPort } from "@zhixing/orchestrator/runtime";
import { createAdvancementModelProviderBinding } from "@zhixing/orchestrator/advancement";
import { ADVANCEMENT_PROPOSAL_TOOL, advancementProposalId, advancementProposalSessionId } from "@zhixing/core/advancement";
import {
  AdvancementAcceptedTurnApplicationService,
  AdvancementConversationLifecycleApplicationService,
} from "@zhixing/core/advancement/application";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import type { ChatRequest, LLMRole } from "@zhixing/core/types";
import { createTempDir } from "@zhixing/test-utils";
import { setupAuthorityRuntime } from "../../setup-delivery.js";
import { createServeAdvancementApplications } from "../advancement-controller.js";
import { advancementProposalEvent } from "../advancement-proposal-events.js";
import {
  PROPOSAL, PROPOSAL_CONVERSATION as CONVERSATION, commitProposalRun, createProposalOwnerHarness, hostCtx,
  type ProposalOwnerHarness,
} from "../../../../owner-kernel/src/__tests__/advancement-proposal-fixture.js";

/**
 * 草案尝试的停服与资源收尾，经真实治理器（生产装配同一守卫）：模型调用在途时排空或删除，调用收到中止并在界内返回；
 * 被中止的根经“结算＋释放”收尾，已预留未消耗的用量按预留上限保守记账；恢复不重放模型调用；删除后迟到结果不复活。
 * 替身：只有模型（挂到被中止为止）与会话所在的 owner 夹具；触发由用例直接调用已接纳运行应用。
 * 进程崩溃（没有收尾）由治理器的过期回收负责：根租约 15 分钟 TTL 到期后，宿主运行时的恢复循环（5 s 一轮）调用
 * reclaimExpired 保守记账并回收，宿主不在时于下次启动后的首轮完成；该回收对 advancement-control 根的行为由
 * owner-kernel resource-governor 测试覆盖。
 */

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string) { this.values.set(`${ref.kind}/${ref.bindingId}`, value); }
  async get(ref: SecretRef) { return this.values.get(`${ref.kind}/${ref.bindingId}`) ?? null; }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const key = `${ref.kind}/${ref.bindingId}`;
    const existing = this.values.get(key);
    if (existing !== undefined) return existing;
    const value = create();
    this.values.set(key, value);
    return value;
  }
  async delete(ref: SecretRef) { this.values.delete(`${ref.kind}/${ref.bindingId}`); }
  async list(prefix: string) {
    return [...this.values.keys()].filter((value) => value.startsWith(prefix)).map((value) => {
      const separator = value.indexOf("/");
      return { kind: value.slice(0, separator) as SecretRef["kind"], bindingId: value.slice(separator + 1) };
    });
  }
  async unlockState() { return "unlocked" as const; }
}

const READINESS = { tools: [] as string[], mcpServers: [] as string[], credentialBindings: [], deviceScopedCredentialBindingIds: [] as string[], credentialGeneration: null };
const IMAGE = { type: "base64" as const, mediaType: "image/png", data: "iVBORw0KGgo=" };

async function assemble(h: ProposalOwnerHarness) {
  const runtime = await setupAuthorityRuntime({ zhixingHome: await createTempDir("advancement-proposal-resources"), secretStore: new MemorySecretStore(), executorReadiness: READINESS });
  const governor = runtime.resourceGovernor;
  const roots: Array<{ workload: unknown; reservationId: string }> = [];
  // 只记下根的身份，调用照常落到真实治理器
  const observed = new Proxy(governor, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "acquireRoot" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const lease = await (value as (...input: unknown[]) => Promise<{ reservationId: string }>).apply(target, args);
        roots.push({ workload: args[0], reservationId: lease.reservationId });
        return lease;
      };
    },
  });
  // 模型调用挂到被中止为止；收到的请求留作核对
  const requests: ChatRequest[] = [];
  const chat = vi.fn(async function* (request: ChatRequest) {
    requests.push(request);
    await new Promise<never>((_, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (request.abortSignal?.aborted) abort(); else request.abortSignal?.addEventListener("abort", abort, { once: true });
    });
    yield { type: "message_end" as const, stopReason: "end_turn" as const, usage: { inputTokens: 0, outputTokens: 0 } };
  });
  const role = { model: "resources-test", provider: { id: "resources-test", models: [], chat }, chat } satisfies LLMRole;
  const completion = createControlCompletionPort({ roles: { main: role, light: role }, meter: observed as never, defaultMaxOutputTokens: 1024 });
  const events: ReturnType<typeof advancementProposalEvent>[] = [];
  const applications = await createServeAdvancementApplications({
    modelProvider: { create: () => createAdvancementModelProviderBinding({ completion, reviewer: { review: vi.fn() } }) },
    governor: () => observed as never,
    sessionState: h.adapter as never,
    recentContext: Object.freeze({ read: async () => undefined }),
    rubricScope: "local",
    onProposalFact: (fact) => { events.push(advancementProposalEvent(fact)); },
  });
  const acceptedTurns = new AdvancementAcceptedTurnApplicationService({
    catchUp: { catchUpAcceptedTurn: vi.fn(async () => ({ status: "no-active-session" as const })) },
    review: { reviewAcceptedRun: vi.fn() },
    results: { projectReviewResult: vi.fn(async () => undefined) },
    proposals: applications.proposals,
  });
  return { runtime, governor, roots, chat, requests, events, applications, acceptedTurns };
}

async function proposeAndWaitForModel(h: ProposalOwnerHarness, wired: Awaited<ReturnType<typeof assemble>>) {
  const outcome = await commitProposalRun(h, {
    runId: "run-proposal", turnId: "turn-proposal", text: "按截图把界面修好",
    enabledControls: [ADVANCEMENT_PROPOSAL_TOOL], postTurnControl: PROPOSAL, images: [IMAGE],
  });
  if (!outcome.committed) throw new Error(`proposal commit rejected: ${outcome.error.message}`);
  const committed = await h.journal.committedRun("run-proposal");
  wired.acceptedTurns.acceptCommittedTurn({
    conversationId: CONVERSATION, turnId: "turn-proposal", runIndex: committed!.runRecord.runIndex, runRecord: committed!.runRecord, ephemeral: false,
  });
  await vi.waitFor(() => expect(wired.chat).toHaveBeenCalledTimes(1), { timeout: 15_000 });
}

/** 被中止的根：已结算并释放，预留的用量按预留上限保守记账。 */
async function expectConservativelySettled(wired: Awaited<ReturnType<typeof assemble>>) {
  expect(wired.roots).toHaveLength(1);
  const root = wired.roots[0]!;
  await expect(wired.governor.inspectImmediateRoot(root.workload as never)).resolves.toMatchObject({ kind: "reservation", state: "released" });
  const state = await (wired.governor as unknown as { snapshot(): Promise<{ usageReservations: Map<string, { state: string; reservationId: string; tokens?: number }>; reservations: Map<string, { used: { tokens?: number; calls?: number } }> }> }).snapshot();
  const usage = [...state.usageReservations.values()].filter((entry) => entry.reservationId === root.reservationId);
  expect(usage.length).toBe(1);
  expect(usage[0]!.state).not.toBe("reserved");
  expect(state.reservations.get(root.reservationId)?.used.calls).toBe(1);
}

describe("草案尝试的停服与资源收尾（真实治理器）", () => {
  it("在途起草时排空：调用被中止并在界内返回，本代记结果不明，根保守结算释放，恢复后不重放模型调用", async () => {
    const h = await createProposalOwnerHarness();
    const wired = await assemble(h);
    try {
      await proposeAndWaitForModel(h, wired);
      // 原任务的图片随起草调用到达模型
      expect(JSON.stringify(wired.requests[0]!.messages)).toContain(IMAGE.data);

      const started = Date.now();
      await wired.applications.proposals.beginDrain();
      expect(Date.now() - started).toBeLessThan(5_000);

      const sessionId = advancementProposalSessionId(advancementProposalId(CONVERSATION, "run-proposal"));
      expect(await h.adapter.readAdvancementState(CONVERSATION, hostCtx("drained"), sessionId)).toMatchObject({ status: "draft-uncertain" });
      expect(wired.events).toMatchObject([{ event: "advancement:proposal_draft_failed", payload: { outcome: "uncertain" } }]);
      await expectConservativelySettled(wired);

      wired.applications.proposals.resume();
      await wired.applications.proposals.advance(CONVERSATION);
      expect(wired.chat).toHaveBeenCalledTimes(1);
    } finally {
      await wired.runtime.startupCleanup.run();
    }
  }, 60_000);

  it("在途起草时删除对话：会话取消、调用被中止，迟到结果不复活，根保守结算释放", async () => {
    const h = await createProposalOwnerHarness();
    const wired = await assemble(h);
    try {
      await proposeAndWaitForModel(h, wired);
      const lifecycle = new AdvancementConversationLifecycleApplicationService({
        mechanism: {
          loadOpenConversationLifecycleSession: (conversationId) => wired.applications.controller.loadOpenConversationLifecycleSession(conversationId),
          persistConversationLifecycleCancellation: (request) => wired.applications.reviews.cancelSession(request),
          removeConversationData: async () => undefined,
          listConversationDataCandidates: async () => [],
          removeConversationDataCandidate: async () => false,
        },
        conversationAlive: { isConversationDataAlive: async () => true },
        proposals: wired.applications.proposals,
      });
      const started = Date.now();
      await lifecycle.cancelConversationLifecycle(CONVERSATION);
      expect(Date.now() - started).toBeLessThan(5_000);

      const sessionId = advancementProposalSessionId(advancementProposalId(CONVERSATION, "run-proposal"));
      const session = await h.adapter.readAdvancementState(CONVERSATION, hostCtx("deleted"), sessionId);
      expect(session).toMatchObject({ status: "cancelled" });
      expect(session?.pendingRubricDraft).toBeUndefined();
      expect(wired.events).toEqual([]);
      await expectConservativelySettled(wired);
    } finally {
      await wired.runtime.startupCleanup.run();
    }
  }, 60_000);
});
