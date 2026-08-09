import { describe, expect, it } from "vitest";
import { DeviceKey, enrollDeviceIdentity } from "../device-identity.js";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  createTrustGenesisEvent,
  initializeTrustChain,
  verifyHomeTrustRecord,
  type TrustProjection,
} from "../trust-chain.js";

const AT = "2026-08-09T00:00:00.000Z";

describe("planned anchor issuer transition", () => {
  it("separates the target device identity from its transfer-bound issuer key", async () => {
    const fixture = await trustFixture();
    const issuer = await DeviceKey.generate();
    const transition = createSignedTrustEvent({
      current: fixture.trust,
      signer: fixture.sourceKey,
      at: AT,
      body: {
        t: "issuer-transition",
        reason: "migration",
        signedBy: "issuer",
        nextTrustEpoch: fixture.trust.trustEpoch + 1,
        fromIssuerKeyId: fixture.trust.issuer.issuerKeyId,
        toDeviceId: fixture.target.deviceId,
        toIssuerKeyId: issuer.deviceId,
        toIssuerPublicKey: issuer.publicKey,
      },
    });
    const migrated = applyTrustEvent(fixture.trust, transition);
    const record = buildHomeTrustRecord(migrated, issuer);

    expect(migrated.issuer).toEqual({
      deviceId: fixture.target.deviceId,
      issuerKeyId: issuer.deviceId,
      issuerPublicKey: issuer.publicKey,
    });
    expect(() => verifyHomeTrustRecord(record, migrated)).not.toThrow();
    const followup = createSignedTrustEvent({
      current: migrated,
      signer: issuer,
      at: AT,
      body: { t: "role-change", deviceId: fixture.target.deviceId, roles: ["anchor"] },
    });
    expect(() => applyTrustEvent(migrated, followup)).not.toThrow();
  });

  it("rejects a migrated issuer key id that does not match the carried public key", async () => {
    const fixture = await trustFixture();
    const issuer = await DeviceKey.generate();
    const other = await DeviceKey.generate();
    const transition = createSignedTrustEvent({
      current: fixture.trust,
      signer: fixture.sourceKey,
      at: AT,
      body: {
        t: "issuer-transition",
        reason: "migration",
        signedBy: "issuer",
        nextTrustEpoch: fixture.trust.trustEpoch + 1,
        fromIssuerKeyId: fixture.trust.issuer.issuerKeyId,
        toDeviceId: fixture.target.deviceId,
        toIssuerKeyId: issuer.deviceId,
        toIssuerPublicKey: other.publicKey,
      },
    });
    expect(() => applyTrustEvent(fixture.trust, transition)).toThrow(
      "target is invalid",
    );
  });

  it("keeps legacy transitions whose issuer key is the target device key valid", async () => {
    const fixture = await trustFixture();
    const transition = createSignedTrustEvent({
      current: fixture.trust,
      signer: fixture.sourceKey,
      at: AT,
      body: {
        t: "issuer-transition",
        reason: "migration",
        signedBy: "issuer",
        nextTrustEpoch: fixture.trust.trustEpoch + 1,
        fromIssuerKeyId: fixture.trust.issuer.issuerKeyId,
        toDeviceId: fixture.target.deviceId,
        toIssuerKeyId: fixture.target.deviceId,
      },
    });
    const migrated = applyTrustEvent(fixture.trust, transition);
    expect(migrated.issuer).toEqual({
      deviceId: fixture.target.deviceId,
      issuerKeyId: fixture.target.deviceId,
    });
  });
});

async function trustFixture(): Promise<{
  sourceKey: DeviceKey;
  targetKey: DeviceKey;
  target: ReturnType<typeof enrollDeviceIdentity>;
  trust: TrustProjection;
}> {
  const sourceKey = await DeviceKey.generate();
  const targetKey = await DeviceKey.generate();
  const source = enrollDeviceIdentity(sourceKey, {
    displayName: "source",
    platform: "linux",
    enrolledAt: AT,
  });
  const target = enrollDeviceIdentity(targetKey, {
    displayName: "target",
    platform: "linux",
    enrolledAt: AT,
  });
  const genesis = createTrustGenesisEvent({
    homeId: "home-1",
    issuer: source,
    signer: sourceKey,
    at: AT,
  });
  let trust = initializeTrustChain(genesis);
  trust = applyTrustEvent(trust, createSignedTrustEvent({
    current: trust,
    signer: sourceKey,
    at: AT,
    body: { t: "enroll", device: target, roles: ["anchor"] },
  }));
  return { sourceKey, targetKey, target, trust };
}
