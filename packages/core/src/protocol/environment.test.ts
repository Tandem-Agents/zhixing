import { describe, expect, it } from "vitest";
import type {
  EnvironmentControlGrant,
  ImmediateRootResourceLease,
  ResourceLease,
} from "../contracts/index.js";
import {
  createSignedEnvironmentControlGrant,
  createSignedWorkspaceProbeResult,
  validateEnvironmentControlGrant,
  validateExplicitEnvironmentSelection,
  validateWorkspaceProbeRequest,
  validateWorkspaceProbeResult,
  workspaceProbeRequestDigest,
} from "./environment.js";
import { protocolDigest } from "./canonical.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";

const NOW = "2026-07-30T00:00:00.000Z";
const EXPIRY = "2026-07-30T00:05:00.000Z";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test-digest",
      keyId: "device-a",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

describe("environment protocol", () => {
  it("strictly validates explicit first-party environment selections", () => {
    expect(
      validateExplicitEnvironmentSelection({
        workspace: { deviceId: "device-a", bindingRef: "workspace-a" },
      }),
    ).toEqual({
      workspace: { deviceId: "device-a", bindingRef: "workspace-a" },
    });
    expect(() =>
      validateExplicitEnvironmentSelection({
        workspace: {
          deviceId: "device-a",
          bindingRef: "workspace-a",
          absolutePath: "C:\\secret",
        },
      }),
    ).toThrow("fields are incomplete or unknown");
  });

  it("binds the grant, lease, request and result without exposing a path", () => {
    const lease = immediateLease("probe-1");
    const grant = createSignedEnvironmentControlGrant(
      {
        v: 1,
        grantId: "environment-grant-1",
        deviceId: "device-a",
        bindingRef: "workspace-a",
        methods: ["environment.probe"],
        requestId: "probe-1",
        resourceLeaseDigest: lease.digest,
        issuedAt: NOW,
        expiry: EXPIRY,
      },
      identity,
    );
    expect(validateEnvironmentControlGrant(grant, identity)).toEqual(grant);
    const request = {
      v: 1 as const,
      requestId: "probe-1",
      deviceId: "device-a",
      bindingRef: "workspace-a",
      grant,
      resourceLease: lease,
      at: NOW,
    };
    expect(validateWorkspaceProbeRequest(request, identity)).toEqual(request);
    expect(workspaceProbeRequestDigest(request)).toMatch(/^sha256:/u);

    const result = createSignedWorkspaceProbeResult(
      {
        v: 1,
        requestId: "probe-1",
        bindingRef: "workspace-a",
        workspaceBindingRevision: 2,
        probe: "directory",
        executorId: "executor-a",
      },
      identity,
    );
    expect(validateWorkspaceProbeResult(result, identity)).toEqual(result);
    expect(JSON.stringify({ grant, request, result })).not.toContain("secret");
  });

  it("rejects cross-binding, stale and altered lease uses", () => {
    const lease = immediateLease("probe-1");
    const grant = signedGrant(lease);
    const request = {
      v: 1 as const,
      requestId: "probe-1",
      deviceId: "device-a",
      bindingRef: "workspace-a",
      grant,
      resourceLease: lease,
      at: NOW,
    };
    expect(() =>
      validateWorkspaceProbeRequest(
        { ...request, bindingRef: "workspace-b" },
        identity,
      ),
    ).toThrow("does not bind");
    expect(() =>
      validateWorkspaceProbeRequest(
        { ...request, at: EXPIRY },
        identity,
      ),
    ).toThrow("not active");
    expect(() =>
      validateWorkspaceProbeRequest(
        {
          ...request,
          resourceLease: {
            ...lease,
            digest: protocolDigest("WrongLease", 1, {}),
          },
        },
        identity,
      ),
    ).toThrow();
  });
});

function signedGrant(
  lease: ImmediateRootResourceLease,
): EnvironmentControlGrant {
  return createSignedEnvironmentControlGrant(
    {
      v: 1,
      grantId: "environment-grant-1",
      deviceId: "device-a",
      bindingRef: "workspace-a",
      methods: ["environment.probe"],
      requestId: "probe-1",
      resourceLeaseDigest: lease.digest,
      issuedAt: NOW,
      expiry: EXPIRY,
    },
    identity,
  );
}

function immediateLease(requestId: string): ImmediateRootResourceLease {
  const payload: Omit<ResourceLease, "digest" | "signature"> = {
    v: 1,
    reservationId: `reservation-${requestId}`,
    admissionClass: "interactive",
    workload: { kind: "control", id: requestId, attempt: 1 },
    scopeBinding: {
      kind: "control",
      subject: requestId,
    },
    audience: { executorId: "executor-a" },
    budget: { maxCalls: 1 },
    domain: { kind: "local", localDomainId: "device-a", localGovernorEpoch: 1 },
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: identity.sign("ResourceLease", 1, withDigest),
  } as ImmediateRootResourceLease;
}
