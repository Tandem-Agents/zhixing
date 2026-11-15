import type { CommitEnvelope, LogicalRecord } from "@zhixing-ai/core/contracts";
import { verifyProtocolStep } from "@zhixing-ai/core/protocol";
import {
  isAuthenticatedConversationFacts,
  type AuthenticatedConversationFacts,
} from "../../conversation-base-source.js";
import {
  assertConversationRunInternalRecord,
  assertPlainRecord,
  corruptRunJournal,
  validateConversationRunRecord,
} from "../../conversation-run-contracts.js";
import {
  emptySubmissionGuardProjection,
  type ConversationAbortTicketAuthorizer,
  type ConversationCommitLogRecord,
  type ConversationFactGroup,
  type ConversationSubmissionGuardContext,
  type SubmissionGuardProjection,
} from "../contracts.js";
import {
  applyGuardStateTransition,
  envelopeHasRunRecord,
  envelopeHasRunState,
  reduceAssignmentControlGuardRecord,
} from "../state/assignment-control.js";
import {
  applyConversationTicketRecord,
  applyConversationTicketSyncFrontier,
} from "../state/channel-tickets.js";
import { runStream } from "../state/common.js";
import {
  applyGuardCommittedBundle,
  reduceCommitPublishGuardRecord,
} from "../state/commit-publish.js";
import {
  applyQueueMembershipDelta,
  isEarliestQueuedPosition,
  reduceGuardAdmittedRecord,
} from "../state/run-queue-input.js";
import { submissionCommitSidecars } from "./bundle-binding.js";
import {
  applyConversationGuardCommittedJointTransition,
  applyConversationGuardStateJointTransition,
} from "./joint-transitions.js";

type ConversationDomainSource =
  | {
      readonly kind: "local";
      readonly envelope: CommitEnvelope<ConversationCommitLogRecord>;
      readonly context: ConversationSubmissionGuardContext;
    }
  | {
      readonly kind: "imported";
      readonly group: AuthenticatedConversationFacts;
    };

export async function reduceConversationSubmissionGuard(
  context: ConversationSubmissionGuardContext,
  state: SubmissionGuardProjection,
  record: LogicalRecord<ConversationCommitLogRecord>,
  envelope: CommitEnvelope<ConversationCommitLogRecord>,
  checks?: Array<() => void>,
): Promise<SubmissionGuardProjection> {
  return reduceConversationDomainGuard(
    context,
    state,
    record,
    { kind: "local", envelope, context },
    checks,
  );
}

/**
 * Only the authenticated base reader can produce this source capability.
 * Domain transitions are shared; source effects belong to its frozen authority.
 * No imported group is presented as a target WAL envelope or activation.
 */
export async function reduceImportedConversationGuard(
  context: Pick<
    ConversationSubmissionGuardContext,
    "conversationId" | "verifier"
  >,
  state: SubmissionGuardProjection,
  record: LogicalRecord<ConversationCommitLogRecord>,
  group: AuthenticatedConversationFacts,
): Promise<SubmissionGuardProjection> {
  if (
    !isAuthenticatedConversationFacts(group) ||
    group.source.manifest.conversationId !== context.conversationId ||
    !group.entries.includes(record)
  ) {
    throw corruptRunJournal(
      "Imported conversation facts lack verified source provenance",
    );
  }
  return reduceConversationDomainGuard(context, state, record, {
    kind: "imported",
    group,
  });
}

async function reduceConversationDomainGuard(
  context: Pick<
    ConversationSubmissionGuardContext,
    "conversationId" | "verifier" | "legacyAbortTickets"
  >,
  state: SubmissionGuardProjection,
  record: LogicalRecord<ConversationCommitLogRecord>,
  source: ConversationDomainSource,
  checks?: Array<() => void>,
): Promise<SubmissionGuardProjection> {
  const envelope = (
    source.kind === "local" ? source.envelope : source.group
  ) as ConversationFactGroup;
  const sourceLsn =
    source.kind === "local" ? source.envelope.lsn : source.group.sourceLsn;
  const assertSourceAssignment = (id: string) => {
    const assigned = state.assignedById.get(id);
    if (!assigned || source.kind !== "imported") {
      throw corruptRunJournal("Imported source assignment is missing");
    }
    source.group.assertAssignment(assigned.record);
  };
  const assertUsage: ConversationSubmissionGuardContext["assertResourceUsageFinal"] =
    (assigned, usage) => {
      if (source.kind === "local") {
        source.context.assertResourceUsageFinal(assigned, usage);
      } else {
        assertSourceAssignment(assigned.assignmentId);
      }
    };
  const assertTerminal: ConversationSubmissionGuardContext["assertResourceTerminalRecords"] =
    (assigned, mode, records) => {
      if (source.kind === "local") {
        source.context.assertResourceTerminalRecords(assigned, mode, records);
      } else {
        assertSourceAssignment(assigned.assignmentId);
      }
    };
  const verify = async (check: () => void) => {
    if (checks) checks.push(check);
    else await verifyProtocolStep(check);
  };
  const legacyTickets =
    checks && context.legacyAbortTickets
      ? {
          authorize: (
            input: Parameters<ConversationAbortTicketAuthorizer["authorize"]>[0],
          ) => {
            checks.push(() => {
              try {
                context.legacyAbortTickets!.authorize(input);
              } catch {
                throw corruptRunJournal(
                  "Legacy abort ticket authorization failed",
                );
              }
            });
          },
        }
      : context.legacyAbortTickets;

  if (record.stream !== runStream(context.conversationId)) {
    throw corruptRunJournal(
      "Submission guard projection received a different stream",
    );
  }
  const uncheckedBody = record.body as unknown;
  assertPlainRecord(uncheckedBody, "Submission guard record");
  if ("kind" in uncheckedBody) {
    assertConversationRunInternalRecord(uncheckedBody);
    return state;
  }
  const body = await verifyProtocolStep(() =>
    validateConversationRunRecord(uncheckedBody, context.verifier),
  );
  switch (body.t) {
    case "session-lifecycle":
      return state;
    case "admitted":
      reduceGuardAdmittedRecord({
        state,
        body,
        hasAtomicQueuedState: envelopeHasRunState(
          envelope,
          context.conversationId,
          body.runId,
          "queued",
          1,
          undefined,
        ),
      });
      return state;
    case "assigned":
    case "dispatch-acked":
    case "dispatch-conflict":
    case "supersede-requested":
    case "supersede-started-observed":
    case "cancel-fence":
    case "cancel-proof-accepted":
    case "assignment-superseded":
    case "resolution":
    case "capability-revoked": {
      const isEarliestQueuedForAssign =
        body.t === "assigned"
          ? (() => {
              const admitted = state.admittedByRun.get(body.runId);
              return (
                admitted !== undefined &&
                isEarliestQueuedPosition(state, admitted.queuedPosition)
              );
            })()
          : undefined;
      await reduceAssignmentControlGuardRecord({
        conversationId: context.conversationId,
        verifier: context.verifier,
        state,
        crossFacts: {
          tickets: state,
          ...(isEarliestQueuedForAssign !== undefined
            ? { isEarliestQueuedForAssign }
            : {}),
        },
        body,
        envelope,
        sourceLsn,
        ...(source.kind === "local"
          ? {
              localCommit: {
                lsn: source.envelope.lsn,
                envelopeDigest: source.envelope.envelopeDigest,
                at: source.envelope.at,
              },
            }
          : {
              importedOrigin: source.group.location(
                source.group.entries.indexOf(record),
              ),
            }),
        assertUsage,
        assertTerminal,
        verify,
        legacyTickets,
      });
      return state;
    }
    case "ticket-issued": {
      const assigned = state.assignedById.get(body.ticket.assignmentId);
      const admitted = assigned
        ? state.admittedByRun.get(assigned.record.runId)
        : undefined;
      await applyConversationTicketRecord({
        state,
        record: body,
        verifier: context.verifier,
        envelopeAt: envelope.at,
        conversationId: context.conversationId,
        assigned: assigned?.record,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) ===
            assigned.record.assignmentId,
        assignmentAcknowledged: assigned?.acked ?? false,
        assignmentClosed: state.closedAssignments.has(body.ticket.assignmentId),
        assignmentActive:
          assigned !== undefined &&
          (state.stateByRun.get(assigned.record.runId)?.state ===
            "dispatched" ||
            state.stateByRun.get(assigned.record.runId)?.state === "running") &&
          !state.cancelFences.has(body.ticket.assignmentId),
        originalSurfacePrincipal: admitted?.ingress.surfacePrincipal,
        hasAtomicReplacementRevocation:
          body.replacesTicketId === undefined ||
          envelopeHasRunRecord(
            envelope,
            context.conversationId,
            (candidate) =>
              candidate.t === "ticket-revoked" &&
              candidate.ticketId === body.replacesTicketId,
          ),
      });
      return state;
    }
    case "ticket-revoked":
      await applyConversationTicketRecord({
        state,
        record: body,
        verifier: context.verifier,
        envelopeAt: envelope.at,
        conversationId: context.conversationId,
        assignmentIsCurrent: false,
        assignmentAcknowledged: false,
        assignmentClosed: false,
        assignmentActive: false,
      });
      return state;
    case "ticket-sync-frontier":
      applyConversationTicketSyncFrontier(
        state,
        body.expiresThrough,
        envelope.at,
      );
      return state;
    case "state":
      return applyConversationGuardStateJointTransition({
        conversationId: context.conversationId,
        isLocalSource: source.kind === "local",
        state,
        body,
        envelope,
        assertUsage,
        assertTerminal,
        verify,
      });
    case "committed":
      return applyConversationGuardCommittedJointTransition({
        conversationId: context.conversationId,
        state,
        body,
        envelope,
        assertTerminal,
        verify,
      });
    case "bundle-ack-observed":
      reduceCommitPublishGuardRecord(state, body);
      return state;
    case "session-meta":
    case "session-control":
    case "advancement-event":
    case "run-input-opened":
    case "run-input-closed":
    case "run-input-appended":
    case "run-input-consumed":
    case "dispatch-conflict-contained":
    case "cancel-contained":
    case "not-started-rejected":
    case "interaction-mirror":
    case "channel-challenge-prepared":
    case "channel-challenge-delivered":
    case "channel-challenge-closed":
      return state;
  }
}

export const CONVERSATION_GUARD_FINGERPRINT_FNS: readonly ((...args: never[]) => unknown)[] = [
  reduceConversationSubmissionGuard as (...args: never[]) => unknown,
  reduceConversationDomainGuard as (...args: never[]) => unknown,
  reduceGuardAdmittedRecord as (...args: never[]) => unknown,
  reduceAssignmentControlGuardRecord as (...args: never[]) => unknown,
  reduceCommitPublishGuardRecord as (...args: never[]) => unknown,
  applyConversationTicketRecord as (...args: never[]) => unknown,
  applyConversationTicketSyncFrontier as (...args: never[]) => unknown,
  applyConversationGuardStateJointTransition as (...args: never[]) => unknown,
  applyConversationGuardCommittedJointTransition as (...args: never[]) => unknown,
  applyQueueMembershipDelta as (...args: never[]) => unknown,
  applyGuardStateTransition as (...args: never[]) => unknown,
  applyGuardCommittedBundle as (...args: never[]) => unknown,
  submissionCommitSidecars as (...args: never[]) => unknown,
  emptySubmissionGuardProjection as (...args: never[]) => unknown,
];
