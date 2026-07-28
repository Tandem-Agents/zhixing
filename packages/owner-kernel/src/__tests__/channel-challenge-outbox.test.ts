import { describe, expect, it, vi } from "vitest";
import {
  ChannelChallengeOutbox,
  type ChannelChallengeOutboxStore,
  type PendingChannelChallenge,
} from "../channel-challenge-outbox.js";

const prepared = {
  t: "channel-challenge-prepared" as const,
  ref: {
    execution: "job" as const,
    taskId: "task-1",
    jobRunId: "job-1",
    anchorEpoch: 2,
  },
  assignmentId: "assignment-1",
  frameSeq: 1,
  token: {
    v: 1 as const,
    challengeId: "challenge-1",
    ref: {
      execution: "job" as const,
      taskId: "task-1",
      jobRunId: "job-1",
      anchorEpoch: 2,
    },
    assignmentId: "assignment-1",
    interactionRequestId: "interaction-1",
    route: { channelId: "feishu", to: "chat-1" },
    displayDigest: `sha256:${"a".repeat(64)}` as const,
    issuedAt: "2026-07-28T00:00:00.000Z",
    expiry: "2026-07-28T00:05:00.000Z",
    signature: { alg: "test", keyId: "owner", sig: "signed" },
  },
  responder: { channelId: "feishu", platformSubject: "user-1" },
  toolName: "bash",
  display: { title: "Approve?", lines: ["run"] },
};

describe("ChannelChallengeOutbox", () => {
  it("retries the same challenge identity and durably records one receipt", async () => {
    const store = memoryStore([{ prepared }]);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary channel failure"))
      .mockResolvedValue({
        acceptedAt: "2026-07-28T00:01:00.000Z",
        platformMessage: { channelId: "feishu", messageId: "message-1" },
      });
    const outbox = new ChannelChallengeOutbox({
      store,
      sender: { send },
      now: () => "2026-07-28T00:01:00.000Z",
    });

    await expect(outbox.drain()).resolves.toEqual({
      delivered: 1,
      expired: 0,
      failures: [],
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([value]) => value.challengeId)).toEqual([
      "challenge-1",
      "challenge-1",
    ]);
    await expect(outbox.drain()).resolves.toMatchObject({ delivered: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("closes expired work without sending and leaves bounded failures pending", async () => {
    const expiredStore = memoryStore([{ prepared }]);
    const send = vi.fn();
    const expired = new ChannelChallengeOutbox({
      store: expiredStore,
      sender: { send },
      now: () => "2026-07-28T00:05:00.000Z",
    });
    await expect(expired.drain()).resolves.toMatchObject({ expired: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(expiredStore.closed).toEqual(["challenge-1"]);

    const failedStore = memoryStore([{ prepared }]);
    const failed = new ChannelChallengeOutbox({
      store: failedStore,
      sender: { send: vi.fn().mockRejectedValue(new Error("offline")) },
      now: () => "2026-07-28T00:01:00.000Z",
      maxAttempts: 2,
    });
    await expect(failed.drain()).resolves.toMatchObject({
      delivered: 0,
      failures: [{ challengeId: "challenge-1" }],
    });
    expect((await failedStore.pendingChannelChallenges())).toHaveLength(1);
  });
});

function memoryStore(initial: readonly PendingChannelChallenge[]) {
  const pending = [...initial];
  const closed: string[] = [];
  const store: ChannelChallengeOutboxStore & { readonly closed: string[] } = {
    closed,
    async pendingChannelChallenges() {
      return pending;
    },
    async recordChannelChallengeDelivered(input) {
      const index = pending.findIndex(
        (item) => item.prepared.token.challengeId === input.challengeId,
      );
      const item = pending[index]!;
      pending[index] = {
        ...item,
        delivered: {
          t: "channel-challenge-delivered",
          challengeId: input.challengeId,
          receipt: input.receipt,
        },
      };
    },
    async closeChannelChallenge(input) {
      closed.push(input.challengeId);
      const index = pending.findIndex(
        (item) => item.prepared.token.challengeId === input.challengeId,
      );
      pending.splice(index, 1);
    },
  };
  return store;
}
