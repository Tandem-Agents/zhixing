import { createPublicKey, verify } from "node:crypto";
import type { Signature } from "@zhixing/core/contracts";
import { protocolBytes, type ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import type { EmbeddedReleaseTrust } from "./release-channel.js";

export function createReleaseVerifier(trust: EmbeddedReleaseTrust): ProtocolSignatureVerifier {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(trust.keyId)) {
    throw new TypeError("Embedded release key id is invalid");
  }
  const der = Buffer.from(trust.publicKeySpki, "base64url");
  if (der.byteLength === 0 || der.toString("base64url") !== trust.publicKeySpki) {
    throw new TypeError("Embedded release public key is invalid");
  }
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("Release public key must be Ed25519");
  return {
    verify(schemaId: string, version: number, payload: unknown, signature: Signature): void {
      if (signature.alg !== "ed25519" || signature.keyId !== trust.keyId) {
        throw new TypeError("Release signature identity is invalid");
      }
      const encoded = Buffer.from(signature.sig, "base64url");
      if (encoded.byteLength !== 64 || encoded.toString("base64url") !== signature.sig) {
        throw new TypeError("Release signature bytes are invalid");
      }
      if (!verify(null, protocolBytes(schemaId, version, payload), key, encoded)) {
        throw new TypeError("Release signature verification failed");
      }
    },
  };
}
