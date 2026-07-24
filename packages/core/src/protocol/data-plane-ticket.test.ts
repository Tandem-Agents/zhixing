import { describe, expect, it } from "vitest";
import type { DataPlaneTicket } from "../contracts/index.js";
import { protocolDigest } from "./canonical.js";
import {
  assertDataPlaneTicketActiveAt,
  assertDataPlaneTicketBinding,
  assertDataPlaneTicketUse,
  createSignedDataPlaneTicket,
  dataPlaneTicketDigest,
  validateDataPlaneTicket,
  validateExecutionAbortRequest,
  validateFirstPartyInteractionDecision,
} from "./data-plane-ticket.js";
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

const ref = {
  execution: "conversation" as const,
  runId: "run-1",
  conversationId: "conversation-1",
  ownerEpoch: 7,
};

function ticket(
  kind: DataPlaneTicket["kind"] = "run-interact",
): DataPlaneTicket {
  return createSignedDataPlaneTicket(
    {
      v: 1,
      ticketId: `ticket:${kind}`,
      ref,
      assignmentId: "assignment-1",
      surfacePrincipal: "surface:user-1",
      executorId: "executor-1",
      issuedAt: "2026-07-23T00:00:00.000Z",
      expiry: "2026-07-23T00:05:00.000Z",
      kind,
      renewable: kind === "abort" ? false : true,
    } as Parameters<typeof createSignedDataPlaneTicket>[0],
    identity,
  );
}

describe("data-plane ticket protocol", () => {
  it.each([
    ["run-observe", true],
    ["run-interact", true],
    ["abort", false],
  ] as const)("signs and validates %s tickets", (kind, renewable) => {
    const value = ticket(kind);
    expect(validateDataPlaneTicket(value, identity)).toEqual(value);
    expect(value.renewable).toBe(renewable);
    const { signature: _, ...payload } = value;
    expect(dataPlaneTicketDigest(value)).toBe(
      protocolDigest("DataPlaneTicket", 1, payload),
    );
  });

  it("rejects unknown fields, invalid discriminants, and tampered signatures", () => {
    expect(() =>
      validateDataPlaneTicket({ ...ticket(), extra: true }, identity),
    ).toThrow(/fields/);
    expect(() =>
      validateDataPlaneTicket(
        { ...ticket("abort"), renewable: true },
        identity,
      ),
    ).toThrow(/renewability/);
    expect(() =>
      validateDataPlaneTicket(
        {
          ...ticket(),
          signature: { alg: "test", keyId: "device:owner", sig: "tampered" },
        },
        identity,
      ),
    ).toThrow();
  });

  it("enforces permission hierarchy, binding, and half-open expiry", () => {
    const interact = ticket("run-interact");
    expect(() => assertDataPlaneTicketUse(interact, "observe")).not.toThrow();
    expect(() => assertDataPlaneTicketUse(interact, "interact")).not.toThrow();
    expect(() => assertDataPlaneTicketUse(interact, "abort")).toThrow();
    expect(() =>
      assertDataPlaneTicketUse(ticket("run-observe"), "interact"),
    ).toThrow();
    expect(() =>
      assertDataPlaneTicketBinding(interact, {
        assignmentId: "assignment-1",
        ref,
        executorId: "executor-1",
        surfacePrincipal: "surface:user-1",
      }),
    ).not.toThrow();
    expect(() =>
      assertDataPlaneTicketBinding(interact, {
        assignmentId: "assignment-1",
        ref,
        executorId: "executor-1",
        surfacePrincipal: "surface:observer",
      }),
    ).toThrow();
    expect(() =>
      assertDataPlaneTicketActiveAt(interact, "2026-07-23T00:04:59.999Z"),
    ).not.toThrow();
    expect(() =>
      assertDataPlaneTicketActiveAt(interact, "2026-07-23T00:05:00.000Z"),
    ).toThrow(/not active/);
  });

  it("validates a full abort request and rejects cross-assignment reuse", () => {
    const abort = ticket("abort");
    expect(
      validateExecutionAbortRequest(
        {
          v: 1,
          assignmentId: "assignment-1",
          ref,
          ticket: abort,
          reason: "owner unavailable",
          at: "2026-07-23T00:01:00.000Z",
        },
        identity,
      ),
    ).toMatchObject({ assignmentId: "assignment-1", ticket: abort });
    expect(() =>
      validateExecutionAbortRequest(
        {
          v: 1,
          assignmentId: "assignment-other",
          ref,
          ticket: abort,
          reason: "owner unavailable",
          at: "2026-07-23T00:01:00.000Z",
        },
        identity,
      ),
    ).toThrow(/bind/);
  });

  it("keeps first-party interaction authority allow-once only", () => {
    expect(
      validateFirstPartyInteractionDecision({
        kind: "allow-once",
        note: "approved",
      }),
    ).toEqual({ kind: "allow-once", note: "approved" });
    expect(
      validateFirstPartyInteractionDecision({
        kind: "deny",
        reason: "not now",
      }),
    ).toEqual({ kind: "deny", reason: "not now" });
    expect(() =>
      validateFirstPartyInteractionDecision({
        kind: "allow-session",
        pattern: { tool: "Bash" },
      }),
    ).toThrow(/allow-once or deny/);
    expect(() =>
      validateFirstPartyInteractionDecision({
        kind: "allow-once",
        note: "x".repeat(8 * 1024 + 1),
      }),
    ).toThrow(/budget/);
  });
});
