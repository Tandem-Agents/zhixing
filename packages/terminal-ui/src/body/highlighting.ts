import path from 'node:path';
import { SyntaxStyle, TreeSitterClient, StyledText, treeSitterToTextChunks } from '@opentui/core';
import type { BodyRenderBlock } from './layout.js';

const languages: Readonly<Record<string, string>> = { js: 'javascript', javascript: 'javascript', jsx: 'javascript',
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript', zig: 'zig' };
/** One actual worker request plus one replaceable current-page job. Rapid
 * streaming/resize never builds a worker promise queue or retains old pages. */
export class BodyHighlighter {
  readonly #client: TreeSitterClient;
  readonly #style: SyntaxStyle;
  readonly #changed: () => void;
  readonly #failed: (error: unknown) => void;
  #generation = 0; #completed = 0; #disposed = false; #faulted = false; #running?: Promise<void>; #closing?: Promise<void>;
  #page: readonly BodyRenderBlock[] = [];
  #results = new Map<string, StyledText>();
  constructor(changed: () => void, failed: (error: unknown) => void) {
    const assets = process.env.OTUI_ASSET_ROOT;
    if (!assets || !path.isAbsolute(assets)) throw Error('terminal-body-parser-assets');
    this.#changed = changed; this.#failed = failed;
    this.#style = SyntaxStyle.fromStyles({
      keyword: { fg: '#c8a7d8' }, string: { fg: '#a5c59b' }, comment: { fg: '#858585', italic: true },
      number: { fg: '#d4b48c' }, function: { fg: '#91b9c6' }, type: { fg: '#c8ba89' },
      punctuation: { fg: '#b0b0b0' }, variable: { fg: '#dddddd' }, default: { fg: '#dddddd' },
    });
    // The build supplies the pinned read-only worker: it reads these admitted
    // assets and has no runtime download/cache writer path.
    try {
      this.#client = new TreeSitterClient({ dataPath: assets, workerPath: path.join(assets, '@opentui/core/parser.worker.js'), initTimeout: 5000 },
        { autoStartWorker: false });
    } catch (error) { this.#style.destroy(); throw error; }
    this.#client.on('error', message => this.#fail(Error(message)));
    this.#client.on('warning', message => this.#fail(Error(message)));
  }
  get(key: string): StyledText | undefined { return this.#results.get(key); }
  setPage(page: readonly BodyRenderBlock[]): void {
    if (this.#disposed || this.#faulted) return;
    this.#generation++; this.#page = page;
    this.#results.clear();
    this.#start();
  }
  #fail(error: unknown): void {
    if (this.#disposed || this.#faulted) return;
    this.#faulted = true; this.#page = []; this.#failed(error);
  }
  #start(): void {
    if (this.#disposed || this.#faulted || this.#running || this.#completed === this.#generation) return;
    const running = this.#run(); this.#running = running;
    void running.catch(error => this.#fail(error)).finally(() => {
      if (this.#running === running) this.#running = undefined;
      // setPage can arrive after #run resolved but before this microtask.
      this.#start();
    });
  }
  async #run(): Promise<void> {
    while (!this.#disposed && !this.#faulted && this.#completed !== this.#generation) {
      const generation = this.#generation, page = this.#page;
      for (const block of page) {
        if (this.#disposed || this.#faulted || generation !== this.#generation) break;
        const language = languages[block.node.language?.toLowerCase() ?? ''];
        if (block.node.kind !== 'code' || !language || !block.text) continue;
        const result = await this.#client.highlightOnce(block.text, language);
        if (this.#disposed || this.#faulted || generation !== this.#generation) break;
        if (result.error) throw Error(result.error);
        if (result.warning) throw Error(result.warning);
        if (!result.highlights) continue;
        if (result.highlights.length > 32768) throw Error('terminal-body-highlight-capacity');
        const chunks = treeSitterToTextChunks(block.text, result.highlights, this.#style, { enabled: false });
        if (chunks.map(chunk => chunk.text).join('') !== block.text) throw Error('terminal-body-highlight-source');
        this.#results.set(block.key, new StyledText(chunks)); this.#changed();
      }
      this.#completed = generation;
    }
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#disposed = true; this.#generation++; this.#page = []; this.#results.clear();
    return this.#closing = (async () => {
      try { await this.#client.destroy(); await this.#running?.catch(() => {}); }
      finally { this.#style.destroy(); }
    })();
  }
}
