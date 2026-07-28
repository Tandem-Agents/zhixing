import { describe, expect, it } from "vitest";
import type { ExecutionStatusNotice } from "@zhixing/core/contracts";
import {
  ExecutionStatusHub,
  FirstPartyFinalitySession,
  type ExecutionStatusCursor,
} from "./first-party-finality-session.js";

const subject = {
  execution: "conversation" as const,
  conversationId: "conv-1",
  runId: "run-1",
  ownerEpoch: 1,
};

function notice(statusRevision: number): ExecutionStatusNotice {
  return {
    ref: subject,
    state: "running",
    statusRevision,
    actions: [],
    at: "2026-07-28T00:00:00.000Z",
  } as unknown as ExecutionStatusNotice;
}

function hub(history: readonly ExecutionStatusNotice[]): ExecutionStatusHub {
  return new ExecutionStatusHub({
    conversationHistory: async (requests) => {
      const request = requests[0]!;
      const notices = history.filter(
        (candidate) => candidate.statusRevision > request.afterStatusRevision,
      );
      const last = notices.at(-1)?.statusRevision ?? request.afterStatusRevision;
      return {
        notices: notices as never,
        next: [{ ...request, afterStatusRevision: last }],
      };
    },
    jobHistory: async (cursors) => ({ notices: [], next: cursors }),
    deliveryHistory: async () => [],
  });
}

describe("FirstPartyFinalitySession", () => {
  it("subscribes first, buffers out-of-order live notices, then merges history without gaps", async () => {
    const sources = hub([notice(1), notice(2)]);
    const seen: number[] = [];
    const session = new FirstPartyFinalitySession({
      sources,
      lastSeen: [{ subject, afterStatusRevision: 0 }],
      onStatus: (accepted) => {
        seen.push(accepted.statusRevision);
      },
    });
    // 补读完成前,乱序的实时通知先进入缓冲——释放序由 revision 门保证。
    const startup = session.start();
    sources.publish(notice(3));
    await startup;

    expect(seen).toEqual([1, 2, 3]);
    expect(session.nextCursors()).toEqual([
      { subject, afterStatusRevision: 3 },
    ]);

    sources.publish(notice(3));
    sources.publish(notice(4));
    await Promise.resolve();
    expect(seen).toEqual([1, 2, 3, 4]);
    session.close();
  });

  it("rebuilds from returned cursors after a disconnect with zero skips", async () => {
    const sources = hub([notice(1), notice(2), notice(3)]);
    const first: number[] = [];
    const session = new FirstPartyFinalitySession({
      sources,
      lastSeen: [{ subject, afterStatusRevision: 0 }],
      onStatus: (accepted) => {
        first.push(accepted.statusRevision);
      },
    });
    await session.start();
    const cursors: readonly ExecutionStatusCursor[] = session.nextCursors();
    session.close();

    const resumedSources = hub([notice(1), notice(2), notice(3), notice(4)]);
    const resumed: number[] = [];
    const next = new FirstPartyFinalitySession({
      sources: resumedSources,
      lastSeen: cursors,
      onStatus: (accepted) => {
        resumed.push(accepted.statusRevision);
      },
    });
    await next.start();
    expect(first).toEqual([1, 2, 3]);
    expect(resumed).toEqual([4]);
    next.close();
  });

  it("keeps the old watermark and requires resynchronization when a consumer rejects", async () => {
    const sources = hub([notice(1)]);
    const failures: Error[] = [];
    const session = new FirstPartyFinalitySession({
      sources,
      lastSeen: [{ subject, afterStatusRevision: 0 }],
      onStatus: async () => {
        throw new Error("connection queue rejected the notice");
      },
      onResyncRequired: (error) => failures.push(error),
    });

    await expect(session.start()).rejects.toThrow(/resynchronization/u);
    expect(session.nextCursors()).toEqual([
      { subject, afterStatusRevision: 0 },
    ]);
    expect(failures).toHaveLength(1);
    await expect(session.acceptProvisionalFinal({
      v: 1,
      assignmentId: "assignment-1",
      ref: subject,
      streamEpoch: 1,
      seq: 1,
      payload: {
        kind: "provisional-final",
        finalSeq: 1,
        streamDigest: `sha256:${"a".repeat(64)}`,
      },
      meta: {},
    })).rejects.toThrow(/resynchronization/u);
  });

  it("routes mixed-domain history through the hub and advances every cursor", async () => {
    const jobSubject = {
      execution: "job" as const,
      taskId: "task-1",
      jobRunId: "job-1",
      anchorEpoch: 1,
    };
    const deliverySubject = { execution: "delivery" as const, itemId: "dlv-1" };
    const sources = new ExecutionStatusHub({
      conversationHistory: async (requests) => ({
        notices: [notice(1)] as never,
        next: requests.map((request) => ({
          ...request,
          afterStatusRevision: 1,
        })),
      }),
      jobHistory: async (cursors) => ({
        notices: [],
        next: cursors,
      }),
      deliveryHistory: async () => [
        {
          ref: deliverySubject,
          state: "delivery-failed",
          statusRevision: 2,
          actions: [],
          at: "2026-07-28T00:00:00.000Z",
          attempt: 1,
          anchorEpoch: 1,
        } as unknown as ExecutionStatusNotice,
      ],
    });
    const page = await sources.statusHistory([
      { subject, afterStatusRevision: 0 },
      { subject: jobSubject, afterStatusRevision: 5 },
      { subject: deliverySubject, afterStatusRevision: 1 },
    ]);
    expect(page.next).toEqual([
      { subject, afterStatusRevision: 1 },
      { subject: jobSubject, afterStatusRevision: 5 },
      { subject: deliverySubject, afterStatusRevision: 2 },
    ]);
    expect(page.notices).toHaveLength(2);
  });
});
