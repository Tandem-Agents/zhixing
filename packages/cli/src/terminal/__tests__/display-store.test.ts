import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DeviceCapacityArbiterPort, DeviceCapacityQuantum } from '@zhixing/core/resources';
import { TerminalDisplayStore } from '../display-store.js';
import { projectHistorySegmentsReverse } from '../history-segments.js';
import { TerminalBodyProjection, type BodyProjectionChange } from '../body-projection.js';
import { TerminalManagedFiles } from '../managed-files.js';
import { TERMINAL_LIMITS } from '@zhixing/terminal-ui/protocol';
import { TerminalDisplayReplay, type DisplayReplayRecord, type DisplayReplaySource } from '../display-replay.js';
import { TerminalOutputProjection } from '../output.js';
import { processArtifactText, processArtifactLines, processArtifactSpans } from '../process-presentation.js';

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
async function setup(replay?: (record: DisplayReplayRecord) => Promise<import('@zhixing/terminal-ui/protocol').TerminalDisplaySegment>) {
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
  const store = new TerminalDisplayStore(root, capacity, account, new AbortController().signal, undefined, replay); stores.push(store);
  return { root, account, store, counts: () => ({ active, outstanding, stored }) };
}

describe('display recovery retains the original cache', () => {
  it('retains only locators for cold durable history and rereads evicted pages without dropping live-only output', async () => {
    const sourceText = '中文😀\n'.repeat(1600), read = vi.fn(async (_source: DisplayReplaySource, offset: number) => sourceText.slice(offset));
    const replay = new TerminalDisplayReplay(read), h = await setup(record => replay.read(record));
    const source: DisplayReplaySource = { kind: 'owner', conversationId: 'test', runId: 'run', length: sourceText.length, markdown: false,
      cursor: { conversationId: 'test', ownerEpoch: 1, revision: 1, message: 0, block: 0, offset: 0 } };
    const segment = (blockId: string) => ({ blockId, role: 'user', text: sourceText, contentOffset: 0, final: true });
    try {
      await h.store.append({ ...segment('unpersisted'), text: 'live-only receipt' });
      for (let i = 0; i < 80; i++) await h.store.append(segment(`cold-${i}`), true, undefined, true, source);
      expect(h.counts().stored).toBeLessThan(Buffer.byteLength(sourceText) * 80 / 5);
      const page = await h.store.page(-4, false);
      expect(page.segments.map(item => item.text)).toEqual(Array(4).fill(sourceText));
      expect(read).toHaveBeenCalled();
      expect((await h.store.page(0)).segments[0]?.text).toBe('live-only receipt');
      read.mockRejectedValueOnce(Error('source unavailable'));
      await expect(h.store.page(-40, false)).rejects.toThrow('source unavailable');
      expect(h.store.paused).toBe(false);
      expect((await h.store.page(-40, false)).segments).toHaveLength(4);
    } finally { replay.close(); }
  });

  it('rejects unavailable capacity, then admits new content without deleting retained pages', async () => {
    const h = await setup();
    await h.store.append({ blockId: 'original', role: 'assistant', text: 'retained prefix', contentOffset: 0, final: false });
    for (let i = 0; i < 3; i++) await h.store.append({ blockId: `fill-${i}`, role: 'process', text: 'x'.repeat(32768), contentOffset: 0, final: true });
    const before = await h.store.page(), charged = h.counts().stored;
    h.account.reserve.mockRejectedValueOnce(Error('synthetic capacity full'));
    await expect(h.store.append({ blockId: 'failed', role: 'assistant', text: 'x'.repeat(32768), contentOffset: 0, final: true })).rejects.toThrow();
    h.account.reserve.mockRejectedValueOnce(Error('synthetic capacity still full'));
    await expect(h.store.retry()).rejects.toThrow('synthetic capacity still full');
    expect(await h.store.page()).toEqual(before);
    await h.store.retry();
    expect(h.account.released).not.toHaveBeenCalled();
    expect(h.counts()).toEqual({ active: 0, outstanding: 0, stored: charged });
    expect(await h.store.page()).toEqual(before);
    await h.store.append({ blockId: 'new', role: 'assistant', text: 'new content', contentOffset: 0, final: true });
    expect((await h.store.page()).segments.at(-1)?.text).toBe('new content');
    expect((await h.store.page(0)).segments[0]?.text).toBe('retained prefix');
  });

  it('keeps an unconfirmed settlement paused while preserving its earlier page', async () => {
    const h = await setup();
    await h.store.append({ blockId: 'original', role: 'assistant', text: 'retained', contentOffset: 0, final: true });
    const before = await h.store.page();
    await h.store.admit();
    h.account.settle.mockRejectedValueOnce(Error('synthetic unknown settlement'));
    await expect(h.store.append({ blockId: 'uncertain', role: 'assistant', text: 'uncertain'.repeat(1024), contentOffset: 0, final: true })).rejects.toThrow();
    await expect(h.store.retry()).rejects.toThrow('terminal-display-recovery-unavailable');
    expect(h.account.released).not.toHaveBeenCalled();
    expect(await h.store.page()).toEqual(before);
  });
});

describe('bounded terminal display projection', () => {
  it('retains a real empty diff EOF row when encoded metadata forces carrier splitting', async () => {
    const h = await setup(), gap = vi.fn(), code = 'a'.repeat(28000);
    const artifact = { kind: 'file-diff' as const, path: 'blank.ts', operation: 'modified' as const,
      changeStats: { kind: 'exact' as const, addedLines: 2, removedLines: 0 },
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: [
        { type: 'added' as const, newLineNumber: 1, content: code }, { type: 'added' as const, newLineNumber: 2, content: '' }] }] };
    const text = processArtifactText(artifact);
    const producer = new TerminalOutputProjection(async segment => { await h.store.append(segment); }, async () => {}, gap,
      { last: 0, work: action => action(), amend: async () => {}, seal: async () => {} });
    try {
      producer.appendProcessBlock({ blockId: 'blank-diff', role: 'tool-diff', text, lines: processArtifactLines(artifact), spans: processArtifactSpans(artifact) });
      await producer.drain();
      expect(gap).not.toHaveBeenCalled();
      const page = await h.store.page(0, false);
      expect(page.segments.length).toBeGreaterThan(1);
      expect(page.segments.map(segment => segment.text).join('')).toBe(text);
      const blank = page.segments.flatMap(segment => segment.body!.context.nodes).filter(node => node.decoration === '+ 2  ');
      expect(blank).toHaveLength(1); expect(blank[0]).toMatchObject({ from: text.length, to: text.length, runs: [] });
    } finally { await producer.close(); }
  });
  it('keeps a partially grown extent charged without publishing or losing the old page', async () => {
    const h = await setup();
    for (let i = 0; i < 3; i++) await h.store.append({ blockId: `old-${i}`, role: 'process', text: 'x'.repeat(32768), contentOffset: 0, final: true });
    const before = await h.store.page(), write = TerminalManagedFiles.prototype.write;
    let extensions = 0;
    vi.spyOn(TerminalManagedFiles.prototype, 'write').mockImplementation(async function(this: TerminalManagedFiles, ...args) {
      const result = await write.apply(this, args);
      if (args[0] === 'display/data' && args[1].length === 1 && ++extensions === 2) throw Error('synthetic extent failure');
      return result;
    });
    await expect(h.store.append({ blockId: 'new', role: 'process', text: 'x'.repeat(32768), contentOffset: 0, final: true })).rejects.toThrow('extent failure');
    expect(extensions).toBe(2);
    expect(h.counts().active).toBe(0);
    expect(h.counts().outstanding).toBeGreaterThan(1024 * 1024);
    expect(await h.store.page()).toEqual(before);
    await expect(h.store.reset()).rejects.toThrow('settlement-unknown');
    expect(h.account.released).not.toHaveBeenCalled();
  });

  it('charges real bounded extents once and preserves old records across allocation and prepend', async () => {
    const h = await setup();
    for (let i = 0; i < 48; i++) await h.store.append({ blockId: `record-${i}`, role: 'process', text: `${i}:` + 'x'.repeat(16000), contentOffset: 0, final: true });
    for (let i = 0; i < 4; i++) await h.store.append({ blockId: `older-${i}`, role: 'process', text: `old-${i}`, contentOffset: 0, final: true }, true);
    const data = await stat(path.join(h.root, 'display/data')), index = await stat(path.join(h.root, 'display/index'));
    expect(h.counts().stored).toBe(data.size + index.size);
    expect(h.counts().outstanding).toBe(0);
    expect(h.account.reserve.mock.calls.length).toBeLessThanOrEqual(3);
    expect(h.account.reserve.mock.calls.every(([, bytes]) => bytes <= TERMINAL_LIMITS.storageReservationBytes)).toBe(true);
    expect((await h.store.page(0)).segments.map(segment => segment.blockId)).toEqual(['record-0', 'record-1', 'record-2', 'record-3']);
    expect((await h.store.page(-4)).segments.map(segment => segment.text)).toEqual(['old-3', 'old-2', 'old-1', 'old-0']);
    expect((await h.store.page()).segments.at(-1)?.text).toBe('47:' + 'x'.repeat(16000));
    await h.store.reset(); expect(h.counts().stored).toBe(0);
  });
  it('reuses only one confirmed hot page and reads evicted content back without retaining history', async () => {
    const h = await setup(), read = vi.spyOn(TerminalManagedFiles.prototype, 'read');
    for (let index = 0; index < 12; index++) await h.store.append({ blockId: `block-${index}`, role: 'assistant', text: `value-${index}`, contentOffset: 0, final: true });
    read.mockClear();
    expect((await h.store.page()).segments.map(item => item.text)).toEqual(['value-8', 'value-9', 'value-10', 'value-11']);
    expect(read).not.toHaveBeenCalled();
    expect((await h.store.page(0)).segments.map(item => item.text)).toEqual(['value-0', 'value-1', 'value-2', 'value-3']);
    expect(read).toHaveBeenCalledTimes(8);
    read.mockClear(); await h.store.page(); expect(read).toHaveBeenCalledTimes(8);
    await h.store.reset(); expect((await h.store.page()).segments).toEqual([]);
  });
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
        contentOffset: change.contentOffset, final: change.body.end, body: change.body }, false, undefined, change.stable);
    }
  };

  it('stores only grammar-unstable carriers in mutable slots and preserves the logical EOF', async () => {
    const h = await setup(), parser = new TerminalBodyProjection('markdown');
    const source = '已完成段落 **bold** 中文🙂\n\n'.repeat(1600);
    await apply(h.store, parser.feed(source));
    await apply(h.store, parser.feed('最后的 *未闭合'));
    await apply(h.store, parser.feed('*'));
    await apply(h.store, parser.end()); await h.store.seal('stream');
    const parts = [];
    for (let at = h.store.first; at < h.store.last; at += 4) parts.push(...(await h.store.page(at, false)).segments);
    expect(parts.map(part => part.text).join('')).toBe(source + '最后的 *未闭合*');
    expect(parts.at(-1)?.body?.end).toBe(true);
    expect(parts.at(-1)?.body?.context.nodes.flatMap(node => node.runs).some(run => run.style === 2 && run.text === '未闭合')).toBe(true);
    const index = await readFile(path.join(h.root, 'display/index'));
    expect(parts.some((part, ordinal) => part.body && index.readUInt32LE(ordinal * 32 + 12) === 0)).toBe(true);
    const physical = (await stat(path.join(h.root, 'display/data'))).size;
    expect(physical).toBeLessThan(parts.length * 2 * 48 * 1024 + TERMINAL_LIMITS.storageReservationBytes);
  });

  it('keeps the current reading page stable while new output advances the tail', async () => {
    const h = await setup(), read = vi.spyOn(TerminalManagedFiles.prototype, 'read');
    for (let i = 0; i < 12; i++) await h.store.append({ blockId: `block-${i}`, role: 'process', text: `value-${i}`, contentOffset: 0, final: true });
    const before = await h.store.page(0); read.mockClear();
    for (let i = 12; i < 40; i++) {
      await h.store.append({ blockId: `block-${i}`, role: 'process', text: `value-${i}`, contentOffset: 0, final: true });
      const page = await h.store.page(0);
      expect(page.last).toBe(i + 1);
      page.segments.forEach((segment, index) => expect(segment).toBe(before.segments[index]));
    }
    expect(read).not.toHaveBeenCalled();
    await h.store.page(8); read.mockClear();
    await h.store.page(0); expect(read).toHaveBeenCalledTimes(8);
  });

  // Sixty separately acknowledged managed-file amendments need real I/O headroom.
  it('keeps a readable multi-fragment stream and bounded physical versions while old fragments are repeatedly amended', async () => {
    const h = await setup(), parser = new TerminalBodyProjection('markdown');
    const prefix = '**' + 'a'.repeat(28_000);
    await apply(h.store, parser.feed(prefix));
    expect(h.store.last).toBeGreaterThan(1);
    const bytesBefore = (await stat(path.join(h.root, 'display/data'))).size;
    const reservations = h.account.reserve.mock.calls.length;
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
    expect(bytesBefore).toBeGreaterThanOrEqual(h.store.last * 2 * 48 * 1024);
    expect(bytesBefore - h.store.last * 2 * 48 * 1024).toBeLessThan(TERMINAL_LIMITS.storageReservationBytes);
    expect(h.account.reserve).toHaveBeenCalledTimes(reservations);
    expect((await h.store.page(h.store.first, false)).segments[0]?.text).toBe(page.segments[0]?.text);
    expect(h.counts().active).toBe(0); expect(h.counts().outstanding).toBe(0);
  }, 10_000);

  it.each(['data', 'index', 'settlement'] as const)('preserves the confirmed page after a failed replacement at %s and seals later writes', async stage => {
    const h = await setup(), parser = new TerminalBodyProjection('markdown');
    await apply(h.store, parser.feed('before'));
    const before = await h.store.page();
    if (stage === 'settlement') {
      await h.store.admit(); // A separately admitted operation still settles its reservation, even with zero growth.
      h.account.settle.mockRejectedValueOnce(Error('synthetic replacement failure'));
    }
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
