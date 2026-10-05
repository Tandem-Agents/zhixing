import type { TerminalAction, TerminalCandidateAcceptance, TerminalCandidates } from './protocol.js';
import type { TerminalInputSession } from './input-session.js';

/** One outstanding bounded query, one replaceable successor, and one visible
 * result. Async results never edit a different draft or cursor position. */
export class TerminalCandidateSession {
  value?: TerminalCandidates;
  selected = 0;
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
    void this.#drain();
  }
  dismiss(): void {
    ++this.#revision; this.#pending = undefined; this.value = undefined; this.#snapshot = undefined; this.changed();
  }
  move(direction: -1 | 1): void {
    if (!this.value) return;
    this.selected = Math.max(0, Math.min(this.value.items.length - 1, this.selected + direction)); this.changed();
  }
  async accept(): Promise<boolean> {
    const value = this.value, snapshot = this.#snapshot, item = value?.items[this.selected];
    if (!item || !value || !snapshot || this.#accepting) return false;
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
        try {
          const result = await this.request({ kind: 'input-candidates', revision: query.revision, text: query.text, cursor: query.cursor - query.offset }) as TerminalCandidates;
          if (query.revision !== this.#revision || !this.#active) continue;
          if (result.revision !== query.revision || !Array.isArray(result.items) || result.items.length > 100 ||
            result.start < 0 || result.end < result.start || result.end > query.text.length || ((query.offset > 0 || this.input.windowStart > 0) && result.start === 0)) continue;
          this.value = result; this.#snapshot = query; this.changed();
        } catch { /* A failed optional query leaves ordinary input available. */ }
      }
    } finally { this.#running = false; }
  }
}
