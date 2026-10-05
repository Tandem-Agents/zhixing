/** One bracketed paste's bounded original pages, before N durably accepts them.
 * The parser still recognizes delimiters; overflow drains that same paste.
 * reserve/release charge full page capacity, including a partially filled tail.
 */
export class TerminalPasteStream implements AsyncIterable<Uint8Array> {
  static readonly pageBytes = 32 * 1024 - 3;
  readonly #pages: Uint8Array[] = [];
  #tail?: Uint8Array;
  #used = 0;
  #ended = false;
  #failure?: Error;
  #wake?: () => void;

  constructor(readonly reserve: (bytes: number) => void, readonly release: (bytes: number) => void) {}

  write(bytes: Uint8Array): void {
    if (this.#ended || this.#failure) return;
    try {
      for (let offset = 0; offset < bytes.length;) {
        if (!this.#tail) {
          this.reserve(TerminalPasteStream.pageBytes);
          try { this.#tail = new Uint8Array(TerminalPasteStream.pageBytes); }
          catch (error) { this.release(TerminalPasteStream.pageBytes); throw error; }
          this.#used = 0;
        }
        const count = Math.min(bytes.length - offset, this.#tail.length - this.#used);
        this.#tail.set(bytes.subarray(offset, offset + count), this.#used);
        this.#used += count; offset += count;
        if (this.#used === this.#tail.length) {
          this.#pages.push(this.#tail); this.#tail = undefined; this.#used = 0; this.#signal();
        }
      }
    } catch (error) { this.abort(error instanceof Error ? error : Error('粘贴工作区不可用，原草稿保留。')); }
  }
  end(): void {
    if (this.#ended || this.#failure) return;
    this.#ended = true;
    if (this.#tail) {
      this.#pages.push(this.#tail.subarray(0, this.#used)); this.#tail = undefined; this.#used = 0;
    }
    this.#signal();
  }
  abort(error = Error('粘贴未完整接收，原草稿保留。')): void {
    this.#failure ??= error;
    this.#ended = true;
    this.release((this.#pages.length + (this.#tail ? 1 : 0)) * TerminalPasteStream.pageBytes);
    this.#pages.length = 0; this.#tail = undefined; this.#used = 0; this.#signal();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        if (this.#failure) throw this.#failure;
        const page = this.#pages.shift();
        if (page) {
          try { yield page; }
          finally { this.release(TerminalPasteStream.pageBytes); }
        } else if (this.#ended) return;
        else await new Promise<void>(resolve => { this.#wake = resolve; });
      }
    } finally { this.abort(); }
  }
  #signal(): void { const wake = this.#wake; this.#wake = undefined; wake?.(); }
}

export interface TerminalPasteSink {
  write(bytes: Uint8Array): void;
  end(): void;
  abort(): void;
}
