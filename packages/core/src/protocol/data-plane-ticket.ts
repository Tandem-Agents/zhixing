import type {
  DataPlaneTicket,
  ExecutionAbortRequest,
  ExecutionRef,
  Signature,
} from "../contracts/index.js";
import {
  validateConfirmationDecisionText,
  type ConfirmationDecision,
} from "../confirmation/types.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";
import { assertProtocolIdentifier } from "./validation.js";

export const DATA_PLANE_TICKET_KINDS = [
  "run-observe",
  "run-interact",
  "abort",
] as const satisfies readonly DataPlaneTicket["kind"][];

export const MAX_EXECUTION_ABORT_REASON_BYTES = 8 * 1024;
export const MAX_DATA_PLANE_TICKET_TTL_MS = 24 * 60 * 60 * 1_000;

export type DataPlaneTicketKind = DataPlaneTicket["kind"];
export type DataPlaneTicketUse = "observe" | "interact" | "abort";
export type FirstPartyInteractionDecision = Extract<
  ConfirmationDecision,
  { kind: "allow-once" | "deny" }
>;
export type UnsignedDataPlaneTicket = DataPlaneTicket extends infer Ticket
  ? Ticket extends DataPlaneTicket
    ? Omit<Ticket, "signature">
    : never
  : never;

export interface DataPlaneTicketBinding {
  readonly assignmentId: string;
  readonly ref: ExecutionRef;
  readonly executorId: string;
  readonly surfacePrincipal: string;
}

export function assertDataPlaneTicketTtlMs(ttlMs: number): void {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_DATA_PLANE_TICKET_TTL_MS
  ) {
    throw new RangeError("Data-plane ticket TTL is outside its bounded range");
  }
}

export function createSignedDataPlaneTicket(
  input: UnsignedDataPlaneTicket,
  signer: ProtocolSigner,
): DataPlaneTicket {
  const payload = validateUnsignedTicket(input);
  return {
    ...payload,
    signature: signer.sign("DataPlaneTicket", 1, payload),
  } as DataPlaneTicket;
}

export function validateDataPlaneTicket(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): DataPlaneTicket {
  const ticket = clone(input, "Data-plane ticket") as DataPlaneTicket;
  assertPlainObject(ticket, "Data-plane ticket");
  assertExactKeys(
    ticket,
    [
      "assignmentId",
      "executorId",
      "expiry",
      "issuedAt",
      "kind",
      "ref",
      "renewable",
      "signature",
      "surfacePrincipal",
      "ticketId",
      "v",
    ],
    "Data-plane ticket",
  );
  assertSignature(ticket.signature, "Data-plane ticket signature");
  const { signature, ...unsigned } = ticket;
  const payload = validateUnsignedTicket(unsigned as UnsignedDataPlaneTicket);
  verifier.verify("DataPlaneTicket", 1, payload, signature);
  return ticket;
}

export function dataPlaneTicketDigest(ticket: DataPlaneTicket): string {
  const { signature: _, ...payload } = ticket;
  return protocolDigest("DataPlaneTicket", 1, payload);
}

export function assertDataPlaneTicketBinding(
  ticket: DataPlaneTicket,
  binding: DataPlaneTicketBinding,
): void {
  assertProtocolIdentifier(binding.assignmentId, "Ticket use assignmentId");
  assertProtocolIdentifier(binding.executorId, "Ticket use executorId");
  assertProtocolIdentifier(
    binding.surfacePrincipal,
    "Ticket use surface principal",
  );
  validateExecutionRef(binding.ref, "Ticket use execution reference");
  if (
    ticket.assignmentId !== binding.assignmentId ||
    ticket.executorId !== binding.executorId ||
    ticket.surfacePrincipal !== binding.surfacePrincipal ||
    canonicalize(ticket.ref) !== canonicalize(binding.ref)
  ) {
    throw new TypeError("Data-plane ticket does not bind the requested operation");
  }
}

export function assertDataPlaneTicketUse(
  ticket: DataPlaneTicket,
  use: DataPlaneTicketUse,
): void {
  const allowed =
    use === "observe"
      ? ticket.kind === "run-observe" || ticket.kind === "run-interact"
      : use === "interact"
        ? ticket.kind === "run-interact"
        : ticket.kind === "abort";
  if (!allowed) {
    throw new TypeError(`Data-plane ticket cannot authorize ${use}`);
  }
}

export function assertDataPlaneTicketActiveAt(
  ticket: DataPlaneTicket,
  at: string,
): void {
  const now = parseCanonicalTime(at, "Ticket use time");
  const issuedAt = parseCanonicalTime(ticket.issuedAt, "Data-plane ticket issuedAt");
  const expiry = parseCanonicalTime(ticket.expiry, "Data-plane ticket expiry");
  if (now < issuedAt || now >= expiry) {
    throw new TypeError("Data-plane ticket is not active at the requested time");
  }
}

export function validateExecutionAbortRequest(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ExecutionAbortRequest {
  const request = clone(input, "Execution abort request") as ExecutionAbortRequest;
  assertPlainObject(request, "Execution abort request");
  assertExactKeys(
    request,
    ["assignmentId", "at", "reason", "ref", "ticket", "v"],
    "Execution abort request",
  );
  if (request.v !== 1) {
    throw new TypeError("Execution abort request version must be 1");
  }
  assertProtocolIdentifier(
    request.assignmentId,
    "Execution abort request assignmentId",
  );
  validateExecutionRef(request.ref, "Execution abort request reference");
  parseCanonicalTime(request.at, "Execution abort request time");
  if (
    typeof request.reason !== "string" ||
    request.reason.trim().length === 0 ||
    Buffer.byteLength(request.reason, "utf8") >
      MAX_EXECUTION_ABORT_REASON_BYTES
  ) {
    throw new TypeError("Execution abort request reason is invalid or exceeds its bound");
  }
  const ticket = validateDataPlaneTicket(request.ticket, verifier);
  if (ticket.kind !== "abort") {
    throw new TypeError("Execution abort request requires an abort ticket");
  }
  assertDataPlaneTicketBinding(ticket, {
    assignmentId: request.assignmentId,
    ref: request.ref,
    executorId: ticket.executorId,
    surfacePrincipal: ticket.surfacePrincipal,
  });
  assertDataPlaneTicketUse(ticket, "abort");
  return { ...request, ticket };
}

export function validateFirstPartyInteractionDecision(
  input: unknown,
): FirstPartyInteractionDecision {
  const decision = clone(
    input,
    "First-party interaction decision",
  ) as Record<string, unknown>;
  assertPlainObject(decision, "First-party interaction decision");
  if (decision.kind === "allow-once") {
    assertExactKeys(
      decision,
      ["kind", ...(decision.note === undefined ? [] : ["note"])],
      "First-party allow-once decision",
    );
    if (decision.note !== undefined && typeof decision.note !== "string") {
      throw new TypeError("First-party interaction note must be a string");
    }
  } else if (decision.kind === "deny") {
    assertExactKeys(
      decision,
      ["kind", ...(decision.reason === undefined ? [] : ["reason"])],
      "First-party deny decision",
    );
    if (decision.reason !== undefined && typeof decision.reason !== "string") {
      throw new TypeError("First-party interaction reason must be a string");
    }
  } else {
    throw new TypeError(
      "First-party interaction accepts only allow-once or deny",
    );
  }
  return validateConfirmationDecisionText(
    decision as unknown as FirstPartyInteractionDecision,
  ) as FirstPartyInteractionDecision;
}

function validateUnsignedTicket(
  input: UnsignedDataPlaneTicket,
): UnsignedDataPlaneTicket {
  const ticket = clone(input, "Unsigned data-plane ticket") as UnsignedDataPlaneTicket;
  assertPlainObject(ticket, "Unsigned data-plane ticket");
  assertExactKeys(
    ticket,
    [
      "assignmentId",
      "executorId",
      "expiry",
      "issuedAt",
      "kind",
      "ref",
      "renewable",
      "surfacePrincipal",
      "ticketId",
      "v",
    ],
    "Unsigned data-plane ticket",
  );
  if (ticket.v !== 1) throw new TypeError("Data-plane ticket version must be 1");
  if (!DATA_PLANE_TICKET_KINDS.includes(ticket.kind)) {
    throw new TypeError("Data-plane ticket kind is invalid");
  }
  if (
    (ticket.kind === "abort" && ticket.renewable !== false) ||
    (ticket.kind !== "abort" && ticket.renewable !== true)
  ) {
    throw new TypeError("Data-plane ticket renewability does not match its kind");
  }
  assertProtocolIdentifier(ticket.ticketId, "Data-plane ticket id");
  assertProtocolIdentifier(ticket.assignmentId, "Data-plane ticket assignmentId");
  assertProtocolIdentifier(ticket.executorId, "Data-plane ticket executorId");
  assertProtocolIdentifier(
    ticket.surfacePrincipal,
    "Data-plane ticket surface principal",
  );
  validateExecutionRef(ticket.ref, "Data-plane ticket execution reference");
  const issuedAt = parseCanonicalTime(ticket.issuedAt, "Data-plane ticket issuedAt");
  const expiry = parseCanonicalTime(ticket.expiry, "Data-plane ticket expiry");
  if (expiry <= issuedAt) {
    throw new TypeError("Data-plane ticket expiry must follow issuedAt");
  }
  if (expiry - issuedAt > MAX_DATA_PLANE_TICKET_TTL_MS) {
    throw new TypeError("Data-plane ticket lifetime exceeds its bound");
  }
  return ticket;
}

function validateExecutionRef(value: unknown, label: string): asserts value is ExecutionRef {
  assertPlainObject(value, label);
  if (value.execution === "conversation") {
    assertExactKeys(
      value,
      ["conversationId", "execution", "ownerEpoch", "runId"],
      label,
    );
    assertProtocolIdentifier(value.runId, `${label} runId`);
    assertProtocolIdentifier(value.conversationId, `${label} conversationId`);
    assertPositiveInteger(value.ownerEpoch, `${label} ownerEpoch`);
    return;
  }
  if (value.execution === "job") {
    assertExactKeys(
      value,
      ["anchorEpoch", "execution", "jobRunId", "taskId"],
      label,
    );
    assertProtocolIdentifier(value.jobRunId, `${label} jobRunId`);
    assertProtocolIdentifier(value.taskId, `${label} taskId`);
    assertPositiveInteger(value.anchorEpoch, `${label} anchorEpoch`);
    return;
  }
  throw new TypeError(`${label} kind is invalid`);
}

function assertSignature(
  value: unknown,
  label: string,
): asserts value is Signature {
  assertPlainObject(value, label);
  assertExactKeys(value, ["alg", "keyId", "sig"], label);
  assertProtocolIdentifier(value.alg, `${label} algorithm`);
  assertProtocolIdentifier(value.keyId, `${label} keyId`);
  assertProtocolIdentifier(value.sig, `${label} bytes`);
}

function parseCanonicalTime(value: unknown, label: string): number {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  if (
    canonicalize(Object.keys(value).sort()) !==
    canonicalize([...expected].sort())
  ) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function clone(value: unknown, label: string): unknown {
  try {
    return JSON.parse(canonicalize(value));
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, {
      cause: error,
    });
  }
}
