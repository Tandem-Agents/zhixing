import type { CommandDef, ICommandRegistry } from '@zhixing/core/typeahead';
import type { SkillCatalogClient } from '@zhixing/core/skills/catalog';
import { SkillCommandSource } from '../commands/skill-command-source.js';
import { BUILTIN_COMMANDS } from '../commands/builtin-definitions.js';

const reserved = new Map<string, CommandDef>();
for (const definition of Object.values(BUILTIN_COMMANDS) as CommandDef[]) {
  for (const name of [definition.name, ...(definition.aliases ?? [])]) reserved.set(name.toLowerCase(), definition);
}

/** Metadata-only route. U submits its original input snapshot through T01–T06. */
export function terminalSkillCommandRoute(registry: ICommandRegistry, name: string): { readonly route: 'input' } | undefined {
  if (reserved.has(name.toLowerCase())) return;
  const definition = registry.findByName(name);
  if (definition?.execution === 'agent') return { route: 'input' };
}

/** One Catalog client shared with the management page; no execution or I/O owner. */
export class TerminalSkillCommands {
  readonly #unregister: () => void;
  readonly #unsubscribe: () => void;
  #disposed = false;
  #refreshing?: Promise<void>;
  #requested = false;
  #failure?: Error;
  #listing?: Promise<readonly CommandDef[]>;

  constructor(readonly options: {
    registry: ICommandRegistry;
    client: SkillCatalogClient;
    onError(error: Error): void;
    signal?: AbortSignal;
  }) {
    const findExisting = (name: string) => reserved.get(name.toLowerCase()) ?? options.registry.findByName(name);
    const source = new SkillCommandSource({ client: options.client, findExisting });
    this.#unregister = options.registry.registerDynamicSource({ id: source.id, list: () => {
      if (this.#disposed) return Promise.reject(Error('terminal-skills-closed'));
      if (this.#listing) return this.#listing;
      const work = source.list().then(definitions => {
        // Reject stale binding work; Registry also checks the registration
        // identity at the later apply boundary after awaiting this promise.
        if (this.#disposed) throw Error('terminal-skills-closed');
        return definitions.map(definition => ({ ...definition, aliases: definition.aliases?.filter(alias => {
          const existing = findExisting(alias);
          return !existing || existing.id.startsWith('skill:');
        }) }));
      }).catch(error => {
        if (!this.#disposed) this.#failure = error instanceof Error ? error : Error('技能命令刷新失败。');
        throw error;
      }).finally(() => { if (this.#listing === work) this.#listing = undefined; });
      this.#listing = work; return work;
    } });
    try {
      this.#unsubscribe = options.client.onFact(() => { void this.refresh().catch(() => {}); });
    } catch (error) { this.#unregister(); throw error; }
    options.signal?.addEventListener('abort', this.dispose, { once: true });
    if (options.signal?.aborted) this.dispose();
  }

  /** Facts coalesce into one trailing read. Registry swallows source failures,
   * so the wrapper records the actual source outcome and reports it explicitly. */
  refresh(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#requested = true;
    if (this.#refreshing) return this.#refreshing;
    const work = (async () => {
      while (this.#requested && !this.#disposed) {
        this.#requested = false; this.#failure = undefined;
        await this.options.registry.refresh();
        if (!this.#disposed && this.#failure) this.options.onError(this.#failure);
      }
      if (!this.#disposed && this.#failure) throw this.#failure;
    })().finally(() => { if (this.#refreshing === work) this.#refreshing = undefined; });
    this.#refreshing = work; return work;
  }

  readonly dispose = (): void => {
    if (this.#disposed) return;
    this.#disposed = true; this.#requested = false;
    this.options.signal?.removeEventListener('abort', this.dispose);
    this.#unsubscribe(); this.#unregister();
  };
}
