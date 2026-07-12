import type { Duplex } from "node:stream";
import { MeshProtocolError } from "./errors.js";
import { assertRuntimeTimerDelay } from "./runtime-time.js";

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export interface BlindRelayOptions {
  readonly signal?: AbortSignal;
  readonly drainTimeoutMs?: number;
}

/** Relays opaque TLS records byte-for-byte and never terminates either TLS session. */
export async function bridgeBlindRelay(
  left: Duplex,
  right: Duplex,
  options: BlindRelayOptions = {},
): Promise<void> {
  const { signal } = options;
  const drainTimeoutMs = assertRuntimeTimerDelay(
    options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    "Blind relay drain timeout",
  );
  if (signal?.aborted) {
    left.destroy();
    right.destroy();
    return;
  }
  left.pipe(right);
  right.pipe(left);
  let drainTimer: NodeJS.Timeout | undefined;
  try {
    const completion = Promise.all([
      waitForStreamSide(left, "readable", signal),
      waitForStreamSide(left, "writable", signal),
      waitForStreamSide(right, "readable", signal),
      waitForStreamSide(right, "writable", signal),
    ]);
    const drainExpired = Promise.race([
      waitForStreamSide(left, "readable", signal),
      waitForStreamSide(right, "readable", signal),
    ]).then(
      () =>
        new Promise<never>((_resolve, reject) => {
          drainTimer = setTimeout(() => {
            reject(
              new MeshProtocolError(
                "connection-closed",
                "Blind relay peer did not finish within the drain deadline",
              ),
            );
          }, drainTimeoutMs);
          drainTimer.unref();
        }),
    );
    await Promise.race([completion, drainExpired]);
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    if (drainTimer) clearTimeout(drainTimer);
    left.unpipe(right);
    right.unpipe(left);
    if (!left.destroyed) left.destroy();
    if (!right.destroyed) right.destroy();
  }
}

function waitForStreamSide(
  stream: Duplex,
  side: "readable" | "writable",
  signal?: AbortSignal,
): Promise<void> {
  if (side === "readable" ? stream.readableEnded : stream.writableFinished) {
    return Promise.resolve();
  }
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const event = side === "readable" ? "end" : "finish";
    const cleanup = () => {
      stream.removeListener(event, onComplete);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onComplete = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      const complete = side === "readable" ? stream.readableEnded : stream.writableFinished;
      cleanup();
      if (complete) resolve();
      else reject(new Error(`Blind relay ${side} side closed before draining`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal!));
    };
    stream.once(event, onComplete);
    stream.once("close", onClose);
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Operation aborted", "AbortError");
}
