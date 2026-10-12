import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createTempDir } from '@zhixing/test-utils';
import { FileDurableProjectionIndex } from '../durable-projection-index.js';
import { runWithMaintenanceUrgency } from '../../resources/maintenance-context.js';
const fault = vi.hoisted(() => ({ mode: '' as string, attempts: 0, controller: undefined as AbortController | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (source: string, target: string) => {
    if (fault.mode && path.basename(target) === 'write-intent.json' && ++fault.attempts >= 2) {
      if (fault.mode === 'transient') fault.mode = '';
      if (fault.mode === 'cancel') fault.controller!.abort(new Error('maintenance stopped'));
      throw Object.assign(new Error('sharing conflict'), { code: 'EPERM', syscall: 'rename' });
    }
    return actual.rename(source, target);
  } };
});
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => { fault.mode = ''; fault.controller = undefined; Object.defineProperty(process, 'platform', platform); });
const checkpoint = (lsn: number) => ({ logId: 'test', lsn, frameEndOffset: 64 + lsn, prefixDigest: 'sha256:' + lsn.toString(16).padStart(64, '0') });
it.each(['transient', 'persistent', 'cancel'])('preserves manifest and recovers the same projection after %s replacement failure', async mode => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const rootDir = await createTempDir('projection-replacement');
  const options = { rootDir, projectionId: 'replacement', reducerVersion: 1 };
  const index = new FileDurableProjectionIndex(options);
  let reopened: FileDurableProjectionIndex | undefined;
  try {
    await index.initialize({ source: checkpoint(0) });
    index.publish(await index.prepare([{ kind: 'put', key: 'value', value: 1 }]), { source: checkpoint(1) });
    await index.flush();
    const previous = await readFile(path.join(rootDir, 'manifest.json'), 'utf8');
    index.publish(await index.prepare([{ kind: 'put', key: 'value', value: 2 }]), { source: checkpoint(2) });
    fault.mode = mode; fault.attempts = 0; fault.controller = new AbortController();
    const result = runWithMaintenanceUrgency(() => 'recovery', fault.controller.signal, () => index.flush());
    if (mode === 'transient') await expect(result).resolves.toBeUndefined();
    else { await expect(result).rejects.toThrow(); expect(await readFile(path.join(rootDir, 'manifest.json'), 'utf8')).toBe(previous); }
    expect(fault.attempts).toBeGreaterThanOrEqual(2); fault.mode = '';
    await index.stopStorageMaintenance();
    reopened = new FileDurableProjectionIndex(options); await reopened.initialize({ source: checkpoint(0) });
    await expect(reopened.get('value')).resolves.toBe(mode === 'transient' ? 2 : 1);
    reopened.publish(await reopened.prepare([{ kind: 'put', key: 'value', value: 3 }]), { source: checkpoint(3) });
    await reopened.flush(); await expect(reopened.get('value')).resolves.toBe(3);
  } finally { fault.mode = ''; await index.stopStorageMaintenance(); await reopened?.stopStorageMaintenance(); }
}, 10000);
