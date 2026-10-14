import type { ConversationRunState } from '@zhixing/core/contracts';
import type { ConversationRunJournalRecord } from './conversation-run-contracts.js';

const messageFacts = new Set(['admitted', 'assigned', 'state', 'cancel-fence', 'supersede-started-observed',
  'assignment-superseded', 'resolution', 'committed', 'run-input-opened', 'run-input-closed',
  'run-input-appended', 'run-input-consumed', 'session-meta', 'session-lifecycle']);
/** 消息投递事实：带判别字段 `t` 的运行日志记录（不含内部索引记录）。 */
export type MessageDeliveryRecord = Extract<ConversationRunJournalRecord, { readonly t: string }>;
export const isMessageDeliveryFact = (body: unknown): body is MessageDeliveryRecord =>
  !!body && typeof body === 'object' && 't' in body && messageFacts.has(String(body.t));

/** The same durable facts define delivery in the execution and query views. */
export interface MessageDeliveryFacts {
  readonly assignedById: ReadonlyMap<string, { readonly record: { readonly runId: string } }>;
  readonly assignmentByRun: ReadonlyMap<string, string>;
  readonly stateByRun: ReadonlyMap<string, { readonly state: ConversationRunState }>;
  readonly cancelOrigins: ReadonlyMap<string, ConversationRunState>;
  readonly uncertainOrigins: ReadonlyMap<string, ConversationRunState>;
  readonly supersedeStartedObservations: { has(assignmentId: string): boolean };
  readonly committedByAssignment: { has(assignmentId: string): boolean };
  readonly openInputAssignments: ReadonlyMap<string, string>;
  readonly closedInputAssignments: ReadonlySet<string>;
}

export function hasDurableStartedObservation(state: MessageDeliveryFacts, assignmentId: string): boolean {
  const assigned = state.assignedById.get(assignmentId);
  const current = assigned && state.assignmentByRun.get(assigned.record.runId) === assignmentId
    ? state.stateByRun.get(assigned.record.runId)?.state : undefined;
  return current === 'running' || state.cancelOrigins.get(assignmentId) === 'running' ||
    state.uncertainOrigins.get(assignmentId) === 'running' || state.supersedeStartedObservations.has(assignmentId);
}

export function consumedInitialRuns(state: MessageDeliveryFacts): ReadonlySet<string> {
  const consumed = new Set<string>();
  for (const [id, assigned] of state.assignedById) {
    if (hasDurableStartedObservation(state, id) || state.committedByAssignment.has(id) ||
        state.openInputAssignments.get(assigned.record.runId) === id || state.closedInputAssignments.has(id)) {
      consumed.add(assigned.record.runId);
    }
  }
  return consumed;
}

export function projectInputDelivery(facts: MessageDeliveryFacts, runId: string, consumed: boolean) {
  const state = facts.stateByRun.get(runId)?.state;
  if (!state) throw Error('Input has no authoritative run state');
  const assignment = facts.assignmentByRun.get(runId);
  const closed = assignment !== undefined && facts.closedInputAssignments.has(assignment);
  const disposition = consumed ? 'consumed' : closed || state === 'committed' || state === 'failed' || state === 'cancelled'
    ? 'stopped' : 'pending';
  return { runId, state, consumed, disposition } as const;
}
