import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DeviceCapacityArbiterPort, DeviceCapacityQuantum } from '@zhixing/core/resources';
import { TerminalDisplayStore } from '../display-store.js';
import { projectHistorySegmentsReverse } from '../history-segments.js';
import { TerminalBodyProjection, type BodyProjectionChange } from '../body-projection.js';
import { TerminalManagedFiles } from '../managed-files.js';

const roots: string[] = [];
const stores: TerminalDisplayStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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

describe('display recovery retains the original cache', () => {
  it('rejects unavailable capacity, then admits new content without deleting retained pages', async () => {
    const h = await setup();
    await h.store.append({ blockId: 'original', role: 'assistant', text: 'retained prefix', contentOffset: 0, final: false });
    const before = await h.store.page(), charged = h.counts().stored;
    h.account.reserve.mockRejectedValueOnce(Error('synthetic capacity full'));
    await expect(h.store.append({ blockId: 'failed', role: 'assistant', text: 'unretained', contentOffset: 0, final: true })).rejects.toThrow();
    h.account.reserve.mockRejectedValueOnce(Error('synthetic capacity still full'));
    await expect(h.store.retry()).rejects.toThrow('synthetic capacity still full');
    expect(await h.store.page()).toEqual(before);
    await h.store.retry();
    expect(h.account.released).not.toHaveBeenCalled();
    expect(h.counts()).toEqual({ active: 0, outstanding: 0, stored: charged });
    expect(await h.store.page()).toEqual(before);
    await h.store.append({ blockId: 'new', role: 'assistant', text: 'new content', contentOffset: 0, final: true });
    expect((await h.store.page()).segments.map(part => part.text)).toEqual(['retained prefix', 'new content']);
  });

  it('keeps an unconfirmed settlement paused while preserving its earlier page', async () => {
    const h = await setup();
    await h.store.append({ blockId: 'original', role: 'assistant', text: 'retained', contentOffset: 0, final: true });
    const before = await h.store.page();
    h.account.settle.mockRejectedValueOnce(Error('synthetic unknown settlement'));
    await expect(h.store.append({ blockId: 'uncertain', role: 'assistant', text: 'uncertain', contentOffset: 0, final: true })).rejects.toThrow();
    await expect(h.store.retry()).rejects.toThrow('terminal-display-recovery-unavailable');
    expect(h.account.released).not.toHaveBeenCalled();
    expect(await h.store.page()).toEqual(before);
  });
});

describe('bounded terminal display projection', () => {
  it('keeps a superseded plain notice outside the visible range after asynchronous settlement', async () => {
    const h = await setup();
    let current = true;
    const settle = h.account.settle.getMockImplementation()!;
    h.account.settle.mockImplementationOnce(async (token, bytes) => {
      await settle(token, bytes);
      current = false;
    });
    await h.store.append({ blockId: 'old-notice', role: 'notice', text: 'Old conversation', contentOffset: 0, final: true }, false, () => current);
    expect(h.store.last).toBe(0);
    expect((await h.store.page()).segments).toEqual([]);
    expect(h.counts().stored).toBeGreaterThan(0);
    await h.store.append({ blockId: 'new-notice', role: 'notice', text: 'New conversation', contentOffset: 0, final: true });
    expect((await h.store.page()).segments.map(segment => segment.text)).toEqual(['New conversation']);
    await h.store.reset();
    expect(h.counts()).toEqual({ active: 0, outstanding: 0, stored: 0 });
  });

  it('rechecks notice context after waiting for an earlier display write', async () => {
    const h = await setup();
    let finish!: () => void, entered!: () => void, current = true;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const settle = h.account.settle.getMockImplementation()!;
    h.account.settle.mockImplementationOnce(async (token, bytes) => {
      entered(); await blocked; await settle(token, bytes);
    });
    const first = h.store.append({ blockId: 'body', role: 'assistant', text: 'Current body', contentOffset: 0, final: true });
    await started;
    const second = h.store.append({ blockId: 'late-notice', role: 'notice', text: 'Stale notice', contentOffset: 0, final: true }, false, () => current);
    current = false; finish();
    await Promise.all([first, second]);
    expect(h.account.reserve).toHaveBeenCalledTimes(1);
    expect((await h.store.page()).segments.map(segment => segment.text)).toEqual(['Current body']);
  });

  const apply = async (store: TerminalDisplayStore, changes: Iterable<BodyProjectionChange>) => {
    for (const change of changes) {
      if (change.kind === 'amend') await store.amend('stream', change);
      else await store.append({ blockId: 'stream', role: 'assistant', text: change.text,
        contentOffset: change.contentOffset, final: change.body.end, body: change.body });
    }
  };

  // Sixty separately acknowledged managed-file amendments need real I/O headroom.
  it('keeps a readable multi-fragment stream and bounded physical versions while old fragments are repeatedly amended', async () => {
    const h = await setup(), parser = new TerminalBodyProjection('markdown');
    const prefix = '**' + 'a'.repeat(28_000);
    await apply(h.store, parser.feed(prefix));
    expect(h.store.last).toBeGreaterThan(1);
    const bytesBefore = (await stat(path.join(h.root, 'display/data'))).size;
    for (let index = 0; index < 60; index++) await apply(h.store, parser.feed('b'));
    await apply(h.store, parser.feed('**')); await apply(h.store, parser.end()); await h.store.seal('stream');
    const page = await h.store.page();
    expect(page.segments.map(item => item.text).join('')).toBe(prefix + 'b'.repeat(60) + '**');
    expect(page.segments.length).toBeLessThanOrEqual(4);
    expect(page.segments.at(-1)?.body?.end).toBe(true);
    for (const segment of page.segments) {
      expect((prefix + 'b'.repeat(60) + '**').slice(segment.contentOffset, segment.contentOffset + segment.text.length)).toBe(segment.text);
      expect(Buffer.byteLength(JSON.stringify(segment))).toBeLessThanOrEqual(48 * 1024);
    }
    expect((await stat(path.join(h.root, 'display/data'))).size).toBe(bytesBefore);
    expect(bytesBefore).toBe(h.store.last * 2 * 48 * 1024);
    expect((await h.store.page(h.store.first, false)).segments[0]?.text).toBe(page.segments[0]?.text);
    expect(h.counts().active).toBe(0); expect(h.counts().outstanding).toBe(0);
  }, 10_000);

  it.each(['data', 'index', 'settlement'] as const)('preserves the confirmed page after a failed replacement at %s and seals later writes', async stage => {
    const h = await setup(), parser = new TerminalBodyProjection('markdown');
    await apply(h.store, parser.feed('before'));
    const before = await h.store.page();
    if (stage === 'settlement') h.account.settle.mockRejectedValueOnce(Error('synthetic replacement failure'));
    else {
      const write = TerminalManagedFiles.prototype.write;
      let injected = false;
      vi.spyOn(TerminalManagedFiles.prototype, 'write').mockImplementation(async function(this: TerminalManagedFiles, ...args) {
        if (!injected && args[0] === `display/${stage}`) {
          injected = true;
          // This completed partial physical write is a known failure. The
          // original ManagedFiles unknown-completion seal is not bypassed.
          await write.call(this, args[0], args[1].subarray(0, 8), args[2], args[3], args[4], args[5]);
          throw Error('synthetic replacement failure');
        }
        return write.apply(this, args);
      });
    }
    await expect(apply(h.store, parser.feed(' after'))).rejects.toThrow('synthetic replacement failure');
    expect(h.store.paused).toBe(true);
    expect(await h.store.page()).toEqual(before);
    await expect(h.store.append({ blockId: 'later', role: 'assistant', contentOffset: 0, text: 'rejected', final: true })).rejects.toThrow('paused');
    await expect(h.store.reset()).rejects.toThrow('settlement-unknown');
    expect(h.account.released).not.toHaveBeenCalled(); expect(h.counts().active).toBe(0);
  });

  it('resets both source identity and revisions before accepting the next generation', async () => {
    const h = await setup(), old = new TerminalBodyProjection('markdown');
    await apply(h.store, old.feed('old'));
    const amendment = [...old.feed(' tail')].find(item => item.kind === 'amend')!;
    // The complete old operation is queued before reset and made stale before
    // it can acquire the file operation. It cannot mutate the next generation.
    const late = h.store.amend('stream', amendment);
    const reset = h.store.reset(); await Promise.all([late, reset]);
    const current = new TerminalBodyProjection('markdown');
    await apply(h.store, current.feed('new')); await apply(h.store, current.end());
    expect((await h.store.page()).segments.map(item => item.text).join('')).toBe('new');
    old.dispose();
  });

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
