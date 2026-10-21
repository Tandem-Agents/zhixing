import type { ArtifactStore, AuthorityCommitLog } from '@zhixing/core/authority';
import type { ArtifactRef, ConversationRunState, TranscriptRunRecord, UserTurnInput } from '@zhixing/core/contracts';
import { canonicalize, interactionMirrorBatchDigest, validateConversationEnvelope, validateConversationSealedBundle,
  validateNonEmptyUserTurnInput, validateTranscriptRunRecord, verifyProtocolStep, type ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { emptyConversationRunProjection, type RunProjection, type AdmittedProjection, type ConversationAbortTicketAuthorizer,
  type ConversationRunJournalRecord } from './conversation-assignment.js';
import { readConversationRunRoot, type ConversationInputLocation } from './conversation-run-state-extras.js';
import { CONVERSATION_RUN_STATE_PROJECTION_ID, registerConversationRunProjection, readConversationGuardView,
  conversationStateBase as base, conversationStateHash as hash, readConversationStateField as field, scanConversationState as scan,
  type ConversationRunScope } from './conversation-run-state-index.js';
import { conversationViewAt, conversationBaseKey, openConversationBase, type ConversationBaseBinding } from './conversation-base-registry.js';
import { conversationWorkingVersion, conversationFieldReader } from './conversation-run-state-index.js';
import type { ConversationBaseSource } from './conversation-base-source.js';

export interface ConversationDecisionScope extends ConversationRunScope {
  readonly requests?: readonly string[]; readonly revisions?: readonly number[];
  readonly mirrorDigests?: readonly string[]; readonly conflictKeys?: readonly string[];
  readonly challenges?: readonly string[]; readonly interactions?: readonly string[]; readonly advancementIds?: readonly string[];
  readonly hydrate?: boolean; readonly workscene?: boolean; readonly historyAfter?: number; readonly advancement?: boolean;
}

/** Only protocol identity fields are collected. Message bodies, tool payloads
 * and source text do not become historical read subjects. */
export function conversationDecisionScope(input: unknown, options: ConversationDecisionScope = {}): ConversationDecisionScope {
  const sets = Object.fromEntries(['runs', 'assignments', 'ingresses', 'tickets', 'requests', 'revisions', 'mirrorDigests', 'conflictKeys',
    'challenges', 'interactions', 'advancementIds', 'ticketDigests'].map(key => [key, new Set<string | number>()]));
  const names: Record<string, string> = { runId: 'runs', assignmentId: 'assignments', ingressKey: 'ingresses', ticketId: 'tickets',
    replacesTicketId: 'tickets', requestId: 'requests', challengeId: 'challenges', interactionRequestId: 'interactions',
    sessionId: 'advancementIds', nextSessionId: 'advancementIds', commitRevision: 'revisions', domainRevision: 'revisions', ticketDigest: 'ticketDigests' };
  let visited = 0;
  const visit = (value: unknown, depth: number, key = '') => {
    if (++visited > 8192 || depth > 10) return;
    if (depth > 1 && ['input', 'output', 'messages', 'parts', 'text', 'code', 'windowInput', 'originalUserTask', 'display'].includes(key)) return;
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return;
    const record = value as Record<string, unknown>;
    for (const [name, item] of Object.entries(record)) {
      const target = names[name];
      if (target && (typeof item === 'string' || target === 'revisions' && typeof item === 'number')) sets[target]!.add(item as string | number);
      visit(item, depth + 1, name);
    }
    if (typeof record.assignmentId === 'string' && typeof record.conflictingActivationDigest === 'string') sets.conflictKeys!.add(record.assignmentId + '\0' + record.conflictingActivationDigest);
    if (typeof record.assignmentId === 'string' && typeof record.mirrorDigest === 'string' && typeof record.previousDigest === 'string' && Array.isArray(record.entries)) {
      sets.mirrorDigests!.add(interactionMirrorBatchDigest(record as unknown as Parameters<typeof interactionMirrorBatchDigest>[0]));
    }
    const body = record.body as { t?: string; ingress?: { ingressId?: string } } | undefined;
    const principal = record.principal as { surfacePrincipal?: string } | undefined;
    if (body?.t === 'input' && typeof body.ingress?.ingressId === 'string' && typeof principal?.surfacePrincipal === 'string') {
      sets.ingresses!.add(canonicalize([principal.surfacePrincipal, body.ingress.ingressId]));
    }
  };
  visit(input, 0);
  if (Object.values(sets).some(values => values.size > 512)) throw new TypeError('Conversation decision has too many identity subjects');
  const result = Object.fromEntries(Object.entries(sets).map(([key, values]) => [key, [...values]]));
  return { ...result, ...options } as ConversationDecisionScope;
}

type InputValue = AdmittedProjection & { source: ConversationInputLocation };
const open = (state: ConversationRunState | undefined) => state !== undefined && ['queued', 'dispatched', 'running', 'cancel-requested', 'uncertain'].includes(state);

/** Read an indexed current/explicit working set at one prefix; materialize only
 * its live inputs/dispatches after releasing the source lock. */
export async function prepareConversationRunView(options: {
  log: AuthorityCommitLog; artifacts: ArtifactStore; verifier: ProtocolSignatureVerifier; conversationId: string;
  scope?: ConversationDecisionScope; previous?: RunProjection; legacy?: ConversationAbortTicketAuthorizer;
  baseSource?: ConversationBaseSource;
}) {
  const { log, artifacts, verifier, conversationId: id } = options, scope = options.scope ?? {};
  registerConversationRunProjection(log, artifacts, verifier, options.legacy);
  const selected = await log.transactDurableProjection<never, { metadata: ConversationRunView; version: string; source?: ConversationBaseSource }>(CONVERSATION_RUN_STATE_PROJECTION_ID,
    async current => {
      const binding = await current.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding | undefined;
      const view = await conversationViewAt(log, current, id);
      const source = binding ? await openConversationBase(log, binding) : undefined;
      if (options.baseSource && (!source || source.namespace !== options.baseSource.namespace)) throw new TypeError('Working set does not bind the published conversation base');
      return { kind: 'return', value: { metadata: await readConversationRunViewMetadata(view, id, scope),
        version: await conversationWorkingVersion(current, id), ...(source ? { source } : {}) } };
    });
  const source = selected.value.source;
  const state = await materializeConversationRunView({ ...options, scope, selected: selected.value.metadata,
    readEnvelopeAt: location => log.readEnvelopeAt(location),
    ...(source ? { readImportedRecord: location => source.record(location) } : {}),
    readAdvancementStatus: sessionId => readConversationExactValue(log, id, 'advancementStatuses', sessionId) });
  return { state, version: selected.value.version, cursor: selected.cursor };
}

export async function readConversationExactValue<T>(log: AuthorityCommitLog, id: string, name: string, key: string | number): Promise<T | undefined> {
  return (await log.transactDurableProjection<never, T | undefined>(CONVERSATION_RUN_STATE_PROJECTION_ID,
    async view => ({ kind: 'return', value: await field(await conversationViewAt(log, view, id), id, 'extra-' + name, key) as T | undefined }))).value;
}

export type ConversationRunView = Awaited<ReturnType<typeof readConversationRunViewMetadata>>;
export async function readConversationRunViewMetadata(view: import('@zhixing/core/authority').DurableProjectionReadContext, id: string, scope: ConversationDecisionScope) {
    const extra = await readConversationRunRoot(view, id);
    const fields = conversationFieldReader(view, id);
    const get = <T>(name: string, key: string | number) => fields.get<T>('extra-' + name, key);
    const preload = (subjects: Iterable<string | number>, names: readonly string[]) =>
      fields.preload([...subjects].flatMap(key => names.map(name => ['extra-' + name, key] as const)));
    const assignments = new Set(scope.assignments), runs = new Set(scope.runs), revisions = new Set(scope.revisions);
    const pending = async (name: string) => scope.current === false ? [] : (await scan(view, base(id) + 'pending-' + name + '/', 32)).map(entry => entry.value);
    const recover = await pending('recovery'), acknowledgements = await pending('ack'), projections = await pending('commit');
    for (const value of [...recover, ...acknowledgements, ...projections]) { if (typeof value !== 'string') throw Error('Invalid conversation obligation'); assignments.add(value); }
    if (extra.latestCommit) { assignments.add(extra.latestCommit.assignmentId); runs.add(extra.latestCommit.runId); }
    const commits = new Map<number, Extract<ConversationRunJournalRecord, { t: 'committed' }>>();
    if (scope.historyAfter !== undefined) {
      const p = base(id) + 'commit-order/'; let after = p + String(scope.historyAfter).padStart(16, '0');
      for (;;) {
        const page = await view.scan({ gt: after, lt: p + '\uffff' }, 64);
        for (const entry of page.entries) {
          if (typeof entry.value !== 'string') throw Error('Invalid commit directory'); assignments.add(entry.value);
        }
        if (!page.continuation) break; after = page.entries.at(-1)!.key;
      }
    }
    await preload(revisions, ['assignmentByCommitRevision']);
    for (const revision of revisions) {
      const assignment = await get<string>('assignmentByCommitRevision', revision);
      if (assignment) assignments.add(assignment);
    }
    const controls = new Map<string, { bundle: ArtifactRef; advancementSessionId?: string }>();
    // Workscene control records are read by exact run id from the caller's
    // bounded obligation set; the historical directory is never scanned.
    await preload(runs, ['committedByRun']);
    for (const runId of runs) {
      const committed = await get<Extract<ConversationRunJournalRecord, { t: 'committed' }>>('committedByRun', runId);
      if (committed) { commits.set(committed.commitRevision, committed); assignments.add(committed.assignmentId); }
    }
    const guard = await readConversationGuardView(view, id, { ...scope, current: scope.current ?? true, runs: [...runs], assignments: [...assignments] });
    const state = emptyConversationRunProjection(id), inputRows = new Map<string, InputValue>(), appendedRows = new Map<string, InputValue>();
    state.domainRevision = extra.domainRevision; state.deleted = extra.deleted; state.clearedThroughLsn = extra.clearedThroughLsn;
    state.clearedThroughRevision = extra.clearedThroughRevision;
    state.hasDurableIdentity = extra.hasDurableIdentity; state.pendingLifecycleCount = extra.pendingLifecycleCount;
    state.activeAdvancementSessionId = extra.activeAdvancementSessionId;
    state.advancementStatuses = new Map();
    state.sessionName = extra.sessionName; state.lastActiveAt = extra.lastActiveAt; state.sessionMeta = extra.sessionMeta;
    if (extra.taskList) state.taskList = structuredClone(extra.taskList);
    if (extra.latestSegment) state.segments.push(extra.latestSegment);
    const mutable = state as unknown as Record<string, unknown>;
    for (const name of ['runByIngress', 'stateByRun', 'queuedRunByPosition', 'queuedPositionHeap', 'queuedPositionHeapIndex', 'activeRunId',
      'supersedeRequests', 'cancelFences', 'resolutionsByRun', 'bundleAcknowledgements', 'ticketsById', 'ticketIdsByAssignment',
      'ticketReplacementsById', 'revokedTickets', 'ticketSyncFrontier', 'revokedCapabilities'] as const) mutable[name] = guard.state[name];
    for (const [runId] of guard.state.admittedByRun) runs.add(runId);
    for (const assignmentId of guard.state.assignedById.keys()) assignments.add(assignmentId);
    await preload(runs, ['admittedByRun', 'assignmentByRun', 'assignmentAttemptByRun', 'openInputAssignments',
      'statusHistoryByRun', 'worksceneControls', 'committedByRun']);
    for (const runId of runs) {
      const admitted = await get<InputValue>('admittedByRun', runId);
      if (admitted) { state.admittedByRun.set(runId, admitted); inputRows.set(runId, admitted); }
      const currentAssignment = await get<string>('assignmentByRun', runId);
      if (currentAssignment) state.assignmentByRun.set(runId, currentAssignment);
      const attempt = await get<number>('assignmentAttemptByRun', runId);
      if (attempt !== undefined) state.assignmentAttemptByRun?.set(runId, attempt);
      const opened = await get<string>('openInputAssignments', runId);
      if (opened) state.openInputAssignments.set(runId, opened);
      const status = await get<NonNullable<ReturnType<typeof state.statusHistoryByRun.get>>>('statusHistoryByRun', runId);
      if (status) state.statusHistoryByRun.set(runId, status);
      const control = await get<{ bundle: ArtifactRef; advancementSessionId?: string }>('worksceneControls', runId);
      if (control && scope.workscene) controls.set(runId, control);
      const committed = await get<Extract<ConversationRunJournalRecord, { t: 'committed' }>>('committedByRun', runId);
      if (committed) commits.set(committed.commitRevision, committed);
      if (open(state.stateByRun.get(runId)?.state) && scope.hydrate) {
        const keys = new Set<string>();
        for (const entry of await scan(view, base(id) + 'appended/' + hash(runId) + '/')) {
          if (typeof entry.value !== 'string') throw Error('Invalid appended input directory');
          const value = await get<InputValue>('appendedInputs', entry.value);
          if (!value) throw Error('Appended input pointer is missing');
          keys.add(entry.value); appendedRows.set(entry.value, value);
          state.appendedInputs.set(entry.value, value as unknown as NonNullable<ReturnType<typeof state.appendedInputs.get>>);
          state.runByIngress.set(entry.value, runId);
        }
        state.appendedInputKeysByRun.set(runId, keys);
      }
    }
    const assignmentFields = ['supersedeStartedObservations', 'conflictByAssignment', 'containmentByAssignment', 'acceptedCancellations',
      'superseded', 'cancelOrigins', 'uncertainOrigins', 'projectedByAssignment'] as const;
    await preload(assignments, [...assignmentFields, 'closedAssignments', 'closedInputAssignments', 'committedByAssignment', 'mirrorStateByAssignment']);
    for (const assignmentId of assignments) {
      const assigned = guard.state.assignedById.get(assignmentId);
      if (assigned) state.assignedById.set(assignmentId, { record: assigned.record,
        ...(assigned.commit ? { commit: assigned.commit } : {}), ...(assigned.origin ? { origin: assigned.origin } : {}), acked: assigned.acked });
      for (const name of assignmentFields) {
        const value = await get(name, assignmentId);
        if (value !== undefined) (state[name] as Map<string, unknown>).set(assignmentId, value);
      }
      for (const name of ['closedAssignments', 'closedInputAssignments'] as const) if (await get(name, assignmentId) === true) state[name].add(assignmentId);
      const committed = await get<Extract<ConversationRunJournalRecord, { t: 'committed' }>>('committedByAssignment', assignmentId);
      if (committed) {
        state.committedByAssignment.set(assignmentId, committed); state.assignmentByCommitRevision.set(committed.commitRevision, assignmentId); commits.set(committed.commitRevision, committed);
        if (projections.includes(assignmentId)) state.pendingCommitProjections.set(assignmentId, committed);
        const content = await get<NonNullable<ReturnType<typeof state.contentByRevision.get>>>('contentByRevision', committed.commitRevision);
        if (content) state.contentByRevision.set(committed.commitRevision, content);
      }
      if (recover.includes(assignmentId)) state.recoveryAssignments.add(assignmentId);
      if (acknowledgements.includes(assignmentId)) state.bundleAcknowledgementOutbox.add(assignmentId);
      for (const kind of ['cancel', 'supersede', 'dispatch-rejection']) {
        const key = assignmentId + '\0' + kind, rejected = await get<NonNullable<ReturnType<typeof state.rejectedNotStarted.get>>>('rejectedNotStarted', key);
        if (rejected) state.rejectedNotStarted.set(key, rejected);
      }
      const head = await get<{ ordinal: number; mirrorDigest: string; mirroredUpTo: number }>('mirrorStateByAssignment', assignmentId);
      if (head) {
        const requestIds = new Set<string>();
        for (const request of [...scope.requests ?? [], ...scope.interactions ?? []]) if (await get('mirrorRequests', assignmentId + '\0' + request)) requestIds.add(request);
        state.mirrorStateByAssignment.set(assignmentId, { ...head, requestIds });
      }
      if (scope.hydrate && assigned && open(state.stateByRun.get(assigned.record.runId)?.state)) for (const entry of await scan(view, base(id) + 'consumed/' + hash(assignmentId) + '/')) {
        if (typeof entry.value !== 'string') throw Error('Invalid input consumption directory');
        const value = await get<NonNullable<ReturnType<typeof state.inputConsumptions.get>>>('inputConsumptions', entry.value);
        if (!value) throw Error('Input consumption pointer is missing'); state.inputConsumptions.set(entry.value, value);
      }
    }
    state.commits.push(...[...commits.values()].sort((a, b) => a.commitRevision - b.commitRevision));
    await preload(scope.requests ?? [], ['sessionMetaByRequest', 'lifecycleByRequest', 'sessionMutationDigests', 'advancementWrites', 'taskListRequestIds']);
    for (const request of scope.requests ?? []) for (const name of ['sessionMetaByRequest', 'lifecycleByRequest', 'sessionMutationDigests', 'advancementWrites'] as const) {
      const value = await get(name, request); if (value !== undefined) (state[name] as Map<string, unknown>).set(request, value);
      if (name === 'sessionMutationDigests' && await get('taskListRequestIds', request)) state.taskListRequestIds.add(request);
    }
    for (const value of await pending('lifecycle')) {
      if (typeof value !== 'number') throw Error('Invalid lifecycle directory'); revisions.add(value);
    }
    for (const revision of revisions) {
      const value = await get<NonNullable<ReturnType<typeof state.pendingLifecycleProjections.get>>>('pendingLifecycleProjections', revision);
      if (value) state.pendingLifecycleProjections.set(revision, value);
      if (await get('projectedLifecycleRevisions', revision)) state.projectedLifecycleRevisions.add(revision);
    }
    for (const key of scope.conflictKeys ?? []) {
      const value = await get<NonNullable<ReturnType<typeof state.conflicts.get>>>('conflicts', key); if (value) state.conflicts.set(key, value);
    }
    for (const value of state.containmentByAssignment.values()) state.containedFacts.add(value.openFactDigest);
    const mirrors = new Map<string, ConversationInputLocation>();
    for (const digest of scope.mirrorDigests ?? []) { const value = await get<{ source: ConversationInputLocation }>('mirrorBatches', digest); if (value) mirrors.set(digest, value.source); }
    const challenges = new Set(scope.challenges);
    for (const value of await pending('channel')) { if (typeof value !== 'string') throw Error('Invalid channel obligation'); challenges.add(value); }
    for (const challenge of challenges) for (const name of ['preparedByChallenge', 'deliveredByChallenge', 'closedByChallenge'] as const) {
      const value = await get('channel-' + name, challenge); if (value) (state.channelInteractions[name] as Map<string, unknown>).set(challenge, value);
    }
    for (const assignmentId of assignments) for (const interaction of scope.interactions ?? []) {
      const key = assignmentId + '\0' + interaction, value = await get<string>('channel-challengeByInteraction', key);
      if (value) (state.channelInteractions.challengeByInteraction as Map<string, string>).set(key, value);
    }
    for (const prepared of state.channelInteractions.preparedByChallenge.values()) (state.channelInteractions.challengeByInteraction as Map<string, string>)
      .set(prepared.assignmentId + '\0' + prepared.token.interactionRequestId, prepared.token.challengeId);
    const advances = new Set([...scope.advancementIds ?? [], ...[...controls.values()].flatMap(value => value.advancementSessionId ? [value.advancementSessionId] : [])]);
    if (scope.advancement && extra.openAdvancementSessionId) advances.add(extra.openAdvancementSessionId);
    for (const sessionId of advances) {
      const status = await get<import('@zhixing/core/advancement').AdvancementSession['status']>('advancementStatuses', sessionId);
      if (status) state.advancementStatuses.set(sessionId, status);
      if (scope.advancement) {
        const value = await get<NonNullable<ReturnType<typeof state.advancementSessions.get>>>('advancementSessions', sessionId);
        if (value) state.advancementSessions.set(sessionId, value);
      }
    }
    return { state, version: guard.version, inputs: inputRows, appended: appendedRows, mirrors, controls };
}
export async function materializeConversationRunView(options: {
  conversationId: string; artifacts: ArtifactStore; verifier: ProtocolSignatureVerifier; scope: ConversationDecisionScope;
  selected: ConversationRunView; previous?: RunProjection;
  readEnvelopeAt(location: import('@zhixing/core/authority').DurableLogCheckpoint): Promise<import('@zhixing/core/contracts').CommitEnvelope<unknown>>;
  readImportedRecord?(location: import('./conversation-base-source.js').ConversationBaseLocation): Promise<import('./conversation-transfer.js').ConversationTransferAuthorityRecord>;
  readAdvancementStatus?(id: string): Promise<import('@zhixing/core/advancement').AdvancementSession['status'] | undefined>;
}) {
  const { conversationId: id, artifacts, verifier, scope, selected } = options;
  const { state, inputs, appended, mirrors, controls } = selected;
  const readAt = async (source: ConversationInputLocation) => {
    if ('imported' in source) {
      if (!options.readImportedRecord) throw new TypeError('Imported input requires its authenticated source reader');
      const record = await options.readImportedRecord(source.imported);
      if (record.stream !== 'run:' + id) throw new TypeError('Imported input locator belongs to another conversation');
      return record.body as unknown as ConversationRunJournalRecord;
    }
    const envelope = await options.readEnvelopeAt(source.checkpoint), entry = envelope.entries[source.item];
    if (!entry || entry.stream !== 'run:' + id) throw Error('Run state body locator changed');
    return entry.body as ConversationRunJournalRecord;
  };
  const materializeInput = async (row: InputValue): Promise<UserTurnInput> => {
    const record = await readAt(row.source);
    if (!('t' in record) || (record.t !== 'admitted' && record.t !== 'run-input-appended') || record.runId !== row.record.runId || record.ingressKey !== row.record.ingressKey) throw Error('Run input locator binding is invalid');
    const value = record.input && typeof record.input === 'object' && 'ref' in record.input
      ? JSON.parse(Buffer.from(await artifacts.get(record.input.ref)).toString('utf8')) as UserTurnInput : record.input;
    validateNonEmptyUserTurnInput(value); return value;
  };
  for (const [runId, row] of inputs) if (open(state.stateByRun.get(runId)?.state)) {
    const previous = options.previous?.admittedByRun.get(runId);
    const same = previous?.input && previous.lsn === row.lsn && canonicalize(previous.record) === canonicalize(row.record) &&
      (row.inputRef ? previous.inputRef?.digest === row.inputRef.digest && previous.inputRef.bytes === row.inputRef.bytes : previous.inputDigest === row.inputDigest);
    if (same || scope.hydrate) state.admittedByRun.set(runId, { ...row, input: same ? previous.input : await materializeInput(row) });
  }
  if (scope.hydrate) for (const [key, row] of appended) {
    const prior = options.previous?.appendedInputs.get(key);
    state.appendedInputs.set(key, { ...state.appendedInputs.get(key)!, input: prior?.input && prior.lsn === row.lsn ? prior.input : await materializeInput(row) });
  }
  for (const [assignmentId, assigned] of state.assignedById) if (open(state.stateByRun.get(assigned.record.runId)?.state)) {
    const previous = options.previous?.assignedById.get(assignmentId);
    if (previous?.envelope && previous.record.dispatchDigest === assigned.record.dispatchDigest && canonicalize(previous.record.dispatchRef) === canonicalize(assigned.record.dispatchRef)) state.assignedById.set(assignmentId, { ...assigned, envelope: previous.envelope });
    else if (scope.hydrate) {
      const bytes = await artifacts.get(assigned.record.dispatchRef);
      const dispatch = await verifyProtocolStep(() => validateConversationEnvelope(JSON.parse(Buffer.from(bytes).toString('utf8')), verifier));
      const { windowInput: _input, ...work } = dispatch.work; state.assignedById.set(assignmentId, { ...assigned, envelope: { ...dispatch, work } });
    }
  }
  for (const [digest, source] of mirrors) {
    const record = await readAt(source);
    if (!('t' in record) || record.t !== 'interaction-mirror' || interactionMirrorBatchDigest(record.batch) !== digest) throw Error('Mirror locator binding is invalid');
    state.mirrorBatches.set(digest, record);
  }
  for (const [runId, control] of controls) {
    const bundle = validateConversationSealedBundle(JSON.parse(Buffer.from(await artifacts.get(control.bundle)).toString('utf8')));
    const stored = bundle.body.runRecord;
    const record = validateTranscriptRunRecord(stored && typeof stored === 'object' && 'ref' in stored
      ? JSON.parse(Buffer.from(await artifacts.get(stored.ref)).toString('utf8')) as TranscriptRunRecord : stored, runId);
    state.worksceneControls.set(runId, { record, ...(control.advancementSessionId ? { advancementSessionId: control.advancementSessionId } : {}) });
    const invocation = state.admittedByRun.get(runId)?.record.invocation;
    const sessionId = control.advancementSessionId ?? record.advancement?.sessionId ?? (invocation?.kind === 'agent' ? invocation.advancement?.sessionId : undefined);
    if (sessionId && !state.advancementStatuses?.has(sessionId)) {
      const status = await options.readAdvancementStatus?.(sessionId);
      if (status) state.advancementStatuses?.set(sessionId, status);
    }
  }
  return state;
}
