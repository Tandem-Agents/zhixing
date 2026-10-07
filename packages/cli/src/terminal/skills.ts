import { randomUUID } from 'node:crypto';
import type { SkillCatalogClient } from '@zhixing/core/skills/catalog';
import { SKILLS_PAGE_DEFAULT, skillsDisplayText, validateSkillsAction, type TerminalSkillsAction, type TerminalSkillsView } from '@zhixing/terminal-ui/skills-model';
import { SkillManagerController } from '../skills/manager-controller.js';

/** A single page lifetime. The controller and client retain Catalog semantics;
 * this owner only projects selection, finite pages and recoverable outcomes. */
export class TerminalSkillsOwner {
  readonly #sessionId = randomUUID();
  readonly #controller: SkillManagerController;
  readonly #closed: Promise<void>;
  #resolve!: () => void;
  #reject!: (error: unknown) => void;
  #unsubscribe?: () => void;
  #opened = false;
  #done = false;
  #revision = 0;
  #pageSize = SKILLS_PAGE_DEFAULT;
  #busy = false;
  #fresh = false;
  #message?: string;
  #state: TerminalSkillsView['state'] = 'loading';
  #operation?: Promise<void>;
  #refreshAgain = false;
  #resizeAgain = false;
  #committed = false;

  constructor(readonly options: {
    client: SkillCatalogClient;
    publish(view: TerminalSkillsView): Promise<void>;
    refreshCommands(): Promise<void> | void;
    signal: AbortSignal;
  }) {
    this.#closed = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    this.#controller = new SkillManagerController({
      query: query => { this.#ensureOpen(); return options.client.query(query); },
      command: async command => {
        this.#ensureOpen(); await options.client.command(command); this.#committed = true;
      },
      onFact: handler => options.client.onFact(handler),
    });
  }

  /** Resolves on page exit, without waiting for an already issued domain write. */
  open(): Promise<void> {
    if (this.#opened || this.#done) return this.#closed;
    this.#opened = true;
    this.options.signal.addEventListener('abort', this.close, { once: true });
    if (this.options.signal.aborted) { this.close(); return this.#closed; }
    try {
      this.#unsubscribe = this.options.client.onFact(() => {
        if (this.#done) return;
        if (this.#operation) this.#refreshAgain = true;
        else void this.#run(() => this.#reload(), false);
      });
      void this.#run(() => this.#reload(), false);
    } catch (error) { this.#finish(error); }
    return this.#closed;
  }

  /** At most one action is active. Resize and Fact invalidation each retain one
   * latest value; no queued keypress may later mutate a different selection. */
  async act(action: TerminalSkillsAction): Promise<boolean> {
    if (!validateSkillsAction(action)) throw Error('terminal-skills-action');
    if (this.#done || !this.#opened || action.sessionId !== this.#sessionId) return false;
    if (action.kind === 'cancel') { this.close(); return true; }
    if (action.kind === 'resize') {
      if (action.revision > this.#revision) return false;
      if (this.#pageSize === action.pageSize) return true;
      this.#pageSize = action.pageSize;
      if (this.#operation) this.#resizeAgain = true;
      else await this.#run(async () => {}, false, false);
      return true;
    }
    if (action.revision !== this.#revision) return false;
    if (this.#operation) {
      if (action.kind === 'refresh') this.#refreshAgain = true;
      return false;
    }
    if (action.kind === 'refresh') { await this.#run(() => this.#reload(), true); return true; }
    if (action.kind === 'move') {
      await this.#run(async () => {
        const current = this.#controller.view();
        const count = action.page ? Math.min(this.#pageSize, action.direction < 0 ? current.selectedIndex : current.items.length - current.selectedIndex - 1) : 1;
        for (let index = 0; index < count; index++) action.direction < 0 ? this.#controller.moveUp() : this.#controller.moveDown();
      }, false, false);
      return true;
    }
    const current = this.#controller.view();
    if (!this.#fresh || current.items[current.selectedIndex]?.id !== action.skillId) return false;
    await this.#run(async () => {
      switch (action.kind) {
        case 'pin': await this.#controller.togglePin(); break;
        case 'disable': await this.#controller.toggleDisabled(); break;
        case 'mode': await this.#controller.cycleMode(); break;
        case 'archive': await this.#controller.archiveSelected(); break;
      }
      this.#fresh = true; this.#state = 'ready';
      this.#message = '变更已保存。';
    }, true);
    return true;
  }

  readonly close = (): void => { this.#finish(); };

  #ensureOpen(): void {
    if (this.#done || this.options.signal.aborted) throw Error('terminal-skills-closed');
  }

  async #reload(): Promise<void> {
    const previous = this.#controller.view(), selectedId = previous.items[previous.selectedIndex]?.id;
    await this.#controller.load(); this.#ensureOpen();
    const current = this.#controller.view(), next = current.items.findIndex(item => item.id === selectedId);
    if (next >= 0) {
      const delta = next - current.selectedIndex;
      for (let index = 0; index < Math.abs(delta); index++) delta < 0 ? this.#controller.moveUp() : this.#controller.moveDown();
    }
    this.#fresh = true; this.#state = 'ready'; this.#message = undefined;
  }

  #run(operation: () => Promise<void>, refreshCommands: boolean, showBusy = true): Promise<void> {
    if (this.#done) return Promise.resolve();
    this.#busy = true;
    const work = (async () => {
      if (showBusy) await this.#publish();
      if (this.#done) return;
      this.#committed = false;
      try { await operation(); }
      catch {
        if (!this.#done) {
          this.#fresh = false; this.#state = 'error';
          this.#message = this.#committed ? '变更已保存，但列表刷新失败；按 r 重新读取。' : '技能操作或读取未完成；按 r 重新读取后再操作。';
        }
      }
      // A submitted write is never undone by closing this page. Even a failed
      // post-write query must refresh commands from the same authoritative client.
      if ((refreshCommands || this.#committed) && !this.options.signal.aborted) {
        try { await this.options.refreshCommands(); }
        catch { if (!this.#done) this.#message = `${this.#committed ? '变更已保存。' : ''}技能命令刷新失败；按 r 重试。`; }
      }
      if (!this.#done) { this.#busy = false; await this.#publish(); }
    })().catch(error => { this.#finish(error); }).finally(() => {
      if (this.#operation === work) this.#operation = undefined;
      if (this.#refreshAgain && !this.#done) {
        this.#refreshAgain = false; void this.#run(() => this.#reload(), false);
      } else if (this.#resizeAgain && !this.#done) {
        this.#resizeAgain = false; void this.#run(async () => {}, false, false);
      }
    });
    this.#operation = work; return work;
  }

  async #publish(): Promise<void> {
    if (this.#done) return;
    this.#resizeAgain = false;
    const view = this.#controller.view(), selected = view.selectedIndex;
    const offset = selected < 0 ? 0 : Math.floor(selected / this.#pageSize) * this.#pageSize;
    await this.options.publish({
      sessionId: this.#sessionId, revision: ++this.#revision, state: this.#state, busy: this.#busy,
      message: this.#message, total: view.items.length, selectedIndex: selected, selectedId: view.items[selected]?.id,
      pageSize: this.#pageSize, offset,
      items: view.items.slice(offset, offset + this.#pageSize).map(item => ({
        id: item.id, name: skillsDisplayText(item.name.slice(0, 480)),
        description: skillsDisplayText(item.description.length > 1024 ? `${item.description.slice(0, 1023)}…` : item.description),
        pinned: item.pinned, disabled: item.disabled, mode: item.mode, source: item.source, hitCount: item.usage?.hitCount ?? null,
      })),
    });
  }

  #finish(error?: unknown): void {
    if (this.#done) return;
    this.#done = true; this.#refreshAgain = false; this.#resizeAgain = false;
    this.options.signal.removeEventListener('abort', this.close);
    this.#unsubscribe?.(); this.#unsubscribe = undefined;
    if (error === undefined) this.#resolve(); else this.#reject(error);
  }
}
