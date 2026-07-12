export type MeshErrorCode =
  | "invalid-frame"
  | "incompatible-version"
  | "identity-mismatch"
  | "unauthorized-peer"
  | "invalid-signature"
  | "clock-skew"
  | "replay-detected"
  | "connection-closed"
  | "service-unavailable";

export class MeshProtocolError extends Error {
  constructor(
    readonly code: MeshErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeshProtocolError";
  }
}
