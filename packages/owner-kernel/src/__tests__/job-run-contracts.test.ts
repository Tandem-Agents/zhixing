import type { SystemJobFence, TaskDefinition } from "@zhixing/core/contracts";
import {
  type ProtocolSignatureVerifier,
  systemJobParamsDigest,
} from "@zhixing/core/protocol";
import { describe, expect, it } from "vitest";
import {
  assertJobAdmissionReplayContract,
  assertJobConflictContainmentReplayContract,
  assertJobOccurrenceReplayContract,
  assertJobStateReplayContract,
  assertSystemJobActivationReplayContract,
  assertSystemJobDefinitionReplayContract,
  assertSystemMissCoalescedReplayContract,
  assertSystemJobTerminalReplayContract,
  assertTaskRevisionReplayContract,
  isValidJobTransition,
  JOB_JOURNAL_RECORD_SHAPES,
  registerPendingSystemMiss,
  taskRevisionReplayViolation,
  validateJobJournalRecord,
  type JobJournalRecordType,
} from "../job-run-contracts.js";

const verifier: ProtocolSignatureVerifier = {
  verify() {},
};

describe("job record shape registry", () => {
  it.each(Object.keys(JOB_JOURNAL_RECORD_SHAPES) as JobJournalRecordType[])(
    "rejects an unknown field for %s through the authoritative shape registry",
    (recordType) => {
      const shape = JOB_JOURNAL_RECORD_SHAPES[recordType];
      const value = Object.fromEntries(shape.required.map((key) => [key, null]));
      value.t = recordType;
      value.unregistered = true;
      expect(() => validateJobJournalRecord(value, verifier)).toThrow(/unknown/u);
    },
  );
});

describe("job replay contracts", () => {
  const systemFence: SystemJobFence = {
    taskId: "task-1",
    jobRunId: "job-run-1",
    scheduledFor: "2026-07-15T09:00:00.000Z",
    taskRevision: 1,
    anchorEpoch: 3,
    handler: "__journal-gc",
    paramsDigest: `sha256:${"1".repeat(64)}`,
    reservationId: "system-reservation-1",
    attempt: 1,
  };
  const validOccurrence = {
    taskIdMatches: true,
    definitionPresent: true,
    definitionState: "enabled" as const,
    definitionRevisionMatches: true,
    definitionKind: "user" as const,
    identifierUnused: true,
    occurrenceState: "queued" as const,
    activeState: undefined,
    hasAtomicAdmission: true,
    hasAtomicOfflineMissPolicy: false,
  };
  const validTaskRevision = {
    taskIdMatches: true,
    taskRevision: 2,
    state: "enabled" as const,
    kind: "user" as const,
    previousRevision: 1,
    previousState: "enabled" as const,
    previousKind: "user" as const,
    activeState: undefined,
    hasAtomicQueuedCancellation: false,
    hasAtomicAssignedCancellation: false,
    hasExistingCancelFence: false,
    hasAtomicUncertainFence: false,
  };

  it.each([
    ["different-task", { taskIdMatches: false }],
    ["first-revision", { previousRevision: undefined, previousState: undefined, previousKind: undefined }],
    ["deleted-resurrection", { previousState: "deleted" as const }],
    ["noncontiguous-revision", { taskRevision: 3 }],
    ["missing-previous-kind", { previousKind: undefined }],
    ["kind-change", { kind: "system" as const }],
    [
      "missing-queued-cancellation",
      { state: "disabled" as const, activeState: "queued" as const },
    ],
    [
      "missing-assigned-cancellation",
      { state: "deleted" as const, activeState: "running" as const },
    ],
    [
      "missing-uncertain-cancellation",
      { state: "deleted" as const, activeState: "uncertain" as const },
    ],
  ] as const)("rejects task revision replay with %s", (reason, override) => {
    const input = { ...validTaskRevision, ...override };
    expect(taskRevisionReplayViolation(input)).toBe(reason);
    expect(() => assertTaskRevisionReplayContract(input)).toThrow(reason);
  });

  it("accepts task revision creation and both atomic stopping shapes", () => {
    expect(() =>
      assertTaskRevisionReplayContract({
        ...validTaskRevision,
        taskRevision: 1,
        previousRevision: undefined,
        previousState: undefined,
        previousKind: undefined,
      }),
    ).not.toThrow();
    expect(() =>
      assertTaskRevisionReplayContract({
        ...validTaskRevision,
        state: "disabled",
        activeState: "queued",
        hasAtomicQueuedCancellation: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertTaskRevisionReplayContract({
        ...validTaskRevision,
        state: "deleted",
        activeState: "running",
        hasAtomicAssignedCancellation: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertTaskRevisionReplayContract({
        ...validTaskRevision,
        state: "deleted",
        activeState: "uncertain",
        hasAtomicUncertainFence: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertTaskRevisionReplayContract({
        ...validTaskRevision,
        state: "deleted",
        activeState: "uncertain",
        hasExistingCancelFence: true,
      }),
    ).not.toThrow();
  });

  it.each([
    ["disabled definition", { definitionState: "disabled" as const }],
    ["stale definition revision", { definitionRevisionMatches: false }],
    ["reused occurrence identity", { identifierUnused: false }],
    ["missing admission", { hasAtomicAdmission: false }],
    [
      "user miss while queued",
      { occurrenceState: "missed" as const, activeState: "queued" as const },
    ],
  ])("rejects an occurrence with %s", (_name, override) => {
    expect(() =>
      assertJobOccurrenceReplayContract({ ...validOccurrence, ...override }),
    ).toThrow();
  });

  it("accepts the two valid occurrence admission shapes", () => {
    expect(() => assertJobOccurrenceReplayContract(validOccurrence)).not.toThrow();
    expect(() =>
      assertJobOccurrenceReplayContract({
        ...validOccurrence,
        occurrenceState: "missed",
        activeState: "running",
        hasAtomicAdmission: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertJobOccurrenceReplayContract({
        ...validOccurrence,
        occurrenceState: "missed",
        activeState: undefined,
        hasAtomicAdmission: false,
        hasAtomicOfflineMissPolicy: true,
      }),
    ).not.toThrow();
  });

  const validTimedAdmission = {
    taskIdMatches: true,
    occurrencePresent: true,
    scheduleMatches: true,
    occurrenceState: "queued" as const,
    definitionKind: "user" as const,
    admissionAlreadyExists: false,
    ingressPresent: false,
    hasAtomicManualControlResult: false,
  };

  it("accepts only source-consistent job admissions", () => {
    expect(() => assertJobAdmissionReplayContract(validTimedAdmission)).not.toThrow();
    expect(() =>
      assertJobAdmissionReplayContract({
        ...validTimedAdmission,
        ingressPresent: true,
        hasAtomicManualControlResult: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertJobAdmissionReplayContract({
        ...validTimedAdmission,
        definitionKind: "system",
      }),
    ).not.toThrow();
  });

  it.each([
    ["surface ingress without control", { ingressPresent: true }],
    ["control without durable ingress", { hasAtomicManualControlResult: true }],
    [
      "system surface origin",
      {
        definitionKind: "system" as const,
        ingressPresent: true,
        hasAtomicManualControlResult: true,
      },
    ],
    ["missing definition kind", { definitionKind: undefined }],
  ])("rejects an admission with %s", (_name, override) => {
    expect(() =>
      assertJobAdmissionReplayContract({ ...validTimedAdmission, ...override }),
    ).toThrow();
  });

  const validSystemMissAlias = {
    definitionKind: "system" as const,
    requestedIdentifierUnused: true,
    pendingMatchesCoalesced: true,
    coalescedState: "missed" as const,
    activeState: "running" as const,
  };

  it.each([
    ["user definition", { definitionKind: "user" as const }],
    ["reused requested identity", { requestedIdentifierUnused: false }],
    ["wrong pending occurrence", { pendingMatchesCoalesced: false }],
    ["non-missed coalesced occurrence", { coalescedState: "queued" as const }],
    ["missing active occurrence", { activeState: undefined }],
    ["terminal active occurrence", { activeState: "committed" as const }],
  ])("rejects a coalesced system miss with %s", (_name, override) => {
    expect(() =>
      assertSystemMissCoalescedReplayContract({
        ...validSystemMissAlias,
        ...override,
      }),
    ).toThrow("alias is invalid");
  });

  it("shares the pending system-miss slot across replay projections", () => {
    expect(
      registerPendingSystemMiss({
        currentPendingJobRunId: undefined,
        jobRunId: "miss-1",
        definitionKind: "system",
        occurrenceState: "missed",
      }),
    ).toBe("miss-1");
    expect(() =>
      registerPendingSystemMiss({
        currentPendingJobRunId: "miss-1",
        jobRunId: "miss-2",
        definitionKind: "system",
        occurrenceState: "missed",
      }),
    ).toThrow("more than one coalesced miss");
  });

  it("keeps system definitions out of the assignment data plane in every reducer", () => {
    expect(() =>
      assertJobStateReplayContract({
        currentState: "queued",
        currentRevision: 1,
        nextState: "dispatched",
        nextRevision: 2,
        assignmentId: "assignment-1",
        assignmentBindingValid: true,
        systemFencePresent: false,
        definitionKind: "system",
        hasAtomicAssignment: true,
        hasAtomicSystemActivation: false,
        hasAtomicSystemResult: false,
      }),
    ).toThrow("assignment data plane");

    expect(() =>
      assertJobStateReplayContract({
        currentState: "queued",
        currentRevision: 1,
        nextState: "dispatched",
        nextRevision: 2,
        assignmentId: "assignment-1",
        assignmentBindingValid: true,
        systemFencePresent: false,
        definitionKind: "user",
        hasAtomicAssignment: true,
        hasAtomicSystemActivation: false,
        hasAtomicSystemResult: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertJobStateReplayContract({
        currentState: "queued",
        currentRevision: 1,
        nextState: "running",
        nextRevision: 2,
        assignmentId: undefined,
        assignmentBindingValid: false,
        systemFencePresent: true,
        definitionKind: "system",
        hasAtomicAssignment: false,
        hasAtomicSystemActivation: true,
        hasAtomicSystemResult: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertJobStateReplayContract({
        currentState: "queued",
        currentRevision: 1,
        nextState: "running",
        nextRevision: 2,
        assignmentId: undefined,
        assignmentBindingValid: false,
        systemFencePresent: true,
        definitionKind: "user",
        hasAtomicAssignment: false,
        hasAtomicSystemActivation: true,
        hasAtomicSystemResult: false,
      }),
    ).toThrow("lacks assignment identity");

    expect(() =>
      assertJobStateReplayContract({
        currentState: "queued",
        currentRevision: 1,
        nextState: "expired",
        nextRevision: 2,
        assignmentId: undefined,
        assignmentBindingValid: false,
        systemFencePresent: false,
        definitionKind: undefined,
        hasAtomicAssignment: false,
        hasAtomicSystemActivation: false,
        hasAtomicSystemResult: false,
      }),
    ).toThrow("no task definition kind");
  });

  const validSystemActivation = {
    taskId: "task-1",
    jobRunId: "job-run-1",
    anchorEpoch: 3,
    definitionKind: "system" as const,
    occurrence: {
      scheduledFor: "2026-07-15T09:00:00.000Z",
      taskRevision: 1,
    },
    currentState: "queued" as const,
    previousFence: undefined,
    fence: systemFence,
    hasForeignRecords: true,
    hasAtomicRunningState: true,
  };

  const systemDefinition: TaskDefinition = {
    taskId: "task-1",
    taskRevision: 1,
    definition: {
      kind: "system",
      handler: "__journal-gc",
      params: { retainDays: 30 },
    },
    state: "enabled",
  };
  const definitionFence: SystemJobFence = {
    ...systemFence,
    paramsDigest: systemJobParamsDigest(systemDefinition.definition.params),
  };

  it.each([
    ["handler", { handler: "__artifact-gc" }],
    ["params digest", { paramsDigest: `sha256:${"2".repeat(64)}` }],
  ])("rejects a system fence with a mismatched definition %s", (_name, override) => {
    expect(() =>
      assertSystemJobDefinitionReplayContract({
        definition: systemDefinition,
        fence: { ...definitionFence, ...override },
      }),
    ).toThrow("task definition");
  });

  it("accepts a system fence bound to the complete definition", () => {
    expect(() =>
      assertSystemJobDefinitionReplayContract({
        definition: systemDefinition,
        fence: definitionFence,
      }),
    ).not.toThrow();
  });

  it.each([
    ["user definition", { definitionKind: "user" as const }],
    ["wrong occurrence", { occurrence: { ...validSystemActivation.occurrence, taskRevision: 2 } }],
    ["wrong pre-state", { currentState: "dispatched" as const }],
    ["wrong first attempt", { fence: { ...systemFence, attempt: 2 } }],
    ["missing resource records", { hasForeignRecords: false }],
    ["missing atomic running state", { hasAtomicRunningState: false }],
  ])("rejects system activation with %s", (_name, override) => {
    expect(() =>
      assertSystemJobActivationReplayContract({
        ...validSystemActivation,
        ...override,
      }),
    ).toThrow();
  });

  it("accepts only a contiguous replacement system attempt", () => {
    const replacement = {
      ...validSystemActivation,
      currentState: "running" as const,
      previousFence: systemFence,
      fence: {
        ...systemFence,
        reservationId: "system-reservation-2",
        attempt: 2,
      },
      hasAtomicRunningState: false,
    };
    expect(() =>
      assertSystemJobActivationReplayContract(replacement),
    ).not.toThrow();
    expect(() =>
      assertSystemJobActivationReplayContract({
        ...replacement,
        fence: { ...replacement.fence, attempt: 3 },
      }),
    ).toThrow("current attempt");
  });

  const validSystemTerminal = {
    jobRunId: "job-run-1",
    definitionKind: "system" as const,
    currentState: "running" as const,
    currentFence: systemFence,
    resultFence: systemFence,
    resultAlreadyExists: false,
    hasForeignRecords: true,
    hasAtomicTerminalState: true,
  };

  it.each([
    ["user definition", { definitionKind: "user" as const }],
    ["wrong pre-state", { currentState: "queued" as const }],
    ["wrong fence", { resultFence: { ...systemFence, reservationId: "other" } }],
    ["duplicate result", { resultAlreadyExists: true }],
    ["missing resource records", { hasForeignRecords: false }],
    ["missing terminal state", { hasAtomicTerminalState: false }],
  ])("rejects system terminal result with %s", (_name, override) => {
    expect(() =>
      assertSystemJobTerminalReplayContract({
        ...validSystemTerminal,
        ...override,
      }),
    ).toThrow();
  });

  const completeContainment = {
    proofDecision: "not-started" as const,
    conflictOpen: true,
    hasAtomicSupersedeWithSameProof: true,
    hasAtomicResolutionClose: true,
    hasAtomicTargetState: true,
    allCapabilitiesRevoked: true,
  };

  it.each([
    ["same-proof supersede", { hasAtomicSupersedeWithSameProof: false }],
    ["resolution close", { hasAtomicResolutionClose: false }],
    ["target state", { hasAtomicTargetState: false }],
    ["capability revocation", { allCapabilitiesRevoked: false }],
  ])("rejects not-started conflict containment without its %s", (_name, override) => {
    expect(() =>
      assertJobConflictContainmentReplayContract({
        ...completeContainment,
        ...override,
      }),
    ).toThrow("atomic closure");
  });

  it("accepts halted containment without not-started closure companions", () => {
    expect(() =>
      assertJobConflictContainmentReplayContract({
        proofDecision: "halted",
        conflictOpen: true,
        hasAtomicSupersedeWithSameProof: false,
        hasAtomicResolutionClose: false,
        hasAtomicTargetState: false,
        allCapabilitiesRevoked: false,
      }),
    ).not.toThrow();
  });

  it("rejects already-started supersede proof as conflict containment", () => {
    expect(() =>
      validateJobJournalRecord(
        {
          t: "dispatch-conflict-contained",
          assignmentId: "assignment-1",
          openFactDigest: `sha256:${"0".repeat(64)}`,
          proof: {
            v: 1,
            assignmentId: "assignment-1",
            executorId: "executor-1",
            fence: { fenceSeq: 1, requestId: "supersede-1" },
            decision: "already-started",
            lastRecordSeq: 1,
            ledgerDigest: `sha256:${"1".repeat(64)}`,
            signature: { alg: "test", keyId: "test", sig: "test" },
          },
        },
        verifier,
      ),
    ).toThrow("Already-started proof");
  });
});

describe("user assigned state edge closure", () => {
  const STATES = [
    "queued",
    "dispatched",
    "running",
    "cancel-requested",
    "uncertain",
    "committed",
    "cancelled",
    "failed",
    "expired",
    "missed",
  ] as const;
  const USER_ASSIGNED_LEGAL: Readonly<Record<string, readonly string[]>> = {
    queued: ["dispatched"],
    dispatched: [
      "running",
      "cancel-requested",
      "committed",
      "uncertain",
      "queued",
      "cancelled",
    ],
    running: ["cancel-requested", "committed", "cancelled", "uncertain"],
    "cancel-requested": ["cancelled", "committed", "uncertain"],
    uncertain: ["queued", "committed", "cancelled", "failed"],
  };

  it("accepts exactly the per-domain assigned edge set over the full cartesian space", () => {
    for (const current of STATES) {
      for (const next of STATES) {
        const attempt = () =>
          assertJobStateReplayContract({
            currentState: current,
            currentRevision: 3,
            nextState: next,
            nextRevision: 4,
            assignmentId: "asg-closure",
            assignmentBindingValid: true,
            systemFencePresent: false,
            definitionKind: "user",
            hasAtomicAssignment: true,
            hasAtomicSystemActivation: false,
            hasAtomicSystemResult: false,
          });
        const legal = (USER_ASSIGNED_LEGAL[current] ?? []).includes(next);
        if (legal) {
          expect(attempt, `${current} -> ${next}`).not.toThrow();
          expect(isValidJobTransition(current, next), `${current} -> ${next}`).toBe(true);
        } else {
          expect(attempt, `${current} -> ${next}`).toThrow();
        }
      }
    }
  });

  it("keeps the unassigned user edges to queued terminal closures only", () => {
    for (const next of ["cancelled", "failed", "expired"] as const) {
      expect(() =>
        assertJobStateReplayContract({
          currentState: "queued",
          currentRevision: 1,
          nextState: next,
          nextRevision: 2,
          assignmentId: undefined,
          assignmentBindingValid: false,
          systemFencePresent: false,
          definitionKind: "user",
          hasAtomicAssignment: true,
          hasAtomicSystemActivation: false,
          hasAtomicSystemResult: false,
        }),
      ).not.toThrow();
    }
    expect(() =>
      assertJobStateReplayContract({
        currentState: "dispatched",
        currentRevision: 2,
        nextState: "running",
        nextRevision: 3,
        assignmentId: undefined,
        assignmentBindingValid: false,
        systemFencePresent: false,
        definitionKind: "user",
        hasAtomicAssignment: true,
        hasAtomicSystemActivation: false,
        hasAtomicSystemResult: false,
      }),
    ).toThrow("lacks assignment identity");
  });

  it("rejects an assigned user transition that carries a system fence", () => {
    expect(() =>
      assertJobStateReplayContract({
        currentState: "dispatched",
        currentRevision: 2,
        nextState: "running",
        nextRevision: 3,
        assignmentId: "asg-closure",
        assignmentBindingValid: true,
        systemFencePresent: true,
        definitionKind: "user",
        hasAtomicAssignment: true,
        hasAtomicSystemActivation: false,
        hasAtomicSystemResult: false,
      }),
    ).toThrow("system fence");
  });
});
