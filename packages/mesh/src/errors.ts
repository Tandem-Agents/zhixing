export type MeshErrorCode =
  | "invalid-frame"
  | "incompatible-version"
  | "identity-mismatch"
  | "unauthorized-peer"
  | "invalid-signature"
  | "clock-skew"
  | "replay-detected"
  | "connection-closed"
  | "service-unavailable"
  | "service-failed"
  | "resource-exhausted"
  | "request-aborted"
  | "request-timeout";

const PUBLIC_ERROR_MESSAGES: Record<MeshErrorCode, string> = {
  "invalid-frame": "Mesh request frame is invalid",
  "incompatible-version": "Mesh service is unavailable for this protocol version",
  "identity-mismatch": "Mesh peer identity does not match",
  "unauthorized-peer": "Mesh peer is not authorized",
  "invalid-signature": "Mesh signature is invalid",
  "clock-skew": "Mesh clock is outside the accepted window",
  "replay-detected": "Mesh replay was detected",
  "connection-closed": "Mesh request channel is closed",
  "service-unavailable": "Mesh service is unavailable",
  "service-failed": "Mesh service failed",
  "resource-exhausted": "Mesh endpoint resource limit was exceeded",
  "request-aborted": "Mesh request was aborted",
  "request-timeout": "Mesh request exceeded its deadline",
};

export function publicMeshErrorMessage(code: MeshErrorCode): string {
  return PUBLIC_ERROR_MESSAGES[code];
}

export class MeshProtocolError extends Error {
  constructor(
    readonly code: MeshErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeshProtocolError";
  }
}
