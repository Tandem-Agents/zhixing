import type { ArtifactStore, AuthorityCommitLog, DurableProjectionMutation, DurableProjectionReadContext } from '@zhixing/core/authority';
import { createDurableProjectionOverlay, readDurableProjectionKeys } from '@zhixing/core/authority';
import type { JsonValue, LogicalRecord, CommitEnvelope, ReservableResourceLease, UsageReport } from '@zhixing/core/contracts';
import { canonicalize, protocolDigest, validateGovernorRecord, requiresFormalResourceCoordination, dataPlaneTicketDigest,
  type ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { emptySubmissionGuardProjection, reduceConversationSubmissionGuard, reduceConversationRunState,
  type RunProjection, type ConversationRunReductionContext, type SubmissionGuardProjection, type ConversationCommitLogRecord, type ConversationAbortTicketAuthorizer } from './conversation-assignment.js';
import { assertAssignmentActivationEvidence, assertAssignmentTerminalEvidence, assertAssignmentUsageEvidence } from './conversation-resource-witness.js';
import { conversationDecisionScope, readConversationRunViewMetadata, materializeConversationRunView } from './conversation-run-state-view.js';
import { dataPlaneTicketSyncBoundary } from './data-plane-ticket-lifecycle.js';
import { foldConversationRunExtras } from './conversation-run-state-extras.js';
import { foldConversationBaseBindings, preserveBaseDeletions, registerConversationBaseContext, registerConversationBaseRepair, conversationBaseUnavailableKey, conversationBaseRepairRequired, conversationViewAt, conversationBaseKey, openConversationBase, type ConversationBaseBinding } from './conversation-base-registry.js';

export const CONVERSATION_RUN_STATE_PROJECTION_ID = 'conversation-run-state-v1';
export const CONVERSATION_SUBMISSION_STATE_PROJECTION_ID = 'conversation-submission-state-v1';
const hash = (value: unknown) => protocolDigest('ConversationStateKey', 1, value).slice(7);
const base = (id: string) => 'conversation/' + hash(id) + '/';
const fieldPrefix = (id: string, field: string) => base(id) + 'guard/' + field + '/';
const fieldKey = (id: string, field: string, key: string | number) => fieldPrefix(id, field) + hash(key);
const rootKey = (id: string) => base(id) + 'root';
interface Root { conversationId: string; version: number; activeRunId?: string; ticketSyncFrontier?: string }
interface Row { key: string | number; value: JsonValue }
interface ResourceWitness { lease?: ReservableResourceLease; watermark: number; usages: UsageReport['usages']; openUsageReservations: number }
export interface ConversationRunScope {
  readonly current?: boolean;
  readonly runs?: readonly string[];
  readonly assignments?: readonly string[];
  readonly ingresses?: readonly string[];
  readonly tickets?: readonly string[];
  readonly ticketDigest?: string;
  readonly ticketDigests?: readonly string[];
  readonly allTickets?: boolean;
  readonly ticketAt?: string;
}

// Every composite is tagged, so user-supplied metadata cannot be mistaken for
// the internal Set representation. Collections are encoded per entry, not as
// a complete historical projection.
function encode(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (value instanceof Set) return { t: 'set', v: [...value].map(encode) };
  if (value instanceof Map) return { t: 'map', v: [...value].map(([key, item]) => [encode(key), encode(item)]) };
  if (Array.isArray(value)) return { t: 'array', v: value.map(encode) };
  if (value && typeof value === 'object') return { t: 'object', v: Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, encode(item)])) };
  throw new TypeError('Invalid conversation state value');
}
function decode(value: JsonValue): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) throw new TypeError('Invalid conversation state encoding');
  const payload = value.v;
  if (value.t === 'object' && payload && typeof payload === 'object' && !Array.isArray(payload)) return Object.fromEntries(Object.entries(payload).map(([key, item]) => [key, decode(item)]));
  if (!Array.isArray(payload)) throw new TypeError('Invalid conversation state encoding');
  if (value.t === 'set') return new Set(payload.map(decode));
  if (value.t === 'array') return payload.map(decode);
  if (value.t === 'map') return new Map(payload.map(item => {
    if (!Array.isArray(item) || item.length !== 2) throw new TypeError('Invalid conversation map encoding');
    return [decode(item[0]!), decode(item[1]!)];
  }));
  throw new TypeError('Invalid conversation state tag');
}
async function scan(view: DurableProjectionReadContext, prefix: string, limit = Infinity) {
  const entries: { key: string; value: JsonValue }[] = []; let after: string | undefined;
  do {
    const page = await view.scan({ ...(after ? { gt: after } : { gte: prefix }), lt: prefix + '\uffff' }, Math.min(64, limit - entries.length));
    entries.push(...page.entries); after = page.continuation ? page.entries.at(-1)!.key : undefined;
  } while (after && entries.length < limit);
  return entries;
}
async function field(view: DurableProjectionReadContext, id: string, name: string, key: string | number): Promise<unknown> {
  const row = await view.get(fieldKey(id, name, key)) as unknown as Row | undefined;
  if (!row) return;
  if (row.key !== key) throw Error('Conversation state key binding is invalid');
  return decode(row.value);
}

/** This cache belongs to one fixed read view, never to a later decision. */
export function conversationFieldReader(view: DurableProjectionReadContext, id: string) {
  const values = new Map<string, unknown>();
  const preload = async (fields: readonly (readonly [string, string | number])[]) => {
    const pending = new Map(fields.map(([name, key]) => [fieldKey(id, name, key), key]));
    const entries = [...pending].filter(([key]) => !values.has(key));
    for (let offset = 0; offset < entries.length; offset += 256) {
      const batch = entries.slice(offset, offset + 256);
      const rows = await readDurableProjectionKeys(view, batch.map(([key]) => key));
      for (let n = 0; n < batch.length; n++) {
        const [storageKey, key] = batch[n]!, row = rows[n] as unknown as Row | undefined;
        if (row && row.key !== key) throw Error('Conversation state key binding is invalid');
        values.set(storageKey, row ? decode(row.value) : undefined);
      }
    }
  };
  return { preload, async get<T = unknown>(name: string, key: string | number): Promise<T | undefined> {
    await preload([[name, key]]); return values.get(fieldKey(id, name, key)) as T | undefined;
  } };
}
const runMaps = ['admittedByRun', 'assignmentByRun', 'assignmentAttemptByRun', 'stateByRun', 'resolutionsByRun'] as const;
const assignmentMaps = ['assignedById', 'supersedeRequests', 'cancelFences', 'committedByAssignment', 'bundleAcknowledgements'] as const;
const assignmentSets = ['conflictAssignments', 'openConflictAssignments', 'supersedeStartedAssignments', 'acceptedCancellations', 'durableStartedAssignments', 'closedAssignments'] as const;

/** Reconstruct a finite metadata view. The complete queue is current work;
 * terminated run/assignment identities are loaded only when requested. */
async function readGuard(view: DurableProjectionReadContext, id: string, scope: ConversationRunScope) {
  const state = emptySubmissionGuardProjection();
  const fields = conversationFieldReader(view, id);
  const root = await view.get(rootKey(id)) as unknown as Root | undefined;
  if (root && root.conversationId !== id) throw Error('Conversation state root binding is invalid');
  state.activeRunId = root?.activeRunId; state.ticketSyncFrontier = root?.ticketSyncFrontier;
  const runs = new Set(scope.runs), assignments = new Set(scope.assignments), ingresses = new Set(scope.ingresses), tickets = new Set(scope.tickets);
  if (root?.activeRunId) runs.add(root.activeRunId);
  for (const entry of await scan(view, fieldPrefix(id, 'queuedRunByPosition'))) {
    const row = entry.value as unknown as Row, runId = decode(row.value);
    if (typeof row.key !== 'number' || typeof runId !== 'string' || entry.key !== fieldKey(id, 'queuedRunByPosition', row.key)) throw Error('Conversation queue binding is invalid');
    state.queuedRunByPosition.set(row.key, runId);
    if (scope.current) runs.add(runId);
  }
  state.queuedPositionHeap.push(...[...state.queuedRunByPosition.keys()].sort((a, b) => a - b));
  for (const [index, position] of state.queuedPositionHeap.entries()) state.queuedPositionHeapIndex.set(position, index);
  if (scope.current) for (const entry of await scan(view, base(id) + 'open-run/')) {
    if (typeof entry.value !== 'string') throw Error('Current run directory is invalid'); runs.add(entry.value);
  }
  await fields.preload([...ingresses].map(key => ['runByIngress', key] as const));
  for (const ingress of ingresses) {
    const runId = await fields.get('runByIngress', ingress);
    if (typeof runId === 'string') { state.runByIngress.set(ingress, runId); runs.add(runId); }
  }
  const digests = [...(scope.ticketDigests ?? []), ...(scope.ticketDigest ? [scope.ticketDigest] : [])];
  for (const digest of digests) {
    const ticketId = await view.get(base(id) + 'ticket-digest/' + hash(digest));
    if (typeof ticketId === 'string') tickets.add(ticketId);
  }
  await fields.preload([...tickets].flatMap(key => ['ticketsById', 'revokedTickets', 'ticketReplacementsById'].map(name => [name, key] as const)));
  for (const ticketId of tickets) {
    const ticket = await fields.get('ticketsById', ticketId) as SubmissionGuardProjection['ticketsById'] extends Map<string, infer T> ? T | undefined : never;
    if (ticket) { state.ticketsById.set(ticketId, ticket); assignments.add(ticket.assignmentId); }
  }
  // Exact assignment lookups discover their run; run lookups discover the
  // current assignment. Two passes close this finite relation.
  for (let pass = 0; pass < 2; pass++) {
    await fields.preload([...assignments].map(key => ['assignedById', key] as const));
    for (const assignmentId of assignments) {
      if (state.assignedById.has(assignmentId)) continue;
      const assigned = await fields.get('assignedById', assignmentId) as ReturnType<typeof state.assignedById.get>;
      if (assigned) { state.assignedById.set(assignmentId, assigned); runs.add(assigned.record.runId); }
    }
    await fields.preload([...runs].flatMap(key => runMaps.map(name => [name, key] as const)));
    for (const runId of runs) for (const name of runMaps) {
      const value = await fields.get(name, runId);
      if (value !== undefined) (state[name] as Map<string, unknown>).set(runId, value);
      if (name === 'assignmentByRun' && typeof value === 'string') assignments.add(value);
      if (name === 'admittedByRun' && value) {
        const admitted = value as NonNullable<ReturnType<typeof state.admittedByRun.get>>;
        ingresses.add(admitted.ingressKey); state.runByIngress.set(admitted.ingressKey, runId);
      }
    }
  }
  await fields.preload([...assignments].flatMap(key => [...assignmentMaps, ...assignmentSets].map(name => [name, key] as const)));
  for (const assignmentId of assignments) {
    for (const name of assignmentMaps) {
      const value = await fields.get(name, assignmentId);
      if (value !== undefined) (state[name] as Map<string, unknown>).set(assignmentId, value);
    }
    for (const name of assignmentSets) if (await fields.get(name, assignmentId) === true) state[name].add(assignmentId);
    for (const capId of state.assignedById.get(assignmentId)?.record.capIds ?? []) {
      const key = assignmentId + '\0' + capId;
      if (await fields.get('revokedCapabilities', key) === true) state.revokedCapabilities.add(key);
    }
    const ids = new Set<string>();
    for (const entry of await scan(view, base(id) + 'ticket-pending/' + hash(assignmentId) + '/')) {
      if (typeof entry.value !== 'string') throw Error('Ticket directory is invalid'); ids.add(entry.value); tickets.add(entry.value);
    }
    // A failed historical ticket match must not accidentally enable the legacy
    // fallback merely because all owner-issued tickets have since been revoked.
    if (digests.length && ids.size === 0) {
      const any = await view.get(base(id) + 'ticket-any/' + hash(assignmentId));
      if (typeof any === 'string') { ids.add(any); tickets.add(any); }
    }
    state.ticketIdsByAssignment.set(assignmentId, ids);
  }
  if (scope.allTickets) {
    if (!scope.ticketAt) throw Error('Ticket evidence requires a fixed observation time');
    const p = base(id) + 'ticket-expiry-reverse/';
    const lastExpired = await view.scan({ gte: p + String(Number.MAX_SAFE_INTEGER - Date.parse(scope.ticketAt)).padStart(16, '0'), lt: p + '\uffff' }, 1);
    let through = root?.ticketSyncFrontier;
    for (const entry of lastExpired.entries) {
      if (typeof entry.value !== 'string') throw Error('Ticket expiry directory is invalid');
      tickets.add(entry.value);
      const ticket = await fields.get('ticketsById', entry.value) as NonNullable<ReturnType<typeof state.ticketsById.get>>;
      const boundary = dataPlaneTicketSyncBoundary(ticket);
      if (!through || boundary > through) through = boundary;
    }
    const prefix = base(id) + 'ticket-expiry/'; let after = through ? prefix + through + '/\uffff' : undefined;
    do {
      const page = await view.scan({ ...(after ? { gt: after } : { gte: prefix }), lt: prefix + '\uffff' }, 64);
      for (const entry of page.entries) { if (typeof entry.value !== 'string') throw Error('Ticket expiry directory is invalid'); tickets.add(entry.value); }
      after = page.continuation ? page.entries.at(-1)!.key : undefined;
    } while (after);
  }
  await fields.preload([...tickets].flatMap(key => ['ticketsById', 'revokedTickets', 'ticketReplacementsById'].map(name => [name, key] as const)));
  for (const ticketId of tickets) {
    const ticket = state.ticketsById.get(ticketId) ?? await fields.get('ticketsById', ticketId) as ReturnType<typeof state.ticketsById.get>;
    if (ticket) {
      state.ticketsById.set(ticketId, ticket);
      const ids = state.ticketIdsByAssignment.get(ticket.assignmentId) ?? new Set<string>(); ids.add(ticketId); state.ticketIdsByAssignment.set(ticket.assignmentId, ids);
    }
    if (await fields.get('revokedTickets', ticketId) === true) state.revokedTickets.add(ticketId);
    const replacement = await fields.get('ticketReplacementsById', ticketId);
    if (typeof replacement === 'string') state.ticketReplacementsById.set(ticketId, replacement);
  }
  return { state, version: root?.version ?? 0 };
}

function rowsOf(id: string, state: SubmissionGuardProjection) {
  const rows = new Map<string, JsonValue>();
  for (const [name, value] of Object.entries(state)) {
    if (name === 'queuedPositionHeapIndex' || name === 'ticketIdsByAssignment') continue;
    if (value instanceof Map) for (const [key, item] of value) rows.set(fieldKey(id, name, key), { key, value: encode(item) });
    else if (value instanceof Set) for (const key of value) rows.set(fieldKey(id, name, key), { key, value: true });
  }
  return rows;
}
function scopeFor(body: Record<string, unknown>, at: string): ConversationRunScope {
  const run = body.runId ?? (body.ref as { runId?: unknown } | undefined)?.runId ?? (body.fact as { subject?: { runId?: unknown } } | undefined)?.subject?.runId;
  const assignment = body.assignmentId ?? (body.ticket as { assignmentId?: unknown } | undefined)?.assignmentId ??
    (body.fact as { subject?: { assignmentId?: unknown } } | undefined)?.subject?.assignmentId;
  const ticket = body.ticketId ?? (body.ticket as { ticketId?: unknown } | undefined)?.ticketId;
  const proof = body.proof as { ticketDigest?: unknown } | undefined;
  return { ...(typeof run === 'string' ? { runs: [run] } : {}), ...(typeof assignment === 'string' ? { assignments: [assignment] } : {}),
    ...(typeof body.ingressKey === 'string' ? { ingresses: [body.ingressKey] } : {}),
    tickets: [ticket, body.replacesTicketId].filter((value): value is string => typeof value === 'string'),
    ...(typeof proof?.ticketDigest === 'string' ? { ticketDigest: proof.ticketDigest } : {}), allTickets: body.t === 'ticket-sync-frontier', ticketAt: at };
}
type ValidationBinding = Pick<ConversationRunReductionContext, 'delivery' | 'currentAuthority' | 'resources'>;
type Binding = { index: ReturnType<AuthorityCommitLog['durableProjection']>; verifier: ProtocolSignatureVerifier; legacy?: ConversationAbortTicketAuthorizer; validation?: ValidationBinding };
const bindings = new WeakMap<AuthorityCommitLog, Binding>();
const submissionBindings = new WeakMap<AuthorityCommitLog, Binding>();

export function registerConversationRunProjection(log: AuthorityCommitLog, _artifacts: ArtifactStore, verifier: ProtocolSignatureVerifier,
  legacy?: ConversationAbortTicketAuthorizer, validation?: ValidationBinding) {
  registerConversationBaseContext(log, _artifacts, verifier);
  const index = registerConversationStateProjection(log, _artifacts, verifier, false, legacy, validation);
  registerConversationStateProjection(log, _artifacts, verifier, true, legacy, validation);
  return index;
}

function registerConversationStateProjection(log: AuthorityCommitLog, _artifacts: ArtifactStore, verifier: ProtocolSignatureVerifier,
  metadataOnly: boolean, legacy?: ConversationAbortTicketAuthorizer, validation?: ValidationBinding) {
  const registry = metadataOnly ? submissionBindings : bindings;
  const found = registry.get(log);
  if (found) { if (found.verifier !== verifier) throw Error('Conversation state verifier changed'); if (legacy) found.legacy = legacy;
    if (validation) found.validation = { ...found.validation, ...Object.fromEntries(Object.entries(validation).filter(([, value]) => value !== undefined)) };
    return found.index; }
  const binding = { verifier, legacy, validation, index: undefined as unknown as ReturnType<AuthorityCommitLog['durableProjection']> };
  const index = log.durableProjection<unknown>({ projectionId: metadataOnly ? CONVERSATION_SUBMISSION_STATE_PROJECTION_ID : CONVERSATION_RUN_STATE_PROJECTION_ID, reducerVersion: 2,
    inputs: { families: ['run:', 'transfer:'], streams: ['governor'] },
    async reduce(envelope, current, source) {
      const changes = new Map<string, JsonValue | undefined>();
      const baseChanges = new Map<string, JsonValue | undefined>();
      await foldConversationBaseBindings(log, envelope.entries, current, baseChanges, source, true);
      for (const [key, value] of baseChanges) changes.set(key, value);
      const view = createDurableProjectionOverlay(current, changes);
      const put = (key: string, value: unknown) => changes.set(key, value as JsonValue);
      const canonicalStates = new Map<string, RunProjection>();
      const conversations = new Set<string>();
      for (const entry of envelope.entries) {
        if (entry.stream !== 'governor') continue;
        const body = validateGovernorRecord(entry.body, verifier);
        if (body.t === 'reserve') {
          const key = 'resource/' + hash(body.lease.reservationId), prior = await view.get(key) as unknown as ResourceWitness | undefined;
          if (prior?.lease && canonicalize(prior.lease) !== canonicalize(body.lease)) throw Error('Resource reservation identity changed');
          put(key, { lease: body.lease, watermark: prior?.watermark ?? 0, usages: prior?.usages ?? [], openUsageReservations: prior?.openUsageReservations ?? 0 });
        } else if (body.t === 'usage-reserved') {
          const heldKey = 'resource-hold/' + hash(body.usageId), held = await view.get(heldKey) as { reservation?: JsonValue; consumed?: boolean } | undefined;
          if (held) { if (canonicalize(held.reservation) !== canonicalize(body)) throw Error('Resource usage reservation identity changed'); continue; }
          const key = 'resource/' + hash(body.rootReservationId), prior = await view.get(key) as unknown as ResourceWitness | undefined;
          if (!prior?.lease) throw Error('Resource usage reservation has no root');
          put(heldKey, { reservation: body, consumed: false });
          put(key, { ...prior, openUsageReservations: prior.openUsageReservations + 1 });
        } else if (body.t === 'consume') {
          const key = 'resource/' + hash(body.rootReservationId), prior = await view.get(key) as unknown as ResourceWitness | undefined;
          const usage = { usageSeq: body.usageSeq, reservationId: body.reservationId, usageId: body.usageId,
            ...(body.tokens ? { tokens: body.tokens } : {}), ...(body.calls ? { calls: body.calls } : {}), ...(body.costMinor ? { costMinor: body.costMinor } : {}) };
          const seenKey = 'resource-usage/' + hash(body.usageId), seen = await view.get(seenKey);
          if (seen !== undefined) { if (canonicalize(seen) !== canonicalize({ root: body.rootReservationId, usage })) throw Error('Resource usage identity changed'); continue; }
          if (!prior?.lease || body.usageSeq !== prior.watermark + 1) throw Error('Resource usage witness is not continuous');
          const heldKey = 'resource-hold/' + hash(body.usageId), held = await view.get(heldKey) as unknown as { reservation: { rootReservationId: string; reservationId: string }; consumed: boolean } | undefined;
          if (!held || held.consumed || held.reservation.rootReservationId !== body.rootReservationId || held.reservation.reservationId !== body.reservationId || prior.openUsageReservations < 1) throw Error('Resource usage has no matching reservation');
          put(heldKey, { ...held, consumed: true });
          put(key, { ...prior, openUsageReservations: prior.openUsageReservations - 1, watermark: body.usageSeq, usages: [...((body.usageSeq - 1) % 256 === 0 ? [] : prior.usages), usage] });
          put(seenKey, { root: body.rootReservationId, usage });
        }
      }
      for (const [item, entry] of envelope.entries.entries()) {
        if (!entry.stream.startsWith('run:')) continue;
        const id = entry.stream.slice(4), body = entry.body as Record<string, unknown>;
        if (await view.get(conversationBaseUnavailableKey(id))) {
          if (source.candidate) throw conversationBaseRepairRequired(log, await view.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding);
          continue;
        }
        conversations.add(id);
        const runView = await conversationViewAt(log, view, id, changes);
        const { state } = await readGuard(runView, id, scopeFor(body, envelope.at));
        const priorState = typeof body.runId === 'string' ? state.stateByRun.get(body.runId)?.state : undefined;
        const priorAssignment = typeof body.runId === 'string' ? state.assignmentByRun.get(body.runId) : undefined;
        const before = rowsOf(id, state);
        const witnesses = new Map<string, ResourceWitness>();
        for (const assigned of state.assignedById.values()) {
          const reservationId = assigned.record.reservation.reservationId;
          const witness = await view.get('resource/' + hash(reservationId)) as unknown as ResourceWitness | undefined;
          if (witness) witnesses.set(reservationId, witness);
        }
        const context = { conversationId: id, verifier, legacyAbortTickets: binding.legacy,
          assertResourceTerminalRecords(assigned, mode, records) {
            if (witnesses.get(assigned.reservation.reservationId)?.openUsageReservations) throw Error('Resource terminal has open usage reservations');
            if (requiresFormalResourceCoordination({ reservationId: assigned.reservation.reservationId, assignmentId: assigned.assignmentId })) {
              assertAssignmentTerminalEvidence({ reservationId: assigned.reservation.reservationId, mode, records }, verifier);
            }
          },
          assertResourceUsageFinal(assigned, usageFinal) {
            if (!requiresFormalResourceCoordination({ reservationId: assigned.reservation.reservationId, assignmentId: assigned.assignmentId })) return;
            const witness = witnesses.get(assigned.reservation.reservationId);
            if (witness?.openUsageReservations) throw Error('Final usage has unresolved durable reservations');
            assertAssignmentUsageEvidence({ root: witness?.lease ? { lease: witness.lease, depth: witness.lease.parentId ? 1 : 0 } : undefined,
              watermark: witness?.watermark ?? 0, block: () => witness?.usages ?? [] },
            { reservationId: assigned.reservation.reservationId, assignmentId: assigned.assignmentId, executorId: assigned.executorId, usageFinal }, verifier);
          },
        } satisfies import('./conversation-assignment.js').ConversationSubmissionGuardContext;
        let validated = canonicalStates.get(id);
        // Reuse the journal's full reducer, once per fact. A single finite view
        // covers every subject in this atomic envelope; no historical map is
        // restored and metadata-only submission reads still avoid CAS bodies.
        if (!metadataOnly && !validated) {
          const records = envelope.entries.filter(value => value.stream === 'run:' + id).map(value => value.body as Record<string, unknown>);
          const events: unknown[] = [], batches: unknown[] = [];
          for (const record of records) if (record.t === 'advancement-event') {
            const stored = record.event;
            events.push(stored && typeof stored === 'object' && 'ref' in stored
              ? JSON.parse(Buffer.from(await _artifacts.get((stored as { ref: import('@zhixing/core/contracts').ArtifactRef }).ref)).toString('utf8')) as unknown : stored);
          }
          for (const record of records) if (record.t === 'committed') {
            const publish = envelope.entries.find(value => value.stream === 'publish' &&
              (value.body as { t?: string; assignmentId?: string })?.t === 'publish-decision' && (value.body as { assignmentId?: string }).assignmentId === record.assignmentId);
            const ref = (publish?.body as { batch?: { ref?: import('@zhixing/core/contracts').ArtifactRef } } | undefined)?.batch?.ref;
            if (ref) batches.push(JSON.parse(Buffer.from(await _artifacts.get(ref)).toString('utf8')));
          }
          const scope = conversationDecisionScope({ records, events, batches }, { current: false, hydrate: true, advancement: events.length > 0,
            allTickets: records.some(value => value.t === 'ticket-sync-frontier'), ticketAt: envelope.at });
          const selected = await readConversationRunViewMetadata(runView, id, scope);
          const importedBinding = await view.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding | undefined;
          const importedSource = importedBinding ? await openConversationBase(log, importedBinding) : undefined;
          validated = await materializeConversationRunView({ conversationId: id, artifacts: _artifacts, verifier, scope, selected,
            ...(importedSource ? { readImportedRecord: location => importedSource.record(location) } : {}),
            readEnvelopeAt: location => {
              if (!source.readEnvelopeAt) throw new TypeError('Conversation replay requires a scoped source reader');
              return source.readEnvelopeAt(location);
            } });
          canonicalStates.set(id, validated);
        }
        let reduced = validated;
        if (validated) reduced = await reduceConversationRunState({ ...context, artifacts: _artifacts, ...binding.validation,
          resources: { assertActivationRecords(input) {
            if (!('lease' in input)) throw new TypeError('Conversation activation requires an assignment lease');
            if (binding.validation?.resources) return binding.validation.resources.assertActivationRecords({ ...input, acceptedAt: input.acceptedAt ?? envelope.at });
            if (input.lease.domain.kind === 'local') throw new TypeError('Local activation requires its local resource authority');
            assertAssignmentActivationEvidence({ ...input, acceptedAt: input.acceptedAt ?? envelope.at }, verifier);
          } },
        }, validated, entry, envelope);
        await reduceConversationSubmissionGuard(context, state, entry as LogicalRecord<ConversationCommitLogRecord>, envelope as CommitEnvelope<ConversationCommitLogRecord>);
        await storeConversationGuard(runView, id, state, before, envelope.lsn, changes);
        if (!metadataOnly) await foldConversationRunExtras({ id, entry, envelope, checkpoint: source.checkpoint, item,
          view: runView, put, drop: key => changes.set(key, undefined), artifacts: _artifacts, verifier, guard: state, priorState, priorAssignment, context, validated: reduced });
      }
      for (const id of conversations) await preserveBaseDeletions(log, view, id, changes);
      return [...changes].map(([key, value]): DurableProjectionMutation => value === undefined ? { kind: 'tombstone', key } : { kind: 'put', key, value });
    },
  });
  binding.index = index; registry.set(log, binding);
  registerConversationBaseRepair(log, metadataOnly ? CONVERSATION_SUBMISSION_STATE_PROJECTION_ID : CONVERSATION_RUN_STATE_PROJECTION_ID, () => index.rebuild());
  return index;
}

export { base as conversationStateBase, hash as conversationStateHash, fieldKey as conversationStateFieldKey,
  fieldPrefix as conversationStateFieldPrefix, encode as encodeConversationState, decode as decodeConversationState,
  field as readConversationStateField, scan as scanConversationState, readGuard as readConversationGuardView,
  rowsOf as conversationGuardRows, scopeFor as conversationRecordScope };

export async function readConversationSubmissionState(log: AuthorityCommitLog, artifacts: ArtifactStore, verifier: ProtocolSignatureVerifier,
  conversationId: string, scope: ConversationRunScope, legacy?: ConversationAbortTicketAuthorizer) {
  registerConversationRunProjection(log, artifacts, verifier, legacy);
  return log.transactDurableProjection<never, { state: SubmissionGuardProjection; version: number }>(CONVERSATION_SUBMISSION_STATE_PROJECTION_ID,
    async current => ({ kind: 'return', value: await readGuard(await conversationViewAt(log, current, conversationId), conversationId, scope) }));
}

export async function conversationWorkingVersion(current: DurableProjectionReadContext, id: string): Promise<string> {
  const root = await current.get(rootKey(id)) as unknown as Root | undefined;
  const binding = await current.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding | undefined;
  return canonicalize([root?.version ?? 0, binding?.manifest ?? null, binding?.activation ?? null]);
}

export async function storeConversationGuard(view: DurableProjectionReadContext, id: string, state: SubmissionGuardProjection,
  before: ReadonlyMap<string, JsonValue>, version: number, changes: Map<string, JsonValue | undefined>) {
  const put = (key: string, value: unknown) => changes.set(key, value as JsonValue);
        const after = rowsOf(id, state);
        for (const key of new Set([...before.keys(), ...after.keys()])) {
          const left = before.get(key), right = after.get(key);
          if (left === undefined && right === undefined || left !== undefined && right !== undefined && canonicalize(left) === canonicalize(right)) continue;
          changes.set(key, right);
        }
        put(rootKey(id), { conversationId: id, version,
          ...(state.activeRunId ? { activeRunId: state.activeRunId } : {}), ...(state.ticketSyncFrontier ? { ticketSyncFrontier: state.ticketSyncFrontier } : {}) });
        for (const [runId, status] of state.stateByRun) changes.set(base(id) + 'open-run/' + hash(runId),
          ['queued', 'dispatched', 'running', 'cancel-requested', 'uncertain'].includes(status.state) ? runId : undefined);
        for (const ticket of state.ticketsById.values()) {
          const owner = hash(ticket.assignmentId), key = base(id) + 'ticket-pending/' + owner + '/' + hash(ticket.ticketId);
          changes.set(key, state.revokedTickets.has(ticket.ticketId) ? undefined : ticket.ticketId);
          put(base(id) + 'ticket-digest/' + hash(dataPlaneTicketDigest(ticket)), ticket.ticketId);
          if (await view.get(base(id) + 'ticket-any/' + owner) === undefined) put(base(id) + 'ticket-any/' + owner, ticket.ticketId);
          const boundary = dataPlaneTicketSyncBoundary(ticket);
          put(base(id) + 'ticket-expiry/' + boundary + '/' + hash(ticket.ticketId), ticket.ticketId);
          put(base(id) + 'ticket-expiry-reverse/' + String(Number.MAX_SAFE_INTEGER - Date.parse(boundary)).padStart(16, '0') + '/' + hash(ticket.ticketId), ticket.ticketId);
        }

}
