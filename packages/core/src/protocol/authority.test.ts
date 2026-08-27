import { describe, expect, it } from "vitest";
import type {
  AuthorityCapability,
  AuthorityPrincipal,
  ControlLease,
  OwnerControlGrant,
  PermissionSnapshotLease,
} from "../contracts/index.js";
import {
  AUTHORITY_PORT_METHODS,
  MAX_PERMISSION_LEASE_TTL_MS,
  PRINCIPAL_METHODS,
  assertActivatedAssignmentCapability,
  assertActivePermissionSnapshotLease,
  assertAuthorizedOwnerControlGrant,
  acceptedRemoteIntervalRemainingMs,
  controlLeaseIdentityDigest,
  createAuthorityPrincipalMethodGuard,
  ownerControlRequestDigest,
  permissionSnapshotLeaseIdentityDigest,
  principalAllowsAuthorityMethod,
  validateAuthorityCapability,
  validateControlLease,
  validateOwnerControlGrant,
  validatePermissionSnapshotLease,
} from "./authority.js";
import { protocolDigest } from "./canonical.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test",
      keyId: "device:test",
      sig: protocolDigest("TestSignature", 1, { schemaId, version, payload }),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

const issuedAt = "2026-07-20T00:00:00.000Z";
const expiry = "2026-07-20T01:00:00.000Z";

function capability(): AuthorityCapability<"conversation"> {
  const payload = {
    v: 1 as const,
    capId: "cap:assignment-1",
    executorId: "executor-1",
    scope: { execution: "conversation" as const, conversationId: "conversation-1" },
    ownerEpoch: 7,
    methods: ["submission.submitBundle"] as const,
    resources: ["conversation:conversation-1"] as const,
    assignmentId: "assignment-1",
    issuedAt,
    expiry,
  };
  return {
    ...payload,
    methods: [...payload.methods],
    resources: [...payload.resources],
    signature: identity.sign("AuthorityCapability", 1, payload),
  };
}

function resignCapability(
  mutate: (payload: Omit<AuthorityCapability<"conversation">, "signature">) => void,
): AuthorityCapability<"conversation"> {
  const { signature: _, ...payload } = capability();
  const changed = structuredClone(payload);
  mutate(changed);
  return {
    ...changed,
    signature: identity.sign("AuthorityCapability", 1, changed),
  };
}

function permissionLease(): PermissionSnapshotLease<"conversation"> {
  const payload = {
    v: 1 as const,
    snapshotVersion: 3,
    snapshotDigest: protocolDigest("TrustRuleSnapshot", 1, { rules: [] }),
    binding: {
      execution: "conversation" as const,
      runId: "run-1",
      conversationId: "conversation-1",
      ownerEpoch: 7,
    },
    assignmentId: "assignment-1",
    executorId: "executor-1",
    controlLeaseId: "control-1",
    issuedAt,
    expiry,
  };
  return {
    ...payload,
    signature: identity.sign("PermissionSnapshotLease", 1, payload),
  };
}

function controlLease(): ControlLease {
  const payload = {
    v: 1 as const,
    controlLeaseId: "control-1",
    assignmentId: "assignment-1",
    authority: {
      execution: "conversation" as const,
      conversationId: "conversation-1",
      ownerEpoch: 7,
    },
    renewalSeq: 1,
    issuedAt,
    expiry: "2026-07-20T00:01:00.000Z",
  };
  return {
    ...payload,
    signature: identity.sign("ControlLease", 1, payload),
  };
}

describe("authority principal method matrix", () => {
  it("closes every authority method across all five principals", () => {
    const principals = Object.keys(PRINCIPAL_METHODS) as AuthorityPrincipal["kind"][];
    expect(principals).toHaveLength(5);
    expect(new Set(AUTHORITY_PORT_METHODS).size).toBe(AUTHORITY_PORT_METHODS.length);
    for (const method of AUTHORITY_PORT_METHODS) {
      for (const principal of principals) {
        expect(principalAllowsAuthorityMethod(principal, method)).toBe(
          (PRINCIPAL_METHODS[principal] as readonly string[]).includes(method),
        );
      }
    }
  });

  it("keeps privileged methods out of host authority", () => {
    for (const method of [
      "submission.submitBundle",
      "governor.submitUsageReport",
      "executor.dispatch",
    ] as const) {
      expect(principalAllowsAuthorityMethod("host", method)).toBe(false);
    }
  });

  it("narrows host authority through the registered component whitelist", () => {
    const guard = createAuthorityPrincipalMethodGuard({
      "scheduler-anchor": ["reservation.prepareSystemJobRoot"],
    });
    const scheduler = { kind: "host", component: "scheduler-anchor" } as const;
    expect(guard.allows(scheduler, "reservation.prepareSystemJobRoot")).toBe(true);
    expect(guard.allows(scheduler, "global.mutate")).toBe(false);
    expect(guard.allows(
      { kind: "host", component: "unknown-component" },
      "reservation.prepareSystemJobRoot",
    )).toBe(false);
    expect(() => guard.assert(scheduler, "global.mutate")).toThrow(
      "host principal cannot call global.mutate",
    );
    expect(() => createAuthorityPrincipalMethodGuard({
      "scheduler-anchor": ["submission.submitBundle" as never],
    })).toThrow("forbidden method");
  });
});

describe("authority protocol guards", () => {
  it("validates signed capabilities and rejects methods outside the frozen matrix", () => {
    expect(validateAuthorityCapability(capability(), identity)).toEqual(capability());
    const invalid = structuredClone(capability()) as AuthorityCapability;
    (invalid.methods as string[]) = ["executor.dispatch"];
    expect(() => validateAuthorityCapability(invalid, identity)).toThrow(
      "forbidden method",
    );
    const retiredMemoryResource = resignCapability((payload) => {
      Object.assign(payload, { resources: ["memory-domain:personal"] });
    });
    expect(() => validateAuthorityCapability(retiredMemoryResource, identity)).toThrow(
      "resource selector is invalid",
    );
  });

  it("requires durable activation and rejects active expiry or revocation", () => {
    const candidate = capability();
    const common = {
      capability: candidate,
      activation: {
        capIds: [candidate.capId],
        assignmentId: candidate.assignmentId,
        executorId: candidate.executorId,
        authority: {
          execution: "conversation" as const,
          conversationId: candidate.scope.conversationId,
          ownerEpoch: candidate.ownerEpoch,
        },
      },
      verifier: identity,
      method: "submission.submitBundle" as const,
      resource: "conversation:conversation-1" as const,
      deadlineAt: expiry,
    };
    expect(() => assertActivatedAssignmentCapability({
      ...common,
      mode: "active",
      revoked: false,
      now: "2026-07-20T00:30:00.000Z",
    })).not.toThrow();
    expect(() => assertActivatedAssignmentCapability({
      ...common,
      mode: "active",
      revoked: true,
      now: "2026-07-20T00:30:00.000Z",
    })).toThrow("expired or revoked");
    expect(() => assertActivatedAssignmentCapability({
      ...common,
      activation: undefined,
      mode: "active",
      revoked: false,
      now: "2026-07-20T00:30:00.000Z",
    })).toThrow("not activated");
    expect(() => assertActivatedAssignmentCapability({
      ...common,
      mode: "durable-replay",
      revoked: true,
      now: "2026-07-20T02:00:00.000Z",
    })).not.toThrow();
  });

  it("rejects every assignment authority binding dimension independently", () => {
    const original = capability();
    const common = {
      activation: {
        capIds: [original.capId],
        assignmentId: original.assignmentId,
        executorId: original.executorId,
        authority: {
          execution: "conversation" as const,
          conversationId: original.scope.conversationId,
          ownerEpoch: original.ownerEpoch,
        },
      },
      verifier: identity,
      method: "submission.submitBundle" as const,
      resource: "conversation:conversation-1" as const,
      mode: "active" as const,
      revoked: false,
      now: "2026-07-20T00:30:00.000Z",
      deadlineAt: expiry,
    };
    const forged = [
      resignCapability((payload) => { payload.assignmentId = "assignment-2"; }),
      resignCapability((payload) => { payload.executorId = "executor-2"; }),
      resignCapability((payload) => { payload.ownerEpoch = 8; }),
      resignCapability((payload) => {
        payload.scope = {
          execution: "conversation",
          conversationId: "conversation-2",
        };
      }),
    ];
    for (const candidate of forged) {
      expect(() => assertActivatedAssignmentCapability({
        ...common,
        capability: candidate,
      })).toThrow("not activated");
    }
    expect(() => assertActivatedAssignmentCapability({
      ...common,
      capability: original,
      resource: "conversation:conversation-2",
    })).toThrow("does not authorize this resource");
    expect(() => assertActivatedAssignmentCapability({
      ...common,
      capability: original,
      method: "submission.reportStarted",
    })).toThrow("does not authorize this method");
    expect(() => assertActivatedAssignmentCapability({
      ...common,
      capability: original,
      now: "2026-07-20T02:00:00.000Z",
    })).toThrow("expired or revoked");
  });

  it("binds permission leases to received activation and active executor state", () => {
    const lease = permissionLease();
    expect(validatePermissionSnapshotLease(lease, identity)).toEqual(lease);
    const common = {
      lease,
      verifier: identity,
      activationDigest: permissionSnapshotLeaseIdentityDigest(lease),
      assignmentId: "assignment-1",
      executorId: "executor-1",
      active: true,
      now: "2026-07-20T00:30:00.000Z",
    };
    expect(() => assertActivePermissionSnapshotLease(common)).not.toThrow();
    expect(() => assertActivePermissionSnapshotLease({
      ...common,
      activationDigest: undefined,
    })).toThrow("inactive");
    expect(() => assertActivePermissionSnapshotLease({
      ...common,
      active: false,
    })).toThrow("inactive");
    expect(() => assertActivePermissionSnapshotLease({
      ...common,
      now: "2026-07-20T02:00:00.000Z",
    })).toThrow("inactive");
  });

  it("rejects permission snapshot leases beyond the protocol TTL budget", () => {
    const { signature: _, ...payload } = permissionLease();
    const atLimit = {
      ...payload,
      expiry: new Date(
        Date.parse(payload.issuedAt) + MAX_PERMISSION_LEASE_TTL_MS,
      ).toISOString(),
    };
    expect(() => validatePermissionSnapshotLease({
      ...atLimit,
      signature: identity.sign("PermissionSnapshotLease", 1, atLimit),
    }, identity)).not.toThrow();

    const overLimit = {
      ...payload,
      expiry: new Date(
        Date.parse(payload.issuedAt) + MAX_PERMISSION_LEASE_TTL_MS + 1,
      ).toISOString(),
    };
    expect(() => validatePermissionSnapshotLease({
      ...overLimit,
      signature: identity.sign("PermissionSnapshotLease", 1, overLimit),
    }, identity)).toThrow("TTL exceeds the protocol limit");
  });

  it("validates owner control methods through the same registry", () => {
    const lease = controlLease();
    const authority = lease.authority;
    const requestDigest = ownerControlRequestDigest({
      method: "executor.dispatch",
      assignmentId: "assignment-1",
      authority,
      requestId: "request-1",
      body: { dispatchDigest: "sha256:" + "1".repeat(64) },
    });
    const payload = {
      v: 1 as const,
      assignmentId: "assignment-1",
      scope: authority,
      methods: ["executor.dispatch"] as const,
      callerDeviceId: "device:test",
      requestId: "request-1",
      requestDigest,
      controlLease: lease,
      issuedAt,
      expiry: lease.expiry,
    };
    const grant: OwnerControlGrant = {
      ...payload,
      methods: [...payload.methods],
      signature: identity.sign("OwnerControlGrant", 1, payload),
    };
    expect(validateOwnerControlGrant(grant, identity)).toEqual(grant);
    const impersonatedPayload = {
      ...payload,
      callerDeviceId: "device:other",
    };
    expect(() => validateOwnerControlGrant({
      ...impersonatedPayload,
      methods: [...impersonatedPayload.methods],
      signature: identity.sign("OwnerControlGrant", 1, impersonatedPayload),
    }, identity)).toThrow();
    const authorized = {
      grant,
      verifier: identity,
      method: "executor.dispatch" as const,
      assignmentId: "assignment-1",
      callerDeviceId: "device:test",
      authenticatedCallerDeviceId: "device:test",
      expectedOwnerDeviceId: "device:test",
      requestId: "request-1",
      requestDigest,
      now: "2026-07-20T00:00:30.000Z",
      deadlineAt: lease.expiry,
      authority: payload.scope,
    };
    expect(() => assertAuthorizedOwnerControlGrant(authorized)).not.toThrow();
    expect(() => assertAuthorizedOwnerControlGrant({
      ...authorized,
      authority: { ...payload.scope, ownerEpoch: 8 },
    })).toThrow("does not authorize");
    expect(() => assertAuthorizedOwnerControlGrant({
      ...authorized,
      requestDigest: protocolDigest("OwnerControlRequest", 1, { altered: true }),
    })).toThrow("does not authorize");
    expect(() => assertAuthorizedOwnerControlGrant({
      ...authorized,
      requestId: "request-2",
    })).toThrow("does not authorize");
    expect(() => assertAuthorizedOwnerControlGrant({
      ...authorized,
      authenticatedCallerDeviceId: "device:other",
    })).toThrow("does not authorize");
    expect(() => assertAuthorizedOwnerControlGrant({
      ...authorized,
      expectedOwnerDeviceId: "device:other",
    })).toThrow("does not authorize");
    expect(() => assertAuthorizedOwnerControlGrant({
      ...authorized,
      now: "2026-07-20T00:03:00.000Z",
    })).toThrow("clock-skew window");
  });

  it("bounds remote lease conversion and keeps control identities sequence-sensitive", () => {
    const lease = controlLease();
    expect(validateControlLease(lease, identity)).toEqual(lease);
    expect(acceptedRemoteIntervalRemainingMs({
      issuedAt: lease.issuedAt,
      expiry: lease.expiry,
      acceptedAt: "2026-07-20T00:00:30.000Z",
      maxTtlMs: 60_000,
    })).toBe(60_000);
    expect(() => acceptedRemoteIntervalRemainingMs({
      issuedAt: lease.issuedAt,
      expiry: lease.expiry,
      acceptedAt: "2026-07-20T00:03:00.000Z",
      maxTtlMs: 60_000,
    })).toThrow("clock-skew window");
    const renewedPayload = {
      ...lease,
      renewalSeq: lease.renewalSeq + 1,
    };
    const { signature: _, ...unsigned } = renewedPayload;
    const renewed: ControlLease = {
      ...unsigned,
      signature: identity.sign("ControlLease", 1, unsigned),
    };
    expect(controlLeaseIdentityDigest(renewed)).not.toBe(
      controlLeaseIdentityDigest(lease),
    );
    expect(ownerControlRequestDigest({
      method: "executor.cancel",
      assignmentId: lease.assignmentId,
      authority: lease.authority,
      requestId: "cancel-1",
      body: { fenceSeq: 1 },
    })).not.toBe(ownerControlRequestDigest({
      method: "executor.cancel",
      assignmentId: lease.assignmentId,
      authority: lease.authority,
      requestId: "cancel-1",
      body: { fenceSeq: 2 },
    }));
  });

  it("treats capability and permission validity intervals as half-open", () => {
    const candidate = capability();
    const common = {
      capability: candidate,
      activation: {
        capIds: [candidate.capId],
        assignmentId: candidate.assignmentId,
        executorId: candidate.executorId,
        authority: {
          execution: "conversation" as const,
          conversationId: candidate.scope.conversationId,
          ownerEpoch: candidate.ownerEpoch,
        },
      },
      verifier: identity,
      method: "submission.submitBundle" as const,
      resource: "conversation:conversation-1" as const,
      mode: "active" as const,
      revoked: false,
      deadlineAt: expiry,
    };
    expect(() => assertActivatedAssignmentCapability({
      ...common,
      now: "2026-07-19T23:59:59.999Z",
    })).toThrow("expired or revoked");
    expect(() => assertActivatedAssignmentCapability({
      ...common,
      now: expiry,
    })).toThrow("expired or revoked");

    const lease = permissionLease();
    const leaseCommon = {
      lease,
      verifier: identity,
      activationDigest: permissionSnapshotLeaseIdentityDigest(lease),
      assignmentId: lease.assignmentId,
      executorId: lease.executorId,
      active: true,
    };
    expect(() => assertActivePermissionSnapshotLease({
      ...leaseCommon,
      now: "2026-07-19T23:59:59.999Z",
    })).toThrow("inactive");
    expect(() => assertActivePermissionSnapshotLease({
      ...leaseCommon,
      now: expiry,
    })).toThrow("inactive");
  });
});
