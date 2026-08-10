import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { canonicalize } from "../canonical.js";
import { describe, expect, it } from "vitest";
import {
  createAnchorTransferReadyProof,
  validateAnchorTransferReadyProof,
} from "../anchor-transfer-ready.js";
import { DeviceKey, enrollDeviceIdentity } from "../device-identity.js";
import {
  applyTrustEvent,
  createSignedTrustEvent,
  createTrustGenesisEvent,
  initializeTrustChain,
} from "../trust-chain.js";

const NOW = Date.parse("2026-08-09T00:00:00.000Z");
const TRANSFER_ID = "xfer-01J00000000000000000000001";
const REQUEST_ID = "request-ready-1";
const CANDIDATE_DIGEST = `sha256:${"a".repeat(64)}`;

describe("anchor migration ready proof", () => {
  it("binds current trust, exact target capabilities and a transfer-local issuer key", async () => {
    const fixture = await readyFixture();
    const first = await createAnchorTransferReadyProof({
      requestId: REQUEST_ID,
      transferId: TRANSFER_ID,
      candidateDigest: CANDIDATE_DIGEST,
      targetIdentityKey: fixture.targetKey,
      trust: fixture.trust,
      secretStore: fixture.secrets,
      snapshot: snapshot(),
      now: NOW,
    });
    const replay = await createAnchorTransferReadyProof({
      requestId: REQUEST_ID,
      transferId: TRANSFER_ID,
      candidateDigest: CANDIDATE_DIGEST,
      targetIdentityKey: fixture.targetKey,
      trust: fixture.trust,
      secretStore: fixture.secrets,
      snapshot: snapshot(),
      now: NOW,
      issuerKey: first.issuerKey,
    });
    expect(replay.issuerKey.deviceId).toBe(first.issuerKey.deviceId);
    await expect(createAnchorTransferReadyProof({
      requestId: REQUEST_ID,
      transferId: TRANSFER_ID,
      candidateDigest: CANDIDATE_DIGEST,
      targetIdentityKey: fixture.targetKey,
      trust: fixture.trust,
      secretStore: fixture.secrets,
      snapshot: snapshot(),
      now: NOW,
      issuerKey: await DeviceKey.generate(),
    })).rejects.toThrow(/persisted transfer key/i);
    expect(validateAnchorTransferReadyProof({
      proof: first.proof,
      trust: fixture.trust,
      targetDeviceId: fixture.targetKey.deviceId,
      expected: snapshot(),
      expectedIdentity: {
        requestId: REQUEST_ID,
        candidateDigest: CANDIDATE_DIGEST,
      },
      now: NOW + 1,
    })).toEqual(first.proof);
    expect(() => validateAnchorTransferReadyProof({
      proof: first.proof,
      trust: fixture.trust,
      targetDeviceId: fixture.targetKey.deviceId,
      expected: snapshot(),
      expectedIdentity: {
        requestId: "request-ready-other",
        candidateDigest: CANDIDATE_DIGEST,
      },
      now: NOW + 1,
    })).toThrow(/bind|generation/i);
    expect(() => validateAnchorTransferReadyProof({
      proof: first.proof,
      trust: fixture.trust,
      targetDeviceId: fixture.targetKey.deviceId,
      expected: { ...snapshot(), credentialRevision: "credentials-v2" },
      expectedIdentity: {
        requestId: REQUEST_ID,
        candidateDigest: CANDIDATE_DIGEST,
      },
      now: NOW + 1,
    })).toThrow(/bind|generation|configuration|snapshot|readiness/i);
    const wire = canonicalize(first.proof);
    expect(wire).not.toContain("pkcs8");
    expect(wire).not.toContain("rootCertificatePem");
  });

  it("rejects expiry, trust-generation drift and a non-anchor target before use", async () => {
    const fixture = await readyFixture();
    const { proof } = await createAnchorTransferReadyProof({
      requestId: REQUEST_ID,
      transferId: TRANSFER_ID,
      candidateDigest: CANDIDATE_DIGEST,
      targetIdentityKey: fixture.targetKey,
      trust: fixture.trust,
      secretStore: fixture.secrets,
      snapshot: snapshot(),
      now: NOW,
      ttlMs: 100,
    });
    expect(() => validateAnchorTransferReadyProof({
      proof,
      trust: fixture.trust,
      targetDeviceId: fixture.targetKey.deviceId,
      now: NOW + 100,
    })).toThrow("not currently active");
    expect(() => validateAnchorTransferReadyProof({
      proof,
      trust: { ...fixture.trust, trustEpoch: fixture.trust.trustEpoch + 1 },
      targetDeviceId: fixture.targetKey.deviceId,
      now: NOW + 1,
    })).toThrow("current trusted target generation");
    const notAnchor = {
      ...fixture.trust,
      members: fixture.trust.members.map((member) =>
        member.device.deviceId === fixture.targetKey.deviceId
          ? { ...member, roles: ["executor" as const] }
          : member),
    };
    expect(() => validateAnchorTransferReadyProof({
      proof,
      trust: notAnchor,
      targetDeviceId: fixture.targetKey.deviceId,
      now: NOW + 1,
    })).toThrow("duty-capable");
  });
});

function snapshot() {
  return {
    configuredCapabilities: {
      providers: ["provider-main"],
      mcpServers: ["mcp-work"],
      channels: ["channel-primary"],
    },
    protocolRevision: "protocol-v1",
    assetRevision: "assets-v1",
    serviceRevision: "services-v1",
    credentialRevision: "credentials-v1",
  };
}

async function readyFixture() {
  const sourceKey = await DeviceKey.generate();
  const targetKey = await DeviceKey.generate();
  const source = enrollDeviceIdentity(sourceKey, {
    displayName: "source",
    platform: "linux",
    enrolledAt: new Date(NOW).toISOString(),
  });
  const target = enrollDeviceIdentity(targetKey, {
    displayName: "target",
    platform: "linux",
    enrolledAt: new Date(NOW).toISOString(),
  });
  let trust = initializeTrustChain(createTrustGenesisEvent({
    homeId: "home-1",
    issuer: source,
    signer: sourceKey,
    at: new Date(NOW).toISOString(),
  }));
  trust = applyTrustEvent(trust, createSignedTrustEvent({
    current: trust,
    signer: sourceKey,
    at: new Date(NOW).toISOString(),
    body: { t: "enroll", device: target, roles: ["anchor"] },
  }));
  return { sourceKey, targetKey, trust, secrets: new MemoryStore() };
}

class MemoryStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string) { this.values.set(key(ref), value); }
  async get(ref: SecretRef) { return this.values.get(key(ref)) ?? null; }
  async delete(ref: SecretRef) { this.values.delete(key(ref)); }
  async list() { return []; }
  async unlockState() { return "unlocked" as const; }
}

function key(ref: SecretRef) { return `${ref.kind}/${ref.bindingId}`; }
