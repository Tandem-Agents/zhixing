import type { ArtifactStore, AuthorityCommitLog, DurableProjectionDefinition, DurableProjectionMutation, DurableProjectionReadContext } from '@zhixing/core/authority';
import { createDurableProjectionOverlay, readDurableProjectionKeys } from '@zhixing/core/authority';
import type { JsonValue, LogicalRecord, CommitEnvelope, ReservableResourceLease, UsageReport } from '@zhixing/core/contracts';
import { canonicalize, validateGovernorRecord, requiresFormalResourceCoordination, dataPlaneTicketDigest,
  type ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { emptySubmissionGuardProjection, reduceConversationSubmissionGuard, reduceConversationRunState,
  type RunProjection, type ConversationRunReductionContext, type SubmissionGuardProjection, type ConversationCommitLogRecord, type ConversationAbortTicketAuthorizer,
  type ConversationSubmissionGuardContext } from './conversation-assignment.js';
import { assertAssignmentActivationEvidence, assertAssignmentTerminalEvidence, assertAssignmentUsageEvidence } from './conversation-resource-witness.js';
import { conversationDecisionScope, readConversationRunViewMetadata, materializeConversationRunView, materializedDispatchEnvelope } from './conversation-run-state-view.js';
import { dataPlaneTicketSyncBoundary } from './data-plane-ticket-lifecycle.js';
import { foldConversationRunExtras } from './conversation-run-state-extras.js';
import { foldConversationBaseBindings, preserveBaseDeletions, registerConversationBaseContext, registerConversationBaseRepair, conversationBaseUnavailableKey, conversationBaseRepairRequired, conversationViewAt, conversationBaseKey, openConversationBase, type ConversationBaseBinding } from './conversation-base-registry.js';
import { conversationStateKeyHash as hash } from './conversation-state-key.js';
import { partitionedDecisionReducer, installConversationDecisionMigration, decisionSeedAtSource, decisionStartAtSource } from './conversation-decision-partitions.js';

export const CONVERSATION_RUN_STATE_PROJECTION_ID = 'conversation-run-state-v1';
const base = (id: string) => 'conversation/' + hash(id) + '/';
const fieldPrefix = (id: string, field: string) => base(id) + 'guard/' + field + '/';
const fieldKey = (id: string, field: string, key: string | number) => fieldPrefix(id, field) + hash(key);
const rootKey = (id: string) => base(id) + 'root';
// 用量占用与消耗按根预留分组，派发结束时可按前缀整组删除。
const resourceWitnessKey = (reservationId: string) => 'resource/' + hash(reservationId);
const resourceHoldKey = (root: string, usageId: string) => 'resource-hold/' + hash(root) + '/' + hash(usageId);
const resourceUsageKey = (root: string, usageId: string) => 'resource-usage/' + hash(root) + '/' + hash(usageId);
const resourceUsagePrefixes = (root: string) => ['resource-hold/' + hash(root) + '/', 'resource-usage/' + hash(root) + '/'];
const OPEN_RUN_STATES = new Set(['queued', 'dispatched', 'running', 'cancel-requested', 'uncertain']);
/** 派发的资源仍可能被结算、回收或继续计量：未提交、未被接受取消、未关闭，且所属运行仍未结束。 */
export function assignmentResourceLive(guard: Pick<SubmissionGuardProjection, 'committedByAssignment' | 'acceptedCancellations' | 'closedAssignments' | 'stateByRun'>,
  assignmentId: string, runId: string): boolean {
  return !guard.committedByAssignment.has(assignmentId) && !guard.acceptedCancellations.has(assignmentId) && !guard.closedAssignments.has(assignmentId) &&
    OPEN_RUN_STATES.has(guard.stateByRun.get(runId)?.state ?? '');
}
interface Root { conversationId: string; version: number; activeRunId?: string; ticketSyncFrontier?: string }
interface Row { key: string | number; value: JsonValue }
/** 会话派发持有的预留见证；conversationId 标明归属，迁移期间据此判定资源记录属于哪个会话。 */
export interface ResourceWitness { lease?: ReservableResourceLease; watermark: number; usages: UsageReport['usages']; openUsageReservations: number; conversationId?: string }
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
  // 按字段名、主体两级保存已读结果（含不存在）；命中时既不拼存储键也不新建 Promise。
  const fields = new Map<string, Map<string | number, unknown>>();
  const guardBase = base(id) + 'guard/';
  const preload = async (wanted: readonly (readonly [string, string | number])[]) => {
    const batch: { values: Map<string | number, unknown>; key: string | number; storageKey: string }[] = [];
    const queued = new Set<string>();
    for (const [name, key] of wanted) {
      let values = fields.get(name);
      if (values?.has(key)) continue;
      if (!values) { values = new Map(); fields.set(name, values); }
      const storageKey = guardBase + name + '/' + hash(key);
      if (queued.has(storageKey)) continue;
      queued.add(storageKey); batch.push({ values, key, storageKey });
    }
    for (let offset = 0; offset < batch.length; offset += 256) {
      const slice = batch.slice(offset, offset + 256);
      const rows = await readDurableProjectionKeys(view, slice.map(item => item.storageKey));
      for (let n = 0; n < slice.length; n++) {
        const { values, key } = slice[n]!, row = rows[n] as unknown as Row | undefined;
        if (row && row.key !== key) throw Error('Conversation state key binding is invalid');
        values.set(key, row ? decode(row.value) : undefined);
      }
    }
  };
  return { preload, get<T = unknown>(name: string, key: string | number): T | undefined | Promise<T | undefined> {
    const values = fields.get(name);
    if (values?.has(key)) return values.get(key) as T | undefined;
    return preload([[name, key]]).then(() => fields.get(name)!.get(key) as T | undefined);
  } };
}
const runMaps = ['admittedByRun', 'assignmentByRun', 'assignmentAttemptByRun', 'stateByRun', 'resolutionsByRun'] as const;
const assignmentMaps = ['assignedById', 'supersedeRequests', 'cancelFences', 'committedByAssignment', 'bundleAcknowledgements'] as const;
const assignmentSets = ['conflictAssignments', 'openConflictAssignments', 'supersedeStartedAssignments', 'acceptedCancellations', 'durableStartedAssignments', 'closedAssignments'] as const;

/** Reconstruct a finite metadata view. The complete queue is current work;
 * terminated run/assignment identities are loaded only when requested. */
export async function readConversationGuardRoot(view: DurableProjectionReadContext, id: string): Promise<Root | undefined> {
  const root = await view.get(rootKey(id)) as unknown as Root | undefined;
  if (root && root.conversationId !== id) throw Error('Conversation state root binding is invalid');
  return root;
}

async function readGuard(view: DurableProjectionReadContext, id: string, scope: ConversationRunScope) {
  const state = emptySubmissionGuardProjection();
  const fields = conversationFieldReader(view, id);
  const root = await readConversationGuardRoot(view, id);
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
type MaterializedBodies = Pick<RunProjection, 'admittedByRun' | 'appendedInputs' | 'assignedById'>;
type Binding = { index: ReturnType<AuthorityCommitLog['durableProjection']>; verifier: ProtocolSignatureVerifier; legacy?: ConversationAbortTicketAuthorizer;
  validation?: ValidationBinding; materialized: Map<string, MaterializedBodies>; reduce?: DurableProjectionDefinition<unknown>['reduce']; artifacts: ArtifactStore };
const bindings = new WeakMap<AuthorityCommitLog, Binding>();
/** canonical 归约的校验上下文：资源见证由调用方按当前视图提供。投影归约与迁移对齐共用，校验逐字相同。 */
export function conversationReductionContexts(log: AuthorityCommitLog, id: string, envelope: { readonly at: string },
  witnessOf: (reservationId: string) => ResourceWitness | undefined): { guard: ConversationSubmissionGuardContext; run: ConversationRunReductionContext } {
  const binding = bindings.get(log);
  if (!binding) throw new TypeError('Conversation run state projection is not registered');
  const verifier = binding.verifier;
  const guard = { conversationId: id, verifier, legacyAbortTickets: binding.legacy,
    assertResourceTerminalRecords(assigned, mode, records) {
      if (witnessOf(assigned.reservation.reservationId)?.openUsageReservations) throw Error('Resource terminal has open usage reservations');
      if (requiresFormalResourceCoordination({ reservationId: assigned.reservation.reservationId, assignmentId: assigned.assignmentId })) {
        assertAssignmentTerminalEvidence({ reservationId: assigned.reservation.reservationId, mode, records }, verifier);
      }
    },
    assertResourceUsageFinal(assigned, usageFinal) {
      if (!requiresFormalResourceCoordination({ reservationId: assigned.reservation.reservationId, assignmentId: assigned.assignmentId })) return;
      const witness = witnessOf(assigned.reservation.reservationId);
      if (witness?.openUsageReservations) throw Error('Final usage has unresolved durable reservations');
      assertAssignmentUsageEvidence({ root: witness?.lease ? { lease: witness.lease, depth: witness.lease.parentId ? 1 : 0 } : undefined,
        watermark: witness?.watermark ?? 0, block: () => witness?.usages ?? [] },
      { reservationId: assigned.reservation.reservationId, assignmentId: assigned.assignmentId, executorId: assigned.executorId, usageFinal }, verifier);
    },
  } satisfies ConversationSubmissionGuardContext;
  const run: ConversationRunReductionContext = { ...guard, artifacts: binding.artifacts, ...binding.validation,
    resources: { assertActivationRecords(input) {
      if (!('lease' in input)) throw new TypeError('Conversation activation requires an assignment lease');
      if (binding.validation?.resources) return binding.validation.resources.assertActivationRecords({ ...input, acceptedAt: input.acceptedAt ?? envelope.at });
      if (input.lease.domain.kind === 'local') throw new TypeError('Local activation requires its local resource authority');
      assertAssignmentActivationEvidence({ ...input, acceptedAt: input.acceptedAt ?? envelope.at }, verifier);
    } } };
  return { guard, run };
}
/** 迁移续算用：已登记的同一 canonical 归约（与投影内执行的完全相同）。 */
export function conversationRunStateReducer(log: AuthorityCommitLog): DurableProjectionDefinition<unknown>['reduce'] {
  const reduce = bindings.get(log)?.reduce;
  if (!reduce) throw new TypeError('Conversation run state projection is not registered');
  return reduce;
}
const MATERIALIZED_CONVERSATIONS = 8;

/** Immutable bodies already materialized for one conversation: verified dispatch
 * envelopes and admitted/appended inputs, bound to their content digests and
 * source positions. The next fact reuses them only after the existing identity
 * checks match; state, guard fields and absence are always read anew. */
function rememberMaterialized(binding: Binding, id: string, state: RunProjection) {
  const bodies: MaterializedBodies = { admittedByRun: new Map([...state.admittedByRun].filter(([, row]) => row.input !== undefined)),
    appendedInputs: new Map([...state.appendedInputs].filter(([, row]) => row.input !== undefined)),
    assignedById: new Map([...state.assignedById].filter(([, row]) => row.envelope !== undefined)) };
  binding.materialized.delete(id);
  if (binding.materialized.size >= MATERIALIZED_CONVERSATIONS) binding.materialized.delete(binding.materialized.keys().next().value!);
  binding.materialized.set(id, bodies);
}
/** Dispatches first verified by this fact's reducer join the same reusable set. */
function rememberAssigned(binding: Binding, id: string, state: RunProjection) {
  const bodies = binding.materialized.get(id);
  if (!bodies) return;
  for (const [assignmentId, row] of state.assignedById) if (row.envelope && !bodies.assignedById.has(assignmentId)) {
    bodies.assignedById.set(assignmentId, { ...row, envelope: materializedDispatchEnvelope(row.envelope) });
  }
}

export function registerConversationRunProjection(log: AuthorityCommitLog, _artifacts: ArtifactStore, verifier: ProtocolSignatureVerifier,
  legacy?: ConversationAbortTicketAuthorizer, validation?: ValidationBinding) {
  return registerConversationRunReadProjection(log, _artifacts, verifier, legacy, validation);
}

/** Read dependencies must not install an unused submission writer projection.
 * Otherwise its first unrelated executor append pays a historical catch-up. */
export function registerConversationRunReadProjection(log: AuthorityCommitLog, artifacts: ArtifactStore, verifier: ProtocolSignatureVerifier,
  legacy?: ConversationAbortTicketAuthorizer, validation?: ValidationBinding) {
  registerConversationBaseContext(log, artifacts, verifier);
  return registerConversationStateProjection(log, artifacts, verifier, legacy, validation);
}

function registerConversationStateProjection(log: AuthorityCommitLog, _artifacts: ArtifactStore, verifier: ProtocolSignatureVerifier,
  legacy?: ConversationAbortTicketAuthorizer, validation?: ValidationBinding) {
  const registry = bindings;
  const found = registry.get(log);
  if (found) { if (found.verifier !== verifier) throw Error('Conversation state verifier changed'); if (legacy) found.legacy = legacy;
    if (validation) found.validation = { ...found.validation, ...Object.fromEntries(Object.entries(validation).filter(([, value]) => value !== undefined)) };
    return found.index; }
  const binding: Binding = { verifier, legacy, validation, materialized: new Map(), artifacts: _artifacts, index: undefined as unknown as ReturnType<AuthorityCommitLog['durableProjection']> };
  const definition: DurableProjectionDefinition<unknown> = { projectionId: CONVERSATION_RUN_STATE_PROJECTION_ID, reducerVersion: 3, authenticated: true,
    inputs: { families: ['run:', 'transfer:'], streams: ['governor'] },
    async reduce(envelope, sourceView, source) {
      const current = envelopeReadView(sourceView);
      const changes = new Map<string, JsonValue | undefined>();
      const baseChanges = new Map<string, JsonValue | undefined>();
      await foldConversationBaseBindings(log, envelope.entries, current, baseChanges, source, true);
      for (const [key, value] of baseChanges) changes.set(key, value);
      const view = createDurableProjectionOverlay(current, changes);
      const put = (key: string, value: unknown) => changes.set(key, value as JsonValue);
      const canonicalStates = new Map<string, RunProjection>();
      const conversations = new Set<string>();
      // 只为会话派发持有的预留维护见证：预留与 assigned 记录在同一原子信封里提交。
      // 其余预留（任务、调度等）及已结束派发的用量由资源调度自身的投影校验，这里不留历史。
      const assignedReservations = new Map(envelope.entries.flatMap(entry => entry.stream.startsWith('run:') &&
        (entry.body as { t?: string } | undefined)?.t === 'assigned' ? [[(entry.body as { reservation: { reservationId: string } }).reservation.reservationId, entry.stream.slice(4)] as const] : []));
      const endedReservations = new Set<string>();
      for (const entry of envelope.entries) {
        if (entry.stream !== 'governor') continue;
        const body = validateGovernorRecord(entry.body, verifier);
        if (body.t === 'reserve') {
          if (!assignedReservations.has(body.lease.reservationId)) continue;
          const key = resourceWitnessKey(body.lease.reservationId), prior = await view.get(key) as unknown as ResourceWitness | undefined;
          if (prior?.lease && canonicalize(prior.lease) !== canonicalize(body.lease)) throw Error('Resource reservation identity changed');
          put(key, { lease: body.lease, watermark: prior?.watermark ?? 0, usages: prior?.usages ?? [], openUsageReservations: prior?.openUsageReservations ?? 0,
            conversationId: assignedReservations.get(body.lease.reservationId) });
        } else if (body.t === 'usage-reserved') {
          const key = resourceWitnessKey(body.rootReservationId), prior = await view.get(key) as unknown as ResourceWitness | undefined;
          if (!prior?.lease) continue;
          const heldKey = resourceHoldKey(body.rootReservationId, body.usageId), held = await view.get(heldKey) as { reservation?: JsonValue; consumed?: boolean } | undefined;
          if (held) { if (canonicalize(held.reservation) !== canonicalize(body)) throw Error('Resource usage reservation identity changed'); continue; }
          put(heldKey, { reservation: body, consumed: false });
          put(key, { ...prior, openUsageReservations: prior.openUsageReservations + 1 });
        } else if (body.t === 'consume') {
          const key = resourceWitnessKey(body.rootReservationId), prior = await view.get(key) as unknown as ResourceWitness | undefined;
          if (!prior?.lease) continue;
          const usage = { usageSeq: body.usageSeq, reservationId: body.reservationId, usageId: body.usageId,
            ...(body.tokens ? { tokens: body.tokens } : {}), ...(body.calls ? { calls: body.calls } : {}), ...(body.costMinor ? { costMinor: body.costMinor } : {}) };
          const seenKey = resourceUsageKey(body.rootReservationId, body.usageId), seen = await view.get(seenKey);
          if (seen !== undefined) { if (canonicalize(seen) !== canonicalize({ root: body.rootReservationId, usage })) throw Error('Resource usage identity changed'); continue; }
          if (body.usageSeq !== prior.watermark + 1) throw Error('Resource usage witness is not continuous');
          const heldKey = resourceHoldKey(body.rootReservationId, body.usageId), held = await view.get(heldKey) as unknown as { reservation: { rootReservationId: string; reservationId: string }; consumed: boolean } | undefined;
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
          const witness = await view.get(resourceWitnessKey(reservationId)) as unknown as ResourceWitness | undefined;
          if (witness) witnesses.set(reservationId, witness);
        }
        const contexts = conversationReductionContexts(log, id, envelope, reservationId => witnesses.get(reservationId));
        const context = contexts.guard;
        let validated = canonicalStates.get(id);
        // Reuse the journal's full reducer, once per fact. A single finite view
        // covers every subject in this atomic envelope; no historical map is
        // restored and metadata-only submission reads still avoid CAS bodies.
        if (!validated) {
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
          const previous = binding.materialized.get(id);
          validated = await materializeConversationRunView({ conversationId: id, artifacts: _artifacts, verifier, scope, selected,
            ...(previous ? { previous } : {}),
            ...(importedSource ? { readImportedRecord: location => importedSource.record(location) } : {}),
            readEnvelopeAt: location => {
              if (!source.readEnvelopeAt) throw new TypeError('Conversation replay requires a scoped source reader');
              return source.readEnvelopeAt(location);
            } });
          rememberMaterialized(binding, id, validated);
          canonicalStates.set(id, validated);
        }
        let reduced = validated;
        if (validated) reduced = await reduceConversationRunState(contexts.run, validated, entry, envelope);
        if (reduced) rememberAssigned(binding, id, reduced);
        await reduceConversationSubmissionGuard(context, state, entry as LogicalRecord<ConversationCommitLogRecord>, envelope as CommitEnvelope<ConversationCommitLogRecord>);
        await storeConversationGuard(runView, id, state, before, envelope.lsn, changes);
        await foldConversationRunExtras({ id, entry, envelope, checkpoint: source.checkpoint, item,
          view: runView, put, drop: key => changes.set(key, undefined), artifacts: _artifacts, verifier, guard: state, priorState, priorAssignment, context, validated: reduced });
        for (const [assignmentId, assigned] of state.assignedById) {
          if (!assignmentResourceLive(state, assignmentId, assigned.record.runId)) endedReservations.add(assigned.record.reservation.reservationId);
        }
      }
      // 派发不再存活后，其资源见证不再参与任何决定：整组删除，决定状态不随历史累积。
      for (const reservationId of endedReservations) {
        if (await view.get(resourceWitnessKey(reservationId)) === undefined) continue;
        changes.set(resourceWitnessKey(reservationId), undefined);
        for (const prefix of resourceUsagePrefixes(reservationId)) for (const row of await scan(view, prefix)) changes.set(row.key, undefined);
      }
      for (const id of conversations) await preserveBaseDeletions(log, view, id, changes);
      return [...changes].map(([key, value]): DurableProjectionMutation => value === undefined ? { kind: 'tombstone', key } : { kind: 'put', key, value });
    },
  };
  // 旧资料升级：新版本从源头部以空状态就绪，各会话在第一次读写前按分区迁移（见 conversation-decision-partitions）。
  const index = log.durableProjection<unknown>({ ...definition, startAtSource: decisionStartAtSource, seedAtSource: decisionSeedAtSource,
    reduce: partitionedDecisionReducer(log, definition.reduce) });
  binding.index = index; binding.reduce = definition.reduce; registry.set(log, binding);
  installConversationDecisionMigration(log, _artifacts, verifier);
  registerConversationBaseRepair(log, CONVERSATION_RUN_STATE_PROJECTION_ID, () => index.rebuild());
  return index;
}

export { base as conversationStateBase, hash as conversationStateHash, fieldKey as conversationStateFieldKey,
  fieldPrefix as conversationStateFieldPrefix, encode as encodeConversationState, decode as decodeConversationState,
  field as readConversationStateField, scan as scanConversationState, readGuard as readConversationGuardView,
  rowsOf as conversationGuardRows, scopeFor as conversationRecordScope, rootKey as conversationStateRootKey,
  resourceWitnessKey as conversationResourceWitnessKey, resourceHoldKey as conversationResourceHoldKey, resourceUsageKey as conversationResourceUsageKey };

export async function readConversationSubmissionState(log: AuthorityCommitLog, artifacts: ArtifactStore, verifier: ProtocolSignatureVerifier,
  conversationId: string, scope: ConversationRunScope, legacy?: ConversationAbortTicketAuthorizer) {
  // The canonical projection already contains the identical guard fields and
  // executes the same guard for every candidate. Read that authenticated view
  // directly; a second metadata projection would replay and publish the same
  // validation again. This read still hydrates no input/artifact bodies.
  registerConversationRunProjection(log, artifacts, verifier, legacy);
  return log.transactDurableProjection<never, { state: SubmissionGuardProjection; version: number }>(CONVERSATION_RUN_STATE_PROJECTION_ID,
    async current => ({ kind: 'return', value: await readGuard(await conversationViewAt(log, current, conversationId), conversationId, scope) }));
}

export async function conversationWorkingVersion(current: DurableProjectionReadContext, id: string): Promise<string> {
  const root = await current.get(rootKey(id)) as unknown as Root | undefined;
  const binding = await current.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding | undefined;
  return canonicalize([root?.version ?? 0, binding?.manifest ?? null, binding?.activation ?? null]);
}

/** Equality of two JSON values decoded from this index or produced by encode().
 * Identical native text implies identical canonical form; only differing text
 * (for example another key order) needs the canonical comparison. */
export function sameStoredJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right) || canonicalize(left) === canonicalize(right);
}

export async function storeConversationGuard(view: DurableProjectionReadContext, id: string, state: SubmissionGuardProjection,
  before: ReadonlyMap<string, JsonValue>, version: number, changes: Map<string, JsonValue | undefined>) {
  const put = (key: string, value: unknown) => changes.set(key, value as JsonValue);
        const after = rowsOf(id, state);
        for (const key of new Set([...before.keys(), ...after.keys()])) {
          const left = before.get(key), right = after.get(key);
          if (left === undefined && right === undefined || left !== undefined && right !== undefined && sameStoredJson(left, right)) continue;
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

/** Only one immutable, source-fenced envelope. Guard and materialization often
 * request the same fields; retain at most 256 KiB / 256 rows for this reduction,
 * including absence. Candidate changes remain in the overlay above this view.
 * Nothing survives a publication, source-fence release, or failed reduction.
 * Rows are the same shared, read-only values the source view returns; each is
 * measured once when retained, never re-encoded on a hit. */
function envelopeReadView(source: DurableProjectionReadContext): DurableProjectionReadContext {
  const rows = new Map<string, JsonValue | undefined>();
  let bytes = 0;
  const remember = (key: string, value: JsonValue | undefined) => {
    if (rows.has(key) || rows.size >= 256) return;
    const size = Buffer.byteLength(key) + (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)));
    if (bytes + size <= 256 * 1024) { rows.set(key, value); bytes += size; }
  };
  const getMany = async (keys: readonly string[]) => {
    const missing = [...new Set(keys.filter(key => !rows.has(key)))];
    const fetched = missing.length ? await readDurableProjectionKeys(source, missing) : [];
    const fresh = new Map(missing.map((key, i) => [key, fetched[i]]));
    for (const [key, value] of fresh) remember(key, value);
    return keys.map(key => rows.has(key) ? rows.get(key) : fresh.get(key));
  };
  return { get: async key => (await getMany([key]))[0], getMany,
    async scan(range, limit, continuation) {
      const page = await source.scan(range, limit, continuation);
      for (const row of page.entries) remember(row.key, row.value);
      return page;
    } };
}