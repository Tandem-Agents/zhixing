import type {
  GovernorRecord,
  ReservableResourceLease,
  ResourceLease,
  Signature,
} from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { canonicalize, protocolDigest } from "./canonical.js";
import {
  ADMISSION_CLASSES,
  applyGovernorRecord,
  applyGovernorRecordAt,
  assertResourceAdmissionRequest,
  assertAssignmentReservationRequest,
  assertSystemJobReservationRequest,
  cloneGovernorProjection,
  compactGovernorProjection,
  conservativeUsageConsumptionRecords,
  dequeueFairReservation,
  emptyGovernorProjection,
  selectFairReservation,
  validateGovernorRecord,
  validateReservableResourceLease,
  waitForResourceAdmissionCandidate,
} from "./resource-governor.js";
import { RESOURCE_WORKLOAD_KINDS } from "../contracts/authorization.js";

const NOW = "2026-07-20T00:00:00.000Z";
const EXPIRY = "2026-07-20T01:00:00.000Z";

const signer = {
  sign(schemaId: string, version: number, payload: unknown): Signature {
    return {
      alg: "test-sha256",
      keyId: "executor-1",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier = {
  verify(schemaId: string, version: number, payload: unknown, signature: Signature) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

describe("resource governor protocol", () => {
  it("replays the durable weighted admission order", () => {
    const state = emptyGovernorProjection();
    const classes = [
      ...Array.from({ length: 16 }, (_, index) => ["interactive", `i-${index}`] as const),
      ...Array.from({ length: 8 }, (_, index) => ["advancement", `a-${index}`] as const),
      ...Array.from({ length: 4 }, (_, index) => ["scheduler", `s-${index}`] as const),
      ...Array.from({ length: 2 }, (_, index) => ["orchestration", `o-${index}`] as const),
    ];
    for (const [admissionClass, reservationId] of classes) {
      applyGovernorRecord(state, {
        t: "queued",
        reservationId,
        admissionClass,
        workload: { kind: "control", id: reservationId, attempt: 1 },
      }, verifier);
    }

    const order: string[] = [];
    while (state.queued.size > 0) {
      const selected = dequeueFairReservation(cloneGovernorProjection(state))!;
      order.push(selected.reservationId);
      applyGovernorRecord(
        state,
        { t: "reserve", lease: rootLease(selected.reservationId, selected.admissionClass) },
        verifier,
      );
    }

    expect(order.slice(0, 15)).toEqual([
      "i-0", "i-1", "i-2", "i-3", "i-4", "i-5", "i-6", "i-7",
      "a-0", "a-1", "a-2", "a-3",
      "s-0", "s-1",
      "o-0",
    ]);
    expect(order).toHaveLength(30);
  });

  it("prevents aggregate child oversell and returns only unused budget", () => {
    const state = emptyGovernorProjection();
    const root = rootLease("root-1", "interactive", {
      budget: { maxCalls: 10 },
      delegation: {
        executorId: "executor-1",
        maxDepth: 1,
        maxBudget: { maxCalls: 10 },
      },
    });
    applyGovernorRecord(state, {
      t: "queued",
      reservationId: root.reservationId,
      admissionClass: root.admissionClass,
      workload: root.workload,
    }, verifier);
    applyGovernorRecord(state, { t: "reserve", lease: root }, verifier);

    const first = childLease(root, "child-1", 6);
    applyGovernorRecord(state, { t: "reserve", lease: first }, verifier);
    expect(() =>
      applyGovernorRecord(
        cloneGovernorProjection(state),
        { t: "reserve", lease: childLease(root, "child-over", 5) },
        verifier,
      )
    ).toThrow("commitments");

    applyGovernorRecord(state, {
      t: "usage-reserved",
      rootReservationId: root.reservationId,
      reservationId: first.reservationId,
      usageId: "usage-1",
      calls: 3,
    }, verifier);
    applyGovernorRecord(state, {
      t: "consume",
      usageSeq: 1,
      rootReservationId: root.reservationId,
      reservationId: first.reservationId,
      usageId: "usage-1",
      calls: 3,
    }, verifier);
    applyGovernorRecord(state, { t: "settle", reservationId: first.reservationId }, verifier);
    applyGovernorRecord(state, { t: "release", reservationId: first.reservationId }, verifier);

    const second = childLease(root, "child-2", 7);
    applyGovernorRecord(state, { t: "reserve", lease: second }, verifier);
    expect(state.reservations.get(root.reservationId)).toMatchObject({
      descendantUsed: { calls: 3 },
      reservedForChildren: { calls: 7 },
    });
  });

  it("compacts terminal resource history without retaining consumed usage", () => {
    const state = emptyGovernorProjection();
    const lease = rootLease("root-retained", "interactive", { budget: { maxCalls: 2 } });
    const apply = (record: GovernorRecord, at: string) =>
      applyGovernorRecordAt(state, record, at, 24 * 60 * 60_000, verifier);
    apply({
      t: "queued",
      reservationId: lease.reservationId,
      admissionClass: lease.admissionClass,
      workload: lease.workload,
    }, NOW);
    apply({ t: "reserve", lease }, NOW);
    apply({
      t: "usage-reserved",
      rootReservationId: lease.reservationId,
      reservationId: lease.reservationId,
      usageId: "usage-retained",
      calls: 1,
    }, NOW);
    apply({
      t: "consume",
      usageSeq: 1,
      rootReservationId: lease.reservationId,
      reservationId: lease.reservationId,
      usageId: "usage-retained",
      calls: 1,
    }, NOW);
    apply(
      { t: "release", reservationId: lease.reservationId },
      "2026-07-20T00:00:01.000Z",
    );

    compactGovernorProjection(state, "2026-07-20T00:00:02.000Z");

    expect(state.reservations.size).toBe(0);
    expect(state.leaseAcceptances.size).toBe(0);
    expect(state.usages.size).toBe(0);
    expect(state.usageReservations.size).toBe(0);
    expect(state.nextUsageSeqByRoot.size).toBe(0);
  });

  it("conservatively consumes only the expired child scope", () => {
    const state = activeRoot("root-scope", { maxCalls: 4 });
    const root = state.reservations.get("root-scope")!.lease;
    const expiredChild = childLease(root, "child-expired", 2);
    const activeSibling = childLease(root, "child-active", 2);
    applyGovernorRecord(state, { t: "reserve", lease: expiredChild }, verifier);
    applyGovernorRecord(state, { t: "reserve", lease: activeSibling }, verifier);
    for (const [usageId, reservationId] of [
      ["usage-expired", expiredChild.reservationId],
      ["usage-active", activeSibling.reservationId],
    ] as const) {
      applyGovernorRecord(state, {
        t: "usage-reserved",
        rootReservationId: root.reservationId,
        reservationId,
        usageId,
        calls: 1,
      }, verifier);
    }

    expect(conservativeUsageConsumptionRecords(state, {
      reservationIds: new Set([expiredChild.reservationId]),
    })).toEqual([expect.objectContaining({ usageId: "usage-expired" })]);
  });

  it("accounts nested child usage through every ancestor within root delegation", () => {
    const state = emptyGovernorProjection();
    const root = rootLease("root-nested", "orchestration", {
      budget: { maxCalls: 10 },
      delegation: {
        executorId: "executor-1",
        maxDepth: 2,
        maxBudget: { maxCalls: 10 },
      },
    });
    applyGovernorRecord(state, {
      t: "queued",
      reservationId: root.reservationId,
      admissionClass: root.admissionClass,
      workload: root.workload,
    }, verifier);
    applyGovernorRecord(state, { t: "reserve", lease: root }, verifier);
    const child = childLease(root, "child-nested", 8);
    applyGovernorRecord(state, { t: "reserve", lease: child }, verifier);
    const grandchild = childLease(child, "grandchild-nested", 5);
    applyGovernorRecord(state, { t: "reserve", lease: grandchild }, verifier);
    applyGovernorRecord(state, {
      t: "usage-reserved",
      rootReservationId: root.reservationId,
      reservationId: grandchild.reservationId,
      usageId: "usage-nested",
      calls: 3,
    }, verifier);
    applyGovernorRecord(state, {
      t: "consume",
      usageSeq: 1,
      rootReservationId: root.reservationId,
      reservationId: grandchild.reservationId,
      usageId: "usage-nested",
      calls: 3,
    }, verifier);
    applyGovernorRecord(state, { t: "release", reservationId: grandchild.reservationId }, verifier);
    applyGovernorRecord(state, { t: "release", reservationId: child.reservationId }, verifier);
    expect(state.reservations.get(root.reservationId)).toMatchObject({
      descendantUsed: { calls: 3 },
      reservedForChildren: { calls: 0 },
    });
  });

  it("makes usage identity exact and sequence continuous", () => {
    const state = activeRoot("root-usage", { maxCalls: 3 });
    const record: GovernorRecord = {
      t: "consume",
      usageSeq: 1,
      rootReservationId: "root-usage",
      reservationId: "root-usage",
      usageId: "usage-1",
      calls: 1,
    };
    applyGovernorRecord(state, {
      t: "usage-reserved",
      rootReservationId: "root-usage",
      reservationId: "root-usage",
      usageId: "usage-1",
      calls: 1,
    }, verifier);
    applyGovernorRecord(state, record, verifier);
    applyGovernorRecord(state, record, verifier);
    expect(state.reservations.get("root-usage")?.used.calls).toBe(1);
    expect(() =>
      applyGovernorRecord(state, { ...record, calls: 2 }, verifier)
    ).toThrow("different content");
    applyGovernorRecord(state, {
      t: "usage-reserved",
      rootReservationId: "root-usage",
      reservationId: "root-usage",
      usageId: "usage-gap",
      calls: 1,
    }, verifier);
    expect(() =>
      applyGovernorRecord(state, {
        ...record,
        usageId: "usage-gap",
        usageSeq: 3,
      }, verifier)
    ).toThrow("not continuous");
  });

  it("replays each terminal action idempotently after settle and release", () => {
    const state = activeRoot("root-terminal", { maxCalls: 1 });
    applyGovernorRecord(state, { t: "settle", reservationId: "root-terminal" }, verifier);
    applyGovernorRecord(state, { t: "release", reservationId: "root-terminal" }, verifier);
    applyGovernorRecord(state, { t: "settle", reservationId: "root-terminal" }, verifier);
    applyGovernorRecord(state, { t: "release", reservationId: "root-terminal" }, verifier);
    expect(state.reservations.get("root-terminal")).toMatchObject({
      settled: true,
      state: "released",
    });
  });

  it("accounts signed remote child usage against its delegated root", () => {
    const state = activeRoot("root-remote", { maxCalls: 3 });
    applyGovernorRecord(state, {
      t: "usage-reserved",
      rootReservationId: "root-remote",
      reservationId: "remote-child-1",
      usageId: "remote-usage-1",
      calls: 2,
    }, verifier);
    applyGovernorRecord(state, {
      t: "consume",
      usageSeq: 1,
      rootReservationId: "root-remote",
      reservationId: "remote-child-1",
      usageId: "remote-usage-1",
      calls: 2,
    }, verifier);
    expect(state.reservations.get("root-remote")).toMatchObject({
      descendantUsed: { calls: 2 },
    });
    expect(() => applyGovernorRecord(state, {
      t: "usage-reserved",
      rootReservationId: "root-remote",
      reservationId: "remote-child-2",
      usageId: "remote-usage-over",
      calls: 2,
    }, verifier)).toThrow("budget");
  });

  it("dequeues without consuming service and rejects every later activation", () => {
    const state = emptyGovernorProjection();
    applyGovernorRecord(state, {
      t: "queued",
      reservationId: "cancelled-root",
      admissionClass: "interactive",
      workload: { kind: "control", id: "cancelled-root", attempt: 1 },
    }, verifier);
    applyGovernorRecord(state, {
      t: "dequeue",
      workload: { kind: "control", id: "cancelled-root", attempt: 1 },
      reason: "cancelled",
    }, verifier);
    applyGovernorRecord(state, {
      t: "dequeue",
      workload: { kind: "control", id: "cancelled-root", attempt: 1 },
      reason: "cancelled",
    }, verifier);
    expect(state.admissionDeficits.interactive).toBe(0);
    expect(() => applyGovernorRecord(state, {
      t: "reserve",
      lease: rootLease("cancelled-root", "interactive"),
    }, verifier)).toThrow("Dequeued");
    expect(() => applyGovernorRecord(state, {
      t: "dequeue",
      workload: { kind: "control", id: "cancelled-root", attempt: 1 },
      reason: "failed",
    }, verifier)).toThrow("another reason");
  });

  it("isolates dequeue tombstones and terminal roots by workload attempt", () => {
    const state = emptyGovernorProjection();
    applyGovernorRecord(state, {
      t: "dequeue",
      workload: { kind: "control", id: "retry-root", attempt: 1 },
      reason: "failed",
    }, verifier);
    const second = rootLease("retry-root-2", "interactive", {
      workload: { kind: "control", id: "retry-root", attempt: 2 },
      scopeBinding: { kind: "control", subject: "retry-root" },
    });
    applyGovernorRecord(state, {
      t: "queued",
      reservationId: second.reservationId,
      admissionClass: second.admissionClass,
      workload: second.workload,
    }, verifier);
    applyGovernorRecord(state, { t: "reserve", lease: second }, verifier);
    applyGovernorRecord(state, { t: "release", reservationId: second.reservationId }, verifier);
    expect(() => applyGovernorRecord(state, {
      t: "dequeue",
      workload: { kind: "control", id: "retry-root", attempt: 3 },
      reason: "expired",
    }, verifier)).not.toThrow();
  });

  it("lets another class progress while a selected class is transiently occupied", () => {
    const state = emptyGovernorProjection();
    applyGovernorRecord(state, {
      t: "queued",
      reservationId: "interactive-head",
      admissionClass: "interactive",
      workload: { kind: "control", id: "interactive-head", attempt: 1 },
    }, verifier);
    applyGovernorRecord(state, {
      t: "queued",
      reservationId: "scheduler-head",
      admissionClass: "scheduler",
      workload: { kind: "control", id: "scheduler-head", attempt: 1 },
    }, verifier);
    expect(selectFairReservation(state)?.reservationId).toBe("interactive-head");
    expect(
      selectFairReservation(state, new Set(["interactive"]))?.reservationId,
    ).toBe("scheduler-head");
    applyGovernorRecord(state, {
      t: "reserve",
      lease: rootLease("scheduler-head", "scheduler"),
    }, verifier);
    expect(state.queued.has("scheduler-head")).toBe(false);
    expect(state.queued.has("interactive-head")).toBe(true);
  });

  it("requires a bounded durable usage reservation before every consume", () => {
    const state = activeRoot("root-prehold", { maxCalls: 2, maxTokens: 20 });
    expect(() => applyGovernorRecord(state, {
      t: "consume",
      usageSeq: 1,
      rootReservationId: "root-prehold",
      reservationId: "root-prehold",
      usageId: "usage-no-hold",
      calls: 1,
    }, verifier)).toThrow("durable reservation");
    applyGovernorRecord(state, {
      t: "usage-reserved",
      rootReservationId: "root-prehold",
      reservationId: "root-prehold",
      usageId: "usage-held",
      calls: 1,
      tokens: 10,
    }, verifier);
    expect(() => applyGovernorRecord(cloneGovernorProjection(state), {
      t: "consume",
      usageSeq: 1,
      rootReservationId: "root-prehold",
      reservationId: "root-prehold",
      usageId: "usage-held",
      calls: 1,
      tokens: 11,
    }, verifier)).toThrow("reservation");
    expect(() => applyGovernorRecord(cloneGovernorProjection(state), {
      t: "settle",
      reservationId: "root-prehold",
    }, verifier)).toThrow("usage reservation");
    applyGovernorRecord(state, {
      t: "consume",
      usageSeq: 1,
      rootReservationId: "root-prehold",
      reservationId: "root-prehold",
      usageId: "usage-held",
      calls: 1,
      tokens: 4,
    }, verifier);
    expect(state.reservations.get("root-prehold")).toMatchObject({
      used: { calls: 1, tokens: 4 },
      reservedUsage: { calls: 0, tokens: 0 },
    });
  });

  it("rejects child domain drift and root terminal before child release", () => {
    const state = activeRoot("root-domain", { maxCalls: 2 });
    const root = state.reservations.get("root-domain")!.lease;
    const child = childLease(root, "child-domain", 1);
    const drifted = signLease({
      ...withoutSignatureAndDigest(child),
      domain: { kind: "anchor", anchorEpoch: 2 },
    });
    expect(() =>
      applyGovernorRecord(state, { t: "reserve", lease: drifted }, verifier)
    ).toThrow("domain");
    applyGovernorRecord(state, { t: "reserve", lease: child }, verifier);
    expect(() =>
      applyGovernorRecord(state, { t: "settle", reservationId: root.reservationId }, verifier)
    ).toThrow("active child");
  });

  it("rejects unknown fields before a lease becomes active", () => {
    const lease = { ...rootLease("root-extra", "interactive"), extra: true };
    expect(() => validateReservableResourceLease(lease, verifier)).toThrow("fields");
  });

  it("validates every durable governor record as a closed discriminated union", () => {
    const lease = rootLease("root-record-contract", "interactive");
    const records: GovernorRecord[] = [
      {
        t: "queued",
        reservationId: lease.reservationId,
        admissionClass: lease.admissionClass,
        workload: lease.workload,
      },
      { t: "dequeue", workload: lease.workload, reason: "cancelled" },
      { t: "reserve", lease },
      {
        t: "usage-reserved",
        rootReservationId: lease.reservationId,
        reservationId: lease.reservationId,
        usageId: "usage-record-contract",
        calls: 1,
      },
      {
        t: "consume",
        usageSeq: 1,
        rootReservationId: lease.reservationId,
        reservationId: lease.reservationId,
        usageId: "usage-record-contract",
        calls: 1,
      },
      { t: "settle", reservationId: lease.reservationId },
      { t: "release", reservationId: lease.reservationId },
      { t: "reclaim", reservationId: lease.reservationId },
    ];

    for (const record of records) {
      expect(validateGovernorRecord(record, verifier)).toEqual(record);
      expect(() => validateGovernorRecord({ ...record, unknown: true }, verifier))
        .toThrow("fields");
      const missing = structuredClone(record) as unknown as Record<string, unknown>;
      delete missing[Object.keys(missing).find((key) => key !== "t")!];
      expect(() => validateGovernorRecord(missing, verifier)).toThrow();
    }
    expect(() => validateGovernorRecord({ t: "unknown" }, verifier)).toThrow("type");
    expect(() => validateGovernorRecord(null, verifier)).toThrow("object");

    for (const admissionClass of ADMISSION_CLASSES) {
      expect(validateGovernorRecord({
        t: "queued",
        reservationId: `reservation-${admissionClass}`,
        admissionClass,
        workload: { kind: "control", id: admissionClass, attempt: 1 },
      }, verifier)).toMatchObject({ admissionClass });
    }
    for (const admissionClass of ["invalid", "constructor", "toString", "__proto__"]) {
      expect(() => validateGovernorRecord({
        t: "queued",
        reservationId: `reservation-${admissionClass}`,
        admissionClass,
        workload: { kind: "control", id: admissionClass, attempt: 1 },
      }, verifier)).toThrow("admission class");
    }
  });

  it("rejects every invalid reservable lease variant before replay", () => {
    const bareRun = signLease({
      ...withoutSignatureAndDigest(rootLease("root-bare-run", "interactive")),
      workload: { kind: "run", id: "run-1", attempt: 1 },
      scopeBinding: { kind: "conversation", conversationId: "conversation-1", ownerEpoch: 1 },
    });
    expect(() => validateReservableResourceLease(bareRun, verifier)).toThrow(
      "Immediate resource root",
    );

    const localJob = signLease({
      ...withoutSignatureAndDigest(rootLease("root-local-job", "scheduler")),
      workload: { kind: "job", id: "job-1", attempt: 1 },
      scopeBinding: { kind: "job", taskId: "task-1", anchorEpoch: 1 },
      domain: { kind: "local", localDomainId: "local-1", localGovernorEpoch: 1 },
      activation: { kind: "assignment", assignmentId: "assignment-1" },
    });
    expect(() => validateReservableResourceLease(localJob, verifier)).toThrow(
      "Job assignment resource root",
    );

    const wrongSystemAdmission = signLease({
      ...withoutSignatureAndDigest(rootLease("root-system", "interactive")),
      workload: { kind: "job", id: "job-system", attempt: 1 },
      scopeBinding: { kind: "job", taskId: "task-system", anchorEpoch: 1 },
      activation: { kind: "system-job", jobRunId: "job-system" },
    });
    expect(() => validateReservableResourceLease(wrongSystemAdmission, verifier)).toThrow(
      "System job resource root",
    );

    const root = rootLease("root-child-audience", "interactive");
    const childWithoutExecutor = signLease({
      ...withoutSignatureAndDigest(childLease(root, "child-no-executor", 1)),
      audience: { provider: "provider-1" },
    });
    expect(() => validateReservableResourceLease(childWithoutExecutor, verifier)).toThrow(
      "executor audience",
    );

    const oversizedDelegation = rootLease("root-delegation", "interactive", {
      budget: { maxCalls: 1 },
      delegation: {
        executorId: "executor-1",
        maxDepth: 1,
        maxBudget: { maxCalls: 2 },
      },
    });
    expect(() => validateReservableResourceLease(oversizedDelegation, verifier)).toThrow(
      "delegation budget",
    );
  });
});

function activeRoot(
  reservationId: string,
  budget: ResourceLease["budget"],
) {
  const state = emptyGovernorProjection();
  const lease = rootLease(reservationId, "interactive", {
    budget,
    delegation: {
      executorId: "executor-1",
      maxDepth: 1,
      maxBudget: budget,
    },
  });
  applyGovernorRecord(state, {
    t: "queued",
    reservationId,
    admissionClass: "interactive",
    workload: lease.workload,
  }, verifier);
  applyGovernorRecord(state, { t: "reserve", lease }, verifier);
  return state;
}

function rootLease(
  reservationId: string,
  admissionClass: ResourceLease["admissionClass"],
  overrides: Partial<ResourceLease> = {},
): ReservableResourceLease {
  return signLease({
    v: 1,
    reservationId,
    admissionClass,
    workload: { kind: "control", id: reservationId, attempt: 1 },
    scopeBinding: { kind: "control", subject: reservationId },
    audience: { executorId: "executor-1" },
    budget: { maxCalls: 1 },
    domain: { kind: "anchor", anchorEpoch: 1 },
    issuedAt: NOW,
    expiry: EXPIRY,
    ...overrides,
  });
}

function childLease(
  parent: ResourceLease,
  reservationId: string,
  maxCalls: number,
): ReservableResourceLease {
  return signLease({
    v: 1,
    reservationId,
    parentId: parent.reservationId,
    parentDigest: parent.digest,
    admissionClass: parent.admissionClass,
    workload: { kind: "orchestration-node", id: reservationId, attempt: 1 },
    scopeBinding: parent.scopeBinding,
    audience: { executorId: "executor-1" },
    budget: { maxCalls },
    domain: parent.domain,
    issuedAt: NOW,
    expiry: EXPIRY,
  });
}

function signLease(
  payload: Omit<ResourceLease, "digest" | "signature"> & Record<string, unknown>,
): ReservableResourceLease {
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: signer.sign("ResourceLease", 1, withDigest),
  } as ReservableResourceLease;
}

function withoutSignatureAndDigest(lease: ResourceLease) {
  const { signature: _signature, digest: _digest, ...payload } = lease;
  return payload;
}

describe("admission enum single source and preflight validation", () => {
  it("accepts every canonical admission class and workload kind from the authoritative sets", () => {
    for (const admissionClass of ADMISSION_CLASSES) {
      const record = {
        t: "queued",
        reservationId: `rsv-${admissionClass}`,
        admissionClass,
        workload: { kind: "control", id: `work-${admissionClass}`, attempt: 1 },
      };
      expect(validateGovernorRecord(record, verifier)).toEqual(record);
    }
    for (const kind of RESOURCE_WORKLOAD_KINDS) {
      const isRootKind = kind === "run" || kind === "job" || kind === "control";
      const check = () =>
        assertResourceAdmissionRequest({ kind, id: `work-${kind}`, attempt: 1 });
      // 根准入只接受根 workload；子租约类 kind 在前置验证即拒绝
      if (isRootKind) expect(check).not.toThrow();
      else expect(check).toThrow();
    }
  });

  it("rejects prototype-chain and unknown admission classes before any reducer access", () => {
    for (const poisoned of ["constructor", "toString", "hasOwnProperty", "unknown-class"]) {
      expect(() =>
        validateGovernorRecord(
          {
            t: "queued",
            reservationId: "rsv-poisoned",
            admissionClass: poisoned,
            workload: { kind: "control", id: "work-poisoned", attempt: 1 },
          },
          verifier,
        ),
      ).toThrow();
    }
  });

  it("rejects invalid workloads and budgets in the shared preflight predicate", () => {
    expect(() =>
      assertResourceAdmissionRequest({ kind: "toString", id: "w", attempt: 1 }),
    ).toThrow();
    expect(() =>
      assertResourceAdmissionRequest({ kind: "control", id: "w", attempt: 0 }),
    ).toThrow();
    expect(() =>
      assertResourceAdmissionRequest(
        { kind: "control", id: "w", attempt: 1 },
        {},
      ),
    ).toThrow();
    expect(() =>
      assertResourceAdmissionRequest(
        { kind: "control", id: "w", attempt: 1 },
        { maxCalls: -1 },
      ),
    ).toThrow();
    expect(() =>
      assertResourceAdmissionRequest(
        { kind: "control", id: "w", attempt: 1 },
        { maxCalls: 1, maxTokens: 10 },
      ),
    ).not.toThrow();
  });

  it("validates complete assignment and system-job reservation requests before any side-effect", () => {
    const valid = {
      assignmentId: "asg-1",
      executorId: "executor-1",
      workload: { kind: "run", id: "run-1", attempt: 1 },
      scopeBinding: { kind: "conversation", conversationId: "conversation-1", ownerEpoch: 1 },
      budget: { maxCalls: 1 },
    };
    expect(() => assertAssignmentReservationRequest(valid)).not.toThrow();
    expect(() => assertAssignmentReservationRequest({ ...valid, extra: 1 })).toThrow();
    expect(() => assertAssignmentReservationRequest({ ...valid, assignmentId: "" })).toThrow();
    expect(() =>
      assertAssignmentReservationRequest({
        ...valid,
        workload: { kind: "control", id: "c", attempt: 1 },
      }),
    ).toThrow();
    expect(() =>
      assertAssignmentReservationRequest({
        ...valid,
        scopeBinding: { kind: "job", taskId: "t", anchorEpoch: 1 },
      }),
    ).toThrow();
    expect(() => assertAssignmentReservationRequest({ ...valid, budget: {} })).toThrow();

    const systemValid = {
      workload: { kind: "job", id: "jobrun-1", attempt: 1 },
      scopeBinding: { kind: "job", taskId: "task-1", anchorEpoch: 1 },
      budget: { maxTokens: 10 },
    };
    expect(() => assertSystemJobReservationRequest(systemValid)).not.toThrow();
    expect(() =>
      assertSystemJobReservationRequest({ ...systemValid, assignmentId: "asg" }),
    ).toThrow();
    expect(() =>
      assertSystemJobReservationRequest({
        ...systemValid,
        workload: { kind: "run", id: "r", attempt: 1 },
      }),
    ).toThrow();
  });

  it("returns the deadline outcome before the first attempt when already expired", async () => {
    let attempts = 0;
    const outcome = await waitForResourceAdmissionCandidate({
      attempt: async () => {
        attempts += 1;
        return "granted";
      },
      isPending: () => false,
      deadline: 100,
      monotonicClock: () => 200,
      onDeadline: () => {
        throw new Error("admission-deadline");
      },
    }).catch((error: Error) => error.message);
    expect(outcome).toBe("admission-deadline");
    expect(attempts).toBe(0);
  });
});
