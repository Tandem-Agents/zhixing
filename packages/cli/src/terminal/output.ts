import type { AgentYield } from '@zhixing/core/loop';
import type { TerminalDisplaySegment } from '@zhixing/terminal-ui/protocol';
import type { ConversationOutputSource } from '../runtime/conversation-output.js';
import { textFragments } from './history-segments.js';

interface Stream { readonly key: string; block: number; offset: number; assistantUnits: number }
/** Fixed hot prefix, drained independently of the domain producer. A full or
 * failed display seals this projection and emits one control gap. */
export class TerminalOutputProjection {
  readonly #streams = new Map<string, Stream>();
  readonly #queue: TerminalDisplaySegment[] = [];
  #bytes = 0; #inflightBytes = 0; #paused = false; #held = 0; #closed = false;
  #timer?: ReturnType<typeof setTimeout>;
  #flushing?: Promise<void>;
  #draining?: Promise<void>;
  #wakeDrain?: () => void;
  #gapWork?: Promise<void>;
  constructor(readonly append: (segment: TerminalDisplaySegment) => Promise<void>, readonly updated: () => Promise<void>, readonly gap: () => Promise<void>) {}
  get paused(): boolean { return this.#paused; }
  hold(): () => void { this.#held++; let released = false; return () => { if (released) return; released = true; this.#held--; this.#schedule(); this.#wakeDrain?.(); }; }
  /** One recovery consumer can wait for actual append/gap acknowledgement.
   * Live notifications still use the bounded nonblocking prefix. */
  drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    const work = (async () => {
      while (!this.#closed) {
        if (this.#paused) { await this.#gapWork; return; }
        if (!this.#queue.length && !this.#flushing) return;
        this.#schedule();
        await new Promise<void>(resolve => { this.#wakeDrain = resolve; });
        this.#wakeDrain = undefined;
      }
    })().finally(() => { if (this.#draining === work) this.#draining = undefined; });
    this.#draining = work; return work;
  }
  accept(event: AgentYield, source: ConversationOutputSource): void {
    if (this.#closed || this.#paused) return;
    const key = `${source.conversationId}:${source.turnId ?? source.runId ?? 'status'}`;
    let stream = this.#streams.get(key);
    if (!stream) {
      if (this.#streams.size >= 128) { this.#pause(); return; }
      stream = { key, block: 0, offset: 0, assistantUnits: 0 }; this.#streams.set(key, stream);
    }
    switch (event.type) {
      case 'text_delta': this.#text(stream, 'assistant', event.text); stream.assistantUnits += event.text.length; break;
      case 'assistant_message': {
        let offset = 0;
        for (const block of event.message.content) if (block.type === 'text') {
          if (offset + block.text.length > stream.assistantUnits) this.#text(stream, 'assistant', block.text.slice(Math.max(0, stream.assistantUnits - offset)));
          offset += block.text.length;
        }
        stream.block++; stream.offset = 0; stream.assistantUnits = 0; break;
      }
      case 'tool_start':
        stream.block++; stream.offset = 0;
        this.#text(stream, 'tool', `${event.name} · 正在执行\n`); stream.block++; stream.offset = 0; break;
      case 'tool_end':
        stream.block++; stream.offset = 0;
        this.#text(stream, 'tool', `${event.name} · ${event.result.isError ? '未完成' : '已完成'}\n`);
        if (typeof event.result.content === 'string') this.#text(stream, 'tool', event.result.content);
        stream.block++; stream.offset = 0; break;
      // Thinking remains low-noise activity state; it is not retained as a
      // second unbounded transcript by the terminal.
      default: break;
    }
    this.#schedule();
  }
  end(conversationId: string, turnId?: string, runId?: string): void {
    this.#streams.delete(`${conversationId}:${turnId ?? runId ?? 'status'}`);
  }
  async close(): Promise<void> {
    this.#closed = true; clearTimeout(this.#timer); this.#queue.length = 0; this.#bytes = 0;
    this.#wakeDrain?.();
    await this.#flushing; this.#streams.clear();
  }
  #text(stream: Stream, role: string, text: string): void {
    for (const part of textFragments(text)) {
      if (this.#paused) return;
      const bytes = Buffer.byteLength(part.text) + 1024;
      if (this.#bytes + this.#inflightBytes + bytes > 1024 * 1024 || this.#queue.length >= 128) { this.#pause(); return; }
      const blockId = `live:${stream.key}:${stream.block}`;
      const tail = this.#queue.at(-1);
      if (tail?.blockId === blockId && Buffer.byteLength(tail.text) + Buffer.byteLength(part.text) <= 32 * 1024) {
        this.#queue[this.#queue.length - 1] = { ...tail, text: tail.text + part.text };
        this.#bytes += Buffer.byteLength(part.text);
      } else {
        // A short slice must not retain a much larger decoded RPC event.
        const owned = Buffer.from(part.text).toString('utf8');
        this.#queue.push({ blockId, contentOffset: stream.offset, role, text: owned, final: false }); this.#bytes += bytes;
      }
      stream.offset += part.text.length;
    }
  }
  #schedule(): void {
    if (this.#closed || this.#held || this.#flushing || this.#timer || !this.#queue.length) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flushing = this.#flush().catch(() => this.#pause()).finally(() => { this.#flushing = undefined; this.#schedule(); this.#wakeDrain?.(); });
    }, 40);
  }
  async #flush(): Promise<void> {
    while (this.#queue.length && !this.#closed && !this.#held) {
      const segment = this.#queue.shift()!;
      this.#inflightBytes = Buffer.byteLength(segment.text) + 1024;
      this.#bytes -= this.#inflightBytes;
      try { await this.append(segment); } finally { this.#inflightBytes = 0; }
    }
    if (!this.#closed) await this.updated();
  }
  #pause(): void {
    if (this.#paused || this.#closed) return;
    this.#paused = true; this.#queue.length = 0; this.#bytes = 0;
    this.#gapWork = this.gap(); void this.#gapWork.catch(() => {}); this.#wakeDrain?.();
  }
}
