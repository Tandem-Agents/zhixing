import { expect, it, onTestFinished, vi } from 'vitest';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempDir } from '@zhixing/test-utils';
import { FileAuthorityCommitLog } from '../commit-log.js';
import { FileArtifactStore } from '../artifact-store.js';
import { readWalVersion } from '../verified-wal-view.js';

// Reproduce the admitted Node24.0/Windows split on every test platform.
// Only path-stat identity differs; the physical file/descriptor is unchanged.
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, stat: async (...args: Parameters<typeof real.stat>) => {
    const value = await real.stat(...args);
    if (typeof value.dev === 'bigint') return { ...value, dev: value.dev + 1n };
    return value;
  } };
});

it('uses identical file identity and nanosecond timestamps for path and borrowed handle', async () => {
  const root = await createTempDir('wal-fstat-version'), file = path.join(root, 'wal');
  await writeFile(file, 'metadata-only');
  const handle = await open(file, 'r');
  try {
    const direct = await readWalVersion(handle), fromPath = await readWalVersion(file);
    expect(fromPath).toEqual(direct);
    expect((await handle.stat({ bigint: true })).ino).toBe(direct.ino); // Borrowed handle remains open.
  } finally { await handle.close(); }
});

it('admits first and subsequent durable commits with path-stat/fstat identity divergence', async () => {
  const root = await createTempDir('wal-fstat-append');
  const log = new FileAuthorityCommitLog(path.join(root, 'authority'), new FileArtifactStore(path.join(root, 'artifacts')));
  onTestFinished(() => log.stopStorageMaintenance());
  await expect(log.append([{ stream: 'control', body: { fixture: 'first' } }])).resolves.toMatchObject({ lsn: 1 });
  await expect(log.append([{ stream: 'control', body: { fixture: 'second' } }])).resolves.toMatchObject({ lsn: 2 });
  expect((await log.readSnapshot()).commits).toHaveLength(2);
});
