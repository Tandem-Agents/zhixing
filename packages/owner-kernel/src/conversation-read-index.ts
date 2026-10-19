import { artifactJsonIndex, createDurableProjectionOverlay, assertArtifactRef, type ArtifactStore, type AuthorityCommitLog } from '@zhixing/core/authority';
import type { ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { validateConversationRunRecord, validateFinalOutboxRecord } from './conversation-run-contracts.js';
import type { JsonValue, SessionMeta, ArtifactRef, ConversationCommitSummary } from '@zhixing/core/contracts';
import { projectStatusEntry, type StatusHistoryEntry } from './conversation-status-projection.js';
import { validateMutationBatch, validatePublishDecisionForBatch, validatePublishDecisionRecord, canonicalize } from '@zhixing/core/protocol';
import type { DurableLogCheckpoint, DurableProjectionMutation, DurableProjectionReadContext } from '@zhixing/core/authority';
import { parseConversationId } from '@zhixing/core/conversation';
import type { ConversationRunJournalRecord } from './conversation-run-contracts.js';
import { isMessageDeliveryFact } from './conversation-message-delivery.js';
import type { ConversationControlTargets } from '@zhixing/core/contracts';
import { isConversationSourceEvidenceError, type ConversationBaseSource } from './conversation-base-source.js';
import { conversationViewOverlay, conversationBaseKey, openConversationBase, foldConversationBaseBindings, registerConversationBaseContext, registerConversationBaseRepair, conversationBaseUnavailableKey, conversationBaseRepairRequired, type ConversationBaseBinding } from './conversation-base-registry.js';
import { worksceneContinuationTurnId, type WorksceneContinuationSource } from '@zhixing/core/workscene/application';
import { loadStored, snapshotStored } from './control-admission.js';

const interruptible = (state: string | undefined): state is ConversationControlTargets['targets'][number]['state'] =>
  state !== undefined && ['queued', 'dispatched', 'running', 'cancel-requested'].includes(state);
interface ControlCandidate { readonly kind: 'control-target'; readonly conversationId: string; readonly runId: string; readonly lsn: number; readonly local: boolean }

export interface ReadMeta {
  count: number; clearedThrough: number; baseRevision: number; name?: string;
  activity: string; sessionActivity?: string; clearId?: string; clearedLsn?: number; deleted?: boolean;
}
export interface ControlRead { readonly entry?: StatusHistoryEntry; readonly communication: boolean; readonly continuation: boolean; readonly commit?: CommitPointer }
export interface CommitPointer { readonly timelineKey?: string; readonly runId: string; readonly assignmentId: string; readonly commitRevision: number; readonly bundle: ArtifactRef; readonly readSummary?: ConversationCommitSummary; readonly publish?: Extract<import('@zhixing/core/contracts').PublishRecord, { t: 'publish-decision' }> }
export interface InputPointer { readonly runId: string; readonly inputKey: string; readonly position: number; readonly lsn: number; readonly identity: NonNullable<import('@zhixing/core').Message['inputIdentity']>; readonly checkpoint?: DurableLogCheckpoint; readonly item: number; readonly initial?: boolean }
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
  #baseControlCandidates = new Map<string, Map<string, ControlCandidate>>();
  #baseView: DurableProjectionReadContext | undefined;
  #source: ConversationBaseSource | undefined;
  #baseDirectoryView: DurableProjectionReadContext | undefined;
  #readBaseRecord: ((item: number) => Promise<{ lsn: number; at: string; stream: string; body: unknown }>) | undefined;
  readonly #reducer: ConversationDirectoryReducer;
  constructor(readonly log: AuthorityCommitLog, readonly artifacts: ArtifactStore, readonly verifier: ProtocolSignatureVerifier) {
    this.index = registerConversationReadProjection(log, artifacts, verifier);
    this.#reducer = directoryBindings.get(log)!.reducer;
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
  async controlTargets(conversationId: string): Promise<ConversationControlTargets> {
    if (this.#baseView) {
      const view = this.#baseView, p = prefix(conversationId);
      const [base, local] = await Promise.all([
        this.#baseDirectoryView!.get(p + 'meta') as Promise<ReadMeta | undefined>,
        this.index.get(p + 'meta') as Promise<ReadMeta | undefined>,
      ]);
      const meta = this.#mergeValues(base, local);
      if (meta.deleted) return { targets: [] };
      const candidates = new Map<string, ControlCandidate>();
      let after: string | undefined;
      do {
        const page = await view.scan({ ...(after ? { gt: after } : { gte: p + 'control-candidate:' }), lt: p + 'control-candidate:\uffff' }, 64);
        for (const entry of page.entries) {
          const value = entry.value as unknown as ControlCandidate;
          if (value.kind !== 'control-target' || value.conversationId !== conversationId || entry.key !== p + 'control-candidate:' + JSON.stringify(value.runId)) throw Error('Control target binding is invalid');
          candidates.set(value.runId, value);
        }
        after = page.continuation ? page.entries.at(-1)!.key : undefined;
      } while (after);
      const queued: ConversationControlTargets['targets'][number][] = [], active: typeof queued = [];
      for (const candidate of candidates.values()) {
        if (candidate.local ? candidate.lsn <= (local?.clearedLsn ?? 0) : !!local?.clearId || candidate.lsn <= (base?.clearedLsn ?? 0)) continue;
        const key = p + 'status:' + JSON.stringify(candidate.runId);
        const status = await view.get(key) as unknown as StatusHistoryEntry | undefined;
        if (!status || !interruptible(status.state)) continue;
        const target = { runId: candidate.runId, state: status.state };
        if (status.state === 'queued') { if (queued.length < 2) queued.push(target); }
        else active.push(target);
        if (active.length === 2) break;
      }
      return { targets: active.length ? active : queued };
    }
    return (await this.log.transactDurableProjection<never, ConversationControlTargets>('conversation-read-directory', async current => {
      const p = prefix(conversationId), local = await current.get(p + 'meta') as unknown as ReadMeta | undefined;
      const meta = this.#mergeState(conversationId, local);
      if (meta.deleted) return { kind: 'return', value: { targets: [] } };
      const candidates = new Map(this.#baseControlCandidates.get(conversationId));
      let after: string | undefined;
      do {
        const page = await current.scan({ ...(after ? { gt: after } : { gte: p + 'control-candidate:' }), lt: p + 'control-candidate:\uffff' }, 64);
        for (const entry of page.entries) {
          const value = entry.value as unknown as ControlCandidate;
          if (value.kind !== 'control-target' || value.conversationId !== conversationId || entry.key !== p + 'control-candidate:' + JSON.stringify(value.runId)) throw Error('Control target binding is invalid');
          candidates.set(value.runId, value);
        }
        after = page.continuation ? page.entries.at(-1)!.key : undefined;
      } while (after);
      const queued: ConversationControlTargets['targets'][number][] = [], active: typeof queued = [];
      for (const candidate of candidates.values()) {
        if (candidate.local ? candidate.lsn <= (local?.clearedLsn ?? 0) :
          !!local?.clearId || candidate.lsn <= ((this.#base.get(p + 'meta') as unknown as ReadMeta | undefined)?.clearedLsn ?? 0)) continue;
        const key = p + 'status:' + JSON.stringify(candidate.runId);
        const status = (await current.get(key) ?? this.#base.get(key)) as unknown as StatusHistoryEntry | undefined;
        if (!status || !interruptible(status.state)) continue;
        const target = { runId: candidate.runId, state: status.state };
        if (status.state === 'queued') { if (queued.length < 2) queued.push(target); }
        else active.push(target);
        if (active.length === 2) break;
      }
      return { kind: 'return', value: { targets: active.length ? active : queued } };
    })).value;
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
  async messageMetadata(conversationId: string, messageId: string) {
    return this.log.transactDurableProjection<never, { pointer: InputPointer; status: StatusHistoryEntry; consumed: boolean; closed: boolean } | undefined>('conversation-read-directory', async (current, context) => {
      let source = this.#source;
      if (source) {
        const binding = await context.readProjection('conversation-run-state-v1').get(conversationBaseKey(conversationId)) as unknown as ConversationBaseBinding | undefined;
        if (!binding) throw new TypeError('Imported message read has no published base');
        source = await openConversationBase(this.log, binding);
        if (source.namespace !== this.#source!.namespace) throw new TypeError('Imported message base generation changed');
      }
      const p = prefix(conversationId), key = p + 'message-id:' + JSON.stringify(messageId);
      const baseGet = (key: string) => source ? source.read(view => view.get('directory/' + key)) : Promise.resolve(this.#base.get(key));
      // The old source precedes the local tail; preserve first-ingress identity.
      const pointer = (await baseGet(key) ?? await current.get(key)) as unknown as InputPointer | undefined;
      if (!pointer) return { kind: 'return', value: undefined };
      const statusKey = p + 'status:' + JSON.stringify(pointer.runId);
      const status = (await current.get(statusKey) ?? await baseGet(statusKey)) as unknown as StatusHistoryEntry | undefined;
      if (!status) throw new TypeError('Message identity has no current run status');
      const consumedKey = pointer.initial ? p + 'initial-consumed:' + JSON.stringify(pointer.runId) : p + 'input-consumed:' + JSON.stringify(pointer.inputKey);
      const consumed = (await current.get(consumedKey) ?? await baseGet(consumedKey)) === true;
      const closedKey = p + 'input-closed:' + JSON.stringify(pointer.runId);
      const closed = (await current.get(closedKey) ?? await baseGet(closedKey)) === true;
      return { kind: 'return', value: { pointer, status, consumed, closed } };
    }, this.#source ? { readProjectionIds: ['conversation-run-state-v1'] } : {});
  }
  async status(conversationId: string, runId: string): Promise<{ entry?: StatusHistoryEntry; communication: boolean }> {
    const p = prefix(conversationId), key = p + 'status:' + JSON.stringify(runId), communicationKey = p + 'communication:' + JSON.stringify(runId);
    if (this.#baseView) {
      const [entry, communication] = await Promise.all([this.#baseView.get(key), this.#baseView.get(communicationKey)]);
      return { entry: entry as unknown as StatusHistoryEntry | undefined, communication: !!communication };
    }
    return { entry: (await this.index.get(key) ?? this.#base.get(key)) as unknown as StatusHistoryEntry | undefined, communication: !!(await this.index.get(communicationKey) ?? this.#base.get(communicationKey)) };
  }
  /** Current unfinished continuation obligations. Only this conversation's
   * bounded marker rows are read: cancelled obligations leave the set at the
   * cancelling fact, and everything behind a stop/clear fence stays out of the
   * scan, so query cost never grows with ended history. */
  async pendingObligationRuns(conversationId: string): Promise<readonly string[]> {
    if (this.#source && await this.index.get(conversationBaseUnavailableKey(conversationId))) {
      const binding = await this.index.get(conversationBaseKey(conversationId)) as unknown as ConversationBaseBinding;
      throw conversationBaseRepairRequired(this.log, binding);
    }
    const p = prefix(conversationId), prefixKey = p + 'obligation-order:';
    const after = prefixKey + ordinal(await this.stopFence(conversationId));
    const runs = new Set<string>();
    const collect = async (view: DurableProjectionReadContext) => {
      let cursor: string | undefined;
      do {
        const page = await view.scan({ ...(cursor ? { gt: cursor } : { gt: after }), lt: prefixKey + '\uffff' }, 64);
        for (const entry of page.entries) {
          const suffix = entry.key.slice(prefixKey.length), separator = suffix.indexOf(':');
          try {
            const runId = JSON.parse(suffix.slice(separator + 1)) as unknown;
            if (typeof runId === 'string') runs.add(runId);
          } catch {}
        }
        cursor = page.continuation ? page.entries.at(-1)!.key : undefined;
      } while (cursor);
    };
    await collect(this.index);
    for (const view of [this.index]) {
      if (!view) continue;
      const key = p + 'continuation-drain:';
      let after: string | undefined;
      do {
        const page = await view.scan({ ...(after ? { gt: after } : { gte: key }), lt: key + '\uffff' }, 64);
        for (const entry of page.entries) if (typeof entry.value === 'string') runs.add(entry.value);
        after = page.continuation ? page.entries.at(-1)!.key : undefined;
      } while (after);
    }
    return [...runs];
  }
  /** Exact historical relation, separate from current recovery discovery. */
  async continuationChildren(conversationId: string, parent: { conversationId: string; runId: string }): Promise<readonly string[]> {
    const key = prefix(conversationId) + 'continuation-child:' + JSON.stringify([parent.conversationId, parent.runId]) + ':';
    const values = new Set<string>();
    for (const view of [this.#baseDirectoryView, this.index]) {
      if (!view) continue;
      let after: string | undefined;
      do {
        const page = await view.scan({ ...(after ? { gt: after } : { gte: key }), lt: key + '\uffff' }, 64);
        for (const entry of page.entries) {
          if (typeof entry.value !== 'string') throw Error('Invalid continuation child identity');
          values.add(entry.value);
        }
        after = page.continuation ? page.entries.at(-1)!.key : undefined;
      } while (after);
    }
    return [...values];
  }
  async continuationMember(conversationId: string, root: { conversationId: string; runId: string }): Promise<string | undefined> {
    const key = prefix(conversationId) + 'continuation-member:' + JSON.stringify([root.conversationId, root.runId]);
    const value = await this.index.get(key) ?? (this.#baseDirectoryView ? await this.#baseDirectoryView.get(key) : this.#base.get(key));
    return typeof value === 'string' ? value : undefined;
  }
  async continuationPending(conversationId: string, runIds: readonly string[]): Promise<ReadonlySet<string>> {
    const result = new Set<string>();
    for (const runId of runIds) {
      const key = prefix(conversationId) + 'obligation:' + JSON.stringify(runId);
      const local = await this.index.get(key);
      const value = local ?? (this.#baseDirectoryView ? await this.#baseDirectoryView.get(key) : this.#base.get(key));
      if (value) result.add(runId);
    }
    return result;
  }
  async continuationFrontiers(root: { conversationId: string; runId: string }): Promise<readonly { conversationId: string; runId: string }[]> {
    const key = prefix(root.conversationId) + 'continuation-frontier:' + JSON.stringify(root.runId) + ':';
    const result = new Map<string, { conversationId: string; runId: string }>();
    for (const view of [this.index]) {
      if (!view) continue;
      let after: string | undefined;
      do {
        const page = await view.scan({ ...(after ? { gt: after } : { gte: key }), lt: key + '\uffff' }, 64);
        for (const entry of page.entries) {
          if (entry.value === false) result.delete(entry.key);
          else result.set(entry.key, entry.value as unknown as { conversationId: string; runId: string });
        }
        after = page.continuation ? page.entries.at(-1)!.key : undefined;
      } while (after);
    }
    return [...result.values()];
  }
  /** The applied stop fence (batch cancel, clear or delete), read by key only. */
  async stopFence(conversationId: string): Promise<number> {
    return Number(await this.index.get(prefix(conversationId) + 'stop-fence') ?? 0);
  }
  /** Applied per-run stops for exactly these runs; one keyed read each. */
  async stoppedRuns(conversationId: string, runIds: readonly string[]): Promise<ReadonlySet<string>> {
    const p = prefix(conversationId), stopped = new Set<string>();
    const localFence = Number(await this.index.get(p + 'stop-fence') ?? 0);
    const baseGet = (key: string) => this.#baseDirectoryView ? this.#baseDirectoryView.get(key) : Promise.resolve(this.#base.get(key));
    const baseFence = Number(await baseGet(p + 'stop-fence') ?? 0);
    for (const runId of new Set(runIds)) {
      const suffix = JSON.stringify(runId), key = p + 'stop:' + suffix;
      const localAt = await this.index.get(p + 'admission-at:' + suffix);
      const baseAt = localAt === undefined ? await baseGet(p + 'admission-at:' + suffix) : undefined;
      if ((await this.index.get(key) ?? await baseGet(key)) === true ||
          typeof localAt === 'number' && localAt <= localFence ||
          typeof baseAt === 'number' && (baseAt <= baseFence || localFence > 0)) stopped.add(runId);
    }
    return stopped;
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
    const meta = this.#baseView
      ? this.#mergeValues(await this.#baseView.get(p + 'meta') as unknown as ReadMeta | undefined, undefined)
      : this.#mergeState(conversationId, values[0] as unknown as ReadMeta | undefined);
    const result = new Map<string, ControlRead>();
    for (const [i, id] of ids.entries()) {
      const offset = 1 + i * 4;
      const read = async (n: number) => values[offset + n] ?? (this.#baseView ? await this.#baseView.get(keys[offset + n]!) : this.#base.get(keys[offset + n]!));
      const commit = await read(2) as unknown as CommitPointer | undefined;
      result.set(id, { entry: await read(0) as unknown as StatusHistoryEntry | undefined, communication: !!(await read(1)), continuation: !!(await read(3)),
        commit: !meta.deleted && commit && commit.commitRevision > meta.clearedThrough ? commit : undefined });
    }
    return result;
  }
  async statusHistory(conversationId: string, runId: string, afterRevision: number): Promise<readonly StatusHistoryEntry[]> {
    const p = prefix(conversationId) + 'status-history:' + JSON.stringify(runId) + ':';
    if (this.#baseView) {
      const page = await this.#baseView.scan({ gt: p + ordinal(afterRevision), lt: p + '\uffff' }, 65);
      return page.entries.map(entry => entry.value as unknown as StatusHistoryEntry);
    }
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
    if (imported && this.#baseView) {
      const page = await this.#baseView.scan({ gte: p + ordinal(position), lt: p + '\uffff' }, 64);
      for (const entry of page.entries) {
        const candidate = entry.value as unknown as InputPointer;
        if (candidate.checkpoint || candidate.position < position || candidate.lsn <= lowerLsn || inputKey && candidate.inputKey !== inputKey) continue;
        if (!pointer || candidate.position < pointer.position) pointer = candidate;
      }
    } else if (imported) {
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
    return Promise.all(pointers.map(async pointer => {
    const runId = pointer.runId;
    const source = pointer.checkpoint ? byCheckpoint.get(canonicalize(pointer.checkpoint))?.entries[pointer.item]
      : this.#readBaseRecord ? await this.#readBaseRecord(pointer.item) : this.#baseRecords[pointer.item];
    if (!source || source.stream !== 'run:' + conversationId) throw Error('conversation-read-input-location');
    const body = validateConversationRunRecord(source.body, this.verifier);
    if ((body.t !== 'admitted' && body.t !== 'run-input-appended') || body.runId !== runId || body.ingressKey !== pointer.inputKey || (body.t === 'admitted' ? body.queuedPosition : body.position) !== pointer.position) throw Error('conversation-read-input-binding');
    return { pointer, input: body.input };
    }));
  }
  /** The transfer owner already verified this immutable prefix. Keep only its
   * locators/metadata alongside the local index, never copied message bodies. */
  installBaseView(source: ConversationBaseSource): void {
    this.#source = source;
    this.#base.clear(); this.#baseRecords = []; this.#baseControlCandidates.clear();
    const local: DurableProjectionReadContext = {
      get: key => this.index.get(key),
      scan: (range, limit) => this.index.scan(range, limit),
    };
    const directory: DurableProjectionReadContext = {
      get: key => source.read(view => view.get('directory/' + key)),
      scan: async (range, limit) => {
        const prefix = 'directory/';
        const query = { ...(range.gte ? { gte: prefix + range.gte } : {}), ...(range.gt ? { gt: prefix + range.gt } : {}), ...(range.lt ? { lt: prefix + range.lt } : {}) };
        const page = await source.read(view => view.scan(query, limit));
        return { entries: page.entries.map(entry => ({ key: entry.key.slice(prefix.length), value: entry.value })),
          ...(page.continuation ? { continuation: page.continuation.slice(prefix.length) } : {}) };
      },
    };
    this.#baseView = conversationViewOverlay(local, directory);
    this.#baseDirectoryView = directory;
    this.#readBaseRecord = item => source.recordAt(item);
  }

  async installBase(records: readonly { lsn: number; at: string; stream: string; body: unknown }[]): Promise<void> {
    this.#source = undefined;
    this.#baseView = undefined; this.#baseDirectoryView = undefined; this.#readBaseRecord = undefined;
    const candidate = new Map<string, JsonValue>();
    let start = 0;
    while (start < records.length) {
      let end = start + 1; while (end < records.length && records[end]!.lsn === records[start]!.lsn) end++;
      const changes = await this.#reducer.reduce(records.slice(start, end), records[start]!.at, records[start]!.lsn, async key => candidate.get(key), undefined, start, async (range, limit) => {
        const entries = [...candidate].filter(([key]) => (range.gt === undefined || key > range.gt) &&
          (range.gte === undefined || key >= range.gte) && (range.lt === undefined || key < range.lt))
          .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, value }));
        const page = entries.slice(0, limit);
        return { entries: page, ...(entries.length > limit ? { continuation: page.at(-1)!.key } : {}) };
      });
      for (const change of changes) if (change.kind === 'put') candidate.set(change.key, change.value); else candidate.delete(change.key);
      start = end;
    }
    const controls = new Map<string, Map<string, ControlCandidate>>();
    for (const value of candidate.values()) {
      const target = value as unknown as ControlCandidate;
      if (target?.kind !== 'control-target') continue;
      const values = controls.get(target.conversationId) ?? new Map<string, ControlCandidate>();
      values.set(target.runId, target); controls.set(target.conversationId, values);
    }
    this.#base = candidate; this.#baseRecords = records; this.#baseControlCandidates = controls;
  }
  async state(conversationId: string): Promise<ReadMeta> {
    const key = `${prefix(conversationId)}meta`;
    if (this.#baseDirectoryView) {
      const [base, local] = await Promise.all([
        this.#baseDirectoryView.get(key) as Promise<ReadMeta | undefined>,
        this.index.get(key) as Promise<ReadMeta | undefined>,
      ]);
      return this.#mergeValues(base, local);
    }
    return this.#mergeState(conversationId, await this.index.get(key) as unknown as ReadMeta | undefined);
  }
  /** No advancement obligation can exist before its signed owner event.
   * Keep historical/closed sessions eligible: their outstanding effects matter. */
  async hasAdvancement(conversationId: string): Promise<boolean> {
    const key = prefix(conversationId) + 'has-advancement';
    if (this.#baseView) return (await this.#baseView.get(key)) === true;
    return (await this.index.get(key)) === true || this.#base.get(key) === true;
  }
  #mergeValues(base: ReadMeta | undefined, local: ReadMeta | undefined): ReadMeta {
    if (!base) return local ?? { count: 0, clearedThrough: 0, baseRevision: 0, activity: '1970-01-01T00:00:00.000Z' };
    if (!local) return base;
    return { ...base, ...local, count: local.count + (local.clearId ? 0 : base.count),
      clearedThrough: Math.max(base.clearedThrough, local.clearedThrough, local.clearId ? base.baseRevision : 0),
      baseRevision: Math.max(base.baseRevision, local.baseRevision), name: local.name ?? base.name,
      clearId: local.clearId ?? base.clearId, clearedLsn: local.clearId ? local.clearedLsn : base.clearedLsn, deleted: local.deleted || base.deleted,
      activity: local.activity > base.activity ? local.activity : base.activity };
  }
  #mergeState(conversationId: string, local: ReadMeta | undefined): ReadMeta {
    return this.#mergeValues(this.#base.get(`${prefix(conversationId)}meta`) as unknown as ReadMeta | undefined, local);
  }

  /** Stable authority order; at most four locators are materialized per page. */
  async timeline(conversationId: string, after?: string): Promise<readonly TimelinePointer[]> {
    const p = prefix(conversationId) + 'timeline:';
    if (this.#baseView) {
      const page = await this.#baseView.scan({ gt: p + (after ?? ''), lt: p + '\uffff' }, 4);
      return page.entries.map(entry => entry.value as unknown as TimelinePointer);
    }
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
    if (this.#baseView) {
      const page = await this.#baseView.scan({ gte: p + timelineKey(throughLsn, Number.MAX_SAFE_INTEGER, true), lt: p + '\uffff' }, 1);
      const commit = page.entries[0]?.value as unknown as CommitPointer | undefined;
      return commit && commit.commitRevision > state.clearedThrough ? commit : undefined;
    }
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
    if (this.#baseView) return await this.#baseView.get(p) as unknown as TimelinePointer | undefined;
    return (key.startsWith('1:') ? this.#base.get(p) : await this.index.get(p)) as unknown as TimelinePointer | undefined;
  }
  async timelineVisible(conversationId: string, pointer: TimelinePointer, throughLsn: number): Promise<boolean> {
    if (this.#baseView) {
      const key = prefix(conversationId) + 'meta';
      const [local, base] = await Promise.all([
        this.index.get(key) as Promise<ReadMeta | undefined>,
        this.#baseDirectoryView!.get(key) as Promise<ReadMeta | undefined>,
      ]);
      const state = this.#mergeValues(base, local);
      if (state.deleted) return false;
      const imported = pointer.key.startsWith('1:');
      if (imported && local?.clearId || !imported && pointer.lsn > throughLsn) return false;
      if (pointer.kind === 'commit') return pointer.commit.commitRevision > state.clearedThrough;
      if (pointer.lsn <= ((imported ? base : local)?.clearedLsn ?? 0)) return false;
      const commit = await this.commit(conversationId, pointer.input.runId);
      return !commit?.timelineKey || commit.timelineKey.startsWith('0:') && Number.MAX_SAFE_INTEGER - Number(commit.timelineKey.split(':')[1]) > throughLsn;
    }
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
    if (this.#baseView) {
      const page = await this.#baseView.scan({ gt: `${p}${ordinal(Number.MAX_SAFE_INTEGER - before)}`, lt: `${p}\uffff` }, 1);
      const pointer = page.entries[0]?.value as unknown as CommitPointer | undefined;
      return pointer && pointer.commitRevision > meta.clearedThrough ? pointer : undefined;
    }
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
    if (this.#baseView) {
      const [baseMeta, localMeta, rawCommit] = await Promise.all([
        this.#baseDirectoryView!.get(p + 'meta') as Promise<ReadMeta | undefined>,
        this.index.get(p + 'meta') as Promise<ReadMeta | undefined>,
        this.#baseView.get(key),
      ]);
      const meta = this.#mergeValues(baseMeta, localMeta);
      const commit = rawCommit as unknown as CommitPointer | undefined;
      return !meta.deleted && commit && commit.commitRevision > meta.clearedThrough ? commit : undefined;
    }
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

/** This reducer has no journal, imported-prefix state or runtime lifecycle. */
export class ConversationDirectoryReducer {
  constructor(readonly artifacts: ArtifactStore, readonly verifier: ProtocolSignatureVerifier) {}
  async reduce(entries: readonly { stream: string; body: unknown }[], at: string, lsn: number, get: (key: string) => Promise<JsonValue | undefined>, checkpoint?: DurableLogCheckpoint, baseStart = 0, scan?: DurableProjectionReadContext['scan']): Promise<DurableProjectionMutation[]> {
    const changes: DurableProjectionMutation[] = [], overlay = new Map<string, JsonValue | undefined>();
    const read = (key: string) => overlay.has(key) ? Promise.resolve(overlay.get(key)) : get(key);
    const put = (key: string, value: unknown) => { overlay.set(key, value as JsonValue); changes.push({ kind: 'put', key, value: value as JsonValue }); };
    const drop = (key: string) => { overlay.set(key, undefined); changes.push({ kind: 'tombstone', key }); };
    type Obligation = { lsn: number; action: boolean; stops: number };
    type RunRef = { conversationId: string; runId: string };
    const marker = (id: string, runId: string) => prefix(id) + 'obligation:' + JSON.stringify(runId);
    const publish = async (id: string, runId: string, value: Obligation | undefined) => {
      const key = marker(id, runId), previous = await read(key) as unknown as Obligation | undefined;
      if (previous) drop(prefix(id) + 'obligation-order:' + ordinal(previous.lsn) + ':' + JSON.stringify(runId));
      put(key, value ?? false);
      if (value) {
        put(prefix(id) + 'obligation-at:' + JSON.stringify(runId), value.lsn);
        put(prefix(id) + 'obligation-order:' + ordinal(value.lsn) + ':' + JSON.stringify(runId), true);
      }
    };
    const updateRoot = async (root: RunRef, delta: number) => {
      const p = prefix(root.conversationId), suffix = JSON.stringify(root.runId), countKey = p + 'continuation-pending:' + suffix;
      const count = Number(await read(countKey) ?? 0) + delta;
      if (count < 0) throw Error('Continuation obligation count underflow');
      put(countKey, count);
      const drain = p + 'continuation-drain:' + suffix;
      if (count || await read(p + 'continuation-cancel-advancement-run:' + suffix)) put(drain, root.runId); else drop(drain);
      const previous = await read(marker(root.conversationId, root.runId)) as unknown as Obligation | undefined;
      const at = previous?.lsn ?? Number(await read(p + 'obligation-at:' + suffix) ?? lsn);
      const stopped = await read(p + 'stop:' + suffix) === true || at <= Number(await read(p + 'stop-fence') ?? 0);
      if (stopped) return;
      if (count || previous?.action || previous?.stops) await publish(root.conversationId, root.runId, previous || { lsn: at, action: false, stops: 0 });
      else await publish(root.conversationId, root.runId, undefined);
    };
    const change = async (id: string, runId: string, next: Obligation | undefined) => {
      const p = prefix(id), suffix = JSON.stringify(runId);
      const previous = await read(marker(id, runId)) as unknown as Obligation | undefined;
      const root = await read(p + 'continuation-root:' + suffix) as unknown as RunRef | undefined;
      const descendants = Number(await read(p + 'continuation-pending:' + suffix) ?? 0);
      const stopped = await read(p + 'stop:' + suffix) === true || (next?.lsn ?? previous?.lsn ?? lsn) <= Number(await read(p + 'stop-fence') ?? 0);
      const live = !!next && (next.action || next.stops > 0) && !stopped;
      const delta = Number(live) - Number(!!previous && (previous.action || previous.stops > 0));
      await publish(id, runId, !stopped && (next?.action || next?.stops || descendants) ? next ?? { lsn: previous?.lsn ?? lsn, action: false, stops: 0 } : undefined);
      if (root) {
        const frontier = prefix(root.conversationId) + 'continuation-frontier:' + JSON.stringify(root.runId) + ':' + JSON.stringify([id, runId]);
        if (live) {
          put(frontier, { conversationId: id, runId });
          put(p + 'continuation-drain:' + suffix, runId);
        } else {
          drop(frontier);
          if (!descendants && !await read(p + 'continuation-cancel-advancement-run:' + suffix)) drop(p + 'continuation-drain:' + suffix);
        }
        if (delta) await updateRoot(root, delta);
      }
    };
    const retire = async (id: string, runId: string, consumed = false) => {
      const previous = await read(marker(id, runId)) as unknown as Obligation | undefined;
      // Ordinary runs never entered this directory. Repeated retirement also
      // keeps an existing false overlay intact; neither case needs to look up
      // descendant/frontier state or publish another empty row. Consumption is
      // a separate durable receipt and must still run even without a candidate.
      if (!previous && !consumed) return;
      if (consumed) put(prefix(id) + 'continuation-consumed:' + JSON.stringify(runId), true);
      await change(id, runId, consumed && previous?.stops ? { ...previous, action: false } : undefined);
    };
    const retain = (id: string, runId: string, action: boolean, stops = 0) => change(id, runId, { lsn, action, stops });
    for (const [item, entry] of entries.entries()) {
      // A stop only becomes durable in the control stream. Record its effect as
      // a keyed row so readers never replay the whole stream per instance.
      if (entry.stream === 'control') {
        const record = entry.body as { t?: string; requestId?: string; envelope?: unknown; result?: unknown };
        if (typeof record?.requestId !== 'string') continue;
        const requestKey = 'control-request:' + JSON.stringify(record.requestId);
        if (record.t === 'received') {
          const admitted = await loadStored<{ body?: { t?: string; conversationId?: string; runId?: string } }>(
            snapshotStored(record.envelope), this.artifacts, 'ControlEnvelope');
          const request = admitted?.body;
          if (request?.conversationId && request.t === 'cancel' && request.runId) put(requestKey, { conversationId: request.conversationId, runId: request.runId });
          else if (request?.conversationId && request.t === 'cancel-batch') put(requestKey, { conversationId: request.conversationId, batch: true });
          continue;
        }
        if (record.t !== 'applied') continue;
        const request = await read(requestKey) as unknown as { conversationId: string; runId?: string; batch?: boolean } | undefined;
        drop(requestKey);
        if (!request) continue;
        const result = await loadStored<{ status?: string }>(snapshotStored(record.result), this.artifacts, 'ControlResult');
        if (result?.status !== 'ok') continue;
        if (request.runId) {
          put(prefix(request.conversationId) + 'stop:' + JSON.stringify(request.runId), true);
          await retire(request.conversationId, request.runId);
        }
        else if (request.batch) put(prefix(request.conversationId) + 'stop-fence', lsn);
        const stopKey = 'continuation-stop-request:' + JSON.stringify(record.requestId);
        const source = await read(stopKey) as unknown as { conversationId: string; runId: string } | undefined;
        if (source) {
          const key = prefix(source.conversationId) + 'obligation:' + JSON.stringify(source.runId);
          const prior = await read(key) as unknown as Obligation | undefined;
          if (prior?.stops) {
            if (prior.stops === 1 && !prior.action) await retire(source.conversationId, source.runId);
            else put(key, { ...prior, stops: prior.stops - 1 });
          }
          drop(stopKey);
        }
        continue;
      }
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
      if (body.t === 'assigned') put(p + 'assignment-run:' + JSON.stringify(body.assignmentId), body.runId);
      if (body.t === 'run-input-consumed') for (const input of body.ingressKeys) put(p + 'input-consumed:' + JSON.stringify(input), true);
      if (body.t === 'supersede-started-observed') {
        const run = await read(p + 'assignment-run:' + JSON.stringify(body.assignmentId));
        if (typeof run === 'string') put(p + 'initial-consumed:' + JSON.stringify(run), true);
      }
      if (body.t === 'run-input-opened' || body.t === 'run-input-closed' || body.t === 'committed' || body.t === 'state' && body.state === 'running') {
        put(p + 'initial-consumed:' + JSON.stringify(body.runId), true);
      }
      if (body.t === 'run-input-opened') drop(p + 'input-closed:' + JSON.stringify(body.runId));
      if (body.t === 'run-input-closed') put(p + 'input-closed:' + JSON.stringify(body.runId), true);
      if (body.t === 'admitted') {
        put(p + 'admission-at:' + JSON.stringify(body.runId), lsn);
        const origin = body.ingress.turnOrigin?.worksceneContinuation;
        if (origin) {
          put(p + 'continuation-origin:' + JSON.stringify(body.runId), origin);
          const root = await read(prefix(origin.conversationId) + 'continuation-root:' + JSON.stringify(origin.runId)) ?? { conversationId: origin.conversationId, runId: origin.runId };
          put(p + 'continuation-root:' + JSON.stringify(body.runId), root);
          const rootRef = root as unknown as { conversationId: string; runId: string };
          put(p + 'continuation-member:' + JSON.stringify([rootRef.conversationId, rootRef.runId]), body.runId);
          const advancement = await read(prefix(rootRef.conversationId) + 'continuation-advancement:' + JSON.stringify(rootRef.runId));
          if (advancement) put(p + 'continuation-advancement:' + JSON.stringify(body.runId), advancement);
          put(p + 'continuation-child:' + JSON.stringify([origin.conversationId, origin.runId]) + ':' + JSON.stringify(body.runId), body.runId);
          // The durable successor admission is the existing consumption receipt.
          // No copied child list and no walk of descendants when a parent stops.
          await retire(origin.conversationId, origin.runId, true);
          await retain(id, body.runId, true);
        }
      } else if (body.t === 'committed') {
        const activeAdvancement = await read(p + 'continuation-active-advancement');
        if (typeof activeAdvancement === 'string') put(p + 'continuation-advancement:' + JSON.stringify(body.runId), { conversationId: id, sessionId: activeAdvancement });
        const summary = body.readSummary;
        const admittedOrigin = await read(p + 'continuation-origin:' + JSON.stringify(body.runId)) as { kind?: string } | undefined;
        if (summary?.controlRecovery !== false || admittedOrigin) {
          const metadata = await this.#continuationMetadata(body.bundle.ref);
          const origin = metadata.origin ?? admittedOrigin;
          const control = metadata.control;
          const stops = control?.stops ?? [];
          const consumed = await read(p + 'continuation-consumed:' + JSON.stringify(body.runId)) === true;
          const action = !consumed && control?.intent.kind !== 'stop_task' && (!!control?.intent.handoff?.remaining.length || !!origin && origin.kind !== 'result');
          await retain(id, body.runId, action, stops.length);
          for (const target of stops) put('continuation-stop-request:' + JSON.stringify(`stop:${worksceneContinuationTurnId({ conversationId: id, runId: body.runId })}:${target.runId}`), { conversationId: id, runId: body.runId });
        } else await retire(id, body.runId);
      } else if (body.t === 'state' && (body.state === 'cancelled' || body.state === 'cancel-requested')) {
        put(p + 'stop:' + JSON.stringify(body.runId), true);
        await retire(id, body.runId);
        const advancement = await read(p + 'continuation-advancement:' + JSON.stringify(body.runId)) as unknown as { conversationId: string; sessionId: string } | undefined;
        if (body.state === 'cancelled' && advancement) {
          const scope = JSON.stringify([advancement.conversationId, advancement.sessionId]);
          if (await read('continuation-advancement-closed:' + scope) !== true) {
            const key = 'continuation-cancel-advancement:' + scope + ':' + JSON.stringify([id, body.runId]);
            if (await read(key) === undefined) {
              put(key, { conversationId: id, runId: body.runId });
              put('continuation-cancel-count:' + scope, Number(await read('continuation-cancel-count:' + scope) ?? 0) + 1);
            }
            put(p + 'continuation-cancel-advancement-run:' + JSON.stringify(body.runId), advancement);
            put(p + 'continuation-drain:' + JSON.stringify(body.runId), body.runId);
          }
        }

      }
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
          const pointer: InputPointer = { runId: body.runId, inputKey: body.ingressKey, position: body.t === 'admitted' ? body.queuedPosition : body.position, lsn, identity, initial: body.t === 'admitted', ...(checkpoint ? { checkpoint } : {}), item: checkpoint ? item : baseStart + item };
          const messageKey = p + 'message-id:' + JSON.stringify(identity.id);
          if (await read(messageKey) === undefined) put(messageKey, pointer);
          put(p + 'input:' + JSON.stringify(body.runId) + ':' + ordinal(pointer.position), pointer);
          const order = timelineKey(lsn, item, !!checkpoint);
          put(p + 'timeline:' + order, { key: order, lsn, kind: 'input', input: pointer });
          if (identity.source.kind === 'conversation') {
            put(p + 'communication:' + JSON.stringify(body.runId), true);
            put(p + 'control-input:' + JSON.stringify(body.runId), lsn);
            const status = await read(p + 'status:' + JSON.stringify(body.runId)) as unknown as StatusHistoryEntry | undefined;
            if (status === undefined || interruptible(status.state)) put(p + 'control-candidate:' + JSON.stringify(body.runId),
              { kind: 'control-target', conversationId: id, runId: body.runId, lsn, local: !!checkpoint } satisfies ControlCandidate);
          }
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
        const candidateKey = p + 'control-candidate:' + JSON.stringify(body.runId);
        const inputLsn = await read(p + 'control-input:' + JSON.stringify(body.runId));
        if (interruptible(body.state) && typeof inputLsn === 'number') put(candidateKey,
          { kind: 'control-target', conversationId: id, runId: body.runId, lsn: inputLsn, local: !!checkpoint } satisfies ControlCandidate);
        else drop(candidateKey);
        continue;
      }
      if (body.t === 'advancement-event') {
        put(p + 'has-advancement', true);
        const event = await loadStored<{ type: string; sessionId?: string }>(snapshotStored(body.event), this.artifacts, 'AdvancementControlEvent');
        if (event.type === 'rubric_confirmed') put(p + 'continuation-active-advancement', event.sessionId!);
        if (event.sessionId && ['completed', 'exited', 'cancelled', 'session_regenerated'].includes(event.type)) {
          if (await read(p + 'continuation-active-advancement') === event.sessionId) drop(p + 'continuation-active-advancement');
          const scope = JSON.stringify([id, event.sessionId]), key = 'continuation-cancel-advancement:' + scope + ':';
          put('continuation-advancement-closed:' + scope, true);
          if (Number(await read('continuation-cancel-count:' + scope) ?? 0) > 0) {
            if (!scan) throw Error('Continuation cancellation requires its current directory');
            const view = createDurableProjectionOverlay({ get, scan }, overlay);
            let after: string | undefined;
            do {
              const page = await view.scan({ ...(after ? { gt: after } : { gte: key }), lt: key + '\uffff' }, 64);
              for (const row of page.entries) {
                const child = row.value as unknown as { conversationId: string; runId: string };
                drop(prefix(child.conversationId) + 'continuation-cancel-advancement-run:' + JSON.stringify(child.runId));
                if (!Number(await read(prefix(child.conversationId) + 'continuation-pending:' + JSON.stringify(child.runId)) ?? 0)) drop(prefix(child.conversationId) + 'continuation-drain:' + JSON.stringify(child.runId));
                drop(row.key);
              }
              after = page.continuation ? page.entries.at(-1)!.key : undefined;
            } while (after);
            put('continuation-cancel-count:' + scope, 0);
          }
        }
        continue;
      }
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
            // Clear and delete retire every earlier obligation without walking them.
            put(p + 'stop-fence', lsn);
            meta.activity = at;
          }
          put(key, meta);
        }
    return changes;
  }
  async #continuationMetadata(bundle: ArtifactRef): Promise<{
    control?: WorksceneContinuationSource['control']; origin?: { kind?: string };
  }> {
    const index = artifactJsonIndex(this.artifacts);
    while (!(await index.prepare(bundle)).ready) await new Promise<void>(setImmediate);
    const external = await index.value(bundle, ['body', 'runRecord', 'ref']);
    let ref = bundle, keys: string[] = ['body', 'runRecord'];
    if (external) { assertArtifactRef(external); ref = external; keys = []; while (!(await index.prepare(ref)).ready) await new Promise<void>(setImmediate); }
    const control = await index.value(ref, [...keys, 'postTurnControl'], 128 * 1024) as WorksceneContinuationSource['control'];
    const origin = await index.value(ref, [...keys, 'worksceneContinuation']) as { kind?: string } | undefined;
    return { control, origin };
  }
  #publish(entries: readonly { stream: string; body: unknown }[], assignmentId: string): { publish?: CommitPointer['publish'] } {
    const decisions = entries.filter(entry => entry.stream === 'publish' && (entry.body as { t?: string; assignmentId?: string })?.t === 'publish-decision' && (entry.body as { assignmentId?: string }).assignmentId === assignmentId);
    if (!decisions.length) return {};
    if (decisions.length !== 1) throw Error('conversation-read-publish-duplicate');
    return { publish: validatePublishDecisionRecord(decisions[0]!.body) };
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
}
const directoryBindings = new WeakMap<AuthorityCommitLog, {
  readonly reducer: ConversationDirectoryReducer;
  readonly index: ReturnType<AuthorityCommitLog['durableProjection']>;
}>();
export function registerConversationReadProjection(log: AuthorityCommitLog, artifacts: ArtifactStore, verifier: ProtocolSignatureVerifier) {
  const existing = directoryBindings.get(log);
  if (existing) {
    if (existing.reducer.verifier !== verifier) throw new TypeError('Conversation directory verifier is already bound by its owner');
    return existing.index;
  }
  registerConversationBaseContext(log, artifacts, verifier);
  const reducer = new ConversationDirectoryReducer(artifacts, verifier);
  const index = log.durableProjection<ConversationRunJournalRecord>({
    projectionId: 'conversation-read-directory', reducerVersion: 16,
    inputs: { families: ['run:', 'transfer:'], streams: ['final-outbox', 'control'] },
    reduce: async (envelope, current, position) => {
      const seeds = new Map<string, JsonValue | undefined>();
      await foldConversationBaseBindings(log, envelope.entries, current, seeds, position);
      for (const entry of envelope.entries) {
        const body = entry.body as { t?: string; conversationId?: string };
        if (!entry.stream.startsWith('transfer:xfer-') || body.t !== 'conversation-transfer-committed-base' || !body.conversationId) continue;
        const id = body.conversationId, p = prefix(id), binding = seeds.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding;
        try {
          const source = await openConversationBase(log, binding);
          const read = (key: string) => source.read(view => view.get('directory/' + key));
          const runs = new Set<string>();
          const scan = async (prefixKey: string, visit: (key: string, value: JsonValue) => void, after?: string) => {
            do {
              const page = await source.read(view => view.scan({ ...(after ? { gt: after } : { gte: 'directory/' + prefixKey }), lt: 'directory/' + prefixKey + '\uffff' }, 64));
              for (const row of page.entries) visit(row.key.slice('directory/'.length), row.value);
              after = page.continuation ? page.entries.at(-1)!.key : undefined;
            } while (after);
          };
          const activeAdvancement = await read(p + 'continuation-active-advancement');
          if (activeAdvancement !== undefined) seeds.set(p + 'continuation-active-advancement', activeAdvancement);
          const fence = Number(await read(p + 'stop-fence') ?? 0);
          await scan(p + 'obligation-order:', key => runs.add(JSON.parse(key.slice((p + 'obligation-order:').length + 17))), 'directory/' + p + 'obligation-order:' + ordinal(fence) + ':\uffff');
          await scan(p + 'continuation-drain:', (key, value) => { if (typeof value !== 'string') throw Error('Invalid continuation drain'); runs.add(value); seeds.set(key, value); });
          for (const runId of runs) {
            const suffix = JSON.stringify(runId);
            for (const field of ['obligation:', 'continuation-root:', 'continuation-origin:', 'continuation-pending:', 'continuation-consumed:', 'continuation-advancement:', 'continuation-cancel-advancement-run:', 'stop:']) {
              const value = await read(p + field + suffix); if (value !== undefined) seeds.set(p + field + suffix, value);
            }
            const advancement = seeds.get(p + 'continuation-advancement:' + suffix) as unknown as { conversationId: string; sessionId: string } | undefined;
            if (advancement) {
              const scope = JSON.stringify([advancement.conversationId, advancement.sessionId]);
              for (const key of ['continuation-cancel-count:' + scope, 'continuation-advancement-closed:' + scope]) {
                const value = await read(key); if (value !== undefined) seeds.set(key, value);
              }
              await scan('continuation-cancel-advancement:' + scope + ':', (key, value) => seeds.set(key, value));
            }
            const obligation = seeds.get(p + 'obligation:' + suffix);
            if (obligation && typeof obligation === 'object' && !Array.isArray(obligation)) {
              seeds.set(p + 'obligation:' + suffix, { ...obligation, lsn: position.checkpoint.lsn });
              seeds.set(p + 'obligation-order:' + ordinal(position.checkpoint.lsn) + ':' + suffix, true);
              seeds.set(p + 'obligation-at:' + suffix, position.checkpoint.lsn);
            }
            await scan(p + 'continuation-frontier:' + suffix + ':', (key, value) => seeds.set(key, value));
          }
          await scan('continuation-stop-request:', (key, value) => seeds.set(key, value));
        } catch (error) {
          if (position.candidate || !isConversationSourceEvidenceError(error)) throw error;
          seeds.set(conversationBaseUnavailableKey(id), true);
        }
      }
      const get = async (key: string): Promise<JsonValue | undefined> => {
        if (seeds.has(key)) return seeds.get(key);
        const value = await current.get(key); if (value !== undefined) return value;
        // Only finite continuation keys consult the immutable source. Native
        // transcript counters and live directories never merge a whole base.
        const match = key.match(/^("(?:[^"\\]|\\.)*"):(continuation-(?:root|origin|consumed|advancement)|stop):/);
        if (!match) return;
        const id = JSON.parse(match[1]!) as string;
        const binding = (seeds.get(conversationBaseKey(id)) ?? await current.get(conversationBaseKey(id))) as unknown as ConversationBaseBinding | undefined;
        if (!binding) return;
        if (await current.get(conversationBaseUnavailableKey(id))) throw conversationBaseRepairRequired(log, binding);
        return (await openConversationBase(log, binding)).read(view => view.get('directory/' + key));
      };
      const mutations = await reducer.reduce(envelope.entries, envelope.at, envelope.lsn, get, position.checkpoint, 0, (range, limit) => createDurableProjectionOverlay(current, seeds).scan(range, limit));
      return [...seeds].map(([key, value]): DurableProjectionMutation => value === undefined ? { kind: 'tombstone', key } : { kind: 'put', key, value }).concat(mutations);
    },
  });
  directoryBindings.set(log, { reducer, index });
  registerConversationBaseRepair(log, 'conversation-read-directory', () => index.rebuild());
  return index;
}
