import type {
  AssignmentTerminationProof,
  CancelProofBody,
  ConversationRunState,
  JobRunState,
} from "@zhixing-ai/core/contracts";
import { canonicalize } from "@zhixing-ai/core/protocol";
import type { AssignmentTerminationProofKind } from "../conversation-run-contracts.js";

export type SharedTerminationEntrypoint =
  | "dispatch-rejection"
  | "supersede"
  | "cancel-proof";

export function withoutTerminationSignature<T extends { readonly signature: unknown }>(
  value: T,
): Omit<T, "signature"> {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}

export function sameUnsignedTerminationProof(
  left: AssignmentTerminationProof | CancelProofBody,
  right: AssignmentTerminationProof | CancelProofBody,
): boolean {
  return (
    canonicalize(withoutTerminationSignature(left)) ===
    canonicalize(withoutTerminationSignature(right))
  );
}

export type SharedTerminationReplayDecision =
  | { readonly kind: "same-proof-replay" }
  | { readonly kind: "conflicting-prior-proof" }
  | { readonly kind: "historical-assignment" }
  | { readonly kind: "terminal-without-durable-fact" }
  | { readonly kind: "proceed" };

export function decideTerminationReplayOrCurrentness(input: {
  readonly domain: "conversation" | "job";
  readonly entrypoint: SharedTerminationEntrypoint;
  readonly proof: AssignmentTerminationProof | CancelProofBody;
  readonly durablePriorProofs: readonly (
    | AssignmentTerminationProof
    | CancelProofBody
    | undefined
  )[];
  readonly assignmentIsCurrent: boolean;
  readonly currentRunState: ConversationRunState | JobRunState | undefined;
}): SharedTerminationReplayDecision {
  const priors = input.durablePriorProofs.filter(
    (
      candidate,
    ): candidate is AssignmentTerminationProof | CancelProofBody =>
      candidate !== undefined,
  );
  if (priors.length > 0) {
    if (
      priors.some(
        (candidate) => !sameUnsignedTerminationProof(candidate, input.proof),
      )
    ) {
      return { kind: "conflicting-prior-proof" };
    }
    return { kind: "same-proof-replay" };
  }
  if (!input.assignmentIsCurrent) {
    return { kind: "historical-assignment" };
  }
  if (
    input.domain === "conversation" &&
    input.entrypoint === "cancel-proof" &&
    (input.currentRunState === "cancelled" ||
      input.currentRunState === "committed")
  ) {
    return { kind: "terminal-without-durable-fact" };
  }
  return { kind: "proceed" };
}

export type ContradictoryUncertainCause =
  | "ledger-unknown"
  | "cancel-unproven"
  | "job-cancel-unknown";

export type SharedNotStartedDecision =
  | { readonly kind: "same-proof-replay" }
  | { readonly kind: "conflicting-prior-proof"; readonly source: "rejected-not-started" }
  | { readonly kind: "unexpected-unreplayed-rejection" }
  | { readonly kind: "missing-open-resolution" }
  | { readonly kind: "unexpected-contained-fact" }
  | { readonly kind: "late-for-state" }
  | { readonly kind: "dispatch-rejection-cannot-close-conflict" }
  | { readonly kind: "conflict-seq-invalid" }
  | {
      readonly kind: "contradictory-not-started";
      readonly opensUncertain: false;
    }
  | {
      readonly kind: "contradictory-not-started";
      readonly opensUncertain: true;
      readonly uncertainCause: ContradictoryUncertainCause;
    }
  | {
      readonly kind: "accepted-not-started";
      readonly settlementRecord: "assignment-superseded" | "cancel-proof-accepted";
      readonly closesOpenResolution: boolean;
      readonly closesDispatchConflict: boolean;
    };

/**
 * Single-source deterministic classifier for `not-started` termination proofs across
 * all 6 public entrypoints (`acceptDispatchRejection`, `acceptSupersedeProof`,
 * and `submitCancelProof` in both `conversation` and `job` domains).
 */
export function classifyNotStartedTermination(input: {
  readonly domain: "conversation" | "job";
  readonly entrypoint: SharedTerminationEntrypoint;
  readonly proof: AssignmentTerminationProof | CancelProofBody;
  readonly proofKind: AssignmentTerminationProofKind;
  readonly currentRunState: ConversationRunState | JobRunState;
  readonly existingRejectedNotStarted?:
    | AssignmentTerminationProof
    | CancelProofBody;
  readonly rejectionAlreadyCheckedInPriorProofs: boolean;
  readonly hasDurableStartedObservation: boolean;
  readonly openResolution?: {
    readonly cause: string;
    readonly isOpen: boolean;
    readonly alreadyContained?: boolean;
    readonly conflictReceivedRecordSeq?: number;
  };
}): SharedNotStartedDecision {
  const conflictsWithReceived =
    input.entrypoint === "dispatch-rejection" &&
    input.openResolution?.isOpen === true &&
    input.openResolution.cause === "dispatch-conflict";
  const startedObserved =
    input.hasDurableStartedObservation ||
    (input.domain === "job" &&
      input.entrypoint !== "dispatch-rejection" &&
      input.currentRunState === "running");

  if (startedObserved || conflictsWithReceived) {
    if (input.existingRejectedNotStarted !== undefined) {
      if (input.rejectionAlreadyCheckedInPriorProofs) {
        return { kind: "unexpected-unreplayed-rejection" };
      }
      if (
        !sameUnsignedTerminationProof(
          input.existingRejectedNotStarted,
          input.proof,
        )
      ) {
        return {
          kind: "conflicting-prior-proof",
          source: "rejected-not-started",
        };
      }
      return { kind: "same-proof-replay" };
    }
    if (input.currentRunState === "uncertain") {
      if (
        input.domain === "conversation" &&
        input.entrypoint !== "cancel-proof" &&
        !input.openResolution?.isOpen
      ) {
        return { kind: "missing-open-resolution" };
      }
      return { kind: "contradictory-not-started", opensUncertain: false };
    }
    if (
      input.currentRunState !== "dispatched" &&
      input.currentRunState !== "running" &&
      input.currentRunState !== "cancel-requested"
    ) {
      return { kind: "late-for-state" };
    }
    const uncertainCause: ContradictoryUncertainCause =
      input.entrypoint === "cancel-proof"
        ? input.domain === "conversation"
          ? "cancel-unproven"
          : "job-cancel-unknown"
        : "ledger-unknown";
    return {
      kind: "contradictory-not-started",
      opensUncertain: true,
      uncertainCause,
    };
  }

  if (input.currentRunState === "uncertain") {
    if (!input.openResolution?.isOpen) {
      return { kind: "missing-open-resolution" };
    }
    const isConflict = input.openResolution.cause === "dispatch-conflict";
    if (isConflict) {
      if (input.proofKind === "dispatch-rejection" || "dispatchDigest" in input.proof) {
        return { kind: "dispatch-rejection-cannot-close-conflict" };
      }
      const receivedSeq = input.openResolution.conflictReceivedRecordSeq;
      if (
        receivedSeq === undefined ||
        input.proof.lastRecordSeq <= receivedSeq
      ) {
        return { kind: "conflict-seq-invalid" };
      }
      if (
        input.entrypoint === "cancel-proof" &&
        input.openResolution.alreadyContained === true
      ) {
        return { kind: "unexpected-contained-fact" };
      }
      return {
        kind: "accepted-not-started",
        settlementRecord: "assignment-superseded",
        closesOpenResolution: true,
        closesDispatchConflict: true,
      };
    }
    return {
      kind: "accepted-not-started",
      settlementRecord: "assignment-superseded",
      closesOpenResolution: true,
      closesDispatchConflict: false,
    };
  }

  if (input.entrypoint === "cancel-proof") {
    if (
      input.domain === "conversation"
        ? input.currentRunState !== "cancel-requested" &&
          input.currentRunState !== "dispatched" &&
          input.currentRunState !== "running"
        : input.currentRunState !== "cancel-requested" &&
          !(
            "cause" in input.proof &&
            input.proof.cause === "abort-ticket" &&
            (input.currentRunState === "dispatched" ||
              input.currentRunState === "running")
          )
    ) {
      return { kind: "late-for-state" };
    }
    return {
      kind: "accepted-not-started",
      settlementRecord: "cancel-proof-accepted",
      closesOpenResolution: false,
      closesDispatchConflict: false,
    };
  }

  if (
    input.currentRunState !== "dispatched" &&
    input.currentRunState !== "cancel-requested"
  ) {
    return { kind: "late-for-state" };
  }
  const closesConflictOutsideUncertain =
    input.domain === "conversation" &&
    input.openResolution?.isOpen === true &&
    input.openResolution.cause === "dispatch-conflict";
  if (closesConflictOutsideUncertain) {
    if (input.proofKind !== "supersede" || "dispatchDigest" in input.proof) {
      return { kind: "dispatch-rejection-cannot-close-conflict" };
    }
    const receivedSeq = input.openResolution?.conflictReceivedRecordSeq;
    if (
      receivedSeq === undefined ||
      input.proof.lastRecordSeq <= receivedSeq
    ) {
      return { kind: "conflict-seq-invalid" };
    }
    return {
      kind: "accepted-not-started",
      settlementRecord: "assignment-superseded",
      closesOpenResolution: Boolean(input.openResolution?.isOpen),
      closesDispatchConflict: true,
    };
  }

  return {
    kind: "accepted-not-started",
    settlementRecord: "assignment-superseded",
    closesOpenResolution:
      input.domain === "conversation"
        ? Boolean(input.openResolution?.isOpen)
        : false,
    closesDispatchConflict: false,
  };
}
