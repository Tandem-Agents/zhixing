import { artifactJsonIndex, assertArtifactRef, type ArtifactStore, type AuthorityCommitLog } from '@zhixing/core/authority';
import type { ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { validateConversationRunRecord } from './conversation-run-contracts.js';
import type { JsonValue, SessionMeta, ArtifactRef, ConversationCommitSummary } from '@zhixing/core/contracts';
import type { DurableProjectionMutation } from '@zhixing/core/authority';
import { parseConversationId } from '@zhixing/core/conversation';
import type { ConversationRunJournalRecord } from './conversation-run-contracts.js';

export interface ReadMeta {
  count: number; clearedThrough: number; baseRevision: number; name?: string;
  activity: string; sessionActivity?: string; clearId?: string; deleted?: boolean;
}
export interface CommitPointer { readonly runId: string; readonly assignmentId: string; readonly commitRevision: number; readonly bundle: ArtifactRef; readonly readSummary?: ConversationCommitSummary }
const prefix = (conversationId: string) => `${JSON.stringify(conversationId)}:`;
const ordinal = (revision: number) => String(revision).padStart(16, '0');
/** Domain read directory contains identities and authoritative locators only.
 * Metadata queries never reconstruct execution state or open transcript bodies. */
export class ConversationReadIndex {
  readonly index;
  readonly #base = new Map<string, JsonValue>();
  constructor(log: AuthorityCommitLog, readonly artifacts: ArtifactStore, readonly verifier: ProtocolSignatureVerifier) {
    this.index = log.durableProjection<ConversationRunJournalRecord>({
      projectionId: 'conversation-read-directory', reducerVersion: 4,
      reduce: async (envelope, current) => this.#reduce(envelope.entries, envelope.at, key => current.get(key)),
    });
  }
  async #reduce(entries: readonly { stream: string; body: unknown }[], at: string, get: (key: string) => Promise<JsonValue | undefined>): Promise<DurableProjectionMutation[]> {
    const changes: DurableProjectionMutation[] = [], overlay = new Map<string, ReadMeta>();
    for (const entry of entries) {
      if (!entry.stream.startsWith('run:')) continue;
      const id = entry.stream.slice(4), p = prefix(id), key = `${p}meta`, raw = entry.body;
      if (!raw || typeof raw !== 'object' || !('t' in raw) || !['committed', 'session-meta', 'session-control', 'session-lifecycle'].includes(String(raw.t))) continue;
      const body = validateConversationRunRecord(raw, this.verifier);
          const meta: ReadMeta = { ...(overlay.get(key) ?? await get(key) as unknown as ReadMeta ??
            { count: 0, clearedThrough: 0, baseRevision: 0, activity: '1970-01-01T00:00:00.000Z' }) };
          if (body.t === 'committed') {
            meta.count++; meta.baseRevision = body.commitRevision; meta.activity = at;
            const name = await this.#stagedName(entries, body.assignmentId); if (name !== undefined) meta.name = name;
            const pointer: CommitPointer = { runId: body.runId, assignmentId: body.assignmentId, commitRevision: body.commitRevision, bundle: body.bundle.ref,
              ...(body.readSummary ? { readSummary: body.readSummary } : {}) };
            changes.push({ kind: 'put', key: `${p}commit:${ordinal(Number.MAX_SAFE_INTEGER - body.commitRevision)}`, value: pointer as unknown as JsonValue },
              { kind: 'put', key: `${p}run:${JSON.stringify(body.runId)}`, value: pointer as unknown as JsonValue });
          } else if (body.t === 'session-meta') { meta.sessionActivity = body.lastActiveAt; if (body.operation === 'delete') meta.deleted = true; }
          else if (body.t === 'session-control') {
            if (body.mutation.kind === 'session-meta' && body.mutation.patch.name !== undefined) meta.name = body.mutation.patch.name;
            meta.activity = at;
          } else if (body.t === 'session-lifecycle') {
            if (body.mutation === 'clear') { meta.count = 0; meta.clearedThrough = meta.baseRevision; meta.clearId = body.requestId; }
            else meta.deleted = true;
            meta.activity = at;
          }
          overlay.set(key, meta); changes.push({ kind: 'put', key, value: meta as unknown as JsonValue });
        }
    return changes;
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
    this.#base.clear();
    let start = 0;
    while (start < records.length) {
      let end = start + 1; while (end < records.length && records[end]!.lsn === records[start]!.lsn) end++;
      const changes = await this.#reduce(records.slice(start, end), records[start]!.at, async key => this.#base.get(key));
      for (const change of changes) if (change.kind === 'put') this.#base.set(change.key, change.value);
      start = end;
    }
  }
  async state(conversationId: string): Promise<ReadMeta> {
    const key = `${prefix(conversationId)}meta`, base = this.#base.get(key) as unknown as ReadMeta | undefined;
    const local = await this.index.get(key) as unknown as ReadMeta | undefined;
    if (!base) return local ?? { count: 0, clearedThrough: 0, baseRevision: 0, activity: '1970-01-01T00:00:00.000Z' };
    if (!local) return base;
    return { ...base, ...local, count: local.count + (local.clearId ? 0 : base.count),
      clearedThrough: Math.max(base.clearedThrough, local.clearedThrough, local.clearId ? base.baseRevision : 0),
      baseRevision: Math.max(base.baseRevision, local.baseRevision), name: local.name ?? base.name,
      clearId: local.clearId ?? base.clearId, deleted: local.deleted || base.deleted,
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
