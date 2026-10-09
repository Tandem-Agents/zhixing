import type { AgentYield } from '@zhixing/core/loop';
import type { TerminalDisplaySegment } from '@zhixing/terminal-ui/protocol';
import type { ConversationOutputSource } from '../runtime/conversation-output.js';
import { textFragments } from './history-segments.js';
import { TerminalBodyProjection, type BodyAmend } from './body-projection.js';
import { BODY_PROJECTION_WORK_BYTES, sliceBodyNodes, type BodyFragmentMetadata, type BodyNode, type BodyRun } from '@zhixing/terminal-ui/body-model';
import { TERMINAL_LIMITS } from '@zhixing/terminal-ui/protocol';
import type { ProcessBlock } from './process-presentation.js';

// Part of the bounded hot prefix, before transport admission. Includes the
// owned UTF-16 string and its encoded representation; IPC keeps its own limit.
const OUTPUT_PREFIX_BYTES = 8 * 1024 * 1024;

interface Stream { readonly key: string; block: number; assistantUnits: number; role?: string }
interface BodyCommand { readonly blockId: string; readonly role: string; readonly text: string; readonly end: boolean;
  readonly body?: BodyFragmentMetadata;
  /** Complete plain display content, whose source can no longer be amended. */
  readonly snapshotOffset?: number }
export interface TerminalOutputBody {
  work(action: () => Promise<void>): Promise<void>;
  amend(blockId: string, change: BodyAmend): Promise<void>;
  seal(blockId: string): Promise<void>;
}
/** Fixed hot prefix, drained independently of the domain producer. A full or
 * failed display seals this projection and emits one control gap. */
export class TerminalOutputProjection {
  readonly #streams = new Map<string, Stream>();
  readonly #queue: { command: BodyCommand; bytes: number }[] = [];
  readonly #parsers = new Map<string, TerminalBodyProjection>();
  #bytes = 0; #inflightBytes = 0; #paused = false; #held = 0; #closed = false;
  #generation = 0;
  #publishedAt = -Infinity;
  #timer?: ReturnType<typeof setTimeout>;
  #flushing?: Promise<void>;
  #draining?: Promise<void>;
  #wakeDrain?: () => void;
  #gapWork?: Promise<void>;
  constructor(readonly append: (segment: TerminalDisplaySegment, stable?: boolean) => Promise<void>, readonly updated: () => Promise<void>,
    readonly gap: (error?: unknown) => Promise<void>, readonly body: TerminalOutputBody,
    readonly process?: { accept(event: AgentYield, source: ConversationOutputSource): void }) {}
  get paused(): boolean { return this.#paused; }
  pause(): void { this.#pause(); }
  async settlePaused(): Promise<void> { await this.#flushing; await this.#gapWork; }
  resume(): void {
    if (this.#closed || this.#flushing) throw Error('terminal-output-recovery-unavailable');
    this.#generation++; this.#streams.clear(); this.#disposeParsers(); this.#paused = false;
  }
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
    this.process?.accept(event, source);
    const key = this.#streamKey(source.conversationId, source.runId ?? source.turnId);
    let stream = this.#streams.get(key);
    if (!stream) {
      if (this.#streams.size >= 128) { this.#pause(Error('terminal-body-active-capacity')); return; }
      stream = { key, block: 0, assistantUnits: 0 }; this.#streams.set(key, stream);
    }
    switch (event.type) {
      case 'text_delta': this.#text(stream, 'assistant', event.text); stream.assistantUnits += event.text.length; break;
      case 'assistant_message': {
        let offset = 0;
        for (const block of event.message.content) if (block.type === 'text') {
          if (offset + block.text.length > stream.assistantUnits) this.#text(stream, 'assistant', block.text.slice(Math.max(0, stream.assistantUnits - offset)));
          offset += block.text.length;
        }
        this.#endBlock(stream); stream.assistantUnits = 0; break;
      }
      case 'tool_start':
        this.#endBlock(stream);
        if (this.process) break;
        this.#text(stream, 'tool', `${event.name} · 正在执行\n`); this.#endBlock(stream); break;
      case 'tool_end':
        this.#endBlock(stream);
        if (this.process) break;
        this.#text(stream, 'tool', `${event.name} · ${event.result.isError ? '未完成' : '已完成'}\n`);
        if (typeof event.result.content === 'string') this.#text(stream, 'tool', event.result.content);
        this.#endBlock(stream); break;
      // Thinking remains low-noise activity state; it is not retained as a
      // second unbounded transcript by the terminal.
      default: break;
    }
    this.#schedule();
  }
  end(conversationId: string, turnId?: string, runId?: string): void {
    // Closing/draining a body observer is not a domain completion receipt.
    const key = this.#streamKey(conversationId, runId ?? turnId), stream = this.#streams.get(key);
    if (stream) { this.#endBlock(stream); this.#streams.delete(key); this.#schedule(); }
  }
  /** Complete process text shares the queue/cache/gap owner, but needs no
   * speculative parser prefix or mutable disk slots. It is already plain text. */
  appendProcessBlock(block: ProcessBlock): void {
    if (this.#closed || this.#paused) return;
    const blockId = this.#generation ? `${block.blockId}:display-${this.#generation}` : block.blockId;
    for (const part of textFragments(block.text)) {
      const runs: BodyRun[] = []; let at = part.offset;
      const end = at + part.text.length;
      const add = (to: number, semantic?: BodyRun['semantic']) => {
        if (to > at) runs.push({ from: at, to, text: block.text.slice(at, to), style: 0, ...(semantic ? { semantic } : {}) }); at = to;
      };
      for (const span of block.spans ?? []) {
        if (span.to <= at || span.from >= end) continue;
        add(Math.max(at, span.from)); add(Math.min(end, span.to), span.semantic);
      }
      add(end);
      const nodes: BodyNode[] = block.lines ? block.lines.filter(line => line.to > part.offset &&
        (line.from < end || part.final && line.from === end && line.decoration !== undefined)).map(line => {
        const from = Math.max(part.offset, line.from), to = Math.min(end, line.to);
        // The source newline belongs to the row boundary, not a second blank
        // visual line. Source coordinates retain it for range continuity.
        // A final empty diff row has no character range, but still owns its
        // gutter at EOF. Only the final fragment may carry that zero-width row.
        const contentEnd = to > from && block.text[to - 1] === '\n' ? to - 1 : to;
        const row = sliceBodyNodes([{ from: part.offset, to: end, kind: 'paragraph', runs }], from, contentEnd)[0];
        return { from, to, origin: line.from, kind: 'paragraph', runs: row?.runs ?? [],
          anchor: line.from === 0 && from === 0 && block.role !== 'thinking', decoration: line.decoration };
      }) : [{ from: part.offset, to: end, origin: 0, kind: 'paragraph', anchor: part.offset === 0 && block.role !== 'thinking', runs }];
      this.#enqueue({ blockId, role: block.role, text: part.text, end: part.final, snapshotOffset: part.offset,
        body: { version: 1, revision: 0, kind: 'plain', end: part.final, context: { nodes } } });
    }
    this.#schedule();
  }
  async reset(current: () => boolean): Promise<void> {
    await this.drain(); if (current()) { this.#streams.clear(); this.#disposeParsers(); }
  }
  #streamKey(conversationId: string, runId?: string): string {
    return `${conversationId}:${runId ?? 'status'}${this.#generation ? `:display-${this.#generation}` : ''}`;
  }
  async close(): Promise<void> {
    this.#closed = true; clearTimeout(this.#timer); this.#queue.length = 0; this.#bytes = 0;
    this.#wakeDrain?.();
    await this.#flushing; this.#streams.clear(); this.#disposeParsers();
  }
  #text(stream: Stream, role: string, text: string): void {
    stream.role = role;
    for (const part of textFragments(text)) {
      if (this.#paused) return;
      const blockId = `live:${stream.key}:${stream.block}`;
      const tail = this.#queue.at(-1);
      if (tail?.command.blockId === blockId && !tail.command.end && Buffer.byteLength(tail.command.text) + Buffer.byteLength(part.text) <= 32 * 1024) {
        const command = { ...tail.command, text: tail.command.text + part.text }, bytes = this.#commandBytes(command);
        if (this.#bytes + this.#inflightBytes - tail.bytes + bytes > OUTPUT_PREFIX_BYTES) { this.#pause(Error('terminal-output-queue-capacity')); return; }
        this.#bytes += bytes - tail.bytes; this.#queue[this.#queue.length - 1] = { command, bytes };
      } else {
        // A short slice must not retain a much larger decoded RPC event.
        const owned = Buffer.from(part.text).toString('utf8');
        this.#enqueue({ blockId, role, text: owned, end: false });
      }
    }
  }
  #commandBytes(command: BodyCommand): number { return Buffer.byteLength(JSON.stringify(command)) + command.text.length * 2; }
  #enqueue(command: BodyCommand): void {
    if (this.#closed || this.#paused) return;
    const bytes = this.#commandBytes(command);
    if (this.#bytes + this.#inflightBytes + bytes > OUTPUT_PREFIX_BYTES || this.#queue.length >= 128) { this.#pause(Error('terminal-output-queue-capacity')); return; }
    this.#queue.push({ command, bytes }); this.#bytes += bytes;
  }
  #endBlock(stream: Stream): void {
    this.#enqueue({ blockId: `live:${stream.key}:${stream.block}`, role: stream.role ?? 'assistant', text: '', end: true }); stream.block++; stream.role = undefined;
  }
  #disposeParsers(): void { for (const parser of this.#parsers.values()) parser.dispose(); this.#parsers.clear(); }
  #parserCapacity(): void {
    let bytes = 0;
    for (const parser of this.#parsers.values()) bytes += parser.retainedBytes;
    if (bytes + BODY_PROJECTION_WORK_BYTES > TERMINAL_LIMITS.parserBytes) throw Error('terminal-body-active-capacity');
  }
  #schedule(backlog = false): void {
    if (this.#closed || this.#held || this.#flushing || this.#timer || !this.#queue.length) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flushing = this.#flush().catch(error => this.#pause(error)).finally(() => {
        this.#flushing = undefined; if (this.#paused) this.#disposeParsers(); this.#schedule(true); this.#wakeDrain?.();
      });
    // Coalesce newly arriving text once. A finite batch already yielded for
    // its IO/publication; do not impose a second quiet period on a backlog.
    // The next timer still lets control/input callbacks run between batches.
    }, backlog ? 0 : 40);
  }
  async #flush(): Promise<void> {
    let consumed = 0;
    while (this.#queue.length && !this.#closed && !this.#held && consumed++ < 4) {
      const { command, bytes } = this.#queue.shift()!;
      this.#inflightBytes = bytes;
      this.#bytes -= this.#inflightBytes;
      try {
        await this.body.work(async () => {
          if (this.#closed || this.#paused) return;
          if (command.snapshotOffset !== undefined) {
            await this.append({ blockId: command.blockId, role: command.role, text: command.text,
              contentOffset: command.snapshotOffset, final: command.end, body: command.body }, true);
            return;
          }
          let parser = this.#parsers.get(command.blockId);
          if (!parser && command.end) return;
          if (!parser) {
            if (this.#parsers.size >= 128) throw Error('terminal-body-active-capacity');
            parser = new TerminalBodyProjection(command.role === 'assistant' ? 'markdown' : 'plain');
            this.#parsers.set(command.blockId, parser);
          }
          for (const change of command.end ? parser.end() : parser.feed(command.text)) {
            this.#parserCapacity();
            if (this.#closed || this.#paused) return;
            if (change.kind === 'amend') await this.body.amend(command.blockId, change);
            else await this.append({ blockId: command.blockId, role: command.role, contentOffset: change.contentOffset,
              text: change.text, final: change.body.end, body: change.body }, change.stable);
          }
          this.#parserCapacity();
          if (command.end) { await this.body.seal(command.blockId); this.#parsers.delete(command.blockId); }
        });
      } finally { this.#inflightBytes = 0; }
    }
    // Storage must drain a burst without a second quiet-period delay, but
    // publishing every intermediate batch needlessly reparses/reflows the
    // same viewport. Coalesce only its display projection, never stored text.
    // The last batch (and a hold boundary) always publishes before drain ends.
    const now = performance.now();
    if (!this.#closed && (!this.#queue.length || this.#held || now - this.#publishedAt >= 40)) {
      this.#publishedAt = now;
      await this.updated();
    }
  }
  #pause(error?: unknown): void {
    if (this.#paused || this.#closed) return;
    this.#paused = true; this.#queue.length = 0; this.#bytes = 0;
    if (!this.#flushing) this.#disposeParsers();
    this.#gapWork = this.gap(error); void this.#gapWork.catch(() => {}); this.#wakeDrain?.();
  }
}
