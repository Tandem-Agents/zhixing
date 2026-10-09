import type { DeviceCapacityArbiterPort, DeviceCapacityBudget } from '@zhixing/core/resources';
import { TERMINAL_LIMITS, type TerminalDisplayPage, type TerminalDisplaySegment } from '@zhixing/terminal-ui/protocol';
import { BODY_FRAGMENT_ENCODED_BYTES, BODY_PARSE_BYTES, sliceBodyNodes, validateBodyMetadata } from '@zhixing/terminal-ui/body-model';
import { mergeBodyAppends, type BodyAmend } from './body-projection.js';
import type { TerminalAssetAccount } from './asset-client.js';
import { TerminalManagedFiles } from './managed-files.js';
import { terminalPhysicalStep } from './physical-step.js';
import { createHash } from 'node:crypto';
import type { DisplayReplayRecord, DisplayReplaySource } from './display-replay.js';

const PAGE_BYTES = 224 * 1024;
const INDEX_BYTES = 16;
const SLOT_BYTES = BODY_FRAGMENT_ENCODED_BYTES;
// Keep initial input admission small; amortize later root-ledger transactions.
// Reserve a finite extent once, then grow it through separate short IO steps.
// Root inventory/commitment must not be repeated for every physical write.
const DATA_EXTENT_BYTES = TERMINAL_LIMITS.storageReservationBytes - 4096;
const PHYSICAL_EXTENT_BYTES = 1024 * 1024;
interface ActiveFragment { readonly ordinal: number; readonly offset: number; readonly length: number; revision: number; semantic: string }
interface ConfirmedFragment { readonly entry: Buffer; readonly segment: TerminalDisplaySegment; readonly encodedBytes: number }
const bodySemantic = (body: NonNullable<TerminalDisplaySegment['body']>) => createHash('sha256')
  .update(JSON.stringify([body.version, body.kind, body.end, body.context])).digest('hex');
const bound: DeviceCapacityBudget = {
  occupancy: { memoryReservationBytes: 3 * 1024 * 1024, temporaryBytes: 1024 * 1024, slots: 1 },
  quantum: { readBytes: 512 * 1024, writeBytes: 2 * 1024 * 1024, ioOperations: 256 },
};
const allocated = (bytes: number) => Math.ceil(bytes / 4096) * 4096;
const indexPosition = (ordinal: number) => (ordinal < 0 ? -ordinal * 2 - 1 : ordinal * 2) * INDEX_BYTES;
const quotedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2;
function carrierBytes(segment: TerminalDisplaySegment, encodedBytes = Buffer.byteLength(JSON.stringify(segment))): number {
  const rendered = segment.body?.context.nodes.reduce((sum, node) => sum + node.runs.reduce((n, run) => n + quotedBytes(run.text), 0), 0);
  return encodedBytes + (rendered === undefined ? 0 : Math.max(0, quotedBytes(segment.text) - rendered));
}
/** Leave room for pending source to become rendered text at logical EOF.
 * Split only before first publication; amendments never change old ranges. */
function* carriers(segment: TerminalDisplaySegment): Generator<{ segment: TerminalDisplaySegment; encoded: Buffer }> {
  const encoded = Buffer.from(JSON.stringify(segment));
  if (carrierBytes(segment, encoded.length) <= SLOT_BYTES) { yield { segment, encoded }; return; }
  let middle = Math.floor(segment.text.length / 2);
  if (middle && /[\ud800-\udbff]/u.test(segment.text[middle - 1]!) && /[\udc00-\udfff]/u.test(segment.text[middle]!)) middle--;
  if (!middle || middle >= segment.text.length) throw Error('terminal-display-encoding-size');
  for (const [from, to] of [[0, middle], [middle, segment.text.length]]) {
    const offset = segment.contentOffset + from!, end = to === segment.text.length;
    yield* carriers({ ...segment, contentOffset: offset, text: Buffer.from(segment.text.slice(from, to), 'utf16le').toString('utf16le'), final: segment.final && end,
      body: segment.body ? { ...segment.body, end: segment.body.end && end,
        context: { nodes: sliceBodyNodes(segment.body.context.nodes, offset, segment.contentOffset + to!) } } : undefined });
  }
}

/** A disposable projection, with a fixed-size disk index rather than a retained
 * in-memory history array. Only complete writes become visible. Negative
 * ordinals prepend older history without copying a growing index or body. */
export class TerminalDisplayStore {
  #first = 0; #last = 0; #bytes = 0; #indexBytes = 0;
  #dataAllocation = 0; #indexAllocation = 0;
  #tail = Promise.resolve(); #pending = 0; #failed = false;
  #unsettled = false;
  #generation = 0;
  readonly #active = new Map<string, ActiveFragment[]>();
  #activeCount = 0;
  // The append tail and the current reading page have separate fixed slots.
  // Live output must not evict the page the user is reading, forcing it through
  // disk, IPC and layout again on every notification. Both are confirmed copies.
  readonly #hot = new Map<number, ConfirmedFragment>();
  readonly #reading = new Map<number, ConfirmedFragment>();
  // There is at most one unpublished index write: the first failure seals all
  // later mutation. Keep its full confirmed entry before touching that index.
  #unpublished?: { readonly ordinal: number; readonly entry: Buffer };
  #admission?: string;
  #dataIdentity?: string; #indexIdentity?: string;
  readonly #files: TerminalManagedFiles;
  readonly #ownsFiles: boolean;
  constructor(readonly directory: string, readonly capacity: DeviceCapacityArbiterPort,
    readonly account: TerminalAssetAccount, readonly signal: AbortSignal, files?: TerminalManagedFiles,
    readonly replay?: (record: DisplayReplayRecord) => Promise<TerminalDisplaySegment>) {
    this.#files = files ?? new TerminalManagedFiles(directory); this.#ownsFiles = !files;
  }

  get first(): number { return this.#first; }
  get last(): number { return this.#last; }
  get paused(): boolean { return this.#failed; }

  async admit(): Promise<void> {
    await this.#tail; this.signal.throwIfAborted();
    await this.#files.runOperation(async () => {
      if (this.#failed || this.#admission) throw Error('terminal-display-admission-unavailable');
      this.#admission = await this.account.reserve('display', 256 * 1024);
    });
  }
  async cancelAdmission(): Promise<void> {
    await this.#files.runOperation(async () => {
      const token = this.#admission;
      if (token) { await this.account.settle(token, 0); this.#admission = undefined; }
    });
  }

  append(segment: TerminalDisplaySegment, prepend = false, current?: () => boolean, stable = false, replay?: DisplayReplaySource): Promise<void> {
    // Context cancellation is for independent plain notices. Streaming bodies
    // retain their existing amendment/reset owner and cannot use this gate.
    if (current && segment.body) return Promise.reject(Error('terminal-display-context-body'));
    if (replay && (!prepend || !this.replay)) return Promise.reject(Error('terminal-display-replay-admission'));
    const isCurrent = current ?? (() => true);
    if (!segment.blockId || segment.blockId.length > 512 || segment.role.length > 32 ||
      !Number.isSafeInteger(segment.contentOffset) || segment.contentOffset < 0 || Buffer.byteLength(segment.text) > 32 * 1024 ||
      (segment.body && !validateBodyMetadata(segment.body, segment.contentOffset, segment.text.length))) return Promise.reject(Error('terminal-display-segment-size'));
    return this.#enqueue(async () => {
      if (!isCurrent()) return;
      // Prepend takes the pieces in reverse while preserving source offsets.
      const parts: { segment: TerminalDisplaySegment; encoded: Buffer }[] = [];
      for (const part of carriers(segment)) {
        if (parts.length >= 16) throw Error('terminal-display-carrier-capacity');
        parts.push(part);
      }
      if (prepend) parts.reverse();
      for (const { segment: part, encoded } of parts) {
        if (!isCurrent()) return;
        await this.#appendFragment(part, this.#encode(part, encoded), prepend, isCurrent, stable, replay);
      }
    });
  }
  async #appendFragment(segment: TerminalDisplaySegment, encoded: Buffer, prepend: boolean, current: () => boolean, stable: boolean, replay?: DisplayReplaySource): Promise<void> {
      const ordinal = prepend ? this.#first - 1 : this.#last;
      const active = !prepend && segment.body && !stable ? this.#active.get(segment.blockId) : undefined;
      const tail = active?.at(-1);
      // Only the actual last visible record can grow. Interleaved blocks keep
      // their existing order; metadata amendments never change source ranges.
      if (tail?.ordinal === this.#last - 1) {
        const old = await this.#read(tail.ordinal);
        if (old.segment.body && old.segment.blockId === segment.blockId && old.segment.role === segment.role) {
          const merged = mergeBodyAppends({ kind: 'append', ...old.segment, body: old.segment.body },
            { kind: 'append', ...segment, body: segment.body! });
          if (merged) {
            const next = { ...segment, contentOffset: merged.contentOffset, text: merged.text, body: merged.body };
            const candidate = Buffer.from(JSON.stringify(next));
            if (candidate.length <= SLOT_BYTES && carrierBytes(next, candidate.length) <= SLOT_BYTES) {
              await this.#write(tail.ordinal, this.#encode(next, candidate), old.entry, false, next);
              this.#remember(segment.blockId, { ordinal: tail.ordinal, offset: next.contentOffset, length: next.text.length,
                revision: next.body.revision, semantic: bodySemantic(next.body) });
              return;
            }
          }
        }
      }
      if (!prepend && segment.body && !stable) this.#checkActive(segment.blockId);
      if (replay) {
        const record: DisplayReplayRecord = { replay, blockId: segment.blockId, groupId: segment.groupId, role: segment.role,
          contentOffset: segment.contentOffset, length: segment.text.length, final: segment.final,
          digest: createHash('sha256').update(segment.text).digest('hex') };
        // The confirmed hot page retains its full projection. Disk stores only
        // an immutable locator; dropping that hot copy never loses source data.
        encoded = Buffer.from(JSON.stringify(record));
        if (encoded.length > 4096) throw Error('terminal-display-replay-size');
      }
      await this.#write(ordinal, encoded, undefined, !prepend && !!segment.body && !stable, segment);
      // The write remains accounted, but a notice from a superseded context
      // must never advance the visible range. A later append reuses this index.
      if (!current()) return;
      if (prepend) this.#first = ordinal; else this.#last = ordinal + 1;
      if (!prepend && segment.body && !stable) this.#remember(segment.blockId, { ordinal, offset: segment.contentOffset, length: segment.text.length,
        revision: segment.body.revision, semantic: bodySemantic(segment.body) });
  }

  amend(blockId: string, change: BodyAmend): Promise<void> {
    return this.#enqueue(async () => {
      const entries = this.#active.get(blockId);
      if (!entries) throw Error('terminal-display-amend-block-missing');
      for (const fragment of entries) {
        if (fragment.offset >= change.to || fragment.offset + fragment.length <= change.from) continue;
        if (fragment.revision >= change.revision) throw Error('terminal-display-amend-stale');
        // Most incoming text does not restyle earlier source. Compare its
        // complete projected semantics using a fixed-size fingerprint; do not
        // reread and rewrite the whole unstable paragraph on every token.
        if (fragment.offset >= change.from) {
          const projected = change.project(fragment.offset, fragment.length);
          if (projected.revision !== change.revision) throw Error('terminal-display-amend-revision');
          if (bodySemantic(projected) === fragment.semantic) { fragment.revision = change.revision; continue; }
        }
        const old = await this.#read(fragment.ordinal), previous = old.segment;
        if (previous.blockId !== blockId || previous.contentOffset !== fragment.offset || previous.text.length !== fragment.length ||
            !previous.body || previous.body.revision >= change.revision) throw Error('terminal-display-amend-stale');
        const body = change.project(previous.contentOffset, previous.text.length, previous.body);
        if (body.revision !== change.revision) throw Error('terminal-display-amend-revision');
        const next = { ...previous, body, final: body.end };
        await this.#write(fragment.ordinal, this.#encode(next), old.entry, false, next);
        fragment.revision = body.revision; fragment.semantic = bodySemantic(body);
      }
    });
  }

  seal(blockId: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#activeCount -= this.#active.get(blockId)?.length ?? 0; this.#active.delete(blockId);
    });
  }

  #checkActive(blockId: string): void {
    if ((!this.#active.has(blockId) && this.#active.size >= 128) || this.#activeCount >= 4096) throw Error('terminal-display-active-capacity');
  }
  #remember(blockId: string, fragment: ActiveFragment): void {
    const previous = this.#active.get(blockId) ?? [];
    // The parser cannot amend before its bounded retained suffix. Descriptors
    // outside that suffix are cold disk records, not retained history arrays.
    const entries = previous.filter(item => item.ordinal !== fragment.ordinal && item.offset + item.length > fragment.offset + fragment.length - BODY_PARSE_BYTES);
    entries.push(fragment); this.#activeCount += entries.length - previous.length;
    this.#active.set(blockId, entries);
  }
  #encode(segment: TerminalDisplaySegment, encoded: Buffer = Buffer.from(JSON.stringify(segment))): Buffer {
    if (!segment.blockId || segment.blockId.length > 512 || segment.role.length > 32 ||
      !Number.isSafeInteger(segment.contentOffset) || segment.contentOffset < 0 || Buffer.byteLength(segment.text) > 32 * 1024 ||
      (segment.body && !validateBodyMetadata(segment.body, segment.contentOffset, segment.text.length))) throw Error('terminal-display-segment-size');
    if (encoded.length > SLOT_BYTES) throw Error('terminal-display-encoding-size');
    return encoded;
  }
  #enqueue(action: () => Promise<void>): Promise<void> {
    if (this.#failed || this.#pending >= 8) return Promise.reject(Error('terminal-display-paused'));
    const generation = this.#generation; this.#pending++;
    const operation = this.#tail.then(() => this.#files.runOperation(async () => {
      this.signal.throwIfAborted();
      if (generation !== this.#generation) return;
      if (this.#failed) throw Error('terminal-display-paused');
      await action();
    })).catch(error => { this.#failed = true; throw error; }).finally(() => { this.#pending--; });
    this.#tail = operation.catch(() => {}); return operation;
  }
  async #write(ordinal: number, encoded: Buffer, previous: Buffer | undefined, mutable: boolean, segment: TerminalDisplaySegment): Promise<void> {
    const confirmed = Object.freeze({ ...segment });
    const indexOffset = indexPosition(ordinal), indexBytes = Math.max(this.#indexBytes, indexOffset + INDEX_BYTES);
    const spare = previous ? previous.readUInt32LE(12) - 1 : -1;
    if (previous && spare < 0) throw Error('terminal-display-immutable-fragment');
    const at = previous ? spare : this.#bytes;
    const growth = previous ? 0 : mutable ? 2 * SLOT_BYTES : encoded.length;
    const bytes = this.#bytes + growth;
    if (bytes >= 0xffffffff) throw Error('terminal-display-offset-capacity');
    const extent = !this.#dataAllocation || this.#admission ? 128 * 1024 : DATA_EXTENT_BYTES;
    const dataAllocation = bytes > this.#dataAllocation ? this.#dataAllocation + extent : this.#dataAllocation;
    const indexAllocation = allocated(indexBytes);
    const charge = dataAllocation - this.#dataAllocation + indexAllocation - this.#indexAllocation;
    // Both mutable slots were charged when the fragment was admitted. An
    // in-place replacement cannot grow disk occupancy; it needs only its IO
    // permit, not a second root-ledger reservation/settlement round trip.
    const token = this.#admission ?? (charge ? await this.account.reserve('display', charge) : undefined);
    this.#admission = undefined; this.#unsettled = true;
    const entry = Buffer.alloc(INDEX_BYTES);
    for (let allocatedBytes = this.#dataAllocation; allocatedBytes < dataAllocation;) {
      const next = Math.min(dataAllocation, allocatedBytes + PHYSICAL_EXTENT_BYTES);
      await terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
        // Account every zero-filled byte while keeping each permit short. A
        // partial extent stays under the original durable reservation on failure.
        step.claim('writeBytes', next - allocatedBytes - 1);
        this.#dataIdentity = (await this.#files.write('display/data', Buffer.alloc(1), next - 1, next, step, this.#dataIdentity)).identity;
      });
      allocatedBytes = next;
    }
    await terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
      this.#dataIdentity = (await this.#files.write('display/data', encoded, at, dataAllocation, step, this.#dataIdentity)).identity;
      entry.writeBigUInt64LE(BigInt(at)); entry.writeUInt32LE(encoded.length, 8);
      if (previous || mutable) entry.writeUInt32LE((previous ? Number(previous.readBigUInt64LE()) : at + SLOT_BYTES) + 1, 12);
      if (previous) this.#unpublished = { ordinal, entry: Buffer.from(previous) };
      const indexPayload = indexAllocation > this.#indexAllocation ? Buffer.alloc(indexAllocation - indexOffset) : entry;
      if (indexPayload !== entry) entry.copy(indexPayload);
      this.#indexIdentity = (await this.#files.write('display/index', indexPayload, indexOffset, indexAllocation, step, this.#indexIdentity)).identity;
    });
    if (token) await this.account.settle(token, charge);
    this.#unsettled = false; this.#unpublished = undefined;
    this.#bytes = bytes; this.#indexBytes = indexBytes;
    this.#dataAllocation = dataAllocation; this.#indexAllocation = indexAllocation;
    // Metadata is validated/frozen by #encode. Keep a private immutable outer
    // record; a JSON round trip here only recreated the same confirmed content.
    this.#rememberHot(ordinal, { entry, segment: confirmed, encodedBytes: Buffer.byteLength(JSON.stringify(confirmed)) });
  }
  #rememberHot(ordinal: number, value: ConfirmedFragment): void {
    if (this.#reading.has(ordinal)) this.#reading.set(ordinal, value);
    this.#hot.delete(ordinal); this.#hot.set(ordinal, value);
    while (this.#hot.size > 4) this.#hot.delete(this.#hot.keys().next().value!);
  }
  async #read(ordinal: number): Promise<ConfirmedFragment> {
    this.signal.throwIfAborted();
    const hot = this.#hot.get(ordinal) ?? this.#reading.get(ordinal);
    if (hot) { this.#rememberHot(ordinal, hot); return hot; }
    const stored = await terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
      if (!this.#indexIdentity || !this.#dataIdentity) throw Error('terminal-display-identity-unavailable');
      const entry = this.#unpublished?.ordinal === ordinal ? this.#unpublished.entry :
        await this.#files.read('display/index', this.#indexAllocation, indexPosition(ordinal), INDEX_BYTES, this.#indexIdentity, step, true);
      if (entry.length !== INDEX_BYTES) throw Error('terminal-display-short-read');
      const at = Number(entry.readBigUInt64LE()), length = entry.readUInt32LE(8);
      if (!Number.isSafeInteger(at) || !length || length > SLOT_BYTES || at + length > this.#bytes) throw Error('terminal-display-index-invalid');
      const bytes = await this.#files.read('display/data', this.#dataAllocation, at, length, this.#dataIdentity, step, true);
      if (bytes.length !== length) throw Error('terminal-display-short-read');
      return { entry, decoded: JSON.parse(bytes.toString('utf8')) as TerminalDisplaySegment | DisplayReplayRecord };
    });
    // Source/parse work happens after releasing the physical display IO permit.
    const segment = 'replay' in stored.decoded ? await this.#replay(stored.decoded) : stored.decoded;
    const encoded = this.#encode(segment);
    const value = { entry: stored.entry, segment: Object.freeze(segment), encodedBytes: encoded.length };
    this.#rememberHot(ordinal, value); return value;
  }

  async #replay(record: DisplayReplayRecord): Promise<TerminalDisplaySegment> {
    if (!this.replay) throw Error('terminal-display-replay-unavailable');
    const segment = await this.replay(record);
    if (segment.blockId !== record.blockId || segment.role !== record.role || segment.contentOffset !== record.contentOffset ||
        segment.text.length !== record.length || createHash('sha256').update(segment.text).digest('hex') !== record.digest)
      throw Error('terminal-display-replay-source-changed');
    return segment;
  }

  async page(start?: number, follow = start === undefined): Promise<TerminalDisplayPage> {
    await this.#tail; this.signal.throwIfAborted();
    return this.#files.runOperation(async () => {
    const first = this.#first, last = this.#last;
    const from = Math.max(first, Math.min(last, start ?? last - 4));
    const segments: TerminalDisplaySegment[] = [];
    const reading = new Map<number, ConfirmedFragment>();
    let encodedBytes = 0;
    for (let ordinal = from; ordinal < Math.min(last, from + 4); ordinal++) {
      const value = await this.#read(ordinal); reading.set(ordinal, value); segments.push(value.segment);
      encodedBytes += value.encodedBytes;
    }
    const page = { first, last, start: from, follow, segments };
    // Confirmed records are immutable. Reuse their admitted JSON lengths rather
    // than serializing the whole reading page on every live-tail notification.
    encodedBytes += Buffer.byteLength(JSON.stringify({ first, last, start: from, follow, segments: [] })) + Math.max(0, segments.length - 1);
    if (encodedBytes > PAGE_BYTES) throw Error('terminal-display-page-size');
    this.#reading.clear(); for (const [ordinal, value] of reading) this.#reading.set(ordinal, value);
    return page;
    });
  }
  async close(): Promise<void> { await this.#tail; this.#hot.clear(); this.#reading.clear(); if (this.#ownsFiles) await this.#files.close(); }

  /** Retry admission without removing any retained prefix or old gap. */
  async retry(): Promise<void> {
    await this.#tail; this.signal.throwIfAborted();
    if (this.#unsettled || this.#unpublished || this.#active.size >= 128 || this.#activeCount >= 4096 ||
        this.#bytes + 2 * SLOT_BYTES >= 0xffffffff) throw Error('terminal-display-recovery-unavailable');
    const token = await this.account.reserve('display', allocated(2 * SLOT_BYTES) + 4096);
    try {
      if (this.#first === this.#last) await terminalPhysicalStep(this.capacity, bound, this.signal, async () => {});
      else await this.page();
    } finally { await this.account.settle(token, 0); }
    this.#failed = false;
  }

  async reset(): Promise<void> {
    this.#generation++;
    await this.#tail; this.signal.throwIfAborted();
    await this.#files.runOperation(async () => {
    // An unconfirmed partial write stays charged until S reclaims this instance.
    if (this.#unsettled) throw Error('terminal-display-settlement-unknown');
    const charge = this.#dataAllocation + this.#indexAllocation;
    this.#failed = true;
    if (charge) await terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
      if (!this.#dataIdentity || !this.#indexIdentity) throw Error('terminal-display-identity-unavailable');
      await this.#files.unlink('display/data', this.#dataIdentity, step);
      await this.#files.unlink('display/index', this.#indexIdentity, step);
    });
    // Release only after both known files are gone. A failure preserves the
    // conservative root charge and prevents the old index from being reused.
    this.#failed = true;
    for (let remaining = charge; remaining > 0;) {
      const amount = Math.min(1024 * 1024, remaining);
      await this.account.released('display', amount); remaining -= amount;
    }
    this.#first = this.#last = this.#bytes = this.#indexBytes = 0; this.#failed = false;
    this.#dataAllocation = this.#indexAllocation = 0;
    this.#active.clear(); this.#activeCount = 0; this.#unpublished = undefined;
    this.#hot.clear(); this.#reading.clear();
    this.#dataIdentity = this.#indexIdentity = undefined;
    });
  }
}
