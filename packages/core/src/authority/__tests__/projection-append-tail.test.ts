import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTempDir } from '@zhixing/test-utils';
import { SerialTaskQueue } from '../../persistence/index.js';
import { FileDurableProjectionIndex } from '../durable-projection-index.js';

const checkpoint = (lsn: number) => ({ logId: 'append-tail-test', lsn, frameEndOffset: 64 + lsn,
  prefixDigest: `sha256:${lsn.toString(16).padStart(64, '0')}` as const });
const manifest = async (root: string) => JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

it('keeps optional file retirement outside a source-exclusive operation and drains it afterwards', async () => {
  const root = await createTempDir('append-retirement'), queue = new SerialTaskQueue(), scope = new AsyncLocalStorage<boolean>();
  const exclusive = <T>(operation: () => Promise<T>) => queue.run(() => scope.run(true, operation));
  const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: 'append-retirement', reducerVersion: 1,
    withSourceLock: operation => scope.getStore() ? operation() : exclusive(operation),
    runDetached: operation => scope.exit(operation) });
  try {
    await index.initialize({ authority: checkpoint(0) });
    for (let n = 1; n <= 5; n++) {
      index.publish(await index.prepare([{ kind: 'put', key: 'current', value: n }]), { authority: checkpoint(n) });
      await index.flush({ compact: false });
    }
    await exclusive(async () => {
      await index.flush();
      const before = await manifest(root);
      expect(before.retirementRoot).toBeDefined();
      expect(await index.get('current')).toBe(5);
      expect((await manifest(root)).generation).toBe(before.generation);
    });
    const deadline = Date.now() + 10_000;
    while ((await manifest(root)).retirementRoot && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect((await manifest(root)).retirementRoot).toBeUndefined();
    expect(await index.get('current')).toBe(5);
  } finally { await index.stopStorageMaintenance(); }
}, 30_000);

it('replaces an unchanged base range boundary without rewriting unrelated directory branches', async () => {
  const root = await createTempDir('append-directory-replacement');
  const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: 'append-directory', reducerVersion: 1,
    allowSegmentReclamation: false });
  try {
    await index.initialize({ authority: checkpoint(0) });
    for (let batch = 0; batch < 5; batch++) {
      const changes = Array.from({ length: 512 }, (_, n) => ({ kind: 'put' as const,
        key: `key-${String(batch * 512 + n).padStart(5, '0')}`, value: 'original' }));
      index.publish(await index.prepare(changes), { authority: checkpoint(batch + 1) });
      await index.flush({ compact: false });
    }
    await index.flush();
    const before = await manifest(root);
    const oldPage = JSON.parse(await readFile(path.join(root, `directory-${before.baseRoot.id}.json`), 'utf8'));
    const key = oldPage.descriptor.minKey;
    for (let n = 6; n <= 10; n++) {
      index.publish(await index.prepare([{ kind: 'put', key, value: `updated-${n}` }]), { authority: checkpoint(n) });
      await index.flush({ compact: false });
    }
    const oldFiles = new Set(await readdir(root));
    await index.flush();
    const addedDirectories = (await readdir(root)).filter(file => file.startsWith('directory-') && !oldFiles.has(file));
    expect(addedDirectories).toHaveLength(1);
    const after = await manifest(root);
    const newPage = JSON.parse(await readFile(path.join(root, `directory-${after.baseRoot.id}.json`), 'utf8'));
    expect(newPage.left).toEqual(oldPage.left); expect(newPage.right).toEqual(oldPage.right);
    expect(await index.get(key)).toBe('updated-10');
    expect(await index.get('key-02559')).toBe('original');
  } finally { await index.stopStorageMaintenance(); }
}, 60_000);
