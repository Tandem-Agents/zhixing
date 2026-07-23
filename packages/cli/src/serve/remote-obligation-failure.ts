import { MeshProtocolError } from "@zhixing/mesh/errors";

const RETRYABLE_MESH_FAILURES = new Set([
  "connection-closed",
  "service-unavailable",
  "service-failed",
  "resource-exhausted",
  "request-aborted",
  "request-timeout",
]);

/** True only when transport semantics cannot prove a durable obligation was rejected. */
export function isRetryableMeshFailure(error: unknown): boolean {
  return error instanceof MeshProtocolError &&
    RETRYABLE_MESH_FAILURES.has(error.code);
}

/** Unknown remote outcomes retain the obligation; only explicit local/protocol errors terminate it. */
export function shouldRetryRemoteObligation(error: unknown): boolean {
  if (error instanceof TypeError) return false;
  if (error instanceof MeshProtocolError) return isRetryableMeshFailure(error);
  return true;
}
