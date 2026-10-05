import type { DeviceCapacityArbiterPort, DeviceCapacityBudget } from '@zhixing/core/resources';
import type { TerminalDisplayPage, TerminalDisplaySegment } from '@zhixing/terminal-ui/protocol';
import type { TerminalAssetAccount } from './asset-client.js';
import { TerminalManagedFiles } from './managed-files.js';
import { terminalPhysicalStep } from './physical-step.js';

const PAGE_BYTES = 224 * 1024;
const INDEX_BYTES = 16;
const bound: DeviceCapacityBudget = {
  occupancy: { memoryReservationBytes: 3 * 1024 * 1024, temporaryBytes: 256 * 1024, slots: 1 },
  quantum: { readBytes: 512 * 1024, writeBytes: 512 * 1024, ioOperations: 256 },
};
const allocated = (bytes: number) => Math.ceil(bytes / 4096) * 4096;
const indexPosition = (ordinal: number) => (ordinal < 0 ? -ordinal * 2 - 1 : ordinal * 2) * INDEX_BYTES;

/** A disposable projection, with a fixed-size disk index rather than a retained
 * in-memory history array. Only complete writes become visible. Negative
 * ordinals prepend older history without copying a growing index or body. */
export class TerminalDisplayStore {
  #first = 0; #last = 0; #bytes = 0; #indexBytes = 0;
  #tail = Promise.resolve(); #pending = 0; #failed = false;
  #unsettled = false;
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
    if (this.#failed || this.#pending >= 8) return Promise.reject(Error('terminal-display-paused'));
    if (!segment.blockId || segment.blockId.length > 512 || segment.role.length > 32 ||
      !Number.isSafeInteger(segment.contentOffset) || segment.contentOffset < 0 || Buffer.byteLength(segment.text) > 32 * 1024) {
      return Promise.reject(Error('terminal-display-segment-size'));
    }
    const encoded = Buffer.from(JSON.stringify(segment));
    if (encoded.length > PAGE_BYTES) return Promise.reject(Error('terminal-display-encoding-size'));
    this.#pending++;
    const operation = this.#tail.then(() => this.#files.runOperation(async () => {
      this.signal.throwIfAborted();
      if (this.#failed) throw Error('terminal-display-paused');
      const ordinal = prepend ? this.#first - 1 : this.#last;
      const indexOffset = indexPosition(ordinal);
      const indexBytes = Math.max(this.#indexBytes, indexOffset + INDEX_BYTES);
      const bytes = this.#bytes + encoded.length;
      const charge = allocated(bytes) - allocated(this.#bytes) + allocated(indexBytes) - allocated(this.#indexBytes);
      // A fully occupied allocation block still needs finite metadata admission.
      const token = this.#admission ?? await this.account.reserve('display', Math.max(1, charge));
      this.#admission = undefined;
      this.#unsettled = true;
      await terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
        this.#dataIdentity = (await this.#files.write('display/data', encoded, this.#bytes, bytes, step, this.#dataIdentity)).identity;
        const entry = Buffer.alloc(INDEX_BYTES);
        entry.writeBigUInt64LE(BigInt(this.#bytes)); entry.writeUInt32LE(encoded.length, 8);
        this.#indexIdentity = (await this.#files.write('display/index', entry, indexOffset, indexBytes, step, this.#indexIdentity)).identity;
      });
      await this.account.settle(token, charge);
      this.#unsettled = false;
      this.#bytes = bytes; this.#indexBytes = indexBytes;
      if (prepend) this.#first = ordinal; else this.#last = ordinal + 1;
    })).catch(error => { this.#failed = true; throw error; }).finally(() => { this.#pending--; });
    this.#tail = operation.catch(() => {}); return operation;
  }

  async page(start?: number, follow = start === undefined): Promise<TerminalDisplayPage> {
    await this.#tail; this.signal.throwIfAborted();
    return this.#files.runOperation(async () => {
    const first = this.#first, last = this.#last;
    const from = Math.max(first, Math.min(last, start ?? last - 4));
    const segments: TerminalDisplaySegment[] = [];
    if (first !== last) await terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
      if (!this.#indexIdentity || !this.#dataIdentity) throw Error('terminal-display-identity-unavailable');
      let retained = 0;
      for (let ordinal = from; ordinal < Math.min(last, from + 4); ordinal++) {
        const entry = await this.#files.read('display/index', this.#indexBytes, indexPosition(ordinal), INDEX_BYTES, this.#indexIdentity, step);
        if (entry.length !== INDEX_BYTES) throw Error('terminal-display-short-read');
        const at = Number(entry.readBigUInt64LE()), length = entry.readUInt32LE(8);
        if (!Number.isSafeInteger(at) || !length || length > PAGE_BYTES || at + length > this.#bytes) throw Error('terminal-display-index-invalid');
        if (retained + length > PAGE_BYTES && segments.length) break;
        const bytes = await this.#files.read('display/data', this.#bytes, at, length, this.#dataIdentity, step);
        if (bytes.length !== length) throw Error('terminal-display-short-read');
        segments.push(JSON.parse(bytes.toString('utf8')) as TerminalDisplaySegment); retained += length;
      }
    });
    return { first, last, start: from, follow, segments };
    });
  }
  async close(): Promise<void> { await this.#tail; if (this.#ownsFiles) await this.#files.close(); }

  async reset(): Promise<void> {
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
    this.#dataIdentity = this.#indexIdentity = undefined;
    });
  }
}
