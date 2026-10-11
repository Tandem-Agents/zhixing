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
import {
  advancementEvidenceRequestId,
  type AdvancementControlEvent,
} from "@zhixing/core/advancement";
import {
  canonicalize, createMutationBatch, createConversationSealedBundle, sealedBundleArtifact,
  createSignedEvidenceRequest,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { isHoldingMaintenanceExclusion, StorageMaintenanceAdmissionError } from "@zhixing/core/resources";
import {
  ControlAdmissionJournal,
  createConversationControlEnvelope,
} from "../control-admission.js";
import { ConversationRunJournal } from "../conversation-assignment.js";
import { createOwnerDeliveryParticipant } from "../delivery.js";
import { ConversationSessionStateAdapter } from "../session-state-adapter.js";
import {
  DURABLE_IO_TEST_TIMEOUT_MS,
  trackAuthorityLog,
} from "./durable-io-test-support.js";

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
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  }));
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
      delivery: createOwnerDeliveryParticipant({
        authority: new DeliveryAuthority({ log, anchorEpoch: 1 }),
      }),
      clock: () => NOW,
    });
  const journal = makeJournal();
  let directoryExists = true;
  const adapter = new ConversationSessionStateAdapter({
    journalFor: () => journal,
    sessionExists: async () => directoryExists,
  });
  let requestSeq = 0;
  const write = (events: readonly AdvancementControlEvent[], requestId?: string) =>
    adapter.mutate(
      conversationId,
      { kind: "advancement-event", events },
      hostCtx(requestId ?? `req-write-${++requestSeq}`),
    );
  const read = () =>
    adapter.readAdvancementState(conversationId, hostCtx(`req-read-${++requestSeq}`));
  return {
    artifacts,
    log,
    journal,
    adapter,
    makeJournal,
    write,
    read,
    removeDirectoryIdentity: () => {
      directoryExists = false;
    },
  };
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

function confirmedEvent(): AdvancementControlEvent {
  const originalUserTask = task("把测试修到全绿");
  return {
    type: "rubric_confirmed",
    timestamp: NOW,
    sessionId: "session-1",
    confirmedRubric: confirmed(),
    admissionIntent: {
      turnId: "turn-1",
      surfacePrincipal: "surface:test",
      turnOrigin: { channel: "rpc", triggeredBy: "surface:test" },
      inputDigest: protocolDigest(
        "AdvancementOriginalTaskInput",
        1,
        originalUserTask,
      ),
    },
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
    attribution: review().attribution,
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
  const requestId = advancementEvidenceRequestId("review-1", 1, 1);
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
    workload: { kind: "evidence", id: requestId, attempt: 1 },
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
      requestId,
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

describe("ConversationSessionStateAdapter advancement", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("承载完整推进生命周期并复合原子落盘", async () => {
    const { write, read, log } = await createHarness();

    await write([createdEvent()]);
    expect((await read())?.status).toBe("awaiting-rubric-confirmation");

    await write([
      confirmedEvent(),
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
      reviewedEvent({
        id: "review-2",
        runIndex: 1,
        decision: "passed",
        proxyMessageId: undefined,
      }),
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

  it("fresh 推进写入要求会话身份，既有 request 在身份删除后仍可全等回放", async () => {
    const { adapter, log, removeDirectoryIdentity } = await createHarness();
    removeDirectoryIdentity();

    await expect(
      adapter.mutate(
        "conv-1",
        { kind: "advancement-event", events: [createdEvent()] },
        hostCtx("req-unknown"),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(await log.readAll()).toHaveLength(0);

    const known = await createHarness("conv-known");
    const knownEvents = [createdEvent({ conversationId: "conv-known" })];
    const first = await known.adapter.mutate(
      "conv-known",
      { kind: "advancement-event", events: knownEvents },
      hostCtx("req-replay"),
    );
    known.removeDirectoryIdentity();
    const replay = await known.adapter.mutate(
      "conv-known",
      { kind: "advancement-event", events: knownEvents },
      hostCtx("req-replay"),
    );
    expect(replay).toEqual(first);
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
      confirmedEvent(),
    ]);
    await expect(
      write([
        confirmedEvent(),
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
      confirmedEvent(),
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
      confirmedEvent(),
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
      confirmedEvent(),
    ]);
    const request = evidenceRequest();
    const requestId = request.requestId;
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
          requestId,
          reviewId: "review-1",
          generation: 1,
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
      requestId,
      reviewId: "review-1",
    });
    expect(head?.evidence?.pending[0]?.outcome).toBeUndefined();

    await write([
      {
        type: "evidence_result",
        timestamp: NOW,
        sessionId: "session-1",
        requestId,
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
        requestId,
        settlement: "deferred",
      },
    ]);
    head = await read();
    expect(head?.evidence).toEqual({
      pending: [],
      generations: [
        { runId: "run-1", reviewId: "review-1", generation: 1, lastAttempt: 1 },
      ],
    });
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


it('directory advancement reads skip historical execution artifacts and load external events outside exclusions', async () => {
  const h = await createHarness();
  await h.journal.admit({ ingressKey: 'old-input', runId: 'old-run', queuedPosition: 0,
    userInput: task('historical input '.repeat(4000)), invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: 'old-input', receivedAt: NOW } });
  await h.journal.cancelRun({ runId: 'old-run', requestId: 'cancel-old' });
  await h.write([createdEvent({ originalUserTask: task('advancement '.repeat(4000)) })]);
  const records = await h.log.readStream('run:conv-1');
  const eventRef = (records.find(entry => (entry.body as any).t === 'advancement-event')!.body as any).event.ref;
  const get = h.artifacts.get.bind(h.artifacts);
  const reads = vi.spyOn(h.artifacts, 'get').mockImplementation(async ref => {
    expect(ref.digest).toBe(eventRef.digest);
    expect(isHoldingMaintenanceExclusion()).toBe(false);
    return get(ref);
  });
  try {
    const restarted = h.makeJournal();
    expect((await restarted.advancementSessions())[0]?.id).toBe('session-1');
    expect(reads).toHaveBeenCalledTimes(1);
    await restarted.advancementSessions();
    expect(reads).toHaveBeenCalledTimes(1);
  } finally { reads.mockRestore(); }
}, 20000);

it('advancement reads combine verified imported authority with the local tail', async () => {
  const source = await createHarness(); await source.write([createdEvent()]);
  const sourceSnapshot = await source.log.readSnapshot<unknown>();
  const target = await createHarness(), local = await target.log.readSnapshot<unknown>();
  await target.journal.primeRecoverySnapshot({ commits: sourceSnapshot.commits, cursor: local.cursor });
  await target.journal.primeImportedReadBase(sourceSnapshot.commits.flatMap(envelope => envelope.entries.map(record => ({ ...record, lsn: envelope.lsn, at: envelope.at }))) as any);
  expect((await target.journal.advancementSessions())[0]?.status).toBe('awaiting-rubric-confirmation');
  await target.journal.applyAdvancementEvents({ requestId: 'local-confirm', events: [confirmedEvent()] });
  expect((await target.journal.advancementSessions())[0]?.status).toBe('active');
}, 20000);

it('advancement cold read recovers temporary artifact pressure without entering a serial exclusion', async () => {
  const h = await createHarness(); await h.write([createdEvent({ originalUserTask: task('large '.repeat(10000)) })]);
  const get = h.artifacts.get.bind(h.artifacts); let calls = 0;
  const spy = vi.spyOn(h.artifacts, 'get').mockImplementation(async ref => {
    expect(isHoldingMaintenanceExclusion()).toBe(false);
    if (++calls === 1) throw new StorageMaintenanceAdmissionError({ kind: 'backpressured', blockedBy: 'probe-unavailable', retryAfterMs: 1 });
    return get(ref);
  });
  try { expect((await h.makeJournal().advancementSessions())[0]?.id).toBe('session-1'); expect(calls).toBe(2); }
  finally { spy.mockRestore(); }
}, 20000);

it('advancement reads preserve the shared session revision guard', async () => {
  const h = await createHarness(); await h.write([createdEvent()]);
  await h.log.append([{ stream: 'run:conv-1', body: { t: 'session-control', requestId: 'rename', domainRevision: 2, mutation: { kind: 'session-meta', patch: { name: 'renamed' } } } }]);
  const entry = (await h.log.readStream('run:conv-1')).find(entry => (entry.body as any).t === 'advancement-event')!;
  await h.log.append([{ stream: 'run:conv-1', body: { ...(entry.body as any), requestId: 'conflicting-new-write', domainRevision: 2, event: confirmedEvent() } }]);
  await expect(h.makeJournal().advancementSessions()).rejects.toThrow('Advancement event domain revision is not monotonic');
});


it.each(['cold', 'warm', 'imported'] as const)('session read includes committed session mutations: %s', async mode => {
  const source = await createHarness(); await source.write([createdEvent()]);
  const reader = source.makeJournal(); if (mode === 'warm') await reader.advancementSessions();
  const firstTasks = {items:[{id:'staged',content:'staged task',status:'pending' as const}]};
  const batch = createMutationBatch('commit-assignment', [
    { v:1, t:'staged-mutation', seq:1, domain:'session', requestId:'commit-first', mutation:{kind:'task-list-op',op:{op:'set',state:firstTasks}}},
    { v:1, t:'staged-mutation', seq:2, domain:'session', requestId:'commit-rename', mutation:{kind:'task-list-op',op:{op:'set',state:{items:[]}}}},
  ]);
  const ref = await source.artifacts.put(Buffer.from(canonicalize(batch)));
  const bundle = createConversationSealedBundle({ assignmentId:'commit-assignment', executorId:'executor-test',
    streamFinal:{finalSeq:1,streamDigest:'sha256:'+'0'.repeat(64)},usage:{inputTokens:0,outputTokens:0,toolCalls:0},usageFinal:{reportDigest:'sha256:'+'0'.repeat(64),upToUsageSeq:0},dependencyArtifacts:[],
    body:{t:'conversation',runId:'committed-run',conversationId:'conv-1',ownerEpoch:1,baseRevision:0,
      runRecord:{type:'run',runId:'committed-run',runIndex:1,timestamp:NOW,messages:[{role:'user',content:[{type:'text',text:'session mutation'}]}]},
      contentAssets:[],mutationBatch:{ref,sessionCount:2,globalCount:0}}});
  const dummy = await source.artifacts.put(sealedBundleArtifact(bundle).bytes);
  await source.log.append([
    {stream:'run:conv-1',body:{t:'committed',runId:'committed-run',assignmentId:'commit-assignment',commitRevision:1,bundle:{ref:dummy}}},
    {stream:'run:conv-1',body:{kind:'content-asset-index',entries:[]}},
    {stream:'final-outbox',body:{t:'final',conversationId:'conv-1',runId:'committed-run',commitRevision:1,digest:dummy.digest,state:'pending'}},
    {stream:'publish',body:{t:'publish-decision',assignmentId:'commit-assignment',batch:{ref},sessionCount:2,globalCount:0,outcomes:[{seq:1,outcome:{t:'granted',targetRevision:2}},{seq:2,outcome:{t:'granted',targetRevision:3}}]}},
    {stream:'publish',body:{t:'publish-progress',assignmentId:'commit-assignment',domain:'session',state:'pending',upToSeq:0}},
  ]);
  const later = {stream:'run:conv-1',body:{t:'session-control',requestId:'after-commit',domainRevision:4,mutation:{kind:'session-meta',patch:{name:'later name'}}}};
  if (mode === 'imported') {
    const target = await createHarness(); await target.artifacts.put(Buffer.from(canonicalize(batch)));
    const snapshot = await source.log.readSnapshot<unknown>();
    await target.journal.primeImportedReadBase(snapshot.commits.flatMap(e => e.entries.map(r => ({...r,lsn:e.lsn,at:e.at}))) as any);
    await target.log.append([later]);
    expect(await target.journal.taskListBeforeMutation('commit-rename')).toEqual(firstTasks);
    expect(await target.journal.taskListBeforeMutation('commit-first')).toEqual({items:[]});
    expect((await target.journal.advancementSessions())[0]?.id).toBe('session-1');
    expect(await target.journal.sessionMutationRequest('commit-rename')).toMatchObject({domainRevision:3});
    expect(await target.journal.sessionMutationRequest('after-commit')).toMatchObject({domainRevision:4});
  } else {
    await source.log.append([later]);
    expect(await reader.taskListBeforeMutation('commit-rename')).toEqual(firstTasks);
    expect(await reader.taskListBeforeMutation('commit-first')).toEqual({items:[]});
    expect((await reader.advancementSessions())[0]?.id).toBe('session-1');
    expect(await reader.sessionMutationRequest('after-commit')).toMatchObject({domainRevision:4});
  }
}, 20000);

it('warm session read recovers external advancement tails outside the owner queue', async () => {
  const h = await createHarness(), reader = h.makeJournal();
  expect(await reader.advancementSessions()).toEqual([]);
  await h.write([createdEvent({originalUserTask:task('external '.repeat(8000))})]);
  const get = h.artifacts.get.bind(h.artifacts); let blocked = false;
  const spy = vi.spyOn(h.artifacts,'get').mockImplementation(async ref => {
    if (isHoldingMaintenanceExclusion()) { blocked = true; throw new StorageMaintenanceAdmissionError({kind:'backpressured',blockedBy:'probe-unavailable',retryAfterMs:1}); }
    return get(ref);
  });
  try {expect((await reader.advancementSessions())[0]?.id).toBe('session-1');expect(blocked).toBe(false);}
  finally {spy.mockRestore();}
}, 20000);

it('task-list retry base remains the original session input after later mutations and restart', async () => {
  const h = await createHarness();
  const first = {items:[{id:'first',content:'first task',status:'pending'}]};
  await h.log.append([{stream:'run:conv-1',body:{t:'session-control',requestId:'first',domainRevision:1,mutation:{kind:'task-list-op',op:{op:'set',state:first}}}}]);
  await h.log.append([{stream:'run:conv-1',body:{t:'session-control',requestId:'second',domainRevision:2,mutation:{kind:'task-list-op',op:{op:'set',state:{items:[]}}}}}]);
  const reader = h.makeJournal(), all = vi.spyOn(h.log,'readSnapshot').mockRejectedValue(Error('whole log forbidden'));
  try {
    expect(await reader.taskListBeforeMutation('second')).toEqual(first);
    expect(await reader.taskList()).toEqual({items:[]});
    expect(await reader.taskListBeforeMutation('first')).toEqual({items:[]});
    expect(await reader.taskListBeforeMutation('missing')).toBeUndefined();
    expect(all).not.toHaveBeenCalled();
  } finally {all.mockRestore();}
});

it('task-list late retries preserve no-op and pre-clear inputs within one envelope', async () => {
  const h = await createHarness();
  const first = {items:[{id:'a',content:'original',status:'pending'}]};
  const control = (requestId: string, domainRevision: number, state: unknown) => ({stream:'run:conv-1',body:{t:'session-control',requestId,domainRevision,mutation:{kind:'task-list-op',op:{op:'set',state}}}});
  await h.log.append([control('first',1,first),control('no-effect',2,first)]);
  await h.log.append([{stream:'run:conv-1',body:{t:'session-lifecycle',requestId:'clear-list',domainRevision:3,mutation:'clear'}}]);
  await h.log.append([control('after-clear',4,{items:[]})]);
  const reader = h.makeJournal();
  expect(await reader.taskListBeforeMutation('no-effect')).toEqual(first);
  expect(await reader.taskListBeforeMutation('after-clear')).toEqual({items:[]});
  expect(await reader.taskListBeforeMutation('first')).toEqual({items:[]});
  expect(await reader.taskList()).toEqual({items:[]});
});

it('session batch read crosses 64 frames and discards failed partial state', async () => {
  const h = await createHarness();
  for (let revision=1;revision<=66;revision++) await h.log.append([{stream:'run:conv-1',body:{t:'session-control',requestId:'batch-'+revision,domainRevision:revision,
    mutation:{kind:'task-list-op',op:{op:'set',state:{items:[{id:'item-'+revision,content:'task '+revision,status:'pending'}]}}}}}]);
  const reader=h.makeJournal(), read=h.log.readEnvelopesAt.bind(h.log); let failed=false;
  const spy=vi.spyOn(h.log,'readEnvelopesAt').mockImplementation(async points=>{
    if (!failed && points[0]?.lsn>64) {failed=true;throw Error('second batch unavailable');}
    return read(points);
  });
  try {
    await expect(reader.taskList()).rejects.toThrow('second batch unavailable');
    expect((await reader.taskList()).items[0]?.id).toBe('item-66');
    expect((await reader.taskListBeforeMutation('batch-66'))?.items[0]?.id).toBe('item-65');
    expect((await reader.taskList()).items[0]?.id).toBe('item-66');
    expect(spy.mock.calls.some(([points])=>points.length===64)).toBe(true);
  } finally {spy.mockRestore();}
},30000);

it("retains exact cancelled direct intent across a new head and authority replay", async () => {
  const h = await createHarness();
  await h.write([createdEvent()]);
  const confirmation = confirmedEvent();
  if (confirmation.type !== "rubric_confirmed") throw Error("fixture");
  await h.write([{ type: "original_task_directed", timestamp: NOW, sessionId: "session-1", admissionIntent: confirmation.admissionIntent,
    exit: { reason: "user-cancelled", message: "直接执行", occurredAt: NOW } }]);
  await h.write([createdEvent({ id: "session-new" })]);
  const recovered = h.makeJournal();
  const adapter = new ConversationSessionStateAdapter({ journalFor: () => recovered, sessionExists: async () => true });
  expect((await adapter.readAdvancementState("conv-1", hostCtx("head")))?.id).toBe("session-new");
  expect(await adapter.listPendingAdvancementOriginalTasks("conv-1", hostCtx("pending"))).toEqual({ sessionIds: ["session-1"] });
  expect(await adapter.readAdvancementState("conv-1", hostCtx("exact"), "session-1")).toMatchObject({ status: "cancelled", originalTaskAdmission: { mode: "direct", status: "pending" } });
  await adapter.mutate("conv-1", { kind: "advancement-event", events: [{ type: "original_task_admitted", sessionId: "session-1", timestamp: NOW, turnId: "turn-1", inputDigest: confirmation.admissionIntent.inputDigest, runId: "run-direct" }] }, hostCtx("settle-direct"));
  expect(await adapter.listPendingAdvancementOriginalTasks("conv-1", hostCtx("done"))).toEqual({ sessionIds: [] });
  await expect(adapter.listPendingAdvancementOriginalTasks("conv-1", { ...hostCtx("forbidden"), principal: { kind: "surface", surfacePrincipal: "surface:test", connectionId: "conn-test" } } as never)).rejects.toThrow();
}, DURABLE_IO_TEST_TIMEOUT_MS);

it("advancement submission receipt shares the business commit and survives head replacement", async () => {
  const { advancementSubmissionRequestId } = await import("@zhixing/core/advancement");
  const h = await createHarness();
  const identity = { surfacePrincipal: "surface:test", submissionId: "turn-submission", requestDigest: protocolDigest("Submission", 1, { text: "task" }) };
  const requestId = advancementSubmissionRequestId("conv-1", identity.surfacePrincipal, identity.submissionId);
  const created = createdEvent();
  if (created.type !== "session_created") throw Error("fixture");
  const receipt = { identity, outcome: { kind: "draft-saved" as const, disposition: "original-saved" as const, sessionId: "session-1",
    draftId: created.pendingRubricDraft.draftId, draftVersion: 0, originalTurnId: created.pendingRubricDraft.originalTurnId } };
  const events: AdvancementControlEvent[] = [created, { type: "submission_settled", conversationId: "conv-1", timestamp: NOW, receipt }];
  await expect(h.write([created, { ...events[1]!, receipt: { ...receipt, outcome: { ...receipt.outcome, draftId: "wrong-draft" } } } as AdvancementControlEvent], requestId)).rejects.toThrow("does not bind");
  expect(await h.read()).toBeNull();
  await h.write(events, requestId);
  await h.write([{ type: "cancelled", timestamp: NOW, sessionId: "session-1" }]);
  await h.write([createdEvent({ id: "session-new" })]);
  const replayed = h.makeJournal();
  const adapter = new ConversationSessionStateAdapter({ journalFor: () => replayed });
  expect(await adapter.readAdvancementSubmission("conv-1", identity, hostCtx("receipt"))).toEqual(receipt);
  expect(await adapter.readAdvancementSubmission("conv-1", { ...identity, surfacePrincipal: "surface:other" }, hostCtx("other"))).toBeNull();
  expect((await adapter.readAdvancementState("conv-1", hostCtx("head")))?.id).toBe("session-new");
  await h.write(events, requestId);
  await expect(h.write([created, { type: "submission_settled", conversationId: "conv-1", timestamp: NOW, receipt: { ...receipt, identity: { ...identity, requestDigest: protocolDigest("Submission", 1, { text: "changed" }) } } }], requestId)).rejects.toThrow("conflicting durable payloads");
}, DURABLE_IO_TEST_TIMEOUT_MS);
