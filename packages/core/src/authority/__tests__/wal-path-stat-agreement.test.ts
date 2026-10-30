import { afterEach, expect, it, vi } from 'vitest';
import { appendFile, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempDir } from '@zhixing/test-utils';
import { readWalVersion, resetWalPathStatAgreementForTesting } from '../verified-wal-view.js';

// 统计按路径打开 WAL 的次数，并可让按路径 stat 在某一次返回改动后的值（模拟两次读之间文件被追加）
const fs = vi.hoisted(() => ({ opens: new Map<string, number>(), statShift: undefined as undefined | ((value: { size: bigint }) => void) }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const key = String(args[0]);
      fs.opens.set(key, (fs.opens.get(key) ?? 0) + 1);
      return real.open(...args);
    },
    stat: async (...args: Parameters<typeof real.stat>) => {
      const value = await real.stat(...args);
      const shift = fs.statShift;
      if (shift && typeof value.size === 'bigint') { fs.statShift = undefined; const copy = { ...value }; shift(copy as { size: bigint }); return copy; }
      return value;
    },
  };
});

afterEach(() => { resetWalPathStatAgreementForTesting(); fs.opens.clear(); fs.statShift = undefined; });

async function wal(name: string) {
  const root = await createTempDir(name), file = path.join(root, 'wal');
  await writeFile(file, 'metadata-only');
  return file;
}

async function fstatVersion(file: string) {
  const handle = await open(file, 'r');
  try { return await readWalVersion(handle); } finally { await handle.close(); }
}

it('stops opening the WAL for metadata once path stat and fstat agree on that path', async () => {
  const file = await wal('wal-path-agree');
  const first = await readWalVersion(file);
  expect(fs.opens.get(file)).toBe(1);
  const second = await readWalVersion(file), third = await readWalVersion(file);
  expect(fs.opens.get(file)).toBe(1);
  expect(second).toEqual(first); expect(third).toEqual(first);
  // 取值与打开后 fstat 完全相同；追加之后按路径读到的也与 fstat 一致
  await appendFile(file, '-grown');
  const grown = await readWalVersion(file);
  expect(grown).toEqual(await fstatVersion(file));
  expect(grown.size).toBeGreaterThan(first.size);
});

it('draws no conclusion when the file changes between fstat and path stat, and compares again next time', async () => {
  const file = await wal('wal-path-race');
  fs.statShift = value => { value.size += 1n; };
  await readWalVersion(file);
  await readWalVersion(file);
  // 第一次比对因中途改动不下结论，第二次照旧打开并比对一致；此后不再打开
  expect(fs.opens.get(file)).toBe(2);
  await readWalVersion(file);
  expect(fs.opens.get(file)).toBe(2);
});

it('keeps each path separate', async () => {
  const one = await wal('wal-path-one'), two = await wal('wal-path-two');
  await readWalVersion(one); await readWalVersion(one);
  await readWalVersion(two);
  expect(fs.opens.get(one)).toBe(1); expect(fs.opens.get(two)).toBe(1);
});
