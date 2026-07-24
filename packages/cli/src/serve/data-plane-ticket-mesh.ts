import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import type {
  DataPlaneTicket,
  ExecutionAbortRequest,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  validateDataPlaneTicket,
  validateExecutionAbortRequest,
  validateFirstPartyInteractionDecision,
  type FirstPartyInteractionDecision,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type {
  DataPlaneTicketRegistry,
} from "@zhixing/executor";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type {
  MeshServiceRegistry,
  SecureMeshConnection,
} from "@zhixing/mesh";

export const DATA_PLANE_TICKET_SERVICE = "assignment.data-plane-ticket";

type DataPlaneTicketServiceRequest =
  | { readonly v: 1; readonly t: "accept"; readonly ticket: DataPlaneTicket }
  | {
      readonly v: 1;
      readonly t: "revoke";
      readonly assignmentId: string;
      readonly ticketId: string;
    }
  | {
      readonly v: 1;
      readonly t: "answer";
      readonly assignmentId: string;
      readonly requestId: string;
      readonly ticketId: string;
      readonly decision: FirstPartyInteractionDecision;
    }
  | {
      readonly v: 1;
      readonly t: "abort";
      readonly request: ExecutionAbortRequest;
    };

export interface DataPlaneTicketServiceOptions {
  readonly tickets: Pick<DataPlaneTicketRegistry, "accept" | "revoke">;
  readonly verifier: ProtocolSignatureVerifier;
  readonly operations: {
    answerInteractionWithTicket(input: {
      readonly assignmentId: string;
      readonly requestId: string;
      readonly ticketId: string;
      readonly surfacePrincipal: string;
      readonly decision: FirstPartyInteractionDecision;
    }): Promise<void>;
    abortWithTicket(request: ExecutionAbortRequest): Promise<void>;
  };
  readonly authorizeOwner: (
    connection: SecureMeshConnection,
    assignmentId: string,
  ) => boolean;
  readonly surfacePrincipalFor: (connection: SecureMeshConnection) => string;
  readonly authorizePeer?: (deviceId: string) => boolean;
}

export interface DataPlaneTicketFacts {
  readonly issued: readonly DataPlaneTicket[];
  readonly revokedTicketIds: readonly string[];
}

export function registerDataPlaneTicketService(
  registry: MeshServiceRegistry,
  options: DataPlaneTicketServiceOptions,
): () => void {
  return registry.register(DATA_PLANE_TICKET_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    ...(options.authorizePeer
      ? {
          authorize: (connection: SecureMeshConnection) =>
            options.authorizePeer!(connection.peer.deviceId),
        }
      : {}),
    handler: createDataPlaneTicketServiceHandler(options),
  });
}

export function createDataPlaneTicketServiceHandler(
  options: DataPlaneTicketServiceOptions,
): (
  payload: Uint8Array,
  connection: SecureMeshConnection,
  signal: AbortSignal,
) => Promise<Uint8Array> {
  return async (payload, connection, signal) => {
    signal.throwIfAborted();
    const request = decodeRequest(payload, options.verifier);
    if (request.t === "accept") {
      if (!options.authorizeOwner(connection, request.ticket.assignmentId)) {
        throw new Error("Ticket delivery requires the assignment owner");
      }
      await options.tickets.accept(request.ticket);
    } else if (request.t === "revoke") {
      if (!options.authorizeOwner(connection, request.assignmentId)) {
        throw new Error("Ticket revocation requires the assignment owner");
      }
      await options.tickets.revoke({
        assignmentId: request.assignmentId,
        ticketId: request.ticketId,
      });
    } else if (request.t === "answer") {
      await options.operations.answerInteractionWithTicket({
        assignmentId: request.assignmentId,
        requestId: request.requestId,
        ticketId: request.ticketId,
        surfacePrincipal: options.surfacePrincipalFor(connection),
        decision: request.decision,
      });
    } else {
      if (
        request.request.ticket.surfacePrincipal !==
        options.surfacePrincipalFor(connection)
      ) {
        throw new Error("Abort ticket belongs to a different surface");
      }
      await options.operations.abortWithTicket(request.request);
    }
    signal.throwIfAborted();
    return encode({ v: 1, t: "ok" });
  };
}

export class DataPlaneTicketMeshClient {
  constructor(private readonly client: MeshServiceClient) {}

  async accept(ticket: DataPlaneTicket, signal?: AbortSignal): Promise<void> {
    await this.#send({ v: 1, t: "accept", ticket }, signal);
  }

  async revoke(
    assignmentId: string,
    ticketId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#send(
      { v: 1, t: "revoke", assignmentId, ticketId },
      signal,
    );
  }

  async synchronize(
    facts: DataPlaneTicketFacts,
    signal?: AbortSignal,
  ): Promise<void> {
    const issuedById = new Map(facts.issued.map((ticket) => [ticket.ticketId, ticket]));
    const revoked = new Set(facts.revokedTicketIds);
    for (const ticket of facts.issued) {
      if (!revoked.has(ticket.ticketId)) await this.accept(ticket, signal);
    }
    for (const ticketId of facts.revokedTicketIds) {
      const ticket = issuedById.get(ticketId);
      if (!ticket) {
        throw new Error("Ticket revocation has no matching issued fact");
      }
      await this.revoke(ticket.assignmentId, ticketId, signal);
    }
  }

  async answer(
    input: {
      readonly assignmentId: string;
      readonly requestId: string;
      readonly ticketId: string;
      readonly decision: FirstPartyInteractionDecision;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#send({ v: 1, t: "answer", ...input }, signal);
  }

  async abort(
    request: ExecutionAbortRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#send({ v: 1, t: "abort", request }, signal);
  }

  async #send(
    request: DataPlaneTicketServiceRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = decodeJson(
      await this.client.request(
        DATA_PLANE_TICKET_SERVICE,
        encode(request),
        signal,
      ),
    );
    if (
      !isPlainObject(response) ||
      response.v !== 1 ||
      response.t !== "ok" ||
      Object.keys(response).length !== 2
    ) {
      throw new TypeError("Data-plane ticket service response is invalid");
    }
  }
}

function decodeRequest(
  payload: Uint8Array,
  verifier: ProtocolSignatureVerifier,
): DataPlaneTicketServiceRequest {
  const value = decodeJson(payload);
  if (!isPlainObject(value) || value.v !== 1 || typeof value.t !== "string") {
    throw new TypeError("Data-plane ticket service request is invalid");
  }
  if (value.t === "accept") {
    assertKeys(value, ["t", "ticket", "v"]);
    return {
      v: 1,
      t: "accept",
      ticket: validateDataPlaneTicket(value.ticket, verifier),
    };
  }
  if (value.t === "revoke") {
    assertKeys(value, ["assignmentId", "t", "ticketId", "v"]);
    assertIdentifier(value.assignmentId, "Ticket assignment id");
    assertIdentifier(value.ticketId, "Ticket id");
    return value as unknown as DataPlaneTicketServiceRequest;
  }
  if (value.t === "answer") {
    assertKeys(value, [
      "assignmentId",
      "decision",
      "requestId",
      "t",
      "ticketId",
      "v",
    ]);
    assertIdentifier(value.assignmentId, "Interaction assignment id");
    assertIdentifier(value.requestId, "Interaction request id");
    assertIdentifier(value.ticketId, "Interaction ticket id");
    return {
      v: 1,
      t: "answer",
      assignmentId: value.assignmentId as string,
      requestId: value.requestId as string,
      ticketId: value.ticketId as string,
      decision: validateFirstPartyInteractionDecision(value.decision),
    };
  }
  if (value.t === "abort") {
    assertKeys(value, ["request", "t", "v"]);
    return {
      v: 1,
      t: "abort",
      request: validateExecutionAbortRequest(value.request, verifier),
    };
  }
  throw new TypeError("Data-plane ticket service request type is invalid");
}

function encode(input: unknown): Uint8Array {
  return Buffer.from(canonicalize(input), "utf8");
}

function decodeJson(payload: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  const parsed = JSON.parse(text) as unknown;
  if (canonicalize(parsed) !== text) {
    throw new TypeError("Data-plane ticket payload is not canonical JSON");
  }
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    canonicalize(Object.keys(value).sort()) !==
    canonicalize([...keys].sort())
  ) {
    throw new TypeError("Data-plane ticket service fields are incomplete or unknown");
  }
}

function assertIdentifier(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 480) {
    throw new TypeError(`${label} is invalid`);
  }
}
