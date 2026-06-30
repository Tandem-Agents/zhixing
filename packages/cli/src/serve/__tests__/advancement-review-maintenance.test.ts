import { describe, expect, it, vi } from "vitest";
import type {
  AdvancementTurnReviewResult,
  SessionEventEnvelope,
  TurnCommittedInfo,
} from "@zhixing/server";
import type { Message } from "@zhixing/core";
import { createAdvancementReviewMaintenance } from "../advancement-review-maintenance.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeInfo(overrides?: Partial<TurnCommittedInfo>): TurnCommittedInfo {
  const userMsg: Message = {
    role: "user",
    content: [{ type: "text", text: "把测试修到全绿" }],
  };
  return {
    conversationId: "conv-1",
    turnId: "turn-1",
    turnCount: 1,
    runIndex: 0,
    runRecordRef: { shardId: "000001", runIndex: 0 },
    runRecord: {
      timestamp: "2026-01-01T00:00:00.000Z",
      messages: [userMsg],
    },
    runMessages: [userMsg],
    ephemeral: false,
    runtime: { sessionId: "conv-1" } as never,
    ...overrides,
  };
}

function reviewed(
  kind: "reviewed" | "completed" | "exited" = "reviewed",
): AdvancementTurnReviewResult {
  const review = {
    id: "review-1",
    runIndex: 0,
    reviewedAt: "2026-01-01T00:01:00.000Z",
    decision: kind === "completed" ? "passed" : kind === "exited" ? "exit" : "failed",
    evidence: [],
    unmetCriteria: kind === "completed" ? [] : ["测试未全绿"],
  } as const;
  const session = {
    id: "adv-1",
    conversationId: "conv-1",
  } as never;
  if (kind === "reviewed") return { kind, session, review };
  return {
    kind,
    session,
    review,
    exit: {
      reason: kind === "completed" ? "passed" : "system-error",
      message: "done",
      occurredAt: "2026-01-01T00:02:00.000Z",
    },
  } as AdvancementTurnReviewResult;
}

describe("createAdvancementReviewMaintenance", () => {
  it("验收完成后发 run_reviewed control 事件", async () => {
    const events: SessionEventEnvelope[] = [];
    const advancement = {
      afterTurnCommitted: vi.fn(async () => reviewed()),
    };
    const maintain = createAdvancementReviewMaintenance({
      advancement: advancement as never,
      sessionBroadcast: () => (_conversationId, method, payload) => {
        expect(method).toBe("session.event");
        events.push(payload as SessionEventEnvelope);
      },
    });

    maintain(makeInfo());
    await flush();

    expect(advancement.afterTurnCommitted).toHaveBeenCalledWith({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: expect.objectContaining({ timestamp: "2026-01-01T00:00:00.000Z" }),
      runRecordRef: { shardId: "000001", runIndex: 0 },
    });
    expect(events).toEqual([
      expect.objectContaining({
        conversationId: "conv-1",
        scope: "control",
        runId: "turn-1",
        seq: 0,
        event: "advancement:run_reviewed",
      }),
    ]);
  });

  it("completed/exited 会在 review 后追加终态 control 事件", async () => {
    for (const kind of ["completed", "exited"] as const) {
      const events: SessionEventEnvelope[] = [];
      const maintain = createAdvancementReviewMaintenance({
        advancement: {
          afterTurnCommitted: vi.fn(async () => reviewed(kind)),
        } as never,
        sessionBroadcast: () => (_conversationId, _method, payload) => {
          events.push(payload as SessionEventEnvelope);
        },
      });

      maintain(makeInfo());
      await flush();

      expect(events.map((event) => event.event)).toEqual([
        "advancement:run_reviewed",
        kind === "completed" ? "advancement:completed" : "advancement:exited",
      ]);
      expect(events[1]?.seq).toBe(1);
      expect(events[1]?.scope).toBe("control");
    }
  });

  it("ephemeral 与 skipped 不发事件", async () => {
    const events: SessionEventEnvelope[] = [];
    const advancement = {
      afterTurnCommitted: vi.fn(async () => ({
        kind: "skipped",
        reason: "no-active-session",
      })),
    };
    const maintain = createAdvancementReviewMaintenance({
      advancement: advancement as never,
      sessionBroadcast: () => (_conversationId, _method, payload) => {
        events.push(payload as SessionEventEnvelope);
      },
    });

    maintain(makeInfo({ ephemeral: true }));
    maintain(makeInfo());
    await flush();

    expect(advancement.afterTurnCommitted).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("同一 conversation 的验收按 accepted run 顺序串行", async () => {
    const first = deferred<AdvancementTurnReviewResult>();
    const advancement = {
      afterTurnCommitted: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(reviewed()),
    };
    const maintain = createAdvancementReviewMaintenance({
      advancement: advancement as never,
      sessionBroadcast: () => null,
    });

    maintain(makeInfo({ runIndex: 0, turnId: "turn-1" }));
    maintain(makeInfo({ runIndex: 1, turnId: "turn-2" }));
    await flush();

    expect(advancement.afterTurnCommitted).toHaveBeenCalledTimes(1);
    expect(advancement.afterTurnCommitted).toHaveBeenLastCalledWith(
      expect.objectContaining({ runIndex: 0 }),
    );

    first.resolve(reviewed());
    await flush();
    await flush();

    expect(advancement.afterTurnCommitted).toHaveBeenCalledTimes(2);
    expect(advancement.afterTurnCommitted).toHaveBeenLastCalledWith(
      expect.objectContaining({ runIndex: 1 }),
    );
  });

  it("单次验收失败不阻断同一 conversation 后续验收", async () => {
    const advancement = {
      afterTurnCommitted: vi
        .fn()
        .mockRejectedValueOnce(new Error("store down"))
        .mockResolvedValueOnce(reviewed()),
    };
    const maintain = createAdvancementReviewMaintenance({
      advancement: advancement as never,
      sessionBroadcast: () => null,
    });

    maintain(makeInfo({ runIndex: 0, turnId: "turn-1" }));
    maintain(makeInfo({ runIndex: 1, turnId: "turn-2" }));
    await flush();
    await flush();

    expect(advancement.afterTurnCommitted).toHaveBeenCalledTimes(2);
    expect(advancement.afterTurnCommitted).toHaveBeenLastCalledWith(
      expect.objectContaining({ runIndex: 1 }),
    );
  });
});
