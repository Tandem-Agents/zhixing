import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Replace an already closed temporary file under the caller's writer lock.
 * Windows readers without FILE_SHARE_DELETE can briefly block rename. Retry
 * only that atomic step; never remove the destination or rewrite the input. */
export async function replaceFile(source: string, destination: string, options: {
  readonly signal?: AbortSignal;
  readonly beforeAttempt?: () => void;
} = {}): Promise<void> {
  const started = performance.now();
  for (let attempt = 0;; attempt++) {
    options.signal?.throwIfAborted();
    options.beforeAttempt?.();
    try { await rename(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const remaining = 1_000 - (performance.now() - started);
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || remaining <= 0 || attempt >= 10) {
        // Capture the internal caller as well as the original OS operation/code.
        throw new Error('Atomic file replacement failed', { cause: error });
      }
      await delay(Math.min(remaining, 10 * 2 ** Math.min(attempt, 4)), undefined, { signal: options.signal });
    }
  }
}
