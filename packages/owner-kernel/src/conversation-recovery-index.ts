import { corruptRunJournal } from './conversation-run-contracts.js';
import { AuthorityStorageError, createDurableProjectionOverlay, type ArtifactStore, type AuthorityCommitLog, type DurableProjectionMutation, type DurableProjectionReadContext, type DurableLogCheckpoint } from '@zhixing/core/authority';
import type { JsonValue, FinalFrame } from '@zhixing/core/contracts';
import { canonicalize, protocolDigest, validateMutationBatch, validatePublishDecisionForBatch, validatePublishDecisionRecord } from '@zhixing/core/protocol';
import { domainPublishDecisionRequired, publishDomainSequence, publishProgressFollows } from './conversation-publish-obligations.js';
import { foldConversationBaseBindings, conversationBaseKey, conversationBaseUnavailableKey, conversationBaseRepairRequired, registerConversationBaseRepair, openConversationBase, conversationViewForSource, type ConversationBaseBinding } from './conversation-base-registry.js';
import { isConversationSourceEvidenceError, type AuthenticatedConversationFacts, type ConversationBaseSource } from './conversation-base-source.js';
import { conversationStateBase } from './conversation-run-state-index.js';

export const CONVERSATION_RECOVERY_PROJECTION_ID = 'conversation-recovery-pending-v1';
interface ConversationRoot {
  id: string; deleted: boolean; control: boolean; runs: number; assignments: number; lifecycle: number; version: number;
  finalRevision?: number;
}
interface AssignmentWork {
  conversationId?: string; revision?: number; projected?: boolean; acknowledged?: boolean;
  final?: boolean; domains?: ('session' | 'global')[];
  plans?: Partial<Record<'session' | 'global', { grantedSeqs: number[]; terminalSeq: number; position: number; progress?: { upToSeq: number; state: string } }>>;
}
const identity = (value: unknown) => protocolDigest('ConversationRecoveryKey', 1, value).slice(7);
const rootKey = (id: string) => 'conversation/' + identity(id);
const assignmentKey = (id: string) => 'assignment/' + identity(id);
const order = (lsn: number) => String(lsn).padStart(16, '0');
const finalIdentity = (frame: Pick<FinalFrame, 'conversationId' | 'runId' | 'commitRevision'>) => identity([frame.conversationId, frame.runId, frame.commitRevision]);
const openStates = new Set(['queued', 'dispatched', 'running', 'cancel-requested', 'uncertain']);
const owes = (value: AssignmentWork) => value.revision !== undefined &&
  (!value.projected || !value.acknowledged || !value.final || !!value.domains?.length);
const bindings = new WeakMap<AuthorityCommitLog, ReturnType<AuthorityCommitLog['durableProjection']>>();

/** Durable obligations only. Completed identities stay exact on disk; neither
 * discovery nor shutdown serializes a collection of historical conversations. */
export function registerConversationRecoveryProjection(log: AuthorityCommitLog, artifacts: ArtifactStore) {
  const existing = bindings.get(log);
  if (existing) return existing;
  const index = log.durableProjection<unknown>({
    projectionId: CONVERSATION_RECOVERY_PROJECTION_ID, reducerVersion: 2,
    inputs: { families: ['run:', 'transfer:'], streams: ['publish', 'final-outbox'] },
    async reduce(envelope, current, source) {
      const changes = new Map<string, JsonValue | undefined>();
      await foldConversationBaseBindings(log, envelope.entries, current, changes, source);
      const view = createDurableProjectionOverlay(current, changes);
      for (const entry of envelope.entries) {
        const body = entry.body as { t?: string; conversationId?: string };
        if (!entry.stream.startsWith('transfer:xfer-') || body?.t !== 'conversation-transfer-committed-base' || !body.conversationId) continue;
        const id = body.conversationId, binding = await view.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding;
        try {
        const base = await openConversationBase(log, binding);
        const root = await base.read(reader => reader.get(rootKey(id))) as unknown as ConversationRoot | undefined;
        if (!root || root.assignments || root.lifecycle) throw corruptRunJournal('Adopted source has unsettled owner effects');
        // Freeze closes source effects. Only queued conversation inputs become
        // new-owner work; historical publication/finality directories stay in
        // the immutable source and are available solely for exact reads.
        changes.set(rootKey(id), { ...root, version: envelope.lsn } as unknown as JsonValue);
        changes.set('pending/' + identity(id), root.control || root.runs ? id : undefined);
        const p = conversationStateBase(id) + 'open-run/'; let after: string | undefined;
        do {
          const page = await base.read(reader => reader.scan({ ...(after ? { gt: after } : { gte: p }), lt: p + '\uffff' }, 64));
          for (const row of page.entries) {
            if (typeof row.value !== 'string') throw corruptRunJournal('Imported pending run identity is invalid');
            changes.set('run/' + identity([id, row.value]), true);
          }
          after = page.continuation ? page.entries.at(-1)!.key : undefined;
        } while (after);
        } catch (error) {
          if (source.candidate || !isConversationSourceEvidenceError(error)) throw error;
          changes.set(conversationBaseUnavailableKey(id), true);
          changes.set('pending/' + identity(id), id);
        }
      }
      const available = [];
      for (const entry of envelope.entries) {
        const body = entry.body as { conversationId?: string; assignmentId?: string };
        const id = entry.stream.startsWith('run:') ? entry.stream.slice(4) : body?.conversationId;
        if (id && await view.get(conversationBaseUnavailableKey(id))) {
          if (source.candidate) throw conversationBaseRepairRequired(log, await view.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding);
          continue;
        }
        available.push(entry);
      }
      for (const mutation of await reduceConversationRecoveryFacts(available, envelope.at, envelope.lsn, source.checkpoint, view, artifacts)) {
        changes.set(mutation.key, mutation.kind === 'put' ? mutation.value : undefined);
      }
      return [...changes].map(([key, value]): DurableProjectionMutation => value === undefined ? { kind: 'tombstone', key } : { kind: 'put', key, value });
    }
  });
  bindings.set(log, index);
  registerConversationBaseRepair(log, CONVERSATION_RECOVERY_PROJECTION_ID, () => index.rebuild());
  return index;
}

export async function conversationRecoveryVersion(current: DurableProjectionReadContext, conversationId: string): Promise<number> {
  return (await current.get(rootKey(conversationId)) as unknown as ConversationRoot | undefined)?.version ?? 0;
}

export async function conversationRecoveryPending(log: AuthorityCommitLog, artifacts: ArtifactStore, conversationId: string): Promise<boolean> {
  registerConversationRecoveryProjection(log, artifacts);
  return (await log.transactDurableProjection<never, boolean>(CONVERSATION_RECOVERY_PROJECTION_ID, async current => {
    if (await current.get(conversationBaseUnavailableKey(conversationId))) throw conversationBaseRepairRequired(log, await current.get(conversationBaseKey(conversationId)) as unknown as ConversationBaseBinding);
    const root = await current.get(rootKey(conversationId)) as unknown as ConversationRoot | undefined;
    // Control continuation discovery retains its former one-pass behavior;
    // its consumption semantics are owned by the continuation domain.
    return { kind: 'return', value: !!root && (root.lifecycle > 0 || !root.deleted && (root.runs > 0 || root.assignments > 0)) };
  })).value;
}

export type ConversationEffectSelection =
  | { readonly kind: 'publish'; readonly assignments?: readonly string[] }
  | { readonly kind: 'final'; readonly frames?: readonly Pick<FinalFrame, 'conversationId' | 'runId' | 'commitRevision'>[]; readonly publishedBefore?: number };

/** Select immutable WAL locators at one authority prefix. Bodies are loaded
 * after releasing that lock; the journal rechecks version before deciding. */
export async function prepareConversationEffects(log: AuthorityCommitLog, artifacts: ArtifactStore,
  conversationId: string, selection: ConversationEffectSelection) {
  registerConversationRecoveryProjection(log, artifacts);
  const selected = await log.transactDurableProjection<never, {
    version: number; subjects: readonly string[]; checkpoints: readonly DurableLogCheckpoint[];
    source?: ConversationBaseSource; imported: readonly import('./conversation-base-source.js').ConversationBaseLocation[];
  }>(CONVERSATION_RECOVERY_PROJECTION_ID, async current => {
    const binding = await current.get(conversationBaseKey(conversationId)) as unknown as ConversationBaseBinding | undefined;
    if (binding && await current.get(conversationBaseUnavailableKey(conversationId))) throw conversationBaseRepairRequired(log, binding);
    const source = binding && (selection.kind === 'publish' ? selection.assignments : selection.frames) ? await openConversationBase(log, binding) : undefined;
    const exact = source ? conversationViewForSource(current, source) : current;
    const scan = async (prefix: string, limit = Infinity, upper = prefix + '\uffff') => {
      const values: JsonValue[] = []; let after: string | undefined;
      do {
        const page = await exact.scan({ ...(after ? { gt: after } : { gte: prefix }), lt: upper }, Math.min(64, limit - values.length));
        values.push(...page.entries.map(entry => entry.value));
        after = page.continuation ? page.entries.at(-1)!.key : undefined;
      } while (after && values.length < limit);
      return values;
    };
    const subjects: string[] = [];
    if (selection.kind === 'publish') {
      const ids = selection.assignments ?? await scan('publish-pending/' + identity(conversationId) + '/', 32);
      for (const id of ids) {
        if (typeof id !== 'string') throw corruptRunJournal('Publish obligation binding is invalid');
        const work = await exact.get(assignmentKey(id)) as unknown as AssignmentWork | undefined;
        if (work?.conversationId === conversationId) subjects.push(id);
      }
    } else if (selection.frames) {
      for (const frame of selection.frames) {
        if (frame.conversationId !== conversationId) throw corruptRunJournal('Final selection belongs to another conversation');
        subjects.push(finalIdentity(frame));
      }
    } else {
      const p = (selection.publishedBefore !== undefined ? 'final-published/' : 'final-pending/') + identity(conversationId) + '/';
      const values = await scan(p, 32, selection.publishedBefore === undefined ? p + '\uffff' : p + order(selection.publishedBefore) + '/\uffff');
      for (const id of values) { if (typeof id !== 'string') throw corruptRunJournal('Final obligation binding is invalid'); subjects.push(id); }
    }
    const checkpoints = new Map<number, DurableLogCheckpoint>();
    const imported = new Map<number, import('./conversation-base-source.js').ConversationBaseLocation>();
    for (const id of subjects) {
      const p = selection.kind === 'publish' ? 'publish-frame/' + identity(id) + '/' : 'final-frame/' + id + '/';
      for (const value of await scan(p)) {
        if (value && typeof value === 'object' && 'imported' in value) {
          if (!source) throw corruptRunJournal('Effect source has no authenticated imported base');
          const location = value.imported as unknown as import('./conversation-base-source.js').ConversationBaseLocation;
          imported.set(location.record, location); continue;
        }
        const point = value as unknown as DurableLogCheckpoint;
        if (!point || !Number.isSafeInteger(point.lsn) || point.lsn < 1 || typeof point.logId !== 'string') throw corruptRunJournal('Effect source locator is invalid');
        const prior = checkpoints.get(point.lsn);
        if (prior && canonicalize(prior) !== canonicalize(point)) throw corruptRunJournal('Effect source locators disagree');
        checkpoints.set(point.lsn, point);
      }
    }
    return { kind: 'return', value: { version: await conversationRecoveryVersion(current, conversationId), subjects,
      checkpoints: [...checkpoints.values()].sort((a, b) => a.lsn - b.lsn), source,
      imported: [...imported.values()].sort((a, b) => a.record - b.record) } };
  });
  const imported: AuthenticatedConversationFacts[] = [];
  for (const location of selected.value.imported) {
    const source = selected.value.source!;
    await source.record(location);
    const group = await source.group(location.record);
    if (!group || group.firstRecord !== location.record) throw corruptRunJournal('Effect source is not an authenticated group boundary');
    imported.push(group);
  }
  const envelopes = [];
  for (let start = 0; start < selected.value.checkpoints.length; start += 64) {
    envelopes.push(...await log.readEnvelopesAt<unknown>(selected.value.checkpoints.slice(start, start + 64)));
  }
  const subjects = new Set(selected.value.subjects);
  const includes = (stream: string, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return false;
    const body = raw as Record<string, unknown>;
    return selection.kind === 'publish' ? stream === 'publish' && typeof body.assignmentId === 'string' && subjects.has(body.assignmentId) :
      stream === 'final-outbox' && body.conversationId === conversationId && typeof body.runId === 'string' && typeof body.commitRevision === 'number' && subjects.has(finalIdentity(body as unknown as FinalFrame));
  };
  return { version: selected.value.version, cursor: selected.cursor, groups: [...imported, ...envelopes], includes };
}

export async function conversationRecoveryPage(log: AuthorityCommitLog, artifacts: ArtifactStore, after?: string, limit = 32) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64 || (after !== undefined && !/^pending\/[a-f0-9]{64}$/u.test(after))) throw new TypeError('Invalid recovery page');
  const index = registerConversationRecoveryProjection(log, artifacts);
  const page = await index.scan({ ...(after ? { gt: after } : { gte: 'pending/' }), lt: 'pending/\uffff' }, limit);
  const conversationIds = page.entries.map(entry => {
    if (typeof entry.value !== 'string' || entry.key !== 'pending/' + identity(entry.value)) throw corruptRunJournal('Recovery directory binding is invalid');
    return entry.value;
  });
  return { conversationIds, ...(page.continuation ? { after: page.entries.at(-1)!.key } : {}) };
}

export type ConversationEffectSource = DurableLogCheckpoint | { readonly imported: import('./conversation-base-source.js').ConversationBaseLocation };
/** Domain obligation folding uses an explicit location. An imported location
 * is never accepted by the WAL reader and never becomes a local cursor. */
export async function reduceConversationRecoveryFacts(entries: readonly import('@zhixing/core/contracts').LogicalRecord<unknown>[],
  at: string, position: number, location: ConversationEffectSource, current: DurableProjectionReadContext, artifacts: ArtifactStore): Promise<readonly DurableProjectionMutation[]> {
      const changes = new Map<string, JsonValue | undefined>();
      const roots = new Map<string, ConversationRoot>();
      const get = async <T>(key: string): Promise<T | undefined> =>
        (changes.has(key) ? changes.get(key) : await current.get(key)) as T | undefined;
      const put = (key: string, value: unknown) => changes.set(key, value as JsonValue);
      const root = async (id: string) => {
        let value = roots.get(id);
        if (!value) {
          value = { ...(await get<ConversationRoot>(rootKey(id)) ??
            { id, deleted: false, control: false, runs: 0, assignments: 0, lifecycle: 0, version: 0 }) };
          if (value.id !== id) throw corruptRunJournal('Conversation recovery root binding is invalid');
          roots.set(id, value);
        }
        value.version = position;
        return value;
      };
      const assignment = async (id: string, change: (value: AssignmentWork) => void) => {
        const key = assignmentKey(id), prior = await get<AssignmentWork>(key) ?? {}, next = { ...prior };
        change(next);
        if (prior.conversationId && next.conversationId !== prior.conversationId) throw corruptRunJournal('Recovery assignment changed conversation');
        if (next.conversationId) {
          const count = Number(owes(next)) - Number(!!prior.conversationId && owes(prior));
          (await root(next.conversationId)).assignments += count;
          changes.set('publish-pending/' + identity(next.conversationId) + '/' + identity(id), next.domains?.length ? id : undefined);
        }
        put(key, next);
      };
      for (const entry of entries) {
        if (!entry.body || typeof entry.body !== 'object' || Array.isArray(entry.body)) continue;
        const body = entry.body as Record<string, unknown>;
        if (entry.stream === 'publish' && typeof body.assignmentId === 'string') {
          put('publish-frame/' + identity(body.assignmentId) + '/' + order(position), location);
        }
        if (entry.stream === 'final-outbox' && body.t === 'final' && typeof body.conversationId === 'string' &&
            typeof body.runId === 'string' && typeof body.commitRevision === 'number') {
          const key = finalIdentity(body as unknown as FinalFrame), p = identity(body.conversationId) + '/' + key;
          const previous = await get<{ state: string; at: string; digest: string }>('final-current/' + key);
          const meta = await root(body.conversationId);
          if (!previous) {
            if (body.state !== 'pending' || body.commitRevision <= (meta.finalRevision ?? 0)) throw corruptRunJournal('Final outbox must begin pending');
            const bound = entries.filter(item => item.stream === 'run:' + body.conversationId &&
              (item.body as { t?: string; runId?: string; commitRevision?: number })?.t === 'committed' &&
              (item.body as { runId?: string }).runId === body.runId && (item.body as { commitRevision?: number }).commitRevision === body.commitRevision);
            if (bound.length !== 1) throw corruptRunJournal('Final outbox must bind exactly one committed run');
            meta.finalRevision = body.commitRevision;
          }
          if (previous && (previous.digest !== body.digest ||
            !(previous.state === 'pending' && (body.state === 'published' || body.state === 'expired') || previous.state === 'published' && body.state === 'expired'))) {
            throw corruptRunJournal('Final outbox transition is invalid');
          }
          put('final-frame/' + key + '/' + order(position), location);
          changes.set('final-pending/' + p, body.state === 'pending' ? key : undefined);
          if (previous?.state === 'published') changes.set('final-published/' + identity(body.conversationId) + '/' + order(Date.parse(previous.at)) + '/' + key, undefined);
          if (body.state === 'published') put('final-published/' + identity(body.conversationId) + '/' + order(Date.parse(at)) + '/' + key, key);
          put('final-current/' + key, { state: body.state, at: at, digest: body.digest });
          await root(body.conversationId);
        }
        if (entry.stream.startsWith('run:')) {
          const id = entry.stream.slice(4), summary = await root(id);
          if (body.t === 'state' && typeof body.runId === 'string' && typeof body.state === 'string') {
            const key = 'run/' + identity([id, body.runId]), prior = await get<boolean>(key) ?? false;
            const active = openStates.has(body.state); summary.runs += Number(active) - Number(prior);
            put(key, active);
          } else if (typeof body.domainRevision === 'number' &&
              (body.t === 'session-lifecycle' || body.t === 'session-meta' && body.operation === 'delete' || body.kind === 'conversation-lifecycle-projection')) {
            const key = 'lifecycle/' + identity([id, body.domainRevision]);
            const prior = await get<{ fact?: boolean; projected?: boolean }>(key) ?? {}, next = { ...prior };
            if (body.t === 'session-lifecycle' || body.t === 'session-meta') { next.fact = true; if (body.mutation === 'delete' || body.operation === 'delete') summary.deleted = true; }
            else next.projected = true;
            summary.lifecycle += Number(!!next.fact && !next.projected) - Number(!!prior.fact && !prior.projected);
            put(key, next);
          } else if (body.t === 'committed' && typeof body.assignmentId === 'string' && typeof body.commitRevision === 'number') {
            const terminal = await get<boolean>('final/' + identity([id, body.commitRevision]));
            await assignment(body.assignmentId, value => { value.conversationId = id; value.revision = body.commitRevision as number; value.final = terminal === true; });
            put('revision/' + identity([id, body.commitRevision]), body.assignmentId);
            // Continuation ownership is refined by its own domain in package 1b.
            if ((body.readSummary as { controlRecovery?: boolean } | undefined)?.controlRecovery !== false) summary.control = true;
          } else if (typeof body.assignmentId === 'string' &&
              (body.t === 'bundle-ack-observed' || body.kind === 'conversation-commit-projection')) {
            await assignment(body.assignmentId, value => {
              if (body.t === 'bundle-ack-observed') value.acknowledged = true;
              else value.projected = true;
            });
          }
        } else if (entry.stream === 'publish' && body.t === 'publish-decision' && typeof body.assignmentId === 'string') {
          const decision = validatePublishDecisionRecord(body);
          const commits = entries.filter(item => item.stream.startsWith('run:') &&
            (item.body as { t?: string; assignmentId?: string })?.t === 'committed' &&
            (item.body as { assignmentId?: string }).assignmentId === decision.assignmentId);
          if (commits.length !== 1) throw corruptRunJournal('Publish decision must bind exactly one committed run');
          let domains: ('session' | 'global')[];
          const plans: AssignmentWork['plans'] = {};
          try {
            const text = Buffer.from(await artifacts.get(decision.batch.ref)).toString('utf8');
            const batch = validateMutationBatch(JSON.parse(text));
            if (canonicalize(batch) !== text || batch.assignmentId !== decision.assignmentId) throw corruptRunJournal('Recovery publish batch binding is invalid');
            validatePublishDecisionForBatch(decision, batch);
            domains = (['session', 'global'] as const).filter(domain => domainPublishDecisionRequired(batch.records, decision.outcomes, domain));
            for (const domain of domains) plans[domain] = { ...publishDomainSequence(batch.records, decision.outcomes, domain)!, position: 0 };
          } catch (error) {
            if (!(error instanceof AuthorityStorageError) || error.code !== 'artifact-missing') throw error;
            // An upgraded directory may encounter an already reclaimed batch.
            // Later durable settlement/deletion can discharge it without that
            // body. Otherwise keep it pending: absence never proves completion.
            domains = (['session', 'global'] as const).filter(domain =>
              (domain === 'session' ? decision.sessionCount : decision.globalCount) > 0);
          }
          await assignment(decision.assignmentId, value => { value.domains = domains; value.plans = plans; });
        } else if (entry.stream === 'publish' && body.t === 'publish-progress' &&
            typeof body.assignmentId === 'string' && (body.domain === 'session' || body.domain === 'global')) {
          await assignment(body.assignmentId, value => {
            const domain = body.domain as 'session' | 'global', plan = value.plans?.[domain];
            if (plan) {
              const next = { state: String(body.state), upToSeq: Number(body.upToSeq) };
              const prior = plan.progress ?? (next.upToSeq > 0 ? { state: 'pending', upToSeq: 0 } : undefined);
              if (!publishProgressFollows({ current: prior, next, nextGrantedSeq: plan.grantedSeqs[plan.position],
                terminalSeq: plan.terminalSeq, noGranted: plan.grantedSeqs.length === 0 })) throw corruptRunJournal('Publish progress skips or misstates a decided mutation');
              value.plans = { ...value.plans, [domain]: { ...plan, progress: next, position: plan.position + Number(next.upToSeq > 0) } };
            }
            if (body.state === 'settled') value.domains = value.domains?.filter(candidate => candidate !== domain) ?? [];
          });
        } else if (entry.stream === 'final-outbox' && body.t === 'final' && typeof body.conversationId === 'string' &&
            typeof body.commitRevision === 'number' && (body.state === 'published' || body.state === 'expired')) {
          const key = identity([body.conversationId, body.commitRevision]); put('final/' + key, true);
          const id = await get<string>('revision/' + key);
          if (id) await assignment(id, value => { value.final = true; });
        }
      }
      for (const value of roots.values()) {
        if ([value.runs, value.assignments, value.lifecycle].some(n => !Number.isSafeInteger(n) || n < 0)) throw corruptRunJournal('Conversation recovery count is invalid');
        put(rootKey(value.id), value);
        const pending = value.lifecycle > 0 || value.control || (!value.deleted && (value.runs > 0 || value.assignments > 0));
        changes.set('pending/' + identity(value.id), pending ? value.id : undefined);
      }
      return [...changes].map(([key, value]): DurableProjectionMutation => value === undefined
        ? { kind: 'tombstone', key } : { kind: 'put', key, value });
}
