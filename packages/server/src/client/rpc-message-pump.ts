import { WebSocket, type RawData } from "ws";
import type { Socket } from "node:net";
import { RpcReceiverBody, type RpcReceiverEdge } from "./rpc-receiver-body.js";

type WriteDone = (error?: Error | null) => void;

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
    this.#body = new RpcReceiverBody(receiver);
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
      void Promise.resolve(consumed).then(() => this.#resume(), () => this.#fail());
    } catch { this.#fail(); }
  }

  #resume(): void {
    if (this.#closed) return;
    this.#paused = false;
    const continuation = this.#continuation;
    this.#continuation = undefined;
    if (continuation) this.#receiver.startLoop(continuation);
    // A buffered next message may already have paused the loop again.
    if (!this.#paused && this.socket.readyState !== WebSocket.CLOSED) this.socket.resume();
  }

  #fail(): void {
    if (this.#closed) return;
    this.close();
    this.failure();
  }
}
