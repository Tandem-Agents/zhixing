import type { DeviceCapacityArbiterPort, DeviceCapacityBudget } from '@zhixing/core/resources';
import type { TerminalDisplayPage, TerminalDisplaySegment } from '@zhixing/terminal-ui/protocol';
import { BODY_FRAGMENT_ENCODED_BYTES, BODY_PARSE_BYTES, sliceBodyNodes, validateBodyMetadata } from '@zhixing/terminal-ui/body-model';
import { mergeBodyAppends, type BodyAmend } from './body-projection.js';
import type { TerminalAssetAccount } from './asset-client.js';
import { TerminalManagedFiles } from './managed-files.js';
import { terminalPhysicalStep } from './physical-step.js';

const PAGE_BYTES = 224 * 1024;
const INDEX_BYTES = 16;
const SLOT_BYTES = BODY_FRAGMENT_ENCODED_BYTES;
interface ActiveFragment { readonly ordinal: number; readonly offset: number; readonly length: number }
const bound: DeviceCapacityBudget = {
  occupancy: { memoryReservationBytes: 3 * 1024 * 1024, temporaryBytes: 256 * 1024, slots: 1 },
  quantum: { readBytes: 512 * 1024, writeBytes: 512 * 1024, ioOperations: 256 },
};
const allocated = (bytes: number) => Math.ceil(bytes / 4096) * 4096;
const indexPosition = (ordinal: number) => (ordinal < 0 ? -ordinal * 2 - 1 : ordinal * 2) * INDEX_BYTES;
const quotedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2;
function carrierBytes(segment: TerminalDisplaySegment): number {
  const rendered = segment.body?.context.nodes.reduce((sum, node) => sum + node.runs.reduce((n, run) => n + quotedBytes(run.text), 0), 0);
  return Buffer.byteLength(JSON.stringify(segment)) + (rendered === undefined ? 0 : Math.max(0, quotedBytes(segment.text) - rendered));
}
/** Leave room for pending source to become rendered text at logical EOF.
 * Split only before first publication; amendments never change old ranges. */
function* carriers(segment: TerminalDisplaySegment): Generator<TerminalDisplaySegment> {
  if (carrierBytes(segment) <= SLOT_BYTES) { yield segment; return; }
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
  #tail = Promise.resolve(); #pending = 0; #failed = false;
  #unsettled = false;
  #generation = 0;
  readonly #active = new Map<string, ActiveFragment[]>();
  #activeCount = 0;
  // There is at most one unpublished index write: the first failure seals all
  // later mutation. Keep its full confirmed entry before touching that index.
  #unpublished?: { readonly ordinal: number; readonly entry: Buffer };
  #admission?: string;
  #dataIdentity?: string; #indexIdentity?: string;
  readonly #files: TerminalManagedFiles;
  readonly #ownsFiles: boolean;
  constructor(readonly directory: string, readonly capacity: DeviceCapacityArbiterPort,
    readonly account: TerminalAssetAccount, readonly signal: AbortSignal, files?: TerminalManagedFiles) {
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

  append(segment: TerminalDisplaySegment, prepend = false): Promise<void> {
    if (!segment.blockId || segment.blockId.length > 512 || segment.role.length > 32 ||
      !Number.isSafeInteger(segment.contentOffset) || segment.contentOffset < 0 || Buffer.byteLength(segment.text) > 32 * 1024 ||
      (segment.body && !validateBodyMetadata(segment.body, segment.contentOffset, segment.text.length))) return Promise.reject(Error('terminal-display-segment-size'));
    return this.#enqueue(async () => {
      // Prepend takes the pieces in reverse while preserving source offsets.
      const parts: TerminalDisplaySegment[] = [];
      for (const part of carriers(segment)) {
        if (parts.length >= 16) throw Error('terminal-display-carrier-capacity');
        parts.push(part);
      }
      if (prepend) parts.reverse();
      for (const part of parts) await this.#appendFragment(part, this.#encode(part), prepend);
    });
  }
  async #appendFragment(segment: TerminalDisplaySegment, encoded: Buffer, prepend: boolean): Promise<void> {
      const ordinal = prepend ? this.#first - 1 : this.#last;
      const active = !prepend && segment.body ? this.#active.get(segment.blockId) : undefined;
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
            if (candidate.length <= SLOT_BYTES && carrierBytes(next) <= SLOT_BYTES) {
              await this.#write(tail.ordinal, this.#encode(next), old.entry);
              this.#remember(segment.blockId, { ordinal: tail.ordinal, offset: next.contentOffset, length: next.text.length });
              return;
            }
          }
        }
      }
      if (!prepend && segment.body) this.#checkActive(segment.blockId);
      await this.#write(ordinal, encoded, undefined, !prepend && !!segment.body);
      if (prepend) this.#first = ordinal; else this.#last = ordinal + 1;
      if (!prepend && segment.body) this.#remember(segment.blockId, { ordinal, offset: segment.contentOffset, length: segment.text.length });
  }

  amend(blockId: string, change: BodyAmend): Promise<void> {
    return this.#enqueue(async () => {
      const entries = this.#active.get(blockId);
      if (!entries) throw Error('terminal-display-amend-block-missing');
      for (const fragment of entries) {
        if (fragment.offset >= change.to || fragment.offset + fragment.length <= change.from) continue;
        const old = await this.#read(fragment.ordinal), previous = old.segment;
        if (previous.blockId !== blockId || previous.contentOffset !== fragment.offset || previous.text.length !== fragment.length ||
            !previous.body || previous.body.revision >= change.revision) throw Error('terminal-display-amend-stale');
        const body = change.project(previous.contentOffset, previous.text.length, previous.body);
        if (body.revision !== change.revision) throw Error('terminal-display-amend-revision');
        const next = { ...previous, body, final: body.end };
        await this.#write(fragment.ordinal, this.#encode(next), old.entry);
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
  #encode(segment: TerminalDisplaySegment): Buffer {
    if (!segment.blockId || segment.blockId.length > 512 || segment.role.length > 32 ||
      !Number.isSafeInteger(segment.contentOffset) || segment.contentOffset < 0 || Buffer.byteLength(segment.text) > 32 * 1024 ||
      (segment.body && !validateBodyMetadata(segment.body, segment.contentOffset, segment.text.length))) throw Error('terminal-display-segment-size');
    const encoded = Buffer.from(JSON.stringify(segment));
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
  async #write(ordinal: number, encoded: Buffer, previous?: Buffer, mutable = false): Promise<void> {
    const indexOffset = indexPosition(ordinal), indexBytes = Math.max(this.#indexBytes, indexOffset + INDEX_BYTES);
    const spare = previous ? previous.readUInt32LE(12) - 1 : -1;
    if (previous && spare < 0) throw Error('terminal-display-immutable-fragment');
    const at = previous ? spare : this.#bytes;
    const growth = previous ? 0 : mutable ? 2 * SLOT_BYTES : encoded.length;
    const bytes = this.#bytes + growth;
    if (bytes >= 0xffffffff) throw Error('terminal-display-offset-capacity');
    const charge = allocated(bytes) - allocated(this.#bytes) + allocated(indexBytes) - allocated(this.#indexBytes);
    const token = this.#admission ?? await this.account.reserve('display', Math.max(1, charge));
    this.#admission = undefined; this.#unsettled = true;
    await terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
      const payload = mutable && !previous ? Buffer.alloc(growth) : encoded;
      if (payload !== encoded) encoded.copy(payload);
      this.#dataIdentity = (await this.#files.write('display/data', payload, at, bytes, step, this.#dataIdentity)).identity;
      const entry = Buffer.alloc(INDEX_BYTES);
      entry.writeBigUInt64LE(BigInt(at)); entry.writeUInt32LE(encoded.length, 8);
      if (previous || mutable) entry.writeUInt32LE((previous ? Number(previous.readBigUInt64LE()) : at + SLOT_BYTES) + 1, 12);
      if (previous) this.#unpublished = { ordinal, entry: Buffer.from(previous) };
      this.#indexIdentity = (await this.#files.write('display/index', entry, indexOffset, indexBytes, step, this.#indexIdentity)).identity;
    });
    await this.account.settle(token, charge);
    this.#unsettled = false; this.#unpublished = undefined;
    this.#bytes = bytes; this.#indexBytes = indexBytes;
  }
  async #read(ordinal: number): Promise<{ entry: Buffer; segment: TerminalDisplaySegment }> {
    return terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
      if (!this.#indexIdentity || !this.#dataIdentity) throw Error('terminal-display-identity-unavailable');
      const entry = this.#unpublished?.ordinal === ordinal ? this.#unpublished.entry :
        await this.#files.read('display/index', this.#indexBytes, indexPosition(ordinal), INDEX_BYTES, this.#indexIdentity, step, true);
      if (entry.length !== INDEX_BYTES) throw Error('terminal-display-short-read');
      const at = Number(entry.readBigUInt64LE()), length = entry.readUInt32LE(8);
      if (!Number.isSafeInteger(at) || !length || length > SLOT_BYTES || at + length > this.#bytes) throw Error('terminal-display-index-invalid');
      const bytes = await this.#files.read('display/data', this.#bytes, at, length, this.#dataIdentity, step, true);
      if (bytes.length !== length) throw Error('terminal-display-short-read');
      const segment = JSON.parse(bytes.toString('utf8')) as TerminalDisplaySegment;
      this.#encode(segment); return { entry, segment };
    });
  }

  async page(start?: number, follow = start === undefined): Promise<TerminalDisplayPage> {
    await this.#tail; this.signal.throwIfAborted();
    return this.#files.runOperation(async () => {
    const first = this.#first, last = this.#last;
    const from = Math.max(first, Math.min(last, start ?? last - 4));
    const segments: TerminalDisplaySegment[] = [];
    for (let ordinal = from; ordinal < Math.min(last, from + 4); ordinal++) segments.push((await this.#read(ordinal)).segment);
    const page = { first, last, start: from, follow, segments };
    if (Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTES) throw Error('terminal-display-page-size');
    return page;
    });
  }
  async close(): Promise<void> { await this.#tail; if (this.#ownsFiles) await this.#files.close(); }

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
    const charge = allocated(this.#bytes) + allocated(this.#indexBytes);
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
    this.#active.clear(); this.#activeCount = 0; this.#unpublished = undefined;
    this.#dataIdentity = this.#indexIdentity = undefined;
    });
  }
}
