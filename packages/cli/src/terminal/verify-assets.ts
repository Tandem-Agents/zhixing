import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { TerminalChannelRetiredError } from '@zhixing/terminal-ui/channel';
import { beginLogPhase, type LogRecordPort } from '@zhixing/core/logging';

interface Artifact { readonly name: string; readonly bytes: number; readonly sha256: string }

/** Only S's fixed artifact groups call this: five files, at most five MiB.
 * Failure closes admission promptly; settlement still owns every open handle. */
export async function verifyTerminalAssets(
  distribution: string, artifacts: readonly Artifact[], names: readonly string[],
  assertLive: () => void, onFailure: (error: unknown) => void,
  records?: LogRecordPort,
): Promise<void> {
  const results = await Promise.allSettled(names.map(async name => {
    const phase = records ? beginLogPhase(records, `terminal.verify.${name}`, { waitFor: 'fixed-artifact-io-and-hash' }) : undefined;
    const start = performance.now();
    const timing = { asset: name, durationMs: 0, openMs: 0, statMs: 0, readMs: 0, hashMs: 0, closeMs: 0, bytes: 0, reads: 0 };
    let result: 'success' | 'failure' | 'cancelled' = 'success';
    let reported = false;
    const report = (error: unknown) => {
      if (!reported && !(error instanceof TerminalChannelRetiredError)) { reported = true; onFailure(error); }
    };
    try {
      assertLive();
      const item = artifacts.find(value => value.name === name);
      if (!item || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw Error('terminal-package-manifest');
      const digest = createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let at = performance.now();
      const handle = await open(path.join(distribution, name), 'r').finally(() => { timing.openMs = performance.now() - at; });
      try {
        assertLive();
        at = performance.now();
        const initial = await handle.stat().finally(() => { timing.statMs += performance.now() - at; });
        if (initial.size !== item.bytes) throw Error('terminal-package-integrity');
        let offset = 0;
        while (offset < item.bytes) {
          assertLive();
          at = performance.now(); timing.reads++;
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, item.bytes - offset), offset)
            .finally(() => { timing.readMs += performance.now() - at; });
          if (!bytesRead) throw Error('terminal-package-integrity');
          at = performance.now();
          digest.update(buffer.subarray(0, bytesRead));
          timing.hashMs += performance.now() - at; timing.bytes += bytesRead; offset += bytesRead;
        }
        at = performance.now();
        const final = await handle.stat().finally(() => { timing.statMs += performance.now() - at; });
        if (final.size !== item.bytes) throw Error('terminal-package-integrity');
        if (digest.digest('hex') !== item.sha256) throw Error('terminal-package-integrity');
      } catch (error) {
        report(error); throw error;
      } finally {
        at = performance.now();
        await handle.close().finally(() => { timing.closeMs = performance.now() - at; });
      }
      phase?.finish();
    } catch (error) {
      result = error instanceof TerminalChannelRetiredError ? 'cancelled' : 'failure';
      phase?.finish(result === 'cancelled' ? new DOMException('terminal-retired', 'AbortError') : error);
      report(error);
      throw error;
    } finally {
      timing.durationMs = performance.now() - start;
      try { records?.record({ event: 'terminalAssetVerification', result, data: timing }); }
      catch { /* Observation cannot change integrity or handle ownership. */ }
    }
  }));
  // Cancellation must not hide a different file's read/close/integrity failure.
  const failed = results.find(result => result.status === 'rejected' && !(result.reason instanceof TerminalChannelRetiredError))
    ?? results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
