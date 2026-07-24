import type { DataPlaneTicket, ExecutionAbortRequest } from "@zhixing/core/contracts";
import {
  canonicalize,
  createSignedDataPlaneTicket,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { SecureMeshConnection } from "@zhixing/mesh";
import { describe, expect, it, vi } from "vitest";
import {
  DATA_PLANE_TICKET_SERVICE,
  DataPlaneTicketMeshClient,
  createDataPlaneTicketServiceHandler,
} from "./data-plane-ticket-mesh.js";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test",
      keyId: "owner-fixed",
      sig: protocolDigest("TestSignature", 1, { schemaId, version, payload }),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

const ref = {
  execution: "conversation" as const,
  runId: "run-fixed",
  conversationId: "conversation-fixed",
  ownerEpoch: 3,
};

describe("data-plane ticket mesh adapter", () => {
  it("separates owner delivery from surface use and preserves principal binding", async () => {
    const accepted: DataPlaneTicket[] = [];
    const revoked: string[] = [];
    const answerInteractionWithTicket = vi.fn(async () => undefined);
    const abortWithTicket = vi.fn(async () => undefined);
    const handler = createDataPlaneTicketServiceHandler({
      verifier: identity,
      tickets: {
        async accept(ticket) {
          accepted.push(ticket as DataPlaneTicket);
          return ticket as DataPlaneTicket;
        },
        async revoke(input) {
          revoked.push(input.ticketId);
          return true;
        },
      },
      operations: { answerInteractionWithTicket, abortWithTicket },
      authorizeOwner: (connection) => connection.peer.deviceId === "owner-fixed",
      surfacePrincipalFor: (connection) => `surface:${connection.peer.deviceId}`,
    });
    const owner = new DataPlaneTicketMeshClient(
      directClient(handler, connection("owner-fixed")),
    );
    const surface = new DataPlaneTicketMeshClient(
      directClient(handler, connection("user-fixed")),
    );
    const interact = ticket("run-interact", "surface:user-fixed");

    await owner.accept(interact);
    await surface.answer({
      assignmentId: interact.assignmentId,
      requestId: "request-fixed",
      ticketId: interact.ticketId,
      decision: { kind: "allow-once" },
    });
    await owner.revoke(interact.assignmentId, interact.ticketId);
    expect(accepted).toEqual([interact]);
    expect(revoked).toEqual([interact.ticketId]);
    expect(answerInteractionWithTicket).toHaveBeenCalledWith({
      assignmentId: interact.assignmentId,
      requestId: "request-fixed",
      ticketId: interact.ticketId,
      surfacePrincipal: "surface:user-fixed",
      decision: { kind: "allow-once" },
    });

    const abortTicket = ticket("abort", "surface:user-fixed");
    const abortRequest: ExecutionAbortRequest = {
      v: 1,
      assignmentId: abortTicket.assignmentId,
      ref,
      ticket: abortTicket,
      reason: "owner unavailable",
      at: "2026-07-23T00:01:00.000Z",
    };
    await surface.abort(abortRequest);
    expect(abortWithTicket).toHaveBeenCalledWith(abortRequest);

    await expect(
      new DataPlaneTicketMeshClient(
        directClient(handler, connection("intruder")),
      ).abort(abortRequest),
    ).rejects.toThrow(/different surface/);
    await expect(
      new DataPlaneTicketMeshClient(
        directClient(handler, connection("intruder")),
      ).accept(interact),
    ).rejects.toThrow(/owner/);
  });

  it("replays only active grants and carries revocation tombstones", async () => {
    const calls: string[] = [];
    const client = new DataPlaneTicketMeshClient({
      async request(serviceId, payload) {
        expect(serviceId).toBe(DATA_PLANE_TICKET_SERVICE);
        const request = JSON.parse(Buffer.from(payload).toString("utf8")) as {
          t: string;
          ticket?: DataPlaneTicket;
          ticketId?: string;
        };
        calls.push(
          request.t === "accept"
            ? `accept:${request.ticket!.ticketId}`
            : `revoke:${request.ticketId}`,
        );
        return Buffer.from(canonicalize({ v: 1, t: "ok" }), "utf8");
      },
    });
    const active = ticket("run-observe", "surface:observer");
    const revoked = ticket("run-interact", "surface:user-fixed");

    await client.synchronize({
      issued: [active, revoked],
      revokedTicketIds: [revoked.ticketId],
    });
    expect(calls).toEqual([
      `accept:${active.ticketId}`,
      `revoke:${revoked.ticketId}`,
    ]);
  });
});

function ticket(
  kind: DataPlaneTicket["kind"],
  surfacePrincipal: string,
): DataPlaneTicket {
  return createSignedDataPlaneTicket(
    {
      v: 1,
      ticketId: `ticket:${kind}`,
      ref,
      assignmentId: "assignment-fixed",
      surfacePrincipal,
      executorId: "executor-fixed",
      issuedAt: "2026-07-23T00:00:00.000Z",
      expiry: "2026-07-23T00:05:00.000Z",
      kind,
      renewable: kind !== "abort",
    } as Parameters<typeof createSignedDataPlaneTicket>[0],
    identity,
  );
}

function directClient(
  handler: ReturnType<typeof createDataPlaneTicketServiceHandler>,
  meshConnection: SecureMeshConnection,
): MeshServiceClient {
  return {
    request(serviceId, payload, signal) {
      expect(serviceId).toBe(DATA_PLANE_TICKET_SERVICE);
      return handler(
        payload,
        meshConnection,
        signal ?? new AbortController().signal,
      );
    },
  };
}

function connection(deviceId: string): SecureMeshConnection {
  return {
    peer: { deviceId, publicKey: "test-public-key" },
  } as unknown as SecureMeshConnection;
}
