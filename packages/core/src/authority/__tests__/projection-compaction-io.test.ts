import path from 'node:path';
import { readFile, access, unlink } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createTempDir } from '@zhixing/test-utils';

const work = vi.hoisted(() => ({ enabled: false, offsetReads: 0, offsetBytes: 0, canonicalizations: 0, failManifest: false,
  failManifestAfter: undefined as number | undefined, manifestWrites: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (path.basename(String(args[0])) === '.manifest.tmp') {
      if (work.enabled) work.manifestWrites++;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...input) => {
        if (work.failManifestAfter !== undefined && --work.failManifestAfter === 0) {
          work.failManifestAfter = undefined; throw Error('injected partial compaction');
        }
        if (work.failManifest) { work.failManifest = false; throw Error('injected manifest publication'); }
        return write(...input);
      };
    }
    if (String(args[0]).endsWith('.offsets')) {
      const read = handle.read.bind(handle);
      handle.read = (async (...input: Parameters<typeof read>) => {
        if (work.enabled) work.offsetReads++;
        const result = await read(...input);
        if (work.enabled) work.offsetBytes += result.bytesRead;
        return result;
      }) as typeof handle.read;
    }
    return handle;
  } };
});
vi.mock('../../protocol/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../protocol/index.js')>();
  return { ...actual, canonicalize: (value: unknown) => {
    if (work.enabled && (value as { kind?: string } | null)?.kind === 'compaction-fixture') work.canonicalizations++;
    return actual.canonicalize(value);
  } };
});
import { AuthorityCacheIntegrity, FileDurableProjectionIndex, DurableProjectionStorageError } from '../index.js';
import { runInMaintenanceContext, runWithMaintenanceUrgency } from '../../resources/index.js';

async function scatteredRangesFixture() {
  const root = await createTempDir('compaction-range-batch');
  const options = { rootDir: root, projectionId: 'range-batch', reducerVersion: 1, authenticated: true,
    integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 19)), allowSegmentReclamation: false };
  const index = new FileDurableProjectionIndex(options);
  let lsn = 0;
  const checkpoint = () => ({ source: { logId: 'range-batch', lsn, frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, '0')}` as const } });
  const key = (n: number) => `key-${String(n).padStart(5, '0')}`;
  await index.initialize(checkpoint());
  for (let group = 0; group < 20; group++) {
    lsn++;
    index.publish(await index.prepare(Array.from({ length: 512 }, (_, n) => ({
      kind: 'put' as const, key: key(group * 512 + n), value: group * 512 + n,
    }))), checkpoint());
    await index.flush();
  }
  const original = await index.scan({}, 1);
    for (let batch = 0; batch < 5; batch++) {
      lsn++;
      index.publish(await index.prepare(Array.from({ length: 20 }, (_, group) =>
        ({ kind: 'put' as const, key: key(group * 512), value: 1000 + batch }))), checkpoint());
      await index.flush({ compact: false });
    }
  return { root, options, index, original, key, checkpoint, advance: () => { lsn++; } };
}

it('publishes scattered compaction ranges in bounded batches with the same crash and reader guarantees', async () => {
  const { root, options, index, original, key, checkpoint } = await scatteredRangesFixture();
  try {
    const before = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(before.baseRoot.count).toBeGreaterThanOrEqual(16);
    work.failManifest = true;
    await expect(index.flush()).rejects.toThrow('injected manifest publication');
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')).generation).toBe(before.generation);
    const cold = new FileDurableProjectionIndex({ ...options, readOnly: true });
    await cold.initialize(checkpoint());
    expect(await cold.get(key(19 * 512))).toBe(1004);
    await cold.stopStorageMaintenance();
    work.manifestWrites = 0; work.enabled = true;
    await index.flush(); work.enabled = false;
    expect(work.manifestWrites).toBeLessThan(before.baseRoot.count / 2);
    expect(await index.getMany([key(0), key(19 * 512), key(10239)])).toEqual([1004, 1004, 10239]);
    const pinned = await index.scan({}, 256, original.continuation);
    expect((await index.scan({}, 256, pinned.continuation)).entries.find(row => row.key === key(512))?.value).toBe(512);
  } finally { work.enabled = false; work.failManifest = false; await index.stopStorageMaintenance(); }
}, 60_000);

it('merges a large delta that lands inside one base range over several bounded steps with the same crash and reader guarantees', async () => {
  const root = await createTempDir('compaction-large-range');
  const options = { rootDir: root, projectionId: 'large-range', reducerVersion: 1, authenticated: true,
    integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 23)), allowSegmentReclamation: false };
  const index = new FileDurableProjectionIndex(options);
  let lsn = 0;
  const checkpoint = () => ({ source: { logId: 'large-range', lsn, frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, '0')}` as const } });
  const key = (prefix: string, n: number) => `${prefix}-${String(n).padStart(5, '0')}`;
  try {
    await index.initialize(checkpoint());
    // 六组相互分隔的基段。
    for (const prefix of ['a', 'b', 'c', 'x', 'y', 'z']) {
      lsn++;
      index.publish(await index.prepare(Array.from({ length: 512 }, (_, n) => ({ kind: 'put' as const, key: key(prefix, n), value: prefix + n }))), checkpoint());
      await index.flush();
    }
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')).baseRoot).toBeDefined();
    // 一次写入 5,000 个落在 c 与 x 之间（同一基段范围）的键，再用三个小增量使增量段（连同建基段时留下的一个）超出上限、登记整理。
    lsn++;
    index.publish(await index.prepare(Array.from({ length: 5_000 }, (_, n) => ({ kind: 'put' as const, key: key('m', n), value: n }))), checkpoint());
    await index.flush({ compact: false });
    for (let n = 0; n < 3; n++) {
      lsn++;
      index.publish(await index.prepare([{ kind: 'put', key: key('a', n), value: 'updated' + n }]), checkpoint());
      await index.flush({ compact: false });
    }
    // 第三次发布清单时失败：前两步已发布的部分与其余增量一起仍给出完整、正确的读取。
    work.manifestWrites = 0; work.enabled = true;
    work.failManifestAfter = 3;
    await expect(index.flush()).rejects.toThrow('injected partial compaction');
    const cold = new FileDurableProjectionIndex({ ...options, readOnly: true });
    await cold.initialize(checkpoint());
    expect(await cold.getMany([key('m', 0), key('m', 1_500), key('m', 4_999), key('a', 2), key('c', 511), key('x', 0)]))
      .toEqual([0, 1_500, 4_999, 'updated2', 'c511', 'x0']);
    await cold.stopStorageMaintenance();
    // 整理分多步完成：每步合并的条目有上限，含失败前已发布的两步，发布次数不少于 5,000 / 1,024。
    await index.flush(); work.enabled = false;
    expect(work.manifestWrites).toBeGreaterThanOrEqual(5);
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')).compaction).toBeUndefined();
    const all = new Map<string, unknown>(); let continuation: string | undefined;
    do { const page = await index.scan({ gte: 'm-', lt: 'm.' }, 256, continuation); for (const entry of page.entries) all.set(entry.key, entry.value); continuation = page.continuation; } while (continuation);
    expect(all.size).toBe(5_000);
    expect(await index.getMany([key('m', 2_048), key('a', 0), key('b', 511), key('z', 511)])).toEqual([2_048, 'updated0', 'b511', 'z511']);
  } finally { work.enabled = false; work.failManifestAfter = undefined; await index.stopStorageMaintenance(); }
}, 120_000);

it('waits between background compaction steps at the caller gate and continues at once when a foreground flush joins', async () => {
  const root = await createTempDir('compaction-step-gate');
  const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: 'step-gate', reducerVersion: 1, allowSegmentReclamation: false });
  let lsn = 0;
  const checkpoint = () => ({ source: { logId: 'step-gate', lsn, frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, '0')}` as const } });
  const key = (prefix: string, n: number) => `${prefix}-${String(n).padStart(5, '0')}`;
  const manifest = async () => JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  try {
    await index.initialize(checkpoint());
    for (const prefix of ['a', 'b', 'c', 'x', 'y', 'z']) {
      lsn++;
      index.publish(await index.prepare(Array.from({ length: 512 }, (_, n) => ({ kind: 'put' as const, key: key(prefix, n), value: prefix + n }))), checkpoint());
      await index.flush();
    }
    lsn++;
    index.publish(await index.prepare(Array.from({ length: 5_000 }, (_, n) => ({ kind: 'put' as const, key: key('m', n), value: n }))), checkpoint());
    await index.flush({ compact: false });
    for (let n = 0; n < 3; n++) {
      lsn++;
      index.publish(await index.prepare([{ kind: 'put', key: key('a', n), value: 'updated' + n }]), checkpoint());
      await index.flush({ compact: false });
    }
    expect((await manifest()).compaction).toBeDefined();
    // 后台整理在每一步之前等调用方的闸门；闸门未放行时一步也不做。
    let gateCalls = 0, release: () => void = () => undefined;
    const gate = () => { gateCalls++; return new Promise<void>(resolve => { release = resolve; }); };
    const background = runWithMaintenanceUrgency(() => 'background', new AbortController().signal, () => index.flush({ betweenSteps: gate }));
    await new Promise(resolve => setTimeout(resolve, 300));
    const pausedAt = (await manifest()).generation;
    expect(gateCalls).toBe(1);
    // 放行一次：推进一步后再次停在闸门。
    release();
    for (let n = 0; n < 100 && gateCalls < 2; n++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(gateCalls).toBe(2);
    expect((await manifest()).generation).toBeGreaterThan(pausedAt);
    expect((await manifest()).compaction).toBeDefined();
    // 前台落盘加入同一维护义务：紧急度升高，不再等闸门，整理一并完成。
    await runInMaintenanceContext('foreground', () => index.flush());
    await background;
    expect(gateCalls).toBe(2);
    expect((await manifest()).compaction).toBeUndefined();
    expect(await index.getMany([key('m', 0), key('m', 4_999), key('a', 2), key('z', 511)])).toEqual([0, 4_999, 'updated2', 'z511']);
  } finally { await index.stopStorageMaintenance(); }
}, 120_000);

it('preserves initial base construction before optimizing later checkpoint tails', async () => {
  const root = await createTempDir('initial-projection-base');
  const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: 'initial-base', reducerVersion: 1, overlayEntries: 2 });
  const checkpoint = (lsn: number) => ({ source: { logId: 'initial-base', lsn, frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, '0')}` as const } });
  try {
    await index.initialize(checkpoint(0));
    for (let n = 1; n <= 12; n++) index.publish(await index.prepare([{ kind: 'put', key: 'current', value: n }]), checkpoint(n));
    await index.flushCheckpoint();
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')).baseRoot).toBeDefined();
    expect(await index.get('current')).toBe(12);
  } finally { await index.stopStorageMaintenance(); }
});

it('compacts authenticated rows with bounded offset reads and reuses their verified canonical payload', async () => {
  const root = await createTempDir('compaction-io');
  const options = { rootDir: path.join(root, 'index'), projectionId: 'compaction-io', reducerVersion: 1,
    authenticated: true, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 31)), allowSegmentReclamation: false };
  const checkpoint = (lsn: number) => ({ source: { logId: 'compaction-io', lsn, frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, '0')}` as const } });
  const writer = new FileDurableProjectionIndex(options);
  await writer.initialize(checkpoint(0));
  for (let batch = 0; batch < 5; batch++) {
    const values = Array.from({ length: 120 }, (_, n) => ({ kind: 'put' as const,
      key: `key-${String(batch * 120 + n).padStart(5, '0')}`,
      value: { kind: 'compaction-fixture', id: batch * 120 + n, data: ['preserved', { nested: true }] } }));
    writer.publish(await writer.prepare(values), checkpoint(batch + 1));
    await writer.flush();
  }
  for (let n = 6; n <= 10; n++) {
    writer.publish(await writer.prepare([{ kind: 'put', key: 'key-00000',
      value: { kind: 'compaction-fixture', id: n, data: ['updated'] } }]), checkpoint(n));
    await writer.flush({ compact: false });
  }
  await writer.stopStorageMaintenance();
  const cold = new FileDurableProjectionIndex(options);
  try {
    await cold.initialize(checkpoint(0));
    work.enabled = true; work.offsetReads = 0; work.canonicalizations = 0;
    await cold.flush();
    work.enabled = false;
    expect(work.offsetReads).toBeLessThan(64);
    // One canonical validation per source payload; compaction must not parse
    // and re-serialize unchanged historical values for sizing and writing.
    expect(work.canonicalizations).toBeLessThanOrEqual(520);
    work.offsetBytes = 0; work.enabled = true;
    expect(await cold.get('key-00300')).toEqual({ kind: 'compaction-fixture', id: 300, data: ['preserved', { nested: true }] });
    work.enabled = false;
    expect(work.offsetBytes).toBeLessThanOrEqual(16 * 8);
    expect(await cold.get('key-00000')).toEqual({ kind: 'compaction-fixture', id: 10, data: ['updated'] });
    expect(await cold.get('key-00300')).toEqual({ kind: 'compaction-fixture', id: 300, data: ['preserved', { nested: true }] });
    expect(cold.checkpoints()).toEqual(checkpoint(10));
  } finally { work.enabled = false; await cold.stopStorageMaintenance(); }
}, 30_000);

async function sparseDeltaFixture(limits: { overlayEntries?: number; overlayBytes?: number; allowSegmentReclamation?: boolean } = {}, spread: boolean | 'unique' = false) {
  const root = await createTempDir('bounded-delta-consolidation');
  const options = { rootDir: root, projectionId: 'bounded-delta', reducerVersion: 1, authenticated: true,
    integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 42)), ...limits };
  const checkpoint = (lsn: number) => ({ source: { logId: 'bounded-delta', lsn, frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, '0')}` as const } });
  const index = new FileDurableProjectionIndex(options);
  await index.initialize(checkpoint(0));
  for (let batch = 0; batch < 5; batch++) {
    index.publish(await index.prepare(Array.from({ length: 120 }, (_, n) => ({ kind: 'put' as const,
      key: `key-${String(batch * 120 + n).padStart(5, '0')}`, value: batch * 120 + n }))), checkpoint(batch + 1));
    await index.flush();
  }
  const manifest = async () => JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const base = (await manifest()).baseRoot;
  for (let n = 6; n <= 10; n++) {
    const key = spread === 'unique' ? `key-${String(n).padStart(5, '0')}` : spread && n % 2 ? 'key-00599' : 'key-00000';
    index.publish(await index.prepare([n === 10 ? { kind: 'tombstone', key: 'key-00000' }
      : { kind: 'put', key, value: n }]), checkpoint(n));
    await index.flush({ compact: false });
  }
  return { index, options, root, base, checkpoint, manifest };
}

it('keeps the observed 620-row tail plus 133 active rows out of historical base compaction', async () => {
  const h = await sparseDeltaFixture();
  try {
    await h.index.flush();
    const base = (await h.manifest()).baseRoot;
    let ordinal = 0;
    const rows = (count: number) => Array.from({ length: count }, () => ({
      kind: 'put' as const, key: `tail-${String(ordinal++).padStart(5, '0')}`,
      value: { payload: 'x'.repeat(600) },
    }));
    for (const [batch, count] of [118, 133, 116, 124, 129].entries()) {
      h.index.publish(await h.index.prepare(rows(count)), h.checkpoint(11 + batch));
      await h.index.flush({ compact: false });
    }
    expect((await h.manifest()).deltaSegments.map((segment: { count: number }) => segment.count).reduce((a: number, b: number) => a + b, 0)).toBe(620);
    h.index.publish(await h.index.prepare(rows(133)), h.checkpoint(16));
    await h.index.flush({ compact: false });
    const after = await h.manifest();
    expect(after.baseRoot).toEqual(base);
    expect(after.compaction).toBeUndefined();
    expect(after.deltaSegments).toHaveLength(2);
    expect(after.checkpoints).toEqual(h.checkpoint(16));
    const cold = new FileDurableProjectionIndex({ ...h.options, readOnly: true });
    try {
      await cold.initialize(h.checkpoint(0));
      expect(await cold.getMany(['tail-00000', 'tail-00619', 'tail-00752'])).toEqual(
        Array.from({ length: 3 }, () => ({ payload: 'x'.repeat(600) })),
      );
      expect(await cold.get('key-00599')).toBe(599);
    } finally { await cold.stopStorageMaintenance(); }
  } finally { await h.index.stopStorageMaintenance(); }
}, 30_000);

it('publishes a bounded delta without rewriting the historical base, preserving crash recovery and pinned readers', async () => {
  const h = await sparseDeltaFixture();
  const before = await h.manifest();
  const page = await h.index.scan({}, 1);
  expect(page.continuation).toBeDefined();
  try {
    h.index.publish(await h.index.prepare([{ kind: 'put', key: 'key-00002', value: 'new' }]), h.checkpoint(11));
    work.failManifest = true;
    await expect(h.index.flush({ compact: false })).rejects.toThrow('injected manifest publication');
    expect((await h.manifest()).generation).toBe(before.generation);
    const old = new FileDurableProjectionIndex({ ...h.options, readOnly: true });
    try {
      await old.initialize(h.checkpoint(0));
      expect(await old.get('key-00002')).toBe(2);
      expect(old.checkpoints()).toEqual(h.checkpoint(10));
    } finally { await old.stopStorageMaintenance(); }
    await h.index.flush({ compact: false });
    const after = await h.manifest();
    expect(after.baseRoot).toEqual(h.base);
    expect(after.deltaSegments).toHaveLength(1);
    expect(after.compaction).toBeUndefined();
    expect(await h.index.get('key-00000')).toBeUndefined();
    expect(await h.index.get('key-00002')).toBe('new');
    expect(await h.index.get('key-00599')).toBe(599);
    expect((await h.index.scan({}, 1, page.continuation)).entries).toEqual([{ key: 'key-00002', value: 2 }]);
    for (const segment of before.deltaSegments) await access(path.join(h.root, segment.dataFile));
    expect(h.index.checkpoints()).toEqual(h.checkpoint(11));
  } finally {
    work.failManifest = false;
    h.index.releaseContinuation(page.continuation!);
    await h.index.stopStorageMaintenance();
  }
}, 30_000);

it('consolidates the remaining tail after a partially published base compaction without losing either range', async () => {
  const h = await scatteredRangesFixture();
  const manifest = async () => JSON.parse(await readFile(path.join(h.root, 'manifest.json'), 'utf8'));
  const before = await manifest();
  try {
    work.failManifestAfter = 2;
    await expect(h.index.flush()).rejects.toThrow('injected partial compaction');
    const partial = await manifest();
    expect(partial.generation).toBe(before.generation + 1);
    expect(partial.compaction.afterKey).toBe(h.key(7 * 512));
    h.advance();
    h.index.publish(await h.index.prepare([
      { kind: 'put', key: h.key(2), value: 'new' },
      { kind: 'tombstone', key: h.key(0) },
    ]), h.checkpoint());
    await h.index.flush({ compact: false });
    const after = await manifest();
    expect(after.baseRoot).toEqual(partial.baseRoot);
    expect(after.compaction).toBeUndefined();
    expect(await h.index.get('key-00000')).toBeUndefined();
    expect(await h.index.get('key-00002')).toBe('new');
    expect(await h.index.get(h.key(19 * 512))).toBe(1004);
    expect(after.checkpoints).toEqual(h.checkpoint());
  } finally { work.failManifestAfter = undefined; await h.index.stopStorageMaintenance(); }
}, 30_000);

it.each([{ overlayEntries: 1 }, { overlayBytes: 100 }])('retains ordinary compaction when a delta cannot fit the existing budget: %j', async limits => {
  const h = await sparseDeltaFixture(limits, 'unique');
  try {
    h.index.publish(await h.index.prepare([{ kind: 'put', key: 'key-00002', value: 'new' }]), h.checkpoint(11));
    await h.index.flush({ compact: false });
    expect((await h.manifest()).baseRoot).not.toEqual(h.base);
    expect(await h.index.get('key-00000')).toBeUndefined();
    expect(await h.index.get('key-00002')).toBe('new');
    expect(await h.index.get('key-00599')).toBe(599);
  } finally { await h.index.stopStorageMaintenance(); }
}, 30_000);

it.each([{ overlayEntries: 1 }, { overlayBytes: 100 }])('packs a tail into multiple original-sized segments instead of rewriting the base: %j', async limits => {
  const h = await sparseDeltaFixture(limits);
  try {
    h.index.publish(await h.index.prepare([{ kind: 'put', key: 'key-00002', value: 'new' }]), h.checkpoint(11));
    await h.index.flush({ compact: false });
    const after = await h.manifest();
    expect(after.baseRoot).toEqual(h.base);
    expect(after.deltaSegments.length).toBeGreaterThan(1);
    expect(after.deltaSegments.length).toBeLessThanOrEqual(2);
    expect(after.compaction).toBeUndefined();
    for (const segment of after.deltaSegments) {
      if (limits.overlayEntries) expect(segment.count).toBeLessThanOrEqual(limits.overlayEntries);
      if (limits.overlayBytes) expect((await readFile(path.join(h.root, segment.dataFile))).length).toBeLessThanOrEqual(limits.overlayBytes);
    }
    const cold = new FileDurableProjectionIndex({ ...h.options, readOnly: true });
    try {
      await cold.initialize(h.checkpoint(0));
      expect(await cold.getMany(['key-00002', 'key-00599', 'key-00000'])).toEqual(['new', 599, undefined]);
    } finally { await cold.stopStorageMaintenance(); }
  } finally { await h.index.stopStorageMaintenance(); }
}, 30_000);

it('checkpoints a small deduplicated tail without leaving already-verified facts for the first send', async () => {
  const h = await sparseDeltaFixture({ overlayEntries: 2 });
  try {
    h.index.publish(await h.index.prepare([{ kind: 'put', key: 'key-00002', value: 'checkpointed' }]), h.checkpoint(11));
    await h.index.flushCheckpoint();
    const after = await h.manifest();
    expect(after.checkpoints).toEqual(h.checkpoint(11));
    expect(after.baseRoot).toEqual(h.base);
    expect(after.deltaSegments).toHaveLength(1);
    const cold = new FileDurableProjectionIndex({ ...h.options, readOnly: true });
    try {
      await cold.initialize(h.checkpoint(0));
      expect(await cold.get('key-00000')).toBeUndefined();
      expect(await cold.get('key-00002')).toBe('checkpointed');
    } finally { await cold.stopStorageMaintenance(); }
  } finally { await h.index.stopStorageMaintenance(); }
}, 30_000);

it('keeps a missing consolidated source segment classified as recoverable projection corruption', async () => {
  const h = await sparseDeltaFixture();
  try {
    const before = await h.manifest();
    await unlink(path.join(h.root, before.deltaSegments[0].dataFile));
    h.index.publish(await h.index.prepare([{ kind: 'put', key: 'key-00002', value: 'new' }]), h.checkpoint(11));
    await expect(h.index.flush({ compact: false })).rejects.toBeInstanceOf(DurableProjectionStorageError);
    expect((await h.manifest()).generation).toBe(before.generation);
  } finally { await h.index.stopStorageMaintenance(); }
}, 30_000);
