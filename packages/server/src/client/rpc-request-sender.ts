import type { WebSocket } from 'ws';
import type { RpcEncodedJsonReader, RpcEncodedJsonSource } from './rpc-encoded-source.js';

const MAX_REQUESTS = 32;
const FRAGMENT_UNITS = Math.floor(32 * 1024 / 3);
type Done = (error?: Error) => void;
interface Request {
  readonly pending: () => boolean;
  readonly done: Done;
  text?: string;
  offset: number;
  started: boolean;
  writing?: boolean;
  retire?: () => void;
  textBytes?: number;
  settled?: boolean;
  source?: { prefix: string; params: RpcEncodedJsonSource; signal: AbortSignal;
    reader?: RpcEncodedJsonReader; phase: 0 | 1 | 2; reading: boolean; writing: boolean; drained(): void };
}

/** One JSON-RPC message at a time on the existing WebSocket. Waiting for each
 * write callback bounds masking/socket buffers; fragments of another request
 * can never enter the middle of this message. Admission snapshots parameters
 * synchronously, as the existing request API did before transport queuing.
 * The caller's original request deadline includes this queue and every write. */
export class RpcRequestSender {
  readonly #queue: Request[] = [];
  #active?: Request;
  #scheduled?: ReturnType<typeof setImmediate>;
  #closed = false;
  readonly #sourceWork = new Set<Promise<void>>();
  readonly #writes = new Set<Promise<void>>();
  #textBytes = 0;
  constructor(readonly socket: Pick<WebSocket, 'send'>, readonly failed: (error: Error) => void,
    readonly maximumQueuedBytes = Infinity) {}

  send(encode: () => string, pending: () => boolean, done: Done, retired?: () => void): () => boolean {
    if (this.#closed || this.#queue.length + Number(!!this.#active) >= MAX_REQUESTS) {
      done(Error(this.#closed ? 'RPC sender closed' : 'RPC send queue is full'));
      retired?.();
      return () => false;
    }
    let text: string;
    try { text = encode(); }
    catch (error) { done(error instanceof Error ? error : Error('Unable to encode RPC request')); retired?.(); return () => false; }
    const textBytes = Buffer.byteLength(text);
    if (textBytes > this.maximumQueuedBytes - this.#textBytes) {
      done(Error('RPC encoded send queue is full')); retired?.(); return () => false;
    }
    this.#textBytes += textBytes;
    const request: Request = { text, textBytes, pending, done, offset: 0, started: false, retire: retired };
    this.#queue.push(request); this.#schedule();
    return () => {
      const partial = this.#active === request && request.started;
      this.#dropText(request);
      const index = this.#queue.indexOf(request);
      if (index >= 0) this.#queue.splice(index, 1);
      this.#retire(request);
      // Once the first non-final frame is sent, dropping the rest would turn
      // the next request into its continuation. The client must close instead.
      return partial;
    };
  }

  sendEncoded(id: number, method: string, params: RpcEncodedJsonSource, signal: AbortSignal,
    pending: () => boolean, done: Done, retired?: () => void): () => boolean {
    const prefix = `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":`;
    if (this.#closed || this.#queue.length + Number(!!this.#active) >= MAX_REQUESTS ||
      !Number.isSafeInteger(params.byteLength) || params.byteLength < 1 ||
      Buffer.byteLength(prefix) + params.byteLength + 1 > 100 * 1024 * 1024) {
      done(Error('RPC encoded request admission failed')); retired?.(); return () => false;
    }
    let drained!: () => void;
    const work = new Promise<void>(resolve => { drained = resolve; });
    this.#sourceWork.add(work);
    const request: Request = { pending, done, offset: 0, started: false, retire: retired,
      source: { prefix, params, signal, phase: 0, reading: false, writing: false,
        drained: () => { this.#sourceWork.delete(work); drained(); } } };
    this.#queue.push(request); this.#schedule();
    return () => {
      const partial = this.#active === request && request.started;
      const index = this.#queue.indexOf(request);
      if (index >= 0) this.#queue.splice(index, 1);
      this.#releaseSource(request);
      return partial;
    };
  }

  /** Caller rejection does not retire a write or a cold-source borrow. */
  async drain(): Promise<void> { await Promise.all([...this.#sourceWork, ...this.#writes]); }

  close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true; clearImmediate(this.#scheduled); this.#scheduled = undefined;
    const requests = this.#active ? [this.#active, ...this.#queue] : [...this.#queue];
    this.#active = undefined; this.#queue.length = 0;
    for (const request of requests) {
      this.#dropText(request); this.#settle(request, error); this.#releaseSource(request); this.#retire(request);
    }
  }

  #schedule(): void {
    if (this.#closed || this.#active || this.#scheduled || !this.#queue.length) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      if (this.#closed) return;
      const request = this.#queue.shift();
      if (!request) return;
      if (!request.pending() || (request.text === undefined && !request.source)) { this.#dropText(request); this.#releaseSource(request); this.#retire(request); this.#schedule(); return; }
      this.#active = request;
      if (request.source) this.#writeSource(request); else this.#write(request);
    });
  }

  #write(request: Request): void {
    if (this.#closed || this.#active !== request) return;
    if (!request.pending() || request.text === undefined) { this.#fail(Error('RPC send expired')); return; }
    let end = Math.min(request.text.length, request.offset + FRAGMENT_UNITS);
    if (end < request.text.length && request.text.charCodeAt(end - 1) >= 0xd800 && request.text.charCodeAt(end - 1) <= 0xdbff &&
        request.text.charCodeAt(end) >= 0xdc00 && request.text.charCodeAt(end) <= 0xdfff) end--;
    const final = end === request.text.length;
    const fragment = request.text.slice(request.offset, end);
    request.offset = end; request.started = true;
    const finishWrite = this.#trackWrite(request);
    try {
      this.socket.send(fragment, { binary: false, compress: false, fin: final }, error => {
        finishWrite();
        if (this.#closed || this.#active !== request) return;
        if (error) { this.#fail(error); return; }
        if (final) {
          this.#dropText(request); this.#active = undefined; this.#settle(request); this.#schedule();
        } else {
          // Drop the prior ws/masking callback frame before allocating another
          // fragment. This also gives cancellation and the deadline a turn.
          this.#scheduled = setImmediate(() => { this.#scheduled = undefined; this.#write(request); });
        }
      });
    } catch (error) { finishWrite(); this.#fail(error instanceof Error ? error : Error('Unable to send RPC request')); }
  }

  #writeSource(request: Request): void {
    const source = request.source;
    if (!source) return;
    if (this.#closed || this.#active !== request || !request.pending() || source.signal.aborted) {
      this.#releaseSource(request); return;
    }
    try {
      source.reader ??= source.params.open();
      if (source.phase !== 1) {
        this.#writeSourceFrame(request, source.phase === 0 ? source.prefix : '}', source.phase === 2);
      } else {
        source.reading = true;
        void source.reader.read(request.offset, 32 * 1024, source.signal).then(bytes => {
          source.reading = false;
          if (this.#closed || this.#active !== request || !request.pending() || source.signal.aborted) { this.#releaseSource(request); return; }
          if (!bytes.byteLength || bytes.byteLength > 32 * 1024 || request.offset + bytes.byteLength > source.params.byteLength) {
            this.#fail(Error('RPC encoded source length mismatch')); return;
          }
          request.offset += bytes.byteLength;
          this.#writeSourceFrame(request, bytes, false);
        }, error => {
          source.reading = false;
          if (this.#closed) this.#releaseSource(request);
          else this.#fail(error instanceof Error ? error : Error('RPC encoded source read failed'));
        });
      }
    } catch (error) { this.#fail(error instanceof Error ? error : Error('RPC encoded source unavailable')); }
  }

  #writeSourceFrame(request: Request, bytes: string | Uint8Array, final: boolean): void {
    const source = request.source!;
    source.writing = true; request.started = true;
    const finishWrite = this.#trackWrite(request);
    try {
      this.socket.send(bytes, { binary: false, compress: false, fin: final }, error => {
        source.writing = false;
        finishWrite();
        if (this.#closed || this.#active !== request) { this.#releaseSource(request); return; }
        if (error) { this.#fail(error); return; }
        if (final) {
          this.#releaseSource(request); this.#active = undefined; this.#settle(request); this.#schedule();
        } else {
          source.phase = source.phase === 0 ? 1 : request.offset === source.params.byteLength ? 2 : 1;
          this.#scheduled = setImmediate(() => { this.#scheduled = undefined; this.#writeSource(request); });
        }
      });
    } catch (error) {
      source.writing = false; finishWrite(); this.#fail(error instanceof Error ? error : Error('Unable to send RPC request'));
    }
  }

  #releaseSource(request: Request): void {
    const source = request.source;
    if (!source || source.reading || source.writing) return;
    source.reader?.release(); source.drained(); request.source = undefined; this.#retire(request);
  }
  #dropText(request: Request): void {
    request.text = undefined;
    this.#textBytes -= request.textBytes ?? 0; request.textBytes = undefined;
  }
  #retire(request: Request): void {
    if (request.writing || request.source || request.text !== undefined) return;
    const retire = request.retire; request.retire = undefined; retire?.();
  }
  #trackWrite(request: Request): () => void {
    request.writing = true;
    let finish!: () => void, completed = false;
    const work = new Promise<void>(resolve => { finish = resolve; });
    this.#writes.add(work);
    return () => {
      if (completed) return; completed = true;
      // Retire after the real ws callback stack, including masking buffers.
      setImmediate(() => {
        request.writing = false; this.#retire(request);
        this.#writes.delete(work); finish();
      });
    };
  }
  #settle(request: Request, error?: Error): void {
    if (request.settled) return;
    request.settled = true;
    if (error) request.done(error); else request.done();
  }

  #fail(error: Error): void { this.close(error); this.failed(error); }
}
