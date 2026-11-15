import type {
  AuthorityCallContext,
  ConversationRunState,
  JobRunState,
} from "@zhixing-ai/core/contracts";
import {
  assertActivatedAssignmentCapability,
  canonicalize,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import type {
  AssignmentSubmissionAuthorization,
  AssignmentSubmissionAuthorizer,
  AssignmentSubmissionIdentity,
} from "./contracts.js";

export type SubmissionAuthorityTarget =
  | {
      readonly domain: "conversation";
      readonly conversationId: string;
      readonly currentOwnerEpoch: number;
    }
  | {
      readonly domain: "job";
      readonly taskId: string;
      readonly currentAnchorEpoch: number;
    };

export interface SubmissionAssignedCapabilityFact {
  readonly assignmentId: string;
  readonly executorId: string;
  readonly capIds: readonly string[] | ReadonlySet<string>;
  readonly epoch: number;
  readonly envelope?: {
    readonly capabilities: readonly { readonly capId: string }[];
  };
}

export function assertCapabilityMatchesAssignedEnvelope(
  capability: { readonly capId: string },
  envelope: { readonly capabilities: readonly { readonly capId: string }[] },
): void {
  const assigned = envelope.capabilities.find(
    (candidate) => candidate.capId === capability.capId,
  );
  if (!assigned || canonicalize(assigned) !== canonicalize(capability)) {
    throw new TypeError(
      "Assignment capability does not match the durable dispatch capability",
    );
  }
}

export function assertSubmissionContextIdentity(
  context: AuthorityCallContext,
  identity: AssignmentSubmissionIdentity,
  domain: "conversation" | "job",
): void {
  if (
    context.principal.kind !== "assignment" ||
    context.principal.capability.assignmentId !== identity.assignmentId ||
    !context.principal.capability.methods.includes(identity.method)
  ) {
    throw new Error(
      domain === "conversation"
        ? "Assignment submission identity does not bind the call"
        : "Assignment submission identity does not bind the job call",
    );
  }
}

export function authenticateAssignmentSubmission(
  submission: AssignmentSubmissionAuthorizer,
  context: AuthorityCallContext,
  identity: AssignmentSubmissionIdentity,
  domain: "conversation" | "job",
): void {
  submission.authenticate(context, identity);
  assertSubmissionContextIdentity(context, identity, domain);
}

export function hasCurrentSubmissionAuthority(
  context: AuthorityCallContext,
  target: SubmissionAuthorityTarget,
): boolean {
  if (context.principal.kind !== "assignment") return false;
  const capability = context.principal.capability;
  if (target.domain === "conversation") {
    return (
      capability.scope.execution === "conversation" &&
      "ownerEpoch" in capability &&
      capability.ownerEpoch === target.currentOwnerEpoch
    );
  }
  return (
    capability.scope.execution === "job" &&
    capability.scope.taskId === target.taskId &&
    "anchorEpoch" in capability &&
    capability.anchorEpoch === target.currentAnchorEpoch
  );
}

export function assertSubmissionGuardActivatedCapability(input: {
  readonly target: SubmissionAuthorityTarget;
  readonly context: AuthorityCallContext;
  readonly identity: AssignmentSubmissionIdentity;
  readonly assigned: SubmissionAssignedCapabilityFact | undefined;
  readonly verifier: ProtocolSignatureVerifier;
  readonly now: string;
  readonly checkEnvelopeMatch?: boolean;
}): void {
  assertSubmissionContextIdentity(
    input.context,
    input.identity,
    input.target.domain,
  );
  if (input.context.principal.kind !== "assignment") return;
  const capability = input.context.principal.capability;
  assertActivatedAssignmentCapability({
    capability,
    activation: input.assigned
      ? {
          capIds: input.assigned.capIds,
          assignmentId: input.assigned.assignmentId,
          executorId: input.assigned.executorId,
          authority:
            input.target.domain === "conversation"
              ? {
                  execution: "conversation",
                  conversationId: input.target.conversationId,
                  ownerEpoch: input.assigned.epoch,
                }
              : {
                  execution: "job",
                  taskId: input.target.taskId,
                  anchorEpoch: input.assigned.epoch,
                },
        }
      : undefined,
    verifier: input.verifier,
    method: input.identity.method,
    resource:
      input.target.domain === "conversation"
        ? `conversation:${input.target.conversationId}`
        : `task:${input.target.taskId}`,
    mode: "durable-replay",
    revoked: false,
    now: input.now,
    deadlineAt: input.context.deadlineAt,
  });
  if (input.checkEnvelopeMatch && input.assigned?.envelope) {
    assertCapabilityMatchesAssignedEnvelope(
      capability,
      input.assigned.envelope,
    );
  }
}

export function authorizeAssignmentSubmissionCapability(input: {
  readonly submission: AssignmentSubmissionAuthorizer;
  readonly target: SubmissionAuthorityTarget;
  readonly context: AuthorityCallContext;
  readonly authorization: AssignmentSubmissionAuthorization;
  readonly assigned: SubmissionAssignedCapabilityFact | undefined;
  readonly isCapabilityRevoked: (capId: string) => boolean;
  readonly verifier: ProtocolSignatureVerifier;
  readonly now: string;
  readonly checkEnvelopeMatch: boolean;
}): void {
  input.submission.authorize(input.context, input.authorization);
  assertSubmissionContextIdentity(
    input.context,
    input.authorization,
    input.target.domain,
  );
  if (
    (input.authorization.mode === "active" ||
      input.authorization.mode === "settlement") &&
    !hasCurrentSubmissionAuthority(input.context, input.target)
  ) {
    throw new Error(
      input.target.domain === "conversation"
        ? "Assignment capability belongs to a stale owner epoch"
        : "Assignment capability belongs to a stale job authority",
    );
  }
  if (input.context.principal.kind !== "assignment") return;
  const capability = input.context.principal.capability;
  assertActivatedAssignmentCapability({
    capability,
    activation: input.assigned
      ? {
          capIds: input.assigned.capIds,
          assignmentId: input.assigned.assignmentId,
          executorId: input.assigned.executorId,
          authority:
            input.target.domain === "conversation"
              ? {
                  execution: "conversation",
                  conversationId: input.target.conversationId,
                  ownerEpoch: input.assigned.epoch,
                }
              : {
                  execution: "job",
                  taskId: input.target.taskId,
                  anchorEpoch: input.assigned.epoch,
                },
        }
      : undefined,
    verifier: input.verifier,
    method: input.authorization.method,
    resource:
      input.target.domain === "conversation"
        ? `conversation:${input.target.conversationId}`
        : `task:${input.target.taskId}`,
    mode: input.authorization.mode,
    revoked: input.isCapabilityRevoked(capability.capId),
    now: input.now,
    deadlineAt: input.context.deadlineAt,
  });
  if (input.checkEnvelopeMatch && input.assigned?.envelope) {
    assertCapabilityMatchesAssignedEnvelope(
      capability,
      input.assigned.envelope,
    );
  }
}

export function decideSubmissionBundleGuardRejection(input: {
  readonly domain: "conversation" | "job";
  readonly hasCurrentAuthority: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly assignmentClosed?: boolean;
  readonly hasOpenDispatchConflict: boolean;
  readonly currentState: ConversationRunState | JobRunState | undefined;
}): string | undefined {
  if (!input.hasCurrentAuthority) {
    return input.domain === "conversation"
      ? "Bundle capability belongs to a stale owner epoch"
      : "Bundle capability belongs to a stale job authority";
  }
  if (!input.assignmentIsCurrent || input.assignmentClosed === true) {
    return "Bundle belongs to a historical assignment";
  }
  if (input.hasOpenDispatchConflict) {
    return "Bundle is blocked by an open dispatch conflict";
  }
  if (
    input.currentState !== "dispatched" &&
    input.currentState !== "running" &&
    input.currentState !== "cancel-requested" &&
    input.currentState !== "uncertain"
  ) {
    return input.domain === "conversation"
      ? "Bundle is late for the current run state"
      : "Bundle is late for the current job state";
  }
  return undefined;
}
