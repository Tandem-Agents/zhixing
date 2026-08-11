const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 30_000;

export interface ConnectionLifetimeObligationOptions {
  readonly connectionClosed?: Promise<unknown>;
  readonly stopSignal?: AbortSignal;
  readonly attempt: (signal: AbortSignal) => void | Promise<void>;
  readonly shouldRetry: (error: unknown) => boolean;
  readonly onError?: (error: unknown) => void;
}

/** Retains a connection-scoped obligation until success, stable rejection or closure. */
export async function fulfillConnectionLifetimeObligation(
  options: ConnectionLifetimeObligationOptions,
): Promise<void> {
  const controller = new AbortController();
  const abortFromStop = () => controller.abort(options.stopSignal?.reason);
  if (options.stopSignal?.aborted) abortFromStop();
  else options.stopSignal?.addEventListener("abort", abortFromStop, { once: true });
  if (options.connectionClosed) {
    const abortFromConnection = () => {
      controller.abort(new Error("Authenticated mesh connection closed"));
    };
    void options.connectionClosed.then(abortFromConnection, abortFromConnection);
  }
  let retryDelayMs = INITIAL_RETRY_MS;
  try {
    while (!controller.signal.aborted) {
      try {
        await options.attempt(controller.signal);
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        options.onError?.(error);
        if (!options.shouldRetry(error)) return;
        await abortableDelay(retryDelayMs, controller.signal);
        retryDelayMs = Math.min(MAX_RETRY_MS, retryDelayMs * 2);
      }
    }
  } finally {
    options.stopSignal?.removeEventListener("abort", abortFromStop);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}
