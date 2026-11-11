import type { ConversationRunState, ConversationStatusNotice, ConversationUncertainClosure, UncertainResolutionFact, IsoTime } from '@zhixing-ai/core/contracts';
import { projectUncertainStatusTransition, conversationUncertainClosure, corruptRunJournal } from './conversation-run-contracts.js';

export type StatusHistoryEntry = {
  readonly state: ConversationRunState;
  readonly statusRevision: number;
  readonly at: IsoTime;
  readonly reason?: string;
  /** 读目录保存的这条状态所属派发（执行尝试）；只在派发、执行与取消中且状态记录带来时存在 */
  readonly assignmentId?: string;
} & (
  | { readonly uncertainTransition?: undefined }
  | { readonly uncertainTransition: "opened"; readonly openFactDigest: string }
  | ({ readonly uncertainTransition: "closed"; readonly openFactDigest: string } &
      ConversationUncertainClosure)
);


export function projectStatusEntry(body: { state: ConversationRunState; statusRevision: number; reason?: string }, at: IsoTime, currentState: ConversationRunState | undefined, resolutionFacts: readonly UncertainResolutionFact[]): StatusHistoryEntry {
  const transition = projectUncertainStatusTransition({ currentState, nextState: body.state, resolutionFacts });
  if (transition.kind === 'closed' && transition.resolutionKind === 'proven-not-started-cancelled') throw corruptRunJournal('Conversation uncertainty uses a job-only closure kind');
  return { state: body.state, statusRevision: body.statusRevision, at, ...(body.reason ? { reason: body.reason } : {}),
    ...(transition.kind === 'opened' ? { uncertainTransition: 'opened' as const, openFactDigest: transition.openFactDigest } : transition.kind === 'closed' ? { uncertainTransition: 'closed' as const, openFactDigest: transition.openFactDigest, ...conversationUncertainClosure(transition.resolutionKind as Exclude<typeof transition.resolutionKind, 'proven-not-started-cancelled'>) } : {}) };
}

/** 带执行尝试身份的状态：派发、执行与取消中都属于某一次派发 */
export function conversationAttemptState(state: ConversationRunState): boolean {
  return state === "dispatched" || state === "running" || state === "cancel-requested";
}

/**
 * assignmentId 是这条状态所属的派发（执行尝试），只对 dispatched、running、cancel-requested 生效。
 * 实时路径直接传入状态记录里的值；恢复路径取读目录条目自带的值（由同一条状态记录派生）。
 */
export function conversationStatusNotice(
  conversationId: string,
  ownerEpoch: number,
  runId: string,
  entry: StatusHistoryEntry,
  assignmentId?: string,
): ConversationStatusNotice | undefined {
  const ref = {
    execution: "conversation" as const,
    conversationId,
    runId,
    ownerEpoch,
  };
  if (entry.uncertainTransition === "opened") {
    if (entry.state !== "uncertain") {
      throw corruptRunJournal("Uncertain opening notice has a non-uncertain state");
    }
    return {
      v: 1,
      ref,
      state: "uncertain",
      statusRevision: entry.statusRevision,
      actions: ["verify-side-effects", "abandon", "retry-risk-ack"],
      at: entry.at,
      openFactDigest: entry.openFactDigest,
    };
  }
  if (entry.uncertainTransition === "closed") {
    if (entry.resultingState !== entry.state) {
      throw corruptRunJournal("Uncertain closure notice has a mismatched successor state");
    }
    return {
      v: 1,
      ref,
      state: "uncertain-closed",
      statusRevision: entry.statusRevision,
      actions: [],
      at: entry.at,
      openFactDigest: entry.openFactDigest,
      closedBy: entry.closedBy,
      resultingState: entry.resultingState,
    } as ConversationStatusNotice;
  }
  if (entry.state === "committed") return undefined;
  if (entry.state === "uncertain") {
    throw corruptRunJournal("Uncertain state has no durable open fact identity");
  }
  return {
    v: 1,
    ref,
    state: entry.state,
    statusRevision: entry.statusRevision,
    actions: [],
    at: entry.at,
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...((assignmentId ?? entry.assignmentId) && conversationAttemptState(entry.state)
      ? { assignmentId: assignmentId ?? entry.assignmentId }
      : {}),
  };
}

