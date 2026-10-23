import { Buffer } from "node:buffer";
import path from "node:path";
import fs from "node:fs/promises";
import { readConversationSubmissionState } from '../conversation-run-state-index.js';
import {
  AuthorityCacheIntegrity, FileDurableProjectionIndex, durableProjectionDirectoryName,
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
  createSignedEvidenceRequest, createSignedTrustRuleSnapshot,
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
import { ConversationRunJournal, pendingAdvancementConversations, startConversationDecisionMigration } from "../conversation-assignment.js";
import { createOwnerDeliveryParticipant } from "../delivery.js";
import { ConversationSessionStateAdapter } from "../session-state-adapter.js";
import {
  DURABLE_IO_TEST_TIMEOUT_MS,
  trackAuthorityLog,
} from "./durable-io-test-support.js";
import { importAuthenticatedBase, installVerifiedAnchorTenure } from "./imported-base-fixture.js";

const NOW = "2026-08-02T00:00:00.000Z";
const EXPIRY = "2026-08-02T01:00:00.000Z";
const CONTROL_EXPIRY = "2026-08-02T00:00:30.000Z";

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

async function createHarness(conversationId = "conv-1", ownerEpoch = 1, journalVerifier = verifier, integrity?: AuthorityCacheIntegrity) {
  const root = await createTempDir("session-state-adapter");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000, integrity,
  }));
  const makeJournal = (ownerLog = log) =>
    new ConversationRunJournal({
      conversationId,
      ownerEpoch,
      log: ownerLog,
      artifacts,
      signer,
      verifier: journalVerifier,
      submission: {
        authenticate() {},
        authorize() {},
      },
      authority: {
        decideAtPrefix: () => ({ committed: true, commitRevision: 1 }),
      },
      projection: { async project() {} },
      delivery: createOwnerDeliveryParticipant({
        authority: new DeliveryAuthority({ log: ownerLog, anchorEpoch: 1 }),
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


async function seedCommittedSessionMutations(h: Awaited<ReturnType<typeof createHarness>>) {
  const firstTasks = { items: [{ id: 'staged', content: 'staged task', status: 'pending' as const }] };
  const batch = createMutationBatch('commit-assignment', [
    { v: 1, t: 'staged-mutation', seq: 1, domain: 'session', requestId: 'commit-first', mutation: { kind: 'task-list-op', op: { op: 'set', state: firstTasks } } },
    { v: 1, t: 'staged-mutation', seq: 2, domain: 'session', requestId: 'commit-rename', mutation: { kind: 'task-list-op', op: { op: 'set', state: { items: [] } } } },
  ]);
  const ingress = { kind: 'first-party' as const, surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: 'committed-input', receivedAt: NOW };
  await h.journal.admit({
    ingressKey: 'committed-input', runId: 'committed-run', queuedPosition: 0,
    userInput: task('session mutation'), invocation: { kind: 'agent', source: 'interactive' }, ingress,
  });
  const windowRef = await h.artifacts.put(Buffer.from(canonicalize([{ role: 'user', content: [{ type: 'text', text: 'session mutation' }] }])));
  const trust = createSignedTrustRuleSnapshot({ snapshotVersion: 1, rules: [], generatedAt: NOW }, signer);
  const manifestBody = { v: 1 as const, baseRef: { execution: 'conversation' as const, conversationId: 'conv-1', baseRevision: 0 },
    requires: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1, skillsRev: 1, rubricsRev: 1, promptAssetsRev: 1, permissionSnapshotVersion: 1 },
    protocolVersion: '1', tools: [], mcpServers: [], environment: {}, credentialBindings: [] };
  const controlBody = { v: 1 as const, controlLeaseId: 'control-1', assignmentId: 'commit-assignment',
    authority: { execution: 'conversation' as const, conversationId: 'conv-1', ownerEpoch: 1 }, renewalSeq: 1, issuedAt: NOW, expiry: CONTROL_EXPIRY };
  const permissionBody = { v: 1 as const, snapshotVersion: 1, snapshotDigest: trust.digest,
    binding: { execution: 'conversation' as const, runId: 'committed-run', conversationId: 'conv-1', ownerEpoch: 1 },
    assignmentId: 'commit-assignment', executorId: 'executor-test', controlLeaseId: 'control-1', issuedAt: NOW, expiry: CONTROL_EXPIRY };
  const capabilityBody = { v: 1 as const, capId: 'capability-1', executorId: 'executor-test',
    scope: { execution: 'conversation' as const, conversationId: 'conv-1' }, ownerEpoch: 1,
    methods: ['submission.submitBundle'] as const, resources: ['conversation:conv-1'] as const,
    assignmentId: 'commit-assignment', issuedAt: NOW, expiry: CONTROL_EXPIRY };
  const resourceBody = { v: 1 as const, reservationId: 'reservation-1', admissionClass: 'interactive' as const,
    workload: { kind: 'run' as const, id: 'committed-run', attempt: 1 },
    scopeBinding: { kind: 'conversation' as const, conversationId: 'conv-1', ownerEpoch: 1 },
    audience: { executorId: 'executor-test' }, budget: { maxCalls: 10, maxTokens: 10_000 },
    domain: { kind: 'local' as const, localDomainId: 'local:device-1', localGovernorEpoch: 1 },
    activation: { kind: 'assignment' as const, assignmentId: 'commit-assignment' }, issuedAt: NOW, expiry: CONTROL_EXPIRY };
  const resourceWithDigest = { ...resourceBody, digest: protocolDigest('ResourceLease', 1, resourceBody) };
  const unsigned = { v: 1, execution: 'conversation', assignmentId: 'commit-assignment', executorId: 'executor-test',
    manifest: { ...manifestBody, digest: protocolDigest('ExecutionManifest', 1, manifestBody) },
    controlLease: { ...controlBody, signature: signer.sign('ControlLease', 1, controlBody) },
    permissionLease: { ...permissionBody, signature: signer.sign('PermissionSnapshotLease', 1, permissionBody) },
    capabilities: [{ ...capabilityBody, signature: signer.sign('AuthorityCapability', 1, capabilityBody) }],
    resourceLease: { ...resourceWithDigest, signature: signer.sign('ResourceLease', 1, resourceWithDigest) },
    dependencyArtifacts: [], issuedAt: NOW,
    work: { t: 'conversation', runId: 'committed-run', conversationId: 'conv-1', ownerEpoch: 1, baseRevision: 0,
      ingress, contentAssets: [], windowInput: { t: 'full', windowEpoch: 1, messages: { ref: windowRef } }, controlContext: [] } };
  const dispatch = await h.journal.assign(unsigned as never);
  const ref = await h.artifacts.put(Buffer.from(canonicalize(batch)));
  const bundle = createConversationSealedBundle({
    assignmentId: 'commit-assignment', executorId: 'executor-test',
    streamFinal: { finalSeq: 1, streamDigest: 'sha256:' + '0'.repeat(64) },
    usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    usageFinal: { reportDigest: 'sha256:' + '0'.repeat(64), upToUsageSeq: 0 }, dependencyArtifacts: [],
    body: { t: 'conversation', runId: 'committed-run', conversationId: 'conv-1', ownerEpoch: 1, baseRevision: 0,
      runRecord: { type: 'run', runId: 'committed-run', runIndex: 1, timestamp: NOW, messages: [{ role: 'user', content: [{ type: 'text', text: 'session mutation' }] }] },
      contentAssets: [], mutationBatch: { ref, sessionCount: 2, globalCount: 0 } },
  });
  await h.artifacts.put(sealedBundleArtifact(bundle).bytes);
  const outcome = await h.journal.submitBundle(bundle, {
    principal: { kind: 'assignment', capability: dispatch.envelope.capabilities[0]! },
    requestId: 'commit-session-mutations', deadlineAt: CONTROL_EXPIRY,
  });
  if (!outcome.committed) throw new Error(`Seed commit rejected: ${outcome.error.message}`);
  await h.journal.observeBundleAcknowledgement('commit-assignment', { v: 1, assignmentId: 'commit-assignment', phase: 'acked', lastSeq: 4,
    sealedBundleRef: sealedBundleArtifact(bundle).ref, acknowledgedCommitRevision: outcome.commitRevision });
  return { firstTasks, batch };
}

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
  await source.journal.admit({ runId: 'identity-run', ingressKey: 'identity-run', queuedPosition: 0,
    userInput: task('identity'), invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: 'identity-run', receivedAt: NOW } });
  await source.journal.cancelRun({ runId: 'identity-run', requestId: 'cancel-identity' });
  const target = await createHarness('conv-1', 2);
  const tenure = await installVerifiedAnchorTenure(target.log, NOW);
  const publication = await importAuthenticatedBase({
    sourceLog: source.log, sourceArtifacts: source.artifacts,
    targetLog: target.log, targetArtifacts: target.artifacts,
    conversationId: 'conv-1', sourceOwnerEpoch: 1, verifier, signer, sourceJournal: source.journal,
    sourceDeviceId: tenure.memberDeviceId, targetDeviceId: tenure.anchorDeviceId,
  });
  await target.journal.installImportedBase(publication.source);
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
  const before = await h.log.readSnapshot();
  await expect(h.log.append([{ stream: 'run:conv-1', body: { ...(entry.body as any), requestId: 'conflicting-new-write', domainRevision: 2, event: confirmedEvent() } }]))
    .rejects.toThrow('Advancement event domain revision is not monotonic');
  const after = await h.log.readSnapshot();
  expect(after.cursor).toEqual(before.cursor);
  expect((await h.makeJournal().advancementSessions())[0]?.id).toBe('session-1');
  await h.write([confirmedEvent()]);
  expect((await h.makeJournal().advancementSessions())[0]?.status).toBe('active');
});


it.each(['cold', 'warm', 'imported'] as const)('session read includes committed session mutations: %s', async mode => {
  const source = await createHarness(); await source.write([createdEvent()]);
  const reader = source.makeJournal(); if (mode === 'warm') await reader.advancementSessions();
  const { firstTasks } = await seedCommittedSessionMutations(source);
  const later = {stream:'run:conv-1',body:{t:'session-control',requestId:'after-commit',domainRevision:4,mutation:{kind:'session-meta',patch:{name:'later name'}}}};
  if (mode === 'imported') {
    const target = await createHarness('conv-1', 2);
    const tenure = await installVerifiedAnchorTenure(target.log, NOW);
    const publication = await importAuthenticatedBase({
      sourceLog: source.log, sourceArtifacts: source.artifacts,
      targetLog: target.log, targetArtifacts: target.artifacts,
      conversationId: 'conv-1', sourceOwnerEpoch: 1, verifier, signer, sourceJournal: source.journal,
      sourceDeviceId: tenure.memberDeviceId, targetDeviceId: tenure.anchorDeviceId,
    });
    await target.journal.installImportedBase(publication.source);
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
    expect((await reader.taskList()).items[0]?.id).toBe('item-66');
    expect(failed).toBe(false);
    await expect(reader.taskListBeforeMutation('batch-66')).rejects.toThrow('second batch unavailable');
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
  expect((await pendingAdvancementConversations(h.log, h.artifacts, verifier)).conversationIds).toEqual(['conv-1']);
  const recovered = h.makeJournal();
  const adapter = new ConversationSessionStateAdapter({ journalFor: () => recovered, sessionExists: async () => true });
  expect((await adapter.readAdvancementState("conv-1", hostCtx("head")))?.id).toBe("session-new");
  expect(await adapter.listPendingAdvancementOriginalTasks("conv-1", hostCtx("pending"))).toEqual({ sessionIds: ["session-1"] });
  expect(await adapter.readAdvancementState("conv-1", hostCtx("exact"), "session-1")).toMatchObject({ status: "cancelled", originalTaskAdmission: { mode: "direct", status: "pending" } });
  await adapter.mutate("conv-1", { kind: "advancement-event", events: [{ type: "original_task_admitted", sessionId: "session-1", timestamp: NOW, turnId: "turn-1", inputDigest: confirmation.admissionIntent.inputDigest, runId: "run-direct" }] }, hostCtx("settle-direct"));
  expect(await adapter.listPendingAdvancementOriginalTasks("conv-1", hostCtx("done"))).toEqual({ sessionIds: [] });
  expect((await pendingAdvancementConversations(h.log, h.artifacts, verifier)).conversationIds).toEqual([]);
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

it('retains deleted conversation resource cleanup until its exact durable receipt, without resurrecting identity', async () => {
  const { advancementReviewLineageId, advancementReviewAttemptId, advancementReviewRootRequestId } = await import('@zhixing/core/advancement');
  const h = await createHarness(); await h.write([createdEvent(), confirmedEvent()]);
  const runRecordRef = { shardId: 'owner-log', runIndex: 0 }, lineageId = advancementReviewLineageId('session-1', runRecordRef);
  const attempt = { lineageId, generation: 1, runId: 'accepted-run', runIndex: 0, runRecordRef, phase: 'started' as const,
    root: { workload: { kind: 'control' as const, id: advancementReviewAttemptId(lineageId, 1), attempt: 1 },
      budget: { maxCalls: 8, maxTokens: 300000 }, requestId: advancementReviewRootRequestId(lineageId, 1) } };
  await h.write([{ type: 'review_attempt_transitioned', sessionId: 'session-1', timestamp: NOW, attempt }]);
  await h.log.append([{ stream: 'run:conv-1', body: { t: 'session-lifecycle', requestId: 'delete-with-cleanup', domainRevision: 3, mutation: 'delete' } }]);
  expect((await pendingAdvancementConversations(h.log, h.artifacts, verifier)).conversationIds).toEqual(['conv-1']);
  expect((await h.journal.pendingAdvancementCleanup()).items).toEqual([{ sessionId: 'session-1', attempt, deleted: true }]);
  expect(await h.journal.pendingAdvancementOriginalTasks()).toEqual({ sessionIds: [] });
  const establish = vi.fn(); const port = new ConversationSessionStateAdapter({ journalFor: () => h.makeJournal(), establishIdentity: establish });
  await port.mutate('conv-1', { kind: 'advancement-event', events: [{ type: 'review_attempt_transitioned', sessionId: 'session-1', timestamp: NOW, attempt: { ...attempt, phase: 'expired' } }] }, hostCtx('expire-deleted-root'));
  await port.mutate('conv-1', { kind: 'advancement-event', events: [{ type: 'review_root_settled', sessionId: 'session-1', timestamp: NOW, lineageId, generation: 1 }] }, hostCtx('settle-deleted-root'));
  expect(establish).not.toHaveBeenCalled();
  expect((await h.journal.pendingAdvancementCleanup()).items).toEqual([]);
  expect((await pendingAdvancementConversations(h.log, h.artifacts, verifier)).conversationIds).toEqual([]);
  expect((await h.journal.authorityState()).deleted).toBe(true);
}, DURABLE_IO_TEST_TIMEOUT_MS);

it.each(['review', 'clear'] as const)('locates accepted advancement runs exactly and removes the suffix on %s', async mode => {
  const h = await createHarness(); await h.write([createdEvent(), confirmedEvent()]);
  await seedCommittedSessionMutations(h);
  const first = await h.journal.pendingAdvancementRun('session-1');
  expect(first?.record.runId).toBe('committed-run');
  expect(first?.runRecordRef).toEqual({ shardId: 'owner-log', runIndex: 1 });
  expect(await h.journal.pendingAdvancementRun('session-1', 1)).toBeUndefined();
  if (mode === 'clear') await h.log.append([{ stream: 'run:conv-1', body: { t: 'session-lifecycle', requestId: 'clear-review-suffix', domainRevision: 4, mutation: 'clear' } }]);
  else await h.write([{ type: 'run_reviewed', timestamp: NOW, sessionId: 'session-1', review: review({ runIndex: 1, runRecordRef: { shardId: 'old-physical', runIndex: 1 } }) }]);
  expect(await h.journal.pendingAdvancementRun('session-1')).toBeUndefined();
}, DURABLE_IO_TEST_TIMEOUT_MS);

it('keeps advancement recovery out of execution-only journal construction', async () => {
  const registered = vi.spyOn(FileAuthorityCommitLog.prototype, 'durableProjection');
  try {
    const h = await createHarness();
    expect(registered.mock.calls.some(([definition]) => definition.projectionId === 'advancement-recovery-v1')).toBe(false);
    await h.write([createdEvent()]);
    expect(registered.mock.calls.some(([definition]) => definition.projectionId === 'advancement-recovery-v1')).toBe(true);
    expect((await h.read())?.id).toBe('session-1');
  } finally { registered.mockRestore(); }
}, DURABLE_IO_TEST_TIMEOUT_MS);

it('pending discovery prepares its validation reader without installing an unrelated submission writer', async () => {
  const root=await createTempDir('advancement-pending-reader');
  const artifacts=new FileArtifactStore(path.join(root,'artifacts'));
  const log=trackAuthorityLog(new FileAuthorityCommitLog(path.join(root,'log'),artifacts));
  const registered=vi.spyOn(log,'durableProjection');
  expect(await pendingAdvancementConversations(log,artifacts,verifier)).toEqual({conversationIds:[]});
  const ids=registered.mock.calls.map(([definition])=>definition.projectionId);
  expect(ids).toContain('conversation-run-state-v1');
  expect(ids).toContain('advancement-recovery-v1');
  expect(ids).not.toContain('conversation-submission-state-v1');
},DURABLE_IO_TEST_TIMEOUT_MS);

it.each(['pending-delete','session-text','session-state','session-key','session-absent','guard-delete'] as const)(
  'cold production reads reject unsigned %s and recover the complete authenticated state', async attack => {
    const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 71));
    const h = await createHarness('conv-1',1,verifier,integrity);
    await h.write([createdEvent()]);
    const confirmation = confirmedEvent();
    if (confirmation.type !== 'rubric_confirmed') throw Error('fixture');
    await h.write([{ type:'original_task_directed', sessionId:'session-1',timestamp:NOW,admissionIntent:confirmation.admissionIntent,
      exit:{reason:'user-cancelled',message:'direct',occurredAt:NOW} }]);
    const expected = await h.journal.advancementSession('session-1');
    expect((await pendingAdvancementConversations(h.log,h.artifacts,verifier)).conversationIds).toEqual(['conv-1']);
    // Exercise the actual guard read port, now backed by the canonical state.
    await readConversationSubmissionState(h.log,h.artifacts,verifier,'conv-1',{});
    await h.log.stopStorageMaintenance();
    const wal = await fs.readFile(h.log.logPath);
    const id = attack === 'pending-delete' ? 'advancement-recovery-v1' : 'conversation-run-state-v1';
    const version = attack === 'pending-delete' ? 2 : 3;
    const folder = path.join(h.log.rootDir,'projections',durableProjectionDirectoryName(id)+'.v'+version);
    const manifest = JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8'));
    expect(manifest.integrity).toMatch(/^[a-f0-9]{64}$/);
    // Read the public fixture rows through their legitimate authenticated view.
    const published = new FileDurableProjectionIndex({rootDir:folder,projectionId:id,reducerVersion:version,
      authenticated:true,integrity,readOnly:true,allowSegmentReclamation:false});
    await published.initialize(manifest.checkpoints);
    const publicRows: Array<{key:string;value:import('@zhixing/core/contracts').JsonValue}> = [];
    let publishedCursor: string | undefined;
    do { const page=await published.scan({},256,publishedCursor); publicRows.push(...page.entries); publishedCursor=page.continuation; } while(publishedCursor);
    await published.stopStorageMaintenance();
    // The attacker has no integrity key; even self-consistent public checksums
    // and correctly bound row identities cannot authorize this publication.
    const index = new FileDurableProjectionIndex({rootDir:folder,projectionId:id,reducerVersion:version,allowSegmentReclamation:false});
    await index.initialize(manifest.checkpoints);
    let changed = 0;
    const mutations: import('@zhixing/core/authority').DurableProjectionMutation[] = [];
    {
      for (const row of publicRows) {
        const text = JSON.stringify(row.value);
        const match = attack === 'pending-delete' ? row.key.startsWith('advancement-pending/')
          : attack === 'guard-delete' ? row.key.endsWith('/root') : row.key.includes('advancementSessions') && text.includes('session-1');
        if (!match) { mutations.push({kind:'put',key:row.key,value:row.value}); continue; }
        changed++;
        if (attack.endsWith('delete') || attack === 'session-absent') mutations.push({kind:'tombstone',key:row.key});
        else {
          const forged = attack === 'session-text' ? text.replaceAll('把测试修到全绿','UNSIGNED-TEXT')
            : attack === 'session-state' ? text.replaceAll('cancelled','completed') : text.replaceAll('session-1','wrong-session');
          expect(forged).not.toBe(text);
          mutations.push({kind:'put',key:row.key,value:JSON.parse(forged)});
        }
      }
    }
    expect(changed).toBeGreaterThan(0);
    index.publish(await index.prepare(mutations),manifest.checkpoints); await index.flush(); await index.stopStorageMaintenance();
    const cold=trackAuthorityLog(new FileAuthorityCommitLog(h.log.rootDir,h.artifacts,{integrity,clock:()=>NOW}));
    const journal=h.makeJournal(cold);
    expect(await journal.advancementSession('session-1')).toEqual(expected);
    // 被篡改的派生目录不被采用：它从源头部重新起步，按会话从认证事实迁移；后台迁移完成后待办完整，不漏义务。
    await pendingAdvancementConversations(cold,h.artifacts,verifier);
    await startConversationDecisionMigration(cold);
    expect((await pendingAdvancementConversations(cold,h.artifacts,verifier)).conversationIds).toEqual(['conv-1']);
    expect(await journal.advancementSession('absent-session')).toBeNull();
    await readConversationSubmissionState(cold,h.artifacts,verifier,'conv-1',{});
    expect(await fs.readFile(h.log.logPath)).toEqual(wal);
  },30000);
it('advancement cold readers replay a same-identity old signed state, rotate keys, and keep authenticated files unchanged without a key', async () => {
  const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32,72));
  const h = await createHarness('conv-1',1,verifier,integrity);
  await h.write([createdEvent()]);
  await pendingAdvancementConversations(h.log,h.artifacts,verifier);
  await h.log.stopStorageMaintenance();
  const source=path.join(h.log.rootDir,'projections'), snapshot=path.join(h.log.rootDir,'old-derived-snapshot');
  await fs.cp(source,snapshot,{recursive:true});
  const writer=trackAuthorityLog(new FileAuthorityCommitLog(h.log.rootDir,h.artifacts,{integrity,clock:()=>NOW}));
  const writerJournal=h.makeJournal(writer), adapter=new ConversationSessionStateAdapter({journalFor:()=>writerJournal,sessionExists:async()=>true});
  const confirmation=confirmedEvent(); if(confirmation.type!=='rubric_confirmed')throw Error('fixture');
  await adapter.mutate('conv-1',{kind:'advancement-event',events:[{type:'original_task_directed',sessionId:'session-1',timestamp:NOW,
    admissionIntent:confirmation.admissionIntent,exit:{reason:'user-cancelled',message:'direct',occurredAt:NOW}}]},hostCtx('after-old-snapshot'));
  const expected=await writerJournal.advancementSession('session-1');
  await pendingAdvancementConversations(writer,h.artifacts,verifier); await writer.stopStorageMaintenance();
  // Restore signed older manifests and their referenced pages, leaving the WAL.
  await fs.cp(snapshot,source,{recursive:true,force:true});
  const cold=trackAuthorityLog(new FileAuthorityCommitLog(h.log.rootDir,h.artifacts,{integrity,clock:()=>NOW}));
  expect(await h.makeJournal(cold).advancementSession('session-1')).toEqual(expected);
  expect((await pendingAdvancementConversations(cold,h.artifacts,verifier)).conversationIds).toEqual(['conv-1']);
  await cold.stopStorageMaintenance();
  const manifests=async()=>Promise.all((await fs.readdir(source)).map(async name=>[name,await fs.readFile(path.join(source,name,'manifest.json'),'utf8').catch(()=>null)]));
  const before=await manifests();
  const strict=trackAuthorityLog(new FileAuthorityCommitLog(h.log.rootDir,h.artifacts,{readOnly:true,clock:()=>NOW}));
  expect(await h.makeJournal(strict).advancementSession('session-1')).toEqual(expected);
  expect((await pendingAdvancementConversations(strict,h.artifacts,verifier)).conversationIds).toEqual(['conv-1']);
  await strict.stopStorageMaintenance();
  expect(await manifests()).toEqual(before);
  const rotated=trackAuthorityLog(new FileAuthorityCommitLog(h.log.rootDir,h.artifacts,{integrity:new AuthorityCacheIntegrity(Buffer.alloc(32,73)),clock:()=>NOW}));
  expect(await h.makeJournal(rotated).advancementSession('session-1')).toEqual(expected);
  expect((await pendingAdvancementConversations(rotated,h.artifacts,verifier)).conversationIds).toEqual(['conv-1']);
},30000);