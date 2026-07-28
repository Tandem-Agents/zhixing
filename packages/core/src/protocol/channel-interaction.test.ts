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
  channelInteractionConfirmationDecision,
  channelInteractionGrantDigest,
  createSignedChannelChallengeToken,
  createSignedChannelInteractionGrant,
  interactionDisplayDigest,
  validateChannelChallengeCallback,
  validateChannelChallengeToken,
  validateChannelInteractionGrant,
} from "./channel-interaction.js";
import { confirmationDecisionDigest } from "./assignment.js";
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

describe("channel challenge callback validation", () => {
  const callback = () => ({
    v: 1,
    token: token(),
    decision: { allowed: true },
  });

  it("accepts a canonical callback and returns its token and decision", () => {
    const result = validateChannelChallengeCallback(callback());
    expect(result.token).toEqual(token());
    expect(result.decision).toEqual({ allowed: true });
  });

  it("rejects unknown fields on the payload, decision, and token", () => {
    expect(() =>
      validateChannelChallengeCallback({ ...callback(), extra: 1 }),
    ).toThrow(/incomplete or unknown/u);
    expect(() =>
      validateChannelChallengeCallback({
        ...callback(),
        decision: { allowed: false, verdict: "spoofed" },
      }),
    ).toThrow(/incomplete or unknown/u);
    expect(() =>
      validateChannelChallengeCallback({
        ...callback(),
        token: { ...token(), extra: true },
      }),
    ).toThrow(/incomplete or unknown/u);
  });

  it("rejects wrong versions and oversized reasons", () => {
    expect(() =>
      validateChannelChallengeCallback({ ...callback(), v: 2 }),
    ).toThrow(/version must be 1/u);
    expect(() =>
      validateChannelChallengeCallback({
        ...callback(),
        decision: { allowed: false, reason: "r".repeat(8 * 1024 + 1) },
      }),
    ).toThrow(/reason is invalid/u);
  });
});

describe("channel decision digest unification", () => {
  it("maps channel wire decisions onto the frozen confirmation decision digest", () => {
    expect(channelInteractionConfirmationDecision({ allowed: true })).toEqual({
      kind: "allow-once",
    });
    expect(
      channelInteractionConfirmationDecision({ allowed: false, reason: "no" }),
    ).toEqual({ kind: "deny", reason: "no" });
    expect(
      confirmationDecisionDigest(
        "interaction-1",
        channelInteractionConfirmationDecision({ allowed: false, reason: "no" }),
      ),
    ).toBe(
      protocolDigest("ConfirmationDecision", 1, {
        requestId: "interaction-1",
        decision: { kind: "deny", reason: "no" },
      }),
    );
  });
});
