import { describe, expect, it } from "vitest";
import { protocolDigest } from "./canonical.js";
import {
  createSignedDeviceLifecycleAbort,
  decodeDeviceLifecycleRecord,
  emptyDeviceLifecycleProjection,
  encodeDeviceLifecycleRecord,
  reduceDeviceLifecycle,
  reduceDeviceLifecycleProjection,
  validateDeviceLifecycleRecord,
  type AnchorUninstallLifecycleIdentity,
  type ExecutorRemovalLifecycleIdentity,
  type StopLifecycleIdentity,
} from "./device-lifecycle.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./signature.js";

const DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
const AT = "2026-08-12T00:00:00.000Z";

function identity(keyId: string): ProtocolSigner & ProtocolSignatureVerifier {
  return {
    sign(schemaId, version, payload) {
      return { alg: "test-digest", keyId, sig: protocolDigest(schemaId, version, payload) };
    },
    verify(schemaId, version, payload, signature) {
      expect(signature).toEqual(this.sign(schemaId, version, payload));
    },
  };
}

const issuer = identity("device-anchor");

describe("device lifecycle protocol", () => {
  it("strictly round-trips every stable operation identity", () => {
    for (const input of [stopIdentity(), removalIdentity(), uninstallIdentity()] as const) {
      const record = validateDeviceLifecycleRecord({ v: 1, t: "accepted", identity: input });
      expect(decodeDeviceLifecycleRecord(encodeDeviceLifecycleRecord(record))).toEqual(record);
    }
    expect(() => validateDeviceLifecycleRecord({
      v: 1,
      t: "accepted",
      identity: { ...stopIdentity(), pidFile: "secret-path" },
    })).toThrow("incomplete or unknown");
    expect(() => validateDeviceLifecycleRecord({
      v: 1,
      t: "accepted",
      identity: { ...removalIdentity(), acceptedTrustHeadDigest: "head" },
    })).toThrow("sha256 digest");
    expect(() => validateDeviceLifecycleRecord({
      v: 1,
      t: "accepted",
      identity: { ...uninstallIdentity(), anchorEpoch: 0 },
    })).toThrow("positive safe integer");
  });

  it("rejects cross-kind competition for the same home device before effects", () => {
    let projection = reduceDeviceLifecycleProjection(
      emptyDeviceLifecycleProjection(),
      { v: 1, t: "accepted", identity: removalIdentity() },
    );
    expect(() => reduceDeviceLifecycleProjection(
      projection,
      { v: 1, t: "accepted", identity: uninstallIdentity() },
    )).toThrow("already owns this home subject");
    projection = advanceRemovalToAbortable(projection);
    const abort = createSignedDeviceLifecycleAbort({
      v: 1,
      operationId: "remove-1",
      homeId: "home-1",
      subjectDeviceId: "device-executor",
      authorizedByDeviceId: "device-anchor",
      reason: "user-cancelled",
      at: AT,
    }, issuer);
    projection = reduceDeviceLifecycleProjection(
      projection,
      { v: 1, t: "aborted", operationId: "remove-1", abort },
      issuer,
    );
    expect(() => reduceDeviceLifecycleProjection(
      projection,
      { v: 1, t: "accepted", identity: uninstallIdentity() },
    )).not.toThrow();
  });

  it("lets stop atomically own its host and local device without blocking remote issuer work", () => {
    const projection = reduceDeviceLifecycleProjection(
      emptyDeviceLifecycleProjection(),
      { v: 1, t: "accepted", identity: stopIdentity() },
    );
    expect(() => reduceDeviceLifecycleProjection(projection, {
      v: 1,
      t: "accepted",
      identity: { ...removalIdentity(), targetDeviceId: "device-local" },
    })).toThrow("already owns this home subject");
    expect(() => reduceDeviceLifecycleProjection(projection, {
      v: 1,
      t: "accepted",
      identity: { ...uninstallIdentity(), currentDeviceId: "device-local" },
    })).toThrow("already owns this home subject");
    expect(() => reduceDeviceLifecycleProjection(projection, {
      v: 1,
      t: "accepted",
      identity: removalIdentity(),
    })).not.toThrow();
  });

  it("makes replay exact, forbids stop abort, and never moves a terminal backward", () => {
    const accepted = { v: 1, t: "accepted", identity: stopIdentity() } as const;
    let state = reduceDeviceLifecycle(undefined, accepted);
    expect(reduceDeviceLifecycle(state, accepted)).toBe(state);
    expect(() => reduceDeviceLifecycle(state, {
      v: 1,
      t: "accepted",
      identity: { ...stopIdentity(), strategy: "drain" },
    })).toThrow("conflicts with replay");
    expect(() => reduceDeviceLifecycle(state, {
      v: 1,
      t: "aborted",
      operationId: "stop-1",
      abort: createSignedDeviceLifecycleAbort({
        v: 1,
        operationId: "stop-1",
        homeId: "home-1",
        subjectDeviceId: "host:zhixing-home-1",
        authorizedByDeviceId: "device-anchor",
        reason: "user-cancelled",
        at: AT,
      }, issuer),
    }, issuer)).toThrow("Accepted stop cannot be aborted");
    for (const phase of ["gate-closed", "work-settled", "flushed", "ready-to-stop"] as const) {
      state = reduceDeviceLifecycle(state, {
        v: 1,
        t: "advanced",
        operationId: "stop-1",
        phase,
        evidence: [],
      });
    }
    state = reduceDeviceLifecycle(state, {
      v: 1,
      t: "terminal",
      operationId: "stop-1",
      outcome: "stopped",
      evidence: [{ kind: "supervisor", digest: DIGEST }],
    });
    expect(state.phase).toBe("terminal");
    expect(reduceDeviceLifecycle(state, {
      v: 1,
      t: "advanced",
      operationId: "stop-1",
      phase: "flushed",
      evidence: [],
    })).toBe(state);
  });

  it("permits authenticated cancel only before the first irreversible fact", () => {
    let state = reduceDeviceLifecycle(undefined, {
      v: 1,
      t: "accepted",
      identity: removalIdentity(),
    });
    for (const phase of ["gate-frozen", "authority-decided", "authority-settled"] as const) {
      state = reduceDeviceLifecycle(state, {
        v: 1,
        t: "advanced",
        operationId: "remove-1",
        phase,
        evidence: phase === "authority-settled"
          ? [{ kind: "authority-transfer", digest: DIGEST }]
          : [],
      });
    }
    const abort = createSignedDeviceLifecycleAbort({
      v: 1,
      operationId: "remove-1",
      homeId: "home-1",
      subjectDeviceId: "device-executor",
      authorizedByDeviceId: "device-anchor",
      reason: "preflight-changed",
      at: AT,
    }, issuer);
    expect(() => reduceDeviceLifecycle(state, {
      v: 1,
      t: "aborted",
      operationId: "remove-1",
      abort,
    }, issuer)).toThrow("cannot be aborted");
    expect(() => reduceDeviceLifecycle(
      reduceDeviceLifecycle(undefined, { v: 1, t: "accepted", identity: removalIdentity() }),
      { v: 1, t: "aborted", operationId: "remove-1", abort: { ...abort, homeId: "other" } },
      issuer,
    )).toThrow();
  });

  it("requires recovery backup to close and flush accepted work before final verification", () => {
    let state = reduceDeviceLifecycle(undefined, {
      v: 1,
      t: "accepted",
      identity: uninstallIdentity(),
    });
    for (const phase of [
      "gate-frozen",
      "checkpoint-verified",
      "retirement-decided",
      "gate-closed",
      "work-settled",
      "flushed",
      "final-checkpoint-verified",
      "cleanup-complete",
    ] as const) {
      state = reduceDeviceLifecycle(state, {
        v: 1,
        t: "advanced",
        operationId: "uninstall-1",
        phase,
        evidence: [],
      });
    }
    expect(state.phase).toBe("cleanup-complete");

    const beforeFinal = [
      "gate-frozen",
      "checkpoint-verified",
      "retirement-decided",
      "gate-closed",
      "work-settled",
    ] as const;
    let incomplete = reduceDeviceLifecycle(undefined, {
      v: 1,
      t: "accepted",
      identity: { ...uninstallIdentity(), operationId: "uninstall-incomplete" },
    });
    for (const phase of beforeFinal) {
      incomplete = reduceDeviceLifecycle(incomplete, {
        v: 1,
        t: "advanced",
        operationId: "uninstall-incomplete",
        phase,
        evidence: [],
      });
    }
    expect(() => reduceDeviceLifecycle(incomplete, {
      v: 1,
      t: "advanced",
      operationId: "uninstall-incomplete",
      phase: "final-checkpoint-verified",
      evidence: [],
    })).toThrow("cannot advance");
  });

  it("makes each cross-end peer effect an exact single durable fact", () => {
    let state = reduceDeviceLifecycle(undefined, {
      v: 1,
      t: "accepted",
      identity: removalIdentity(),
    });
    const effect = {
      v: 1,
      t: "peer-effect",
      operationId: "remove-1",
      effect: { kind: "target-ready", digest: DIGEST, evidence: [] },
    } as const;
    state = reduceDeviceLifecycle(state, effect);
    expect(reduceDeviceLifecycle(state, effect)).toBe(state);
    expect(() => reduceDeviceLifecycle(state, {
      ...effect,
      effect: { ...effect.effect, digest: OTHER_DIGEST },
    })).toThrow("conflicts with replay");
  });

  it("rejects corrupt canonical bytes, duplicate evidence and skipped phases", () => {
    const record = { v: 1, t: "accepted", identity: stopIdentity() } as const;
    expect(() => decodeDeviceLifecycleRecord(Buffer.from(JSON.stringify(record), "utf8"))).toThrow("bytes are invalid");
    const state = reduceDeviceLifecycle(undefined, record);
    expect(() => reduceDeviceLifecycle(state, {
      v: 1,
      t: "advanced",
      operationId: "stop-1",
      phase: "flushed",
      evidence: [],
    })).toThrow("cannot advance");
    expect(() => validateDeviceLifecycleRecord({
      v: 1,
      t: "advanced",
      operationId: "stop-1",
      phase: "gate-closed",
      evidence: [
        { kind: "accepted-work", digest: OTHER_DIGEST },
        { kind: "accepted-work", digest: OTHER_DIGEST },
      ],
    })).toThrow("duplicate");
  });

});

function stopIdentity(): StopLifecycleIdentity {
  return {
    v: 1,
    kind: "stop",
    localDeviceId: "device-local",
    requestId: "request-stop-1",
    operationId: "stop-1",
    homeId: "home-1",
    strategy: "immediate",
    host: {
      kind: "managed",
      serviceId: "zhixing-home-1",
      definitionDigest: DIGEST,
      instanceId: "managed-instance-1",
    },
  };
}

function removalIdentity(): ExecutorRemovalLifecycleIdentity {
  return {
    v: 1,
    kind: "executor-removal",
    requestId: "request-remove-1",
    operationId: "remove-1",
    homeId: "home-1",
    targetDeviceId: "device-executor",
    targetMemberPublicKey: "ed25519:executor-key",
    targetDeviceKeyGeneration: "device-key-generation-1",
    acceptedIssuerDeviceId: "device-anchor",
    acceptedTrustHeadDigest: DIGEST,
  };
}

function uninstallIdentity(): AnchorUninstallLifecycleIdentity {
  return {
    v: 1,
    kind: "anchor-uninstall",
    requestId: "request-uninstall-1",
    operationId: "uninstall-1",
    homeId: "home-1",
    currentDeviceId: "device-executor",
    anchorEpoch: 3,
    trustHeadDigest: DIGEST,
    path: {
      kind: "recovery-backup",
      checkpointTargetId: "checkpoint-target-1",
      checkpointGeneration: "checkpoint-generation-7",
    },
  };
}

function advanceRemovalToAbortable(projection: ReturnType<typeof emptyDeviceLifecycleProjection>) {
  return reduceDeviceLifecycleProjection(projection, {
    v: 1,
    t: "advanced",
    operationId: "remove-1",
    phase: "gate-frozen",
    evidence: [],
  });
}
