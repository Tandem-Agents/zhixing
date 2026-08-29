import { protocolDigest } from "./canonical.js";

/** Durable ledger request identity for one assignment-scoped mutation operation. */
export function assignmentMutationRequestId(input: {
  readonly assignmentId: string;
  readonly domain: "session" | "global";
  readonly operationId: string;
}): string {
  return `mutation:${protocolDigest("AssignmentMutationRequest", 1, input)}`;
}
