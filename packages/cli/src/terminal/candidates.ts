import { CommandProvider, DefaultCommandRegistry, FileProvider, type SuggestionItem, type SuggestionProvider, type RuntimeContext } from '@zhixing/core/typeahead';
import type { TerminalCandidates } from '@zhixing/terminal-ui/protocol';
import { BUILTIN_COMMANDS } from '../commands/builtin-definitions.js';
import { createInputHandleTokenPatterns } from '../input-handle-tokens.js';

/** Commands delivered in this migration unit. Other command ownership stays in
 * the same catalog, without exposing an inoperative candidate. */
const available = new Set(['help', 'status', 'stop', 'config', 'mcp', 'exit']);

export class TerminalCandidatesOwner {
  readonly registry = new DefaultCommandRegistry();
  readonly #providers: readonly SuggestionProvider[];
  #query?: { revision: number; abort: AbortController; items: readonly SuggestionItem[] };
  constructor(readonly runtime: () => RuntimeContext) {
    for (const definition of Object.values(BUILTIN_COMMANDS)) if (available.has(definition.name)) this.registry.register(definition);
    this.#providers = [new CommandProvider({ registry: this.registry }), new FileProvider({ root: () => runtime().cwd, maxResults: 100, maxResultBytes: 96 * 1024 })]
      .sort((left, right) => left.priority - right.priority);
  }
  async query(revision: number, text: string, cursor: number): Promise<TerminalCandidates> {
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 ||
      !Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length || (this.#query && revision <= this.#query.revision)) throw Error('terminal-candidate-query');
    this.#query?.abort.abort();
    const query = { revision, abort: new AbortController(), items: [] as readonly SuggestionItem[] }; this.#query = query;
    const context = { draft: text, cursor: Array.from(text.slice(0, cursor)).length, runtime: this.runtime(), mode: 'prompt' as const,
      wordTerminators: createInputHandleTokenPatterns() };
    for (const provider of this.#providers) {
      const match = provider.matchTrigger(context);
      if (!match) continue;
      const items = await provider.query(match, query.abort.signal);
      if (query !== this.#query || query.abort.signal.aborted) return { revision, start: cursor, end: cursor, items: [] };
      // Metadata, retained payloads and their UI projections share a finite slot.
      let bytes = 0;
      query.items = items.filter(item => {
        const charge = Buffer.byteLength(JSON.stringify(item));
        if (bytes + charge > 96 * 1024) return false;
        bytes += charge; return true;
      }).slice(0, 100);
      const chars = Array.from(text);
      return { revision, start: chars.slice(0, match.tokenStart).join('').length, end: chars.slice(0, match.tokenEnd).join('').length,
        items: query.items.map(item => ({ id: item.id, label: item.displayText, detail: item.description })) };
    }
    return { revision, start: cursor, end: cursor, items: [] };
  }
  accept(revision: number, id: string): SuggestionItem {
    const query = this.#query, item = query?.items.find(item => item.id === id);
    if (!query || query.revision !== revision || query.abort.signal.aborted || !item) throw Error('terminal-candidate-expired');
    query.items = []; return item;
  }
  close(): void { this.#query?.abort.abort(); this.#query = undefined; }
}
