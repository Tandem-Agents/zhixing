import { TERMINAL_LIMITS, type TerminalAction, type TerminalCandidateAcceptance } from './protocol.js';
import { TerminalPasteStream, type TerminalPasteSink } from './paste-stream.js';

export interface TerminalDraft { text: string; cursor: number; version: number }
interface Submission { readonly inputId: string; readonly version: number }
interface InputWindow { inputId: string; start: number; end: number; bytes: number; text: string; handles?: readonly { token: string; id: string; paste: boolean }[] }
interface DraftSnapshot { text: string; cursor: number; cold?: Omit<InputWindow, 'text'>; dirty: boolean; replacePastes?: string }
const EDIT_WINDOW_BYTES = 128 * 1024;
const COMPACT_WINDOW_BYTES = 48 * 1024;
const inputIdValid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/u.test(id);

/** Surface-owned edits; an application receipt can only settle its own version.
 * Paste uploads hold a visible marker so intervening edits remain independent. */
export class TerminalInputSession {
  readonly draft: TerminalDraft = { text: '', cursor: 0, version: 0 };
  readonly #pastes = new Map<string, string>();
  readonly #handles = new Map<string, { id: string; paste: boolean }>();
  readonly #completed = new Set<string>();
  #referenceWork?: Promise<void>;
  #referenceDirty = false; #referenceSignature = '';
  #referenceVersion = 0;
  #pasteBytes = 0;
  #saved?: DraftSnapshot;
  #cold?: Omit<InputWindow, 'text'>;
  #dirty = false;
  #replacePastes?: string;
  #document = 0;
  #persistWork?: Promise<{ inputId: string; version: number }>;
  #working?: DraftSnapshot & { inputId?: string };
  #paging = false;
  #preparing = false;
  #historyOffset = -1;
  #historyLoading = false;
  #historyEpoch = 0;
  #active = true;
  #submission?: Submission & { readonly text: string };
  #referenceError?: unknown;
  #marker = 0;
  constructor(readonly request: (action: TerminalAction) => Promise<unknown>, readonly changed: () => void) {}
  get pending(): boolean { return this.#preparing || !!this.#submission || this.#pastes.size > 0 || !!this.#persistWork || this.#paging || this.#historyLoading; }
  get windowStart(): number { return this.#cold?.start ?? 0; }
  get beforeWindow(): boolean { return this.windowStart > 0; }
  get afterWindow(): boolean { return !!this.#cold && this.#cold.end < this.#cold.bytes; }
  get completeWindow(): boolean { return !this.beforeWindow && !this.afterWindow; }
  clear(version: number): boolean {
    if (this.draft.version !== version) return false;
    this.#saved = undefined; this.#historyOffset = -1; this.#historyEpoch++;
    this.#cold = undefined; this.#dirty = false; this.#replacePastes = undefined; this.#document++;
    this.edit('', 0); this.changed(); return true;
  }
  activate(active: boolean): void {
    if (this.#active !== active) { this.#active = active; this.#historyEpoch++; }
  }
  edit(text: string, cursor: number): void {
    if (Buffer.byteLength(text) > EDIT_WINDOW_BYTES) throw Error('输入窗口正在保存，请稍后继续；已接纳的草稿保留。');
    if (text !== this.draft.text) { this.draft.text = text; this.draft.version++; this.#dirty = true; }
    this.draft.cursor = Math.max(0, Math.min(cursor, text.length));
    this.#syncReferences();
  }
  candidate(result: TerminalCandidateAcceptance, replace?: { start: number; end: number }): void {
    this.#registerHandles(result.handles ?? [], false);
    if (result.inputId) this.#completed.add(result.inputId);
    if (replace) {
      try { this.edit(this.draft.text.slice(0, replace.start) + result.text + this.draft.text.slice(replace.end), replace.start + result.text.length); this.changed(); }
      finally { this.#syncReferences(); }
    } else this.#syncReferences();
  }
  async submit(): Promise<void> {
    if (this.pending) throw Error('输入仍在处理，请稍候；草稿已保留。');
    if (this.completeWindow && !this.draft.text.trim()) return;
    this.#preparing = true;
    try {
      if (this.#referenceError && !this.#referenceWork) { this.#referenceSignature = '\0'; this.#syncReferences(); }
      await this.#referenceWork;
      if (this.#referenceError) throw Error('输入引用保留尚未确认，草稿已保留；请重新核对后再提交。');
      const frozenText = this.draft.text;
      // Every user submission has a distinct immutable identity, including a
      // resubmitted history entry. Its earlier history owner stays independent.
      const frozen = await this.#persist(true);
      const submission = { ...frozen, text: frozenText };
      this.#submission = submission; this.#syncReferences();
      await this.request({ kind: 'input-submit', inputId: submission.inputId, version: submission.version });
    } finally { this.#preparing = false; }
  }
  settle(result: Submission & { accepted: boolean }): boolean {
    if (this.#submission?.inputId !== result.inputId || this.#submission.version !== result.version) return false;
    this.#submission = undefined;
    if (result.accepted && this.draft.version === result.version) {
      this.clear(result.version);
    }
    else this.#syncReferences();
    return true;
  }
  paste(bytes: Uint8Array): Promise<void> {
    const paste = this.beginPaste(bytes.byteLength);
    paste.write(bytes); paste.end(); return paste.done;
  }
  beginPaste(expectedBytes?: number): TerminalPasteSink & { readonly done: Promise<void> } {
    if (this.#pastes.size >= 2) throw Error('前次粘贴仍在保存，原有草稿保留。');
    const stream = new TerminalPasteStream(bytes => {
      // The other 47.5 MiB cover both processes' reference metadata, editor,
      // parser and in-flight storage/transport pages in the shared J account.
      if (this.#pasteBytes + bytes + 47.5 * 1024 * 1024 > TERMINAL_LIMITS.inputHotBytes) throw Error('本次粘贴超过可用输入工作区，原有草稿保留。');
      this.#pasteBytes += bytes;
    }, bytes => { this.#pasteBytes -= bytes; });
    const inputId = crypto.randomUUID(), marker = `[粘贴处理中 · ${++this.#marker}]`;
    this.#pastes.set(inputId, marker);
    const cursor = this.draft.cursor;
    try { this.edit(this.draft.text.slice(0, cursor) + marker + this.draft.text.slice(cursor), cursor + marker.length); this.changed(); }
    catch (error) { this.#pastes.delete(inputId); stream.abort(); throw error; }
    const done = this.#consumePaste(inputId, marker, stream, expectedBytes);
    return { write: bytes => stream.write(bytes), end: () => stream.end(), abort: () => stream.abort(), done };
  }
  async #consumePaste(inputId: string, marker: string, stream: TerminalPasteStream, expectedBytes?: number): Promise<void> {
    try {
      await this.#upload(inputId, 'paste', decodePaste(stream), expectedBytes);
      const result = await this.request({ kind: 'paste-finish', inputId }) as { text?: unknown; handles?: readonly { token: string; id: string }[]; paste?: boolean; replacePastes?: boolean };
      if (typeof result?.text !== 'string' || result.text.length > 64 * 1024) throw Error('粘贴结果不可用，原有草稿保留。');
      this.#registerHandles(result.handles ?? [], !!result.paste);
      const applied = this.#replaceMarker(marker, result.text, !!result.replacePastes, inputId);
      if (applied && result.replacePastes && !this.completeWindow) {
        this.#replacePastes = inputId; this.#syncReferences();
        await this.#persistWork;
        await this.#persist();
      }
    } catch (error) { this.#replaceMarker(marker, ''); throw error; }
    finally { stream.abort(); this.#pastes.delete(inputId); this.#completed.add(inputId); this.#syncReferences(); }
  }
  async history(direction: -1 | 1): Promise<void> {
    if (this.pending || !this.#active) return;
    const next = this.#historyOffset + (direction < 0 ? 1 : -1);
    if (next < -1) return;
    if (next === -1) {
      const saved = this.#saved; this.#saved = undefined; this.#historyOffset = -1;
      if (saved) { this.#restore(saved); this.changed(); } return;
    }
    if (this.#historyOffset === -1) this.#saved = this.#snapshot();
    this.#historyLoading = true;
    const version = this.draft.version;
    const epoch = this.#historyEpoch;
    let ticket: string | undefined, restored = false;
    try {
      const result = await this.request({ kind: 'input-history', offset: next }) as { ticket?: unknown; inputId?: unknown; bytes?: unknown; end?: boolean };
      if (result.end) return;
      if (!inputIdValid(result.ticket) || !inputIdValid(result.inputId) || !Number.isSafeInteger(result.bytes) || (result.bytes as number) < 0) throw Error('历史输入未完整读取，原有草稿保留。');
      ticket = result.ticket;
      if (version !== this.draft.version || epoch !== this.#historyEpoch) return;
      const page = await this.#readWindow(result.inputId, result.bytes as number);
      if (page.bytes !== result.bytes) throw Error('历史输入大小不一致，原有草稿保留。');
      if (version !== this.draft.version || epoch !== this.#historyEpoch) return;
      this.#rememberHandles(page);
      this.#historyOffset = next; restored = true;
      this.#restore({ text: page.text, cursor: page.text.length, cold: this.#metadata(page), dirty: false }); this.changed();
      await this.#referenceWork;
    } finally {
      this.#historyLoading = false;
      if (!restored && this.#historyOffset === -1) this.#saved = undefined;
      if (ticket) await this.request({ kind: 'input-history-end', ticket });
    }
  }
  /** Save a growing hot window, then keep only the cursor neighbourhood. Edits
   * made during IO stay on the newly saved base and are never overwritten. */
  async compact(): Promise<void> {
    if (Buffer.byteLength(this.draft.text) < COMPACT_WINDOW_BYTES || this.pending) return;
    await this.#reframe();
  }
  async navigate(kind: 'left' | 'right' | 'up' | 'down' | 'backspace' | 'delete', moveVisualLine?: () => void): Promise<void> {
    if (this.pending) return;
    const direction = ['left', 'up', 'backspace'].includes(kind) ? -1 : 1;
    if (!(direction < 0 ? this.beforeWindow : this.afterWindow)) return;
    if (!await this.#reframe()) return;
    if ((kind === 'up' || kind === 'down') && moveVisualLine) { moveVisualLine(); return; }
    if (['left', 'right', 'backspace', 'delete'].includes(kind)) {
      if (this.atomic(kind as 'left' | 'right' | 'backspace' | 'delete')) return;
      const text = this.draft.text, at = this.draft.cursor;
      const previous = at - (at > 1 && /[\uDC00-\uDFFF]/u.test(text[at - 1]!) ? 2 : 1);
      const next = at + (/[\uD800-\uDBFF]/u.test(text[at] ?? '') ? 2 : 1);
      if (kind === 'left') this.edit(text, Math.max(0, previous));
      else if (kind === 'right') this.edit(text, Math.min(text.length, next));
      else if (kind === 'backspace' && at) this.edit(text.slice(0, previous) + text.slice(at), previous);
      else if (kind === 'delete') this.edit(text.slice(0, at) + text.slice(next), at);
    } else {
      const text = this.draft.text, at = this.draft.cursor;
      const line = text.lastIndexOf('\n', at - 1) + 1, column = at - line;
      const end = text.indexOf('\n', at);
      if (kind === 'up') {
        const previous = text.lastIndexOf('\n', line - 2) + 1;
        this.edit(text, line ? Math.min(line - 1, previous + column) : 0);
      } else this.edit(text, end < 0 ? text.length : Math.min(text.indexOf('\n', end + 1) < 0 ? text.length : text.indexOf('\n', end + 1), end + 1 + column));
    }
    this.changed();
  }
  async #reframe(): Promise<boolean> {
    const document = this.#document, epoch = this.#historyEpoch;
    const position = this.windowStart + Buffer.byteLength(this.draft.text.slice(0, this.draft.cursor));
    const version = this.draft.version;
    const oldCursor = this.draft.cursor;
    const frozen = await this.#persist();
    this.#paging = true;
    try {
      const page = await this.#readWindow(frozen.inputId, position);
      if (document !== this.#document || version !== this.draft.version || oldCursor !== this.draft.cursor || epoch !== this.#historyEpoch) return false;
      const cursor = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.from(page.text).subarray(0, position - page.start)).length;
      this.#rememberHandles(page);
      this.#restore({ text: page.text, cursor, cold: this.#metadata(page), dirty: false }); this.changed();
      return true;
    } finally { this.#paging = false; }
  }
  #snapshot(): DraftSnapshot { return { text: this.draft.text, cursor: this.draft.cursor, cold: this.#cold, dirty: this.#dirty, replacePastes: this.#replacePastes }; }
  #restore(snapshot: DraftSnapshot): void {
    this.#cold = snapshot.cold; this.#document++;
    this.draft.text = snapshot.text; this.draft.cursor = snapshot.cursor; this.draft.version++;
    this.#dirty = snapshot.dirty; this.#replacePastes = snapshot.replacePastes; this.#syncReferences();
  }
  #persist(force = false): Promise<{ inputId: string; version: number }> {
    if (this.#persistWork) return this.#persistWork;
    const snapshot = this.#snapshot(), version = this.draft.version, document = this.#document;
    const replacePastes = snapshot.replacePastes;
    if (!force && !replacePastes && snapshot.cold && !snapshot.dirty) return Promise.resolve({ inputId: snapshot.cold.inputId, version });
    this.#working = snapshot;
    const work = (async () => {
      const replacementId = crypto.randomUUID(), bytes = Buffer.byteLength(snapshot.text);
      await this.#upload(replacementId, 'draft', fragments(snapshot.text), bytes);
      let inputId: string = replacementId;
      let total = bytes, start = snapshot.cold?.start ?? 0, end = start + bytes;
      if (snapshot.cold) {
        const result = await this.request({ kind: 'input-splice', inputId: snapshot.cold.inputId, start: snapshot.cold.start, end: snapshot.cold.end, replacementId, ...(replacePastes ? { replacePastes } : {}) }) as { inputId?: unknown; bytes?: unknown; start?: unknown; end?: unknown };
        const expected = snapshot.cold.bytes - (snapshot.cold.end - snapshot.cold.start) + bytes;
        if (!inputIdValid(result.inputId) || !Number.isSafeInteger(result.bytes) || (replacePastes ? (result.bytes as number) < bytes || (result.bytes as number) > expected : result.bytes !== expected)) throw Error('输入保存结果未确认，原草稿保留。');
        if (replacePastes) {
          if (!Number.isSafeInteger(result.start) || !Number.isSafeInteger(result.end) || (result.start as number) < 0 || (result.end as number) > (result.bytes as number) || (result.end as number) - (result.start as number) !== bytes) throw Error('输入替换位置未确认，原草稿保留。');
          start = result.start as number; end = result.end as number;
        }
        inputId = result.inputId; total = result.bytes as number; this.#completed.add(replacementId);
      }
      this.#working = { ...snapshot, inputId };
      if (document === this.#document) {
        this.#cold = { inputId, start, end, bytes: total };
        this.#dirty = this.draft.text !== snapshot.text;
        if (this.#replacePastes === replacePastes) this.#replacePastes = undefined;
      }
      this.#completed.add(inputId); this.#syncReferences(); await this.#referenceWork;
      if (this.#referenceError) throw Error('输入引用保存未确认，原草稿保留。');
      return { inputId, version };
    })();
    return this.#persistWork = work.finally(() => { this.#working = undefined; this.#persistWork = undefined; this.#syncReferences(); });
  }
  async #readWindow(inputId: string, position: number): Promise<InputWindow> {
    const page = await this.request({ kind: 'input-window', inputId, position }) as InputWindow;
    if (page?.inputId !== inputId || ![page.start, page.end, page.bytes].every(Number.isSafeInteger) || page.start < 0 || page.end < page.start || page.end > page.bytes || position < page.start || position > page.end || typeof page.text !== 'string' || Buffer.byteLength(page.text) !== page.end - page.start || page.end - page.start > TERMINAL_LIMITS.textFragmentBytes) throw Error('输入窗口未完整读取，原草稿保留。');
    if (page.handles && (!Array.isArray(page.handles) || page.handles.length > 4096 || page.handles.some(handle => !inputIdValid(handle.id) || typeof handle.token !== 'string' || !handle.token.length || Buffer.byteLength(handle.token) > 1024 || !page.text.includes(handle.token) || typeof handle.paste !== 'boolean'))) throw Error('输入窗口引用未完整读取，原草稿保留。');
    return page;
  }
  #rememberHandles(page: InputWindow): void {
    this.#registerHandles(page.handles ?? []);
  }
  #registerHandles(handles: readonly { token: string; id: string; paste?: boolean }[], paste?: boolean): void {
    const added = new Set<string>();
    for (const handle of handles) {
      if (!inputIdValid(handle.id) || !handle.token.length || Buffer.byteLength(handle.token) > 1024) throw Error('输入引用不可用，原草稿保留。');
      if (!this.#handles.has(handle.token)) added.add(handle.token);
    }
    if (this.#handles.size + added.size > 4096) throw Error('输入引用工作区不足，原草稿保留；请重新核对后再试。');
    for (const handle of handles) this.#handles.set(handle.token, { id: handle.id, paste: paste ?? !!handle.paste });
  }
  #metadata({ inputId, start, end, bytes }: InputWindow): Omit<InputWindow, 'text'> { return { inputId, start, end, bytes }; }
  atomic(kind: 'backspace' | 'delete' | 'left' | 'right'): boolean {
    const cursor = this.draft.cursor;
    for (const token of [...this.#handles.keys(), ...this.#pastes.values()]) {
      for (let from = 0; from < this.draft.text.length;) {
        const start = this.draft.text.indexOf(token, from);
        if (start < 0) break;
        const end = start + token.length; from = end;
        if ((kind === 'backspace' || kind === 'left') ? cursor > start && cursor <= end : cursor >= start && cursor < end) {
          if (kind === 'left' || kind === 'right') this.edit(this.draft.text, kind === 'left' ? start : end);
          else this.edit(this.draft.text.slice(0, start) + this.draft.text.slice(end), start);
          this.changed(); return true;
        }
      }
    }
    return false;
  }
  #syncReferences(): void {
    const ids = this.#referencedIds();
    const signature = ids.join(',');
    if (signature === this.#referenceSignature && !this.#completed.size) return;
    this.#referenceDirty = true;
    if (this.#referenceWork) return;
    this.#referenceWork = (async () => {
      while (this.#referenceDirty) {
        this.#referenceDirty = false;
        const ids = this.#referencedIds();
        // Reconcile cached tokens even when the preceding collection reply
        // was lost. These IDs do not retain originals; N's owners decide that.
        // Excluding live IDs keeps their combined wire list at one per input.
        const live = new Set(ids);
        const cached = [...new Set([...this.#handles.values()].map(handle => handle.id))].filter(id => !live.has(id));
        const completed = [...this.#completed].slice(0, 4);
        // A reference change can occur without a text edit (working/saved
        // ownership, completion, retry). Give each transaction its own order.
        const result = await this.request({ kind: 'input-references', version: ++this.#referenceVersion, ids, completed, cached }) as { accepted?: boolean; removed?: readonly string[] } | undefined;
        if (result?.accepted === false) throw Error('输入引用保留尚未确认，草稿已保留。');
        for (const id of completed) this.#completed.delete(id);
        this.#referenceError = undefined;
        for (const id of result?.removed ?? []) for (const [token, handle] of this.#handles) if (handle.id === id) this.#handles.delete(token);
        this.#referenceSignature = ids.join(',');
        if (this.#completed.size) this.#referenceDirty = true;
      }
    })().finally(() => { this.#referenceWork = undefined; });
    void this.#referenceWork.catch(error => { this.#referenceError = error; });
  }
  #referencedIds(): string[] {
    return [...new Set([
      ...[this.#cold?.inputId, this.#replacePastes, this.#saved?.cold?.inputId, this.#saved?.replacePastes, this.#working?.cold?.inputId, this.#working?.inputId, this.#working?.replacePastes, this.#submission?.inputId].filter((id): id is string => !!id),
      ...[...this.#handles].filter(([token]) => this.draft.text.includes(token) || this.#saved?.text.includes(token) || this.#submission?.text.includes(token) || this.#working?.text.includes(token)).map(([, handle]) => handle.id),
    ])];
  }
  #replaceMarker(marker: string, text: string, replacePastes = false, newId?: string): boolean {
    let draft = this.draft.text, cursor = this.draft.cursor;
    if (!draft.includes(marker)) return false;
    if (replacePastes) for (const [token, handle] of this.#handles) if (handle.paste && handle.id !== newId) {
      for (let at = draft.indexOf(token); at >= 0; at = draft.indexOf(token)) {
        draft = draft.slice(0, at) + draft.slice(at + token.length);
        if (cursor > at) cursor -= Math.min(token.length, cursor - at);
      }
    }
    const start = draft.indexOf(marker);
    if (start < 0) return false;
    const end = start + marker.length;
    cursor = cursor <= start ? cursor : cursor < end ? start + text.length : cursor + text.length - marker.length;
    this.edit(draft.slice(0, start) + text + draft.slice(end), cursor); this.changed();
    return true;
  }
  async #upload(inputId: string, purpose: 'draft' | 'paste', parts: Iterable<string> | AsyncIterable<string>, bytes?: number): Promise<void> {
    await this.request({ kind: 'input-begin', inputId, purpose, bytes });
    let index = 0;
    for await (const text of parts) await this.request({ kind: 'input-part', inputId, index: index++, text, final: false });
    await this.request({ kind: 'input-part', inputId, index, text: '', final: true });
  }
}

function* fragments(text: string): Generator<string> {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 8192);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    yield text.slice(offset, end); offset = end;
  }
}
async function* decodePaste(pages: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for await (const page of pages) yield decoder.decode(page, { stream: true });
  const final = decoder.decode(); if (final) yield final;
}
