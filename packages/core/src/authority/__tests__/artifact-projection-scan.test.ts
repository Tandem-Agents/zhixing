/** 制品派生页的续读：按区间与上一页末键续读，不保留读视图，随后整理产生的退役不被旧代际视图挡住。 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createTempDir } from '@zhixing/test-utils';
import { expect, it, vi } from 'vitest';
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog } from '../index.js';

/** 投影目录里某类文件的个数 */
async function projectionFiles(dir: string, prefix: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix)) count++;
  }
  return count;
}

it('pages artifact-derived rows without retaining read views, so later retirement is not held back', async () => {
  const root = await createTempDir('artifact-projection-scan');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const log = new FileAuthorityCommitLog(path.join(root, 'authority'), artifacts,
    { integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 5)) });
  try {
    await log.append([{ stream: 'control', body: { t: 'fixture' } }]);
    const artifact = await artifacts.put(Buffer.from('artifact-projection-scan'));
    const cache = log.artifactProjection({ projectionId: 'artifact-scan', reducerVersion: 1, artifact, ownerCheckpoint: await log.checkpoint() });
    const range = { gte: 'row/', lt: 'row/￿' };
    // 每页一次落盘、中间读满一页（与基底准备流水线相同）：增量段超过上限后整理，被合并的段转入退役
    for (let round = 0; round < 8; round++) {
      await cache.update(async () => ({ mutations: [{ kind: 'put' as const, key: 'row/' + round, value: round }], value: undefined }));
      expect((await cache.read(view => view.scan(range, 1))).continuation).toBeDefined();
    }
    const projections = path.join(root, 'authority', 'projections');
    await vi.waitFor(async () => {
      await cache.read(view => view.get('row/0'));
      expect(await projectionFiles(projections, 'directory-')).toBeGreaterThan(0);
      expect(await projectionFiles(projections, 'retirement-')).toBe(0);
    }, { timeout: 5_000 });
    // 续读按区间与末键进行，结果与一次读完相同；续读位置绑定它的区间
    const first = await cache.read(view => view.scan(range, 3));
    expect(first.entries.map(entry => entry.key)).toEqual(['row/0', 'row/1', 'row/2']);
    const second = await cache.read(view => view.scan(range, 3, first.continuation));
    expect(second.entries.map(entry => entry.key)).toEqual(['row/3', 'row/4', 'row/5']);
    const last = await cache.read(view => view.scan(range, 3, second.continuation));
    expect(last).toEqual({ entries: [{ key: 'row/6', value: 6 }, { key: 'row/7', value: 7 }] });
    await expect(cache.read(view => view.scan({ gte: 'row/1', lt: 'row/￿' }, 3, first.continuation))).rejects.toThrow('continuation is invalid');
  } finally { await log.stopStorageMaintenance(); }
}, 30_000);
