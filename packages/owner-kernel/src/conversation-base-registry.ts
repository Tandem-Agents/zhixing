import type { ArtifactStore, AuthorityCommitLog, DurableProjectionReadContext, DurableProjectionSource, DurableLogCheckpoint } from '@zhixing/core/authority';
import { assertArtifactRef, createDurableProjectionOverlay, AuthorityPreparationRequired } from '@zhixing/core/authority';
import type { ArtifactRef, JsonValue, LogicalRecord, TransferRecord } from '@zhixing/core/contracts';
import { canonicalize, protocolDigest, reduceConversationTransfer, type ConversationTransferState, type ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { ConversationBaseSource, isConversationSourceEvidenceError } from './conversation-base-source.js';

export interface ConversationBaseBinding {
  readonly state: ConversationTransferState;
  readonly manifest: ArtifactRef; readonly records: ArtifactRef; readonly sessionState: ArtifactRef;
  readonly activation: DurableLogCheckpoint; readonly ownerOrigin: DurableLogCheckpoint;
}
interface Context { artifacts: ArtifactStore; verifier: ProtocolSignatureVerifier; sources: Map<string, Promise<ConversationBaseSource>> }
const contexts = new WeakMap<AuthorityCommitLog, Context>();
const preparedSources = new WeakMap<ArtifactStore, Map<string, ConversationBaseSource>>();
const repairs = new WeakMap<AuthorityCommitLog, Map<string, () => Promise<void>>>();

const hash = (value: unknown) => protocolDigest('ConversationBaseBinding', 1, value).slice(7);
export const conversationBaseKey = (id: string) => 'source/base/' + hash(id);
export const conversationBaseUnavailableKey = (id: string) => 'source/unavailable/' + hash(id);
export function registerConversationBaseRepair(log: AuthorityCommitLog, id: string, rebuild: () => Promise<void>): void {
  const callbacks = repairs.get(log) ?? new Map<string, () => Promise<void>>();
  callbacks.set(id, rebuild); repairs.set(log, callbacks);
}
export function conversationBaseRepairRequired(log: AuthorityCommitLog, binding: ConversationBaseBinding): AuthorityPreparationRequired {
  const error = new AuthorityPreparationRequired([]);
  error.prepareOutside = async () => {
    const context = contexts.get(log);
    if (!context) throw new TypeError('Conversation base has no registered verifier');
    const key = canonicalize([binding.manifest, binding.state.identity]);
    const source = await (context.sources.get(key) ?? ConversationBaseSource.open({ log, artifacts: context.artifacts,
      verifier: context.verifier, state: binding.state, ownerCheckpoint: binding.ownerOrigin }));
    await source.prepare();
    context.sources.set(key, Promise.resolve(source));
    // Only recovery of genuinely unavailable evidence rebuilds these derived
    // indexes. The signed source and committed owner epoch remain unchanged.
    for (const rebuild of repairs.get(log)?.values() ?? []) await rebuild();
  };
  return error;
}
const transferKey = (id: string) => 'source/transfer/' + hash(id);
const masked = (value: JsonValue | undefined): boolean => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === 1 && value.conversationBaseDeleted === true;
export const conversationBaseTombstone = Object.freeze({ conversationBaseDeleted: true });
const runPrefix = (id: string) => 'conversation/' + protocolDigest('ConversationStateKey', 1, id).slice(7) + '/';
const currentPrefixes = (id: string) => {
  const p = runPrefix(id);
  return [p + 'guard/queuedRunByPosition/', p + 'open-run/', p + 'pending-', p + 'ticket-pending/', p + 'ticket-expiry/', p + 'ticket-expiry-reverse/'];
};

export function registerConversationBaseContext(log: AuthorityCommitLog, artifacts: ArtifactStore, verifier: ProtocolSignatureVerifier): void {
  const prior = contexts.get(log);
  if (prior && prior.verifier !== verifier) throw new TypeError('Conversation base verifier changed');
  if (!prior) contexts.set(log, { artifacts, verifier, sources: new Map() });
}


export function registerConversationBaseSource(artifacts: ArtifactStore, source: ConversationBaseSource): void {
  const sources = preparedSources.get(artifacts) ?? new Map<string, ConversationBaseSource>();
  const key = canonicalize([source.manifestRef, source.state.identity]);
  sources.set(key, source);
  preparedSources.set(artifacts, sources);
  const context = contexts.get(source.log);
  if (context?.artifacts === artifacts) context.sources.set(key, Promise.resolve(source));
}

export async function openConversationBase(log: AuthorityCommitLog, binding: ConversationBaseBinding): Promise<ConversationBaseSource> {
  const context = contexts.get(log);
  if (!context) throw new TypeError('Conversation base has no registered verifier');
  const key = canonicalize([binding.manifest, binding.state.identity]);
  const registered = preparedSources.get(context.artifacts)?.get(key);
  let opening = context.sources.get(key);
  if (!opening) {
    opening = registered && registered.log === log
      ? Promise.resolve(registered)
      : ConversationBaseSource.open({ log, artifacts: context.artifacts, verifier: context.verifier, state: binding.state, ownerCheckpoint: binding.ownerOrigin });
    context.sources.set(key, opening);
    void opening.catch(() => { if (context.sources.get(key) === opening) context.sources.delete(key); });
  }
  const source = await opening;
  if (source.unavailable) throw source.unavailable;
  if (canonicalize(source.state.identity) !== canonicalize(binding.state.identity) || canonicalize(source.manifestRef) !== canonicalize(binding.manifest)) {
    throw new TypeError('Conversation cached source differs from the requested durable base generation');
  }
  if (!source.ready) throw source.preparationRequired();
  if (canonicalize(source.manifest.authorityBase.records) !== canonicalize(binding.records) ||
      canonicalize(source.manifest.authorityBase.sessionState) !== canonicalize(binding.sessionState)) throw new TypeError('Conversation base pointer differs from its signed manifest');
  return source;
}

/** Each consuming domain maintains the same tiny transfer binding at its own
 * WAL prefix. Immutable seed rows are joined on demand, never copied to WAL. */
export async function foldConversationBaseBindings(log: AuthorityCommitLog, entries: readonly LogicalRecord<unknown>[],
  current: DurableProjectionReadContext, changes: Map<string, JsonValue | undefined>, position: DurableProjectionSource,
  seedRunDirectories = false): Promise<void> {
  if (!entries.some(entry => entry.stream.startsWith('transfer:xfer-'))) return;
  const context = contexts.get(log);
  if (!context) throw new TypeError('Conversation transfer facts require the registered source verifier');
  const get = (key: string) => changes.has(key) ? Promise.resolve(changes.get(key)) : current.get(key);
  for (const entry of entries) {
    if (!entry.stream.startsWith('transfer:xfer-')) continue;
    const body = entry.body as Record<string, unknown>;
    if (!body || typeof body !== 'object' || typeof body.transferId !== 'string' || entry.stream !== 'transfer:' + body.transferId) throw new TypeError('Invalid conversation transfer source stream');
    const key = transferKey(body.transferId), prior = await get(key) as unknown as ConversationTransferState | undefined;
    if (body.t !== 'conversation-transfer-committed-base') {
      const next = reduceConversationTransfer(prior, body as unknown as TransferRecord, context.verifier);
      changes.set(key, next as unknown as JsonValue); continue;
    }
    if (!prior?.commit || prior.phase !== 'committed' || !prior.manifest || (body.v !== 1 && body.v !== 2) || body.conversationId !== prior.identity.conversationId ||
        Object.keys(body).sort().join(',') !== (body.v === 2 ? 'conversationId,manifest,ownerBasis,records,sessionState,t,transferId,v' : 'conversationId,manifest,records,sessionState,t,transferId,v') ||
        canonicalize(body.manifest) !== canonicalize(prior.manifest) || !position.originCheckpoint ||
        !entries.some(value => value.stream === entry.stream && (value.body as { t?: string })?.t === 'committed')) {
      throw new TypeError('Conversation base has no atomic authenticated owner commit');
    }
    assertArtifactRef(body.manifest); assertArtifactRef(body.records); assertArtifactRef(body.sessionState);
    const binding: ConversationBaseBinding = { state: prior, manifest: body.manifest, records: body.records, sessionState: body.sessionState,
      activation: position.checkpoint, ownerOrigin: position.originCheckpoint };
    const baseKey = conversationBaseKey(prior.identity.conversationId), previous = await get(baseKey) as unknown as ConversationBaseBinding | undefined;
    if (previous && canonicalize(previous.manifest) !== canonicalize(binding.manifest)) throw new TypeError('Conversation already has another adopted source');
    // Fresh commits can publish only a completely prepared view. On historical
    // recovery the binding itself stays visible even when one source is lost;
    // only queries depending on that source must prepare or fail explicitly.
    if (position.candidate) await openConversationBase(log, binding);
    changes.set(baseKey, binding as unknown as JsonValue);
    if (!seedRunDirectories) continue;
    // Only live working directories are seeded. Historical exact rows stay in
    // the immutable base; retiring live items then uses ordinary local deletes.
    try {
    const base = await openConversationBase(log, binding);
    for (const prefix of currentPrefixes(prior.identity.conversationId).slice(0, 3)) {
      let after: string | undefined;
      do {
        const page = await base.read(view => view.scan({ ...(after ? { gt: after } : { gte: prefix }), lt: prefix + '\uffff' }, 64));
        for (const row of page.entries) changes.set(row.key, row.value);
        after = page.continuation ? page.entries.at(-1)!.key : undefined;
      } while (after);
    }
    const rootKey = runPrefix(prior.identity.conversationId) + 'root';
    const root = await base.read(view => view.get(rootKey)) as Record<string, JsonValue> | undefined;
    if (root) changes.set(rootKey, { ...root, version: position.checkpoint.lsn });
    } catch (error) {
      if (position.candidate || !isConversationSourceEvidenceError(error)) throw error;
      changes.set(conversationBaseUnavailableKey(prior.identity.conversationId), true);
    }
  }
}

/** Explicit overlay tombstones suppress imported values; absence never revives
 * a cleared queue entry or a revoked source capability. */
export function conversationViewOverlay(current: DurableProjectionReadContext, importedView: DurableProjectionReadContext): DurableProjectionReadContext {
  return {
    get: async key => {
      const local = await current.get(key);
      return masked(local) ? undefined : local !== undefined ? local : importedView.get(key);
    },
    scan: async (range, limit) => {
      let after = range.gt;
      const entries: { key: string; value: JsonValue }[] = [];
      let more = false;
      for (;;) {
        const query = { ...range, ...(after ? { gt: after } : {}) };
        const local = await current.scan(query, Math.max(1, limit));
        const imported = await importedView.scan(query, Math.max(1, limit));
        const rows = new Map(imported.entries.map(entry => [entry.key, entry.value]));
        for (const entry of local.entries) rows.set(entry.key, entry.value);
        const localEnd = local.continuation ? local.entries.at(-1)?.key : undefined;
        const importedEnd = imported.continuation ? imported.entries.at(-1)?.key : undefined;
        const through = localEnd && importedEnd ? (localEnd < importedEnd ? localEnd : importedEnd) : localEnd ?? importedEnd;
        const keys = [...rows.keys()].filter(key => through === undefined || key <= through).sort();
        for (const key of keys) {
          after = key;
          const value = rows.get(key)!;
          if (!masked(value)) entries.push({ key, value });
          if (entries.length === limit) break;
        }
        more = !!local.continuation || !!imported.continuation || keys.some(key => after !== undefined && key > after);
        if (entries.length === limit || !more || !keys.length) break;
      }
      return { entries, ...(more && entries.length ? { continuation: entries.at(-1)!.key } : {}) };
    },
  };
}

export function conversationViewForSource(current: DurableProjectionReadContext, source: ConversationBaseSource): DurableProjectionReadContext {
  return conversationViewOverlay(current, {
    get: key => source.read(view => view.get(key)),
    scan: (range, limit) => source.read(view => view.scan(range, limit)),
  });
}

export async function conversationViewAt(log: AuthorityCommitLog, current: DurableProjectionReadContext, id: string,
  changes?: ReadonlyMap<string, JsonValue | undefined>): Promise<DurableProjectionReadContext> {
  const binding = await current.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding | undefined;
  if (!binding) return current;
  if (await current.get(conversationBaseUnavailableKey(id))) throw conversationBaseRepairRequired(log, binding);
  const local: DurableProjectionReadContext = changes ? {
    get: key => changes.has(key) ? Promise.resolve(changes.get(key) ?? conversationBaseTombstone) : current.get(key),
    scan: (range, limit) => createDurableProjectionOverlay(current,
      new Map([...changes].map(([key, value]) => [key, value ?? conversationBaseTombstone]))).scan(range, limit),
  } : current;
  const source = await openConversationBase(log, binding), live = currentPrefixes(id);
  return conversationViewOverlay(local, {
    get: key => live.some(prefix => key.startsWith(prefix)) ? Promise.resolve(undefined) : source.read(view => view.get(key)),
    scan: (range, limit) => live.some(prefix => (range.gt ?? range.gte ?? '').startsWith(prefix))
      ? Promise.resolve({ entries: [] }) : source.read(view => view.scan(range, limit)),
  });
}

export async function preserveBaseDeletions(log: AuthorityCommitLog, view: DurableProjectionReadContext, id: string,
  changes: Map<string, JsonValue | undefined>): Promise<void> {
  const binding = await view.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding | undefined;
  if (!binding) return;
  const source = await openConversationBase(log, binding);
  for (const [key, value] of changes) if (value === undefined && !currentPrefixes(id).some(prefix => key.startsWith(prefix)) && await source.read(base => base.get(key)) !== undefined) {
    changes.set(key, conversationBaseTombstone);
  }
}
