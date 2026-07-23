import type { BlindRendezvousHello, RendezvousKey } from "@zhixing/core/contracts";
import type { Duplex } from "node:stream";
import { canonicalize } from "./canonical.js";
import { bridgeBlindRelay } from "./blind-relay.js";
import { MeshProtocolError } from "./errors.js";
import { validateBlindRendezvousHello } from "./bootstrap.js";

const MAX_HELLO_BYTES = 512;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_PENDING_RENDEZVOUS = 1_024;

interface PendingRendezvous {
  readonly stream: Duplex;
  readonly timer: NodeJS.Timeout;
  readonly close: () => void;
  readonly error: () => void;
}

export class BlindRendezvousMatcher {
  readonly #pending = new Map<RendezvousKey, PendingRendezvous>();
  readonly #maxPending: number;
  #closed = false;

  constructor(options: { readonly maxPending?: number } = {}) {
    const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_RENDEZVOUS;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new TypeError("Blind rendezvous capacity must be a positive safe integer");
    }
    this.#maxPending = maxPending;
  }

  accept(stream: Duplex, value: unknown): "waiting" | "bridged" {
    if (this.#closed) throw new MeshProtocolError("service-unavailable", "Blind rendezvous matcher is closed");
    const hello = validateBlindRendezvousHello(value);
    const waiting = this.#pending.get(hello.key);
    if (!waiting) {
      if (this.#pending.size >= this.#maxPending) {
        throw new MeshProtocolError(
          "resource-exhausted",
          "Blind rendezvous matcher reached its pending connection limit",
        );
      }
      const close = () => {
        const current = this.#pending.get(hello.key);
        if (current?.stream === stream) {
          this.#pending.delete(hello.key);
          clearTimeout(current.timer);
          stream.removeListener("error", current.error);
        }
      };
      const error = () => close();
      const timer = setTimeout(() => {
        stream.destroy(new MeshProtocolError("request-timeout", "Blind rendezvous expired"));
      }, hello.ttlMs);
      timer.unref();
      stream.once("close", close);
      stream.once("error", error);
      this.#pending.set(hello.key, { stream, timer, close, error });
      return "waiting";
    }
    this.#pending.delete(hello.key);
    clearTimeout(waiting.timer);
    waiting.stream.removeListener("close", waiting.close);
    waiting.stream.removeListener("error", waiting.error);
    void bridgeBlindRelay(waiting.stream, stream).catch((error) => {
      waiting.stream.destroy(error instanceof Error ? error : undefined);
      stream.destroy(error instanceof Error ? error : undefined);
    });
    return "bridged";
  }

  close(reason = new MeshProtocolError("connection-closed", "Blind rendezvous matcher closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.stream.removeListener("close", pending.close);
      pending.stream.removeListener("error", pending.error);
      pending.stream.once("error", () => {});
      pending.stream.destroy(reason);
    }
    this.#pending.clear();
  }

  get waiting(): number {
    return this.#pending.size;
  }
}

export function encodeBlindRendezvousHello(hello: BlindRendezvousHello): Uint8Array {
  const body = Buffer.from(canonicalize(validateBlindRendezvousHello(hello)), "utf8");
  if (body.byteLength > MAX_HELLO_BYTES) throw new TypeError("Blind rendezvous hello exceeds its byte limit");
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

export async function readBlindRendezvousHello(
  stream: Duplex,
  signal: AbortSignal = AbortSignal.timeout(DEFAULT_HELLO_TIMEOUT_MS),
): Promise<BlindRendezvousHello> {
  const header = await readExactly(stream, 4, signal);
  const length = header.readUInt32BE(0);
  if (length < 1 || length > MAX_HELLO_BYTES) {
    throw new MeshProtocolError("invalid-frame", "Blind rendezvous hello length is invalid");
  }
  const body = await readExactly(stream, length, signal);
  const text = body.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MeshProtocolError("invalid-frame", "Blind rendezvous hello is not JSON");
  }
  if (canonicalize(value) !== text) {
    throw new MeshProtocolError("invalid-frame", "Blind rendezvous hello is not canonical");
  }
  return validateBlindRendezvousHello(value);
}

async function readExactly(
  stream: Duplex,
  bytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < bytes) {
    const chunk = stream.read(bytes - total) as Buffer | null;
    if (chunk) {
      chunks.push(chunk);
      total += chunk.byteLength;
      continue;
    }
    await waitReadable(stream, signal);
  }
  return Buffer.concat(chunks, bytes);
}

function waitReadable(stream: Duplex, signal: AbortSignal): Promise<void> {
  if (stream.destroyed) return Promise.reject(new MeshProtocolError("connection-closed", "Blind rendezvous stream closed"));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener("readable", onReadable);
      stream.removeListener("end", onEnd);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onReadable = () => { cleanup(); resolve(); };
    const onEnd = () => { cleanup(); reject(new MeshProtocolError("connection-closed", "Blind rendezvous stream ended")); };
    const onClose = () => { cleanup(); reject(new MeshProtocolError("connection-closed", "Blind rendezvous stream closed")); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAbort = () => {
      cleanup();
      stream.destroy();
      reject(signal.reason);
    };
    stream.once("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
