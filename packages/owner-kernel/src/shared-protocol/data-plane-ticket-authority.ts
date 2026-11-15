import type { DataPlaneTicket } from "@zhixing-ai/core/contracts";
import {
  assertDataPlaneTicketTtlMs,
  assertProtocolIdentifier,
  createSignedDataPlaneTicket,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import {
  dataPlaneTicketIssueMatches,
  nextDataPlaneTicketSyncFrontier,
  ticketPrecedesSyncFrontier,
  type ReadonlyDataPlaneTicket,
} from "../data-plane-ticket-lifecycle.js";
import type {
  DataPlaneTicketFacts,
  DataPlaneTicketIssueRequest,
} from "./contracts.js";

export function validateDataPlaneTicketIssueRequest(
  input: DataPlaneTicketIssueRequest,
): void {
  assertProtocolIdentifier(input.ticketId, "Data-plane ticket id");
  assertProtocolIdentifier(
    input.assignmentId,
    "Data-plane ticket assignment id",
  );
  assertProtocolIdentifier(
    input.surfacePrincipal,
    "Data-plane ticket surface principal",
  );
  assertDataPlaneTicketTtlMs(input.ttlMs);
  if (input.replacesTicketId !== undefined) {
    assertProtocolIdentifier(
      input.replacesTicketId,
      "Replaced data-plane ticket id",
    );
    if (input.replacesTicketId === input.ticketId) {
      throw new TypeError("Ticket renewal requires a new ticket id");
    }
  }
}

export function decideDataPlaneTicketReplayOrConflict(input: {
  readonly existing: ReadonlyDataPlaneTicket | undefined;
  readonly existingReplacementId: string | undefined;
  readonly request: DataPlaneTicketIssueRequest;
}): DataPlaneTicket | undefined {
  if (!input.existing) return undefined;
  if (
    !dataPlaneTicketIssueMatches(
      input.existing,
      input.existingReplacementId,
      input.request,
    )
  ) {
    throw new Error("Ticket id already belongs to a different grant");
  }
  return structuredClone(input.existing) as DataPlaneTicket;
}

export function validateDataPlaneTicketSurfaceAndRenewal(input: {
  readonly request: DataPlaneTicketIssueRequest;
  readonly expectedSurfacePrincipal: string;
  readonly replacedTicket: ReadonlyDataPlaneTicket | undefined;
  readonly isReplacedTicketRevoked: boolean;
}): void {
  const { request } = input;
  if (
    request.kind !== "run-observe" &&
    request.surfacePrincipal !== input.expectedSurfacePrincipal
  ) {
    throw new Error("Interactive tickets are restricted to the original surface");
  }
  if (request.kind === "abort" && request.replacesTicketId !== undefined) {
    throw new Error("Abort tickets are not renewable");
  }
  if (
    request.replacesTicketId !== undefined &&
    (!input.replacedTicket ||
      input.isReplacedTicketRevoked ||
      !input.replacedTicket.renewable ||
      input.replacedTicket.assignmentId !== request.assignmentId ||
      input.replacedTicket.surfacePrincipal !== request.surfacePrincipal ||
      input.replacedTicket.kind !== request.kind)
  ) {
    throw new Error("Ticket renewal does not continue an active renewable grant");
  }
}

export function createSignedDomainDataPlaneTicket(input: {
  readonly request: DataPlaneTicketIssueRequest;
  readonly ref:
    | {
        readonly execution: "conversation";
        readonly runId: string;
        readonly conversationId: string;
        readonly ownerEpoch: number;
      }
    | {
        readonly execution: "job";
        readonly jobRunId: string;
        readonly taskId: string;
        readonly anchorEpoch: number;
      };
  readonly executorId: string;
  readonly issuedAt: string;
  readonly signer: ProtocolSigner;
}): DataPlaneTicket {
  return createSignedDataPlaneTicket(
    {
      v: 1,
      ticketId: input.request.ticketId,
      ref: input.ref,
      assignmentId: input.request.assignmentId,
      surfacePrincipal: input.request.surfacePrincipal,
      executorId: input.executorId,
      issuedAt: input.issuedAt,
      expiry: new Date(
        Date.parse(input.issuedAt) + input.request.ttlMs,
      ).toISOString(),
      kind: input.request.kind,
      renewable: input.request.kind !== "abort",
    } as Parameters<typeof createSignedDataPlaneTicket>[0],
    input.signer,
  );
}

export function decideDataPlaneTicketRevocationState(input: {
  readonly hasTicket: boolean;
  readonly isRevoked: boolean;
}): boolean {
  if (!input.hasTicket) {
    throw new Error("Cannot revoke an unknown data-plane ticket");
  }
  return !input.isRevoked;
}

export function computeDataPlaneTicketSyncFacts(input: {
  readonly candidateForAdvance: Iterable<ReadonlyDataPlaneTicket>;
  readonly candidateForRetained: Iterable<ReadonlyDataPlaneTicket>;
  readonly currentFrontier: string | undefined;
  readonly at: string;
  readonly isTicketRevoked: (ticketId: string) => boolean;
}): {
  readonly nextFrontier: string | undefined;
  readonly facts: DataPlaneTicketFacts;
} {
  const nextFrontier = nextDataPlaneTicketSyncFrontier(
    input.candidateForAdvance,
    input.currentFrontier,
    input.at,
  );
  const frontier = nextFrontier ?? input.currentFrontier;
  const issued = [...input.candidateForRetained]
    .filter((ticket) => !ticketPrecedesSyncFrontier(ticket, frontier))
    .sort((left, right) => left.ticketId.localeCompare(right.ticketId))
    .map((ticket) => structuredClone(ticket) as DataPlaneTicket);
  const retainedIds = new Set(issued.map((ticket) => ticket.ticketId));
  const revokedTicketIds = [...retainedIds]
    .filter((ticketId) => input.isTicketRevoked(ticketId))
    .sort();
  return {
    nextFrontier,
    facts: {
      issued,
      revokedTicketIds,
    },
  };
}
