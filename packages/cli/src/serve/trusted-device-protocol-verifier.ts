import type { DeviceIdentity } from "@zhixing/core/contracts";
import type { ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import { verifyDeviceSignature } from "@zhixing/mesh/device-identity";

/** Builds the production verifier from one frozen trusted-device exact set. */
export function createTrustedDeviceProtocolVerifier(
  identities: readonly DeviceIdentity[],
): ProtocolSignatureVerifier {
  const trusted = new Map(
    identities.map((identity) => [identity.deviceId, identity] as const),
  );
  if (trusted.size !== identities.length) {
    throw new TypeError("Trusted device identities must be unique");
  }
  const verifier: ProtocolSignatureVerifier = {
    verify(schemaId, version, payload, signature) {
      const signer = trusted.get(signature.keyId);
      if (!signer) {
        throw new TypeError("Protocol signature belongs to an untrusted device");
      }
      verifyDeviceSignature(signer, schemaId, version, payload, signature);
    },
  };
  return Object.freeze(verifier);
}
