import { normalizeLeadingSlashAlias, type TerminalAction, type TerminalCandidateAcceptance, type TerminalCandidates } from './protocol.js';
import type { TerminalInputSession } from './input-session.js';

/** One outstanding bounded query, one replaceable successor, and one visible
 * result. Async results never edit a different draft or cursor position. */
export class TerminalCandidateSession {
  value?: TerminalCandidates;
  selected = 0;
  busy = false;
  open = false;
  loading = false;
  error?: string;
  #deleteSignature?: string;
  get deleteArmed(): boolean { return this.#deleteSignature !== undefined; }
  // 准备删除的状态决定选中项是否显示为危险态：进入与解除都要通知界面重算，否则红底不出现或不消失
  resetDelete(): void { if (this.#deleteSignature === undefined) return; this.#deleteSignature = undefined; this.changed(); }
  confirmDelete(pageKey: number): boolean {
    const value = this.value, item = value?.items[this.selected], draft = this.input.draft;
    if (!value?.canDelete || value.mode !== 'picker' || !item || this.busy) return false;
    const signature = JSON.stringify([pageKey, value.revision, item.id, draft.version, draft.cursor]);
    if (this.#deleteSignature === signature) { this.#deleteSignature = undefined; this.changed(); return true; }
    this.#deleteSignature = signature; this.changed(); return false;
  }
  /** 返回删除是否完成（只对删除有意义）；删除结束后按新状态重新取候选。 */
  async manage(action: 'delete' | 'rename' | 'create'): Promise<boolean> {
    const value = this.value, item = value?.items[this.selected];
    if (!value || value.mode !== 'picker' || this.busy || (action !== 'create' && !item) ||
        !(action === 'create' ? value.canCreate : action === 'rename' ? value.canRename : value.canDelete)) return false;
    this.resetDelete(); this.busy = true; this.changed();
    // 管理之后列表会按新状态重取：改名回到原项，删除停在原位置（同一份草稿的下一次结果才恢复）
    if (action !== 'create') this.#restore = { version: this.input.draft.version, index: this.selected, ...(action === 'rename' ? { id: item!.id } : {}) };
    try {
      const reply = await this.request({ kind: 'candidate-manage', revision: value.revision, action, ...(item ? { id: item.id } : {}) }) as { deleted?: unknown } | undefined;
      if (action !== 'delete') return false;
      if (this.value === value && this.#active) this.refresh();
      return reply?.deleted === true;
    } finally { this.busy = false; this.changed(); }
  }
  #restore?: { version: number; index: number; id?: string };
  #revision = 0;
  #signature = '';
  #pending?: { version: number; cursor: number; text: string; offset: number; revision: number; atStart: boolean };
  #snapshot?: { version: number; cursor: number; offset: number };
  #running = false;
  #accepting = false;
  /** 每次接纳一个令牌；作废时递增，在途接纳据此判定自己已经作废 */
  #acceptToken = 0;
  #active = true;
  constructor(readonly input: TerminalInputSession, readonly request: (action: TerminalAction) => Promise<unknown>, readonly changed: () => void) {}
  /**
   * 作废在途的接纳：迟到的应答不改草稿、不执行、不报错；接纳锁立即解除，下一次同步照常查询，
   * 用户不必等旧应答回来就能继续操作。离开主输入（sync(false)）时同样作废。
   */
  cancelAccept(): void {
    if (!this.#accepting) return;
    this.#acceptToken++; this.#accepting = false; this.#signature = '';
  }
  sync(active = true): void {
    if (!active) this.cancelAccept();
    this.#active = active;
    const draft = this.input.draft, signature = `${draft.version}:${draft.cursor}:${active}`;
    if (signature === this.#signature) return;
    this.resetDelete();
    this.#signature = signature;
    this.value = undefined; this.#snapshot = undefined; this.selected = 0;
    this.open = active && !this.#accepting && !!draft.text && (this.open || /^[/／]/u.test(draft.text));
    this.loading = active && !this.#accepting && !!draft.text;
    this.error = undefined; this.changed();
    const revision = ++this.#revision;
    if (!active || this.#accepting) { this.#pending = undefined; return; }
    // Bound the provider workspace independently from retained original input.
    // Keep enough surrounding text to reject a cut token, and preserve UTF-16 pairs.
    let offset = Math.max(0, draft.cursor - 4096), end = Math.min(draft.text.length, draft.cursor + 4096);
    if (offset && /[\uDC00-\uDFFF]/u.test(draft.text[offset]!)) offset++;
    if (end < draft.text.length && /[\uDC00-\uDFFF]/u.test(draft.text[end]!)) end--;
    const text = draft.text.slice(offset, end);
    const atStart = offset === 0 && this.input.windowStart === 0;
    this.#pending = { version: draft.version, cursor: draft.cursor, text, offset, revision, atStart };
    if (/^\/trust\s/u.test(atStart ? normalizeLeadingSlashAlias(text) : text)) {
      this.value = { revision, start: text.length, end: text.length, mode: 'management', items: [], hint: ['Esc 返回', '正在读取信任规则'] };
      this.#snapshot = this.#pending; this.changed();
    }
    void this.#drain();
  }
  dismiss(): void {
    // 收起即认定当前草稿已处理：草稿不变就不因后续同步重新打开（作废接纳会清空签名，这里补回）
    const draft = this.input.draft; this.#signature = `${draft.version}:${draft.cursor}:${this.#active}`;
    this.resetDelete(); this.#restore = undefined;
    this.open = false; this.loading = false; this.error = undefined;
    ++this.#revision; this.#pending = undefined; this.value = undefined; this.#snapshot = undefined; this.changed();
  }
  refresh(): void { this.#signature = ''; this.sync(this.#active); }
  /**
   * 候选打开时 Esc 只收起候选，草稿原样保留（再按一次 Esc 才是清空）；收起后草稿不变就不
   * 重新打开，继续输入才再查询。/trust 管理面板是独立的管理视图：先删掉面板里的查询词，
   * 再按一次返回主输入。
   */
  escape(): void {
    const value = this.value, snapshot = this.#snapshot;
    const draft = this.input.draft;
    if (value?.mode !== 'management') { this.dismiss(); return; }
    if (value.items.length && snapshot && draft.version === snapshot.version && draft.cursor === snapshot.cursor && value.end > value.start) {
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
  /** 按方向移动选中项；翻页时 step 为一页的条数，选中项随页移动，Enter 总作用于看得见的那一项。 */
  move(direction: -1 | 1, step = 1): void {
    this.resetDelete();
    if (!this.value) return;
    this.selected = Math.max(0, Math.min(this.value.items.length - 1, this.selected + direction * step)); this.changed();
  }
  async accept(ghost = false): Promise<boolean> {
    const value = this.value, snapshot = this.#snapshot, item = value?.items[this.selected];
    if (!value || !snapshot || (ghost ? !value.ghost : !item) || value.mode === 'management' || this.#accepting) return false;
    const token = ++this.#acceptToken;
    this.#accepting = true; this.dismiss();
    try {
      const result = await this.request(ghost ? { kind: 'candidate-ghost', revision: value.revision } : { kind: 'candidate-accept', revision: value.revision, id: item!.id }) as TerminalCandidateAcceptance;
      if (typeof result?.text !== 'string' || result.text.length > 32 * 1024) throw Error('补全结果不可用，草稿保留。');
      // 已作废的接纳只登记应答带来的引用，不改草稿、不执行
      const current = token === this.#acceptToken && this.#active && this.input.draft.version === snapshot.version && this.input.draft.cursor === snapshot.cursor;
      this.input.candidate(result, current ? { start: value.start + snapshot.offset, end: value.end + snapshot.offset } : undefined);
      return !ghost && current && result.execute;
    } catch (error) {
      if (token !== this.#acceptToken) return false;
      throw error;
    } finally {
      // 已作废的接纳不碰锁与查询：此时可能已有更新的接纳或查询在进行
      if (token === this.#acceptToken) {
        this.#accepting = false;
        // A file/directory completion may open its successor. A command will be
        // submitted by the caller before this microtask reaches the next query.
        this.#signature = ''; queueMicrotask(() => this.sync(this.#active));
      }
    }
  }
  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#pending) {
        const query = this.#pending; this.#pending = undefined;
        // Preserve management ownership while loading, including an empty list.
        if (/^\/trust\s/u.test(query.atStart ? normalizeLeadingSlashAlias(query.text) : query.text)) {
          this.value = { revision: query.revision, start: query.text.length, end: query.text.length,
            mode: 'management', items: [], hint: ['正在读取信任规则', 'Esc 返回'] };
          this.#snapshot = query; this.changed();
        }
        try {
          const result = await this.request({ kind: 'input-candidates', revision: query.revision, text: query.text, cursor: query.cursor - query.offset, atStart: query.atStart }) as TerminalCandidates;
          if (query.revision !== this.#revision || !this.#active) continue;
          if (result.revision !== query.revision || !Array.isArray(result.items) || result.items.length > 100 ||
            !Number.isSafeInteger(result.start) || !Number.isSafeInteger(result.end) || result.start < 0 || result.end < result.start || result.end > query.text.length || ((query.offset > 0 || this.input.windowStart > 0) && result.start === 0)) throw Error('terminal-candidate-result');
          if ((result.ghost !== undefined && (typeof result.ghost?.fullValue !== 'string' || !result.ghost.fullValue || Buffer.byteLength(result.ghost.fullValue) > 4096)) ||
              (result.argumentHint !== undefined && (typeof result.argumentHint !== 'string' || Buffer.byteLength(result.argumentHint) > 4096)) ||
              (result.hint !== undefined && (!Array.isArray(result.hint) || result.hint.length > 8 || !result.hint.every(item => typeof item === 'string' && item.length > 0 && Buffer.byteLength(item) <= 256)))) throw Error('terminal-candidate-result');
          this.value = result; this.#snapshot = query;
          const restore = this.#restore; this.#restore = undefined;
          if (restore?.version === query.version && result.items.length) {
            const found = restore.id === undefined ? -1 : result.items.findIndex(item => item.id === restore.id);
            this.selected = found >= 0 ? found : Math.min(restore.index, result.items.length - 1);
          }
          this.open = result.active ?? !!(result.items.length || result.mode || result.argumentHint);
          this.loading = false; this.changed();
        } catch (error) {
          if (query.revision === this.#revision && this.#active) {
            this.loading = false;
            this.error = '候选读取未完成 · Ctrl+R 重试'; this.changed();
          }
          if (query.revision === this.#revision && this.#active && this.value?.mode === 'management') {
            this.value = { ...this.value, items: [], error: error instanceof Error ? error.message.slice(0, 2048) : '规则读取失败，请刷新。' };
            this.changed();
          }
        }
      }
    } finally { this.#running = false; }
  }
}
