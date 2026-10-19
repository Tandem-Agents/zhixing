import { corruptRunJournal } from './conversation-run-contracts.js';
import { isAuthenticatedConversationFacts, type AuthenticatedConversationFacts, type ConversationBaseLocation } from './conversation-base-source.js';
import type { ArtifactStore, DurableLogCheckpoint, DurableProjectionReadContext } from '@zhixing/core/authority';
import type { CommitEnvelope, LogicalRecord, ArtifactRef, ConversationRunState, SegmentRecord } from '@zhixing/core/contracts';
import { canonicalize, protocolDigest, interactionMirrorSeed, interactionMirrorBatchDigest, validateConversationInteractionMirrorEntry, validateNonEmptyUserTurnInput,
  type ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { dispatchConflictKey, rejectedNotStartedKey, loadCommittedBundleBinding, emptyConversationRunProjection, reduceConversationContainment,
  type RunProjection, type SubmissionGuardProjection, type ConversationFactGroup, type ConversationSubmissionGuardContext } from './conversation-assignment.js';
import { assignmentTerminationProofKind, assertHistoricalBundleFence, type ConversationRunJournalRecord, type ConversationRunInternalRecord, type Stored } from './conversation-run-contracts.js';
import { conversationCommitSummary } from './conversation-commit-summary.js';
import { projectStatusEntry } from './conversation-status-projection.js';
import { createChannelInteractionJournalState, advanceChannelInteractionJournal } from './channel-interaction-records.js';
import { conversationStateBase as base, conversationStateHash as hash, conversationStateFieldKey as fieldKey,
  encodeConversationState as encode, decodeConversationState as decode, readConversationStateField as field } from './conversation-run-state-index.js';

export interface ConversationRunRoot {
  domainRevision: number; deleted: boolean; clearedThroughLsn: number; hasDurableIdentity: boolean;
  clearedThroughRevision?: number;
  pendingLifecycleCount: number;
  sessionName?: string; lastActiveAt?: string;
  sessionMeta?: Extract<ConversationRunJournalRecord, { t: 'session-meta' }>;
  latestCommit?: Extract<ConversationRunJournalRecord, { t: 'committed' }>;
  latestSegment?: Pick<SegmentRecord, 'segmentId' | 'timestamp'>;
  activeAdvancementSessionId?: string;
  openAdvancementSessionId?: string;
  taskList?: RunProjection['taskList'];
}
export type ConversationInputLocation = { readonly checkpoint: DurableLogCheckpoint; readonly item: number }
  | { readonly imported: ConversationBaseLocation };
const rootKey = (id: string) => base(id) + 'run-root';
export async function readConversationRunRoot(view: DurableProjectionReadContext, id: string): Promise<ConversationRunRoot> {
  const row = await view.get(rootKey(id));
  return row === undefined ? { domainRevision: 0, deleted: false, clearedThroughLsn: 0, hasDurableIdentity: false, pendingLifecycleCount: 0 } : decode(row) as ConversationRunRoot;
}
async function load<T>(value: Stored<T>, artifacts: ArtifactStore): Promise<T> {
  return value && typeof value === 'object' && Object.keys(value).length === 1 && 'ref' in value
    ? JSON.parse(Buffer.from(await artifacts.get(value.ref as ArtifactRef)).toString('utf8')) as T : value as T;
}

/** Supplemental current state, exact identities and original-body locators.
 * Execution/permission transitions are validated by the existing metadata
 * guard; live decisions retain the full journal candidate reducer. */
export async function foldConversationRunExtras(input: {
  id: string; entry: LogicalRecord<unknown>; envelope: CommitEnvelope<unknown> | AuthenticatedConversationFacts; checkpoint?: DurableLogCheckpoint; item: number;
  view: DurableProjectionReadContext; put(key: string, value: unknown): void; drop(key: string): void;
  artifacts: ArtifactStore; verifier: ProtocolSignatureVerifier; guard: SubmissionGuardProjection;
  priorState?: ConversationRunState; priorAssignment?: string;
  context: Pick<ConversationSubmissionGuardContext, 'conversationId' | 'verifier' | 'legacyAbortTickets'> & Partial<Pick<ConversationSubmissionGuardContext, 'assertResourceUsageFinal'>>;
  validated?: RunProjection;
}): Promise<void> {
  const { id, envelope, view, artifacts, guard } = input;
  const sourceLsn = isAuthenticatedConversationFacts(envelope) ? envelope.sourceLsn : envelope.lsn;
  const body = input.entry.body as ConversationRunJournalRecord | ConversationRunInternalRecord;
  const root = await readConversationRunRoot(view, id);
  const get = <T>(name: string, key: string | number) => field(view, id, 'extra-' + name, key) as Promise<T | undefined>;
  const put = (name: string, key: string | number, value: unknown) => input.put(fieldKey(id, 'extra-' + name, key), { key, value: encode(value) });
  const drop = (name: string, key: string | number) => input.drop(fieldKey(id, 'extra-' + name, key));
  const pending = (name: string, key: string, value: unknown | undefined) => {
    const location = base(id) + 'pending-' + name + '/' + hash(key);
    if (value === undefined) input.drop(location); else input.put(location, value);
  };
  if (!isAuthenticatedConversationFacts(envelope) && !input.checkpoint) throw new TypeError('Local source checkpoint is required');
  const source: ConversationInputLocation = isAuthenticatedConversationFacts(envelope)
    ? { imported: envelope.location(input.item) } : { checkpoint: input.checkpoint!, item: input.item };
  const assignmentRun = (assignmentId: string) => guard.assignedById.get(assignmentId)?.record.runId;
  const sessionMutation = async (requestId: string, mutation: unknown, digestSchema: string, revision?: number) => {
    const digest = protocolDigest(digestSchema, 1, mutation);
    const prior = await get<{ digest: string; domainRevision: number }>('sessionMutationDigests', requestId);
    if (prior) {
      if (prior.digest !== digest || revision !== undefined && prior.domainRevision !== revision) throw corruptRunJournal('Session mutation identity changed');
      return;
    }
    if (revision !== undefined && revision !== root.domainRevision + 1 || root.deleted) throw corruptRunJournal('Session mutation revision or terminal state is invalid');
    root.domainRevision++;
    put('sessionMutationDigests', requestId, { digest, domainRevision: root.domainRevision });
    const value = mutation as { kind: string; segment?: SegmentRecord; patch?: { name?: string } };
    if (value.kind === 'task-list-op') put('taskListRequestIds', requestId, true);
    if (value.kind === 'session-meta' && value.patch?.name !== undefined) root.sessionName = value.patch.name;
    if (value.kind === 'segment-append') {
      const segment = value.segment!;
      const seen = await get<number>('segmentRevisionSeen', segment.segmentId);
      if (seen !== undefined && seen > (root.clearedThroughRevision ?? 0) || root.latestSegment && Date.parse(root.latestSegment.timestamp) > Date.parse(segment.timestamp)) throw corruptRunJournal('Segment history is duplicated or non-monotonic');
      put('segmentRevisionSeen', segment.segmentId, root.domainRevision);
      root.latestSegment = { segmentId: segment.segmentId, timestamp: segment.timestamp };
    }
  };
  if ('kind' in body) {
    if (body.kind === 'conversation-commit-projection') {
      const committed = await get<Extract<ConversationRunJournalRecord, { t: 'committed' }>>('committedByAssignment', body.assignmentId);
      if (!committed || committed.runId !== body.runId || committed.commitRevision !== body.commitRevision || await get('projectedByAssignment', body.assignmentId)) throw corruptRunJournal('Projection progress does not name one unprojected commit');
      if (await get<string>('committedDigest', body.assignmentId) !== body.digest) throw corruptRunJournal('Projection progress digest does not match its bundle');
      put('projectedByAssignment', body.assignmentId, body); pending('commit', body.assignmentId, undefined);
    } else if (body.kind === 'conversation-lifecycle-projection') {
      const prior = await get<{ requestId: string; mutation: string }>('pendingLifecycleProjections', body.domainRevision);
      if (!prior || prior.requestId !== body.requestId || prior.mutation !== body.mutation) throw corruptRunJournal('Lifecycle projection progress does not bind its pending fact');
      put('projectedLifecycleRevisions', body.domainRevision, true); drop('pendingLifecycleProjections', body.domainRevision);
      pending('lifecycle', String(body.domainRevision), undefined); root.pendingLifecycleCount--;
    } else if (body.kind === 'session-activity') {
      throw corruptRunJournal('Session activity record was written to the run stream');
    } else if (body.kind === 'content-asset-index') {
      const committed = root.latestCommit;
      if (!committed || !envelope.entries.some(entry => entry.stream === 'run:' + id && (entry.body as { t?: string; assignmentId?: string })?.t === 'committed' &&
          (entry.body as { assignmentId?: string }).assignmentId === committed.assignmentId) || await get('contentByRevision', committed.commitRevision)) throw corruptRunJournal('Content index has no unique committed run');
      put('contentByRevision', committed.commitRevision, body.entries);
    }
  } else switch (body.t) {
    case 'session-meta': {
      if (body.domainRevision !== root.domainRevision + 1 || await get('sessionMetaByRequest', body.requestId) ||
          body.operation === 'create' && root.sessionMeta !== undefined || body.operation !== 'create' && (!root.sessionMeta || root.sessionMeta.sceneId !== body.sceneId) ||
          body.operation !== 'delete' && root.deleted) throw corruptRunJournal('Session metadata transition is invalid');
      root.domainRevision = body.domainRevision; root.sessionMeta = body; root.hasDurableIdentity = true;
      put('sessionMetaByRequest', body.requestId, body);
      if (body.operation === 'delete') {
        root.deleted = true; root.pendingLifecycleCount++;
        const work = { mutation: 'delete', domainRevision: body.domainRevision, requestId: body.requestId };
        put('pendingLifecycleProjections', body.domainRevision, work); pending('lifecycle', String(body.domainRevision), body.domainRevision);
      }
      break;
    }
    case 'session-control': await sessionMutation(body.requestId, body.mutation, 'SessionControlMutation', body.domainRevision); root.lastActiveAt = envelope.at; break;
    case 'session-lifecycle': {
      if (body.domainRevision !== root.domainRevision + 1 || root.deleted || await get('lifecycleByRequest', body.requestId)) throw corruptRunJournal('Session lifecycle revision or terminal state is invalid');
      root.domainRevision = body.domainRevision; root.hasDurableIdentity = true; root.pendingLifecycleCount++;
      put('lifecycleByRequest', body.requestId, body); put('pendingLifecycleProjections', body.domainRevision, body);
      pending('lifecycle', String(body.domainRevision), body.domainRevision);
      if (body.mutation === 'clear') { root.clearedThroughLsn = sourceLsn; root.clearedThroughRevision = body.domainRevision; delete root.latestSegment; }
      else root.deleted = true;
      root.lastActiveAt = envelope.at; break;
    }
    case 'admitted': case 'run-input-appended': {
      const { input: value, ...record } = body;
      const reference = value && typeof value === 'object' && Object.keys(value).length === 1 && 'ref' in value ? value.ref : undefined;
      const stored = { record, lsn: sourceLsn, domainRevision: root.domainRevision, source, ...(reference ? { inputRef: reference } : { inputDigest: protocolDigest('ConversationAdmittedInput', 1, value) }) };
      if (body.t === 'admitted') {
        if (root.deleted) throw corruptRunJournal('Deleted conversation contains a later admitted run');
        put('admittedByRun', body.runId, stored); root.hasDurableIdentity = true;
        const ingressKey = canonicalize([body.ingress.ingressId, body.invocation.source]);
        const prior = await get<string[]>('runByIngressIdentity', ingressKey) ?? [];
        if (!prior.includes(body.runId) && prior.length < 2) prior.push(body.runId);
        put('runByIngressIdentity', ingressKey, prior);
      } else {
        if (!await get('openInputAssignments', body.runId) || guard.runByIngress.has(body.ingressKey) || guard.stateByRun.get(body.runId)?.state !== 'running') throw corruptRunJournal('Invalid appended input');
        validateNonEmptyUserTurnInput(await load(body.input, artifacts));
        put('appendedInputs', body.ingressKey, stored);
        input.put(base(id) + 'appended/' + hash(body.runId) + '/' + String(body.position).padStart(16, '0') + '/' + hash(body.ingressKey), body.ingressKey);
        input.put(fieldKey(id, 'runByIngress', body.ingressKey), { key: body.ingressKey, value: encode(body.runId) });
      }
      break;
    }
    case 'run-input-opened':
      if (await get('assignmentByRun', body.runId) !== body.assignmentId || await get('closedInputAssignments', body.assignmentId) || guard.stateByRun.get(body.runId)?.state !== 'running') throw corruptRunJournal('Invalid input opening');
      put('openInputAssignments', body.runId, body.assignmentId); break;
    case 'run-input-closed':
      if (await get('openInputAssignments', body.runId) !== body.assignmentId) throw corruptRunJournal('Invalid input closing');
      drop('openInputAssignments', body.runId); put('closedInputAssignments', body.assignmentId, true); break;
    case 'run-input-consumed': {
      const key = body.assignmentId + '/' + body.boundary;
      const head = await get<number>('inputConsumptionHead', body.assignmentId);
      if (await get('openInputAssignments', body.runId) !== body.assignmentId || await get('inputConsumptions', key) || head !== undefined && head >= body.boundary) throw corruptRunJournal('Invalid input consumption');
      for (const ingressKey of body.ingressKeys) {
        const appended = await get<{ record: { runId: string } }>('appendedInputs', ingressKey);
        if (appended?.record.runId !== body.runId || await get('consumedIngress', body.assignmentId + '\0' + ingressKey)) throw corruptRunJournal('Invalid input consumption');
        put('consumedIngress', body.assignmentId + '\0' + ingressKey, true);
      }
      put('inputConsumptionHead', body.assignmentId, body.boundary);
      put('inputConsumptions', key, body);
      input.put(base(id) + 'consumed/' + hash(body.assignmentId) + '/' + String(body.boundary).padStart(16, '0'), key); break;
    }
    case 'assigned': {
      put('assignmentByRun', body.runId, body.assignmentId);
      const prior = await get<number>('assignmentAttemptByRun', body.runId) ?? 0;
      put('assignmentAttemptByRun', body.runId, Math.max(prior, body.reservation.attempt));
      pending('recovery', body.assignmentId, body.assignmentId);
      put('mirrorStateByAssignment', body.assignmentId, { ordinal: 0, mirrorDigest: interactionMirrorSeed(body.assignmentId), mirroredUpTo: 0 });
      break;
    }
    case 'supersede-started-observed': put('supersedeStartedObservations', body.assignmentId, body); break;
    case 'dispatch-conflict': put('conflictByAssignment', body.assignmentId, body); put('conflicts', dispatchConflictKey(body.proof), body); break;
    case 'dispatch-conflict-contained': case 'cancel-contained': case 'not-started-rejected': {
      const state = emptyConversationRunProjection(id);
      const target = state as unknown as Record<string, unknown>;
      for (const name of ['assignedById', 'stateByRun', 'assignmentByRun', 'resolutionsByRun', 'supersedeRequests', 'cancelFences',
        'ticketIdsByAssignment', 'ticketsById', 'revokedCapabilities', 'revokedTickets'] as const) target[name] = guard[name];
      for (const name of ['conflictByAssignment', 'supersedeStartedObservations', 'cancelOrigins', 'uncertainOrigins'] as const) {
        const value = await get(name, body.assignmentId);
        if (value !== undefined) (state[name] as Map<string, unknown>).set(body.assignmentId, value);
      }
      if ('openFactDigest' in body && await get('containedFacts', body.openFactDigest)) state.containedFacts.add(body.openFactDigest);
      const rejectionKey = rejectedNotStartedKey(body.assignmentId, assignmentTerminationProofKind(body.proof));
      const rejected = await get<NonNullable<ReturnType<typeof state.rejectedNotStarted.get>>>('rejectedNotStarted', rejectionKey);
      if (rejected) state.rejectedNotStarted.set(rejectionKey, rejected);
      reduceConversationContainment(state, body, envelope as ConversationFactGroup, id, input.context.legacyAbortTickets);
      if (body.t === 'not-started-rejected') put('rejectedNotStarted', rejectionKey, body);
      else { put('containedFacts', body.openFactDigest, true); put('containmentByAssignment', body.assignmentId, body); pending('recovery', body.assignmentId, undefined); }
      break;
    }
    case 'cancel-proof-accepted': put('acceptedCancellations', body.assignmentId, body); pending('recovery', body.assignmentId, undefined); break;
    case 'assignment-superseded': {
      put('superseded', body.assignmentId, body); pending('recovery', body.assignmentId, undefined);
      const run = assignmentRun(body.assignmentId); if (run) drop('assignmentByRun', run);
      put('closedAssignments', body.assignmentId, true); break;
    }
    case 'cancel-fence': {
      const run = assignmentRun(body.assignmentId), current = run && guard.stateByRun.get(run)?.state;
      if (current !== 'dispatched' && current !== 'running') throw corruptRunJournal('Cancellation fence has no active origin');
      put('cancelOrigins', body.assignmentId, current); break;
    }
    case 'interaction-mirror': {
      const batch = body.batch, digest = interactionMirrorBatchDigest(batch);
      const assigned = guard.assignedById.get(body.assignmentId), current = assigned && guard.stateByRun.get(assigned.record.runId)?.state;
      const head = await get<{ ordinal: number; mirrorDigest: string; mirroredUpTo: number }>('mirrorStateByAssignment', body.assignmentId);
      if (!assigned || batch.executorId !== assigned.record.executorId || guard.assignmentByRun.get(assigned.record.runId) !== body.assignmentId ||
          guard.closedAssignments.has(body.assignmentId) || await get('mirrorBatches', digest) || !head || !batch.entries.length ||
          batch.previousDigest !== head.mirrorDigest || batch.entries[0]!.ordinal !== head.ordinal + 1 ||
          !(['dispatched', 'running'].includes(current ?? '') || ['cancel-requested', 'uncertain'].includes(current ?? '') && guard.cancelFences.has(body.assignmentId))) throw corruptRunJournal('Interaction mirror has no current audit prefix');
      let ordinal = head.ordinal, seq = head.mirroredUpTo;
      for (const raw of batch.entries) {
        const entry = validateConversationInteractionMirrorEntry(raw), key = body.assignmentId + '\0' + entry.requestId;
        if (entry.ordinal !== ordinal + 1 || entry.seq <= seq || await get('mirrorRequests', key)) throw corruptRunJournal('Interaction mirror sequence or request identity is invalid');
        ordinal = entry.ordinal; seq = entry.seq; put('mirrorRequests', key, true);
        if (await get('interactionOutcome', entry.requestId) === undefined) put('interactionOutcome', entry.requestId,
          entry.outcome.t === 'answered' ? { t: 'answered', decisionDigest: entry.outcome.decisionDigest } : { t: 'closed' });
      }
      put('mirrorStateByAssignment', body.assignmentId, { ordinal, mirroredUpTo: seq, mirrorDigest: batch.mirrorDigest });
      put('mirrorBatches', digest, { source }); break;
    }
    case 'channel-challenge-prepared': case 'channel-challenge-delivered': case 'channel-challenge-closed': {
      const challenge = body.t === 'channel-challenge-prepared' ? body.token.challengeId : body.challengeId;
      if (body.t === 'channel-challenge-prepared') {
        const assigned = guard.assignedById.get(body.assignmentId), admitted = assigned && guard.admittedByRun.get(assigned.record.runId);
        if (!assigned || !admitted || admitted.ingress.kind !== 'channel' || body.ref.conversationId !== id ||
            body.ref.runId !== assigned.record.runId || body.ref.ownerEpoch !== assigned.record.ownerEpoch ||
            canonicalize(body.responder) !== canonicalize(admitted.ingress.responder) || canonicalize(body.token.route) !== canonicalize(admitted.ingress.replyTarget)) {
          throw corruptRunJournal('Conversation channel challenge does not bind its assignment ingress');
        }
      }
      const state = createChannelInteractionJournalState('conversation');
      for (const name of ['preparedByChallenge', 'deliveredByChallenge', 'closedByChallenge'] as const) {
        const value = await get('channel-' + name, challenge);
        if (value) (state[name] as Map<string, unknown>).set(challenge, value);
      }
      if (body.t === 'channel-challenge-prepared') {
        const interaction = body.assignmentId + '\0' + body.token.interactionRequestId;
        const prior = await get<string>('channel-challengeByInteraction', interaction);
        if (prior) (state.challengeByInteraction as Map<string, string>).set(interaction, prior);
      }
      const next = advanceChannelInteractionJournal(state, body, input.verifier);
      for (const name of ['preparedByChallenge', 'deliveredByChallenge', 'closedByChallenge', 'challengeByInteraction'] as const)
        for (const [key, value] of next[name]) put('channel-' + name, key, value);
      pending('channel', challenge, next.closedByChallenge.has(challenge) ? undefined : challenge); break;
    }
    case 'state': {
      if (body.state === 'uncertain' && input.priorState !== 'uncertain' && input.priorAssignment) put('uncertainOrigins', input.priorAssignment, input.priorState);
      if (body.state === 'failed' && body.assignmentId) { drop('assignmentByRun', body.runId); put('closedAssignments', body.assignmentId, true); }
      if (body.assignmentId && ['queued', 'cancelled', 'failed', 'expired'].includes(body.state)) pending('recovery', body.assignmentId, undefined);
      const resolutions = envelope.entries.flatMap(entry => {
        const fact = entry.body as ConversationRunJournalRecord;
        return entry.stream === 'run:' + id && fact && 't' in fact && fact.t === 'resolution' && fact.runId === body.runId ? [fact.fact] : [];
      });
      put('statusHistoryByRun', body.runId, [projectStatusEntry(body, envelope.at, input.priorState, resolutions)]); break;
    }
    case 'resolution': {
      if (body.fact.resolution) {
        put('closedAssignments', body.fact.subject.assignmentId, true);
        if (await get('assignmentByRun', body.runId) === body.fact.subject.assignmentId) drop('assignmentByRun', body.runId);
      }
      break;
    }
    case 'advancement-event': {
      const validated = input.validated;
      if (!validated) throw corruptRunJournal('Advancement record has no canonical validation');
      root.domainRevision = validated.domainRevision;
      const write = validated.advancementWrites.get(body.requestId);
      if (write) put('advancementWrites', body.requestId, write);
      for (const [sessionId, session] of validated.advancementSessions) {
        put('advancementSessions', sessionId, session);
        put('advancementStatuses', sessionId, session.status);
      }
      root.activeAdvancementSessionId = [...validated.advancementSessions.values()].find(value => value.status === 'active')?.id;
      root.openAdvancementSessionId = [...validated.advancementSessions.values()].find(value => value.status === 'active' || value.status === 'awaiting-rubric-confirmation')?.id;
      break;
    }
    case 'committed': {
      if (root.latestCommit && body.commitRevision !== root.latestCommit.commitRevision + 1) throw corruptRunJournal('Committed run revision is not contiguous');
      const binding = await loadCommittedBundleBinding(envelope, artifacts, candidate => candidate.assignmentId === body.assignmentId);
      put('committedDigest', body.assignmentId, binding.bundle.digest);
      if (binding.bundle.body.conversationId !== id) throw corruptRunJournal('Committed bundle belongs to another conversation');
      const assigned = guard.assignedById.get(body.assignmentId);
      if (!assigned) throw corruptRunJournal('Commit has no assigned resource identity');
      assertHistoricalBundleFence({ assignedExecutorId: assigned.record.executorId, assignedOwnerEpoch: assigned.record.ownerEpoch,
        assignedBaseRevision: assigned.record.baseRevision, bundleExecutorId: binding.bundle.executorId,
        bundleOwnerEpoch: binding.bundle.body.ownerEpoch, bundleBaseRevision: binding.bundle.body.baseRevision,
        conflictOpen: guard.openConflictAssignments.has(body.assignmentId) });
      if (isAuthenticatedConversationFacts(envelope)) envelope.assertAssignment(assigned.record);
      else {
        if (!input.context.assertResourceUsageFinal) throw new TypeError('Local commit requires resource usage verification');
        input.context.assertResourceUsageFinal(assigned.record, binding.bundle.usageFinal);
      }
      const metadata = 'metadata' in binding.closure ? binding.closure.metadata : binding.closure.runRecord;
      const expected = conversationCommitSummary(metadata), { controlRecovery: _control, ...legacy } = expected;
      if (body.readSummary && canonicalize(body.readSummary) !== canonicalize(body.readSummary.controlRecovery === undefined ? legacy : expected)) throw corruptRunJournal('Committed read summary does not match its authoritative record');
      put('committedByAssignment', body.assignmentId, body); put('assignmentByCommitRevision', body.commitRevision, body.assignmentId);
      put('committedByRun', body.runId, body); input.put(base(id) + 'commit-order/' + String(body.commitRevision).padStart(16, '0'), body.assignmentId);
      pending('recovery', body.assignmentId, undefined); pending('ack', body.assignmentId, body.assignmentId); pending('commit', body.assignmentId, body.assignmentId);
      if (expected.controlRecovery || guard.admittedByRun.get(body.runId)?.ingress.turnOrigin?.worksceneContinuation) {
        put('worksceneControls', body.runId, { bundle: body.bundle.ref, ...(root.activeAdvancementSessionId ? { advancementSessionId: root.activeAdvancementSessionId } : {}) });
        input.put(base(id) + 'workscene-controls/' + hash(body.runId), body.runId);
      }
      for (const record of binding.closure.batch?.records ?? []) if (record.domain === 'session') await sessionMutation(record.requestId, record.mutation, 'SessionStagedMutation');
      root.latestCommit = body; root.lastActiveAt = envelope.at; break;
    }
    case 'bundle-ack-observed': pending('recovery', body.assignmentId, undefined); pending('ack', body.assignmentId, undefined); break;
  }
  if (input.validated) root.taskList = input.validated.taskList;
  if (root.pendingLifecycleCount < 0) throw corruptRunJournal('Conversation lifecycle obligation count is invalid');
  input.put(rootKey(id), encode(root));
}
