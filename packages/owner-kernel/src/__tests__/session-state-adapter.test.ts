import { Buffer } from "node:buffer";
import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import { DeliveryAuthority } from "@zhixing/core/delivery";
import type {
  AdvancementExit,
  AdvancementProxyMessage,
  AdvancementRunReview,
  AuthorityCallContext,
  ConfirmedRubricSnapshot,
  CreateAdvancementSessionInput,
  EvidenceRequest,
  ResourceLease,
  RubricContractDraftSnapshot,
  Signature,
  UserTurnInput,
} from "@zhixing/core/contracts";
import type { AdvancementControlEvent } from "@zhixing/core/advancement";
import {
  createSignedEvidenceRequest,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  ControlAdmissionJournal,
  createConversationControlEnvelope,
} from "../control-admission.js";
import { ConversationRunJournal } from "../conversation-assignment.js";
import { OwnerDeliveryParticipant } from "../delivery.js";
import { AnchorSessionStateAdapter } from "../session-state-adapter.js";

const NOW = "2026-08-02T00:00:00.000Z";
const EXPIRY = "2026-08-02T01:00:00.000Z";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "device:test-owner",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

async function createHarness(conversationId = "conv-1") {
  const root = await createTempDir("session-state-adapter");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  });
  const makeJournal = () =>
    new ConversationRunJournal({
      conversationId,
      ownerEpoch: 1,
      log,
      artifacts,
      signer,
      verifier,
      submission: {
        authenticate() {},
        authorize() {},
      },
      authority: {
        decideAtPrefix: () => ({ committed: true, commitRevision: 1 }),
      },
      projection: { async project() {} },
      delivery: new OwnerDeliveryParticipant({
        authority: new DeliveryAuthority({ log, anchorEpoch: 1 }),
      }),
      clock: () => NOW,
    });
  const journal = makeJournal();
  const adapter = new AnchorSessionStateAdapter({ journalFor: () => journal });
  let requestSeq = 0;
  const write = (events: readonly AdvancementControlEvent[], requestId?: string) =>
    adapter.mutate(
      conversationId,
      { kind: "advancement-event", events },
      hostCtx(requestId ?? `req-write-${++requestSeq}`),
    );
  const read = () =>
    adapter.readAdvancementState(conversationId, hostCtx(`req-read-${++requestSeq}`));
  return { artifacts, log, journal, adapter, makeJournal, write, read };
}

function hostCtx(requestId: string): AuthorityCallContext {  return {
    principal: { kind: "host", component: "advancement-test" },
    requestId,
    deadlineAt: EXPIRY,
  };
}

function task(text: string): UserTurnInput {
  return { parts: [{ type: "text", text }] };
}

function draft(id = "draft-1"): RubricContractDraftSnapshot {
  return {
    draftId: id,
    originalTurnId: "turn-1",
    source: "generated",
    candidateRubricIds: [],
    title: "代码审查推进准则",
    description: "用于判断开发任务是否完成",
    content: {
      passCriteria: ["测试通过", "实现满足需求"],
      evidenceRequirements: [
        { id: "tests", kind: "test-result", description: "测试结果需要通过", required: true },
      ],
      failureHandling: [
        { id: "fix-tests", scenario: "测试失败", reply: "请修复失败测试后再继续。" },
      ],
    },
    createdAt: NOW,
  };
}

function confirmed(): ConfirmedRubricSnapshot {
  const content = draft().content;
  return {
    source: { kind: "library", rubricId: "rubric-code-review", rubricVersion: "v1" },
    title: "代码审查推进准则",
    description: "用于判断开发任务是否完成",
    content: {
      passCriteria: content.passCriteria.map((text, index) => ({
        id: `pc-${index + 1}`,
        text,
      })),
      evidenceRequirements: content.evidenceRequirements,
      failureHandling: content.failureHandling,
    },
    confirmedAt: NOW,
    confirmedBy: "user",
  };
}

function createdEvent(
  extra: Partial<CreateAdvancementSessionInput> = {},
): AdvancementControlEvent {
  const input: CreateAdvancementSessionInput = {
    id: "session-1",
    conversationId: "conv-1",
    originalUserTask: task("把测试修到全绿"),
    pendingRubricDraft: draft(),
    createdAt: NOW,
    ...extra,
  };
  return {
    type: "session_created",
    timestamp: input.createdAt ?? NOW,
    sessionId: input.id,
    conversationId: input.conversationId,
    originalUserTask: input.originalUserTask,
    pendingRubricDraft: input.pendingRubricDraft,
  };
}

function review(extra: Partial<AdvancementRunReview> = {}): AdvancementRunReview {
  const value = {
    id: "review-1",
    runIndex: 0,
    reviewedAt: NOW,
    decision: "failed",
    evidence: [],
    attribution: {
      criteria: [
        { criterionId: "pc-1", verdict: "unmet", reason: "仍有 1 个测试失败" },
      ],
    },
    unmetCriteria: ["测试通过"],
    selectedFailureHandlingId: "fix-tests",
    proxyMessageId: "proxy-1",
    ...extra,
  };
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as unknown as AdvancementRunReview;
}

function reviewedEvent(extra: Partial<AdvancementRunReview> = {}): AdvancementControlEvent {
  return {
    type: "run_reviewed",
    timestamp: NOW,
    sessionId: "session-1",
    review: review(extra),
  };
}

function proxyMessage(extra: Partial<AdvancementProxyMessage> = {}): AdvancementProxyMessage {
  return {
    id: "proxy-1",
    sessionId: "session-1",
    reviewId: "review-1",
    content: task("请继续修复失败测试"),
    rubricFailureHandlingId: "fix-tests",
    variables: { unmet_criteria: "测试通过" },
    attribution: { criteria: [] },
    createdAt: NOW,
    ...extra,
  };
}

function exit(reason: AdvancementExit["reason"]): AdvancementExit {
  return { reason, message: "收场", occurredAt: NOW };
}

function signLease(
  payload: Omit<ResourceLease, "digest" | "signature"> & Record<string, unknown>,
): ResourceLease {
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: signer.sign("ResourceLease", 1, withDigest),
  };
}

function evidenceRequest(): EvidenceRequest {
  const parent = signLease({
    v: 1,
    reservationId: "rsv-review-1",
    admissionClass: "advancement",
    workload: { kind: "control", id: "review-1", attempt: 1 },
    scopeBinding: { kind: "conversation", conversationId: "conv-1", ownerEpoch: 1 },
    audience: { executorId: "executor-1" },
    budget: { maxCalls: 8 },
    domain: { kind: "anchor", anchorEpoch: 1 },
    issuedAt: NOW,
    expiry: EXPIRY,
  });
  const lease = signLease({
    v: 1,
    reservationId: "rsv-evidence-1",
    parentId: parent.reservationId,
    parentDigest: parent.digest,
    admissionClass: "advancement",
    workload: { kind: "evidence", id: "req-1", attempt: 1 },
    scopeBinding: { kind: "conversation", conversationId: "conv-1", ownerEpoch: 1 },
    audience: { executorId: "executor-1" },
    budget: { maxCalls: 4 },
    domain: parent.domain,
    issuedAt: NOW,
    expiry: EXPIRY,
  });
  return createSignedEvidenceRequest(
    {
      v: 1,
      requestId: "req-1",
      reviewId: "review-1",
      runId: "run-1",
      conversationId: "conv-1",
      ownerEpoch: 1,
      executorId: "executor-1",
      workspace: { bindingRef: "workspace-1", workspaceBindingRevision: 3 },
      items: [{ kind: "file-diff", locator: {} }],
      lease,
      issuedAt: NOW,
      expiry: EXPIRY,
    },
    verifier,
    signer,
  );
}

describe("AnchorSessionStateAdapter advancement", () => {
  it("承载完整推进生命周期并复合原子落盘", async () => {
    const { write, read, log } = await createHarness();

    await write([createdEvent()]);
    expect((await read())?.status).toBe("awaiting-rubric-confirmation");

    await write([
      { type: "rubric_confirmed", timestamp: NOW, sessionId: "session-1", confirmedRubric: confirmed() },
    ]);
    expect((await read())?.status).toBe("active");

    await write([
      reviewedEvent(),
      { type: "proxy_enqueued", timestamp: NOW, sessionId: "session-1", proxyMessage: proxyMessage() },
    ]);
    expect((await read())?.outstandingProxyMessageId).toBe("proxy-1");

    await write([
      { type: "proxy_settled", timestamp: NOW, sessionId: "session-1", proxyMessageId: "proxy-1" },
    ]);
    expect((await read())?.outstandingProxyMessageId).toBeUndefined();

    await write([
      reviewedEvent({ id: "review-2", decision: "passed", proxyMessageId: undefined }),
      { type: "completed", timestamp: NOW, sessionId: "session-1", exit: exit("passed") },
    ]);
    const head = await read();
    expect(head?.status).toBe("completed");
    expect(head?.runs).toHaveLength(2);

    const commits = await log.readAll();
    const lastAdvancementCommit = commits
      .filter((commit) =>
        commit.entries.some(
          (entry) =>
            entry.stream === "run:conv-1" &&
            (entry.body as { t?: string }).t === "advancement-event",
        ),
      )
      .at(-1)!;
    const terminalRecords = lastAdvancementCommit.entries.filter(
      (entry) => (entry.body as { t?: string }).t === "advancement-event",
    );
    expect(terminalRecords).toHaveLength(2);
  });

  it("重复 requestId 回放原结果，异载荷拒绝", async () => {
    const { adapter } = await createHarness();
    const events: AdvancementControlEvent[] = [createdEvent()];

    const first = await adapter.mutate(
      "conv-1",
      { kind: "advancement-event", events },
      hostCtx("req-write-1"),
    );
    const replayed = await adapter.mutate(
      "conv-1",
      { kind: "advancement-event", events },
      hostCtx("req-write-1"),
    );
    expect(replayed.revision).toBe(first.revision);

    await expect(
      adapter.mutate(
        "conv-1",
        { kind: "advancement-event", events: [createdEvent({ id: "session-other" })] },
        hostCtx("req-write-1"),
      ),
    ).rejects.toThrow("conflicting durable payloads");
  });

  it("非 host principal 与其它 mutation kind 被拒绝", async () => {
    const { adapter } = await createHarness();
    await expect(
      adapter.mutate(
        "conv-1",
        { kind: "advancement-event", events: [createdEvent()] },
        {
          principal: {
            kind: "surface",
            surfacePrincipal: "surface:user-1",
            connectionId: "conn-1",
          },
          requestId: "req-surface-1",
          deadlineAt: EXPIRY,
        },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });

    await expect(
      adapter.mutate(
        "conv-1",
        { kind: "window-op", op: "clear" },
        hostCtx("req-kind-1"),
      ),
    ).rejects.toMatchObject({ code: "capability-gap" });
  });

  it("领域前置违规按控制日志同规则拒绝", async () => {
    const { write } = await createHarness();
    await write([createdEvent()]);
    await expect(write([createdEvent({ id: "session-2" })])).rejects.toThrow(
      "already has an open advancement session",
    );
    await write([
      { type: "rubric_confirmed", timestamp: NOW, sessionId: "session-1", confirmedRubric: confirmed() },
    ]);
    await expect(
      write([
        { type: "rubric_confirmed", timestamp: NOW, sessionId: "session-1", confirmedRubric: confirmed() },
      ]),
    ).rejects.toThrow("is not awaiting rubric confirmation");
    await expect(
      write([
        { type: "proxy_settled", timestamp: NOW, sessionId: "session-1", proxyMessageId: "proxy-missing" },
      ]),
    ).rejects.toThrow('proxy message "proxy-missing" is not outstanding');
  });

  it("重启重放得到同一会话状态", async () => {
    const { write, makeJournal } = await createHarness();
    await write([createdEvent()]);
    await write([
      { type: "rubric_confirmed", timestamp: NOW, sessionId: "session-1", confirmedRubric: confirmed() },
    ]);
    await write([
      reviewedEvent(),
      { type: "proxy_enqueued", timestamp: NOW, sessionId: "session-1", proxyMessage: proxyMessage() },
    ]);

    const restarted = makeJournal();
    const sessions = await restarted.advancementSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "session-1",
      status: "active",
      outstandingProxyMessageId: "proxy-1",
    });
    expect(sessions[0]?.runs).toHaveLength(1);
  });

  it("超大任务经内容寻址落盘并可折叠", async () => {
    const { write, read, log } = await createHarness();
    const bigTask = task(`把测试修到全绿：${"详".repeat(20_000)}`);
    await write([createdEvent({ originalUserTask: bigTask })]);
    expect((await read())?.originalUserTask).toEqual(bigTask);
    const stream = await log.readStream("run:conv-1");
    const record = stream.find(
      (entry) => (entry.body as { t?: string }).t === "advancement-event",
    );
    expect(record).toBeDefined();
    expect(
      typeof (record!.body as { event?: { ref?: unknown } }).event?.ref,
    ).toBe("object");
  });

  it("跨对话绑定：他对话的会话事件被拒绝", async () => {
    const { write, adapter } = await createHarness();
    await write([createdEvent()]);
    await write([
      { type: "rubric_confirmed", timestamp: NOW, sessionId: "session-1", confirmedRubric: confirmed() },
    ]);
    await expect(
      adapter.mutate(
        "conv-2",
        { kind: "advancement-event", events: [reviewedEvent()] },
        hostCtx("req-stray-1"),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("证据事件折叠出 pending 投影并随结算关闭", async () => {
    const { write, read } = await createHarness();
    await write([createdEvent()]);
    await write([
      { type: "rubric_confirmed", timestamp: NOW, sessionId: "session-1", confirmedRubric: confirmed() },
    ]);
    await write([reviewedEvent()]);

    const request = evidenceRequest();
    const requestDigest = protocolDigest("EvidenceRequest", 1, (() => {
      const { signature: _sig, ...payload } = request;
      return payload;
    })());

    await write([
      {
        type: "evidence_requested",
        timestamp: NOW,
        sessionId: "session-1",
        attempt: {
          requestId: "req-1",
          reviewId: "review-1",
          attempt: 1,
          request,
          itemRequirements: [{ itemIndex: 0, requirementIds: ["tests"] }],
          requestDigest,
        },
      },
    ]);
    let head = await read();
    expect(head?.evidence?.pending).toHaveLength(1);
    expect(head?.evidence?.pending[0]).toMatchObject({
      requestId: "req-1",
      reviewId: "review-1",
    });
    expect(head?.evidence?.pending[0]?.outcome).toBeUndefined();

    await write([
      {
        type: "evidence_result",
        timestamp: NOW,
        sessionId: "session-1",
        requestId: "req-1",
        outcome: { kind: "typed-stale" },
      },
    ]);
    head = await read();
    expect(head?.evidence?.pending[0]?.outcome).toEqual({ kind: "typed-stale" });

    await write([
      {
        type: "evidence_settled",
        timestamp: NOW,
        sessionId: "session-1",
        requestId: "req-1",
        settlement: "deferred",
      },
    ]);
    head = await read();
    expect(head?.evidence).toBeUndefined();
  });

  it("会话删除后推进写入被拒（删除闭包归对话权威）", async () => {
    const { artifacts, log, journal, write } = await createHarness();
    await write([createdEvent()]);

    const admission = new ControlAdmissionJournal(log, artifacts);
    const authority = await journal.authorityState();
    const principal = {
      surfacePrincipal: "surface:user-1",
      deviceId: "device-1",
      connectionId: "conn-1",
    };
    const envelope = createConversationControlEnvelope({
      requestId: "req-delete-1",
      source: { principal },
      at: NOW,
      body: {
        t: "session-write",
        conversationId: "conv-1",
        mutation: { kind: "conversation-delete" },
        ownerEpoch: 1,
        domainRevision: authority.domainRevision,
      },
    });
    const outcome = await journal.applyControl({
      admission,
      envelope,
      source: { principal },
    });
    expect(outcome.kind).toBe("applied");

    await expect(write([reviewedEvent()])).rejects.toThrow(
      "durably deleted",
    );
  });
});
