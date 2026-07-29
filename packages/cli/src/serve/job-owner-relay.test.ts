import type {
  StreamAck,
  StreamConsumerAuth,
  StreamFrame,
  StreamSubscribe,
} from "@zhixing/core/contracts";
import { StreamFrameVerifier } from "@zhixing/core/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AssignmentStreamPathConnection } from "./assignment-stream-path-manager.js";
import {
  JobOwnerRelay,
  type JobOwnerRelayJournal,
} from "./job-owner-relay.js";

const ref = {
  execution: "job" as const,
  taskId: "task-1",
  jobRunId: "job-1",
  anchorEpoch: 3,
};
const firstAuth: Extract<
  StreamConsumerAuth,
  { readonly kind: "owner-relay" }
> = {
  kind: "owner-relay",
  authority: {
    execution: "job",
    taskId: "task-1",
    anchorEpoch: 3,
  },
  controlLeaseId: "lease-1",
};

describe("JobOwnerRelay", () => {
  it("restores the durable verifier, adopts before ACK, and rotates only the lease", async () => {
    const verifier = new StreamFrameVerifier({
      assignmentId: "assignment-1",
      ref,
    });
    verifier.accept(frame(1, 1));
    const initial = verifier.checkpoint();
    const order: string[] = [];
    const journal: JobOwnerRelayJournal = {
      channelRelayCheckpoint: vi.fn(async () => initial),
      prepareChannelRelayRequest: vi.fn(async () => {
        throw new Error("not requested");
      }),
      adoptChannelRelayFrame: vi.fn(async ({ checkpoint }) => {
        order.push(`adopt:${checkpoint.lastSeq}`);
        return { checkpoint };
      }),
      grantChannelChallenge: vi.fn(async () => {
        throw new Error("unused");
      }),
      pendingChannelGrantDeliveries: vi.fn(async () => []),
    };
    const first = connection([frame(2, 2)], order);
    const second = connection([], order);
    const queue = [first, second];
    const direct = {
      async open() {
        return queue.shift()!;
      },
    };
    const relay = await JobOwnerRelay.create({
      assignmentId: "assignment-1",
      ref,
      consumer: firstAuth,
      journal,
      resolver: {
        async resolveNoInteractiveSurface() {},
        async resolveGrant() {},
      },
      connector: direct,
    });

    await relay.poll();
    expect(first.subscriptions[0]).toMatchObject({ afterSeq: 1 });
    expect(order).toEqual(["ack:1", "adopt:2", "ack:2"]);

    await relay.rotateControlLease("lease-2");
    await relay.poll();
    expect(second.acknowledgments[0]).toMatchObject({
      ackSeq: 2,
      consumer: expect.objectContaining({ controlLeaseId: "lease-2" }),
    });
    expect(second.subscriptions[0]).toMatchObject({ afterSeq: 2 });
  });

  it("rejects an owner authority outside the job stream", async () => {
    await expect(
      JobOwnerRelay.create({
        assignmentId: "assignment-1",
        ref,
        consumer: {
          ...firstAuth,
          authority: {
            ...firstAuth.authority,
            taskId: "task-other",
          },
        },
        journal: {
          async channelRelayCheckpoint() {
            return undefined;
          },
          async prepareChannelRelayRequest() {
            throw new Error("unused");
          },
          async adoptChannelRelayFrame({ checkpoint }) {
            return { checkpoint };
          },
          async grantChannelChallenge() {
            throw new Error("unused");
          },
          async pendingChannelGrantDeliveries() {
            return [];
          },
        },
        resolver: {
          async resolveNoInteractiveSurface() {},
          async resolveGrant() {},
        },
        connector: { async open() { throw new Error("unused"); } },
      }),
    ).rejects.toThrow(/does not bind/);
  });
});

interface RecordedConnection extends AssignmentStreamPathConnection {
  readonly subscriptions: StreamSubscribe[];
  readonly acknowledgments: StreamAck[];
}

function connection(
  frames: readonly StreamFrame[],
  order: string[],
): RecordedConnection {
  const subscriptions: StreamSubscribe[] = [];
  const acknowledgments: StreamAck[] = [];
  return {
    subscriptions,
    acknowledgments,
    async subscribe(request) {
      subscriptions.push(request);
      return frames.filter((candidate) => candidate.seq > request.afterSeq);
    },
    async acknowledge(ack) {
      acknowledgments.push(ack);
      order.push(`ack:${ack.ackSeq}`);
    },
  };
}

function frame(seq: number, streamEpoch: number): StreamFrame {
  return {
    v: 1,
    ref,
    assignmentId: "assignment-1",
    streamEpoch,
    seq,
    payload: {
      kind: "agent-yield",
      yield: { type: "text_delta", text: String(seq) },
    },
    meta: {},
  };
}
