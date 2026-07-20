import type { Signature } from "../contracts/index.js";

export interface ProtocolSigner {
  sign(schemaId: string, version: number, payload: unknown): Signature;
}

export interface ProtocolSignatureVerifier {
  verify(
    schemaId: string,
    version: number,
    payload: unknown,
    signature: Signature,
  ): void;
}
