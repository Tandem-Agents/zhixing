import type {
  CancelProofBody,
  DataPlaneTicket,
} from "@zhixing/core/contracts";
import { dataPlaneTicketDigest } from "@zhixing/core/protocol";

export function hasOwnerIssuedAbortTicketProof(input: {
  readonly assignmentId: string;
  readonly ticketIds: ReadonlySet<string>;
  readonly ticketsById: ReadonlyMap<string, DataPlaneTicket>;
  readonly proof: Extract<CancelProofBody, { cause: "abort-ticket" }>;
}): boolean {
  return [...input.ticketIds].some((ticketId) => {
    const ticket = input.ticketsById.get(ticketId);
    return (
      ticket?.kind === "abort" &&
      ticket.assignmentId === input.assignmentId &&
      ticket.executorId === input.proof.executorId &&
      ticket.surfacePrincipal === input.proof.surfacePrincipal &&
      dataPlaneTicketDigest(ticket) === input.proof.ticketDigest
    );
  });
}

export function abortTicketProofBindsOwnerHistory(input: {
  readonly assignmentId: string;
  readonly ticketIds: ReadonlySet<string>;
  readonly ticketsById: ReadonlyMap<string, DataPlaneTicket>;
  readonly proof: Extract<CancelProofBody, { cause: "abort-ticket" }>;
  readonly legacy?: {
    authorize(authority: {
      readonly assignmentId: string;
      readonly executorId: string;
      readonly ticketDigest: string;
      readonly surfacePrincipal: string;
    }): void;
  };
}): boolean {
  if (hasOwnerIssuedAbortTicketProof(input)) return true;
  if (input.ticketIds.size > 0 || !input.legacy) return false;
  input.legacy.authorize({
    assignmentId: input.assignmentId,
    executorId: input.proof.executorId,
    ticketDigest: input.proof.ticketDigest,
    surfacePrincipal: input.proof.surfacePrincipal,
  });
  return true;
}
