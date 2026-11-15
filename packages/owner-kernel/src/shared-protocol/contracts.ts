import { projectionCheckpointKey } from "@zhixing-ai/core/authority";
import type {
  AuthorityCallContext,
  AuthorityCapability,
  AuthorityError,
  CancelProofBody,
  DataPlaneTicket,
  DispatchConflictProof,
  DispatchRejectionProof,
  SupersedeProof,
} from "@zhixing-ai/core/contracts";
import type {
  DataPlaneTicketKind,
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import type {
  AssignmentTerminationProofKind,
  DurableSourceBoundProof,
} from "../conversation-run-contracts.js";

export type AssignmentSubmissionMethod =
  | "submission.reportStarted"
  | "submission.mirrorInteractions"
  | "submission.completeInteractionSettlement"
  | "submission.submitBundle"
  | "submission.submitCancelProof";

export interface AssignmentSubmissionIdentity {
  readonly method: AssignmentSubmissionMethod;
  readonly assignmentId: string;
}

export type AssignmentBundleSubmissionResult =
  | { readonly committed: true; readonly commitRevision: number }
  | { readonly committed: false; readonly error: AuthorityError };

export type AssignmentSubmissionPreflightResult =
  | { readonly kind: "continue" }
  | { readonly kind: "return"; readonly result: AssignmentBundleSubmissionResult };

export type AssignmentSubmissionAuthorization =
  | {
      readonly mode: "active";
      readonly method: AssignmentSubmissionMethod;
      readonly assignmentId: string;
    }
  | {
      /** A validated terminal payload may only narrow the current attempt. */
      readonly mode: "settlement";
      readonly method:
        | "submission.mirrorInteractions"
        | "submission.completeInteractionSettlement"
        | "submission.submitBundle"
        | "submission.submitCancelProof";
      readonly assignmentId: string;
    }
  | {
      /** The request is already subsumed by durable authority state and will append nothing. */
      readonly mode: "durable-replay";
      readonly method:
        | "submission.reportStarted"
        | "submission.mirrorInteractions"
        | "submission.completeInteractionSettlement"
        | "submission.submitBundle"
        | "submission.submitCancelProof";
      readonly assignmentId: string;
    }
  | {
      /** A durable fence determines a zero-write rejection before payload processing. */
      readonly mode: "durable-rejection";
      readonly method: "submission.submitBundle";
      readonly assignmentId: string;
    };

export interface AssignmentSubmissionAuthorizer {
  authenticate(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void;
  authorize(
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void;
}

export interface AssignmentSubmissionPreflightPort {
  preflightSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<AssignmentSubmissionPreflightResult>;
}

export interface InProcessDispatchContextFactory {
  create(
    assignmentId: string,
    method:
      | "executor.dispatch"
      | "executor.cancel"
      | "executor.supersede"
      | "executor.queryLedger",
    request: {
      readonly requestId: string;
      readonly body: unknown;
    },
  ): AuthorityCallContext;
}

export interface InProcessCancellationSubmission {
  submitCancellation(assignmentId: string): Promise<boolean>;
}

export interface InProcessBundleSubmission {
  submitSealedBundle(assignmentId: string): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | { readonly committed: false; readonly error: AuthorityError }
  >;
}

export interface DataPlaneTicketIssueRequest {
  readonly ticketId: string;
  readonly assignmentId: string;
  readonly surfacePrincipal: string;
  readonly kind: DataPlaneTicketKind;
  readonly ttlMs: number;
  readonly replacesTicketId?: string;
}

export interface DataPlaneTicketFacts {
  readonly issued: readonly DataPlaneTicket[];
  readonly revokedTicketIds: readonly string[];
}

export function dispatchConflictKey(proof: DispatchConflictProof): string {
  return `${proof.assignmentId}\0${proof.conflictingActivationDigest}`;
}

export function rejectedNotStartedKey(
  assignmentId: string,
  kind: AssignmentTerminationProofKind,
): string {
  return `${assignmentId}\0${kind}`;
}

/**
 * Narrow read-only fact input for shared not-started termination decisions
 * across both conversation and job journals (dispatch-rejection, supersede, cancel-proof).
 */
export interface SharedNotStartedTerminationFacts {
  readonly domain: "conversation" | "job";
  readonly entrypoint:
    | "dispatch-rejection"
    | "supersede"
    | "cancel-proof";
  readonly assignmentId: string;
  readonly assignedExists: boolean;
  readonly currentAssignmentMatches: boolean;
  readonly executorId: string;
  readonly ownerEpoch: number;
  readonly hasDurableStarted: boolean;
  readonly hasInteractionMirror: boolean;
  readonly hasCommitted: boolean;
  readonly hasAcceptedCancelProof: boolean;
  readonly existingRejectedNotStarted?: DurableSourceBoundProof;
  readonly existingAcceptedProof?: DurableSourceBoundProof;
  readonly proof: DispatchRejectionProof | SupersedeProof | CancelProofBody;
}

/**
 * Narrow read-only fact input for shared data-plane ticket issuance & sync frontier.
 */
export interface SharedDataPlaneTicketFactsView {
  readonly domain: "conversation" | "job";
  readonly assignmentId: string;
  readonly existingTicket?: DataPlaneTicket;
  readonly replacedTicket?: DataPlaneTicket;
  readonly replacementTargetForReplaced?: string;
  readonly isClosedOrTerminal: boolean;
  readonly isCancelledOrCancelRequested: boolean;
  readonly hasChannelOrInteractiveAllowance: boolean;
  readonly ticketSyncFrontier?: string;
  readonly revokedTicketIds: ReadonlySet<string>;
}

export interface SharedTicketAuthorityPorts {
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly issueCapability?: AuthorityCapability;
}

/**
 * Builds a projection checkpoint key from an explicit tuple of semantic leaf
 * reduction functions so edits to non-semantic wrapper/router shells do not
 * falsely invalidate persisted checkpoints while any semantic leaf edit does.
 */
export function buildSemanticProjectionCheckpointPrefix(
  projectionName: string,
  version: number,
  leafFns: readonly ((...args: never[]) => unknown)[],
): string {
  if (leafFns.length === 0) {
    throw new TypeError(
      `Semantic checkpoint ${projectionName}@v${version} requires at least one leaf reducer function`,
    );
  }
  return projectionCheckpointKey(projectionName, version, ...leafFns);
}
