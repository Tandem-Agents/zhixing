/** Pure keyboard intent reducer for the existing root's management candidates.
 * No renderer, input subscription, draft, RPC or trust rule lives here. */
export interface TrustCandidateSnapshot {
  readonly mode?: 'picker' | 'management';
  readonly revision: number;
  readonly items: readonly { readonly id: string }[];
  readonly selected: number;
  readonly draftVersion: number;
  readonly cursor: number;
  readonly pageKey: string | number;
  readonly canDelete: boolean;
  readonly busy?: boolean;
  readonly error?: string;
  readonly safe: boolean;
}
export interface TrustCandidateKey { readonly name: string; readonly ctrl?: boolean; readonly meta?: boolean; readonly shift?: boolean }
export type TrustCandidateIntent =
  | { readonly kind: 'unhandled' }
  | { readonly kind: 'none'; readonly message?: string }
  | { readonly kind: 'move'; readonly direction: -1 | 1; readonly page?: boolean }
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'armed'; readonly id: string; readonly message: string }
  | { readonly kind: 'revoke'; readonly revision: number; readonly id: string };

export class TerminalTrustCandidateControls {
  #signature = '';
  #armed?: string;
  get armedId(): string | undefined { return this.#armed; }

  /** Call on result, selection, draft/cursor and page changes (including paste).
   * A true return asks the root to clear the old transient confirmation hint. */
  sync(snapshot: TrustCandidateSnapshot): boolean {
    const selected = snapshot.items[snapshot.selected]?.id;
    const signature = JSON.stringify([snapshot.mode, snapshot.revision, snapshot.draftVersion, snapshot.cursor,
      snapshot.pageKey, selected, snapshot.canDelete, !!snapshot.busy, snapshot.error, snapshot.safe]);
    if (signature === this.#signature) return false;
    const wasArmed = this.#armed !== undefined;
    this.#signature = signature; this.#armed = undefined;
    return wasArmed;
  }
  reset(): void { this.#signature = ''; this.#armed = undefined; }

  key(snapshot: TrustCandidateSnapshot, key: TrustCandidateKey): TrustCandidateIntent {
    this.sync(snapshot);
    if (snapshot.mode !== 'management') return { kind: 'unhandled' };
    const name = key.name.toLowerCase();
    if (name === 'escape') { this.reset(); return { kind: 'dismiss' }; }
    // Even an empty/error/too-small management panel owns Enter and Tab.
    // Returning unhandled here would submit the untouched /trust draft.
    if (name === 'return' || name === 'enter' || name === 'tab') {
      this.#armed = undefined; return { kind: 'none' };
    }
    if (key.ctrl && !key.meta && !key.shift && name === 'd') {
      if (!snapshot.safe) { this.#armed = undefined; return { kind: 'none', message: '请放大窗口后撤销；Esc 返回。' }; }
      const item = snapshot.items[snapshot.selected];
      if (snapshot.busy || snapshot.error || !snapshot.canDelete || !item) {
        this.#armed = undefined; return { kind: 'none', message: snapshot.busy ? '正在撤销，请稍候。' : '没有可撤销的已核实规则，请刷新列表。' };
      }
      if (this.#armed === item.id) {
        this.#armed = undefined; return { kind: 'revoke', revision: snapshot.revision, id: item.id };
      }
      this.#armed = item.id;
      return { kind: 'armed', id: item.id, message: '再次按 Ctrl+D 撤销当前规则；其他按键取消准备。' };
    }
    this.#armed = undefined;
    if (!key.ctrl && !key.meta && !key.shift && ['up', 'down', 'pageup', 'pagedown'].includes(name)) {
      if (!snapshot.safe) return { kind: 'none', message: '请放大窗口后浏览；Esc 返回。' };
      return { kind: 'move', direction: name === 'up' || name === 'pageup' ? -1 : 1,
        ...(name === 'pageup' || name === 'pagedown' ? { page: true } : {}) };
    }
    return { kind: 'unhandled' };
  }
}
