import { describe, expect, it } from "vitest";
import {
  MAX_ASSIGNMENT_ARTIFACT_GRANT_BYTES,
  MAX_ASSIGNMENT_ARTIFACT_GRANT_TTL_MS,
  type AssignmentArtifactTransferGrant,
  type Signature,
} from "../contracts/index.js";
import { protocolDigest } from "./canonical.js";
import {
  createSignedAssignmentArtifactTransferGrant,
  validateAssignmentArtifactTransferGrant,
} from "./assignment.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./signature.js";

const issuedAt = "2026-07-23T00:00:00.000Z";
const expiry = new Date(Date.parse(issuedAt) + MAX_ASSIGNMENT_ARTIFACT_GRANT_TTL_MS)
  .toISOString();
const activationDigest = `sha256:${"a".repeat(64)}` as const;
const refs = [
  { digest: `sha256:${"2".repeat(64)}` as const, bytes: 20 },
  { digest: `sha256:${"1".repeat(64)}` as const, bytes: 10 },
];

function signer(keyId: string): ProtocolSigner {
  return {
    sign(schemaId, version, payload) {
      return {
        alg: "test",
        keyId,
        sig: protocolDigest("TestSignature", 1, { schemaId, version, payload, keyId }),
      };
    },
  };
}

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(signer(signature.keyId).sign(schemaId, version, payload));
  },
};

function createGrant(
  overrides: Partial<Parameters<typeof createSignedAssignmentArtifactTransferGrant>[0]> = {},
): AssignmentArtifactTransferGrant {
  return createSignedAssignmentArtifactTransferGrant({
    assignmentId: "assignment-1",
    executorId: "executor-1",
    capId: "cap-1",
    sourceDeviceId: "owner-1",
    targetDeviceId: "executor-device-1",
    direction: "owner-to-executor",
    activationDigest,
    refs,
    issuedAt,
    expiry,
    signer: signer("owner-1"),
    ...overrides,
  });
}

describe("assignment artifact transfer grants", () => {
  it("binds source, target, direction and the exact aggregate artifact set", () => {
    const grant = createGrant();

    expect(validateAssignmentArtifactTransferGrant(grant, verifier)).toEqual(grant);
    expect(grant.refs).toEqual([refs[1], refs[0]]);
    expect(grant.totalBytes).toBe(30);
    expect(grant.signature.keyId).toBe(grant.sourceDeviceId);
  });

  it("rejects a signer that does not own the transfer source", () => {
    expect(() => createGrant({ signer: signer("executor-device-1") })).toThrow(
      "signer is not its source device",
    );
  });

  it("enforces unique refs, aggregate bytes and a bounded lifetime", () => {
    expect(() => createGrant({ refs: [refs[0]!, refs[0]!] })).toThrow(
      "duplicate digests",
    );
    expect(() => createGrant({
      refs: [{ digest: refs[0]!.digest, bytes: MAX_ASSIGNMENT_ARTIFACT_GRANT_BYTES + 1 }],
    })).toThrow("byte budget");
    expect(() => createGrant({
      expiry: new Date(
        Date.parse(issuedAt) + MAX_ASSIGNMENT_ARTIFACT_GRANT_TTL_MS + 1,
      ).toISOString(),
    })).toThrow("TTL exceeds");
  });

  it("rejects a validly signed grant whose signer differs from its declared source", () => {
    const grant = createGrant();
    const { signature: _, ...payload } = grant;
    const changed = {
      ...payload,
      sourceDeviceId: "owner-other",
    };
    const mismatched = {
      ...changed,
      signature: signer("owner-1").sign(
        "AssignmentArtifactTransferGrant",
        1,
        changed,
      ) as Signature,
    };

    expect(() => validateAssignmentArtifactTransferGrant(mismatched, verifier)).toThrow(
      "signer is not its source device",
    );
  });
});
