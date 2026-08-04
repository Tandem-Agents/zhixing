import type {
  AdvancementSession,
  ConfirmedRubricSnapshot,
  RunRecordInput,
} from "@zhixing/core";
import type {
  CapabilityDescriptor,
  EvidenceExecutionResult,
  EvidenceRequest,
  ImmediateRootResourceLease,
  ResourceLease,
  ResourceReservationPort,
  Signature,
} from "@zhixing/core/contracts";
import {
  createSignedCapabilityDescriptor,
  createSignedEvidenceBundle,
  createSignedEvidenceRequest,
  evidenceObservationStateFingerprint,
  evidenceRequestDigest,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { describe, expect, it } from "vitest";
import type { AdvancementSessionStore } from "./session-store.js";
import {
  AdvancementEvidenceCoordinator,
  AdvancementEvidenceDeferredError,
  type AdvancementEvidenceTarget,
} from "./evidence.js";

const NOW = "2026-08-03T00:00:00.000Z";
const EXPIRY = "2026-08-03T01:00:00.000Z";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId: string, version: number, payload: unknown): Signature {
    return {
      alg: "test-sha256",
      keyId: "test",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
  verify(schemaId, version, payload, signature) {
    if (signature.sig !== protocolDigest(schemaId, version, payload)) {
      throw new TypeError("signature mismatch");
    }
  },
};

describe("AdvancementEvidenceCoordinator", () => {
  it("durably records the request before transport and closes usage before review consumption", async () => {
    const calls: string[] = [];
    const store = storeRecording(calls);
    const resources = resourcesRecording(calls);
    const coordinator = makeCoordinator({
      store,
      resources,
      collect: async (request) => {
        calls.push("transport");
        return {
          kind: "bundle",
          bundle: createSignedEvidenceBundle(
            {
              v: 1,
              requestId: request.requestId,
              requestDigest: evidenceRequestDigest(request),
              executorId: request.executorId,
              observation: observation(true),
              items: [{
                kind: "log",
                locator: { paths: ["logs/run.log"] },
                contentDigest: protocolDigest("content", 1, { ok: true }),
                summary: "日志显示任务已完成。",
                source: "independent",
              }],
            },
            identity,
          ),
        };
      },
    });

    const result = await coordinator.collect(reviewInput());
    expect(result.canonicalEvidence).toContainEqual(expect.objectContaining({
      requirementId: "required-log",
      source: "independent",
    }));
    expect(calls).toEqual([
      "acquire-child",
      "request-durable",
      "reserve",
      "transport",
      "consume",
      "child-settle",
      "child-release",
      "result-durable",
    ]);
  });

  it("settles durable attempts and leases when transport outcome is unknown", async () => {
    const calls: string[] = [];
    const coordinator = makeCoordinator({
      store: storeRecording(calls),
      resources: resourcesRecording(calls),
      collect: async () => {
        calls.push("transport");
        throw new Error("connection lost");
      },
    });

    await expect(coordinator.collect(reviewInput())).rejects.toThrow("connection lost");
    expect(calls).toEqual([
      "acquire-child",
      "request-durable",
      "reserve",
      "transport",
      "consume",
      "child-settle",
      "child-release",
      "evidence-deferred",
    ]);
  });

  it("bounds stale retries and leaves the accepted run deferred", async () => {
    const calls: string[] = [];
    const coordinator = makeCoordinator({
      store: storeRecording(calls),
      resources: resourcesRecording(calls),
      collect: async (request) => ({
        kind: "bundle",
        bundle: createSignedEvidenceBundle(
          {
            v: 1,
            requestId: request.requestId,
            requestDigest: evidenceRequestDigest(request),
            executorId: request.executorId,
            observation: observation(false),
            items: [{
              kind: "log",
              locator: { paths: ["logs/run.log"] },
              contentDigest: protocolDigest("content", 1, { requestId: request.requestId }),
              summary: "日志读取期间发生变化。",
              source: "independent",
            }],
          },
          identity,
        ),
      }),
    });

    await expect(coordinator.collect(reviewInput())).rejects.toBeInstanceOf(
      AdvancementEvidenceDeferredError,
    );
    expect(calls.filter((call) => call === "request-durable")).toHaveLength(3);
    expect(calls.filter((call) => call === "evidence-deferred")).toHaveLength(3);
  });

  it("treats a missing workspace as a normal capability gap without fabricating a target", async () => {
    let transported = false;
    const coordinator = makeCoordinator({
      store: storeRecording([]),
      resources: resourcesRecording([]),
      target: targetWithoutWorkspace(),
      collect: async () => {
        transported = true;
        return { kind: "capability-gap" };
      },
    });
    const result = await coordinator.collect(reviewInput({ target: targetWithoutWorkspace() }));
    expect(transported).toBe(false);
    expect(result.requestId).toBeUndefined();
    expect(result.canonicalEvidence.some((item) => item.source === "independent")).toBe(false);
  });

  it("finishes a child lease when the durable request write fails before dispatch handoff", async () => {
    const calls: string[] = [];
    const store = storeRecording(calls);
    store.appendEvidenceRequest = async () => {
      calls.push("request-durable");
      throw new Error("owner log unavailable");
    };
    const coordinator = makeCoordinator({
      store,
      resources: resourcesRecording(calls),
      collect: async () => {
        calls.push("transport");
        return { kind: "capability-gap" };
      },
    });

    await expect(coordinator.collect(reviewInput())).rejects.toThrow(
      "owner log unavailable",
    );
    expect(calls).toEqual([
      "acquire-child",
      "request-durable",
      "child-settle",
      "child-release",
    ]);
  });

  it("consumes a durable terminal bundle without reviving its released evidence lease", async () => {
    const calls: string[] = [];
    const oldRoot = rootLease("review-root-old");
    const requestId = "evidence:durable-result";
    const request = createSignedEvidenceRequest(
      {
        v: 1,
        requestId,
        reviewId: "review-1",
        runId: "run-1",
        conversationId: "conversation-1",
        ownerEpoch: 3,
        executorId: "executor-1",
        workspace: {
          bindingRef: "workspace-1",
          workspaceBindingRevision: 7,
        },
        items: [{ kind: "log", locator: { paths: ["logs/run.log"] } }],
        lease: childLease(oldRoot, requestId, 1),
        issuedAt: NOW,
        expiry: EXPIRY,
      },
      identity,
      identity,
    );
    const bundle = createSignedEvidenceBundle(
      {
        v: 1,
        requestId,
        requestDigest: evidenceRequestDigest(request),
        executorId: "executor-1",
        observation: observation(true),
        items: [{
          kind: "log",
          locator: { paths: ["logs/run.log"] },
          contentDigest: protocolDigest("content", 1, { durable: true }),
          summary: "已耐久完成。",
          source: "independent",
        }],
      },
      identity,
    );
    const pendingSession: AdvancementSession = {
      ...session(),
      evidence: {
        pending: [{
          requestId,
          reviewId: "review-1",
          generation: 1,
          attempt: 1,
          request,
          requestDigest: evidenceRequestDigest(request),
          itemRequirements: [{ itemIndex: 0, requirementIds: ["required-log"] }],
          outcome: { kind: "bundle", bundle },
        }],
        generations: [
          { runId: "run-1", reviewId: "review-1", generation: 1, lastAttempt: 1 },
        ],
      },
    };
    const coordinator = makeCoordinator({
      store: storeRecording(calls),
      resources: resourcesRecording(calls),
      collect: async () => {
        calls.push("transport");
        throw new Error("durable outcome must not be dispatched");
      },
    });

    const result = await coordinator.collect(reviewInput({
      session: pendingSession,
      generation: 2,
      rootLease: rootLease("review-root-new"),
    }));

    expect(result.requestId).toBe(requestId);
    expect(result.canonicalEvidence).toContainEqual(expect.objectContaining({
      requirementId: "required-log",
      source: "independent",
    }));
    // The pending fact remains until the review and its consumed settlement
    // commit together; collection itself performs no lease or transport work.
    expect(calls).toEqual([]);
  });
});

function makeCoordinator(input: {
  store: AdvancementSessionStore;
  resources: ResourceReservationPort;
  collect: (request: EvidenceRequest) => Promise<EvidenceExecutionResult>;
  target?: AdvancementEvidenceTarget;
}) {
  const resolved = input.target ?? target();
  return new AdvancementEvidenceCoordinator({
    store: input.store,
    resources: input.resources,
    resolveTarget: async () => resolved,
    clientFor: () => ({ collect: (request) => input.collect(request) }),
    signer: identity,
    verifier: identity,
    now: () => NOW,
  });
}

function storeRecording(calls: string[]): AdvancementSessionStore {
  return {
    appendEvidenceRequest: async () => {
      calls.push("request-durable");
      return session();
    },
    appendEvidenceResult: async () => {
      calls.push("result-durable");
      return session();
    },
    settleEvidence: async (_conversationId, _sessionId, _requestId, settlement) => {
      calls.push(`evidence-${settlement}`);
      return session();
    },
  } as unknown as AdvancementSessionStore;
}

function resourcesRecording(calls: string[]): ResourceReservationPort {
  return {
    enqueueRoot: async () => undefined,
    prepareAssignmentRoot: async () => { throw new Error("unused"); },
    prepareSystemJobRoot: async () => { throw new Error("unused"); },
    acquireRoot: async () => rootLease(),
    acquireChild: async (parent, workload) => {
      calls.push("acquire-child");
      return childLease(parent, workload.id, workload.attempt);
    },
    reserveUsage: async () => { calls.push("reserve"); },
    consume: async () => { calls.push("consume"); },
    settle: async (lease) => { calls.push(lease.parentId ? "child-settle" : "root-settle"); },
    release: async (lease) => { calls.push(lease.parentId ? "child-release" : "root-release"); },
  };
}

function reviewInput(overrides: Partial<Parameters<AdvancementEvidenceCoordinator["collect"]>[0]> = {}) {
  return {
    session: session(),
    runId: "run-1",
    reviewId: "review-1",
    runRecord: runRecord(),
    rootLease: rootLease(),
    target: target(),
    abort: new AbortController().signal,
    ...overrides,
  };
}

function session(): AdvancementSession {
  return {
    id: "session-1",
    conversationId: "conversation-1",
    status: "active",
    originalUserTask: { parts: [{ type: "text", text: "完成任务" }] },
    createdAt: NOW,
    updatedAt: NOW,
    rubricDraftVersion: 1,
    confirmedRubric: rubric(),
    runs: [],
    proxyMessages: [],
  };
}

function rubric(): ConfirmedRubricSnapshot {
  return {
    source: { kind: "local-draft", snapshotId: "draft-1", contentDigest: protocolDigest("draft", 1, {}) },
    title: "任务准则",
    description: "完成后核对日志",
    content: {
      passCriteria: [{ id: "criterion-1", text: "任务完成" }],
      evidenceRequirements: [{
        id: "required-log",
        kind: "log",
        description: "完成日志存在",
        locator: { paths: ["logs/run.log"] },
        required: true,
      }],
      failureHandling: [{ id: "retry", scenario: "未完成", reply: "继续处理" }],
    },
    confirmedAt: NOW,
    confirmedBy: "user",
  };
}

function runRecord(): RunRecordInput {
  return {
    timestamp: NOW,
    messages: [
      { role: "user", content: [{ type: "text", text: "完成任务" }] },
      { role: "assistant", content: [{ type: "text", text: "任务已完成" }] },
    ],
  };
}

function target(): AdvancementEvidenceTarget {
  return {
    ownerEpoch: 3,
    executorId: "executor-1",
    workspace: {
      deviceId: "executor-1",
      bindingRef: "workspace-1",
      workspaceBindingRevision: 7,
    },
    descriptor: descriptor(),
  };
}

function targetWithoutWorkspace(): AdvancementEvidenceTarget {
  const { workspace: _workspace, ...withoutWorkspace } = target();
  return withoutWorkspace;
}

function descriptor(): CapabilityDescriptor {
  return createSignedCapabilityDescriptor({
    v: 1,
    executorId: "executor-1",
    revision: 1,
    protocolVersion: "1",
    workspaces: [{ bindingRef: "workspace-1", workspaceBindingRevision: 7, displayName: "项目" }],
    tools: [],
    mcpServers: [],
    credentialBindings: [],
    evidenceCapabilities: ["log"],
    at: NOW,
  }, identity);
}

function observation(consistent: boolean) {
  const pre = evidenceObservationStateFingerprint([{
    kind: "log" as const,
    locator: { paths: ["logs/run.log"] },
    state: { kind: "present" as const, contentDigest: protocolDigest("state", 1, { v: 1 }) },
  }]);
  const post = consistent ? pre : evidenceObservationStateFingerprint([{
    kind: "log" as const,
    locator: { paths: ["logs/run.log"] },
    state: { kind: "present" as const, contentDigest: protocolDigest("state", 1, { v: 2 }) },
  }]);
  return { observedAt: NOW, preStateFingerprint: pre, postStateFingerprint: post, consistent };
}

function rootLease(reservationId = "review-root-1"): ImmediateRootResourceLease {
  return signLease({
    v: 1,
    reservationId,
    admissionClass: "advancement",
    workload: { kind: "control", id: "review-1", attempt: 1 },
    scopeBinding: { kind: "conversation", conversationId: "conversation-1", ownerEpoch: 3 },
    audience: { executorId: "executor-1" },
    budget: { maxCalls: 8 },
    domain: { kind: "anchor", anchorEpoch: 1 },
    issuedAt: NOW,
    expiry: EXPIRY,
  }) as ImmediateRootResourceLease;
}

function childLease(parent: ResourceLease, requestId: string, attempt: number): ResourceLease {
  return signLease({
    v: 1,
    reservationId: `child-${requestId}`,
    parentId: parent.reservationId,
    parentDigest: parent.digest,
    admissionClass: "advancement",
    workload: { kind: "evidence", id: requestId, attempt },
    scopeBinding: parent.scopeBinding,
    audience: { executorId: "executor-1" },
    budget: { maxCalls: 1 },
    domain: parent.domain,
    issuedAt: NOW,
    expiry: EXPIRY,
  });
}

function signLease(payload: Omit<ResourceLease, "digest" | "signature">): ResourceLease {
  const withDigest = { ...payload, digest: protocolDigest("ResourceLease", 1, payload) };
  return {
    ...withDigest,
    signature: identity.sign("ResourceLease", 1, withDigest),
  } as ResourceLease;
}
