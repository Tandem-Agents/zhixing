import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { DeviceCapacityArbiterPort, DeviceCapacityQuantum } from '@zhixing/core/resources';
import { CheckpointDirectoryHandle } from '@zhixing/mesh/filesystem';
import { TerminalInstanceAssets, type TerminalIdentityResolver } from '../instance-assets.js';

const roots: string[] = [];
const owners: TerminalInstanceAssets[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root), temporary = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temporary) || !path.basename(resolved).startsWith('zhixing-terminal-assets-')) throw Error('Unexpected cleanup boundary');
    await rm(resolved, { recursive: true, force: true });
  }
});

function capacity() {
  let active = 0, completed = 0, released = 0, peakActive = 0, maximumIO = 0;
  let beforeAcquire: (() => Promise<void>) | undefined;
  const owner: DeviceCapacityArbiterPort = { async acquire(request) {
    await beforeAcquire?.();
    active++; peakActive = Math.max(peakActive, active);
    let began = false, done = false, returned = false;
    const used: DeviceCapacityQuantum = { readBytes: 0, writeBytes: 0, ioOperations: 0 };
    return { kind: 'granted', permit: { granted: request.atomic,
      tryBegin: () => {
        if (began) return undefined; began = true;
        return { claim: (dimension, amount) => {
          if (done || returned || !['readBytes', 'writeBytes', 'ioOperations'].includes(dimension)) throw Error('Invalid physical claim');
          const key = dimension as keyof DeviceCapacityQuantum;
          used[key] += amount;
          if (key === 'ioOperations') maximumIO = Math.max(maximumIO, used[key]);
          if (used[key] > request.atomic.quantum[key]) throw Error('Physical claim exceeded its admitted quantum');
        }, complete: () => { if (done) throw Error('Physical operation completed twice'); done = true; completed++; } };
      }, release: () => { if (!done || returned) throw Error('Physical permit released before completion'); returned = true; active--; released++; },
    } };
  } };
  return { owner, counts: () => ({ active, completed, released, peakActive, maximumIO }), beforeAcquire: (hook: () => Promise<void>) => { beforeAcquire = hook; } };
}

async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zhixing-terminal-assets-')); roots.push(home);
  const resources = capacity();
  const identity: TerminalIdentityResolver = { async read(pid) { return pid === process.pid ? { kind: 'present', birth: 'synthetic-self-birth' } : { kind: 'absent' }; } };
  const assets = new TerminalInstanceAssets(home, resources.owner, identity);
  owners.push(assets);
  const signal = new AbortController().signal;
  const recovery = { pid: process.pid, birth: 'synthetic-self-birth', spawnId: randomUUID() };
  const directory = await assets.admit(randomUUID(), recovery, signal);
  const record = async () => JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
  return { home, resources, identity, assets, signal, recovery, directory, record };
}

describe('terminal instance root admission', () => {
  it('accounts an extent separately from physical work and rejects unbounded commitments', async () => {
    const h = await setup();
    const bytes = 8 * 1024 * 1024;
    const token = await h.assets.reserve('display', bytes, h.signal);
    expect((await h.record()).reservations[token].bytes).toBe(bytes);
    expect(h.resources.counts().active).toBe(0);
    await expect(h.assets.reserve('display', bytes + 1, h.signal)).rejects.toThrow('step-size');
    await h.assets.settle(token, 0, h.signal);
    expect((await h.record()).reservations[token]).toBeUndefined();
  });
  it('reclaims the pinned root when its former pathname has been replaced with a junction', async () => {
    const h = await setup();
    const held = path.join(h.home, 'held-terminal');
    await rename(h.assets.root, held);
    const outside = path.join(h.home, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel'), 'preserve');
    await symlink(outside, h.assets.root, process.platform === 'win32' ? 'junction' : 'dir');
    await h.assets.release(h.signal);
    expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('preserve');
    await expect(readFile(path.join(held, path.basename(h.directory), 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reserves before publication, keeps pending writes charged and releases physical permits after each operation', async () => {
    const h = await setup();
    const token = await h.assets.reserve('input', 256 * 1024, h.signal);
    expect((await h.record()).reservations[token]).toEqual({ bucket: 'input', bytes: 256 * 1024 });
    await h.assets.settle(token, 128 * 1024, h.signal);
    expect((await h.record()).inputBytes).toBe(128 * 1024);
    expect(h.resources.counts().active).toBe(0);
    expect(h.resources.counts().completed).toBe(h.resources.counts().released);
    await h.assets.release(h.signal);
    await expect(readFile(path.join(h.directory, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('settles its admitted budget despite foreign residue but refuses new root allocations', async () => {
    const h = await setup();
    const token = await h.assets.reserve('input', 4096, h.signal);
    await writeFile(path.join(h.assets.root, 'foreign'), 'must not delete');
    await h.assets.settle(token, 4096, h.signal);
    expect((await h.record()).inputBytes).toBe(4096);
    await expect(h.assets.reserve('input', 4096, h.signal)).rejects.toThrow('unknown-residue');
    expect(await readFile(path.join(h.assets.root, 'foreign'), 'utf8')).toBe('must not delete');
  });

  it('does not release assets for an unbound creation intent or a mismatched exit receipt', async () => {
    const h = await setup(); const spawnId = await h.assets.intent('ui', h.signal);
    await expect(h.assets.release(h.signal)).rejects.toThrow('writers-not-exited');
    const child = { pid: 123456, birth: 'synthetic-ui-birth', spawnId };
    await h.assets.bind('ui', child, h.signal);
    await expect(h.assets.settleRole('ui', { kind: 'exited', pid: child.pid, spawnId: randomUUID() }, h.signal)).rejects.toThrow('mismatch');
    await h.assets.settleRole('ui', { kind: 'exited', pid: child.pid, spawnId: child.spawnId, born: child.birth }, h.signal);
    await h.assets.release(h.signal);
  });

  it('keeps an instance file writer charged until its matching actual close receipt', async () => {
    const h = await setup(), id = randomUUID();
    await h.assets.writerIntent(id, randomUUID(), h.signal);
    await expect(h.assets.release(h.signal)).rejects.toThrow('helper-not-exited');
    const writer = { pid: 123457, birth: 'synthetic-file-worker', spawnId: id };
    await h.assets.bindWriter(writer, h.signal);
    expect((await h.record()).writers[id]).toMatchObject({ state: 'bound', identity: writer });
    expect((await h.record()).writers[id].wrapped).toBeUndefined();
    await expect(h.assets.settleWriter(id, { ...writer, birth: 'different' }, h.signal)).rejects.toThrow('identity');
    await expect(h.assets.release(h.signal)).rejects.toThrow('helper-not-exited');
    await h.assets.settleWriter(id, writer, h.signal);
    await h.assets.release(h.signal);
  });

  it('preserves unknown residue and prevents a reparse from crossing the managed boundary', async () => {
    const h = await setup();
    const outside = path.join(h.home, 'outside'); await mkdir(outside);
    const sentinel = path.join(outside, 'sentinel'); await writeFile(sentinel, 'preserve');
    await symlink(outside, path.join(h.directory, 'runtime', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(h.assets.reserve('display', 4096, h.signal)).rejects.toThrow();
    await expect(h.assets.release(h.signal)).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe('preserve');
    expect((await h.record()).displayBytes).toBe(16 * 1024 * 1024);
  });

  it('counts existing live roots and refuses the ninth instance without deleting their data', async () => {
    const h = await setup();
    const others: TerminalInstanceAssets[] = [];
    for (let i = 0; i < 7; i++) {
      const other = new TerminalInstanceAssets(h.home, h.resources.owner, h.identity);
      owners.push(other);
      await other.admit(randomUUID(), h.recovery, h.signal); others.push(other);
    }
    const ninth = new TerminalInstanceAssets(h.home, h.resources.owner, h.identity);
    owners.push(ninth);
    await expect(ninth.admit(randomUUID(), h.recovery, h.signal)).rejects.toThrow('root-capacity');
    expect((await h.record()).owner.birth).toBe('synthetic-self-birth');
    expect(others).toHaveLength(7);
  });

  it('scans eight populated instances in bounded steps and never acquires a permit under the root mutex', async () => {
    const h = await setup();
    const directories = [h.directory];
    for (let i = 0; i < 7; i++) {
      const other = new TerminalInstanceAssets(h.home, h.resources.owner, h.identity); owners.push(other);
      directories.push(await other.admit(randomUUID(), h.recovery, h.signal));
    }
    for (const directory of directories) {
      for (let i = 0; i < 100; i++) await writeFile(path.join(directory, 'input', randomUUID()), 'retained original');
    }
    const session = CheckpointDirectoryHandle.createWindowsSession();
    const root = await session.openPath(h.assets.root, false);
    let checked = 0;
    h.resources.beforeAcquire(async () => {
      const unlock = await root.tryLock('owner.lock');
      if (!unlock) throw Error('A physical permit was requested while holding the root mutex');
      checked++; await unlock();
    });
    try {
      const token = await h.assets.reserve('input', 4096, h.signal);
      expect((await h.record()).reservations[token].bytes).toBe(4096);
      expect(checked).toBeGreaterThan(32);
      expect(h.resources.counts()).toMatchObject({ active: 0, peakActive: 1 });
      expect(h.resources.counts().maximumIO).toBeLessThanOrEqual(4096);
    } finally { h.resources.beforeAcquire(async () => {}); await root.close(); await session.close(); }
  }, 30_000);

  it('reclaims more files than fit a single delete quantum while retaining the debt until final deletion', async () => {
    const h = await setup();
    for (let i = 0; i < 400; i++) await writeFile(path.join(h.directory, 'input', randomUUID()), 'cold');
    const before = h.resources.counts().completed;
    let partialDebtObserved = false;
    h.resources.beforeAcquire(async () => {
      const record = await h.record();
      if (record.cleanup) {
        expect(record.displayBytes).toBe(16 * 1024 * 1024);
        expect(record.reservations.startup.bytes).toBe(48 * 1024 * 1024);
        partialDebtObserved = true;
      }
    });
    await h.assets.release(h.signal);
    h.resources.beforeAcquire(async () => {});
    expect(partialDebtObserved).toBe(true);
    expect(h.resources.counts().completed - before).toBeGreaterThan(12);
    expect(h.resources.counts().active).toBe(0);
    await expect(readFile(path.join(h.directory, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('rechecks root debt changed between inventory steps before granting a new reservation', async () => {
    const h = await setup();
    let acquisitions = 0;
    h.resources.beforeAcquire(async () => {
      if (++acquisitions !== 3) return;
      const record = await h.record();
      record.inputBytes = 6 * 1024 * 1024 * 1024;
      await writeFile(path.join(h.directory, 'owner.json'), JSON.stringify(record));
    });
    await expect(h.assets.reserve('input', 4096, h.signal)).rejects.toThrow('root-capacity');
    expect((await h.record()).inputBytes).toBe(6 * 1024 * 1024 * 1024);
    expect(Object.keys((await h.record()).reservations)).toEqual(['startup']);
    expect(h.resources.counts().active).toBe(0);
  });

  it('preserves foreign record fields instead of accepting an unbounded header as its own metadata', async () => {
    const h = await setup();
    const record = { ...await h.record(), unregistered: 'foreign-residue' };
    await writeFile(path.join(h.directory, 'owner.json'), JSON.stringify(record));
    await expect(h.assets.reserve('input', 4096, h.signal)).rejects.toThrow('record-unknown');
    await expect(h.assets.release(h.signal)).rejects.toThrow('record-unknown');
    expect((await h.record()).unregistered).toBe('foreign-residue');
  });
});
