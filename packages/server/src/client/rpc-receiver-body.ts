// Finite body-storage seam for the pinned ws 8.20.0 client Receiver. ws retains
// ownership of headers, masking rules, UTF-8, control frames and compression.
// These state values belong to that pinned Receiver, not the wire protocol.
const GET_INFO = 0, GET_DATA = 4, INFLATING = 5;
const PAGE_BYTES = 32 * 1024;
type Done = (error?: Error | null) => void;
type Inflated = (error: Error | null, data: Buffer) => void;

export interface RpcReceiverEdge {
  _loop: boolean;
  _state: number;
  _opcode: number;
  _payloadLength: number;
  _bufferedBytes: number;
  _compressed: boolean;
  _fin: boolean;
  _fragmented?: number;
  _maxPayload: number;
  _messageLength: number;
  _fragments: Buffer[];
  _extensions: Record<string, { decompress(data: Buffer, fin: boolean, done: (error: Error | null, data: Buffer) => void): void }>;
  consume(bytes: number): Buffer;
  getData(done: Done): void;
  dataMessage(done: Done): void;
  startLoop(done: Done): void;
  destroy(error?: Error): void;
  createError(type: typeof RangeError, message: string, prefix: boolean, status: number, code: string): Error;
}

/** Keep both frame input and fragment metadata bounded before ws emits a
 * completed message. In particular, ws's inflater callback retains its input
 * through output concatenation; passing it a whole large frame can retain
 * three message-sized copies before an outer message handler can intervene. */
export class RpcReceiverBody {
  readonly #getData: RpcReceiverEdge["getData"];
  #pages: Buffer[] = [];
  #tailBytes = 0;
  #length = 0;
  #closed = false;
  #scheduled?: ReturnType<typeof setImmediate>;
  #inflation?: Promise<void>;

  constructor(readonly receiver: RpcReceiverEdge) {
    this.#getData = receiver.getData;
    receiver.getData = done => this.#read(done);
  }

  /** Includes incomplete headers, non-final frames (even empty ones), active
   * inflation and the final decoded frame waiting for its immediate. */
  get receiving(): boolean {
    return this.receiver._state !== GET_INFO || this.receiver._bufferedBytes > 0 ||
      this.#length > 0 || !!this.receiver._fragmented || !!this.#scheduled;
  }

  close(): Promise<void> {
    this.#closed = true;
    clearImmediate(this.#scheduled);
    this.#pages = [];
    this.receiver.getData = this.#getData;
    // Destroying Receiver lets ws emitClose clean up the inflater. Its flush
    // callback still reads extension._inflate, so first let that callback exit.
    return this.#inflation ?? Promise.resolve();
  }

  #read(done: Done): void {
    const receiver = this.receiver;
    if (receiver._opcode > 7) { this.#getData.call(receiver, done); return; }
    if (receiver._payloadLength && !receiver._bufferedBytes) { receiver._loop = false; return; }
    const bytes = Math.min(receiver._payloadLength, receiver._bufferedBytes, PAGE_BYTES);
    const data = bytes ? receiver.consume(bytes) : Buffer.alloc(0);
    receiver._payloadLength -= bytes;
    const frameComplete = receiver._payloadLength === 0;
    if (!receiver._compressed) {
      if (!this.#append(data, done)) return;
      if (frameComplete) this.#finishFrame(done);
      return;
    }
    receiver._state = INFLATING;
    this.#inflate(data, frameComplete && receiver._fin, (error, decoded) => {
      if (this.#closed) return;
      if (error) { done(error); return; }
      if (!this.#append(decoded, done)) return;
      if (frameComplete && receiver._fin) {
        // Let the inflater's input/output callbacks return before ws performs
        // the final page concatenation. No GC or release guess is required.
        this.#scheduled = setImmediate(() => {
          this.#scheduled = undefined;
          if (this.#closed) return;
          this.#finishFrame(done);
          if (receiver._state === GET_INFO) receiver.startLoop(done);
        });
        return;
      }
      receiver._state = frameComplete ? GET_INFO : GET_DATA;
      receiver.startLoop(done);
    });
  }

  #inflate(data: Buffer, fin: boolean, done: Inflated): void {
    const extension = this.receiver._extensions['permessage-deflate']!;
    let retired!: () => void;
    this.#inflation = new Promise<void>(resolve => { retired = resolve; });
    // Keep even a job queued behind ws's zlib limiter charged. Receiver's
    // writable completion stays held until this real callback has returned.
    extension.decompress(data, fin, (error, decoded) => {
      try { done(error, decoded); }
      finally { setImmediate(retired); }
    });
  }

  #append(data: Buffer, done: Done): boolean {
    const receiver = this.receiver;
    if (receiver._maxPayload > 0 && this.#length + data.length > receiver._maxPayload) {
      done(receiver.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
      return false;
    }
    this.#length += data.length;
    receiver._messageLength = this.#length;
    for (let offset = 0; offset < data.length;) {
      if (!this.#pages.length || this.#tailBytes === PAGE_BYTES) {
        this.#pages.push(Buffer.allocUnsafe(PAGE_BYTES)); this.#tailBytes = 0;
      }
      const count = Math.min(PAGE_BYTES - this.#tailBytes, data.length - offset);
      data.copy(this.#pages.at(-1)!, this.#tailBytes, offset, offset + count);
      this.#tailBytes += count; offset += count;
    }
    return true;
  }

  #finishFrame(done: Done): void {
    const receiver = this.receiver;
    if (!receiver._fin) { receiver._state = GET_INFO; return; }
    if (this.#pages.length && this.#tailBytes !== PAGE_BYTES) {
      this.#pages[this.#pages.length - 1] = this.#pages.at(-1)!.subarray(0, this.#tailBytes);
    }
    receiver._fragments = this.#pages;
    this.#pages = []; this.#tailBytes = 0; this.#length = 0;
    receiver.dataMessage(done);
  }
}
