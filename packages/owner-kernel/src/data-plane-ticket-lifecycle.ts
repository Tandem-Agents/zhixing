import type { DataPlaneTicket } from "@zhixing/core/contracts";
import { MAX_CLOCK_SKEW_MS } from "@zhixing/core/protocol";

export interface DataPlaneTicketIssueIdentity {
  readonly ticketId: string;
  readonly assignmentId: string;
  readonly surfacePrincipal: string;
  readonly kind: DataPlaneTicket["kind"];
  readonly ttlMs: number;
  readonly replacesTicketId?: string;
}

export function dataPlaneTicketIssueMatches(
  ticket: DataPlaneTicket,
  replacesTicketId: string | undefined,
  request: DataPlaneTicketIssueIdentity,
): boolean {
  return (
    ticket.ticketId === request.ticketId &&
    ticket.assignmentId === request.assignmentId &&
    ticket.surfacePrincipal === request.surfacePrincipal &&
    ticket.kind === request.kind &&
    Date.parse(ticket.expiry) - Date.parse(ticket.issuedAt) === request.ttlMs &&
    replacesTicketId === request.replacesTicketId
  );
}

export function dataPlaneTicketSyncBoundary(
  ticket: DataPlaneTicket,
): string {
  return new Date(
    Date.parse(ticket.expiry) + MAX_CLOCK_SKEW_MS,
  ).toISOString();
}

export function nextDataPlaneTicketSyncFrontier(
  tickets: Iterable<DataPlaneTicket>,
  current: string | undefined,
  observedAt: string,
): string | undefined {
  const observed = canonicalTime(observedAt, "Ticket sync observation time");
  const currentTime =
    current === undefined
      ? Number.NEGATIVE_INFINITY
      : canonicalTime(current, "Ticket sync frontier");
  let nextTime = currentTime;
  for (const ticket of tickets) {
    const boundary = Date.parse(dataPlaneTicketSyncBoundary(ticket));
    if (boundary <= observed && boundary > nextTime) nextTime = boundary;
  }
  return nextTime === currentTime
    ? undefined
    : new Date(nextTime).toISOString();
}

export function ticketPrecedesSyncFrontier(
  ticket: DataPlaneTicket,
  frontier: string | undefined,
): boolean {
  return (
    frontier !== undefined &&
    Date.parse(dataPlaneTicketSyncBoundary(ticket)) <=
      canonicalTime(frontier, "Ticket sync frontier")
  );
}

function canonicalTime(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}
