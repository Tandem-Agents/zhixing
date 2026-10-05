import type { WebSocket } from 'ws';

const MAX_REQUESTS = 32;
const FRAGMENT_UNITS = Math.floor(32 * 1024 / 3);
type Done = (error?: Error) => void;
interface Request {
  readonly pending: () => boolean;
  readonly done: Done;
  text?: string;
  offset: number;
  started: boolean;
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
  constructor(readonly socket: Pick<WebSocket, 'send'>, readonly failed: (error: Error) => void) {}

  send(encode: () => string, pending: () => boolean, done: Done): () => boolean {
    if (this.#closed || this.#queue.length + Number(!!this.#active) >= MAX_REQUESTS) {
      done(Error(this.#closed ? 'RPC sender closed' : 'RPC send queue is full'));
      return () => false;
    }
    let text: string;
    try { text = encode(); }
    catch (error) { done(error instanceof Error ? error : Error('Unable to encode RPC request')); return () => false; }
    const request: Request = { text, pending, done, offset: 0, started: false };
    this.#queue.push(request); this.#schedule();
    return () => {
      const partial = this.#active === request && request.started;
      request.text = undefined;
      const index = this.#queue.indexOf(request);
      if (index >= 0) this.#queue.splice(index, 1);
      // Once the first non-final frame is sent, dropping the rest would turn
      // the next request into its continuation. The client must close instead.
      return partial;
    };
  }

  close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true; clearImmediate(this.#scheduled); this.#scheduled = undefined;
    const requests = this.#active ? [this.#active, ...this.#queue] : [...this.#queue];
    this.#active = undefined; this.#queue.length = 0;
    for (const request of requests) {
      request.text = undefined; request.done(error);
    }
  }

  #schedule(): void {
    if (this.#closed || this.#active || this.#scheduled || !this.#queue.length) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      if (this.#closed) return;
      const request = this.#queue.shift();
      if (!request) return;
      if (!request.pending() || request.text === undefined) { this.#schedule(); return; }
      this.#active = request;
      this.#write(request);
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
    try {
      this.socket.send(fragment, { binary: false, compress: false, fin: final }, error => {
        if (this.#closed || this.#active !== request) return;
        if (error) { this.#fail(error); return; }
        if (final) {
          request.text = undefined; this.#active = undefined; request.done(); this.#schedule();
        } else {
          // Drop the prior ws/masking callback frame before allocating another
          // fragment. This also gives cancellation and the deadline a turn.
          this.#scheduled = setImmediate(() => { this.#scheduled = undefined; this.#write(request); });
        }
      });
    } catch (error) { this.#fail(error instanceof Error ? error : Error('Unable to send RPC request')); }
  }

  #fail(error: Error): void { this.close(error); this.failed(error); }
}
