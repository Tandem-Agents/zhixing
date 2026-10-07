import type { TerminalAction, TerminalCandidateAcceptance, TerminalCandidates } from './protocol.js';
import type { TerminalInputSession } from './input-session.js';

/** One outstanding bounded query, one replaceable successor, and one visible
 * result. Async results never edit a different draft or cursor position. */
export class TerminalCandidateSession {
  value?: TerminalCandidates;
  selected = 0;
  busy = false;
  #deleteSignature?: string;
  get deleteArmed(): boolean { return this.#deleteSignature !== undefined; }
  resetDelete(): void { this.#deleteSignature = undefined; }
  confirmDelete(pageKey: number): boolean {
    const value = this.value, item = value?.items[this.selected], draft = this.input.draft;
    if (!value?.canDelete || value.mode !== 'picker' || !item || this.busy) return false;
    const signature = JSON.stringify([pageKey, value.revision, item.id, draft.version, draft.cursor]);
    if (this.#deleteSignature === signature) { this.#deleteSignature = undefined; return true; }
    this.#deleteSignature = signature; return false;
  }
  async manage(action: 'delete' | 'rename' | 'create'): Promise<void> {
    const value = this.value, item = value?.items[this.selected];
    if (!value || value.mode !== 'picker' || this.busy || (action !== 'create' && !item) ||
        !(action === 'create' ? value.canCreate : action === 'rename' ? value.canRename : value.canDelete)) return;
    this.resetDelete(); this.busy = true; this.changed();
    try { await this.request({ kind: 'candidate-manage', revision: value.revision, action, ...(item ? { id: item.id } : {}) }); }
    finally { this.busy = false; this.changed(); }
  }
  #revision = 0;
  #signature = '';
  #pending?: { version: number; cursor: number; text: string; offset: number; revision: number };
  #snapshot?: { version: number; cursor: number; offset: number };
  #running = false;
  #accepting = false;
  #active = true;
  constructor(readonly input: TerminalInputSession, readonly request: (action: TerminalAction) => Promise<unknown>, readonly changed: () => void) {}
  sync(active = true): void {
    this.#active = active;
    const draft = this.input.draft, signature = `${draft.version}:${draft.cursor}:${active}`;
    if (signature === this.#signature) return;
    this.resetDelete();
    this.#signature = signature;
    this.value = undefined; this.#snapshot = undefined; this.selected = 0; this.changed();
    const revision = ++this.#revision;
    if (!active || this.#accepting) { this.#pending = undefined; return; }
    // Bound the provider workspace independently from retained original input.
    // Keep enough surrounding text to reject a cut token, and preserve UTF-16 pairs.
    let offset = Math.max(0, draft.cursor - 4096), end = Math.min(draft.text.length, draft.cursor + 4096);
    if (offset && /[\uDC00-\uDFFF]/u.test(draft.text[offset]!)) offset++;
    if (end < draft.text.length && /[\uDC00-\uDFFF]/u.test(draft.text[end]!)) end--;
    const text = draft.text.slice(offset, end);
    this.#pending = { version: draft.version, cursor: draft.cursor, text, offset, revision };
    if (/^\/trust\s/u.test(text)) {
      this.value = { revision, start: text.length, end: text.length, mode: 'management', items: [], hint: 'Esc 返回 · 正在读取信任规则' };
      this.#snapshot = this.#pending; this.changed();
    }
    void this.#drain();
  }
  dismiss(): void {
    this.resetDelete();
    ++this.#revision; this.#pending = undefined; this.value = undefined; this.#snapshot = undefined; this.changed();
  }
  refresh(): void { this.#signature = ''; this.sync(this.#active); }
  escape(): void {
    const value = this.value, snapshot = this.#snapshot;
    const draft = this.input.draft;
    if (value?.items.length && snapshot && draft.version === snapshot.version && draft.cursor === snapshot.cursor && value.end > value.start) {
      this.input.candidate({ text: '', execute: false }, { start: value.start + snapshot.offset, end: value.end + snapshot.offset });
      this.sync(this.#active);
    } else { this.input.clear(draft.version); this.dismiss(); }
  }
  async revoke(revision: number, id: string): Promise<string | undefined> {
    const value = this.value, snapshot = this.#snapshot;
    if (!value || !snapshot || value.mode !== 'management' || value.revision !== revision || !value.items.some(item => item.id === id) || this.busy) return;
    this.busy = true; this.changed();
    try {
      const result = await this.request({ kind: 'candidate-revoke', revision, id }) as { message?: unknown };
      if (this.value !== value || !this.#active || this.input.draft.version !== snapshot.version || this.input.draft.cursor !== snapshot.cursor) return;
      this.refresh();
      return typeof result?.message === 'string' ? result.message.slice(0, 2048) : '撤销结果尚未确认，请刷新。';
    } catch (error) {
      if (this.value === value && this.#active) {
        this.value = { ...value, error: error instanceof Error ? error.message.slice(0, 2048) : '撤销未完成，请刷新后重试。' };
        return this.value.error;
      }
    } finally { this.busy = false; this.changed(); }
  }
  move(direction: -1 | 1): void {
    this.resetDelete();
    if (!this.value) return;
    this.selected = Math.max(0, Math.min(this.value.items.length - 1, this.selected + direction)); this.changed();
  }
  async accept(): Promise<boolean> {
    const value = this.value, snapshot = this.#snapshot, item = value?.items[this.selected];
    if (!item || !value || !snapshot || value.mode === 'management' || this.#accepting) return false;
    this.#accepting = true; this.dismiss();
    try {
      const result = await this.request({ kind: 'candidate-accept', revision: value.revision, id: item.id }) as TerminalCandidateAcceptance;
      if (typeof result?.text !== 'string' || result.text.length > 32 * 1024) throw Error('补全结果不可用，草稿保留。');
      const current = this.#active && this.input.draft.version === snapshot.version && this.input.draft.cursor === snapshot.cursor;
      this.input.candidate(result, current ? { start: value.start + snapshot.offset, end: value.end + snapshot.offset } : undefined);
      return current && result.execute;
    } finally {
      this.#accepting = false;
      // A file/directory completion may open its successor. A command will be
      // submitted by the caller before this microtask reaches the next query.
      this.#signature = ''; queueMicrotask(() => this.sync(this.#active));
    }
  }
  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#pending) {
        const query = this.#pending; this.#pending = undefined;
        // Preserve management ownership while loading, including an empty list.
        if (/^\/trust\s/u.test(query.text)) {
          this.value = { revision: query.revision, start: query.text.length, end: query.text.length,
            mode: 'management', items: [], hint: '正在读取信任规则 · Esc 返回' };
          this.#snapshot = query; this.changed();
        }
        try {
          const result = await this.request({ kind: 'input-candidates', revision: query.revision, text: query.text, cursor: query.cursor - query.offset }) as TerminalCandidates;
          if (query.revision !== this.#revision || !this.#active) continue;
          if (result.revision !== query.revision || !Array.isArray(result.items) || result.items.length > 100 ||
            result.start < 0 || result.end < result.start || result.end > query.text.length || ((query.offset > 0 || this.input.windowStart > 0) && result.start === 0)) continue;
          this.value = result; this.#snapshot = query; this.changed();
        } catch (error) {
          if (query.revision === this.#revision && this.#active && this.value?.mode === 'management') {
            this.value = { ...this.value, items: [], error: error instanceof Error ? error.message.slice(0, 2048) : '规则读取失败，请刷新。' };
            this.changed();
          }
        }
      }
    } finally { this.#running = false; }
  }
}
