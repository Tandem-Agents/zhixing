import { artifactJsonIndex, assertArtifactRef, type ArtifactStore, type AuthorityCommitLog } from '@zhixing/core/authority';
import type { ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { validateConversationRunRecord } from './conversation-run-contracts.js';
import type { JsonValue, SessionMeta, ArtifactRef, ConversationCommitSummary } from '@zhixing/core/contracts';
import { projectStatusEntry, type StatusHistoryEntry } from './conversation-status-projection.js';
import { validateMutationBatch, validatePublishDecisionForBatch, validatePublishDecisionRecord, canonicalize } from '@zhixing/core/protocol';
import type { DurableLogCheckpoint, DurableProjectionMutation } from '@zhixing/core/authority';
import { parseConversationId } from '@zhixing/core/conversation';
import type { ConversationRunJournalRecord } from './conversation-run-contracts.js';

export interface ReadMeta {
  count: number; clearedThrough: number; baseRevision: number; name?: string;
  activity: string; sessionActivity?: string; clearId?: string; clearedLsn?: number; deleted?: boolean;
}
export interface ControlRead { readonly entry?: StatusHistoryEntry; readonly communication: boolean; readonly commit?: CommitPointer }
export interface CommitPointer { readonly runId: string; readonly assignmentId: string; readonly commitRevision: number; readonly bundle: ArtifactRef; readonly readSummary?: ConversationCommitSummary; readonly publish?: Extract<import('@zhixing/core/contracts').PublishRecord, { t: 'publish-decision' }> }
export interface InputPointer { readonly runId: string; readonly inputKey: string; readonly position: number; readonly lsn: number; readonly identity: NonNullable<import('@zhixing/core').Message['inputIdentity']>; readonly checkpoint?: DurableLogCheckpoint; readonly item: number }
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
      projectionId: 'conversation-read-directory', reducerVersion: 6,
      reduce: async (envelope, current, source) => this.#reduce(envelope.entries, envelope.at, envelope.lsn, key => current.get(key), source.checkpoint),
    });
  }
  async #reduce(entries: readonly { stream: string; body: unknown }[], at: string, lsn: number, get: (key: string) => Promise<JsonValue | undefined>, checkpoint?: DurableLogCheckpoint, baseStart = 0): Promise<DurableProjectionMutation[]> {
    const changes: DurableProjectionMutation[] = [], overlay = new Map<string, JsonValue>();
    const read = (key: string) => overlay.has(key) ? Promise.resolve(overlay.get(key)) : get(key);
    const put = (key: string, value: unknown) => { overlay.set(key, value as JsonValue); changes.push({ kind: 'put', key, value: value as JsonValue }); };
    for (const [item, entry] of entries.entries()) {
      if (!entry.stream.startsWith('run:')) continue;
      const id = entry.stream.slice(4), p = prefix(id), key = `${p}meta`, raw = entry.body;
      if (!raw || typeof raw !== 'object' || !('t' in raw) || !['committed', 'session-meta', 'session-control', 'session-lifecycle', 'advancement-event', 'admitted', 'run-input-appended', 'state'].includes(String(raw.t))) continue;
      const body = validateConversationRunRecord(raw, this.verifier);
      if (checkpoint && (['session-meta', 'session-control', 'session-lifecycle', 'advancement-event'].includes(body.t) ||
          body.t === 'committed' && (this.#publish(entries, body.assignmentId).publish?.sessionCount ?? 0) > 0)) {
        put(p + 'session:' + ordinal(lsn), checkpoint);
      }
      if (body.t === 'admitted' || body.t === 'run-input-appended') {
        const identity = body.ingress.turnOrigin?.messageIdentity;
        if (identity) {
          put(p + 'input:' + JSON.stringify(body.runId) + ':' + ordinal(body.t === 'admitted' ? body.queuedPosition : body.position), { runId: body.runId, inputKey: body.ingressKey, position: body.t === 'admitted' ? body.queuedPosition : body.position, lsn, identity, ...(checkpoint ? { checkpoint } : {}), item: checkpoint ? item : baseStart + item });
          if (identity.source.kind === 'conversation') put(p + 'communication:' + JSON.stringify(body.runId), true);
        }
        continue;
      }
      if (body.t === 'state') {
        const statusKey = p + 'status:' + JSON.stringify(body.runId);
        const previous = await read(statusKey) as unknown as StatusHistoryEntry | undefined;
        const resolutions = entries.flatMap(entry => { const fact = entry.body as ConversationRunJournalRecord; return entry.stream === 'run:' + id && fact?.t === 'resolution' && fact.runId === body.runId ? [fact.fact] : []; });
        // Imported execution prefixes are verified by the transfer owner. An
        // atomic closure identifies that prior uncertain state without loading it.
        const previousState = previous?.state ?? (resolutions.some(fact => fact.resolution) ? 'uncertain' : undefined);
        const status = projectStatusEntry(body, at, previousState, resolutions);
        put(statusKey, status);
        put(p + 'status-history:' + JSON.stringify(body.runId) + ':' + ordinal(body.statusRevision), status);
        continue;
      }
      if (body.t === 'advancement-event') continue;
          const meta: ReadMeta = { ...(await read(key) as unknown as ReadMeta ??
            { count: 0, clearedThrough: 0, baseRevision: 0, activity: '1970-01-01T00:00:00.000Z' }) };
          if (body.t === 'committed') {
            meta.count++; meta.baseRevision = body.commitRevision; meta.activity = at;
            const name = await this.#stagedName(entries, body.assignmentId); if (name !== undefined) meta.name = name;
            const pointer: CommitPointer = { runId: body.runId, assignmentId: body.assignmentId, commitRevision: body.commitRevision, bundle: body.bundle.ref,
              ...(body.readSummary ? { readSummary: body.readSummary } : {}), ...this.#publish(entries, body.assignmentId) };
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
  async status(conversationId: string, runId: string): Promise<{ entry?: StatusHistoryEntry; communication: boolean }> {
    const p = prefix(conversationId), key = p + 'status:' + JSON.stringify(runId);
    return { entry: (await this.index.get(key) ?? this.#base.get(key)) as unknown as StatusHistoryEntry | undefined, communication: !!(await this.index.get(p + 'communication:' + JSON.stringify(runId)) ?? this.#base.get(p + 'communication:' + JSON.stringify(runId))) };
  }
  /** A control recovery chunk owns this view only until its page returns. The
   * caller still rechecks lifecycle/transfer generation after collecting facts. */
  async control(conversationId: string, runIds: readonly string[]): Promise<ReadonlyMap<string, ControlRead>> {
    if (runIds.length > 64) throw new TypeError('Control read chunk exceeds 64 runs');
    const ids = [...new Set(runIds)], p = prefix(conversationId);
    if (!ids.length) return new Map();
    const keys = [p + 'meta', ...ids.flatMap(id => {
      const suffix = JSON.stringify(id);
      return [p + 'status:' + suffix, p + 'communication:' + suffix, p + 'run:' + suffix];
    })];
    const values = await this.index.getMany(keys);
    const meta = this.#mergeState(conversationId, values[0] as unknown as ReadMeta | undefined);
    const result = new Map<string, ControlRead>();
    for (const [i, id] of ids.entries()) {
      const offset = 1 + i * 3;
      const read = (n: number) => values[offset + n] ?? this.#base.get(keys[offset + n]!);
      const commit = read(2) as unknown as CommitPointer | undefined;
      result.set(id, { entry: read(0) as unknown as StatusHistoryEntry | undefined, communication: !!read(1),
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
    const source = pointer.checkpoint ? (await this.log.readEnvelopeAt(pointer.checkpoint)).entries[pointer.item] : this.#baseRecords[pointer.item];
    if (!source || source.stream !== 'run:' + conversationId) throw Error('conversation-read-input-location');
    const body = validateConversationRunRecord(source.body, this.verifier);
    if ((body.t !== 'admitted' && body.t !== 'run-input-appended') || body.runId !== runId || body.ingressKey !== pointer.inputKey || (body.t === 'admitted' ? body.queuedPosition : body.position) !== pointer.position) throw Error('conversation-read-input-binding');
    return { pointer, input: body.input };
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
    const meta = await this.state(conversationId);
    const key = `${p}run:${JSON.stringify(runId)}`;
    const commit = (await this.index.get(key) ?? this.#base.get(key)) as unknown as CommitPointer | undefined;
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
