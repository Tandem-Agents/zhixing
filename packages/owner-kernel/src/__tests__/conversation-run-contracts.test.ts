import { protocolDigest, type ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import { describe, expect, it } from "vitest";
import {
  assertAdmissionReplayContract,
  assertAssignmentReplayContract,
  assertAssignmentSupersededReplayContract,
  bundleAcknowledgementBindsCommitted,
  assertCancelFenceReplayContract,
  assertCancelProofAcceptedReplayContract,
  assertCapabilityRevocationReplayContract,
  assertCommittedReplayContract,
  assertConversationResolutionBinding,
  assertDispatchAcknowledgementReplayContract,
  assertDispatchConflictHandlingReplayContract,
  assertDispatchConflictReplayContract,
  assertHistoricalBundleFence,
  assertResolutionCloseAtomicReplayContract,
  assertResolutionClosureReplayContract,
  assertResolutionOpenReplayContract,
  assertStateAtomicReplayContract,
  assertStateReplayContract,
  assertSupersedeRequestReplayContract,
  assertSupersedeStartedObservationReplayContract,
  CONVERSATION_RUN_INTERNAL_RECORD_TYPES,
  CONVERSATION_RUN_RECORD_SHAPES,
  nextActiveRunIdForReplay,
  resolutionFactDigest,
  terminationProofBindsDurableSource,
  validateConversationRunInternalRecord,
  validateConversationRunRecord,
  validateResolutionFact,
  type ConversationRunInternalRecord,
  type ConversationRunRecordType,
} from "../conversation-run-contracts.js";

const verifier: ProtocolSignatureVerifier = { verify: () => undefined };

describe("conversation record shape registry", () => {
  it.each(Object.keys(CONVERSATION_RUN_RECORD_SHAPES) as ConversationRunRecordType[])(
    "rejects an unknown field for %s through the shared structural validator",
    (recordType) => {
      const shape = CONVERSATION_RUN_RECORD_SHAPES[recordType];
      const value = Object.fromEntries(shape.required.map((key) => [key, null]));
      value.t = recordType;
      value.unregistered = true;
      expect(() => validateConversationRunRecord(value, verifier)).toThrow(
        /fields are incomplete or unknown/u,
      );
    },
  );

  it("validates both internal record variants and rejects unknown internal shapes", () => {
    expect(() =>
      validateConversationRunInternalRecord({
        kind: "content-asset-index",
        entries: [
          {
            digest: `sha256:${"1".repeat(64)}`,
            bytes: 1,
            kind: "file",
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateConversationRunInternalRecord({
        kind: "conversation-commit-projection",
        assignmentId: "assignment-1",
        runId: "run-1",
        commitRevision: 1,
        digest: `sha256:${"2".repeat(64)}`,
      }),
    ).not.toThrow();
    expect(() => validateConversationRunInternalRecord({ kind: "future-record" })).toThrow(
      /unknown internal record/u,
    );
  });
});

describe("shared conversation run semantic predicates", () => {
  const cases: readonly {
    readonly name: string;
    readonly accept: () => unknown;
    readonly reject: () => unknown;
  }[] = [
    {
      name: "admission atomicity",
      accept: () =>
        assertAdmissionReplayContract({
          runAlreadyAdmitted: false,
          ingressAlreadyAdmitted: false,
          queuedPositionAlreadyUsed: false,
          hasAtomicQueuedState: true,
        }),
      reject: () =>
        assertAdmissionReplayContract({
          runAlreadyAdmitted: false,
          ingressAlreadyAdmitted: false,
          queuedPositionAlreadyUsed: false,
          hasAtomicQueuedState: false,
        }),
    },
    {
      name: "assignment current atomic head",
      accept: () =>
        assertAssignmentReplayContract({
          currentState: "queued",
          currentRevision: 1,
          runAlreadyAssigned: false,
          assignmentAlreadyKnown: false,
          isEarliestQueuedRun: true,
          hasAtomicDispatchedState: true,
        }),
      reject: () =>
        assertAssignmentReplayContract({
          currentState: "queued",
          currentRevision: 1,
          runAlreadyAssigned: false,
          assignmentAlreadyKnown: false,
          isEarliestQueuedRun: true,
          hasAtomicDispatchedState: false,
        }),
    },
    {
      name: "assignment earliest queued head",
      accept: () =>
        assertAssignmentReplayContract({
          currentState: "queued",
          currentRevision: 1,
          runAlreadyAssigned: false,
          assignmentAlreadyKnown: false,
          isEarliestQueuedRun: true,
          hasAtomicDispatchedState: true,
        }),
      reject: () =>
        assertAssignmentReplayContract({
          currentState: "queued",
          currentRevision: 1,
          runAlreadyAssigned: false,
          assignmentAlreadyKnown: false,
          isEarliestQueuedRun: false,
          hasAtomicDispatchedState: true,
        }),
    },
    {
      name: "dispatch conflict current binding",
      accept: () =>
        assertDispatchConflictReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "dispatched",
          proofBindsAssignment: true,
          handling: "acked-original",
          assignmentAcknowledged: false,
          assignmentSuperseded: false,
          assignmentClosed: false,
          conflictAlreadySeen: false,
        }),
      reject: () =>
        assertDispatchConflictReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: false,
          currentState: "dispatched",
          proofBindsAssignment: true,
          handling: "acked-original",
          assignmentAcknowledged: false,
          assignmentSuperseded: false,
          assignmentClosed: false,
          conflictAlreadySeen: false,
        }),
    },
    {
      name: "dispatch conflict duplicate acked-original",
      accept: () =>
        assertDispatchConflictReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "dispatched",
          proofBindsAssignment: true,
          handling: "acked-original",
          assignmentAcknowledged: false,
          assignmentSuperseded: false,
          assignmentClosed: false,
          conflictAlreadySeen: false,
        }),
      reject: () =>
        assertDispatchConflictReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "dispatched",
          proofBindsAssignment: true,
          handling: "acked-original",
          assignmentAcknowledged: false,
          assignmentSuperseded: false,
          assignmentClosed: false,
          conflictAlreadySeen: true,
        }),
    },
    {
      name: "dispatch conflict handling authority truth",
      accept: () =>
        assertDispatchConflictHandlingReplayContract({
          handling: "acked-original",
          acceptedMatches: true,
          conflictingMatches: false,
          atomicHandling: true,
        }),
      reject: () =>
        assertDispatchConflictHandlingReplayContract({
          handling: "acked-original",
          acceptedMatches: false,
          conflictingMatches: true,
          atomicHandling: true,
        }),
    },
    {
      name: "dispatch acknowledgement late receipt",
      accept: () =>
        assertDispatchAcknowledgementReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "running",
          alreadyAcknowledged: false,
          assignmentSuperseded: false,
          assignmentClosed: false,
        }),
      reject: () =>
        assertDispatchAcknowledgementReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "committed",
          alreadyAcknowledged: false,
          assignmentSuperseded: false,
          assignmentClosed: true,
        }),
    },
    {
      name: "supersede request fence lsn",
      accept: () =>
        assertSupersedeRequestReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "dispatched",
          requestAlreadyExists: false,
          fenceSeq: 7,
          envelopeLsn: 7,
        }),
      reject: () =>
        assertSupersedeRequestReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "dispatched",
          requestAlreadyExists: false,
          fenceSeq: 7,
          envelopeLsn: 8,
        }),
    },
    {
      name: "supersede started observation binding",
      accept: () =>
        assertSupersedeStartedObservationReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "uncertain",
          proofBindsDurableSource: true,
          observationAlreadyExists: false,
        }),
      reject: () =>
        assertSupersedeStartedObservationReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "uncertain",
          proofBindsDurableSource: false,
          observationAlreadyExists: false,
        }),
    },
    {
      name: "cancel fence lsn and atomic target",
      accept: () =>
        assertCancelFenceReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "running",
          fenceAlreadyExists: false,
          fenceSeq: 9,
          envelopeLsn: 9,
          hasAtomicTargetState: true,
        }),
      reject: () =>
        assertCancelFenceReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "running",
          fenceAlreadyExists: false,
          fenceSeq: 9,
          envelopeLsn: 9,
          hasAtomicTargetState: false,
        }),
    },
    {
      name: "accepted cancel proof binding",
      accept: () =>
        assertCancelProofAcceptedReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "cancel-requested",
          acceptanceAlreadyExists: false,
          durableStartedObserved: true,
          proofDecision: "halted",
          proofBindsDurableSource: true,
          hasAtomicCancelledState: true,
          allCapabilitiesRevoked: true,
        }),
      reject: () =>
        assertCancelProofAcceptedReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          currentState: "cancel-requested",
          acceptanceAlreadyExists: false,
          durableStartedObserved: true,
          proofDecision: "not-started",
          proofBindsDurableSource: true,
          hasAtomicCancelledState: true,
          allCapabilitiesRevoked: true,
        }),
    },
    {
      name: "supersede current binding",
      accept: () =>
        assertAssignmentSupersededReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          assignmentAlreadyClosed: false,
          currentState: "dispatched",
          durableStartedObserved: false,
          proofBindsDurableSource: true,
          proofKind: "supersede",
          hasAtomicTargetState: true,
          allCapabilitiesRevoked: true,
          hasAtomicResolutionClose: false,
          conflictOpen: false,
          hasAtomicConflictContainment: false,
        }),
      reject: () =>
        assertAssignmentSupersededReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: false,
          assignmentAlreadyClosed: false,
          currentState: "dispatched",
          durableStartedObserved: false,
          proofBindsDurableSource: true,
          proofKind: "supersede",
          hasAtomicTargetState: true,
          allCapabilitiesRevoked: true,
          hasAtomicResolutionClose: false,
          conflictOpen: false,
          hasAtomicConflictContainment: false,
        }),
    },
    {
      name: "supersede after durable started",
      accept: () =>
        assertAssignmentSupersededReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          assignmentAlreadyClosed: false,
          currentState: "dispatched",
          durableStartedObserved: false,
          proofBindsDurableSource: true,
          proofKind: "supersede",
          hasAtomicTargetState: true,
          allCapabilitiesRevoked: true,
          hasAtomicResolutionClose: false,
          conflictOpen: false,
          hasAtomicConflictContainment: false,
        }),
      reject: () =>
        assertAssignmentSupersededReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          assignmentAlreadyClosed: false,
          currentState: "dispatched",
          durableStartedObserved: true,
          proofBindsDurableSource: true,
          proofKind: "supersede",
          hasAtomicTargetState: true,
          allCapabilitiesRevoked: true,
          hasAtomicResolutionClose: false,
          conflictOpen: false,
          hasAtomicConflictContainment: false,
        }),
    },
    {
      name: "supersede cancel proof only settles uncertain",
      accept: () =>
        assertAssignmentSupersededReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          assignmentAlreadyClosed: false,
          currentState: "uncertain",
          durableStartedObserved: false,
          proofBindsDurableSource: true,
          proofKind: "cancel",
          hasAtomicTargetState: true,
          allCapabilitiesRevoked: true,
          hasAtomicResolutionClose: true,
          conflictOpen: false,
          hasAtomicConflictContainment: false,
        }),
      reject: () =>
        assertAssignmentSupersededReplayContract({
          assignmentExists: true,
          assignmentIsCurrent: true,
          assignmentAlreadyClosed: false,
          currentState: "dispatched",
          durableStartedObserved: false,
          proofBindsDurableSource: true,
          proofKind: "cancel",
          hasAtomicTargetState: true,
          allCapabilitiesRevoked: true,
          hasAtomicResolutionClose: false,
          conflictOpen: false,
          hasAtomicConflictContainment: false,
        }),
    },
    {
      name: "capability assignment binding",
      accept: () =>
        assertCapabilityRevocationReplayContract({
          assignmentExists: true,
          capabilityBelongsToAssignment: true,
          alreadyRevoked: false,
        }),
      reject: () =>
        assertCapabilityRevocationReplayContract({
          assignmentExists: true,
          capabilityBelongsToAssignment: false,
          alreadyRevoked: false,
        }),
    },
    {
      name: "state transition and assignment binding",
      accept: () =>
        assertStateReplayContract({
          currentState: "queued",
          currentRevision: 1,
          nextState: "dispatched",
          nextRevision: 2,
          assignmentId: "assignment-1",
          assignmentBindingValid: true,
          unassignedBindingValid: false,
          hasAtomicAssignment: true,
        }),
      reject: () =>
        assertStateReplayContract({
          currentState: "queued",
          currentRevision: 1,
          nextState: "dispatched",
          nextRevision: 2,
          assignmentId: "assignment-1",
          assignmentBindingValid: true,
          unassignedBindingValid: false,
          hasAtomicAssignment: false,
        }),
    },
    {
      name: "state atomic companions",
      accept: () =>
        assertStateAtomicReplayContract({
          currentState: "dispatched",
          nextState: "cancel-requested",
          hasAtomicCancelFence: true,
          hasAtomicOpenResolution: true,
          hasAtomicSupersede: true,
          hasAtomicTermination: true,
          hasAtomicResolutionClose: true,
          hasAtomicCommit: true,
        }),
      reject: () =>
        assertStateAtomicReplayContract({
          currentState: "dispatched",
          nextState: "cancel-requested",
          hasAtomicCancelFence: false,
          hasAtomicOpenResolution: true,
          hasAtomicSupersede: true,
          hasAtomicTermination: true,
          hasAtomicResolutionClose: true,
          hasAtomicCommit: true,
        }),
    },
    {
      name: "single active run",
      accept: () =>
        nextActiveRunIdForReplay({
          activeRunId: undefined,
          runId: "run-1",
          currentState: "queued",
          nextState: "dispatched",
        }),
      reject: () =>
        nextActiveRunIdForReplay({
          activeRunId: "run-2",
          runId: "run-1",
          currentState: "queued",
          nextState: "dispatched",
        }),
    },
    {
      name: "resolution authority binding",
      accept: () =>
        assertConversationResolutionBinding({
          execution: "conversation",
          conversationId: "conversation-1",
          subjectRunId: "run-1",
          recordRunId: "run-1",
          authorityConversationId: "conversation-1",
          subjectOwnerEpoch: 4,
          authorityOwnerEpoch: 4,
        }),
      reject: () =>
        assertConversationResolutionBinding({
          execution: "conversation",
          conversationId: "conversation-2",
          subjectRunId: "run-1",
          recordRunId: "run-1",
          authorityConversationId: "conversation-1",
          subjectOwnerEpoch: 4,
          authorityOwnerEpoch: 4,
        }),
    },
    {
      name: "resolution authority epoch binding",
      accept: () =>
        assertConversationResolutionBinding({
          execution: "conversation",
          conversationId: "conversation-1",
          subjectRunId: "run-1",
          recordRunId: "run-1",
          authorityConversationId: "conversation-1",
          subjectOwnerEpoch: 4,
          authorityOwnerEpoch: 4,
        }),
      reject: () =>
        assertConversationResolutionBinding({
          execution: "conversation",
          conversationId: "conversation-1",
          subjectRunId: "run-1",
          recordRunId: "run-1",
          authorityConversationId: "conversation-1",
          subjectOwnerEpoch: 5,
          authorityOwnerEpoch: 4,
        }),
    },
    {
      name: "resolution open lifecycle",
      accept: () =>
        assertResolutionOpenReplayContract({
          assignmentExists: true,
          assignmentBindsRun: true,
          assignmentIsCurrent: true,
          currentState: "running",
          alreadyOpen: false,
          cause: "ledger-unknown",
          hasAtomicUncertainState: true,
          hasAtomicDispatchConflict: false,
        }),
      reject: () =>
        assertResolutionOpenReplayContract({
          assignmentExists: true,
          assignmentBindsRun: true,
          assignmentIsCurrent: true,
          currentState: "running",
          alreadyOpen: true,
          cause: "ledger-unknown",
          hasAtomicUncertainState: true,
          hasAtomicDispatchConflict: false,
        }),
    },
    {
      name: "resolution current closure",
      accept: () =>
        assertResolutionClosureReplayContract({
          assignmentExists: true,
          assignmentBindsRun: true,
          assignmentIsCurrentOrAtomicallyClosed: true,
          conflictOpen: false,
          resolutionKind: "late-bundle-committed",
        }),
      reject: () =>
        assertResolutionClosureReplayContract({
          assignmentExists: true,
          assignmentBindsRun: true,
          assignmentIsCurrentOrAtomicallyClosed: false,
          conflictOpen: false,
          resolutionKind: "late-bundle-committed",
        }),
    },
    {
      name: "resolution close atomicity and cause-kind binding",
      accept: () =>
        assertResolutionCloseAtomicReplayContract({
          cause: "ledger-unknown",
          kind: "late-bundle-committed",
          existingOpenMatches: true,
          hasAtomicTargetState: true,
          allCapabilitiesRevoked: true,
          hasRequiredCompanion: true,
        }),
      reject: () =>
        assertResolutionCloseAtomicReplayContract({
          cause: "dispatch-conflict",
          kind: "late-bundle-committed",
          existingOpenMatches: true,
          hasAtomicTargetState: true,
          allCapabilitiesRevoked: true,
          hasRequiredCompanion: true,
        }),
    },
    {
      name: "committed atomic closure",
      accept: () =>
        assertCommittedReplayContract({
          assignmentExists: true,
          assignmentBindsRun: true,
          assignmentIsCurrent: true,
          currentState: "running",
          alreadyCommitted: false,
          conflictOpen: false,
          commitRevisionMatchesAssignedBase: true,
          hasAtomicCommittedState: true,
          allCapabilitiesRevoked: true,
        }),
      reject: () =>
        assertCommittedReplayContract({
          assignmentExists: true,
          assignmentBindsRun: true,
          assignmentIsCurrent: true,
          currentState: "running",
          alreadyCommitted: false,
          conflictOpen: true,
          commitRevisionMatchesAssignedBase: true,
          hasAtomicCommittedState: true,
          allCapabilitiesRevoked: true,
        }),
    },
    {
      name: "committed assigned base revision binding",
      accept: () =>
        assertCommittedReplayContract({
          assignmentExists: true,
          assignmentBindsRun: true,
          assignmentIsCurrent: true,
          currentState: "running",
          alreadyCommitted: false,
          conflictOpen: false,
          commitRevisionMatchesAssignedBase: true,
          hasAtomicCommittedState: true,
          allCapabilitiesRevoked: true,
        }),
      reject: () =>
        assertCommittedReplayContract({
          assignmentExists: true,
          assignmentBindsRun: true,
          assignmentIsCurrent: true,
          currentState: "running",
          alreadyCommitted: false,
          conflictOpen: false,
          commitRevisionMatchesAssignedBase: false,
          hasAtomicCommittedState: true,
          allCapabilitiesRevoked: true,
        }),
    },
    {
      name: "historical bundle assignment fence",
      accept: () =>
        assertHistoricalBundleFence({
          assignedExecutorId: "executor-1",
          assignedOwnerEpoch: 4,
          assignedBaseRevision: 6,
          bundleExecutorId: "executor-1",
          bundleOwnerEpoch: 4,
          bundleBaseRevision: 6,
          conflictOpen: false,
        }),
      reject: () =>
        assertHistoricalBundleFence({
          assignedExecutorId: "executor-1",
          assignedOwnerEpoch: 4,
          assignedBaseRevision: 6,
          bundleExecutorId: "executor-2",
          bundleOwnerEpoch: 4,
          bundleBaseRevision: 6,
          conflictOpen: false,
        }),
    },
    {
      name: "historical bundle fence wrong assigned base",
      accept: () =>
        assertHistoricalBundleFence({
          assignedExecutorId: "executor-1",
          assignedOwnerEpoch: 4,
          assignedBaseRevision: 6,
          bundleExecutorId: "executor-1",
          bundleOwnerEpoch: 4,
          bundleBaseRevision: 6,
          conflictOpen: false,
        }),
      reject: () =>
        assertHistoricalBundleFence({
          assignedExecutorId: "executor-1",
          assignedOwnerEpoch: 4,
          assignedBaseRevision: 6,
          bundleExecutorId: "executor-1",
          bundleOwnerEpoch: 4,
          bundleBaseRevision: 5,
          conflictOpen: false,
        }),
    },
    {
      name: "historical bundle fence open conflict",
      accept: () =>
        assertHistoricalBundleFence({
          assignedExecutorId: "executor-1",
          assignedOwnerEpoch: 4,
          assignedBaseRevision: 6,
          bundleExecutorId: "executor-1",
          bundleOwnerEpoch: 4,
          bundleBaseRevision: 6,
          conflictOpen: false,
        }),
      reject: () =>
        assertHistoricalBundleFence({
          assignedExecutorId: "executor-1",
          assignedOwnerEpoch: 4,
          assignedBaseRevision: 6,
          bundleExecutorId: "executor-1",
          bundleOwnerEpoch: 4,
          bundleBaseRevision: 6,
          conflictOpen: true,
        }),
    },
  ];

  it.each(cases)("accepts and rejects the same $name predicate", ({ accept, reject }) => {
    expect(accept).not.toThrow();
    expect(reject).toThrow();
  });

  it("binds bundle acknowledgement identity across both execution domains", () => {
    const expectedBundleRef = {
      digest: `sha256:${"4".repeat(64)}`,
      bytes: 128,
    };
    expect(
      bundleAcknowledgementBindsCommitted({
        observedBundleRef: expectedBundleRef,
        observedCommitRevision: 7,
        expectedBundleRef,
        expectedCommitRevision: 7,
      }),
    ).toBe(true);
    expect(
      bundleAcknowledgementBindsCommitted({
        observedBundleRef: {
          digest: `sha256:${"5".repeat(64)}`,
          bytes: 128,
        },
        observedCommitRevision: 7,
        expectedBundleRef,
        expectedCommitRevision: 7,
      }),
    ).toBe(false);
    expect(
      bundleAcknowledgementBindsCommitted({
        observedBundleRef: expectedBundleRef,
        observedCommitRevision: 8,
        expectedBundleRef,
        expectedCommitRevision: 7,
      }),
    ).toBe(false);
    expect(
      bundleAcknowledgementBindsCommitted({
        observedBundleRef: undefined,
        observedCommitRevision: undefined,
        expectedBundleRef,
        expectedCommitRevision: 7,
      }),
    ).toBe(false);
  });

  it("binds every termination proof kind to its durable source", () => {
    const base = {
      assignmentId: "assignment-1",
      executorId: "executor-1",
      conversationId: "conversation-1",
      ownerEpoch: 4,
      dispatchDigest: `sha256:${"3".repeat(64)}`,
      supersedeRequest: { fenceSeq: 7, requestId: "request-1" },
      cancelFence: { fenceSeq: 9, requestId: "request-2" },
      abortTicketProofBindsDurableSource: false,
    } as const;
    const rejection = {
      assignmentId: "assignment-1",
      executorId: "executor-1",
      dispatchDigest: base.dispatchDigest,
    } as never;
    expect(terminationProofBindsDurableSource({ ...base, proof: rejection })).toBe(true);
    expect(
      terminationProofBindsDurableSource({
        ...base,
        proof: { ...rejection, dispatchDigest: `sha256:${"4".repeat(64)}` } as never,
      }),
    ).toBe(false);

    const supersede = {
      assignmentId: "assignment-1",
      executorId: "executor-1",
      decision: "not-started-fenced",
      fence: { fenceSeq: 7, requestId: "request-1" },
    } as never;
    expect(terminationProofBindsDurableSource({ ...base, proof: supersede })).toBe(true);
    expect(
      terminationProofBindsDurableSource({
        ...base,
        supersedeRequest: { fenceSeq: 8, requestId: "request-1" },
        proof: supersede,
      }),
    ).toBe(false);

    const ownerFenceHalted = {
      assignmentId: "assignment-1",
      executorId: "executor-1",
      decision: "halted",
      cause: "owner-fence",
      authority: {
        execution: "conversation",
        conversationId: "conversation-1",
        ownerEpoch: 4,
      },
      fence: { fenceSeq: 9, requestId: "request-2" },
    } as never;
    expect(
      terminationProofBindsDurableSource({ ...base, proof: ownerFenceHalted }),
    ).toBe(true);
    expect(
      terminationProofBindsDurableSource({
        ...base,
        ownerEpoch: 5,
        proof: ownerFenceHalted,
      }),
    ).toBe(false);
    expect(
      terminationProofBindsDurableSource({
        ...base,
        cancelFence: undefined,
        proof: ownerFenceHalted,
      }),
    ).toBe(false);

    const abortTicketNotStarted = {
      assignmentId: "assignment-1",
      executorId: "executor-1",
      decision: "not-started",
      cause: "abort-ticket",
      authority: {
        execution: "conversation",
        conversationId: "conversation-1",
        ownerEpoch: 4,
      },
    } as never;
    expect(
      terminationProofBindsDurableSource({ ...base, proof: abortTicketNotStarted }),
    ).toBe(false);
    expect(
      terminationProofBindsDurableSource({
        ...base,
        abortTicketProofBindsDurableSource: true,
        proof: abortTicketNotStarted,
      }),
    ).toBe(true);
    expect(
      terminationProofBindsDurableSource({
        ...base,
        conversationId: "conversation-2",
        proof: abortTicketNotStarted,
      }),
    ).toBe(false);
  });

  it("mechanically binds both open and decision digests", () => {
    const subject = {
      execution: "conversation" as const,
      conversationId: "conversation-1",
      runId: "run-1",
      ownerEpoch: 4,
      assignmentId: "assignment-1",
    };
    const openedAt = "2026-07-15T00:00:00.000Z";
    const cause = "ledger-unknown" as const;
    const openFactDigest = protocolDigest("UncertainOpenFact", 1, {
      subject,
      openedAt,
      cause,
    });
    const at = "2026-07-15T00:00:01.000Z";
    const fact = {
      subject,
      openedAt,
      cause,
      openFactDigest,
      resolution: {
        kind: "user-abandoned" as const,
        by: "user-1",
        at,
        factDigest: resolutionFactDigest(openFactDigest, "user-abandoned", "user-1", at),
      },
    };
    expect(validateResolutionFact(fact)).toEqual(fact);
    expect(() =>
      validateResolutionFact({
        ...fact,
        openFactDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow(/open digest is invalid/u);
  });
});
