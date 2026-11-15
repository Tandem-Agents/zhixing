import type { CommitEnvelope, LogicalRecord } from "@zhixing-ai/core/contracts";
import { verifyProtocolStep } from "@zhixing-ai/core/protocol";
import {
  assertConversationRunInternalRecord,
  assertConversationRunRecord,
  corruptRunJournal,
  type ConversationRunInternalRecord,
  type ConversationRunJournalRecord,
} from "../../conversation-run-contracts.js";
import {
  CONVERSATION_INTERNAL_RECORD_FAMILY_OWNERS,
  CONVERSATION_RECORD_FAMILY_OWNERS,
  emptyConversationRunProjection,
  type ConversationAbortTicketAuthorizer,
  type ConversationCommitLogRecord,
  type ConversationRunReductionContext,
  type RunProjection,
} from "../contracts.js";
import {
  applyRunStateTransition,
  clearRecoveryAssignment,
  compactAssignedEnvelopePayload,
  envelopeHasRunRecord,
  envelopeHasRunState,
  reduceAssignmentControlRunRecord,
  reduceConversationContainment as reduceConversationContainmentSlice,
} from "../state/assignment-control.js";
import {
  applyConversationTicketRecord,
  applyConversationTicketSyncFrontier,
  reduceChannelChallengeRecord,
} from "../state/channel-tickets.js";
import { runStream, snapshot } from "../state/common.js";
import {
  applyCommittedBundle,
  initializeAssignmentMirrorState,
  reduceCommitPublishInternalRecord,
  reduceCommitPublishRunRecord,
} from "../state/commit-publish.js";
import {
  applyQueueMembershipDelta,
  compactAdmittedRecordMetadata,
  compactAppendedInputRecordMetadata,
  compactTerminalRunInput,
  isEarliestQueuedPosition,
  reduceRunQueueInputRecord,
} from "../state/run-queue-input.js";
import {
  applyCommittedSessionEffects,
  applyLifecycleProjectionInternalRecord,
  reduceConversationSessionFact,
} from "../state/session-domain.js";
import {
  envelopeContainsCommit,
  loadStored,
  validateConversationBundleClosure,
} from "./bundle-binding.js";
import {
  applyConversationCommittedJointTransition,
  applyConversationStateJointTransition,
} from "./joint-transitions.js";

/**
 * V1检查点已通过同一HMAC与日志边界验证；只迁移派生形状，不重读历史制品。
 */
export function compactLegacyRunProjection(source: RunProjection): RunProjection {
  const state = {
    ...source,
    appendedInputKeysByRun: new Map<string, Set<string>>(),
  };
  for (const id of state.assignedById.keys()) {
    compactAssignedEnvelopePayload(state, id);
  }
  for (const id of state.admittedByRun.keys()) {
    compactAdmittedRecordMetadata(state, id);
  }
  for (const [key, appended] of state.appendedInputs) {
    compactAppendedInputRecordMetadata(state, appended.record.runId, key);
  }
  for (const [runId, entry] of state.stateByRun) {
    compactTerminalRunInput(state, runId, entry.state);
  }
  return state;
}

/** One canonical semantic reducer for live writes and indexed recovery. */
export async function reduceConversationRunState(
  context: ConversationRunReductionContext,
  state: RunProjection,
  record: LogicalRecord<unknown>,
  rawEnvelope: CommitEnvelope<unknown>,
  checks?: Array<() => void>,
): Promise<RunProjection> {
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
    return state;
  }
  const envelope =
    rawEnvelope as CommitEnvelope<ConversationCommitLogRecord>;
  const body = snapshot(
    record.body as ConversationRunJournalRecord | ConversationRunInternalRecord,
    "Run journal record",
  );
  if ("kind" in body) {
    assertConversationRunInternalRecord(body);
    const owner = CONVERSATION_INTERNAL_RECORD_FAMILY_OWNERS[body.kind];
    void owner;
    switch (body.kind) {
      case "conversation-commit-projection":
      case "content-asset-index": {
        const latestCommit = state.commits.at(-1);
        await reduceCommitPublishInternalRecord({
          state,
          body,
          artifacts: context.artifacts,
          envelopeContainsLatestCommit:
            latestCommit !== undefined &&
            envelopeContainsCommit(
              envelope,
              context.conversationId,
              latestCommit,
            ),
        });
        return state;
      }
      case "conversation-lifecycle-projection":
        applyLifecycleProjectionInternalRecord(state, body);
        return state;
      case "session-activity":
        throw corruptRunJournal(
          "Session activity record was written to the run stream",
        );
    }
  }
  await verifyProtocolStep(() =>
    assertConversationRunRecord(body, context.verifier),
  );
  const familyOwner = CONVERSATION_RECORD_FAMILY_OWNERS[body.t];
  void familyOwner;
  switch (body.t) {
    case "session-meta":
    case "session-control":
    case "session-lifecycle":
    case "advancement-event":
      await reduceConversationSessionFact(
        context,
        state,
        body,
        envelope,
        envelope.lsn,
      );
      return state;
    case "admitted":
    case "run-input-opened":
    case "run-input-closed":
    case "run-input-appended":
    case "run-input-consumed": {
      const currentAssignmentIdForRun = state.assignmentByRun.get(body.runId);
      const currentRunState = state.stateByRun.get(body.runId)?.state;
      await reduceRunQueueInputRecord({
        state,
        crossFacts: {
          sessionDeleted: state.deleted,
          domainRevision: state.domainRevision,
          ...(currentAssignmentIdForRun !== undefined
            ? { currentAssignmentIdForRun }
            : {}),
          ...(currentRunState !== undefined ? { currentRunState } : {}),
        },
        body,
        envelope,
        conversationId: context.conversationId,
        lsn: envelope.lsn,
        artifacts: context.artifacts,
        loadStoredInput: loadStored,
        hasAtomicQueuedState:
          body.t === "admitted" &&
          envelopeHasRunState(
            envelope,
            context.conversationId,
            body.runId,
            "queued",
            1,
            undefined,
          ),
      });
      return state;
    }
    case "assigned":
    case "dispatch-acked":
    case "supersede-requested":
    case "supersede-started-observed":
    case "dispatch-conflict":
    case "dispatch-conflict-contained":
    case "cancel-contained":
    case "cancel-proof-accepted":
    case "not-started-rejected":
    case "assignment-superseded":
    case "cancel-fence":
    case "capability-revoked":
    case "resolution": {
      const admittedForAssign =
        body.t === "assigned"
          ? (() => {
              const admitted = state.admittedByRun.get(body.runId);
              return admitted
                ? {
                    ingress: admitted.record.ingress,
                    isEarliestQueued: isEarliestQueuedPosition(
                      state,
                      admitted.record.queuedPosition,
                    ),
                  }
                : undefined;
            })()
          : undefined;
      await reduceAssignmentControlRunRecord({
        context,
        state,
        crossFacts: {
          tickets: state,
          ...(admittedForAssign ? { admittedForAssign } : {}),
        },
        body,
        envelope,
        verify,
        legacyTickets,
      });
      if (body.t === "assigned") {
        initializeAssignmentMirrorState(state, body.assignmentId);
      }
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
        originalSurfacePrincipal: admitted?.record.ingress.surfacePrincipal,
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
    case "channel-challenge-prepared":
    case "channel-challenge-delivered":
    case "channel-challenge-closed": {
      const bindingFacts =
        body.t === "channel-challenge-prepared"
          ? (() => {
              const assigned = state.assignedById.get(body.assignmentId)?.record;
              const admittedIngress = assigned
                ? state.admittedByRun.get(assigned.runId)?.record.ingress
                : undefined;
              return {
                ...(assigned ? { assigned } : {}),
                ...(admittedIngress ? { admittedIngress } : {}),
              };
            })()
          : undefined;
      await reduceChannelChallengeRecord({
        state,
        body,
        conversationId: context.conversationId,
        verifier: context.verifier,
        ...(bindingFacts ? { bindingFacts } : {}),
      });
      return state;
    }
    case "interaction-mirror":
    case "bundle-ack-observed": {
      const mirrorAssignmentFacts =
        body.t === "interaction-mirror"
          ? (() => {
              const assigned = state.assignedById.get(body.assignmentId)?.record;
              const currentRunState = assigned
                ? state.stateByRun.get(assigned.runId)?.state
                : undefined;
              return {
                ...(assigned
                  ? {
                      assigned: {
                        runId: assigned.runId,
                        executorId: assigned.executorId,
                      },
                    }
                  : {}),
                assignmentIsCurrent:
                  assigned !== undefined &&
                  state.assignmentByRun.get(assigned.runId) ===
                    body.assignmentId,
                assignmentClosed: state.closedAssignments.has(body.assignmentId),
                ...(currentRunState !== undefined ? { currentRunState } : {}),
                hasCancelFence: state.cancelFences.has(body.assignmentId),
              };
            })()
          : undefined;
      reduceCommitPublishRunRecord({
        state,
        body,
        ...(mirrorAssignmentFacts ? { mirrorAssignmentFacts } : {}),
      });
      if (body.t === "bundle-ack-observed") {
        clearRecoveryAssignment(state, body.assignmentId);
      }
      return state;
    }
    case "state":
      return applyConversationStateJointTransition({
        context,
        state,
        body,
        envelope,
        verify,
      });
    case "committed":
      return applyConversationCommittedJointTransition({
        context,
        state,
        body,
        envelope,
        verify,
      });
  }
}

/**
 * 已验事实仅保留执行所需绑定；历史正文留在原制品及分页读模型，不重复进入启动检查点。
 */
export async function reduceRunProjectionWithCompaction(
  context: ConversationRunReductionContext,
  state: RunProjection,
  record: LogicalRecord<unknown>,
  envelope: CommitEnvelope<unknown>,
  checks?: Array<() => void>,
): Promise<RunProjection> {
  const next = await reduceConversationRunState(
    context,
    state,
    record,
    envelope,
    checks,
  );
  const body = record.body as {
    t?: string;
    runId?: string;
    assignmentId?: string;
    ingressKey?: string;
  };
  if (body.t === "assigned" && body.assignmentId) {
    compactAssignedEnvelopePayload(next, body.assignmentId);
  } else if (body.t === "admitted" && body.runId) {
    compactAdmittedRecordMetadata(next, body.runId);
  } else if (body.t === "run-input-appended" && body.runId && body.ingressKey) {
    compactAppendedInputRecordMetadata(next, body.runId, body.ingressKey);
  }
  // 同一原子信封内的闭合验证仍可读取输入；整份该会话事实归约完成后才释放正文副本。
  if (
    envelope.entries.findLast(
      (entry) => entry.stream === runStream(context.conversationId),
    ) === record
  ) {
    for (const entry of envelope.entries) {
      const terminal = entry.body as { t?: string; runId?: string };
      if (
        entry.stream === record.stream &&
        terminal.t === "state" &&
        terminal.runId
      ) {
        compactTerminalRunInput(
          next,
          terminal.runId,
          next.stateByRun.get(terminal.runId)?.state,
        );
      }
    }
  }
  return next;
}

/** The same containment checks protect live candidates and indexed recovery. */
export function reduceConversationContainment(
  state: RunProjection,
  body: Extract<
    ConversationRunJournalRecord,
    {
      t:
        | "dispatch-conflict-contained"
        | "cancel-contained"
        | "not-started-rejected";
    }
  >,
  envelope: import("../contracts.js").ConversationFactGroup,
  conversationId: string,
  legacyTickets?: ConversationAbortTicketAuthorizer,
): RunProjection {
  reduceConversationContainmentSlice({
    state,
    tickets: state,
    body,
    envelope,
    conversationId,
    legacyTickets,
  });
  return state;
}

export const CONVERSATION_RUN_FINGERPRINT_FNS: readonly ((...args: never[]) => unknown)[] = [
  reduceRunProjectionWithCompaction as (...args: never[]) => unknown,
  reduceConversationRunState as (...args: never[]) => unknown,
  reduceConversationSessionFact as (...args: never[]) => unknown,
  reduceRunQueueInputRecord as (...args: never[]) => unknown,
  reduceAssignmentControlRunRecord as (...args: never[]) => unknown,
  reduceConversationContainmentSlice as (...args: never[]) => unknown,
  reduceChannelChallengeRecord as (...args: never[]) => unknown,
  reduceCommitPublishRunRecord as (...args: never[]) => unknown,
  reduceCommitPublishInternalRecord as (...args: never[]) => unknown,
  applyConversationTicketRecord as (...args: never[]) => unknown,
  applyConversationTicketSyncFrontier as (...args: never[]) => unknown,
  applyConversationStateJointTransition as (...args: never[]) => unknown,
  applyConversationCommittedJointTransition as (...args: never[]) => unknown,
  applyQueueMembershipDelta as (...args: never[]) => unknown,
  applyRunStateTransition as (...args: never[]) => unknown,
  applyCommittedBundle as (...args: never[]) => unknown,
  applyCommittedSessionEffects as (...args: never[]) => unknown,
  initializeAssignmentMirrorState as (...args: never[]) => unknown,
  clearRecoveryAssignment as (...args: never[]) => unknown,
  compactTerminalRunInput as (...args: never[]) => unknown,
  validateConversationBundleClosure as (...args: never[]) => unknown,
  emptyConversationRunProjection as (...args: never[]) => unknown,
];
