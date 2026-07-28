import type {
  ChannelChallengeToken,
  ChannelInteractionGrant,
  InteractionDisplay,
} from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { protocolDigest } from "./canonical.js";
import {
  assertChannelChallengeActiveAt,
  assertChannelChallengeBinding,
  assertChannelInteractionGrantActiveAt,
  assertChannelInteractionGrantBinding,
  channelChallengeTokenDigest,
  channelInteractionGrantDigest,
  createSignedChannelChallengeToken,
  createSignedChannelInteractionGrant,
  interactionDisplayDigest,
  validateChannelChallengeToken,
  validateChannelInteractionGrant,
} from "./channel-interaction.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";

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

const display: InteractionDisplay = {
  title: "Run command?",
  lines: ["pnpm test"],
};
const route = {
  channelId: "feishu",
  to: "user-1",
  threadId: "thread-1",
};
const jobRef = {
  execution: "job" as const,
  taskId: "task-1",
  jobRunId: "job-run-1",
  anchorEpoch: 4,
};

function token(
  ref: ChannelChallengeToken["ref"] = jobRef,
): ChannelChallengeToken {
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

function grant(): ChannelInteractionGrant {
  return createSignedChannelInteractionGrant(
    {
      v: 1,
      grantId: "grant-1",
      ref: jobRef,
      assignmentId: "assignment-1",
      interactionRequestId: "interaction-1",
      challengeToken: token() as Extract<
        ChannelChallengeToken,
        { ref: { execution: "job" } }
      >,
      route,
      responder: {
        channelId: "feishu",
        platformSubject: "user-1",
        tenant: "tenant-1",
      },
      decision: { allowed: true },
      issuedAt: "2026-07-28T00:01:00.000Z",
      expiry: "2026-07-28T00:04:00.000Z",
    },
    identity,
    identity,
  );
}

describe("channel interaction protocol", () => {
  it("signs, validates, digests, and binds conversation and job tokens", () => {
    const values = [
      token(),
      token({
        execution: "conversation",
        conversationId: "conversation-1",
        runId: "run-1",
        ownerEpoch: 2,
      }),
    ];
    for (const value of values) {
      expect(validateChannelChallengeToken(value, identity)).toEqual(value);
      const { signature: _, ...payload } = value;
      expect(channelChallengeTokenDigest(value)).toBe(
        protocolDigest("ChannelChallengeToken", 1, payload),
      );
      expect(() =>
        assertChannelChallengeBinding(value, {
          ref: value.ref,
          assignmentId: value.assignmentId,
          interactionRequestId: value.interactionRequestId,
          route,
          toolName: "bash",
          display,
        }),
      ).not.toThrow();
      expect(() =>
        assertChannelChallengeActiveAt(
          value,
          "2026-07-28T00:02:00.000Z",
        ),
      ).not.toThrow();
    }
  });

  it("rejects unknown fields, tampering, wrong bindings, and inactive tokens", () => {
    const value = token();
    expect(() =>
      validateChannelChallengeToken({ ...value, extra: true }, identity),
    ).toThrow(/fields/);
    expect(() =>
      validateChannelChallengeToken(
        { ...value, displayDigest: `sha256:${"0".repeat(64)}` },
        identity,
      ),
    ).toThrow();
    for (const mutation of [
      { assignmentId: "assignment-other" },
      { interactionRequestId: "interaction-other" },
      { route: { ...route, to: "user-other" } },
      { toolName: "write" },
      { display: { ...display, title: "Different" } },
    ]) {
      expect(() =>
        assertChannelChallengeBinding(value, {
          ref: value.ref,
          assignmentId: "assignment-1",
          interactionRequestId: "interaction-1",
          route,
          toolName: "bash",
          display,
          ...mutation,
        }),
      ).toThrow(/does not bind/);
    }
    expect(() =>
      assertChannelChallengeActiveAt(value, "2026-07-28T00:05:00.000Z"),
    ).toThrow(/not active/);
  });

  it("signs a job-only grant and rejects every mismatched signed field", () => {
    const value = grant();
    expect(validateChannelInteractionGrant(value, identity)).toEqual(value);
    const { signature: _, ...payload } = value;
    expect(channelInteractionGrantDigest(value)).toBe(
      protocolDigest("ChannelInteractionGrant", 1, payload),
    );
    const binding = {
      ref: jobRef,
      assignmentId: "assignment-1",
      interactionRequestId: "interaction-1",
      challengeId: "challenge-1",
      route,
      responder: value.responder,
      decision: value.decision,
      toolName: "bash",
      display,
    };
    expect(() =>
      assertChannelInteractionGrantBinding(value, binding),
    ).not.toThrow();
    expect(() =>
      assertChannelInteractionGrantActiveAt(
        value,
        "2026-07-28T00:02:00.000Z",
      ),
    ).not.toThrow();
    for (const mutation of [
      { assignmentId: "assignment-other" },
      { interactionRequestId: "interaction-other" },
      { challengeId: "challenge-other" },
      { route: { ...route, to: "user-other" } },
      {
        responder: { ...value.responder, platformSubject: "user-other" },
      },
      { decision: { allowed: false } },
      { toolName: "write" },
    ]) {
      expect(() =>
        assertChannelInteractionGrantBinding(value, {
          ...binding,
          ...mutation,
        }),
      ).toThrow();
    }
  });

  it("rejects conversation tokens in grants and grant intervals beyond the token", () => {
    const conversationToken = token({
      execution: "conversation",
      conversationId: "conversation-1",
      runId: "run-1",
      ownerEpoch: 2,
    });
    expect(() =>
      createSignedChannelInteractionGrant(
        {
          ...grantWithoutSignature(),
          challengeToken: conversationToken as never,
        },
        identity,
        identity,
      ),
    ).toThrow(/Conversation|job-only/);
    expect(() =>
      createSignedChannelInteractionGrant(
        {
          ...grantWithoutSignature(),
          expiry: "2026-07-28T00:06:00.000Z",
        },
        identity,
        identity,
      ),
    ).toThrow(/exceeds its challenge/);
  });
});

function grantWithoutSignature(): Omit<ChannelInteractionGrant, "signature"> {
  const value = grant();
  const { signature: _, ...payload } = value;
  return payload;
}
