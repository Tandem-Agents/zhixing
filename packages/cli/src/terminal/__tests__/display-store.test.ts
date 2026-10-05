import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DeviceCapacityArbiterPort, DeviceCapacityQuantum } from '@zhixing/core/resources';
import { TerminalDisplayStore } from '../display-store.js';
import { projectHistorySegmentsReverse } from '../history-segments.js';

const roots: string[] = [];
const stores: TerminalDisplayStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('zhixing-terminal-display-')) throw Error('Invalid cleanup boundary');
    await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhixing-terminal-display-')); roots.push(root);
  await mkdir(path.join(root, 'display'));
  let active = 0, outstanding = 0, stored = 0;
  const capacity: DeviceCapacityArbiterPort = { async acquire(request) {
    active++;
    const used: DeviceCapacityQuantum = { readBytes: 0, writeBytes: 0, ioOperations: 0 };
    let complete = false;
    return { kind: 'granted', permit: { granted: request.atomic,
      tryBegin: () => ({ claim: (dimension, amount) => {
        if (complete) throw Error('Claim after completion');
        const key = dimension as keyof DeviceCapacityQuantum;
        used[key] += amount; if (used[key] > request.atomic.quantum[key]) throw Error('Physical quantum exceeded');
      }, complete: () => { complete = true; } }),
      release: () => { expect(complete).toBe(true); active--; },
    } };
  } };
  const account = {
    reserve: vi.fn(async (_bucket: 'display' | 'input', bytes: number) => { outstanding += bytes; return 'own-reservation'; }),
    settle: vi.fn(async (_token: string, bytes: number) => { expect(bytes).toBeLessThanOrEqual(outstanding); outstanding = 0; stored += bytes; }),
    released: vi.fn(async (_bucket: 'display' | 'input', bytes: number) => {
      await expect(stat(path.join(root, 'display/data'))).rejects.toMatchObject({ code: 'ENOENT' }); stored -= bytes;
    }),
  };
  const store = new TerminalDisplayStore(root, capacity, account, new AbortController().signal); stores.push(store);
  return { root, account, store, counts: () => ({ active, outstanding, stored }) };
}

describe('bounded terminal display projection', () => {
  it('prepends original Unicode history and pages without truncating or reordering content', async () => {
    const h = await setup();
    const text = ' \r\n汉字🦞\t'.repeat(12_000);
    const records = [{ shardId: 'own-shard', record: { type: 'run' as const, runIndex: 1,
      timestamp: '2026-10-04', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }] } }];
    for (const segment of projectHistorySegmentsReverse(records)) await h.store.append(segment, true);
    await h.store.append({ blockId: 'live', contentOffset: 0, role: 'assistant', text: '后续', final: true });
    const shown: string[] = [];
    for (let start = h.store.first; start < h.store.last;) {
      const page = await h.store.page(start, false);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
      expect(page.segments.length).toBeLessThanOrEqual(4);
      for (const segment of page.segments) {
        if (segment.blockId !== 'live') expect(text.slice(segment.contentOffset, segment.contentOffset + segment.text.length)).toBe(segment.text);
        shown.push(segment.text);
      }
      start += page.segments.length;
    }
    expect(shown.join('')).toBe(text + '后续');
    expect(h.counts().active).toBe(0); expect(h.counts().outstanding).toBe(0);
    await h.store.reset(); expect(h.counts().stored).toBe(0); expect((await h.store.page()).segments).toEqual([]);
  });

  it('keeps an unconfirmed disk write charged and never exposes it as accepted history', async () => {
    const h = await setup(); h.account.settle.mockRejectedValueOnce(Error('synthetic lost settlement'));
    await expect(h.store.append({ blockId: 'one', contentOffset: 0, role: 'assistant', text: 'unconfirmed', final: true })).rejects.toThrow('lost settlement');
    expect(h.store.paused).toBe(true); expect(h.counts().outstanding).toBeGreaterThan(0); expect(h.counts().active).toBe(0);
    expect((await h.store.page()).segments).toEqual([]);
    await expect(h.store.reset()).rejects.toThrow('settlement-unknown');
    expect(h.account.released).not.toHaveBeenCalled();
  });

  it('refuses normal display before any write when the root cannot reserve capacity', async () => {
    const h = await setup(); h.account.reserve.mockRejectedValueOnce(Error('synthetic full root'));
    await expect(h.store.append({ blockId: 'one', contentOffset: 0, role: 'assistant', text: 'not admitted', final: true })).rejects.toThrow('full root');
    await expect(stat(path.join(h.root, 'display/data'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.store.last).toBe(0); await h.store.reset(); expect(h.store.paused).toBe(false);
  });
});
