import { describe, expect, it, vi } from "vitest";
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
    deliveryHistory: async (cursors) => ({ notices: [], next: cursors }),
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
    await vi.waitFor(() => {
      expect(seen).toEqual([1, 2, 3, 4]);
    });
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
      deliveryHistory: async (cursors) => {
        // 只按请求的主体补读，不夹带未请求的条目
        expect(cursors).toEqual([{ itemId: "dlv-1", afterStatusRevision: 1 }]);
        return {
          notices: [
            {
              ref: deliverySubject,
              state: "delivery-failed",
              statusRevision: 2,
              actions: [],
              at: "2026-07-28T00:00:00.000Z",
              attempt: 1,
              anchorEpoch: 1,
            } as never,
          ],
          next: [{ itemId: "dlv-1", afterStatusRevision: 2 }],
        };
      },
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

  it("replays only the requested delivery subject page by page, then releases live notices in order", async () => {
    const deliveryNotice = (itemId: string, statusRevision: number) => ({
      ref: { execution: "delivery", itemId },
      state: "delivery-failed",
      statusRevision,
      actions: [],
      at: "2026-07-28T00:00:00.000Z",
      attempt: 1,
      anchorEpoch: 1,
    }) as unknown as ExecutionStatusNotice;
    // 请求的主体有 300 条历史，另一个未请求的条目也有历史；源端每个主体每页至多 128 条
    const histories = new Map([
      ["dlv-requested", Array.from({ length: 300 }, (_, index) => deliveryNotice("dlv-requested", index + 1))],
      ["dlv-other", Array.from({ length: 50 }, (_, index) => deliveryNotice("dlv-other", index + 1))],
    ]);
    const requested: string[][] = [];
    const sources = new ExecutionStatusHub({
      conversationHistory: async (requests) => ({ notices: [], next: requests }),
      jobHistory: async (cursors) => ({ notices: [], next: cursors }),
      deliveryHistory: async (cursors) => {
        requested.push(cursors.map(({ itemId }) => itemId));
        const notices = cursors.flatMap((cursor) => (histories.get(cursor.itemId) ?? [])
          .filter((candidate) => candidate.statusRevision > cursor.afterStatusRevision)
          .slice(0, 128));
        return {
          notices: notices as never,
          next: cursors.map((cursor) => ({
            itemId: cursor.itemId,
            afterStatusRevision: notices.filter((candidate) => candidate.ref.execution === "delivery" &&
              candidate.ref.itemId === cursor.itemId).at(-1)?.statusRevision ?? cursor.afterStatusRevision,
          })),
        };
      },
    });
    const seen: string[] = [];
    const session = new FirstPartyFinalitySession({
      sources,
      lastSeen: [{ subject: { execution: "delivery", itemId: "dlv-requested" }, afterStatusRevision: 0 }],
      onStatus: (accepted) => {
        if (accepted.ref.execution === "delivery") seen.push(`${accepted.ref.itemId}:${accepted.statusRevision}`);
      },
    });
    const startup = session.start();
    // 补读期间到达的 live：请求主体的下一条与一个新条目的第一条
    sources.publish(deliveryNotice("dlv-requested", 301));
    sources.publish(deliveryNotice("dlv-new", 1));
    await startup;

    // 只读请求的主体，按页推进到它的水位即止，不读其他条目的历史
    expect(requested).toEqual([["dlv-requested"], ["dlv-requested"], ["dlv-requested"], ["dlv-requested"]]);
    // 补读完成即按修订号放行缓冲的 live（在同一串行队列里紧随补读），不再等任何其他历史
    await vi.waitFor(() => {
      expect(seen).toEqual([
        ...Array.from({ length: 300 }, (_, index) => `dlv-requested:${index + 1}`),
        "dlv-requested:301",
        "dlv-new:1",
      ]);
    });
    expect(requested).toHaveLength(4);
    expect(session.nextCursors()).toEqual([
      { subject: { execution: "delivery", itemId: "dlv-requested" }, afterStatusRevision: 301 },
    ]);
    session.close();
  });
});
