import type { DeviceCapacityArbiterPort, DeviceCapacityBudget } from '@zhixing/core/resources';
import type { TerminalAssetAccount } from './asset-client.js';
import { terminalPhysicalStep } from './physical-step.js';
import { TerminalManagedFiles } from './managed-files.js';
import { formatPasteToken, createPasteTokenPattern } from '../paste-registry.js';
import { createInputHandleTokenPatterns } from '../input-handle-tokens.js';
import { randomUUID } from 'node:crypto';

interface InputBlob {
  readonly id: string; readonly purpose: 'draft' | 'paste';
  bytes: number; index: number; complete: boolean;
  newlines: number; trailingNewlines: number; hasNonNewline: boolean;
  failed: boolean; pasteId?: number; token?: string;
  readonly expectedBytes?: number;
  identity?: string;
  reservation?: { token: string; bytes: number; start: number };
}
const bound: DeviceCapacityBudget = {
  // Includes the finite native-owner byte array, base64 IPC and decoded page.
  occupancy: { memoryReservationBytes: 3 * 1024 * 1024, temporaryBytes: 256 * 1024, slots: 1 },
  quantum: { readBytes: 256 * 1024, writeBytes: 256 * 1024, ioOperations: 128 },
};
const copyBound: DeviceCapacityBudget = {
  occupancy: { memoryReservationBytes: 3 * 1024 * 1024, temporaryBytes: 1024 * 1024, slots: 1 },
  quantum: { readBytes: 1024 * 1024, writeBytes: 1024 * 1024, ioOperations: 128 },
};
const allocated = (bytes: number) => Math.ceil(bytes / 4096) * 4096;
const UUID = /^[a-f0-9-]{36}$/u;

/** Original paste and input history live in P, read through 256 KiB pages.
 * Metadata stays in J; no registry array retains the original strings. */
export class TerminalInputStore {
  readonly #blobs = new Map<string, InputBlob>();
  readonly #pastes = new Map<number, InputBlob>();
  readonly #handles = new Map<string, string>();
  readonly #owners = new Map<string, ReadonlySet<string>>();
  readonly #unclaimed = new Set<string>();
  #nextPaste = 0;
  #serial = Promise.resolve(); #pending = 0;
  #spliceWork?: Promise<{ inputId: string; start: number; end: number; bytes: number }>;
  #referenceSerial = Promise.resolve();
  #referencePending = 0;
  #referenceVersion = -1;
  #deleting = 0;
  #closing = false;
  readonly #files: TerminalManagedFiles;
  readonly #ownsFiles: boolean;
  constructor(readonly directory: string, readonly capacity: DeviceCapacityArbiterPort,
    readonly account: TerminalAssetAccount, readonly signal: AbortSignal, files?: TerminalManagedFiles) {
    this.#files = files ?? new TerminalManagedFiles(directory); this.#ownsFiles = !files;
  }

  begin(id: string, purpose: 'draft' | 'paste', expectedBytes?: number): void {
    this.signal.throwIfAborted();
    if (!UUID.test(id) || !['draft', 'paste'].includes(purpose) || this.#blobs.has(id)) throw Error('terminal-input-identity');
    if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) throw Error('terminal-input-size');
    if (this.#blobs.size >= 4096 || [...this.#blobs.values()].filter(blob => !blob.complete).length >= 4) throw Error('terminal-input-slot-capacity');
    this.#blobs.set(id, { id, purpose, expectedBytes, bytes: 0, index: 0, complete: false, newlines: 0, trailingNewlines: 0, hasNonNewline: false, failed: false });
    this.#unclaimed.add(id);
  }

  part(id: string, index: number, text: string, final: boolean): Promise<void> {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 || this.#pending >= 8) return Promise.reject(Error('terminal-input-part-capacity'));
    this.#pending++;
    const work = this.#serial.then(() => this.#files.runOperation(async () => {
      const blob = this.#blobs.get(id);
      if (!blob || blob.failed || blob.complete || blob.index !== index) throw Error('terminal-input-part-order');
      const bytes = Buffer.from(text);
      if (blob.expectedBytes !== undefined && (blob.bytes + bytes.length > blob.expectedBytes || (final && blob.bytes + bytes.length !== blob.expectedBytes))) throw Error('terminal-input-size-mismatch');
      try {
        if (blob.reservation && allocated(blob.bytes + bytes.length) > blob.reservation.start + blob.reservation.bytes) await this.#settle(blob);
        if (!blob.reservation) {
          // Streaming paste does not know its final size. Its next finite
          // extent stays charged until actual usage is settled; never reserve
          // the unknown whole original or keep a physical permit between parts.
          const reserveBytes = Math.max(1, blob.expectedBytes === undefined ? 1024 * 1024 : Math.min(1024 * 1024, allocated(blob.expectedBytes) - allocated(blob.bytes)));
          const token = await this.account.reserve('input', reserveBytes);
          blob.reservation = { token, bytes: reserveBytes, start: allocated(blob.bytes) };
        }
        await terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
          const written = await this.#files.write(`input/${id}`, bytes, blob.bytes, blob.bytes + bytes.length, step, blob.identity);
          blob.identity = written.identity;
        });
        blob.bytes += bytes.length; blob.index++; blob.complete = final;
        if (final) await this.#settle(blob);
        for (const char of text) {
          if (char === '\n') { blob.newlines++; blob.trailingNewlines++; }
          else if (char !== '\r') { blob.hasNonNewline = true; blob.trailingNewlines = 0; }
        }
      } catch (error) { blob.failed = true; throw error; }
    })).finally(() => { this.#pending--; });
    this.#serial = work.catch(() => {}); return work;
  }

  completePaste(id: string): { token: string; bytes: number; fold: boolean } {
    const blob = this.#ready(id);
    if (blob.purpose !== 'paste') throw Error('terminal-input-purpose');
    if (!blob.pasteId) {
      if (this.#handles.size >= 4096) throw Error('terminal-input-handle-capacity');
      blob.pasteId = ++this.#nextPaste;
      blob.token = formatPasteToken({ id: blob.pasteId, byteSize: blob.bytes,
        lineCount: blob.hasNonNewline ? blob.newlines - blob.trailingNewlines + 1 : 0 });
      this.#pastes.set(blob.pasteId, blob);
      this.#handles.set(blob.token, blob.id);
    }
    const lines = blob.hasNonNewline ? blob.newlines - blob.trailingNewlines + 1 : 0;
    return { token: blob.token!, bytes: blob.bytes, fold: blob.bytes >= 200 || lines >= 4 };
  }

  registerHandles(id: string, text: string): readonly { token: string; id: string }[] {
    this.#ready(id);
    const result = new Map<string, string>();
    for (const pattern of createInputHandleTokenPatterns()) for (const match of text.matchAll(pattern)) {
      if (Buffer.byteLength(match[0]) > 1024 || (!this.#handles.has(match[0]) && this.#handles.size >= 4096)) throw Error('terminal-input-handle-capacity');
      if (!this.#handles.has(match[0])) this.#handles.set(match[0], id);
      result.set(match[0], this.#handles.get(match[0])!);
    }
    return [...result].map(([token, id]) => ({ token, id }));
  }
  get handles(): Iterable<string> { return this.#handles.keys(); }
  references(text: string): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const pattern of createInputHandleTokenPatterns()) for (const match of text.matchAll(pattern)) {
      const id = this.#handles.get(match[0]); if (id) ids.add(id);
    }
    return ids;
  }
  retain(owner: string, ids: ReadonlySet<string>): void {
    this.#checkReferenceOperation();
    if (owner.length > 100 || (!this.#owners.has(owner) && this.#owners.size >= 108)) throw Error('terminal-input-reference-capacity');
    // Every owner aliases the store's canonical immutable identity. History
    // closures retain their own Set slots, not another copy of each wire ID.
    const canonical = new Set<string>();
    for (const id of ids) canonical.add(this.#ready(id).id);
    this.#owners.set(owner, canonical);
    for (const id of canonical) this.#unclaimed.delete(id);
  }
  retainDraft(owner: string, id: string): Promise<void> {
    return this.retainReferences(owner, new Set([id]));
  }
  retainReferences(owner: string, ids: ReadonlySet<string>): Promise<void> {
    return this.#referenceOperation(ids, async canonical => {
      const references = await this.#scanReferences(canonical);
      this.#checkReferenceOperation();
      this.retain(owner, references);
    });
  }

  /** One active scan and one waiting transaction, including frozen submissions.
   * U timing out does not release this admission. A newer admitted revision
   * invalidates an old scan before it can mutate an owner or publish originals.
   * Collection remains inhibited until the last admitted scan has committed. */
  reconcileReferences(version: number, ids: readonly string[], completed: readonly string[], cached: readonly string[] = []): Promise<{ accepted: true; removed: readonly string[] }> {
    if (!Number.isSafeInteger(version) || version < 0 || !Array.isArray(ids) || ids.length > 4096 ||
        !Array.isArray(completed) || completed.length > 4 || !Array.isArray(cached) || cached.length + ids.length > 4104 ||
        [...ids, ...completed, ...cached].some(id => typeof id !== 'string' || !UUID.test(id))) return Promise.reject(Error('terminal-input-references'));
    if (version <= this.#referenceVersion) return Promise.reject(Error('terminal-input-references-superseded'));
    // Admission is synchronous: rejected requests cannot advance the version or
    // retain a queued copy of their IDs. The wire arrays of the two admitted
    // callers and their canonical sets are included in the J ledger.
    return this.#referenceOperation(ids, async canonical => {
      const current = () => { this.#checkReferenceOperation(); if (version !== this.#referenceVersion) throw Error('terminal-input-references-superseded'); };
      current();
      const references = await this.#scanReferences(canonical, current);
      current();
      this.retain('current', references);
      this.published(completed);
      const removed = await this.#collect(current, true);
      current();
      return { accepted: true, removed: [...new Set([...removed, ...this.missing(cached)])] };
    }, () => { this.#referenceVersion = version; });
  }

  #referenceOperation<T>(ids: Iterable<string>, operation: (canonical: ReadonlySet<string>) => Promise<T>, admitted?: () => void): Promise<T> {
    try {
      this.#checkReferenceOperation();
      if (this.#referencePending >= 2 || this.#deleting) throw Error('terminal-input-reference-busy');
      const canonical = new Set<string>();
      for (const id of ids) { if (canonical.size >= 4096 && !canonical.has(id)) throw Error('terminal-input-reference-capacity'); canonical.add(this.#ready(id).id); }
      this.#referencePending++; admitted?.();
      const work = this.#referenceSerial.then(() => { this.#checkReferenceOperation(); return operation(canonical); })
        .finally(() => { this.#referencePending--; });
      this.#referenceSerial = work.then(() => {}, () => {});
      return work;
    } catch (error) { return Promise.reject(error); }
  }
  #checkReferenceOperation(): void {
    this.signal.throwIfAborted();
    if (this.#closing) throw Error('terminal-input-closed');
  }
  async #scanReferences(ids: ReadonlySet<string>, current = () => this.#checkReferenceOperation()): Promise<ReadonlySet<string>> {
    const references = new Set(ids);
    for (const id of ids) {
      current();
      if (this.#ready(id).purpose !== 'draft' || !this.#handles.size) continue;
      // A published immutable draft already has its complete closure in its
      // history/frozen owner. Reusing that closure avoids scanning on cursor
      // movements or repeated visits; a newly edited version is scanned once.
      const known = this.#owners.get(`history:${id}`) ?? this.#owners.get(`frozen:${id}`);
      if (known) { for (const ref of known) references.add(ref); continue; }
      let carry = '';
      for await (const page of this.pages(id)) {
        current();
        const text = carry + page;
        for (const ref of this.references(text)) references.add(ref);
        carry = text.slice(-1024);
      }
    }
    return references;
  }
  transfer(from: string, to: string): void {
    const ids = this.#owners.get(from);
    if (!ids) throw Error('terminal-input-owner-missing');
    this.retain(to, ids);
  }
  forget(owner: string): void { this.#owners.delete(owner); }
  published(ids: readonly string[]): void { for (const id of ids) this.#unclaimed.delete(id); }
  missing(ids: readonly string[]): readonly string[] { return ids.filter(id => !this.#blobs.has(id)); }
  async collect(): Promise<readonly string[]> {
    return this.#collect(() => this.#checkReferenceOperation());
  }
  async #collect(current: () => void, referenceTransaction = false): Promise<readonly string[]> {
    const removed: string[] = [];
    for (const id of this.#blobs.keys()) {
      current();
      if (this.#referencePending > Number(referenceTransaction)) break;
      if (this.#unclaimed.has(id) || [...this.#owners.values()].some(ids => ids.has(id))) continue;
      if (this.#blobs.get(id)?.failed) continue;
      await this.#release(id, referenceTransaction, current);
      if (!this.#blobs.has(id)) removed.push(id);
    }
    return removed;
  }
  get retainedBytes(): number { let total = 0; for (const blob of this.#blobs.values()) total += blob.bytes; return total; }
  get retainedCount(): number { return this.#blobs.size; }
  bytes(id: string): number { return this.#ready(id).bytes; }

  /** Read a bounded editable window around an original UTF-8 position. */
  async window(id: string, position: number): Promise<{ inputId: string; start: number; end: number; bytes: number; text: string; handles: readonly { token: string; id: string; paste: boolean }[] }> {
    const blob = this.#ready(id);
    if (!Number.isSafeInteger(position) || position < 0 || position > blob.bytes) throw Error('terminal-input-position');
    const maximum = 32 * 1024, edge = 4 * 1024, visible = maximum - edge * 2;
    const desiredStart = Math.max(0, Math.min(blob.bytes - visible, position - visible / 2));
    let start = Math.max(0, desiredStart - edge);
    const count = Math.min(maximum, blob.bytes - start);
    if (!count) return { inputId: id, start: 0, end: 0, bytes: 0, text: '', handles: [] };
    const bytes = await this.#files.runOperation(() => terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
      if (!blob.identity) throw Error('terminal-input-identity-unavailable');
      const result = await this.#files.read(`input/${id}`, blob.bytes, start, count, blob.identity, step);
      if (result.length !== count) throw Error('terminal-input-short-read');
      return result;
    }));
    let leading = 0;
    while (leading < bytes.length && (bytes[leading]! & 0xc0) === 0x80) leading++;
    if (leading > 3) throw Error('terminal-input-encoding');
    start += leading;
    const content = bytes.subarray(leading);
    const decode = (value: Uint8Array, stream = true) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value, { stream });
    const text = decode(content, start + content.length < blob.bytes);
    let from = decode(content.subarray(0, Math.max(0, desiredStart - start))).length;
    let to = decode(content.subarray(0, Math.min(content.length, desiredStart + visible - start))).length;
    // A registered atomic handle may straddle a page edge. Include it whole;
    // the 4 KiB margin covers its existing 1,024 UTF-8-byte maximum.
    for (const pattern of createInputHandleTokenPatterns()) for (const match of text.matchAll(pattern)) {
      if (!this.#handles.has(match[0])) continue;
      const first = match.index!, last = first + match[0].length;
      if (first < from && last > from) from = first;
      if (first < to && last > to) to = last;
    }
    const value = text.slice(from, to);
    start += Buffer.byteLength(text.slice(0, from));
    const handles = new Map<string, { token: string; id: string; paste: boolean }>();
    for (const pattern of createInputHandleTokenPatterns()) for (const match of value.matchAll(pattern)) {
      const reference = this.#handles.get(match[0]);
      if (reference) handles.set(match[0], { token: match[0], id: reference, paste: this.#blobs.get(reference)?.token === match[0] });
    }
    return { inputId: id, start, end: start + Buffer.byteLength(value), bytes: blob.bytes, text: value, handles: [...handles.values()] };
  }

  /** Publish an immutable edited draft only after every replacement page is
   * written and settled. The old version and its owners survive a failure.
   * Full copies are streamed through existing P transactions, never joined in
   * J. Unchanged windows need no replacement and no full-file copy. */
  /** Replace a complete paste in one immutable draft transaction. Thresholds
   * and old-token discovery live here; a U window cannot know the cold suffix. */
  applyPaste(id: string, start: number, end: number, pasteId: string, cursor: number): Promise<{ inputId: string; start: number; end: number; bytes: number; cursor: number }> {
    if (this.#spliceWork) return Promise.reject(Error('terminal-input-edit-in-progress'));
    const work = this.#applyPaste(id, start, end, pasteId, cursor);
    this.#spliceWork = work;
    return work.finally(() => { this.#spliceWork = undefined; });
  }
  async #applyPaste(id: string, start: number, end: number, pasteId: string, cursor: number): Promise<{ inputId: string; start: number; end: number; bytes: number; cursor: number }> {
    const source = this.#ready(id), incoming = this.#ready(pasteId);
    if (source.purpose !== 'draft' || incoming.purpose !== 'paste') throw Error('terminal-input-purpose');
    await this.#validateRange(source, start, end);
    await this.#validateRange(source, cursor, cursor);
    let replaced = false, carry = '';
    for await (const page of this.pages(id)) {
      const text = carry + page;
      for (const match of text.matchAll(createPasteTokenPattern())) {
        const old = this.#pastes.get(Number(match[1]));
        if (old?.token === match[0] && old.id !== pasteId) { replaced = true; break; }
      }
      if (replaced) break;
      carry = text.slice(-1024);
    }
    const paste = this.completePaste(pasteId);
    const expanded = replaced || !paste.fold;
    const next = randomUUID(); this.begin(next, 'draft');
    const target = this.#blobs.get(next)!, mapping: { at: number; value?: number } = { at: cursor };
    try {
      await this.#copyWithoutPastes(source, 0, start, target, pasteId, mapping);
      const windowStart = target.bytes;
      if (expanded) await this.#copy(incoming, 0, incoming.bytes, target);
      else { await this.part(next, target.index, paste.token, false); await this.#settle(target); }
      const windowEnd = target.bytes;
      if (cursor > start && cursor <= end) mapping.value = windowEnd;
      await this.#copyWithoutPastes(source, end, source.bytes, target, pasteId, mapping);
      await this.part(next, target.index, '', true);
      return { inputId: next, start: windowStart, end: windowEnd, bytes: target.bytes, cursor: mapping.value ?? windowEnd };
    } catch (error) { await this.release(next).catch(() => {}); throw error; }
  }

  async #validateRange(source: InputBlob, start: number, end: number): Promise<void> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.bytes) throw Error('terminal-input-range');
    for (const offset of new Set([start, end])) if (offset && offset < source.bytes) {
      const byte = await this.#files.runOperation(() => terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
        if (!source.identity) throw Error('terminal-input-identity-unavailable');
        return this.#files.read(`input/${source.id}`, source.bytes, offset, 1, source.identity, step);
      }));
      if (byte.length !== 1 || (byte[0]! & 0xc0) === 0x80) throw Error('terminal-input-range-encoding');
    }
  }
  splice(id: string, start: number, end: number, replacementId: string): Promise<string> {
    return this.editWindow(id, start, end, replacementId).then(result => result.inputId);
  }
  editWindow(id: string, start: number, end: number, replacementId: string): Promise<{ inputId: string; start: number; end: number; bytes: number }> {
    if (this.#spliceWork) return Promise.reject(Error('terminal-input-edit-in-progress'));
    return this.#spliceWork = this.#splice(id, start, end, replacementId).finally(() => { this.#spliceWork = undefined; });
  }

  async #splice(id: string, start: number, end: number, replacementId: string): Promise<{ inputId: string; start: number; end: number; bytes: number }> {
    const source = this.#ready(id), replacement = this.#ready(replacementId);
    await this.#validateRange(source, start, end);
    const next = randomUUID();
    this.begin(next, 'draft', source.bytes - (end - start) + replacement.bytes);
    const target = this.#blobs.get(next)!;
    try {
      await this.#copy(source, 0, start, target);
      const windowStart = target.bytes;
      await this.#copy(replacement, 0, replacement.bytes, target);
      const windowEnd = target.bytes;
      await this.#copy(source, end, source.bytes, target);
      await this.part(next, target.index, '', true);
      return { inputId: next, start: windowStart, end: windowEnd, bytes: target.bytes };
    } catch (error) {
      // Existing settlement rules retain uncertain writes as charged debt.
      await this.release(next).catch(() => {});
      throw error;
    }
  }

  async #copyWithoutPastes(source: InputBlob, start: number, end: number, target: InputBlob, keep?: string, mapping?: { at: number; value?: number }): Promise<void> {
    const copy = async (from: number, to: number) => {
      if (mapping && mapping.value === undefined && mapping.at >= from && mapping.at <= to) mapping.value = target.bytes + mapping.at - from;
      await this.#copy(source, from, to, target);
    };
    if (!keep || !this.#pastes.size) { await copy(start, end); return; }
    // Only registered old paste tokens disappear. Scan one bounded page plus
    // token carry, and copy unchanged ranges without retaining a range table.
    let offset = start, textOffset = start, spanStart = start, carry = '';
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    while (offset < end) {
      const count = Math.min(256 * 1024, end - offset);
      const bytes = await this.#files.runOperation(() => terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
        if (!source.identity) throw Error('terminal-input-identity-unavailable');
        return this.#files.read(`input/${source.id}`, source.bytes, offset, count, source.identity, step);
      }));
      if (bytes.length !== count) throw Error('terminal-input-short-read');
      offset += count;
      const text = carry + decoder.decode(bytes, { stream: offset < end });
      let limit = offset === end ? text.length : Math.max(0, text.length - 1024);
      if (limit && /[\uD800-\uDBFF]/u.test(text[limit - 1]!)) limit--;
      for (const match of text.matchAll(createPasteTokenPattern())) {
        if (match.index! >= limit) break;
        if (match.index! + match[0].length > limit && offset < end) { limit = match.index!; break; }
        const blob = this.#pastes.get(Number(match[1]));
        if (blob?.token !== match[0] || blob.id === keep) continue;
        const tokenStart = textOffset + Buffer.byteLength(text.slice(0, match.index));
        await copy(spanStart, tokenStart);
        spanStart = tokenStart + Buffer.byteLength(match[0]);
        if (mapping && mapping.value === undefined && mapping.at >= tokenStart && mapping.at <= spanStart) mapping.value = target.bytes;
      }
      textOffset += Buffer.byteLength(text.slice(0, limit)); carry = text.slice(limit);
    }
    await copy(spanStart, end);
  }

  async #copy(source: InputBlob, start: number, end: number, target: InputBlob): Promise<void> {
    for (let offset = start; offset < end;) {
      const count = Math.min(1024 * 1024, end - offset);
      try {
        await this.#files.runOperation(async () => {
          const charge = allocated(target.bytes + count) - allocated(target.bytes);
          if (charge) target.reservation = { token: await this.account.reserve('input', charge), bytes: charge, start: allocated(target.bytes) };
          const entry = await terminalPhysicalStep(this.capacity, copyBound, this.signal, async step => {
            if (!source.identity) throw Error('terminal-input-identity-unavailable');
            return this.#files.copyInput(source.id, source.identity, source.bytes, offset, target.id, target.identity, target.bytes, count, step);
          });
          target.identity = entry.identity; target.bytes += count; target.index++;
          await this.#settle(target);
          offset += count;
        });
      } catch (error) { target.failed = true; throw error; }
    }
  }

  async *pages(id: string): AsyncGenerator<string> {
    const blob = this.#ready(id);
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    for (let position = 0; position < blob.bytes;) {
      const count = Math.min(256 * 1024, blob.bytes - position);
      const bytes = await this.#files.runOperation(() => terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
        if (!blob.identity) throw Error('terminal-input-identity-unavailable');
        const buffer = await this.#files.read(`input/${id}`, blob.bytes, position, count, blob.identity, step);
        if (buffer.length !== count) throw Error('terminal-input-short-read');
        return buffer;
      }));
      position += count;
      yield decoder.decode(bytes, { stream: position < blob.bytes });
    }
  }

  async text(id: string, hotBytes: number): Promise<string> {
    const blob = this.#ready(id);
    // Both chunk strings and the final join coexist briefly; reserve both.
    if (blob.bytes * 2 + 1024 * 1024 > hotBytes) throw Error('当前展开工作区不足，原文和草稿已保留。');
    const chunks: string[] = [];
    for await (const page of this.pages(id)) chunks.push(page);
    return chunks.join('');
  }

  /** Re-read an accepted frozen submission for display without retaining its
   * expanded RPC preparation string while waiting for the business result. */
  async *expandedPages(draftId: string): AsyncGenerator<string> {
    let carry = '';
    const expand = async function* (store: TerminalInputStore, text: string, end: number) {
      let start = 0;
      for (const match of text.matchAll(createPasteTokenPattern())) {
        if (match.index! >= end) break;
        if (match.index! + match[0].length > end) { end = match.index!; break; }
        const blob = store.#pastes.get(Number(match[1]));
        if (blob?.token !== match[0]) continue;
        if (match.index! > start) yield text.slice(start, match.index);
        yield* store.pages(blob.id); start = match.index! + match[0].length;
      }
      if (end > start) yield text.slice(start, end);
      carry = text.slice(end);
    };
    for await (const page of this.pages(draftId)) {
      const text = carry + page;
      let end = Math.max(0, text.length - 1024);
      if (end && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
      yield* expand(this, text, end);
    }
    if (carry) yield* expand(this, carry, carry.length);
  }

  /** Expansion keeps text and material order; unknown/edited handles stay literal. */
  async expand(draftId: string, hotBytes: number): Promise<string> {
    const draft = await this.text(draftId, hotBytes);
    const draftBytes = this.#ready(draftId).bytes;
    let expandedBytes = draftBytes, replacements = 0;
    for (const match of draft.matchAll(createPasteTokenPattern())) {
      const blob = this.#pastes.get(Number(match[1]));
      if (blob?.token === match[0]) { expandedBytes += blob.bytes - Buffer.byteLength(match[0]); replacements++; }
    }
    if (!replacements) return draft;
    const metadata = 1024 * 1024 + replacements * 64;
    // Draft + expanded pieces + joined result, including the finite piece
    // index. UTF-16/native/GC amplification belongs to the separate RSS check.
    if (expandedBytes * 2 + draftBytes + metadata > hotBytes) throw Error('当前展开工作区不足，原文和草稿已保留。');
    const pieces: string[] = []; let offset = 0, retainedBytes = draftBytes;
    for (const match of draft.matchAll(createPasteTokenPattern())) {
      const blob = this.#pastes.get(Number(match[1]));
      if (blob?.token !== match[0]) continue;
      const prefix = draft.slice(offset, match.index); pieces.push(prefix); retainedBytes += Buffer.byteLength(prefix);
      const text = await this.text(blob.id, hotBytes - retainedBytes - replacements * 64);
      pieces.push(text); retainedBytes += blob.bytes;
      offset = match.index! + match[0].length;
    }
    pieces.push(draft.slice(offset)); return pieces.join('');
  }

  async release(id: string): Promise<void> {
    return this.#release(id);
  }
  async #release(id: string, referenceTransaction = false, current = () => this.#checkReferenceOperation()): Promise<void> {
    await this.#serial;
    await this.#files.runOperation(async () => {
      current();
      if (this.#referencePending > Number(referenceTransaction)) return;
      const blob = this.#blobs.get(id);
      if (!blob) return;
      if ([...this.#owners.values()].some(ids => ids.has(id))) return;
      if (blob.failed) throw Error('terminal-input-settlement-unknown');
      this.#deleting++;
      try {
        await this.#settle(blob);
        if (blob.index) await terminalPhysicalStep(this.capacity, bound, this.signal, async step => {
          if (!blob.identity) throw Error('terminal-input-identity-unavailable');
          await this.#files.unlink(`input/${id}`, blob.identity, step);
        });
        for (let remaining = allocated(blob.bytes); remaining > 0;) {
          const count = Math.min(1024 * 1024, remaining); await this.account.released('input', count); remaining -= count;
        }
        this.#blobs.delete(id); if (blob.pasteId) this.#pastes.delete(blob.pasteId);
        this.#unclaimed.delete(id);
        for (const [token, reference] of this.#handles) if (reference === id) this.#handles.delete(token);
      } catch (error) { blob.failed = true; throw error; }
      finally { this.#deleting--; }
    });
  }
  async close(): Promise<void> { this.#closing = true; await this.#referenceSerial; await this.#serial; await this.#spliceWork?.catch(() => {}); if (this.#ownsFiles) await this.#files.close(); }
  async #settle(blob: InputBlob): Promise<void> {
    if (!blob.reservation) return;
    await this.account.settle(blob.reservation.token, allocated(blob.bytes) - blob.reservation.start);
    blob.reservation = undefined;
  }
  #ready(id: string): InputBlob {
    const blob = this.#blobs.get(id);
    if (!blob || !blob.complete || blob.failed) throw Error('terminal-input-incomplete'); return blob;
  }
}
