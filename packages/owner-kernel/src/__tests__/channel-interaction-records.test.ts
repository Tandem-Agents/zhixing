import type {
  ChannelChallengeToken,
  ChannelInteractionGrant,
} from "@zhixing/core/contracts";
import {
  createSignedChannelChallengeToken,
  createSignedChannelInteractionGrant,
  interactionDisplayDigest,
  protocolDigest,
  streamDigestSeed,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { describe, expect, it } from "vitest";
import {
  advanceChannelInteractionJournal,
  createChannelInteractionJournalState,
  validateChannelInteractionRelayRecord,
  validateConversationChannelChallengeRecord,
} from "../channel-interaction-records.js";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test",
      keyId: "device:owner",
      sig: protocolDigest("TestSignature", 1, { schemaId, version, payload }),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

const display = { title: "Approve?", lines: ["run"] };
const route = { channelId: "feishu", to: "user-1" };
const ref = {
  execution: "job" as const,
  taskId: "task-1",
  jobRunId: "job-run-1",
  anchorEpoch: 3,
};

function challenge(): ChannelChallengeToken {
  return createSignedChannelChallengeToken(
    {
      v: 1,
      challengeId: "challenge-1",
      ref,
      assignmentId: "assignment-1",
      interactionRequestId: "interaction-1",
      route,
      displayDigest: interactionDisplayDigest("bash", display),
      issuedAt: "2026-07-28T00:00:00.000Z",
      expiry: "2026-07-28T00:05:00.000Z",
    },
    identity,
  );
}

function channelGrant(): ChannelInteractionGrant {
  return createSignedChannelInteractionGrant(
    {
      v: 1,
      grantId: "grant-1",
      ref,
      assignmentId: "assignment-1",
      interactionRequestId: "interaction-1",
      challengeToken: challenge() as Extract<
        ChannelChallengeToken,
        { ref: { execution: "job" } }
      >,
      route,
      responder: { channelId: "feishu", platformSubject: "user-1" },
      decision: { allowed: true },
      issuedAt: "2026-07-28T00:01:00.000Z",
      expiry: "2026-07-28T00:04:00.000Z",
    },
    identity,
    identity,
  );
}

function prepared() {
  return {
    t: "channel-challenge-prepared" as const,
    ref,
    assignmentId: "assignment-1",
    frameSeq: 4,
    token: challenge(),
    responder: { channelId: "feishu", platformSubject: "user-1" },
    toolName: "bash",
    display,
  };
}

function relayCheckpoint(upToSeq: number) {
  return {
    assignmentId: "assignment-1",
    ref,
    streamEpoch: 2,
    lastSeq: upToSeq,
    dataFrames: upToSeq,
    head: streamDigestSeed("assignment-1"),
    ...(upToSeq === 0
      ? {}
      : {
          lastLogicalDigest: protocolDigest("TestStreamFrame", 1, {
            upToSeq,
          }),
        }),
  };
}

describe("channel interaction journal records", () => {
  it("validates job records and enforces one challenge per interaction", () => {
    const initial = createChannelInteractionJournalState("job");
    const first = advanceChannelInteractionJournal(initial, prepared(), identity);
    expect(first.challengeByInteraction.get("assignment-1\u0000interaction-1"))
      .toBe("challenge-1");
    expect(() =>
      advanceChannelInteractionJournal(
        first,
        {
          ...prepared(),
          token: createSignedChannelChallengeToken(
            {
              ...unsignedChallenge(),
              challengeId: "challenge-2",
            },
            identity,
          ),
        },
        identity,
      ),
    ).toThrow(/idempotency/);
  });

  it("requires prepare before delivery, grant, and close", () => {
    const initial = createChannelInteractionJournalState("job");
    for (const record of [
      {
        t: "channel-challenge-delivered",
        challengeId: "challenge-1",
        receipt: { acceptedAt: "2026-07-28T00:01:00.000Z" },
      },
      {
        t: "channel-challenge-closed",
        challengeId: "challenge-1",
        outcome: "allowed",
        at: "2026-07-28T00:02:00.000Z",
      },
      {
        t: "channel-challenge-granted",
        challengeId: "challenge-1",
        jobRunId: "job-run-1",
        grant: channelGrant(),
      },
    ]) {
      expect(() =>
        advanceChannelInteractionJournal(initial, record, identity),
      ).toThrow(/no prepared/);
    }
  });

  it("advances a complete job lifecycle and rejects cursor rollback or grant conflict", () => {
    let state = createChannelInteractionJournalState("job");
    state = advanceChannelInteractionJournal(state, prepared(), identity);
    state = advanceChannelInteractionJournal(
      state,
      {
        t: "channel-relay-cursor",
        jobRunId: "job-run-1",
        assignmentId: "assignment-1",
        upToSeq: 4,
        checkpoint: relayCheckpoint(4),
      },
      identity,
    );
    state = advanceChannelInteractionJournal(
      state,
      {
        t: "channel-challenge-delivered",
        challengeId: "challenge-1",
        receipt: {
          acceptedAt: "2026-07-28T00:01:00.000Z",
          platformMessage: {
            channelId: "feishu",
            messageId: "message-1",
          },
        },
      },
      identity,
    );
    state = advanceChannelInteractionJournal(
      state,
      {
        t: "channel-challenge-granted",
        challengeId: "challenge-1",
        jobRunId: "job-run-1",
        grant: channelGrant(),
      },
      identity,
    );
    expect(state.grantByChallenge.has("challenge-1")).toBe(true);
    expect(() =>
      advanceChannelInteractionJournal(
        state,
        {
          t: "channel-relay-cursor",
          jobRunId: "job-run-1",
          assignmentId: "assignment-1",
          upToSeq: 3,
          checkpoint: relayCheckpoint(3),
        },
        identity,
      ),
    ).toThrow(/backwards/);
    expect(() =>
      advanceChannelInteractionJournal(
        state,
        {
          t: "channel-relay-cursor",
          jobRunId: "job-run-1",
          assignmentId: "assignment-1",
          upToSeq: 4,
          checkpoint: {
            ...relayCheckpoint(4),
            streamEpoch: 3,
          },
        },
        identity,
      ),
    ).toThrow(/conflicting verifier state/);
  });

  it("keeps conversation journals grant-free and validates exact shapes", () => {
    const conversationToken = createSignedChannelChallengeToken(
      {
        ...unsignedChallenge(),
        ref: {
          execution: "conversation",
          conversationId: "conversation-1",
          runId: "run-1",
          ownerEpoch: 2,
        },
      },
      identity,
    );
    const record = {
      ...prepared(),
      ref: conversationToken.ref,
      token: conversationToken,
    };
    expect(
      validateConversationChannelChallengeRecord(record, identity),
    ).toEqual(record);
    expect(() =>
      validateConversationChannelChallengeRecord(
        { ...record, extra: true },
        identity,
      ),
    ).toThrow(/fields/);
    expect(() =>
      validateChannelInteractionRelayRecord(
        {
          t: "channel-challenge-granted",
          challengeId: "challenge-1",
          jobRunId: "job-run-1",
          grant: {
            ...channelGrant(),
            challengeToken: conversationToken,
          },
        },
        identity,
      ),
    ).toThrow();
  });
});

function unsignedChallenge(): Omit<ChannelChallengeToken, "signature"> {
  const value = challenge();
  const { signature: _, ...payload } = value;
  return payload;
}
