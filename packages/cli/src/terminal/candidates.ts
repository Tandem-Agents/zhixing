import { ArgumentProvider, CommandProvider, DefaultCommandRegistry, FileProvider, type CommandDef, type SuggestionItem, type SuggestionProvider, type RuntimeContext } from '@zhixing/core/typeahead';
import type { TerminalTrustCandidates } from './trust-candidates.js';
import type { TerminalCandidates } from '@zhixing/terminal-ui/protocol';
import { BUILTIN_COMMANDS } from '../commands/builtin-definitions.js';
import { createInputHandleTokenPatterns } from '../input-handle-tokens.js';

/** Commands delivered in this migration unit. Other command ownership stays in
 * the same catalog, without exposing an inoperative candidate. */
const available = new Set(['help', 'status', 'stop', 'config', 'mcp', 'skills', 'exit', 'trust', 'security', 'advancement', 'resolve', 'tasklist', 'task', 'tasks', 'model', 'usage', 'context', 'compact']);
interface CandidateQuery { revision: number; abort: AbortController; items: readonly SuggestionItem[]; command?: 'resume' | 'work' }

export class TerminalCandidatesOwner {
  readonly registry = new DefaultCommandRegistry();
  readonly #providers: readonly SuggestionProvider[];
  #query?: CandidateQuery;
  #trust?: TerminalTrustCandidates;
  bindCommands(commands: readonly CommandDef[]): void {
    for (const command of commands) { this.registry.unregister(command.id); this.registry.register(command); }
  }
  bindTrust(trust: TerminalTrustCandidates): void {
    this.#trust = trust;
    this.registry.unregister(trust.command.id);
    this.registry.register(trust.command);
  }
  async revokeTrust(revision: number, id: string): Promise<{ revoked: boolean; message: string }> {
    if (!this.#trust || this.#query?.revision !== revision || this.#query.abort.signal.aborted || !this.#query.items.some(item => item.id === id)) throw Error('候选已失效，请刷新。');
    return this.#trust.revoke(revision, id);
  }
  manage(revision: number, action: 'delete' | 'rename' | 'create', id?: string): { command: 'resume' | 'work'; value?: string } {
    const query = this.#query;
    if (!query || query.revision !== revision || query.abort.signal.aborted || !query.command) throw Error('候选已失效，请刷新。');
    if (action !== 'delete' && query.command !== 'work') throw Error('此候选不支持该操作。');
    const item = query.items.find(item => item.id === id), value = item?.acceptPayload.metadata?.argValue;
    if (action !== 'create' && (!item || item.providerId !== 'argument' || item.acceptPayload.metadata?.commandId !== `${query.command}:repl` || typeof value !== 'string')) throw Error('候选身份不匹配。');
    const result = { command: query.command, ...(typeof value === 'string' ? { value } : {}) };
    query.abort.abort(); return result;
  }
  constructor(readonly runtime: () => RuntimeContext) {
    for (const definition of Object.values(BUILTIN_COMMANDS)) if (available.has(definition.name)) this.registry.register(definition);
    this.#providers = [new CommandProvider({ registry: this.registry }), new ArgumentProvider({ registry: this.registry }), new FileProvider({ root: () => runtime().cwd, maxResults: 100, maxResultBytes: 96 * 1024 })]
      .sort((left, right) => left.priority - right.priority);
  }
  async query(revision: number, text: string, cursor: number): Promise<TerminalCandidates> {
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 ||
      !Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length || (this.#query && revision <= this.#query.revision)) throw Error('terminal-candidate-query');
    this.#query?.abort.abort();
    const query: CandidateQuery = { revision, abort: new AbortController(), items: [] as readonly SuggestionItem[] }; this.#query = query;
    const context = { draft: text, cursor: Array.from(text.slice(0, cursor)).length, runtime: this.runtime(), mode: 'prompt' as const,
      wordTerminators: createInputHandleTokenPatterns() };
    for (const provider of this.#providers) {
      const match = provider.matchTrigger(context);
      if (!match) continue;
      const trust = provider.id === 'argument' && /^\/trust\s/u.test(text);
      const command = provider.id === 'argument' ? /^\/(resume|work)\s/u.exec(text)?.[1] as 'resume' | 'work' | undefined : undefined;
      const chars = Array.from(text);
      const range = { revision, start: chars.slice(0, match.tokenStart).join('').length, end: chars.slice(0, match.tokenEnd).join('').length };
      let items: readonly SuggestionItem[];
      try { items = await provider.query(match, query.abort.signal); }
      catch (error) {
        if (query !== this.#query || query.abort.signal.aborted) return { revision, start: cursor, end: cursor, items: [] };
        return { ...range, ...(trust ? { mode: 'management' as const } : {}), items: [],
          error: error instanceof Error ? error.message.slice(0, 2048) : '候选读取失败，请刷新。' };
      }
      if (query !== this.#query || query.abort.signal.aborted) return { revision, start: cursor, end: cursor, items: [] };
      // Metadata, retained payloads and their UI projections share a finite slot.
      let bytes = 0;
      query.items = items.filter(item => {
        const charge = Buffer.byteLength(JSON.stringify(item));
        if (bytes + charge > 96 * 1024) return false;
        bytes += charge; return true;
      }).slice(0, 100);
      if (trust) this.#trust?.retain(revision, query.items);
      query.command = command;
      return { ...range, ...(trust ? { mode: 'management' as const, canDelete: true, hint: 'Esc 返回 · ↑↓ 选择 · 两次 Ctrl+D 撤销 · Ctrl+R 刷新' }
        : command ? { mode: 'picker' as const, canDelete: true, canRename: command === 'work', canCreate: command === 'work', hint: command === 'work'
          ? 'Esc 返回 · Enter 进入 · Ctrl+D 删除 · Ctrl+R 改名 · Ctrl+N 新建' : 'Esc 返回 · Enter 切换 · 两次 Ctrl+D 删除' } : {}),
        items: query.items.map(item => ({ id: item.id, label: item.displayText, detail: item.description })) };
    }
    return { revision, start: cursor, end: cursor, items: [] };
  }
  accept(revision: number, id: string): SuggestionItem {
    const query = this.#query, item = query?.items.find(item => item.id === id);
    if (!query || query.revision !== revision || query.abort.signal.aborted || !item) throw Error('terminal-candidate-expired');
    if (item.acceptPayload.metadata?.commandId === 'trust:repl') throw Error('信任管理候选不可提交。');
    query.items = []; return item;
  }
  close(): void { this.#query?.abort.abort(); this.#query = undefined; }
}
