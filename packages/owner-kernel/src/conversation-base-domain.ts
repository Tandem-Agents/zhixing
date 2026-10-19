import { collectArtifactRefs, artifactJsonIndex, createDurableProjectionOverlay, resolveDispatchArtifactClosure,
  type DurableProjectionReadContext, type DurableProjectionMutation } from '@zhixing/core/authority';
import type { JsonValue, LogicalRecord, TranscriptRunRecord, ArtifactRef } from '@zhixing/core/contracts';
import { canonicalize, validateConversationEnvelope, validateNonEmptyUserTurnInput, validateMutationBatch,
  validateIntentStreamRecord, reduceDeferredGlobalIntent, validateConversationSealedBundle, validateTranscriptRunRecord } from '@zhixing/core/protocol';
import { freezeAdvancementSessions } from '@zhixing/core/advancement';
import { parseConversationId } from '@zhixing/core/conversation';
import { reduceImportedConversationGuard, reduceConversationSessionFact, validateImportedConversationCommit, assertAssignedMatchesDispatch,
  type ConversationCommitLogRecord, type RunProjection, type ConversationFactGroup } from './conversation-assignment.js';
import { validateImportedConversationControl } from './control-admission.js';
import { ConversationDirectoryReducer, type ReadMeta } from './conversation-read-index.js';
import { readConversationRunRoot, foldConversationRunExtras } from './conversation-run-state-extras.js';
import { conversationDecisionScope, readConversationRunViewMetadata, materializeConversationRunView } from './conversation-run-state-view.js';
import { readConversationGuardView, conversationRecordScope, conversationGuardRows, storeConversationGuard,
  conversationStateBase as base, conversationStateHash as hash, readConversationStateField as field } from './conversation-run-state-index.js';
import { reduceConversationRecoveryFacts } from './conversation-recovery-index.js';
import type { ConversationBaseSource, ConversationBaseHeader, ConversationBaseLocation, AuthenticatedConversationFacts } from './conversation-base-source.js';
import { corruptRunJournal } from './conversation-run-contracts.js';

const ordinal = (value: number) => String(value).padStart(16, '0');
const controlKey = (id: string) => 'source/control/' + hash(id);
type ControlPair = { received?: ConversationBaseLocation; applied?: ConversationBaseLocation; ingressKey?: string };
const readers = new WeakMap<ConversationBaseSource, ConversationDirectoryReducer>();
const isSession = (type: unknown) => ['session-meta', 'session-control', 'session-lifecycle', 'advancement-event'].includes(String(type));
async function stored<T>(value: unknown, source: ConversationBaseSource): Promise<T> {
  return value && typeof value === 'object' && Object.keys(value).length === 1 && 'ref' in value
    ? JSON.parse(Buffer.from(await source.artifacts.get(value.ref as ArtifactRef)).toString('utf8')) as T : value as T;
}

/** Semantic reconstruction consumes only authenticated source groups. Local
 * WAL validation stays in the native reducers and is never selected by a flag. */
export async function prepareConversationBaseDomain(source: ConversationBaseSource, check: () => void): Promise<void> {
  const header = await source.cache.read(view => view.get('source/header')) as unknown as ConversationBaseHeader;
  if (header.phase === 'session') { await verifySessionSnapshot(source, header, check); return; }
  if (header.phase !== 'domain') return;
  if (header.domainNext === header.recordCount) {
    await source.cache.update(async view => {
      await assertFrozenDomain(source, view);
      const current = await view.get('source/header') as unknown as ConversationBaseHeader;
      return { mutations: [{ kind: 'put', key: 'source/header', value: { ...current, phase: 'session', sessionNext: 0 } as unknown as JsonValue }], value: undefined };
    });
    return;
  }
  let directory = readers.get(source);
  if (!directory) { directory = new ConversationDirectoryReducer(source.artifacts, source.verifier); readers.set(source, directory); }
  const id = source.manifest.conversationId;
  const context = { conversationId: id, verifier: source.verifier, artifacts: source.artifacts };
  const prepared: { group: AuthenticatedConversationFacts; scope: ReturnType<typeof conversationDecisionScope> }[] = [];
  let nextRecord = header.domainNext;
  // Keep original atomic groups intact, but publish a bounded group batch and
  // its progress once. A crash repeats at most this private candidate batch.
  while (nextRecord < header.recordCount && prepared.length < 16 && nextRecord - header.domainNext < 64) {
  check();
  const group = await source.group(nextRecord);
  if (!group) throw corruptRunJournal('Conversation source group is missing');
  const payloads: unknown[] = [];
  for (const entry of group.entries) {
    const body = entry.body as Record<string, unknown>;
    if (entry.stream === 'run:' + id && body?.t === 'advancement-event') payloads.push(await stored(body.event, source));
    if (entry.stream === 'publish' && body?.t === 'publish-decision') payloads.push(validateMutationBatch(await stored(body.batch, source)));
  }
  const scope = conversationDecisionScope({ entries: group.entries, payloads }, { current: false, hydrate: true,
    advancement: group.entries.some(entry => (entry.body as { t?: string })?.t === 'advancement-event'),
    allTickets: group.entries.some(entry => (entry.body as { t?: string })?.t === 'ticket-sync-frontier'), ticketAt: group.at });
  prepared.push({ group, scope }); nextRecord += group.entries.length;
  }
  await source.cache.update(async current => {
    const observed = await current.get('source/header') as unknown as ConversationBaseHeader;
    if (observed.phase !== 'domain' || observed.domainNext !== header.domainNext) return { mutations: [], value: undefined };
    const changes = new Map<string, JsonValue | undefined>(), view = createDurableProjectionOverlay(current, changes);
    const put = (key: string, value: unknown) => changes.set(key, value as JsonValue);
    const drop = (key: string) => changes.set(key, undefined);
    for (const { group, scope } of prepared) {
    const beforeRevision = (await readConversationRunRoot(view, id)).domainRevision;
    let previous: RunProjection | undefined;
    for (const [item, entry] of group.entries.entries()) {
      check();
      if (entry.stream === 'control') { await control(source, group, entry, item, view, put, drop); continue; }
      if (entry.stream === 'intent:' + id) {
        validateIntentStreamRecord(entry.body, entry.stream);
        const key = 'source/intent/' + hash(entry.body.intent.intentId);
        const prior = await view.get(key) as unknown as typeof entry.body.intent | undefined;
        const next = reduceDeferredGlobalIntent(prior, entry.body, entry.stream);
        put(key, next); changes.set('source/pending-intent/' + hash(next.intentId), next.status === 'pending' ? next.intentId : undefined);
        continue;
      }
      if (entry.stream !== 'run:' + id) continue;
      const body = entry.body as Record<string, unknown>;
      if (body.kind === 'content-asset-index') for (const ref of collectArtifactRefs(body.entries)) put('source/visible-asset/' + ref.digest, ref);
      const { state } = await readConversationGuardView(view, id, conversationRecordScope(body, group.at));
      const priorState = typeof body.runId === 'string' ? state.stateByRun.get(body.runId)?.state : undefined;
      const priorAssignment = typeof body.runId === 'string' ? state.assignmentByRun.get(body.runId) : undefined;
      const before = conversationGuardRows(id, state);
      let validated: RunProjection | undefined;
      if (isSession(body.t) || body.t === 'committed') {
        const selected = await readConversationRunViewMetadata(view, id, scope);
        validated = await materializeConversationRunView({ conversationId: id, artifacts: source.artifacts, verifier: source.verifier, scope,
          selected, previous, readEnvelopeAt: async () => { throw new TypeError('Imported source cannot read a target WAL cursor'); },
          readImportedRecord: location => source.recordForValidation(location, group, view) });
        previous = validated;
      }
      await reduceImportedConversationGuard(context, state, entry as LogicalRecord<ConversationCommitLogRecord>, group);
      if (body.t === 'assigned') {
        const assigned = state.assignedById.get(body.assignmentId as string);
        if (!assigned) throw corruptRunJournal('Imported assignment was not indexed');
        group.assertAssignment(assigned.record);
        const dispatch = validateConversationEnvelope(await stored({ ref: assigned.record.dispatchRef }, source), source.verifier);
        await resolveDispatchArtifactClosure(dispatch, source.artifacts);
        const admitted = state.admittedByRun.get(assigned.record.runId);
        if (!admitted) throw corruptRunJournal('Imported dispatch has no admitted input');
        assertAssignedMatchesDispatch(assigned.record, dispatch, admitted.ingress, id);
      } else if (body.t === 'admitted') {
        validateNonEmptyUserTurnInput(await stored(body.input, source));
      } else if (isSession(body.t)) {
        await reduceConversationSessionFact(context, validated!, body as never, group as ConversationFactGroup, group.sourceLsn);
      } else if (body.t === 'committed') {
        await validateImportedConversationCommit(context, validated!, body as never, group);
      }
      await storeConversationGuard(view, id, state, before, group.sourceLsn, changes);
      await foldConversationRunExtras({ id, entry, envelope: group, item, view, put, drop, artifacts: source.artifacts, verifier: source.verifier,
        guard: state, context, priorState, priorAssignment, validated });
      if (validated && body.t === 'advancement-event') for (const session of validated.advancementSessions.values()) {
        put('source/advancement-order/' + ordinal(Number.MAX_SAFE_INTEGER - Date.parse(session.createdAt)) + '/' + session.id, session.id);
      }
      if (body.t === 'committed') put('source/commit-group/' + hash(body.assignmentId), group.firstRecord);
    }
    const directoryChanges = await directory!.reduce(group.entries, group.at, group.sourceLsn, key => view.get('directory/' + key), undefined, group.firstRecord, async (range, limit) => {
      const prefix = 'directory/';
      const page = await view.scan({ ...(range.gt ? { gt: prefix + range.gt } : {}), ...(range.gte ? { gte: prefix + range.gte } : {}), ...(range.lt ? { lt: prefix + range.lt } : {}) }, limit);
      return { entries: page.entries.map(row => ({ key: row.key.slice(prefix.length), value: row.value })), ...(page.continuation ? { continuation: page.continuation.slice(prefix.length) } : {}) };
    });
    for (const mutation of directoryChanges) changes.set('directory/' + mutation.key, mutation.kind === 'put' ? mutation.value : undefined);
    for (const mutation of await reduceConversationRecoveryFacts(group.entries, group.at, group.sourceLsn, { imported: group.location(0) }, view, source.artifacts))
      changes.set(mutation.key, mutation.kind === 'put' ? mutation.value : undefined);
    const afterRevision = (await readConversationRunRoot(view, id)).domainRevision;
    if (afterRevision > beforeRevision) put('source/session-range/' + ordinal(afterRevision),
      { firstRevision: beforeRevision + 1, lastRevision: afterRevision, firstRecord: group.firstRecord });
    }
    put('source/header', { ...observed, domainNext: nextRecord });
    return { mutations: [...changes].map(([key, value]): DurableProjectionMutation => value === undefined ? { kind: 'tombstone', key } : { kind: 'put', key, value }), value: undefined };
  });
}

async function control(source: ConversationBaseSource, group: AuthenticatedConversationFacts, record: LogicalRecord<unknown>, item: number,
  view: DurableProjectionReadContext, put: (key: string, value: unknown) => void, drop: (key: string) => void): Promise<void> {
  const pair = async (id: string) => await view.get(controlKey(id)) as unknown as ControlPair | undefined;
  const load = async (location: ConversationBaseLocation | undefined) => {
    if (!location) return;
    const value = await source.recordForValidation(location, group, view);
    return { stream: value.stream, body: value.body };
  };
  const result = await validateImportedConversationControl({ group, record, artifacts: source.artifacts,
    received: async id => load((await pair(id))?.received), applied: async id => load((await pair(id))?.applied),
    ingress: async key => { const id = await view.get('source/ingress-control/' + hash(key)); return typeof id === 'string' ? load((await pair(id))?.received) : undefined; } });
  const previous = await pair(result.requestId), location = group.location(item);
  put(controlKey(result.requestId), { ...previous,
    ...(result.received && !previous?.received ? { received: location } : {}), ...(!result.received ? { applied: location } : {}),
    ...(result.ingressKey ? { ingressKey: result.ingressKey } : {}) });
  if (result.ingressKey) put('source/ingress-control/' + hash(result.ingressKey), result.requestId);
  if (result.applied) drop('source/pending-control/' + hash(result.requestId)); else put('source/pending-control/' + hash(result.requestId), result.requestId);
  const body = record.body as { t: string; result?: unknown };
  if (body.t === 'applied') {
    const outcome = await stored<{ status?: string }>(body.result, source);
    const received = await load((await pair(result.requestId))?.received);
    const receivedBody = received?.body as { envelope?: unknown } | undefined;
    const request = await stored<{ body: { t: string; attachments?: unknown }; dependencyArtifacts?: unknown }>(receivedBody?.envelope, source);
    if (outcome.status === 'ok' && request.body.t === 'input')
      for (const ref of collectArtifactRefs([request.body.attachments ?? [], request.dependencyArtifacts ?? []])) put('source/visible-asset/' + ref.digest, ref);
  }

}

async function assertFrozenDomain(source: ConversationBaseSource, view: DurableProjectionReadContext): Promise<void> {
  const id = source.manifest.conversationId, root = await readConversationRunRoot(view, id);
  if (!root.hasDurableIdentity || root.deleted) throw corruptRunJournal('Frozen conversation is missing or deleted');
  if ((await view.scan({ gte: 'source/pending-control/', lt: 'source/pending-control/\uffff' }, 1)).entries.length) throw corruptRunJournal('Frozen conversation has an unapplied control request');
  let after: string | undefined;
  const p = base(id) + 'open-run/';
  do {
    const page = await view.scan({ ...(after ? { gt: after } : { gte: p }), lt: p + '\uffff' }, 64);
    for (const row of page.entries) {
      if (typeof row.value !== 'string') throw corruptRunJournal('Frozen run directory is invalid');
      const state = await field(view, id, 'stateByRun', row.value) as { state: string } | undefined;
      if (state?.state !== 'queued') throw corruptRunJournal('Frozen conversation still has an executing or unresolved assignment');
    }
    after = page.continuation ? page.entries.at(-1)!.key : undefined;
  } while (after);
  // Source assignment effects must have settled before the source's signed
  // freeze. Queued inputs and explicit deferred intents can continue at target.
  for (const suffix of ['pending-recovery/', 'pending-ack/', 'pending-commit/', 'pending-lifecycle/']) {
    const prefix = base(id) + suffix;
    if ((await view.scan({ gte: prefix, lt: prefix + '\uffff' }, 1)).entries.length) throw corruptRunJournal('Frozen conversation has unsettled source projection work');
  }
  const key = 'conversation/' + (await import('@zhixing/core/protocol')).protocolDigest('ConversationRecoveryKey', 1, id).slice(7);
  const obligations = await view.get(key) as unknown as { assignments: number; lifecycle: number } | undefined;
  if (obligations && (obligations.assignments !== 0 || obligations.lifecycle !== 0)) throw corruptRunJournal('Frozen conversation has unsettled source publication or finality');
}

async function verifySessionSnapshot(source: ConversationBaseSource, header: ConversationBaseHeader, check: () => void): Promise<void> {
  const ref = source.manifest.authorityBase.sessionState, json = artifactJsonIndex(source.artifacts);
  while (!(await json.prepare(ref)).ready) { check(); await new Promise<void>(setImmediate); }
  const rootNode = await json.node(ref, []), transcript = await json.node(ref, ['transcript']);
  if (rootNode?.kind !== 'object' || rootNode.units !== 4 || transcript?.kind !== 'array') throw corruptRunJournal('Conversation session snapshot fields are invalid');
  const id = source.manifest.conversationId;
  const domain = await source.cache.read(async view => ({ root: await readConversationRunRoot(view, id),
    directory: await view.get('directory/' + JSON.stringify(id) + ':meta') as unknown as ReadMeta | undefined }));
  const meta = domain.directory ?? { count: 0, clearedThrough: 0, baseRevision: 0, activity: '1970-01-01T00:00:00.000Z' };
  const scope = parseConversationId(id).scope;
  const expectedMeta = { conversationId: id, ownerEpoch: source.manifest.sourceOwnerEpoch, baseRevision: meta.baseRevision, turnCount: meta.count,
    ...(meta.name ? { name: meta.name } : {}), ...(scope.kind === 'workscene' ? { sceneId: scope.sceneId } : {}), lastActiveAt: meta.sessionActivity ?? meta.activity };
  if (canonicalize(await json.value(ref, ['meta'])) !== canonicalize(expectedMeta) || transcript.units !== meta.count) throw corruptRunJournal('Conversation session meta or transcript count contradicts its source facts');
  const taskNode = await json.node(ref, ['taskList']);
  if (!taskNode || canonicalize(await json.value(ref, ['taskList'], taskNode.hi - taskNode.lo)) !== canonicalize(domain.root.taskList ?? { items: [] })) throw corruptRunJournal('Conversation task list contradicts its source facts');
  const next = (header as ConversationBaseHeader & { sessionNext?: number }).sessionNext ?? 0;
  const progress = await source.cache.read(view => view.get('source/session-progress')) as unknown as { next: number; revision: number } | undefined;
  const from = progress?.next ?? next, revision = progress?.revision ?? meta.clearedThrough;
  const p = base(id) + 'commit-order/';
  const page = await source.cache.read(view => view.scan({ gt: p + ordinal(revision), lt: p + '\uffff' }, 32));
  let lastRevision = revision, index = from;
  for (const row of page.entries) {
    if (typeof row.value !== 'string') throw corruptRunJournal('Imported commit order is invalid');
    const commit = await source.cache.read(view => field(view, id, 'extra-committedByAssignment', row.value as string)) as { bundle: { ref: ArtifactRef }; runId: string; commitRevision: number };
    const bundle = validateConversationSealedBundle(await stored({ ref: commit.bundle.ref }, source));
    if (bundle.body.t !== 'conversation') throw corruptRunJournal('Imported transcript names another execution kind');
    const actual = validateTranscriptRunRecord(await stored<TranscriptRunRecord>(bundle.body.runRecord, source), commit.runId);
    const node = await json.node(ref, ['transcript', index]);
    if (!node || canonicalize(await json.value(ref, ['transcript', index], node.hi - node.lo)) !== canonicalize(actual)) throw corruptRunJournal('Conversation transcript snapshot contradicts its source facts');
    index++; lastRevision = commit.commitRevision; check();
  }
  if (!page.continuation) {
    if (index !== transcript.units) throw corruptRunJournal('Conversation transcript snapshot is incomplete');
    const expectedAdvance = await source.cache.read(async view => {
      const first = domain.root.openAdvancementSessionId ??
        (await view.scan({ gte: 'source/advancement-order/', lt: 'source/advancement-order/\uffff' }, 1)).entries[0]?.value;
      if (typeof first !== 'string') return null;
      const session = await field(view, id, 'extra-advancementSessions', first) as NonNullable<ReturnType<RunProjection['advancementSessions']['get']>>;
      // Public snapshots are JSON values; optional DTO fields disappear when
      // the source persists the snapshot, just as in the target expectation.
      return JSON.parse(JSON.stringify(freezeAdvancementSessions(new Map([[first, session]]))[0]!));
    });
    const advanceNode = await json.node(ref, ['advancement']);
    if (!advanceNode || canonicalize(await json.value(ref, ['advancement'], advanceNode.hi - advanceNode.lo)) !== canonicalize(expectedAdvance)) throw corruptRunJournal('Conversation advancement snapshot contradicts its source facts');
  }
  await source.cache.update(async view => {
    const current = await view.get('source/header') as unknown as ConversationBaseHeader;
    if (current.phase !== 'session') return { mutations: [], value: undefined };
    return { mutations: [
      { kind: 'put', key: 'source/session-progress', value: { next: index, revision: lastRevision } },
      { kind: 'put', key: 'source/header', value: { ...current, phase: page.continuation ? 'session' : 'ready', sessionNext: index } as unknown as JsonValue },
    ], value: undefined };
  });
}
