import { describe, expect, it } from "vitest";
import { canonicalize, protocolDigest } from "../canonical.js";
import {
  DeviceKey,
  deviceIdFromPublicKey,
  enrollDeviceIdentity,
  verifyDeviceSignature,
} from "../device-identity.js";
import { MeshProtocolError } from "../errors.js";

const NOW = Date.parse("2026-07-12T00:00:00.000Z");

describe("mesh protocol cryptography", () => {
  it("canonicalizes protocol payloads and keeps a fixed digest vector", () => {
    const payload = { z: [3, { b: true, a: "知行" }], a: -0 };

    expect(canonicalize(payload)).toBe(
      '{"a":0,"z":[3,{"a":"知行","b":true}]}',
    );
    expect(protocolDigest("MeshVector", 1, payload)).toBe(
      "sha256:160673ea20aa515eaa8cb654d900b1ebb07d91a793f8a35f6806d1dccfb21116",
    );
    expect(() => canonicalize({ value: undefined })).toThrow(TypeError);
    expect(() => canonicalize(new Date(0))).toThrow(TypeError);
  });

  it("rejects every value that cannot have one interoperable I-JSON representation", () => {
    const sparse = new Array(2);
    const withExtraArrayField = ["value"] as string[] & { extra?: string };
    withExtraArrayField.extra = "hidden from JSON arrays";
    const accessorBacked = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "mutable",
    });
    const symbolBacked = { value: "visible", [Symbol("hidden")]: "ambiguous" };

    expect(() => canonicalize({ value: "\ud800" })).toThrow(TypeError);
    expect(() => canonicalize({ "\udc00": "value" })).toThrow(TypeError);
    expect(() => canonicalize(sparse)).toThrow(TypeError);
    expect(() => canonicalize(withExtraArrayField)).toThrow(TypeError);
    expect(() => canonicalize(accessorBacked)).toThrow(TypeError);
    expect(() => canonicalize(symbolBacked)).toThrow(TypeError);
  });

  it("keeps device key material separate from enrollment metadata", async () => {
    const key = await DeviceKey.generate({ now: () => NOW });
    const restored = DeviceKey.import(key.exportMaterial());
    const identity = enrollDeviceIdentity(restored, {
      displayName: "fixed-vector",
      platform: "headless",
      enrolledAt: new Date(NOW).toISOString(),
    });
    const payload = { connectionId: "conn-fixed", nonce: "nonce-fixed" };
    const signature = restored.sign("MeshProtocolHello", 1, payload);

    expect(restored.deviceId).toBe(key.deviceId);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(DeviceKey.prototype)).toBe(true);
    expect(() =>
      Object.defineProperty(restored, "rootCertificatePem", { value: "tampered" }),
    ).toThrow(TypeError);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(identity.deviceId).toBe(deviceIdFromPublicKey(identity.publicKey));
    expect(() =>
      verifyDeviceSignature(identity, "MeshProtocolHello", 1, payload, signature),
    ).not.toThrow();
    expect(() =>
      verifyDeviceSignature(identity, "MeshProtocolAccepted", 1, payload, signature),
    ).toThrowError(MeshProtocolError);
    expect(() =>
      verifyDeviceSignature(identity, "MeshProtocolHello", 1, payload, {
        ...signature,
        sig: `${signature.sig}=`,
      }),
    ).toThrowError(MeshProtocolError);
    expect(() =>
      enrollDeviceIdentity(restored, {
        displayName: "invalid",
        platform: "headless",
        enrolledAt: "not-a-time",
      }),
    ).toThrow(TypeError);
  });

  it("issues renewable short-lived TLS leaves from a stable device trust root", async () => {
    const key = await DeviceKey.generate({ now: () => NOW });
    const first = await key.issueTlsCredential({ now: () => NOW });
    const second = await key.issueTlsCredential({ now: () => NOW + 1 });

    expect(first.deviceId).toBe(key.deviceId);
    expect(first.certificateChainPem).not.toBe(second.certificateChainPem);
    expect(first.privateKeyPem).not.toBe(second.privateKeyPem);
    expect(first.certificateChainPem).toContain(key.rootCertificatePem.trim());
    expect(Date.parse(first.expiresAt) - NOW).toBe(24 * 60 * 60_000);
    expect(key.rootExpiresAt).toBe("9999-12-31T23:59:59.000Z");
  });

  it("never reports or issues a TLS leaf beyond its device trust root", async () => {
    const rootValidityMs = 5 * 60_000;
    const key = await DeviceKey.generate({
      now: () => NOW,
      rootValidityMs,
    });

    expect(key.rootExpiresAt).toBe(new Date(NOW + rootValidityMs).toISOString());
    await expect(
      key.issueTlsCredential({
        now: () => NOW,
        validityMs: 24 * 60 * 60_000,
      }),
    ).rejects.toThrow("TLS leaf certificate cannot outlive its device trust root");
    await expect(
      key.issueTlsCredential({
        now: () => NOW + rootValidityMs + 1,
        validityMs: 3 * 60_000,
      }),
    ).rejects.toThrow("Device root certificate is not valid at TLS issuance time");
  });
});
