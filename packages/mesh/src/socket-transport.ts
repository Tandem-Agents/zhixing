import type { TLSSocket } from "node:tls";
import { MeshProtocolError } from "./errors.js";
import { assertRuntimeTimerDelay } from "./runtime-time.js";
import type { MeshFrameTransport } from "./transport.js";

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_FRAMES = 1_024;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const INPUT_PAGE_BYTES = 16 * 1024;
export const MESH_ALPN_PROTOCOL = "zhixing-mesh";

interface PendingReceive {
  resolve(frame: Uint8Array): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort?: () => void;
}

export interface SocketFrameTransportOptions {
  readonly maxFrameBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedFrames?: number;
  readonly closeTimeoutMs?: number;
}

/** Internal length-prefixed transport for an already authenticated mesh TLS socket. */
export class SocketFrameTransport implements MeshFrameTransport {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly frames = new FrameQueue();
  private readonly waiters: PendingReceive[] = [];
  private readonly input = new PagedByteQueue();
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly maxBufferedFrames: number;
  private readonly closeTimeoutMs: number;
  private readonly pauseBytes: number;
  private readonly resumeBytes: number;
  private readonly pauseFrames: number;
  private readonly resumeFrames: number;
  private failure: Error | undefined;
  private ended = false;
  private flowPaused = false;

  constructor(
    private readonly socket: TLSSocket,
    options: SocketFrameTransportOptions = {},
  ) {
    assertAuthenticatedMeshSocket(socket);
    this.maxFrameBytes = positiveInteger(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      "Mesh frame limit",
    );
    this.maxBufferedBytes = positiveInteger(
      options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      "Mesh buffered byte limit",
    );
    this.maxBufferedFrames = positiveInteger(
      options.maxBufferedFrames ?? DEFAULT_MAX_BUFFERED_FRAMES,
      "Mesh buffered frame limit",
    );
    this.closeTimeoutMs = assertRuntimeTimerDelay(
      options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      "Mesh close timeout",
    );
    if (this.maxBufferedBytes < this.maxFrameBytes + 4) {
      throw new TypeError("Mesh buffered byte limit must hold one maximum frame");
    }
    this.pauseBytes = Math.max(
      this.maxFrameBytes + 4,
      Math.floor(this.maxBufferedBytes * 0.75),
    );
    this.resumeBytes = Math.floor(this.pauseBytes / 2);
    this.pauseFrames = Math.max(1, Math.floor(this.maxBufferedFrames * 0.75));
    this.resumeFrames = Math.floor(this.pauseFrames / 2);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    socket.on("data", (chunk) => this.onData(chunk));
    socket.once("end", () => {
      this.pump(true);
      if (!this.ended && this.input.byteLength > 0) {
        this.protocolFailure("Mesh socket ended with a truncated frame");
      } else {
        this.fail();
      }
      if (!socket.writableEnded) socket.end();
    });
    socket.once("error", (error) => {
      this.fail(error);
      if (!socket.destroyed) socket.destroy();
    });
    socket.once("close", () => {
      this.fail();
      this.resolveClosed();
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.ended) throw this.failure ?? closedError();
    if (frame.byteLength > this.maxFrameBytes) {
      throw new MeshProtocolError("invalid-frame", "Mesh frame exceeds its size limit");
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(frame.byteLength, 0);
    const packet = Buffer.concat([header, Buffer.from(frame)]);
    try {
      await new Promise<void>((resolve, reject) => {
        this.socket.write(packet, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      const failure = error instanceof Error ? error : closedError();
      this.fail(failure);
      this.socket.destroy(failure);
      throw failure;
    }
  }

  receive(signal?: AbortSignal): Promise<Uint8Array> {
    const queued = this.frames.shift();
    if (queued !== undefined) {
      this.pump();
      this.updateFlowControl();
      return Promise.resolve(queued);
    }
    if (this.ended) return Promise.reject(this.failure ?? closedError());
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const pending: PendingReceive = { resolve, reject, signal };
      if (signal) {
        pending.abort = () => {
          this.removeWaiter(pending);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.waiters.push(pending);
      this.pump();
      this.updateFlowControl();
    });
  }

  async close(reason?: Error): Promise<void> {
    if (!this.ended) {
      this.fail(reason);
      if (reason) this.socket.destroy(reason);
      else this.socket.end();
    }
    const timer = setTimeout(() => {
      if (!this.socket.destroyed) this.socket.destroy();
    }, this.closeTimeoutMs);
    timer.unref();
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }

  private onData(chunk: Buffer): void {
    if (this.ended) return;
    if (this.bufferedBytes + chunk.byteLength > this.maxBufferedBytes) {
      this.protocolFailure("Mesh receive buffer exceeds its byte limit");
      return;
    }
    this.input.push(chunk);
    this.pump();
    this.updateFlowControl();
  }

  private pump(drainInput = false): void {
    while (!this.ended && this.input.byteLength >= 4) {
      const length = this.input.peekUInt32BE();
      if (length > this.maxFrameBytes) {
        this.protocolFailure("Incoming mesh frame exceeds its size limit");
        return;
      }
      if (this.input.byteLength < length + 4) return;
      const waiter = this.waiters.shift();
      if (!waiter && !drainInput && this.frames.length >= this.pauseFrames) return;

      this.input.discard(4);
      const frame = this.input.read(length);
      if (waiter) {
        this.detachAbort(waiter);
        waiter.resolve(frame);
      } else {
        if (
          this.frames.length >= this.maxBufferedFrames ||
          this.frames.byteLength + frame.byteLength > this.maxBufferedBytes
        ) {
          this.protocolFailure("Mesh receive buffer exceeds its frame limit");
          return;
        }
        this.frames.push(frame);
      }
    }
  }

  private updateFlowControl(): void {
    if (this.ended) return;
    const shouldPause =
      this.bufferedBytes >= this.pauseBytes || this.frames.length >= this.pauseFrames;
    if (shouldPause && !this.flowPaused) {
      this.flowPaused = true;
      this.socket.pause();
      return;
    }
    const shouldResume =
      this.bufferedBytes <= this.resumeBytes && this.frames.length <= this.resumeFrames;
    if (!shouldPause && shouldResume && this.flowPaused) {
      this.flowPaused = false;
      this.socket.resume();
    }
  }

  private get bufferedBytes(): number {
    return this.frames.byteLength + this.input.byteLength;
  }

  private protocolFailure(message: string): void {
    const error = new MeshProtocolError("invalid-frame", message);
    this.fail(error);
    this.socket.destroy(error);
  }

  private fail(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      this.detachAbort(waiter);
      waiter.reject(error ?? closedError());
    }
  }

  private removeWaiter(target: PendingReceive): void {
    const index = this.waiters.indexOf(target);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private detachAbort(waiter: PendingReceive): void {
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
  }
}

class PagedByteQueue {
  byteLength = 0;
  private readonly pages = new Map<number, { buffer: Buffer; end: number }>();
  private headPage = 0;
  private tailPage = -1;
  private headOffset = 0;

  push(chunk: Buffer): void {
    let sourceOffset = 0;
    while (sourceOffset < chunk.byteLength) {
      let tail = this.pages.get(this.tailPage);
      if (!tail || tail.end === INPUT_PAGE_BYTES) {
        this.tailPage += 1;
        tail = { buffer: Buffer.allocUnsafe(INPUT_PAGE_BYTES), end: 0 };
        this.pages.set(this.tailPage, tail);
      }
      const copied = Math.min(
        INPUT_PAGE_BYTES - tail.end,
        chunk.byteLength - sourceOffset,
      );
      chunk.copy(tail.buffer, tail.end, sourceOffset, sourceOffset + copied);
      tail.end += copied;
      sourceOffset += copied;
      this.byteLength += copied;
    }
  }

  peekUInt32BE(): number {
    const head = this.pages.get(this.headPage)!;
    if (head.end - this.headOffset >= 4) return head.buffer.readUInt32BE(this.headOffset);
    const header = this.copy(4, false);
    return header.readUInt32BE(0);
  }

  read(length: number): Uint8Array {
    return Uint8Array.from(this.copy(length, true));
  }

  discard(length: number): void {
    this.consume(length);
  }

  private copy(length: number, consume: boolean): Buffer {
    if (length > this.byteLength) throw new RangeError("Mesh byte queue underflow");
    const output = Buffer.allocUnsafe(length);
    let outputOffset = 0;
    let pageIndex = this.headPage;
    let pageOffset = this.headOffset;
    while (outputOffset < length) {
      const page = this.pages.get(pageIndex)!;
      const available = page.end - pageOffset;
      const copied = Math.min(available, length - outputOffset);
      page.buffer.copy(output, outputOffset, pageOffset, pageOffset + copied);
      outputOffset += copied;
      pageIndex += 1;
      pageOffset = 0;
    }
    if (consume) this.consume(length);
    return output;
  }

  private consume(length: number): void {
    if (length > this.byteLength) throw new RangeError("Mesh byte queue underflow");
    this.byteLength -= length;
    while (length > 0) {
      const head = this.pages.get(this.headPage)!;
      const available = head.end - this.headOffset;
      if (length < available) {
        this.headOffset += length;
        return;
      }
      length -= available;
      this.pages.delete(this.headPage);
      this.headPage += 1;
      this.headOffset = 0;
    }
    if (this.byteLength === 0) {
      this.pages.clear();
      this.headPage = 0;
      this.tailPage = -1;
    }
  }
}

class FrameQueue {
  byteLength = 0;
  private readonly values = new Map<number, Uint8Array>();
  private head = 0;
  private tail = 0;

  get length(): number {
    return this.tail - this.head;
  }

  push(value: Uint8Array): void {
    this.values.set(this.tail, value);
    this.tail += 1;
    this.byteLength += value.byteLength;
  }

  shift(): Uint8Array | undefined {
    if (this.head === this.tail) return undefined;
    const value = this.values.get(this.head)!;
    this.values.delete(this.head);
    this.head += 1;
    this.byteLength -= value.byteLength;
    if (this.head === this.tail) {
      this.head = 0;
      this.tail = 0;
    }
    return value;
  }
}

function assertAuthenticatedMeshSocket(socket: TLSSocket): void {
  if (
    !socket.encrypted ||
    !socket.authorized ||
    socket.getProtocol() !== "TLSv1.3" ||
    socket.alpnProtocol !== MESH_ALPN_PROTOCOL
  ) {
    throw new TypeError("Mesh frames require an authenticated TLS 1.3 mesh socket");
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function closedError(): MeshProtocolError {
  return new MeshProtocolError("connection-closed", "Mesh socket is closed");
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Operation aborted", "AbortError");
}
