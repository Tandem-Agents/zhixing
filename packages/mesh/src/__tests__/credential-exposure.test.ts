import { describe, expect, it } from "vitest";
import {
  createCredentialExposureRecord,
  projectDeviceCredentialRevocation,
} from "../credential-exposure.js";

describe("credential exposure revocation projection", () => {
  it("derives principal fingerprints only from service-verified identities", () => {
    const verified = createCredentialExposureRecord({
      deviceId: "device",
      bindingId: "main",
      service: "provider",
      verifiedPrincipal: {
        verification: "service-verified",
        canonicalProviderPrincipal: "account-123",
      },
      markedAt: "2026-07-13T00:00:00.000Z",
    });
    const unverified = createCredentialExposureRecord({
      deviceId: "device",
      bindingId: "secondary",
      service: "provider",
      markedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(verified.principalFingerprint).toMatch(/^sha256:/u);
    expect(unverified.principalFingerprint).toBeUndefined();
    expect(() =>
      createCredentialExposureRecord({
        deviceId: "device",
        bindingId: "forged",
        service: "provider",
        verifiedPrincipal: {
          verification: "unverified" as "service-verified",
          canonicalProviderPrincipal: "account-123",
        },
        markedAt: "2026-07-13T00:00:00.000Z",
      }),
    ).toThrow("service-verified");
  });

  it("marks only the revoked device bindings and returns a user-actionable account list", () => {
    const result = projectDeviceCredentialRevocation({
      deviceId: "lost",
      markedAt: "2026-07-13T00:00:00.000Z",
      records: [
        {
          deviceId: "lost",
          bindingId: "provider-main",
          service: "OpenAI",
          tenant: "personal",
          scopes: ["models:read"],
          state: "active",
          markedAt: "2026-07-01T00:00:00.000Z",
          rotationHint: "openai-api-keys",
        },
        {
          deviceId: "safe",
          bindingId: "provider-main",
          service: "OpenAI",
          state: "active",
          markedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    expect(result.records.map((record) => record.state)).toEqual(["compromised", "active"]);
    expect(result.affectedAccounts).toEqual([
      {
        bindingId: "provider-main",
        service: "OpenAI",
        tenant: "personal",
        scopes: ["models:read"],
        rotationHint: "openai-api-keys",
      },
    ]);
  });

  it("rejects malformed durable records before deriving revocation actions", () => {
    expect(() =>
      projectDeviceCredentialRevocation({
        deviceId: "lost",
        markedAt: "2026-07-13T00:00:00.000Z",
        records: [
          {
            deviceId: "lost",
            bindingId: "provider-main",
            service: "OpenAI",
            principalFingerprint: "self-reported",
            state: "active",
            markedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow("fingerprint is invalid");
  });

  it("keeps distinct services and tenants for the same local binding id", () => {
    const result = projectDeviceCredentialRevocation({
      deviceId: "lost",
      markedAt: "2026-07-13T00:00:00.000Z",
      records: [
        {
          deviceId: "lost",
          bindingId: "main",
          service: "Provider",
          tenant: "personal",
          state: "active",
          markedAt: "2026-07-01T00:00:00.000Z",
        },
        {
          deviceId: "lost",
          bindingId: "main",
          service: "Channel",
          tenant: "work",
          state: "active",
          markedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    expect(result.affectedAccounts).toHaveLength(2);
  });

  it("rejects a revocation timestamp that predates the active exposure", () => {
    expect(() =>
      projectDeviceCredentialRevocation({
        deviceId: "lost",
        markedAt: "2026-07-01T00:00:00.000Z",
        records: [
          {
            deviceId: "lost",
            bindingId: "main",
            service: "Provider",
            state: "active",
            markedAt: "2026-07-02T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow("cannot precede");
  });

  it("rejects silently lossy optional fields and freezes nested exposure identity", () => {
    expect(() =>
      createCredentialExposureRecord({
        deviceId: "device",
        bindingId: "main",
        service: "Provider",
        tenant: "",
        markedAt: "2026-07-13T00:00:00.000Z",
      }),
    ).toThrow("tenant is invalid");
    expect(() =>
      projectDeviceCredentialRevocation({
        deviceId: "",
        markedAt: "2026-07-13T00:00:00.000Z",
        records: [],
      }),
    ).toThrow("device identity is invalid");

    const record = createCredentialExposureRecord({
      deviceId: "device",
      bindingId: "main",
      service: "Provider",
      scopes: ["write", "read"],
      markedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(record.scopes).toEqual(["read", "write"]);
    expect(() => record.scopes?.push("admin")).toThrow();
  });
});
