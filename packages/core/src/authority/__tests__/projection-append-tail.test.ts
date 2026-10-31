import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTempDir } from '@zhixing/test-utils';
import { SerialTaskQueue } from '../../persistence/index.js';
import { createDefaultDeviceCapacityPolicy, DefaultDeviceCapacityArbiter, DefaultStorageMaintenanceGovernor, runInMaintenanceContext,
  type StorageMaintenanceGovernorPort } from '../../resources/index.js';
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

/**
 * 后台拿不到容量：关闭时后台紧急度的步骤申请立即回背压（与锁内零等待准入同一语义，不在锁内等），续跑按规则稍后重试；
 * 前台照常准入。开闸后后台照常准入。
 */
function gatedBackground() {
  const defaults = createDefaultDeviceCapacityPolicy();
  const inner = new DefaultStorageMaintenanceGovernor({ capacity: new DefaultDeviceCapacityArbiter({ policy: defaults,
    probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: 32 * 1024 ** 2, temporaryBytesAvailable: 8 * 1024 ** 3 }) }) });
  let opened = false;
  const counts = { refused: 0, background: 0 };
  const port: StorageMaintenanceGovernorPort = {
    acquire: async (request, abort) => {
      if (request.urgency === 'background') {
        counts.background++;
        if (!opened) {
          counts.refused++;
          return { kind: 'backpressured', blockedBy: 'slots', retryAfterMs: 20 };
        }
      }
      return inner.acquire(request, abort);
    },
    snapshot: () => inner.snapshot(),
  };
  return { port, counts, open: () => { opened = true; } };
}

it('leaves file retirement a normal stop did not finish to the next instance: its foreground pays a fixed amount, the background the rest', async () => {
  // 正常停止不等后台清理：后台续跑被挡住时，多轮整理的退役债务累积在清单上并随停止保留。冷开的前台对这份遗留债务
  // 至多付首个触发者的固定额度（每次触发至多 2 步），与债务大小无关；其余由后台按步续做到清空，值照常可读
  const root = await createTempDir('append-retirement-debt'), queue = new SerialTaskQueue(), scope = new AsyncLocalStorage<boolean>();
  const exclusive = <T>(operation: () => Promise<T>) => queue.run(() => scope.run(true, operation));
  const create = (storageMaintenance: StorageMaintenanceGovernorPort) => new FileDurableProjectionIndex({ rootDir: root,
    projectionId: 'append-retirement-debt', reducerVersion: 1, storageMaintenance,
    withSourceLock: operation => scope.getStore() ? operation() : exclusive(operation), runDetached: operation => scope.exit(operation) });
  // 调用方的操作都在前台语境里；后台续跑自己以后台紧急度运行，被闸挡住
  const foreground = <T>(operation: () => Promise<T>) => runInMaintenanceContext('foreground', operation);
  const first = gatedBackground();
  let index = create(first.port);
  let lsn = 0;
  try {
    await foreground(() => index.initialize({ authority: checkpoint(0) }));
    for (let round = 0; round < 4; round++) {
      for (let n = 1; n <= 5; n++) {
        lsn++;
        await foreground(async () => {
          index.publish(await index.prepare([{ kind: 'put', key: 'current', value: lsn }, { kind: 'put', key: `k:${lsn}`, value: lsn }]), { authority: checkpoint(lsn) });
          await index.flush({ compact: false });
        });
      }
      await foreground(() => exclusive(() => index.flush()));
    }
    // 后台续跑确实接手过、且没拿到容量
    for (const deadline = Date.now() + 5_000; first.counts.refused === 0 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 5));
    expect(first.counts.refused).toBeGreaterThan(0);
    await index.stopStorageMaintenance();
    const stopped = await manifest(root);
    expect(stopped.retirementRoot).toBeDefined();

    const second = gatedBackground();
    index = create(second.port);
    await foreground(() => index.initialize({ authority: checkpoint(0) }));
    expect(await foreground(() => index.get('current'))).toBe(lsn);
    const opened = await manifest(root);
    // 前台：每推进一步写一次清单，至多固定额度；债务仍在，留给后台
    expect(opened.generation - stopped.generation).toBeLessThanOrEqual(2);
    expect(opened.retirementRoot ?? opened.retirementCleanup).toBeDefined();

    second.open();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const current = await manifest(root);
      if (current.retirementRoot === undefined && current.retirementCleanup === undefined) break;
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(second.counts.background).toBeGreaterThan(0);
    expect((await manifest(root)).generation).toBeGreaterThan(opened.generation);
    expect(await index.get('current')).toBe(lsn);
    expect(await index.get('k:1')).toBe(1);
  } finally { await index.stopStorageMaintenance(); }
}, 60_000);

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
