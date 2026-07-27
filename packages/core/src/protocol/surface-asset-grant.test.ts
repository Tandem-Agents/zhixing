import { describe, expect, it } from "vitest";
import {
  MAX_SURFACE_ASSET_BYTES,
  MAX_SURFACE_ASSET_GRANT_TTL_MS,
  type Digest,
  type Signature,
  type SurfaceAssetGrant,
} from "../contracts/index.js";
import { protocolDigest } from "./canonical.js";
import {
  assertSurfaceAssetGrantIssueBinding,
  assertSurfaceAssetGrantUse,
  createSignedSurfaceAssetGrant,
  surfaceAssetGrantDigest,
  validateSurfaceAssetGrant,
  validateSurfaceAssetGrantIssueBinding,
  type SurfaceAssetGrantIssueBinding,
  type SurfaceAssetGrantUse,
  type UnsignedSurfaceAssetGrant,
} from "./surface-asset-grant.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";

const issuedAt = "2026-07-24T00:00:00.000Z";
const expiry = new Date(
  Date.parse(issuedAt) + MAX_SURFACE_ASSET_GRANT_TTL_MS,
).toISOString();
const payloadDigest = `sha256:${"a".repeat(64)}` as Digest;
const assetA = { digest: `sha256:${"1".repeat(64)}` as Digest, bytes: 10 };
const assetB = { digest: `sha256:${"2".repeat(64)}` as Digest, bytes: 20 };

const signer: ProtocolSigner = {
  sign(schemaId, version, payload) {
    return {
      alg: "test",
      keyId: "owner-key",
      sig: protocolDigest("TestSignature", 1, {
        schemaId,
        version,
        payload,
      }),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

function unsigned(
  overrides: Partial<UnsignedSurfaceAssetGrant> = {},
): UnsignedSurfaceAssetGrant {
  return {
    v: 1,
    grantId: "grt-01J00000000000000000000000",
    scope: {
      domain: "conversation",
      conversationId: "conversation-1",
      ownerEpoch: 1,
    },
    surfacePrincipal: "surface-1",
    requestId: "request-1",
    kind: "asset-upload",
    payloadDigest,
    assets: [assetB, assetA],
    issuedAt,
    expiry,
    ...overrides,
  } as UnsignedSurfaceAssetGrant;
}

describe("surface asset grants", () => {
  it("signs a canonical exact asset set and validates every use binding", () => {
    const grant = createSignedSurfaceAssetGrant(unsigned(), signer);

    expect(grant.assets).toEqual([assetA, assetB]);
    expect(validateSurfaceAssetGrant(grant, verifier)).toEqual(grant);
    expect(surfaceAssetGrantDigest(grant)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() =>
      assertSurfaceAssetGrantUse(grant, {
        scope: grant.scope,
        surfacePrincipal: grant.surfacePrincipal,
        kind: "asset-upload",
        ref: assetA,
        at: issuedAt,
        payloadDigest,
      }),
    ).not.toThrow();
  });

  it("rejects the wrong principal, scope, direction, payload, ref and time", () => {
    const grant = createSignedSurfaceAssetGrant(unsigned(), signer);
    const use = {
      scope: grant.scope,
      surfacePrincipal: grant.surfacePrincipal,
      kind: "asset-upload" as const,
      ref: assetA,
      at: issuedAt,
      payloadDigest,
    };

    expect(() =>
      assertSurfaceAssetGrantUse(grant, {
        ...use,
        surfacePrincipal: "surface-other",
      }),
    ).toThrow("does not bind");
    expect(() =>
      assertSurfaceAssetGrantUse(grant, {
        ...use,
        scope: { ...grant.scope, ownerEpoch: 2 },
      }),
    ).toThrow("does not bind");
    expect(() =>
      assertSurfaceAssetGrantUse(grant, {
        ...use,
        kind: "asset-download",
      } as unknown as SurfaceAssetGrantUse),
    ).toThrow("does not bind");
    expect(() =>
      assertSurfaceAssetGrantUse(grant, {
        ...use,
        payloadDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow("control payload");
    expect(() =>
      assertSurfaceAssetGrantUse(grant, {
        ...use,
        ref: { digest: `sha256:${"3".repeat(64)}`, bytes: 1 },
      }),
    ).toThrow("does not contain");
    expect(() =>
      assertSurfaceAssetGrantUse(grant, {
        ...use,
        at: expiry,
      }),
    ).toThrow("not active");
  });

  it("rejects upload-only payload bindings on download requests and uses", () => {
    const { payloadDigest: _, ...upload } = unsigned();
    const grant = createSignedSurfaceAssetGrant(
      { ...upload, kind: "asset-download" } as UnsignedSurfaceAssetGrant,
      signer,
    );
    const issue = {
      kind: "asset-download",
      scope: grant.scope,
      requestId: grant.requestId,
      assets: grant.assets,
      payloadDigest,
    } as unknown as SurfaceAssetGrantIssueBinding;
    expect(() => assertSurfaceAssetGrantIssueBinding(grant, issue)).toThrow(
      "incomplete or unknown",
    );
    expect(() =>
      assertSurfaceAssetGrantUse(grant, {
        scope: grant.scope,
        surfacePrincipal: grant.surfacePrincipal,
        kind: "asset-download",
        ref: assetA,
        at: issuedAt,
        payloadDigest,
      } as unknown as SurfaceAssetGrantUse),
    ).toThrow("does not bind");
  });

  it("validates the complete issue binding with one canonical predicate", () => {
    const request = {
      kind: "asset-upload",
      scope: unsigned().scope,
      requestId: "request-1",
      assets: [assetA, assetB],
      payloadDigest,
    } as const;
    expect(validateSurfaceAssetGrantIssueBinding(request)).toEqual(request);
    expect(() =>
      validateSurfaceAssetGrantIssueBinding({
        ...request,
        kind: "unknown",
      }),
    ).toThrow("kind is invalid");
    expect(() =>
      validateSurfaceAssetGrantIssueBinding({
        ...request,
        assets: [assetB, assetA],
      }),
    ).toThrow("canonical order");
    expect(() =>
      validateSurfaceAssetGrantIssueBinding({
        kind: "asset-download",
        scope: request.scope,
        requestId: request.requestId,
        assets: request.assets,
        payloadDigest,
      }),
    ).toThrow("incomplete or unknown");
  });

  it("enforces canonical refs, byte budgets and the bounded lifetime", () => {
    expect(() =>
      createSignedSurfaceAssetGrant(
        unsigned({ assets: [assetA, assetA] }),
        signer,
      ),
    ).toThrow("duplicate");
    expect(() =>
      createSignedSurfaceAssetGrant(
        unsigned({
          assets: [{ ...assetA, bytes: MAX_SURFACE_ASSET_BYTES + 1 }],
        }),
        signer,
      ),
    ).toThrow("byte bound");
    expect(() =>
      createSignedSurfaceAssetGrant(
        unsigned({
          expiry: new Date(
            Date.parse(issuedAt) + MAX_SURFACE_ASSET_GRANT_TTL_MS + 1,
          ).toISOString(),
        }),
        signer,
      ),
    ).toThrow("TTL exceeds");
  });

  it("rejects unknown fields and a valid signature over non-canonical ordering", () => {
    const valid = createSignedSurfaceAssetGrant(unsigned(), signer);
    expect(() =>
      validateSurfaceAssetGrant({ ...valid, unknown: true }, verifier),
    ).toThrow("incomplete or unknown");

    const { signature: _, ...payload } = valid;
    const reordered = { ...payload, assets: [assetB, assetA] };
    const signed = {
      ...reordered,
      signature: signer.sign("SurfaceAssetGrant", 1, reordered) as Signature,
    } as SurfaceAssetGrant;
    expect(() => validateSurfaceAssetGrant(signed, verifier)).toThrow(
      "canonical order",
    );
  });
});
