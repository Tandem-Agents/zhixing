import { artifactJsonIndex, assertArtifactRef, type ArtifactStore, type AuthorityCommitLog } from '@zhixing/core/authority';
import type { ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { validateConversationRunRecord, validateFinalOutboxRecord } from './conversation-run-contracts.js';
import type { JsonValue, SessionMeta, ArtifactRef, ConversationCommitSummary } from '@zhixing/core/contracts';
import { projectStatusEntry, type StatusHistoryEntry } from './conversation-status-projection.js';
import { validateMutationBatch, validatePublishDecisionForBatch, validatePublishDecisionRecord, canonicalize } from '@zhixing/core/protocol';
import type { DurableLogCheckpoint, DurableProjectionMutation } from '@zhixing/core/authority';
import { parseConversationId } from '@zhixing/core/conversation';
import type { ConversationRunJournalRecord } from './conversation-run-contracts.js';
import { isMessageDeliveryFact } from './conversation-message-delivery.js';

export interface ReadMeta {
  count: number; clearedThrough: number; baseRevision: number; name?: string;
  activity: string; sessionActivity?: string; clearId?: string; clearedLsn?: number; deleted?: boolean;
}
export interface ControlRead { readonly entry?: StatusHistoryEntry; readonly communication: boolean; readonly continuation: boolean; readonly commit?: CommitPointer }
export interface CommitPointer { readonly timelineKey?: string; readonly runId: string; readonly assignmentId: string; readonly commitRevision: number; readonly bundle: ArtifactRef; readonly readSummary?: ConversationCommitSummary; readonly publish?: Extract<import('@zhixing/core/contracts').PublishRecord, { t: 'publish-decision' }> }
export interface InputPointer { readonly runId: string; readonly inputKey: string; readonly position: number; readonly lsn: number; readonly identity: NonNullable<import('@zhixing/core').Message['inputIdentity']>; readonly checkpoint?: DurableLogCheckpoint; readonly item: number }
export type TimelinePointer = { readonly key: string; readonly lsn: number } & (
  { readonly kind: 'commit'; readonly commit: CommitPointer } | { readonly kind: 'input'; readonly input: InputPointer });
const timelineKey = (lsn: number, item: number, local: boolean) => `${local ? 0 : 1}:${ordinal(Number.MAX_SAFE_INTEGER - lsn)}:${ordinal(Number.MAX_SAFE_INTEGER - item)}`;
const prefix = (conversationId: string) => `${JSON.stringify(conversationId)}:`;
const ordinal = (revision: number) => String(revision).padStart(16, '0');
/** Domain read directory contains identities and authoritative locators only.
 * Metadata queries never reconstruct execution state or open transcript bodies. */
export class ConversationReadIndex {
  readonly index;
  #base = new Map<string, JsonValue>();
  #baseRecords: readonly { lsn: number; at: string; stream: string; body: unknown }[] = [];
  constructor(readonly log: AuthorityCommitLog, readonly artifacts: ArtifactStore, readonly verifier: ProtocolSignatureVerifier) {
    this.index = log.durableProjection<ConversationRunJournalRecord>({
      projectionId: 'conversation-read-directory', reducerVersion: 12,
      reduce: async (envelope, current, source) => this.#reduce(envelope.entries, envelope.at, envelope.lsn, key => current.get(key), source.checkpoint),
    });
  }
  async #reduce(entries: readonly { stream: string; body: unknown }[], at: string, lsn: number, get: (key: string) => Promise<JsonValue | undefined>, checkpoint?: DurableLogCheckpoint, baseStart = 0): Promise<DurableProjectionMutation[]> {
    const changes: DurableProjectionMutation[] = [], overlay = new Map<string, JsonValue>();
    const read = (key: string) => overlay.has(key) ? Promise.resolve(overlay.get(key)) : get(key);
    const put = (key: string, value: unknown) => { overlay.set(key, value as JsonValue); changes.push({ kind: 'put', key, value: value as JsonValue }); };
    for (const [item, entry] of entries.entries()) {
      if (checkpoint && entry.stream === 'final-outbox' && (entry.body as { t?: string })?.t === 'final') {
        const final = validateFinalOutboxRecord(entry.body);
        put(prefix(final.conversationId) + 'control:' + ordinal(lsn), checkpoint);
      }
      if (!entry.stream.startsWith('run:')) continue;
      const id = entry.stream.slice(4), p = prefix(id), key = `${p}meta`, raw = entry.body;
      if (!raw || typeof raw !== 'object' || !('t' in raw)) continue;
      const directoryFact = ['committed', 'session-meta', 'session-control', 'session-lifecycle', 'advancement-event', 'admitted', 'run-input-appended', 'state'].includes(String(raw.t));
      if (!directoryFact && !isMessageDeliveryFact(raw)) continue;
      const body = validateConversationRunRecord(raw, this.verifier);
      if (checkpoint && isMessageDeliveryFact(body)) put(p + 'message-fact:' + ordinal(lsn), checkpoint);
      if (!directoryFact) continue;
      if (checkpoint && ['admitted', 'run-input-appended', 'state'].includes(body.t)) {
        put(p + 'control:' + ordinal(lsn), checkpoint);
      }
      if (checkpoint && (['session-meta', 'session-control', 'session-lifecycle', 'advancement-event'].includes(body.t) ||
          body.t === 'committed' && (this.#publish(entries, body.assignmentId).publish?.sessionCount ?? 0) > 0)) {
        put(p + 'session:' + ordinal(lsn), checkpoint);
      }
      if (body.t === 'admitted' || body.t === 'run-input-appended') {
        if (body.t === 'admitted' && body.ingress.turnOrigin?.worksceneContinuation) put(p + 'continuation:' + JSON.stringify(body.runId), true);
        // Older interactive admissions have a durable ingress ID but no message identity.
        const identity = body.ingress.turnOrigin?.messageIdentity ?? { id: body.ingress.ingressId, source: { kind: 'user' as const } };
        if (identity) {
          const pointer: InputPointer = { runId: body.runId, inputKey: body.ingressKey, position: body.t === 'admitted' ? body.queuedPosition : body.position, lsn, identity, ...(checkpoint ? { checkpoint } : {}), item: checkpoint ? item : baseStart + item };
          put(p + 'input:' + JSON.stringify(body.runId) + ':' + ordinal(pointer.position), pointer);
          const order = timelineKey(lsn, item, !!checkpoint);
          put(p + 'timeline:' + order, { key: order, lsn, kind: 'input', input: pointer });
          if (identity.source.kind === 'conversation') put(p + 'communication:' + JSON.stringify(body.runId), true);
        }
        continue;
      }
      if (body.t === 'state') {
        const statusKey = p + 'status:' + JSON.stringify(body.runId);
        const previous = await read(statusKey) as unknown as StatusHistoryEntry | undefined;
        const resolutions = entries.flatMap(entry => { const fact = entry.body as ConversationRunJournalRecord; return entry.stream === 'run:' + id && fact && 't' in fact && fact.t === 'resolution' && fact.runId === body.runId ? [fact.fact] : []; });
        // Imported execution prefixes are verified by the transfer owner. An
        // atomic closure identifies that prior uncertain state without loading it.
        const previousState = previous?.state ?? (resolutions.some(fact => fact.resolution) ? 'uncertain' : undefined);
        const status = projectStatusEntry(body, at, previousState, resolutions);
        put(statusKey, status);
        put(p + 'status-history:' + JSON.stringify(body.runId) + ':' + ordinal(body.statusRevision), status);
        continue;
      }
      if (body.t === 'advancement-event') { put(p + 'has-advancement', true); continue; }
          const meta: ReadMeta = { ...(await read(key) as unknown as ReadMeta ??
            { count: 0, clearedThrough: 0, baseRevision: 0, activity: '1970-01-01T00:00:00.000Z' }) };
          if (body.t === 'committed') {
            meta.count++; meta.baseRevision = body.commitRevision; meta.activity = at;
            const name = await this.#stagedName(entries, body.assignmentId); if (name !== undefined) meta.name = name;
            const pointer: CommitPointer = { timelineKey: timelineKey(lsn, item, !!checkpoint), runId: body.runId, assignmentId: body.assignmentId, commitRevision: body.commitRevision, bundle: body.bundle.ref,
              ...(body.readSummary ? { readSummary: body.readSummary } : {}), ...this.#publish(entries, body.assignmentId) };
            put(p + 'commit-order:' + pointer.timelineKey, pointer);
            put(p + 'timeline:' + pointer.timelineKey, { key: pointer.timelineKey, lsn, kind: 'commit', commit: pointer });
            changes.push({ kind: 'put', key: `${p}commit:${ordinal(Number.MAX_SAFE_INTEGER - body.commitRevision)}`, value: pointer as unknown as JsonValue },
              { kind: 'put', key: `${p}run:${JSON.stringify(body.runId)}`, value: pointer as unknown as JsonValue });
          } else if (body.t === 'session-meta') { meta.sessionActivity = body.lastActiveAt; if (body.operation === 'delete') meta.deleted = true; }
          else if (body.t === 'session-control') {
            if (body.mutation.kind === 'session-meta' && body.mutation.patch.name !== undefined) meta.name = body.mutation.patch.name;
            meta.activity = at;
          } else if (body.t === 'session-lifecycle') {
            if (body.mutation === 'clear') { meta.count = 0; meta.clearedThrough = meta.baseRevision; meta.clearId = body.requestId; meta.clearedLsn = lsn; }
            else meta.deleted = true;
            meta.activity = at;
          }
          put(key, meta);
        }
    return changes;
  }
  #publish(entries: readonly { stream: string; body: unknown }[], assignmentId: string): { publish?: CommitPointer['publish'] } {
    const decisions = entries.filter(entry => entry.stream === 'publish' && (entry.body as { t?: string; assignmentId?: string })?.t === 'publish-decision' && (entry.body as { assignmentId?: string }).assignmentId === assignmentId);
    if (!decisions.length) return {};
    if (decisions.length !== 1) throw Error('conversation-read-publish-duplicate');
    return { publish: validatePublishDecisionRecord(decisions[0]!.body) };
  }
  async finalConflicts(commit: CommitPointer): Promise<number> {
    const decision = commit.publish;
    if (!decision) return 0;
    const text = Buffer.from(await this.artifacts.get(decision.batch.ref)).toString('utf8');
    const batch = validateMutationBatch(JSON.parse(text));
    if (canonicalize(batch) !== text || batch.assignmentId !== commit.assignmentId) throw Error('conversation-read-publish-binding');
    const validated = validatePublishDecisionForBatch(decision, batch);
    return validated.outcomes.filter(item => item.outcome.t === 'conflicted').length;
  }
  async sessionPage(conversationId: string, afterLsn: number): Promise<readonly DurableLogCheckpoint[]> {
    const p = prefix(conversationId) + 'session:';
    return (await this.index.scan({ gt: p + ordinal(afterLsn), lt: p + '\uffff' }, 64)).entries.map(entry => entry.value as unknown as DurableLogCheckpoint);
  }
  async controlPage(conversationId: string, afterLsn: number): Promise<readonly DurableLogCheckpoint[]> {
    const p = prefix(conversationId) + 'control:';
    const page = await this.index.scan({ gt: p + ordinal(afterLsn), lt: p + '\uffff' }, 64);
    return page.entries.map(entry => entry.value as unknown as DurableLogCheckpoint);
  }
  async messagePage(conversationId: string, afterLsn: number): Promise<readonly DurableLogCheckpoint[]> {
    const p = prefix(conversationId) + 'message-fact:';
    return (await this.index.scan({ gt: p + ordinal(afterLsn), lt: p + '\uffff' }, 64))
      .entries.map(entry => entry.value as unknown as DurableLogCheckpoint);
  }
  async status(conversationId: string, runId: string): Promise<{ entry?: StatusHistoryEntry; communication: boolean }> {
    const p = prefix(conversationId), key = p + 'status:' + JSON.stringify(runId);
    return { entry: (await this.index.get(key) ?? this.#base.get(key)) as unknown as StatusHistoryEntry | undefined, communication: !!(await this.index.get(p + 'communication:' + JSON.stringify(runId)) ?? this.#base.get(p + 'communication:' + JSON.stringify(runId))) };
  }
  /** A control recovery chunk owns this view only until its page returns. The
   * caller still rechecks lifecycle/transfer generation after collecting facts. */
  async control(conversationId: string, runIds: readonly string[]): Promise<ReadonlyMap<string, ControlRead>> {
    if (runIds.length > 63) throw new TypeError('Control read chunk exceeds 63 runs');
    const ids = [...new Set(runIds)], p = prefix(conversationId);
    if (!ids.length) return new Map();
    const keys = [p + 'meta', ...ids.flatMap(id => {
      const suffix = JSON.stringify(id);
      return [p + 'status:' + suffix, p + 'communication:' + suffix, p + 'run:' + suffix, p + 'continuation:' + suffix];
    })];
    const values = await this.index.getMany(keys);
    const meta = this.#mergeState(conversationId, values[0] as unknown as ReadMeta | undefined);
    const result = new Map<string, ControlRead>();
    for (const [i, id] of ids.entries()) {
      const offset = 1 + i * 4;
      const read = (n: number) => values[offset + n] ?? this.#base.get(keys[offset + n]!);
      const commit = read(2) as unknown as CommitPointer | undefined;
      result.set(id, { entry: read(0) as unknown as StatusHistoryEntry | undefined, communication: !!read(1), continuation: !!read(3),
        commit: !meta.deleted && commit && commit.commitRevision > meta.clearedThrough ? commit : undefined });
    }
    return result;
  }
  async statusHistory(conversationId: string, runId: string, afterRevision: number): Promise<readonly StatusHistoryEntry[]> {
    const p = prefix(conversationId) + 'status-history:' + JSON.stringify(runId) + ':';
    const local = await this.index.scan({ gt: p + ordinal(afterRevision), lt: p + '\uffff' }, 65);
    const selected = new Map<number, StatusHistoryEntry>();
    for (const [key, value] of this.#base) if (key.startsWith(p)) {
      const entry = value as unknown as StatusHistoryEntry;
      if (entry.statusRevision > afterRevision) selected.set(entry.statusRevision, entry);
    }
    for (const entry of local.entries) { const value = entry.value as unknown as StatusHistoryEntry; selected.set(value.statusRevision, value); }
    return [...selected.values()].sort((a, b) => a.statusRevision - b.statusRevision).slice(0, 65);
  }
  async input(conversationId: string, runId: string, position: number, inputKey: string | undefined, imported: boolean, lowerLsn: number, upperLsn: number): Promise<{ pointer: InputPointer; input: import('./conversation-run-contracts.js').Stored<import('@zhixing/core/contracts').UserTurnInput> } | undefined> {
    const p = prefix(conversationId) + 'input:' + JSON.stringify(runId) + ':';
    let pointer: InputPointer | undefined;
    if (imported) {
      for (const [key, value] of this.#base) if (key.startsWith(p)) {
        const candidate = value as unknown as InputPointer;
        if (candidate.position >= position && candidate.lsn > lowerLsn && (!inputKey || candidate.inputKey === inputKey) && (!pointer || candidate.position < pointer.position)) pointer = candidate;
      }
    } else {
      let continuation: string | undefined;
      do {
        const page = await this.index.scan({ gte: p + ordinal(position), lt: p + '\uffff' }, 64, continuation);
        for (const entry of page.entries) {
          const candidate = entry.value as unknown as InputPointer;
          if (candidate.lsn > upperLsn) return;
          if (candidate.lsn > lowerLsn && (!inputKey || candidate.inputKey === inputKey)) { pointer = candidate; break; }
        }
        if (pointer) break;
        continuation = page.continuation;
      } while (continuation);
    }
    if (!pointer) return;
    return this.inputAt(conversationId, pointer);
  }
  async inputAt(conversationId: string, pointer: InputPointer) {
    return (await this.inputsAt(conversationId, [pointer]))[0]!;
  }
  /** Materialize one bounded input page under a single verified WAL read. */
  async inputsAt(conversationId: string, pointers: readonly InputPointer[]) {
    if (pointers.length > 64) throw new TypeError('Input body read exceeds 64 locators');
    const checkpoints = [...new Map(pointers.flatMap(pointer => pointer.checkpoint
      ? [[canonicalize(pointer.checkpoint), pointer.checkpoint] as const] : [])).values()];
    const envelopes = await this.log.readEnvelopesAt<unknown>(checkpoints);
    const byCheckpoint = new Map(checkpoints.map((checkpoint, i) => [canonicalize(checkpoint), envelopes[i]!]));
    return pointers.map(pointer => {
    const runId = pointer.runId;
    const source = pointer.checkpoint ? byCheckpoint.get(canonicalize(pointer.checkpoint))?.entries[pointer.item] : this.#baseRecords[pointer.item];
    if (!source || source.stream !== 'run:' + conversationId) throw Error('conversation-read-input-location');
    const body = validateConversationRunRecord(source.body, this.verifier);
    if ((body.t !== 'admitted' && body.t !== 'run-input-appended') || body.runId !== runId || body.ingressKey !== pointer.inputKey || (body.t === 'admitted' ? body.queuedPosition : body.position) !== pointer.position) throw Error('conversation-read-input-binding');
    return { pointer, input: body.input };
    });
  }
  async #stagedName(entries: readonly { stream: string; body: unknown }[], assignmentId: string): Promise<string | undefined> {
    const decision = entries.find(entry => entry.stream === 'publish' && (entry.body as { t?: string; assignmentId?: string })?.t === 'publish-decision' &&
      (entry.body as { assignmentId?: string }).assignmentId === assignmentId)?.body as { batch?: { ref?: unknown }; sessionCount?: number } | undefined;
    if (!decision?.sessionCount) return;
    const ref = decision.batch?.ref; assertArtifactRef(ref);
    const json = artifactJsonIndex(this.artifacts);
    while (!(await json.prepare(ref)).ready) await new Promise<void>(setImmediate);
    const records = await json.node(ref, ['records']); if (records?.kind !== 'array') throw Error('conversation-directory-mutation-batch');
    let name: string | undefined;
    for (let i = 0; i < records.units; i++) {
      if (await json.value(ref, ['records', i, 'domain'], 128) !== 'session' ||
          await json.value(ref, ['records', i, 'mutation', 'kind'], 128) !== 'session-meta') continue;
      const value = await json.value(ref, ['records', i, 'mutation', 'patch', 'name'], 4096);
      if (value !== undefined) { if (typeof value !== 'string') throw Error('conversation-directory-name'); name = value; }
    }
    return name;
  }
  /** The transfer owner already verified this immutable prefix. Keep only its
   * locators/metadata alongside the local index, never copied message bodies. */
  async installBase(records: readonly { lsn: number; at: string; stream: string; body: unknown }[]): Promise<void> {
    const candidate = new Map<string, JsonValue>();
    let start = 0;
    while (start < records.length) {
      let end = start + 1; while (end < records.length && records[end]!.lsn === records[start]!.lsn) end++;
      const changes = await this.#reduce(records.slice(start, end), records[start]!.at, records[start]!.lsn, async key => candidate.get(key), undefined, start);
      for (const change of changes) if (change.kind === 'put') candidate.set(change.key, change.value);
      start = end;
    }
    this.#base = candidate; this.#baseRecords = records;
  }
  async state(conversationId: string): Promise<ReadMeta> {
    const key = `${prefix(conversationId)}meta`;
    return this.#mergeState(conversationId, await this.index.get(key) as unknown as ReadMeta | undefined);
  }
  /** No advancement obligation can exist before its signed owner event.
   * Keep historical/closed sessions eligible: their outstanding effects matter. */
  async hasAdvancement(conversationId: string): Promise<boolean> {
    const key = prefix(conversationId) + 'has-advancement';
    return (await this.index.get(key)) === true || this.#base.get(key) === true;
  }
  #mergeState(conversationId: string, local: ReadMeta | undefined): ReadMeta {
    const base = this.#base.get(`${prefix(conversationId)}meta`) as unknown as ReadMeta | undefined;
    if (!base) return local ?? { count: 0, clearedThrough: 0, baseRevision: 0, activity: '1970-01-01T00:00:00.000Z' };
    if (!local) return base;
    return { ...base, ...local, count: local.count + (local.clearId ? 0 : base.count),
      clearedThrough: Math.max(base.clearedThrough, local.clearedThrough, local.clearId ? base.baseRevision : 0),
      baseRevision: Math.max(base.baseRevision, local.baseRevision), name: local.name ?? base.name,
      clearId: local.clearId ?? base.clearId, clearedLsn: local.clearId ? local.clearedLsn : base.clearedLsn, deleted: local.deleted || base.deleted,
      activity: local.activity > base.activity ? local.activity : base.activity };
  }

  /** Stable authority order; at most four locators are materialized per page. */
  async timeline(conversationId: string, after?: string): Promise<readonly TimelinePointer[]> {
    const p = prefix(conversationId) + 'timeline:';
    const local = after?.startsWith('1:') ? [] : (await this.index.scan({ gt: p + (after ?? ''), lt: p + '\uffff' }, 4)).entries.map(entry => entry.value as unknown as TimelinePointer);
    if (local.length === 4) return local;
    const base: TimelinePointer[] = [];
    for (const [key, value] of this.#base) if (key.startsWith(p)) {
      const entry = value as unknown as TimelinePointer;
      if (after && entry.key <= after) continue;
      const position = base.findIndex(item => item.key > entry.key);
      base.splice(position < 0 ? base.length : position, 0, entry);
      if (base.length > 4 - local.length) base.pop();
    }
    return [...local, ...base];
  }
  async historyCommit(conversationId: string, throughLsn: number): Promise<CommitPointer | undefined> {
    const p = prefix(conversationId) + 'commit-order:', state = await this.state(conversationId);
    if (state.deleted) return;
    const local = await this.index.scan({ gte: p + timelineKey(throughLsn, Number.MAX_SAFE_INTEGER, true), lt: p + '1:' }, 1);
    let commit = local.entries[0]?.value as unknown as CommitPointer | undefined;
    if (!commit) for (const [key, value] of this.#base) if (key.startsWith(p)) {
      const candidate = value as unknown as CommitPointer;
      if (!commit || candidate.commitRevision > commit.commitRevision) commit = candidate;
    }
    return commit && commit.commitRevision > state.clearedThrough ? commit : undefined;
  }
  async timelineAt(conversationId: string, key: string): Promise<TimelinePointer | undefined> {
    const p = prefix(conversationId) + 'timeline:' + key;
    return (key.startsWith('1:') ? this.#base.get(p) : await this.index.get(p)) as unknown as TimelinePointer | undefined;
  }
  async timelineVisible(conversationId: string, pointer: TimelinePointer, throughLsn: number): Promise<boolean> {
    const local = await this.index.get(prefix(conversationId) + 'meta') as unknown as ReadMeta | undefined;
    const base = this.#base.get(prefix(conversationId) + 'meta') as unknown as ReadMeta | undefined;
    const state = this.#mergeState(conversationId, local);
    if (state.deleted) return false;
    const imported = pointer.key.startsWith('1:');
    if (imported && local?.clearId || !imported && pointer.lsn > throughLsn) return false;
    if (pointer.kind === 'commit') return pointer.commit.commitRevision > state.clearedThrough;
    if (pointer.lsn <= ((imported ? base : local)?.clearedLsn ?? 0)) return false;
    const commit = await this.commit(conversationId, pointer.input.runId);
    // A later commit is consumed by live completion. It cannot retroactively
    // remove a source from this history snapshot or break its cold replay.
    return !commit?.timelineKey || commit.timelineKey.startsWith('0:') && Number.MAX_SAFE_INTEGER - Number(commit.timelineKey.split(':')[1]) > throughLsn;
  }
  async latest(conversationId: string, before = Number.MAX_SAFE_INTEGER): Promise<CommitPointer | undefined> {
    const p = `${prefix(conversationId)}commit:`, meta = await this.state(conversationId);
    if (meta.deleted) return;
    const page = await this.index.scan({ gt: `${p}${ordinal(Number.MAX_SAFE_INTEGER - before)}`, lt: `${p}\uffff` }, 1);
    let pointer = page.entries[0]?.value as unknown as CommitPointer | undefined;
    if (!pointer) for (const [key, value] of this.#base) if (key.startsWith(p)) {
      const candidate = value as unknown as CommitPointer;
      if (candidate.commitRevision < before && (!pointer || candidate.commitRevision > pointer.commitRevision)) pointer = candidate;
    }
    return pointer && pointer.commitRevision > meta.clearedThrough ? pointer : undefined;
  }
  async commit(conversationId: string, runId: string): Promise<CommitPointer | undefined> {
    const p = prefix(conversationId);
    const key = `${p}run:${JSON.stringify(runId)}`;
    const [rawMeta, rawCommit] = await this.index.getMany([p + 'meta', key]);
    const meta = this.#mergeState(conversationId, rawMeta as unknown as ReadMeta | undefined);
    const commit = (rawCommit ?? this.#base.get(key)) as unknown as CommitPointer | undefined;
    return !meta?.deleted && commit && commit.commitRevision > (meta?.clearedThrough ?? 0) ? commit : undefined;
  }
  async meta(conversationId: string, ownerEpoch: number): Promise<SessionMeta> {
    const value = await this.state(conversationId);
    const scope = parseConversationId(conversationId).scope;
    return { conversationId, ownerEpoch, baseRevision: value?.baseRevision ?? 0, turnCount: value?.count ?? 0,
      ...(value?.name ? { name: value.name } : {}), ...(scope.kind === 'workscene' ? { sceneId: scope.sceneId } : {}),
      lastActiveAt: value?.sessionActivity ?? value?.activity ?? '1970-01-01T00:00:00.000Z' };
  }
}
