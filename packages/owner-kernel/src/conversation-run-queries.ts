import type { DurableProjectionReadContext } from '@zhixing/core/authority';
import type { ConversationRunState } from '@zhixing/core/contracts';
import { canonicalize } from '@zhixing/core/protocol';
import type { AssignedProjection, ConversationRunJournalRecord, RunProjection, SubmissionGuardProjection } from './conversation-assignment.js';
import { corruptRunJournal } from './conversation-run-contracts.js';
import { conversationFieldReader, conversationStateBase, readConversationGuardRoot, scanConversationState } from './conversation-run-state-index.js';
import { readConversationRunRoot } from './conversation-run-state-extras.js';

type GuardAssigned = NonNullable<ReturnType<SubmissionGuardProjection['assignedById']['get']>>;
type Committed = Extract<ConversationRunJournalRecord, { t: 'committed' }>;
type Status = NonNullable<ReturnType<RunProjection['stateByRun']['get']>>;
const detached = <T>(value: T): T => JSON.parse(canonicalize(value)) as T;
const assignedSnapshot = (value: GuardAssigned): AssignedProjection => detached({ record: value.record,
  ...(value.commit ? { commit: value.commit } : {}), ...(value.origin ? { origin: value.origin } : {}), acked: value.acked });
const active = (state: ConversationRunState) => ['dispatched', 'running', 'cancel-requested', 'uncertain'].includes(state);

async function pending(view: DurableProjectionReadContext, id: string, kind: 'recovery' | 'ack' | 'commit'): Promise<string[]> {
  // Every current obligation is returned. Page size is not an API result limit.
  return (await scanConversationState(view, conversationStateBase(id) + 'pending-' + kind + '/')).map(row => {
    if (typeof row.value !== 'string') throw corruptRunJournal('Invalid conversation obligation');
    return row.value;
  });
}

export async function readIndexedConversationAuthority(view: DurableProjectionReadContext, id: string) {
  const root = await readConversationRunRoot(view, id);
  // Keep the old materialized compatibility fallback for reachable old roots.
  if (root.hasDurableIdentity === undefined || root.pendingLifecycleCount === undefined) return undefined;
  return { domainRevision: root.domainRevision, commitRevision: root.latestCommit?.commitRevision ?? 0,
    deleted: root.deleted, hasDurableIdentity: root.hasDurableIdentity, pendingLifecycleProjections: root.pendingLifecycleCount };
}

export async function readIndexedPendingDispatch(view: DurableProjectionReadContext, id: string): Promise<AssignedProjection | undefined> {
  const root = await readConversationGuardRoot(view, id), runId = root?.activeRunId;
  if (runId === undefined) return undefined;
  const fields = conversationFieldReader(view, id);
  await fields.preload([['stateByRun', runId], ['assignmentByRun', runId]]);
  const current = (await fields.get<Status>('stateByRun', runId))?.state;
  const assignmentId = await fields.get<string>('assignmentByRun', runId);
  const assigned = assignmentId ? await fields.get<GuardAssigned>('assignedById', assignmentId) : undefined;
  // Validate the active pointer before filtering for a dispatched state.
  if (!current || !active(current) || !assigned) throw corruptRunJournal('Active run index has no durable assignment state');
  if (assigned.record.assignmentId !== assignmentId || assigned.record.runId !== runId) throw corruptRunJournal('Active assignment binding is invalid');
  await fields.preload([['extra-superseded', assignmentId!], ['extra-closedAssignments', assignmentId!]]);
  return current === 'dispatched' && !assigned.acked && await fields.get('extra-superseded', assignmentId!) === undefined &&
    await fields.get('extra-closedAssignments', assignmentId!) !== true ? assignedSnapshot(assigned) : undefined;
}

export async function readIndexedRecoveryAssignments(view: DurableProjectionReadContext, id: string) {
  const recovery = await pending(view, id, 'recovery'), acknowledgements = new Set(await pending(view, id, 'ack'));
  const ids = [...new Set([...recovery, ...acknowledgements])], fields = conversationFieldReader(view, id);
  await fields.preload(ids.map(key => ['assignedById', key] as const));
  const assigned = new Map<string, GuardAssigned>();
  for (const assignmentId of ids) {
    const value = await fields.get<GuardAssigned>('assignedById', assignmentId);
    if (!value || value.record.assignmentId !== assignmentId) throw corruptRunJournal('Recovery outbox names an unknown assignment');
    assigned.set(assignmentId, value);
  }
  const runs = [...new Set([...assigned.values()].map(value => value.record.runId))];
  await fields.preload(runs.flatMap(key => ['stateByRun', 'assignmentByRun', 'resolutionsByRun'].map(name => [name, key] as const)));
  await fields.preload(ids.flatMap(key => ['extra-committedByAssignment', 'bundleAcknowledgements', 'extra-superseded', 'extra-closedAssignments'].map(name => [name, key] as const)));
  const result: Array<{ assignmentId: string; state: 'dispatched' | 'running' | 'cancel-requested' | 'uncertain' | 'committed'; assigned: AssignedProjection }> = [];
  for (const assignmentId of ids) {
    const value = assigned.get(assignmentId)!, runId = value.record.runId;
    const current = (await fields.get<Status>('stateByRun', runId))?.state;
    // Acknowledgement is an independent obligation; ordinary recovery filters
    // must never hide it, including when the two directories overlap.
    if (acknowledgements.has(assignmentId)) {
      const committed = await fields.get<Committed>('extra-committedByAssignment', assignmentId);
      if (current !== 'committed' || committed?.assignmentId !== assignmentId || committed?.runId !== runId || await fields.get('bundleAcknowledgements', assignmentId) !== undefined)
        throw corruptRunJournal('Bundle acknowledgement outbox does not bind one pending committed assignment');
      result.push({ assignmentId, state: current, assigned: assignedSnapshot(value) });
      continue;
    }
    if (await fields.get('assignmentByRun', runId) !== assignmentId || await fields.get('extra-superseded', assignmentId) !== undefined ||
        await fields.get('extra-closedAssignments', assignmentId) === true ||
        await fields.get('extra-rejectedNotStarted', assignmentId + '\0cancel') !== undefined ||
        await fields.get('extra-rejectedNotStarted', assignmentId + '\0dispatch-rejection') !== undefined ||
        !current || !active(current)) continue;
    const open = await fields.get<NonNullable<ReturnType<RunProjection['resolutionsByRun']['get']>>>('resolutionsByRun', runId);
    if (open && await fields.get('extra-containedFacts', open.openFactDigest) === true) continue;
    result.push({ assignmentId, state: current as 'dispatched' | 'running' | 'cancel-requested' | 'uncertain', assigned: assignedSnapshot(value) });
  }
  return result;
}

export async function readIndexedPendingProjections(view: DurableProjectionReadContext, id: string): Promise<Committed[]> {
  const ids = [...new Set(await pending(view, id, 'commit'))], fields = conversationFieldReader(view, id);
  await fields.preload(ids.map(key => ['extra-committedByAssignment', key] as const));
  const result: Committed[] = [];
  for (const assignmentId of ids) {
    const committed = await fields.get<Committed>('extra-committedByAssignment', assignmentId);
    if (!committed || committed.assignmentId !== assignmentId) throw corruptRunJournal('Commit projection outbox names an unknown assignment');
    result.push(detached(committed));
  }
  return result;
}