import {
  protocolDigest,
  type ProtocolSignatureVerifier,
} from "../../protocol/index.js";
import { describe, expect, it } from "vitest";
import { isAdvancementControlEvent } from "../event-codec.js";
import {
  advancementReviewAttemptId,
  advancementReviewLineageId,
} from "../review-attempt-identity.js";

const NOW = "2026-08-04T00:00:00.000Z";
const verifier: ProtocolSignatureVerifier = { verify() {} };

describe("isAdvancementControlEvent", () => {
  it("accepts the closed nested review and window shapes", () => {
    expect(isAdvancementControlEvent(reviewed(), verifier)).toBe(true);
    expect(isAdvancementControlEvent(windowUpdated(), verifier)).toBe(true);
  });

  it("rejects unknown or malformed nested review fields before replay", () => {
    const event = reviewed();
    expect(isAdvancementControlEvent({
      ...event,
      review: {
        ...event.review,
        evidence: [{
          id: "evidence-1",
          kind: "log",
          summary: "完成",
          refs: [7],
        }],
      },
    }, verifier)).toBe(false);
    expect(isAdvancementControlEvent({
      ...event,
      review: { ...event.review, unknown: true },
    }, verifier)).toBe(false);
  });

  it("rejects malformed window messages and snapshots before replay", () => {
    const event = windowUpdated();
    expect(isAdvancementControlEvent({
      ...event,
      advancementWindow: {
        ...event.advancementWindow,
        entries: [{
          kind: "review",
          reviewId: "review-1",
          runIndex: 0,
          messages: [{ role: "system", content: [] }, message("assistant", "继续")],
        }],
      },
    }, verifier)).toBe(false);
    expect(isAdvancementControlEvent({
      ...event,
      advancementWindow: {
        ...event.advancementWindow,
        lastSnapshot: {
          ...event.advancementWindow.lastSnapshot,
          decision: { kind: "trigger", reason: "阈值", threshold: -1 },
        },
      },
    }, verifier)).toBe(false);
  });

  it("rejects confirmed Rubric source extras and invalid content kinds", () => {
    const base = confirmedEvent();
    expect(isAdvancementControlEvent(base, verifier)).toBe(true);
    expect(isAdvancementControlEvent({
      ...base,
      confirmedRubric: {
        ...base.confirmedRubric,
        source: { ...base.confirmedRubric.source, extra: true },
      },
    }, verifier)).toBe(false);
    expect(isAdvancementControlEvent({
      ...base,
      confirmedRubric: {
        ...base.confirmedRubric,
        content: {
          ...base.confirmedRubric.content,
          evidenceRequirements: [{
            id: "required-log",
            kind: "invented-kind",
            description: "非法类型",
          }],
        },
      },
    }, verifier)).toBe(false);
    expect(isAdvancementControlEvent({
      ...base,
      confirmedRubric: {
        ...base.confirmedRubric,
        content: {
          ...base.confirmedRubric.content,
          passCriteria: [
            { id: "pc-1", text: "测试通过" },
            { id: "pc-1", text: "构建通过" },
          ],
        },
      },
    }, verifier)).toBe(false);
  });

  it("accepts closed review-attempt phases and rejects lease/root drift", () => {
    const started = reviewAttemptEvent("started");
    const invoking = reviewAttemptEvent("invoking");
    expect(isAdvancementControlEvent(started, verifier)).toBe(true);
    expect(isAdvancementControlEvent(invoking, verifier)).toBe(true);
    expect(isAdvancementControlEvent({
      ...invoking,
      attempt: {
        ...invoking.attempt,
        rootLease: {
          ...invoking.attempt.rootLease,
          budget: { maxCalls: 7, maxTokens: 300_000 },
        },
      },
    }, verifier)).toBe(false);
    expect(isAdvancementControlEvent({
      ...started,
      attempt: { ...started.attempt, unknown: true },
    }, verifier)).toBe(false);
  });
});

function reviewAttemptEvent(phase: "started" | "invoking") {
  const runRecordRef = { shardId: "shard-1", runIndex: 0 };
  const lineageId = advancementReviewLineageId("session-1", runRecordRef);
  const id = advancementReviewAttemptId(lineageId, 1);
  const root = {
    workload: { kind: "control" as const, id, attempt: 1 },
    budget: { maxCalls: 8, maxTokens: 300_000 },
    requestId: `advancement-review-root:${id}`,
  };
  const unsignedLease = {
    v: 1 as const,
    reservationId: `reservation:${id}`,
    admissionClass: "advancement" as const,
    workload: root.workload,
    scopeBinding: { kind: "control" as const, subject: id },
    audience: { executorId: "executor-1" },
    budget: root.budget,
    domain: { kind: "anchor" as const, anchorEpoch: 1 },
    issuedAt: "2026-08-04T00:00:00.000Z",
    expiry: "2026-08-04T01:00:00.000Z",
  };
  const rootLease = {
    ...unsignedLease,
    digest: protocolDigest("ResourceLease", 1, unsignedLease),
    signature: { alg: "test", keyId: "test", sig: "test" },
  };
  return {
    type: "review_attempt_transitioned" as const,
    timestamp: NOW,
    sessionId: "session-1",
    attempt: {
      lineageId,
      generation: 1,
      runId: "accepted-run:shard-1:0",
      runIndex: 0,
      runRecordRef,
      phase,
      root,
      ...(phase === "invoking" ? { rootLease } : {}),
    },
  };
}

function reviewed() {
  return {
    type: "run_reviewed" as const,
    timestamp: NOW,
    sessionId: "session-1",
    review: {
      id: "review-1",
      runIndex: 0,
      runRecordRef: { shardId: "shard-1", runIndex: 0 },
      reviewedAt: NOW,
      decision: "failed" as const,
      evidence: [{
        id: "evidence-1",
        kind: "log" as const,
        summary: "完成",
        requirementId: "required-log",
        source: "independent" as const,
        passed: true,
        refs: ["logs/run.log"],
      }],
      attribution: { criteria: [] },
      unmetCriteria: ["测试通过"],
      usage: {
        judge: { inputTokens: 10, outputTokens: 2 },
        run: { inputTokens: 20, outputTokens: 4 },
      },
      selectedFailureHandlingId: "fix",
      proxyMessageId: "proxy-1",
      contextWindow: contextSnapshot(),
    },
  };
}

function windowUpdated() {
  return {
    type: "window_updated" as const,
    timestamp: NOW,
    sessionId: "session-1",
    advancementWindow: {
      source: "advancement-window" as const,
      reviewCount: 1,
      entries: [{
        kind: "review" as const,
        reviewId: "review-1",
        runIndex: 0,
        messages: [message("user", "未通过"), message("assistant", "继续")],
      }],
      updatedAt: NOW,
      lastSnapshot: contextSnapshot(),
    },
  };
}

function contextSnapshot() {
  return {
    source: "advancement-window" as const,
    priorReviewCount: 0,
    inputMessageCount: 2,
    outputMessageCount: 2,
    decision: { kind: "pass" as const, reason: "未触发压缩" },
  };
}

function confirmedEvent() {
  return {
    type: "rubric_confirmed" as const,
    timestamp: NOW,
    sessionId: "session-1",
    admissionIntent: {
      turnId: "turn-1",
      surfacePrincipal: "surface:test",
      turnOrigin: { channel: "rpc" as const, triggeredBy: "surface:test" },
      inputDigest: `sha256:${"b".repeat(64)}`,
    },
    confirmedRubric: {
      source: {
        kind: "local-draft" as const,
        snapshotId: "draft-1",
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
      title: "准则",
      description: "描述",
      content: {
        passCriteria: [{ id: "pc-1", text: "测试通过" }],
        evidenceRequirements: [{
          id: "required-log",
          kind: "log" as const,
          description: "日志存在",
          locator: { paths: ["logs/run.log"] },
          required: true,
        }],
        failureHandling: [{ id: "fix", scenario: "失败", reply: "修复" }],
      },
      confirmedAt: NOW,
      confirmedBy: "user" as const,
    },
  };
}

function message(role: "user" | "assistant", text: string) {
  return { role, content: [{ type: "text" as const, text }] };
}
