import type {
  ChannelResponderRef,
  ConversationChannelChallengeToken,
  StreamAck,
  StreamFrame,
  StreamSubscribe,
} from "@zhixing/core/contracts";
import {
  createSignedDataPlaneTicket,
  byteDigest,
  canonicalize,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AssignmentStreamPathConnection } from "./assignment-stream-path-manager.js";
import {
  ConversationChannelHost,
  type ConversationChannelJournal,
} from "./conversation-channel-confirmation.js";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test",
      keyId: "owner-fixed",
      sig: protocolDigest("TestSignature", 1, {
        schemaId,
        version,
        payload,
      }),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

const ref = {
  execution: "conversation" as const,
  conversationId: "conversation-fixed",
  runId: "run-fixed",
  ownerEpoch: 3,
};
const responder: ChannelResponderRef = {
  channelId: "feishu",
  tenant: "tenant-fixed",
  platformSubject: "user-fixed",
};

describe("ConversationChannelHost", () => {
  it("durably adopts a requested frame before ACK and resolves with its local ticket", async () => {
    const order: string[] = [];
    const journal: ConversationChannelJournal = {
      adoptConversationChannelFrame: vi.fn(async () => {
        order.push("adopt");
        return {};
      }),
      authorizeConversationChannelCallback: vi.fn(async () => ({
        assignmentId: "assignment-fixed",
        interactionRequestId: "interaction-fixed",
      })),
    };
    const connection = recordedConnection([requestedFrame()], order);
    const resolver = {
      resolve: vi.fn(async () => true),
    };
    const host = new ConversationChannelHost({
      assignmentId: "assignment-fixed",
      ref,
      ticket: interactionTicket(),
      verifier: identity,
      journal,
      resolver,
      connector: { async open() { return connection; } },
      now: () => "2026-07-28T00:01:00.000Z",
    });

    await host.poll();
    expect(order).toEqual(["adopt", "ack:1"]);

    const token = { challengeId: "challenge-fixed" } as
      ConversationChannelChallengeToken;
    await expect(
      host.resolveCallback({
        token,
        responder,
        decision: { kind: "allow-once" },
      }),
    ).resolves.toBe(true);
    expect(journal.authorizeConversationChannelCallback).toHaveBeenCalledWith({
      token,
      responder,
      at: "2026-07-28T00:01:00.000Z",
    });
    expect(resolver.resolve).toHaveBeenCalledWith({
      assignmentId: "assignment-fixed",
      requestId: "interaction-fixed",
      ticketId: "ticket-fixed",
      surfacePrincipal: "channel:feishu:tenant-fixed:user-fixed",
      decision: { kind: "allow-once" },
    });
  });

  it("does not expose a ticket input and rejects a callback before resolution", async () => {
    const resolver = { resolve: vi.fn(async () => true) };
    const journal: ConversationChannelJournal = {
      async adoptConversationChannelFrame() {
        return {};
      },
      async authorizeConversationChannelCallback() {
        throw new TypeError("responder mismatch");
      },
    };
    const host = new ConversationChannelHost({
      assignmentId: "assignment-fixed",
      ref,
      ticket: interactionTicket(),
      verifier: identity,
      journal,
      resolver,
      connector: { async open() { throw new Error("unused"); } },
      now: () => "2026-07-28T00:01:00.000Z",
    });

    await expect(
      host.resolveCallback({
        token: { challengeId: "challenge-fixed" } as
          ConversationChannelChallengeToken,
        responder: { ...responder, platformSubject: "observer" },
        decision: { kind: "deny", reason: "no" },
      }),
    ).rejects.toThrow(/responder mismatch/);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("materializes the original referenced display through the authenticated stream path", async () => {
    const inline = {
      title: "Large command",
      lines: ["x".repeat(9 * 1024)],
    };
    const bytes = Buffer.from(canonicalize(inline), "utf8");
    const refValue = {
      digest: byteDigest(bytes),
      bytes: bytes.byteLength,
    };
    const host = new ConversationChannelHost({
      assignmentId: "assignment-fixed",
      ref,
      ticket: interactionTicket(),
      verifier: identity,
      journal: {
        async adoptConversationChannelFrame() {
          return {};
        },
        async authorizeConversationChannelCallback() {
          throw new Error("unused");
        },
      },
      resolver: { async resolve() { return false; } },
      connector: {
        async open() {
          return {
            async subscribe() {
              return [];
            },
            async acknowledge() {},
            async readArtifact(request) {
              const end = Math.min(
                bytes.byteLength,
                request.offset + request.limit,
              );
              return {
                ref: refValue,
                offset: request.offset,
                bytes: bytes.subarray(request.offset, end),
                complete: end === bytes.byteLength,
              };
            },
          };
        },
      },
      now: () => "2026-07-28T00:01:00.000Z",
    });

    await expect(
      host.materializeInteractionDisplay({ ref: refValue }),
    ).resolves.toEqual(inline);
  });
});

function interactionTicket() {
  return createSignedDataPlaneTicket(
    {
      v: 1,
      ticketId: "ticket-fixed",
      ref,
      assignmentId: "assignment-fixed",
      surfacePrincipal: "channel:feishu:tenant-fixed:user-fixed",
      executorId: "executor-fixed",
      issuedAt: "2026-07-28T00:00:00.000Z",
      expiry: "2026-07-28T00:05:00.000Z",
      kind: "run-interact",
      renewable: true,
    },
    identity,
  );
}

function requestedFrame(): StreamFrame {
  return {
    v: 1,
    ref,
    assignmentId: "assignment-fixed",
    streamEpoch: 1,
    seq: 1,
    payload: {
      kind: "interaction",
      event: {
        t: "requested",
        requestId: "interaction-fixed",
        toolName: "bash",
        display: {
          title: "Run command",
          lines: ["echo ok"],
        },
        issuedAt: "2026-07-28T00:00:00.000Z",
        ttlMs: 5 * 60 * 1_000,
        expiresAt: "2026-07-28T00:05:00.000Z",
      },
    },
    meta: {},
  };
}

function recordedConnection(
  frames: readonly StreamFrame[],
  order: string[],
): AssignmentStreamPathConnection & {
  readonly subscriptions: StreamSubscribe[];
  readonly acknowledgments: StreamAck[];
} {
  const subscriptions: StreamSubscribe[] = [];
  const acknowledgments: StreamAck[] = [];
  return {
    subscriptions,
    acknowledgments,
    async subscribe(request) {
      subscriptions.push(request);
      return frames.filter((frame) => frame.seq > request.afterSeq);
    },
    async acknowledge(ack) {
      acknowledgments.push(ack);
      order.push(`ack:${ack.ackSeq}`);
    },
  };
}
import { Buffer } from "node:buffer";
