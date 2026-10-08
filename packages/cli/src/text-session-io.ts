import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import type { Readable } from 'node:stream';
import type { AgentYield } from '@zhixing/core/loop';
import type { TerminalSelectionPort } from './terminal/selection.js';

export interface TextSink { write(text: string): unknown }

/** Pull one finite input chunk only when the consumer asks for another line.
 * Readable stays in paused mode during startup and RPC waits, so its ordinary
 * stream backpressure reaches the pipe; there is no eagerly growing FIFO. */
export const TEXT_INPUT_MAX_LINE_BYTES = 1024 * 1024;
const INPUT_CHUNK_BYTES = 16 * 1024;
export class TextLineInput {
  readonly #decoder = new StringDecoder('utf8');
  #pending = '';
  #skipLF = false;
  #closed = false;
  #disposed = false;
  #failure?: Error;
  #wake?: () => void;
  readonly #notify = (): void => { const wake = this.#wake; this.#wake = undefined; wake?.(); };
  readonly #onEnd = (): void => { this.#pending += this.#decoder.end(); this.#closed = true; this.#notify(); };
  readonly #onError = (error: Error): void => { this.#failure = error; this.#closed = true; this.#notify(); };

  constructor(readonly input: Readable) {
    input.pause();
    this.#closed = input.readableEnded;
    input.on('readable', this.#notify);
    input.once('end', this.#onEnd);
    input.on('error', this.#onError);
  }
  async next(): Promise<string | undefined> {
    let line = '', bytes = 0;
    for (;;) {
      if (this.#disposed) return;
      if (this.#failure) throw this.#failure;
      if (this.#skipLF && this.#pending.length) {
        if (this.#pending.startsWith('\n')) this.#pending = this.#pending.slice(1);
        this.#skipLF = false;
      }
      const boundary = this.#pending.search(/[\r\n]/u);
      const text = boundary < 0 ? this.#pending : this.#pending.slice(0, boundary);
      bytes += Buffer.byteLength(text);
      if (bytes > TEXT_INPUT_MAX_LINE_BYTES) {
        this.#failure = Error('单行输入超过 1 MiB，未发送该行；请拆分输入后重试。');
        throw this.#failure;
      }
      line += text;
      if (boundary >= 0) {
        this.#skipLF = this.#pending[boundary] === '\r';
        this.#pending = this.#pending.slice(boundary + 1);
        return line;
      }
      this.#pending = '';
      if (this.#closed) return line.length ? line : undefined;
      const chunk: unknown = this.input.read(Math.min(INPUT_CHUNK_BYTES, this.input.readableLength || INPUT_CHUNK_BYTES));
      if (chunk !== null) {
        if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) throw Error('文本输入必须是字节流。');
        this.#pending = this.#decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        continue;
      }
      await new Promise<void>(resolve => { this.#wake = resolve; });
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#pending = ''; this.input.pause();
    this.input.off('readable', this.#notify); this.input.off('end', this.#onEnd);
    this.input.off('error', this.#onError); this.#notify();
  }
}

/** No ANSI producer and no terminal editing ownership. Controls from any
 * remote text are stripped even when FORCE_COLOR is inherited. */
export function textSessionPlain(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/gu, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '');
}
export class TextSessionOutput {
  #inline = false;
  #thinking = false;
  constructor(readonly output: TextSink) {}
  readonly ensureSegmentBreak = (): void => {
    if (this.#inline) this.output.write('\n');
    this.#inline = false;
  };
  readonly line = (text: string): void => { this.ensureSegmentBreak(); this.output.write(`${textSessionPlain(text)}\n`); };
  readonly notify = this.line;
  readonly appendInline = (text: string): void => {
    const plain = textSessionPlain(text);
    if (!plain) return;
    this.output.write(plain); this.#inline = !plain.endsWith('\n');
  };
  yield(event: AgentYield): void {
    switch (event.type) {
      case 'text_delta':
        if (this.#thinking) { this.ensureSegmentBreak(); this.#thinking = false; }
        this.appendInline(event.text); break;
      case 'thinking_block_start': this.line('[思考]'); this.#thinking = true; break;
      case 'thinking_delta': this.appendInline(event.thinking); break;
      case 'thinking_block_end': this.ensureSegmentBreak(); this.#thinking = false; break;
      case 'tool_start': this.line(`[工具] ${event.name}`); break;
      case 'tool_end': this.line(`[工具完成] ${event.name}${event.result.isError ? '（失败）' : ''}`); break;
      // Delta delivery/recovery belongs to ConversationController. The final
      // assistant message is never printed again, avoiding duplicate answers.
      case 'assistant_message': case 'turn_complete': break;
    }
  }
}

/** Pipe lines are task input, never confirmation answers. The existing
 * selection adapters map an absent response to cancellation or denial. */
export function createTextSelection(output: TextSessionOutput, options: { readonly readOnly?: boolean } = {}): TerminalSelectionPort {
  return async page => {
    output.line(page.title);
    if (page.message) output.line(page.message);
    for (const choice of page.choices ?? []) {
      if (['previous', 'next', 'return'].includes(choice.id)) continue;
      output.line(`- ${choice.label}${choice.detail ? `：${choice.detail}` : ''}`);
    }
    // The selection adapter reserves next/previous for bounded body pages and
    // prefixes business options with option:. Read every body page, even when
    // it describes a pending decision, but never select that decision. Generic
    // pickers, input and confirmation pages cannot opt in merely by naming an
    // action next; their interaction layer is not a body-page contract.
    const bodyPage = options.readOnly === true && page.kind === 'selection' && !page.field &&
      (page.selectionLayer === 'select' || page.selectionLayer === 'details') &&
      page.choices?.every(choice => ['previous', 'next', 'return', 'details'].includes(choice.id) || choice.id.startsWith('option:'));
    if (bodyPage && page.choices?.some(choice => choice.id === 'next' && !choice.disabled && !choice.danger)) return { itemId: 'next' };
    if (page.choices?.some(choice => choice.id === 'next')) output.line('还有更多内容，请在交互终端查看。');
    const actions = page.choices?.filter(choice => !['return', 'option:done', 'previous', 'cancel', 'done'].includes(choice.id));
    if (page.kind === 'confirmation') output.line('当前为非交互文本输入，已拒绝本次操作；请在交互终端确认。');
    else if (page.field || actions?.length) output.line('当前环境不支持选择交互，未提交选择。请在交互终端继续。');
    return undefined;
  };
}

export interface TextSignalEmitter {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}
export function attachTextInterrupts(options: {
  signals: TextSignalEmitter;
  active(): boolean;
  abort(): Promise<void>;
  abortBackground(): Promise<boolean>;
  exit(): void;
  error(error: unknown): void;
  now?: () => number;
}): () => void {
  let previous = -Infinity, stopping = false;
  const stop = (terminate: boolean) => {
    const now = options.now?.() ?? Date.now(), repeated = now - previous < 800;
    previous = now;
    if (terminate || repeated) options.exit();
    if (options.active()) { void options.abort().catch(options.error); return; }
    if (stopping) return;
    stopping = true;
    void options.abortBackground().then(stopped => {
      if (!stopped) options.exit();
    }).catch(options.error).finally(() => { stopping = false; });
  };
  const interrupt = () => stop(false), terminate = () => stop(true);
  options.signals.on('SIGINT', interrupt); options.signals.on('SIGTERM', terminate);
  return () => { options.signals.off('SIGINT', interrupt); options.signals.off('SIGTERM', terminate); };
}
