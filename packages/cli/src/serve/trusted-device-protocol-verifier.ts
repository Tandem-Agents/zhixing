import type { DeviceIdentity } from "@zhixing-ai/core/contracts";
import type { ProtocolSignatureVerifier } from "@zhixing-ai/core/protocol";
import { verifyDeviceSignature } from "@zhixing-ai/mesh/device-identity";

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

/**
 * Builds the verifier used by a long-lived runtime whose durable trust chain can
 * add verification identities without rebuilding every protocol consumer.
 * Authorization remains a separate, per-effect decision; this lookup only
 * retains the public identities needed to verify historical and current facts.
 */
export function createLiveTrustedDeviceProtocolVerifier(
  identityFor: (deviceId: string) => DeviceIdentity | undefined,
): ProtocolSignatureVerifier {
  const verifier: ProtocolSignatureVerifier = {
    verify(schemaId, version, payload, signature) {
      const signer = identityFor(signature.keyId);
      if (!signer) {
        throw new TypeError("Protocol signature belongs to an untrusted device");
      }
      verifyDeviceSignature(signer, schemaId, version, payload, signature);
    },
  };
  return Object.freeze(verifier);
}
