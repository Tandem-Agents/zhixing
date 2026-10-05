import { randomUUID } from 'node:crypto';
import { TerminalInputStore } from './input-store.js';
import { textFragments } from './history-segments.js';

/** One pinned history read. Large drafts cross the surface boundary in the
 * same bounded fragments as other input, without a second full Node copy. */
export class TerminalInputHistoryReader {
  #current?: { ticket: string; owner: string; iterator: AsyncGenerator<string> };
  #reading = false;
  #opening = false;
  #generation = 0;
  constructor(readonly inputs: TerminalInputStore) {}
  async open(id: string): Promise<{ ticket: string; inputId: string; bytes: number }> {
    if (this.#reading || this.#opening) throw Error('terminal-history-read-in-progress');
    this.#opening = true;
    const generation = ++this.#generation;
    try {
      await this.#disposeCurrent();
      if (generation !== this.#generation) throw Error('terminal-history-read-expired');
      const ticket = randomUUID(), owner = `browse:${ticket}`;
      this.inputs.transfer(`history:${id}`, owner);
      this.#current = { ticket, owner, iterator: this.#fragments(id) };
      return { ticket, inputId: id, bytes: this.inputs.bytes(id) };
    } finally { this.#opening = false; }
  }
  async next(ticket: string): Promise<{ text?: string; end?: true }> {
    const current = this.#current;
    if (!current || current.ticket !== ticket || this.#reading) throw Error('terminal-history-read-expired');
    this.#reading = true;
    try {
      const result = await current.iterator.next();
      if (this.#current !== current) throw Error('terminal-history-read-expired');
      return result.done ? { end: true } : { text: result.value };
    } finally { this.#reading = false; }
  }
  async close(ticket?: string): Promise<void> {
    const current = this.#current;
    if (ticket && (!current || ticket !== current.ticket)) return;
    this.#generation++;
    await this.#disposeCurrent();
  }
  async #disposeCurrent(): Promise<void> {
    const current = this.#current;
    if (!current) return;
    this.#current = undefined;
    try { await current.iterator.return(undefined); }
    finally { this.inputs.forget(current.owner); }
  }
  async *#fragments(id: string): AsyncGenerator<string> {
    for await (const page of this.inputs.pages(id)) for (const fragment of textFragments(page)) yield fragment.text;
  }
}
