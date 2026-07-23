import { describe, expect, it } from "vitest";
import type { StreamFrame } from "../contracts/protocol.js";
import {
  assertStreamFinalReconciliation,
  StreamDigestChain,
  StreamFrameVerifier,
  streamConsumerKey,
  validateStreamAck,
  validateStreamFrame,
  validateStreamSubscribe,
} from "./stream.js";

const ref = {
  execution: "conversation" as const,
  runId: "run-fixed",
  conversationId: "conversation-fixed",
  ownerEpoch: 0,
};

function frame(
  input: Omit<StreamFrame, "assignmentId" | "ref" | "v">,
): StreamFrame {
  return {
    v: 1,
    ref,
    assignmentId: "assignment-fixed",
    ...input,
  };
}

describe("StreamDigestChain", () => {
  it("uses the frozen empty-stream seed and reserves the final sequence", () => {
    const chain = new StreamDigestChain("assignment-fixed");

    expect(chain.final()).toEqual({
      finalSeq: 1,
      streamDigest: "sha256:e8d2a430008d77c3f5d9636a262d0813edb3781a57a9a4513481ee5f2a78be68",
    });
  });

  it("hashes the actual wrapped payload, sequence and metadata", () => {
    const chain = new StreamDigestChain("assignment-fixed");
    expect(
      chain.append(
        { kind: "agent-yield", yield: { type: "text_delta", text: "hi" } },
        {},
      ),
    ).toBe(1);
    expect(
      chain.append(
        {
          kind: "agent-event",
          event: {
            event: "agent:run_start",
            payload: { prompt: "hello" },
          },
        },
        { lineage: "main" },
      ),
    ).toBe(2);

    expect(chain.final()).toEqual({
      finalSeq: 3,
      streamDigest: "sha256:1ae48e7b4bbee6293fdb39450f0130f601b6c3cd8f765141a443693a394cebe4",
    });
  });

  it("restores the exact digest checkpoint without resetting sequence", () => {
    const first = new StreamDigestChain("assignment-fixed");
    first.append(
      { kind: "agent-yield", yield: { type: "text_delta", text: "one" } },
      {},
    );

    const restored = new StreamDigestChain(
      "assignment-fixed",
      first.checkpoint(),
    );
    expect(
      restored.append(
        { kind: "agent-yield", yield: { type: "text_delta", text: "two" } },
        {},
      ),
    ).toBe(2);
    expect(restored.final().finalSeq).toBe(3);
  });

  it("keeps logical digesting independent from the bounded wire representation", () => {
    const payload = {
      kind: "agent-yield" as const,
      yield: { type: "text_delta" as const, text: "x".repeat(40 * 1024) },
    };
    const chain = new StreamDigestChain("assignment-fixed");

    expect(chain.append(payload, {})).toBe(1);
    expect(() =>
      validateStreamFrame(
        frame({
          streamEpoch: 1,
          seq: 1,
          payload,
          meta: {},
        }),
      ),
    ).toThrow(/externalized/);
  });
});

describe("stream wire validators", () => {
  it("accepts exact frames, subscriptions and cumulative acknowledgments", () => {
    expect(
      validateStreamFrame(
        frame({
          streamEpoch: 1,
          seq: 1,
          payload: {
            kind: "agent-yield",
            yield: { type: "text_delta", text: "hello" },
          },
          meta: {},
        }),
      ),
    ).toMatchObject({ seq: 1 });
    expect(() =>
      validateStreamFrame(
        frame({
          streamEpoch: 1,
          seq: 1,
          payload: {
            kind: "agent-yield",
            yield: {
              ref: {
                digest:
                  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                bytes: 40_000,
              },
            },
          },
          meta: {},
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateStreamFrame(
        frame({
          streamEpoch: 1,
          seq: 1,
          payload: {
            kind: "agent-yield",
            yield: {
              ref: {
                digest:
                  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                bytes: 40_000,
              },
              unexpected: true,
            },
          } as never,
          meta: {},
        }),
      ),
    ).toThrow(/unknown or missing/);
    expect(
      validateStreamSubscribe({
        v: 1,
        ref,
        assignmentId: "assignment-fixed",
        consumer: { kind: "surface-ticket", ticketId: "ticket-fixed" },
        afterSeq: 0,
      }),
    ).toMatchObject({ afterSeq: 0 });
    expect(
      validateStreamAck({
        v: 1,
        assignmentId: "assignment-fixed",
        consumer: {
          kind: "owner-relay",
          authority: {
            execution: "job",
            taskId: "task-fixed",
            anchorEpoch: 1,
          },
          controlLeaseId: "lease-fixed",
        },
        ackSeq: 1,
      }),
    ).toMatchObject({ ackSeq: 1 });
  });

  it("rejects unknown fields and inconsistent interaction expiry", () => {
    expect(() =>
      validateStreamFrame({
        ...frame({
          streamEpoch: 1,
          seq: 1,
          payload: {
            kind: "interaction",
            event: {
              t: "requested",
              requestId: "request-fixed",
              toolName: "bash",
              display: { title: "Approve", lines: [] },
              issuedAt: "2026-07-23T00:00:00.000Z",
              ttlMs: 1_000,
              expiresAt: "2026-07-23T00:00:02.000Z",
            },
          },
          meta: {},
        }),
        unexpected: true,
      }),
    ).toThrow(/unknown or missing/);

    expect(() =>
      validateStreamFrame(
        frame({
          streamEpoch: 1,
          seq: 1,
          payload: {
            kind: "interaction",
            event: {
              t: "requested",
              requestId: "request-fixed",
              toolName: "bash",
              display: { title: "Approve", lines: [] },
              issuedAt: "2026-07-23T00:00:00.000Z",
              ttlMs: 1_000,
              expiresAt: "2026-07-23T00:00:02.000Z",
            },
          },
          meta: {},
        }),
      ),
    ).toThrow(/expiry/);
  });

  it("validates the complete payload of projected passthrough events", () => {
    expect(() =>
      validateStreamFrame(
        frame({
          streamEpoch: 1,
          seq: 1,
          payload: {
            kind: "agent-event",
            event: {
              event: "agent:run_end",
              payload: {
                reason: "completed",
                duration: 12,
                usage: { inputTokens: 3, outputTokens: 4 },
              },
            },
          },
          meta: {},
        }),
      ),
    ).not.toThrow();

    expect(() =>
      validateStreamFrame(
        frame({
          streamEpoch: 1,
          seq: 1,
          payload: {
            kind: "agent-event",
            event: {
              event: "security:rule_sedimented",
              payload: {
                tool: "bash",
                operation: "run",
                pattern: { tool: "bash", argument: "*" },
                scope: "context",
                contextId: { kind: "main" },
                ruleId: "rule-fixed",
                contributors: [
                  { origin: "user", timestamp: 1, unexpected: true },
                ],
              },
            },
          },
          meta: {},
        }),
      ),
    ).toThrow(/unknown or missing/);
  });

  it("keeps owner relay ACK identity stable across lease rotation", () => {
    const authority = {
      execution: "job" as const,
      taskId: "task-fixed",
      anchorEpoch: 2,
    };
    expect(
      streamConsumerKey({
        kind: "owner-relay",
        authority,
        controlLeaseId: "lease-one",
      }),
    ).toBe(
      streamConsumerKey({
        kind: "owner-relay",
        authority,
        controlLeaseId: "lease-two",
      }),
    );
  });
});

describe("StreamFrameVerifier", () => {
  it("accepts contiguous data, fences old paths and reconciles final", () => {
    const verifier = new StreamFrameVerifier({
      assignmentId: "assignment-fixed",
      ref,
    });
    const data = frame({
      streamEpoch: 1,
      seq: 1,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "hello" },
      },
      meta: {},
    });
    expect(verifier.accept(data)).toBe("accepted");
    expect(verifier.accept({ ...data, streamEpoch: 2 })).toBe("duplicate");
    expect(() => verifier.accept({ ...data, streamEpoch: 1 })).toThrow(
      /fenced/,
    );

    const checkpoint = verifier.checkpoint();
    const finalSeq = checkpoint.dataFrames + 1;
    expect(
      verifier.accept(
        frame({
          streamEpoch: 2,
          seq: finalSeq,
          payload: {
            kind: "provisional-final",
            finalSeq,
            streamDigest: checkpoint.head,
          },
          meta: {},
        }),
      ),
    ).toBe("accepted");
    expect(verifier.checkpoint().finalSeq).toBe(2);
  });

  it("rejects gaps, field tampering and frames after final", () => {
    const verifier = new StreamFrameVerifier({
      assignmentId: "assignment-fixed",
      ref,
    });
    expect(() =>
      verifier.accept(
        frame({
          streamEpoch: 1,
          seq: 2,
          payload: {
            kind: "agent-yield",
            yield: { type: "text_delta", text: "gap" },
          },
          meta: {},
        }),
      ),
    ).toThrow(/contiguous/);

    const empty = verifier.checkpoint();
    verifier.accept(
      frame({
        streamEpoch: 1,
        seq: 1,
        payload: {
          kind: "provisional-final",
          finalSeq: 1,
          streamDigest: empty.head,
        },
        meta: {},
      }),
    );
    expect(() =>
      verifier.accept(
        frame({
          streamEpoch: 1,
          seq: 2,
          payload: {
            kind: "agent-yield",
            yield: { type: "text_delta", text: "late" },
          },
          meta: {},
        }),
      ),
    ).toThrow(/follows/);
  });

  it("detects payload and metadata tampering at final reconciliation", () => {
    const source = new StreamFrameVerifier({
      assignmentId: "assignment-fixed",
      ref,
    });
    const original = frame({
      streamEpoch: 1,
      seq: 1,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "original" },
      },
      meta: { lineage: "main" },
    });
    source.accept(original);
    const sourceCheckpoint = source.checkpoint();
    const sourceFinal = frame({
      streamEpoch: 1,
      seq: 2,
      payload: {
        kind: "provisional-final",
        finalSeq: 2,
        streamDigest: sourceCheckpoint.head,
      },
      meta: {},
    });

    for (const tampered of [
      {
        ...original,
        payload: {
          kind: "agent-yield" as const,
          yield: { type: "text_delta" as const, text: "tampered" },
        },
      },
      { ...original, meta: { lineage: "another" } },
    ]) {
      const receiver = new StreamFrameVerifier({
        assignmentId: "assignment-fixed",
        ref,
      });
      receiver.accept(tampered);
      expect(() => receiver.accept(sourceFinal)).toThrow(/does not match/);
    }
  });

  it("requires the provisional and sealed final values to agree", () => {
    const chain = new StreamDigestChain("assignment-fixed");
    const final = chain.final();
    const finalFrame = frame({
      streamEpoch: 1,
      seq: 1,
      payload: { kind: "provisional-final", ...final },
      meta: {},
    });
    expect(() =>
      assertStreamFinalReconciliation(finalFrame, final),
    ).not.toThrow();
    expect(() =>
      assertStreamFinalReconciliation(finalFrame, {
        ...final,
        finalSeq: 2,
      }),
    ).toThrow(/do not reconcile/);
  });
});
