import {
  createSessionBroadcastTransport,
  type SessionBroadcastTransport,
} from "@zhixing/rpc/session-broadcast";
import { describe, expect, it, vi } from "vitest";
import { AnchorSessionBroadcastLifecycle } from "../anchor-session-broadcast-lifecycle.js";
import { createTempDir } from "@zhixing/test-utils";
import {
  type AdvancementRunReview,
  type ConfirmedRubricSnapshot,
} from "@zhixing/core/advancement";
import { AdvancementStore } from "../../../../core/src/advancement/store.js";
import { protocolDigest } from "@zhixing/core/protocol";
import {
  AdvancementController,
  createAdvancementRecoveryMaintenance,
} from "@zhixing/owner-services/advancement";
import { createAdvancementReviewAttemptApplication } from "@zhixing/owner-services/advancement/review-attempt-correctness";
import { createAdvancementReviewExternalMechanism } from "@zhixing/owner-services/advancement/review-external-mechanism";
import { AdvancementReviewResultProjectionApplicationService } from "@zhixing/core/advancement/application";
import { createAdvancementEventSink } from "@zhixing/server";

describe("AnchorSessionBroadcastLifecycle", () => {
  it("keeps stable ports fail-closed until one Server transport is installed", () => {
    const lifecycle = new AnchorSessionBroadcastLifecycle();
    const port = lifecycle.port;
    expect(() => port.session("conversation-1", "session.event", { seq: 1 }))
      .toThrow("not active");
    expect(() => port.activity(activity("conversation-1"))).toThrow("not active");

    const first = transport("first");
    lifecycle.install(first.transport);
    expect(lifecycle.port).toBe(port);
    port.session("conversation-1", "session.event", { seq: 1 });
    port.activity(activity("conversation-2"));
    expect(first.notifications).toEqual([
      ["first", "session.event", { seq: 1 }],
      ["first", "session.activity", activity("conversation-2")],
    ]);
    expect(() => lifecycle.install(transport("duplicate").transport))
      .toThrow("already installed");
  });

  it("rejects a structurally forged transport without Server provenance", () => {
    const lifecycle = new AnchorSessionBroadcastLifecycle();
    expect(() => lifecycle.install({
      session: vi.fn(),
      activity: vi.fn(),
    } as SessionBroadcastTransport)).toThrow("no Server provenance");
  });

  it("does not let a stale generation release its successor", () => {
    const lifecycle = new AnchorSessionBroadcastLifecycle();
    const first = transport("first");
    const firstLease = lifecycle.install(first.transport);
    firstLease.release();

    const second = transport("second");
    const secondLease = lifecycle.install(second.transport);
    firstLease.release();
    lifecycle.port.session("conversation-1", "session.changed", { revision: 2 });
    expect(first.notifications).toEqual([]);
    expect(second.notifications).toEqual([
      ["second", "session.changed", { revision: 2 }],
    ]);

    secondLease.release();
    expect(() => lifecycle.port.session("conversation-1", "session.event", {}))
      .toThrow("not active");
  });

  it("releases the active generation once and cannot be reactivated after close", () => {
    const lifecycle = new AnchorSessionBroadcastLifecycle();
    lifecycle.install(transport("active").transport);
    lifecycle.close();
    lifecycle.close();
    expect(() => lifecycle.port.activity(activity("conversation-1")))
      .toThrow("not active");
    expect(() => lifecycle.install(transport("late").transport)).toThrow("closed");
  });

  it("recovers persisted missing and pending proxies after installing the Host transport, with no Channel", async () => {
    const store = new AdvancementStore(await createTempDir("host-recovery-readiness"));
    const ids = ["conversation-1", "conversation-2"];
    const rubric: ConfirmedRubricSnapshot = {
      source: { kind: "library", rubricId: "rubric", rubricVersion: "v1" },
      title: "Recovery", description: "Recover accepted work",
      content: {
        passCriteria: [{ id: "p1", text: "finished" }],
        evidenceRequirements: [],
        failureHandling: [{ id: "continue", scenario: "unfinished", reply: "continue" }],
      },
      confirmedAt: "2026-01-01T00:01:00.000Z", confirmedBy: "user",
    };
    for (const id of ids) {
      const task = { parts: [{ type: "text" as const, text: "finish" }] };
      const intent = {
        turnId: `turn-${id}`, surfacePrincipal: "surface:test",
        turnOrigin: { channel: "rpc" as const, triggeredBy: "surface:test" },
        inputDigest: protocolDigest("AdvancementOriginalTaskInput", 1, task),
      };
      await store.createSession({
        id, conversationId: id, originalUserTask: task,
        pendingRubricDraft: {
          draftId: "draft", originalTurnId: intent.turnId, source: "generated",
          candidateRubricIds: [], title: rubric.title, description: rubric.description,
          content: { ...rubric.content, passCriteria: ["finished"] },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await store.confirmRubric(id, id, rubric, intent);
      await store.settleOriginalTaskAdmission(id, id, {
        turnId: intent.turnId, inputDigest: intent.inputDigest,
        runId: "legacy-recovered:000001:0",
      });
      const review: AdvancementRunReview = {
        id: `review-${id}`, runIndex: 0,
        runRecordRef: { shardId: "000001", runIndex: 0 },
        reviewedAt: "2026-01-01T00:02:00.000Z", decision: "failed", evidence: [],
        attribution: { criteria: [{ criterionId: "p1", verdict: "unmet", reason: "unfinished" }] },
        unmetCriteria: ["unfinished"], selectedFailureHandlingId: "continue",
        proxyMessageId: `proxy-${id}`,
      };
      if (id === ids[0]) {
        // Persist a review whose proxy enqueue was interrupted.
        await store.appendRunReview(id, id, review);
      } else {
        await store.appendRunReviewWithProxyMessage(id, id, review, {
          id: review.proxyMessageId!, sessionId: id, reviewId: review.id,
          content: { parts: [{ type: "text", text: "continue" }] },
          rubricFailureHandlingId: "continue", variables: {},
          attribution: review.attribution, createdAt: review.reviewedAt,
        });
      }
    }
    const lifecycle = new AnchorSessionBroadcastLifecycle();
    const events = createAdvancementEventSink(lifecycle.port.session);
    const schedule = vi.fn(async () => ({ status: "queued" as const }));
    const maintenance = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store }),
      reviews: createAdvancementReviewAttemptApplication({
        store,
        // This fixture replays settled reviews; acquiring new model work is forbidden.
        resources: { inspectImmediateRoot: () => { throw new Error("unexpected new review"); } } as never,
        mechanism: createAdvancementReviewExternalMechanism({}), reviewerAvailable: false,
      }),
      directory: {
        list: async () => ids.map((id) => ({ id })),
        exists: async () => true,
        readRunsReverse: async () => ({
          runs: [{ shardId: "000001", record: {
            type: "run", runIndex: 0, timestamp: "2026-01-01T00:01:30.000Z",
            messages: [], source: "interactive",
          } }], hasMore: false,
        }),
      } as never,
      proxyTurns: {
        isRunning: () => false,
        inspectDurableClaim: async () => ({ status: "unclaimed" }),
        schedule,
      },
      events,
      reviewResults: new AdvancementReviewResultProjectionApplicationService({ events }),
    });
    const notify = vi.fn();
    lifecycle.install(createSessionBroadcastTransport({
      connections: new Set([{ id: "observer", authenticated: true, closed: false, notify }]),
      observerConnectionIds: () => new Set(["observer"]),
    }));
    const results = await maintenance.recoverAllOpenSessions();
    expect(results.map((result) => result.status)).toEqual(["scheduled", "scheduled"]);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map((call) => call[1].event)).toEqual([
      "advancement:proxy_enqueued", "advancement:proxy_recovered", "advancement:proxy_recovered",
    ]);
    expect((await store.loadActiveSession(ids[0]!))?.outstandingProxyMessageId)
      .toBe(`proxy-${ids[0]}`);
    // The stop-recovery caller and normal startup share this idempotent scan.
    expect((await maintenance.recoverAllOpenSessions()).map((result) => result.status))
      .toEqual(["already-scheduled", "already-scheduled"]);
    expect(schedule).toHaveBeenCalledTimes(2);
    lifecycle.close();
  });
});

function transport(label: string): {
  readonly transport: SessionBroadcastTransport;
  readonly notifications: unknown[][];
} {
  const notifications: unknown[][] = [];
  const connection = {
    id: label,
    authenticated: true,
    closed: false,
    notify(method: string, params: unknown) {
      notifications.push([label, method, params]);
    },
  };
  return {
    transport: createSessionBroadcastTransport({
      connections: new Set([connection]),
      observerConnectionIds: (conversationId: string) =>
        conversationId === "conversation-1"
          ? new Set([label])
          : new Set<string>(),
    }),
    notifications,
  };
}

function activity(conversationId: string) {
  return {
    conversationId,
    source: "test",
    lastActiveAt: "2026-08-24T00:00:00.000Z",
    unreadHint: true,
    listInvalidated: true,
  } as const;
}
