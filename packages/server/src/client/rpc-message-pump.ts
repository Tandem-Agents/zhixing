import { WebSocket, type RawData } from "ws";
import type { Socket } from "node:net";
import { RpcReceiverBody, type RpcReceiverEdge } from "./rpc-receiver-body.js";
import type { RpcRequestDeadline } from "./rpc-encoded-source.js";

type WriteDone = (error?: Error | null) => void;
interface Preparation {
  operation(signal: AbortSignal): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  readonly abort: AbortController;
  dispose(): void;
}

/** The pinned ws 8.20.0 receiver can emit several messages from one TCP chunk,
 * including from its asynchronous inflater. Socket.pause alone cannot stop
 * that loop. Hold its current write callback at a completed message boundary
 * and resume framing only after consumption. Writable backpressure bounds
 * additional unparsed socket chunks while that callback is held.
 *
 * This is an instance-local adaptation of that finite receiver seam. It does
 * not replace framing, UTF-8 validation, compression or the 100 MiB limit. */
export class RpcMessagePump {
  readonly #receiver: RpcReceiverEdge;
  readonly #body: RpcReceiverBody;
  readonly #startLoop: RpcReceiverEdge["startLoop"];
  readonly #transport: Socket;
  readonly #disconnected = () => this.#fail();
  readonly #callbacks = new WeakMap<WriteDone, WriteDone>();
  #continuation?: WriteDone;
  #paused = false;
  #closed = false;
  #wire?: Buffer;
  #text?: string;
  #scheduled?: ReturnType<typeof setImmediate>;
  #consuming?: Promise<void>;
  #preparation?: Preparation;
  #preparing?: Promise<void>;
  readonly #preparations: Preparation[] = [];

  constructor(
    readonly socket: WebSocket,
    readonly dispatch: (text: string) => void | Promise<void>,
    readonly failure: () => void,
  ) {
    const edge = socket as unknown as { _receiver?: RpcReceiverEdge; _socket?: Socket };
    const receiver = edge._receiver;
    if (!receiver || !edge._socket || typeof receiver.startLoop !== "function" || typeof receiver._loop !== "boolean") {
      throw Error("Unsupported WebSocket receiver boundary");
    }
    this.#receiver = receiver;
    this.#body = new RpcReceiverBody(receiver, () => !this.#tryPrepare());
    this.#transport = edge._socket;
    // ws's close event waits for Receiver.finish, whose write callback may be
    // held by the consumer. Observe transport termination before that fence.
    this.#transport.once("end", this.#disconnected);
    this.#transport.once("close", this.#disconnected);
    this.#startLoop = receiver.startLoop;
    receiver.startLoop = done => {
      const original = this.#callbacks.get(done) ?? done;
      if (this.#paused) { this.#park(original); return; }
      const guarded: WriteDone = error => {
        if (error || !this.#paused) original(error);
        else this.#park(original);
      };
      this.#callbacks.set(guarded, original);
      this.#startLoop.call(receiver, guarded);
    };
  }

  /** Only local finite preparation belongs inside this lease. In particular,
   * no RPC/reconnect/user wait may depend on this paused receive connection. */
  prepare<T>(operation: (signal: AbortSignal) => Promise<T>, options: RpcRequestDeadline): Promise<T> {
    if (this.#closed || this.#preparations.length + Number(!!this.#preparing) >= 2) return Promise.reject(Error('RPC preparation unavailable'));
    if (options.deadline <= Date.now() || options.signal?.aborted) return Promise.reject(Error('RPC preparation deadline or cancellation'));
    return new Promise<T>((resolve, reject) => {
      const abort = new AbortController();
      let request: Preparation;
      const cancel = () => {
        abort.abort(); reject(Error('RPC preparation deadline or cancellation'));
        const index = this.#preparations.indexOf(request);
        if (index >= 0) { this.#preparations.splice(index, 1); request.dispose(); }
      };
      const timer = setTimeout(cancel, options.deadline - Date.now());
      options.signal?.addEventListener('abort', cancel, { once: true });
      request = { operation, resolve: resolve as (value: unknown) => void, reject, abort,
        dispose: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); } };
      this.#preparations.push(request);
      // An already started header/body/inflater must reach its full message
      // boundary. Merely seeing GET_INFO between non-final frames is not idle.
      if (!this.#paused && !this.#scheduled && !this.#consuming && this.#receiver._bufferedBytes === 0) this.#tryPrepare();
    });
  }

  /** Unlike close(), wait for actual consumer/preparation frames to exit. */
  async drain(): Promise<void> {
    await Promise.all([this.#consuming, this.#preparing, this.#body.drain()]);
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  accept(data: RawData): void {
    if (this.#closed) return;
    // The client keeps ws's default nodebuffer binaryType. No second message
    // may occupy this slot while a decoded result is still being consumed.
    if (!Buffer.isBuffer(data) || this.#paused) { this.#fail(); return; }
    this.#paused = true;
    this.#receiver._loop = false;
    // Hold Receiver's write callback. Its existing writable high-water mark
    // bounds additional raw socket chunks and applies socket backpressure.
    // Pausing immediately would also hide an otherwise readable EOF.
    this.#wire = data;
    this.#scheduled = setImmediate(() => this.#decode());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const interrupted = this.#paused || this.#body.receiving;
    const cancellation = Error('RPC preparation connection closed');
    this.#preparation?.abort.abort(); this.#preparation?.reject(cancellation);
    for (const pending of this.#preparations.splice(0)) { pending.abort.abort(); pending.reject(cancellation); pending.dispose(); }
    const bodyClosed = this.#body.close();
    this.#transport.removeListener("end", this.#disconnected);
    this.#transport.removeListener("close", this.#disconnected);
    clearImmediate(this.#scheduled);
    this.#scheduled = undefined;
    this.#wire = undefined;
    this.#text = undefined;
    this.#receiver.startLoop = this.#startLoop;
    if (interrupted) {
      // A body/inflater may still own Receiver's writable callback before a
      // complete message exists. Destroy the receiver in all interrupted
      // phases; dropping that callback alone leaves ws.close awaiting finish.
      this.#receiver._loop = false;
      this.#continuation = undefined;
      void bodyClosed.then(() => {
        this.#receiver.destroy(Error("RPC receive boundary closed"));
        this.socket.terminate();
      });
    }
  }

  #park(done: WriteDone): void {
    if (this.#continuation && this.#continuation !== done) {
      this.#fail(); return;
    }
    this.#continuation = done;
  }

  #decode(): void {
    this.#scheduled = undefined;
    if (this.#closed) return;
    try {
      this.#text = this.#wire!.toString("utf8");
      this.#wire = undefined;
      // The entire ws emit/fragment stack and this conversion must return
      // before JSON parsing starts. An immediate, not a microtask, separates
      // the wire+text and text+parsed-result lifetimes.
      this.#scheduled = setImmediate(() => this.#parse());
    } catch { this.#fail(); }
  }

  #parse(): void {
    this.#scheduled = undefined;
    if (this.#closed) return;
    try {
      const consumed = this.dispatch(this.#text!);
      this.#text = undefined;
      // dispatch parses synchronously; its returned promise owns only the
      // consumer's result. Do not keep raw JSON through asynchronous page IO.
      const work = Promise.resolve(consumed).then(() => {}, () => this.#fail());
      this.#consuming = work;
      void work.finally(() => {
        if (this.#consuming === work) this.#consuming = undefined;
        // The consumer's result/frame has returned before a preparation lease
        // or another large decoded message can start.
        setImmediate(() => this.#resume());
      });
    } catch { this.#fail(); }
  }

  #resume(): void {
    if (this.#closed) return;
    if (this.#preparing) return;
    if (this.#tryPrepare()) return;
    this.#paused = false;
    const continuation = this.#continuation;
    this.#continuation = undefined;
    if (continuation) this.#receiver.startLoop(continuation);
    // A buffered next message may already have paused the loop again.
    if (!this.#paused && this.socket.readyState !== WebSocket.CLOSED) this.socket.resume();
  }

  #tryPrepare(): boolean {
    if (this.#closed || this.#preparing || this.#consuming || !this.#preparations.length || !this.#body.atMessageBoundary) return false;
    const preparation = this.#preparations.shift()!;
    this.#preparation = preparation;
    this.#paused = true; this.#receiver._loop = false;
    // Do not allocate preparation objects inside ws's header/emit stack.
    const work = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      preparation.abort.signal.throwIfAborted();
      return preparation.operation(preparation.abort.signal);
    }).then(value => {
      preparation.abort.signal.throwIfAborted(); preparation.resolve(value);
    }).catch(error => preparation.reject(error)).then(async () => {
      preparation.dispose();
      await new Promise<void>(resolve => setImmediate(resolve));
      this.#preparation = undefined; this.#preparing = undefined;
      this.#resume();
    });
    this.#preparing = work;
    return true;
  }

  #fail(): void {
    if (this.#closed) return;
    this.close();
    this.failure();
  }
}
