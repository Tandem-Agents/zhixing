import { AuthorityStorageError } from "@zhixing/core/authority";
import { shouldRetryRemoteObligation } from "./remote-obligation-failure.js";

/** Retains a durable obligation across transient local or remote failures. */
export async function retryDurableObligation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let delayMs = 100;
  while (!signal?.aborted) {
    try {
      return await abortableOperation(operation, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Durable obligation was aborted");
      }
      if (
        error instanceof AuthorityStorageError ||
        !shouldRetryRemoteObligation(error)
      ) {
        throw error;
      }
      await abortableDelay(delayMs, signal);
      delayMs = Math.min(delayMs * 2, 5_000);
    }
  }
  throw signal.reason ?? new Error("Durable obligation was aborted");
}

function abortableOperation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new Error("Durable obligation was aborted"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new Error("Durable obligation was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new Error("Durable obligation was aborted"),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Durable obligation was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
