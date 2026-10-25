import { artifactJsonIndex, AuthorityPreparationRequired, AuthorityStorageError, assertArtifactRef, readDurableProjectionKeys,
  type ArtifactStore, type AuthorityCommitLog, type ArtifactProjectionCache, type DurableLogCheckpoint,
  type DurableProjectionReadContext } from '@zhixing/core/authority';
import type { ArtifactRef, ConversationTransferManifest, JsonValue, LogicalRecord } from '@zhixing/core/contracts';
import { canonicalize, protocolDigest, createProtocolDigestAccumulator, sourceFreezeProofDigest,
  validateConversationTransferCommit, validateConversationTransferManifest, validateSourceFreezeProof,
  assertConversationFreezeProofBinding, type ConversationTransferState, type ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { currentMaintenanceAbortSignal, isHoldingMaintenanceExclusion, maintenanceRetryDelayMs, waitForMaintenanceRetry,
  StorageMaintenanceCancelledError } from '@zhixing/core/resources';
import type { ConversationTransferAuthorityRecord } from './conversation-transfer.js';

export type ConversationBaseManifest = Omit<ConversationTransferManifest, 'contentAssets'>;
export interface ConversationBaseLocation {
  readonly manifest: ArtifactRef; readonly conversationId: string; readonly sourceDeviceId: string;
  readonly sourceOwnerEpoch: number; readonly transferId: string; readonly record: number;
  readonly sourceLsn: number;
}
interface RecordLocation { index: number; lo: number; bytes: number; sourceLsn: number; at: string; stream: string; digest: string }
export interface ConversationBaseHeader {
  manifest: ConversationBaseManifest; manifestRef: ArtifactRef; namespace: string;
  phase: 'assets' | 'records' | 'digests' | 'domain' | 'session' | 'ready';
  assetNext: number; assetCount: number; recordNext: number; recordCount: number;
  assetLast?: string;
  digestsDone: string[]; domainNext: number;
  previous?: { lsn: number; at: string; sourceItem?: number; sourceEnvelopeDigest?: string; group: number };
}
type SourceHeader = ConversationBaseHeader;
export function isConversationSourceEvidenceError(error: unknown): error is Error {
  return error instanceof TypeError || error instanceof SyntaxError || error instanceof AuthorityStorageError && error.code !== 'commit-log-corrupt';
}
const seal = Symbol('authenticated-conversation-source');
const groups = new WeakSet<object>();
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const ordinal = (n: number) => String(n).padStart(16, '0');
const rawKey = (n: number) => 'source/record/' + ordinal(n);
const groupKey = (n: number) => 'source/group/' + ordinal(n);
const streamPrefix = (stream: string) => 'source/stream/' + JSON.stringify(stream) + '/';
const sameRef = (a: ArtifactRef, b: ArtifactRef) => a.digest === b.digest && a.bytes === b.bytes;
/** 就绪基底点读行的进程内缓存上限（一次决定的主体数上限是 512）。 */
const MAX_CACHED_ROWS = 4096;

/** Source-domain facts authenticated by a frozen manifest. This deliberately
 * has no envelopeDigest, target LSN or local WAL cursor. */
export class AuthenticatedConversationFacts {
  readonly kind = 'authenticated-conversation-facts';
  constructor(token: symbol, readonly source: ConversationBaseSource, readonly firstRecord: number,
    readonly sourceLsn: number, readonly at: string, readonly entries: readonly LogicalRecord<unknown>[]) {
    if (token !== seal) throw new TypeError('Conversation source facts require verified provenance');
    immutable(entries);
    groups.add(this);
    Object.freeze(this);
  }
  location(item: number): ConversationBaseLocation {
    if (!Number.isSafeInteger(item) || item < 0 || item >= this.entries.length) throw new TypeError('Imported record position is invalid');
    return { manifest: this.source.manifestRef, conversationId: this.source.manifest.conversationId,
      sourceDeviceId: this.source.manifest.sourceDeviceId, sourceOwnerEpoch: this.source.manifest.sourceOwnerEpoch,
      transferId: this.source.manifest.transferId, record: this.firstRecord + item, sourceLsn: this.sourceLsn };
  }
  assertAssignment(assigned: { readonly runId: string; readonly ownerEpoch: number }): void {
    if (!groups.has(this) || assigned.ownerEpoch > this.source.manifest.sourceOwnerEpoch || assigned.ownerEpoch < 1 || !assigned.runId) {
      throw new TypeError('Imported assignment is outside its authenticated source generation');
    }
  }
}
export function isAuthenticatedConversationFacts(value: unknown): value is AuthenticatedConversationFacts {
  return typeof value === 'object' && value !== null && groups.has(value);
}

/** One immutable transfer base. Only its bounded authenticated header is kept
 * in memory; records and domain rows remain in their derived pages/original CAS. */
export class ConversationBaseSource {
  #header: SourceHeader | undefined;
  #preparing: Promise<void> | undefined;
  #unavailable: Error | undefined;
  /** 就绪基底的记录与分组行由已签清单派生、此后不变，读过即按键缓存（null 表示已证明不存在）。 */
  readonly #rows = new Map<string, JsonValue | null>();
  private constructor(readonly log: AuthorityCommitLog, readonly artifacts: ArtifactStore,
    readonly verifier: ProtocolSignatureVerifier, readonly state: ConversationTransferState,
    readonly manifestRef: ArtifactRef, readonly cache: ArtifactProjectionCache) {
      this.state = immutable(structuredClone(state));
      this.manifestRef = immutable({ ...manifestRef });
    }

  static async open(input: { log: AuthorityCommitLog; artifacts: ArtifactStore; verifier: ProtocolSignatureVerifier;
    state: ConversationTransferState; ownerCheckpoint: DurableLogCheckpoint }): Promise<ConversationBaseSource> {
    const { state, verifier } = input;
    if (!state.manifest || !state.proof || !['frozen', 'imported', 'committed', 'tombstoned'].includes(state.phase)) throw new TypeError('Conversation base has no authenticated frozen source');
    assertArtifactRef(state.manifest);
    const proof = validateSourceFreezeProof(state.proof, verifier), identity = state.identity;
    if (proof.scope !== 'conversation' || proof.transferId !== identity.transferId || proof.subject !== identity.conversationId ||
        proof.sourceEpoch !== identity.sourceOwnerEpoch || proof.checkpointDigest !== state.manifest.digest) throw new TypeError('Conversation base proof is outside its source identity');
    if (state.commit) {
      const commit = validateConversationTransferCommit(state.commit, verifier);
      if (commit.transferId !== identity.transferId || commit.conversationId !== identity.conversationId || commit.sourceDeviceId !== identity.sourceDeviceId ||
          commit.targetDeviceId !== identity.targetDeviceId || commit.sourceOwnerEpoch !== identity.sourceOwnerEpoch || commit.nextOwnerEpoch !== identity.nextOwnerEpoch ||
          commit.checkpointDigest !== state.manifest.digest || commit.freezeProofDigest !== sourceFreezeProofDigest(proof)) throw new TypeError('Conversation base commit does not bind its source proof');
    }
    if (!input.log.artifactProjection) throw new TypeError('Authority does not provide artifact-derived pages');
    const cache = input.log.artifactProjection({ projectionId: 'conversation-base-seed', reducerVersion: 9, artifact: state.manifest, ownerCheckpoint: input.ownerCheckpoint });
    const source = new ConversationBaseSource(input.log, input.artifacts, verifier, state, state.manifest, cache);
    source.#header = await cache.read(view => view.get('source/header')) as unknown as SourceHeader | undefined;
    if (source.#header) source.#checkHeader(source.#header);
    return source;
  }
  get manifest(): ConversationBaseManifest {
    if (!this.#header) throw this.preparationRequired();
    return immutable(this.#header.manifest);
  }
  get namespace(): string { if (!this.#header) throw this.preparationRequired(); return this.#header.namespace; }
  get ready(): boolean { return !this.#unavailable && this.#header?.phase === 'ready'; }
  get unavailable(): Error | undefined { return this.#unavailable; }
  get recordCount(): number { if (!this.ready) throw this.preparationRequired(); return this.#header!.recordCount; }
  async recordsPage(start: number, limit = 63): Promise<readonly ConversationTransferAuthorityRecord[]> {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new TypeError('Invalid imported source page');
    const rows = await this.read(view => view.scan({ gte: rawKey(start), lt: 'source/record/\uffff' }, limit));
    const records: ConversationTransferAuthorityRecord[] = [];
    for (const [offset, entry] of rows.entries.entries()) {
      const row = entry.value as unknown as RecordLocation;
      if (row.index !== start + offset) throw new TypeError('Imported source page has a gap');
      records.push(await this.#record(row));
    }
    if (records.length !== Math.min(limit, Math.max(0, this.recordCount - start))) throw new TypeError('Imported source page is incomplete');
    return records;
  }
  preparationRequired(): AuthorityPreparationRequired {
    const error = new AuthorityPreparationRequired([]);
    error.prepareOutside = async () => {
      try { await this.prepare(); }
      catch (cause) {
        if (!isConversationSourceEvidenceError(cause)) throw cause;
        // The retry can record this conversation's unavailable derived view.
        // This never marks the source ready or permits a fresh owner commit.
        this.#unavailable = cause;
      }
    };
    return error;
  }
  #checkHeader(header: SourceHeader): void {
    if (!sameRef(header.manifestRef, this.manifestRef)) throw new TypeError('Conversation seed is bound to another manifest');
    this.#checkManifest(header.manifest);
  }
  #checkManifest(manifest: ConversationBaseManifest): void {
    const identity = this.state.identity;
    for (const key of ['requestId', 'transferId', 'conversationId', 'sourceDeviceId', 'targetDeviceId', 'sourceOwnerEpoch', 'nextOwnerEpoch'] as const)
      if (manifest[key] !== identity[key]) throw new TypeError('Conversation manifest identity changed');
    assertConversationFreezeProofBinding(this.state.proof!, { ...manifest, contentAssets: [] }, this.manifestRef);
  }
  async read<T>(operation: (view: DurableProjectionReadContext) => Promise<T>): Promise<T> {
    if (this.#unavailable) throw this.#unavailable;
    return this.cache.read(async view => {
      const header = await view.get('source/header') as unknown as SourceHeader | undefined;
      if (!header || header.phase !== 'ready') throw this.preparationRequired();
      this.#checkHeader(header); this.#header = header;
      return operation(view);
    });
  }
  #assertLocation(location: ConversationBaseLocation): void {
    if (!sameRef(location.manifest, this.manifestRef) || location.conversationId !== this.manifest.conversationId ||
        location.sourceDeviceId !== this.manifest.sourceDeviceId || location.sourceOwnerEpoch !== this.manifest.sourceOwnerEpoch || location.transferId !== this.manifest.transferId) {
      throw new TypeError('Imported record locator belongs to another source');
    }
  }
  /** 预先装入一组导入记录的定位行：决定前物化要读的记录一次补齐，不在排他段内逐条等锁。 */
  async prefetch(locations: readonly ConversationBaseLocation[]): Promise<void> {
    for (const location of locations) this.#assertLocation(location);
    await this.#readyRows(locations.map(location => rawKey(location.record)));
  }
  async record(location: ConversationBaseLocation): Promise<ConversationTransferAuthorityRecord> {
    this.#assertLocation(location);
    const [row] = await this.#readyRows([rawKey(location.record)]) as unknown as (RecordLocation | undefined)[];
    if (!row || row.sourceLsn !== location.sourceLsn) throw new TypeError('Imported record locator is missing or changed');
    return this.#record(row);
  }
  async recordAt(index: number): Promise<ConversationTransferAuthorityRecord> {
    const [row] = await this.#readyRows([rawKey(index)]) as unknown as (RecordLocation | undefined)[];
    if (!row || row.index !== index) throw new TypeError('Imported source record is missing');
    return this.#record(row);
  }
  #readyRows(keys: readonly string[]): Promise<readonly (JsonValue | undefined)[]> {
    return this.#cachedRows(keys, chunk => this.read(view => readDurableProjectionKeys(view, chunk)));
  }
  /**
   * 按键读记录阶段之后不再变化的记录/分组行，读过即缓存。排他段内取不到日志锁时不等待也不失败：
   * 报待装入并附上段外补齐，调用方离开排他段、照常等锁补齐后重做，重做时直接命中缓存，不再需要锁。
   */
  async #cachedRows(keys: readonly string[],
    read: (keys: readonly string[]) => Promise<readonly (JsonValue | undefined)[]>): Promise<readonly (JsonValue | undefined)[]> {
    const missing = [...new Set(keys)].filter(key => !this.#rows.has(key));
    const found = new Map<string, JsonValue | undefined>();
    const fill = async () => {
      for (let offset = 0; offset < missing.length; offset += 256) {
        const chunk = missing.slice(offset, offset + 256), values = await read(chunk);
        chunk.forEach((key, index) => { found.set(key, values[index]); this.#remember(key, values[index]); });
      }
    };
    if (missing.length) {
      try { await fill(); } catch (error) {
        // 已是待装入（例如基底尚未就绪）的原样交出；只把排他段内取不到锁的背压改成段外补齐
        if (error instanceof AuthorityPreparationRequired || !isHoldingMaintenanceExclusion() || maintenanceRetryDelayMs(error) === undefined) throw error;
        const required = new AuthorityPreparationRequired([]);
        required.prepareOutside = fill;
        throw required;
      }
    }
    return keys.map(key => found.has(key) ? found.get(key) : this.#rows.get(key) ?? undefined);
  }
  #remember(key: string, value: JsonValue | undefined): void {
    if (!this.#rows.has(key) && this.#rows.size >= MAX_CACHED_ROWS) this.#rows.delete(this.#rows.keys().next().value!);
    this.#rows.set(key, value ?? null);
  }
  async recordForValidation(location: ConversationBaseLocation, group: AuthenticatedConversationFacts, view: DurableProjectionReadContext): Promise<ConversationTransferAuthorityRecord> {
    if (!groups.has(group) || group.source !== this || location.record >= group.firstRecord + group.entries.length || !sameRef(location.manifest, this.manifestRef) ||
        location.conversationId !== this.manifest.conversationId || location.transferId !== this.manifest.transferId ||
        location.sourceDeviceId !== this.manifest.sourceDeviceId || location.sourceOwnerEpoch !== this.manifest.sourceOwnerEpoch) throw new TypeError('Imported validation locator is outside its source prefix');
    const row = await view.get(rawKey(location.record)) as unknown as RecordLocation | undefined;
    if (!row || row.sourceLsn !== location.sourceLsn) throw new TypeError('Imported validation source is missing');
    return this.#record(row);
  }
  async #record(row: RecordLocation): Promise<ConversationTransferAuthorityRecord> {
    const bytes = await this.artifacts.readRange(this.manifest.authorityBase.records, row.lo, row.bytes);
    if (bytes.byteLength !== row.bytes) throw new TypeError('Imported record source is truncated');
    const record = validateConversationBaseRecord(JSON.parse(Buffer.from(bytes).toString('utf8')));
    if (record.lsn !== row.sourceLsn || record.at !== row.at || record.stream !== row.stream || protocolDigest('ConversationTransferAuthorityRecord', 1, record) !== row.digest) throw new TypeError('Imported record source binding changed');
    return record;
  }
  async group(first: number, view?: DurableProjectionReadContext): Promise<AuthenticatedConversationFacts | undefined> {
    if (!this.#header || !['domain', 'session', 'ready'].includes(this.#header.phase)) throw this.preparationRequired();
    // 记录阶段已结束：分组与记录行不再变化，锁外读取走缓存；锁内校验直接读所给视图
    const rows = (keys: readonly string[]) => view ? readDurableProjectionKeys(view, keys)
      : this.#cachedRows(keys, chunk => this.cache.read(context => readDurableProjectionKeys(context, chunk)));
    const [group] = await rows([groupKey(first)]) as unknown as ({ first: number; end: number; lsn: number; at: string } | undefined)[];
    if (!group) return;
    const entries: LogicalRecord<unknown>[] = [];
    for (let start = group.first; start < group.end; start += 256) {
      const keys = Array.from({ length: Math.min(256, group.end - start) }, (_, offset) => rawKey(start + offset));
      for (const row of await rows(keys) as unknown as (RecordLocation | undefined)[]) {
        if (!row) throw new TypeError('Imported group is missing a source record');
        const record = await this.#record(row); entries.push({ stream: record.stream, body: record.body });
      }
    }
    return new AuthenticatedConversationFacts(seal, this, first, group.lsn, group.at, entries);
  }
  async prepare(): Promise<void> {
    this.#unavailable = undefined;
    const callerAbort = currentMaintenanceAbortSignal();
    return this.#preparing ??= this.cache.prepare(async stop => {
      const abort = AbortSignal.any([stop, callerAbort]);
      const check = () => { if (abort.aborted) throw new StorageMaintenanceCancelledError(); };
      let retryDeadline: number | undefined;
      try {
        for (;;) {
          check();
          try {
          this.#header = await this.cache.read(view => view.get('source/header')) as unknown as SourceHeader | undefined;
          if (this.#header?.phase === 'ready') { this.#checkHeader(this.#header); return; }
          if (!this.#header) await this.#initialize(check);
          else if (this.#header.phase === 'assets') await this.#assets(check);
          else if (this.#header.phase === 'records') await this.#records(check);
          else if (this.#header.phase === 'digests') await this.#digests(check);
          else {
            // The domain owns semantic validation and the derived seed layout.
            const { prepareConversationBaseDomain } = await import('./conversation-base-domain.js');
            await prepareConversationBaseDomain(this, check);
          }
          retryDeadline = undefined;
          } catch (error) {
            const delay = maintenanceRetryDelayMs(error);
            if (delay === undefined) throw error;
            // The page transaction has released its Authority lock. Retry from
            // the durable phase cursor; never wait for maintenance inside it.
            retryDeadline ??= performance.now() + 30_000;
            check();
            if (performance.now() >= retryDeadline) throw error;
            await waitForMaintenanceRetry(Math.min(delay, 250));
          }
          await new Promise<void>(setImmediate);
        }
      } finally { this.#preparing = undefined; }
    });
  }
  async #json(ref: ArtifactRef, check: () => void) {
    const json = artifactJsonIndex(this.artifacts);
    while (!(await json.prepare(ref)).ready) { check(); await new Promise<void>(setImmediate); }
    check(); return json;
  }
  async #initialize(check: () => void): Promise<void> {
    const json = await this.#json(this.manifestRef, check), root = await json.node(this.manifestRef, []);
    if (root?.kind !== 'object') throw new TypeError('Conversation manifest is not an object');
    const fields = await json.children(this.manifestRef, root, -1, 16);
    const streams = await json.node(this.manifestRef, ['streams']);
    if (streams?.kind !== 'array' || streams.units > 6) throw new TypeError('Conversation manifest stream scope is invalid');
    const object: Record<string, unknown> = {};
    for (const field of fields) if (field.field !== 'contentAssets') object[field.field] = await json.value(this.manifestRef, [field.field], 128 * 1024);
    const assets = await json.node(this.manifestRef, ['contentAssets']);
    if (assets?.kind !== 'array' || root.units !== fields.length) throw new TypeError('Conversation manifest fields are invalid');
    const validated = validateConversationTransferManifest({ ...object, contentAssets: [] });
    const { contentAssets: _, ...manifest } = validated; this.#checkManifest(manifest);
    const allowed = new Set(['run:' + manifest.conversationId, 'intent:' + manifest.conversationId, 'session-activity:' + manifest.conversationId, 'control', 'publish', 'final-outbox']);
    if (manifest.streams.some(range => !allowed.has(range.stream))) throw new TypeError('Conversation manifest includes another domain');
    const namespace = canonicalize([manifest.sourceDeviceId, manifest.sourceOwnerEpoch, manifest.transferId, this.manifestRef]);
    const header: SourceHeader = { manifest, manifestRef: this.manifestRef, namespace, phase: 'assets', assetNext: 0, assetCount: assets.units,
      recordNext: 0, recordCount: 0, digestsDone: [], domainNext: 0 };
    await this.cache.update(async view => ({ mutations: await view.get('source/header') ? [] : [{ kind: 'put', key: 'source/header', value: header as unknown as JsonValue }], value: undefined }));
    this.#header = header;
  }
  async #assets(check: () => void): Promise<void> {
    const header = this.#header!, json = await this.#json(this.manifestRef, check);
    const refs: ArtifactRef[] = [];
    for (let i = header.assetNext; i < Math.min(header.assetNext + 64, header.assetCount); i++) {
      const ref = await json.value(this.manifestRef, ['contentAssets', i]); assertArtifactRef(ref);
      if (!await this.artifacts.has(ref)) throw new TypeError('Conversation transfer references a missing asset');
      refs.push(ref); check();
    }
    await this.cache.update(async view => {
      const current = await view.get('source/header') as unknown as SourceHeader;
      if (current.phase !== 'assets' || current.assetNext !== header.assetNext) return { mutations: [], value: undefined };
      let assetLast = current.assetLast ?? '';
      for (const ref of refs) {
        const key = canonicalize(ref);
        if (Object.keys(ref).sort().join(',') !== 'bytes,digest' || key <= assetLast) throw new TypeError('Conversation content references must be exact, unique and sorted');
        assetLast = key;
      }
      return { mutations: [...refs.map(ref => ({ kind: 'put' as const, key: 'source/asset/' + ref.digest, value: ref as unknown as JsonValue })),
        { kind: 'put', key: 'source/header', value: { ...current, assetNext: current.assetNext + refs.length, assetLast,
          phase: current.assetNext + refs.length === current.assetCount ? 'records' : 'assets' } as unknown as JsonValue }], value: undefined };
    });
  }
  async #records(check: () => void): Promise<void> {
    const header = this.#header!, ref = header.manifest.authorityBase.records, json = await this.#json(ref, check);
    const root = await json.node(ref, []); if (root?.kind !== 'array') throw new TypeError('Conversation records are not an array');
    const rows: { location: RecordLocation; record: ConversationTransferAuthorityRecord }[] = [];
    let bytes = 0;
    for (let i = header.recordNext; i < root.units && rows.length < 32; i++) {
      const node = await json.node(ref, [i]); if (!node) throw new TypeError('Conversation record position is missing');
      if (rows.length && bytes + node.hi - node.lo > 1024 * 1024) break;
      const record = validateConversationBaseRecord(await json.value(ref, [i], node.hi - node.lo));
      rows.push({ location: { index: i, lo: node.lo, bytes: node.hi - node.lo, sourceLsn: record.lsn, at: record.at, stream: record.stream,
        digest: protocolDigest('ConversationTransferAuthorityRecord', 1, record) }, record });
      bytes += node.hi - node.lo; check();
    }
    await this.cache.update(async view => {
      const current = await view.get('source/header') as unknown as SourceHeader;
      if (current.phase !== 'records' || current.recordNext !== header.recordNext) return { mutations: [], value: undefined };
      const mutations: import('@zhixing/core/authority').DurableProjectionMutation[] = [];
      let previous = current.previous;
      for (const { location, record } of rows) {
        if (record.lsn > current.manifest.lastLsn || previous && (record.lsn < previous.lsn || record.lsn === previous.lsn && record.at !== previous.at)) throw new TypeError('Conversation source order is invalid');
        const range = current.manifest.streams.find(value => value.stream === record.stream);
        if (!range) throw new TypeError('Conversation source has an unlisted stream');
        if (record.lsn < range.firstLsn || record.lsn > range.lastLsn) throw new TypeError('Conversation source is outside its declared range');
        const group = previous?.lsn === record.lsn ? previous.group : location.index;
        if (previous?.lsn === record.lsn && (record.sourceEnvelopeDigest !== previous.sourceEnvelopeDigest ||
            record.sourceItem !== undefined && previous.sourceItem !== undefined && record.sourceItem <= previous.sourceItem)) throw new TypeError('Conversation source provenance order changed');
        previous = { lsn: record.lsn, at: record.at, group,
          ...(record.sourceItem !== undefined ? { sourceItem: record.sourceItem, sourceEnvelopeDigest: record.sourceEnvelopeDigest } : {}) };
        mutations.push({ kind: 'put', key: rawKey(location.index), value: location as unknown as JsonValue },
          { kind: 'put', key: streamPrefix(record.stream) + ordinal(location.index), value: location as unknown as JsonValue },
          { kind: 'put', key: groupKey(group), value: { first: group, end: location.index + 1, lsn: record.lsn, at: record.at } });
      }
      mutations.push({ kind: 'put', key: 'source/header', value: { ...current, recordCount: root.units, recordNext: current.recordNext + rows.length,
        previous, phase: current.recordNext + rows.length === root.units ? 'digests' : 'records' } as unknown as JsonValue });
      return { mutations, value: undefined };
    });
  }
  async #digests(check: () => void): Promise<void> {
    const header = this.#header!, range = header.manifest.streams.find(value => !header.digestsDone.includes(value.stream));
    if (!range) {
      await this.cache.update(async view => { const current = await view.get('source/header') as unknown as SourceHeader;
        return { mutations: [{ kind: 'put', key: 'source/header', value: { ...current, phase: 'domain' } as unknown as JsonValue }], value: undefined }; });
      return;
    }
    const digest = createProtocolDigestAccumulator('ConversationTransferLogicalStream', 1);
    digest.update(Buffer.from('{"records":['));
    const prefix = streamPrefix(range.stream); let after: string | undefined, count = 0, firstLsn = 0, lastLsn = 0;
    for (;;) {
      const page = await this.cache.read(view => view.scan({ ...(after ? { gt: after } : { gte: prefix }), lt: prefix + '\uffff' }, 64));
      for (const row of page.entries) {
        const location = row.value as unknown as RecordLocation, record = await this.#record(location);
        if (count++) digest.update(Buffer.from(','));
        digest.update(Buffer.from(canonicalize(record))); firstLsn ||= record.lsn; lastLsn = record.lsn; check();
      }
      if (!page.continuation) break; after = page.entries.at(-1)!.key;
    }
    digest.update(Buffer.from('],"stream":' + canonicalize(range.stream) + '}'));
    if (digest.digest() !== range.digest || count !== range.recordCount || firstLsn !== range.firstLsn || lastLsn !== range.lastLsn) throw new TypeError('Conversation source stream digest or range differs from its signed manifest');
    await this.cache.update(async view => { const current = await view.get('source/header') as unknown as SourceHeader;
      return { mutations: [{ kind: 'put', key: 'source/header', value: { ...current, digestsDone: [...new Set([...current.digestsDone, range.stream])] } as unknown as JsonValue }], value: undefined }; });
  }
}

export function validateConversationBaseRecord(value: unknown): ConversationTransferAuthorityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid conversation source record');
  const record = value as Record<string, unknown>, keys = Object.keys(record);
  if (keys.some(key => !['lsn', 'at', 'stream', 'body', 'sourceEnvelopeDigest', 'sourceItem'].includes(key)) ||
      !Number.isSafeInteger(record.lsn) || (record.lsn as number) < 1 || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at)) ||
      typeof record.stream !== 'string' || !record.stream || !('body' in record) ||
      (record.sourceItem === undefined) !== (record.sourceEnvelopeDigest === undefined) ||
      record.sourceItem !== undefined && (!Number.isSafeInteger(record.sourceItem) || (record.sourceItem as number) < 0 || typeof record.sourceEnvelopeDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.sourceEnvelopeDigest))) {
    throw new TypeError('Invalid conversation source position');
  }
  return record as unknown as ConversationTransferAuthorityRecord;
}
