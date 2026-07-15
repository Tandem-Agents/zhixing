import { protocolDigest, type ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import { describe, expect, it } from "vitest";
import {
  assertAdmissionReplayContract,
  assertAssignmentReplayContract,
  assertAssignmentSupersededReplayContract,
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

const CONTRACT_IDS = [
  "record.closed-structure",
  "record.nested-protocol-validation",
  "admission.atomic-queued",
  "assignment.atomic-current-head",
  "ack.current-active-binding",
  "conflict.current-assignment-binding",
  "conflict.handling-authority-truth",
  "supersede.current-assignment-binding",
  "supersede.request-fence-lsn",
  "supersede.started-observation-binding",
  "cancel.fence-lsn-atomic-target",
  "cancel.accepted-proof-binding",
  "termination.durable-source-binding",
  "capability.assignment-binding",
  "state.transition-assignment-binding",
  "state.atomic-companions",
  "state.single-active-run",
  "resolution.authority-binding",
  "resolution.open-lifecycle",
  "resolution.close-lifecycle",
  "commit.atomic-closure",
  "bundle.historical-assignment-fence",
  "internal.closed-structure",
  "producer.authoritative-envelope",
  "reducer.shared-contract-predicate",
  "guard.inline-fact-projection",
  "recovery.same-authoritative-reducer",
  "test.parameterized-adversarial",
] as const;

type ContractId = (typeof CONTRACT_IDS)[number];
type CoverageRecordType =
  | ConversationRunRecordType
  | ConversationRunInternalRecord["kind"];
type MatrixColumn =
  | "onlineProducer"
  | "fullReducer"
  | "lightweightGuard"
  | "recoveryConsumer"
  | "adversarialTest";
type MatrixCell =
  | {
      readonly status: "implemented";
      readonly contracts: readonly ContractId[];
      readonly evidence: string;
    }
  | { readonly status: "not-applicable"; readonly reason: string };
type MatrixRow = Readonly<Record<MatrixColumn, MatrixCell>>;

const implemented = (
  contracts: readonly ContractId[],
  evidence: string,
): MatrixCell => ({ status: "implemented", contracts, evidence });
const notApplicable = (reason: string): MatrixCell => ({
  status: "not-applicable",
  reason,
});

const guardStructural = implemented(
  ["record.closed-structure", "guard.inline-fact-projection"],
  "submission guard validates the shared record structure; this record never mutates the guard authorization projection",
);

const guardSemantic = (
  contracts: readonly ContractId[],
  evidence: string,
): MatrixCell =>
  implemented(
    ["record.closed-structure", "guard.inline-fact-projection", ...contracts],
    evidence,
  );

function runRecordRow(
  contracts: readonly ContractId[],
  lightweightGuard: MatrixCell,
): MatrixRow {
  return {
    onlineProducer: implemented(
      ["producer.authoritative-envelope", ...contracts],
      "authoritative transaction emits the record in one CommitEnvelope",
    ),
    fullReducer: implemented(
      ["record.closed-structure", "reducer.shared-contract-predicate", ...contracts],
      "full run reducer applies shared structure and applicable semantic predicates",
    ),
    lightweightGuard,
    recoveryConsumer: implemented(
      ["recovery.same-authoritative-reducer", ...contracts],
      "restart replay uses the same full reducer and shared predicates",
    ),
    adversarialTest: implemented(
      ["test.parameterized-adversarial", "record.closed-structure", ...contracts],
      "this matrix test plus assignment-ledger replay corruption scenarios",
    ),
  };
}

const CONTRACT_EXECUTION_MATRIX = {
  admitted: runRecordRow(
    ["admission.atomic-queued"],
    guardSemantic(
      ["admission.atomic-queued"],
      "guard reducer applies the shared admission predicate over inline queue facts",
    ),
  ),
  assigned: runRecordRow(
    ["assignment.atomic-current-head"],
    guardSemantic(
      ["assignment.atomic-current-head"],
      "guard reducer applies the shared assignment predicate and keeps the full assigned snapshot (ownerEpoch/baseRevision/dispatchDigest) for zero-artifact fences",
    ),
  ),
  "dispatch-acked": runRecordRow(
    ["ack.current-active-binding"],
    guardSemantic(
      ["ack.current-active-binding"],
      "guard reducer applies the shared acknowledgement predicate and records the acked flag",
    ),
  ),
  "dispatch-conflict": runRecordRow(
    [
      "record.nested-protocol-validation",
      "conflict.current-assignment-binding",
      "conflict.handling-authority-truth",
    ],
    guardSemantic(
      [
        "conflict.current-assignment-binding",
        "conflict.handling-authority-truth",
      ],
      "guard reducer rebuilds the expected activation from the assigned snapshot binding and applies both shared conflict predicates without artifact reads",
    ),
  ),
  "dispatch-conflict-contained": runRecordRow(
    ["record.nested-protocol-validation", "termination.durable-source-binding"],
    guardStructural,
  ),
  "assignment-superseded": runRecordRow(
    [
      "record.nested-protocol-validation",
      "supersede.current-assignment-binding",
      "termination.durable-source-binding",
    ],
    guardSemantic(
      [
        "supersede.current-assignment-binding",
        "termination.durable-source-binding",
      ],
      "guard reducer verifies durable-started, proof source binding and atomic closure before dropping the current mapping",
    ),
  ),
  "supersede-requested": runRecordRow(
    ["supersede.request-fence-lsn"],
    guardSemantic(
      ["supersede.request-fence-lsn"],
      "guard reducer applies the shared request predicate and keeps the fence for proof binding",
    ),
  ),
  "supersede-started-observed": runRecordRow(
    [
      "record.nested-protocol-validation",
      "supersede.started-observation-binding",
      "termination.durable-source-binding",
    ],
    guardSemantic(
      [
        "supersede.started-observation-binding",
        "termination.durable-source-binding",
      ],
      "guard reducer applies the shared observation predicate and marks the durable started fact",
    ),
  ),
  "cancel-fence": runRecordRow(
    ["cancel.fence-lsn-atomic-target"],
    guardSemantic(
      ["cancel.fence-lsn-atomic-target"],
      "guard reducer applies the shared fence predicate and keeps the fence for proof binding",
    ),
  ),
  "capability-revoked": runRecordRow(
    ["capability.assignment-binding"],
    guardSemantic(
      ["capability.assignment-binding"],
      "guard reducer applies the shared revocation predicate over its inline capability set",
    ),
  ),
  "interaction-mirror": runRecordRow(
    ["record.nested-protocol-validation"],
    guardStructural,
  ),
  state: runRecordRow(
    [
      "state.transition-assignment-binding",
      "state.atomic-companions",
      "state.single-active-run",
    ],
    guardSemantic(
      [
        "state.transition-assignment-binding",
        "state.atomic-companions",
        "state.single-active-run",
      ],
      "guard reducer applies all shared state predicates and accumulates the durable started set",
    ),
  ),
  committed: runRecordRow(
    ["commit.atomic-closure", "bundle.historical-assignment-fence"],
    guardSemantic(
      ["commit.atomic-closure"],
      "guard reducer applies the shared committed predicate; the historical bundle fence is replayed by the cold exact submission path from the assigned snapshot",
    ),
  ),
  resolution: runRecordRow(
    [
      "resolution.authority-binding",
      "resolution.open-lifecycle",
      "resolution.close-lifecycle",
    ],
    guardSemantic(
      [
        "resolution.authority-binding",
        "resolution.open-lifecycle",
        "resolution.close-lifecycle",
      ],
      "guard reducer applies all shared resolution predicates over inline facts",
    ),
  ),
  "cancel-contained": runRecordRow(
    ["record.nested-protocol-validation", "termination.durable-source-binding"],
    guardStructural,
  ),
  "cancel-proof-accepted": runRecordRow(
    [
      "record.nested-protocol-validation",
      "cancel.accepted-proof-binding",
      "termination.durable-source-binding",
    ],
    guardSemantic(
      ["cancel.accepted-proof-binding", "termination.durable-source-binding"],
      "guard reducer applies the shared acceptance predicate against its fence, durable-started and revocation facts",
    ),
  ),
  "not-started-rejected": runRecordRow(
    ["record.nested-protocol-validation", "termination.durable-source-binding"],
    guardStructural,
  ),
  "content-asset-index": {
    onlineProducer: implemented(
      ["producer.authoritative-envelope", "internal.closed-structure"],
      "commit transaction emits the content index sidecar",
    ),
    fullReducer: implemented(
      ["internal.closed-structure", "reducer.shared-contract-predicate"],
      "full reducer validates structure and binds entries to the sealed bundle",
    ),
    lightweightGuard: implemented(
      ["internal.closed-structure", "guard.inline-fact-projection"],
      "guard validates and fingerprints the inline commit sidecar without artifact reads",
    ),
    recoveryConsumer: implemented(
      ["internal.closed-structure", "recovery.same-authoritative-reducer"],
      "restart commit projection consumes the same validated sidecar",
    ),
    adversarialTest: implemented(
      ["internal.closed-structure", "test.parameterized-adversarial"],
      "parameterized internal-record corruption cases",
    ),
  },
  "conversation-commit-projection": {
    onlineProducer: notApplicable(
      "record is emitted only by the durable recovery projector after commit replay",
    ),
    fullReducer: implemented(
      ["internal.closed-structure", "reducer.shared-contract-predicate"],
      "full reducer validates and binds one unprojected committed bundle",
    ),
    lightweightGuard: implemented(
      ["internal.closed-structure", "guard.inline-fact-projection"],
      "guard validates the internal record and intentionally makes no authorization mutation",
    ),
    recoveryConsumer: implemented(
      ["internal.closed-structure", "recovery.same-authoritative-reducer"],
      "pending commit projection recovery is both producer and consumer",
    ),
    adversarialTest: implemented(
      ["internal.closed-structure", "test.parameterized-adversarial"],
      "parameterized internal-record corruption cases",
    ),
  },
} as const satisfies Record<CoverageRecordType, MatrixRow>;

const verifier: ProtocolSignatureVerifier = { verify: () => undefined };

describe("conversation run contract execution matrix", () => {
  it("closes every record type across every execution point without pending cells", () => {
    const expectedTypes = [
      ...Object.keys(CONVERSATION_RUN_RECORD_SHAPES),
      ...CONVERSATION_RUN_INTERNAL_RECORD_TYPES,
    ].sort();
    expect(Object.keys(CONTRACT_EXECUTION_MATRIX).sort()).toEqual(expectedTypes);

    const columns: readonly MatrixColumn[] = [
      "onlineProducer",
      "fullReducer",
      "lightweightGuard",
      "recoveryConsumer",
      "adversarialTest",
    ];
    const knownContracts = new Set<string>(CONTRACT_IDS);
    for (const [recordType, row] of Object.entries(CONTRACT_EXECUTION_MATRIX)) {
      expect(Object.keys(row).sort(), recordType).toEqual([...columns].sort());
      for (const column of columns) {
        const cell = row[column];
        if (cell.status === "not-applicable") {
          expect(cell.reason.length, `${recordType}.${column}`).toBeGreaterThan(20);
          continue;
        }
        expect(cell.contracts.length, `${recordType}.${column}`).toBeGreaterThan(0);
        expect(cell.evidence.length, `${recordType}.${column}`).toBeGreaterThan(20);
        for (const contract of cell.contracts) {
          expect(knownContracts.has(contract), `${recordType}.${column}.${contract}`).toBe(true);
        }
      }
    }
  });

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

  it("binds every termination proof kind to its durable source", () => {
    const base = {
      assignmentId: "assignment-1",
      executorId: "executor-1",
      conversationId: "conversation-1",
      ownerEpoch: 4,
      dispatchDigest: `sha256:${"3".repeat(64)}`,
      supersedeRequest: { fenceSeq: 7, requestId: "request-1" },
      cancelFence: { fenceSeq: 9, requestId: "request-2" },
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
