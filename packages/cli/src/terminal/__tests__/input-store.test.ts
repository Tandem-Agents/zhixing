import { normalizeLeadingSlashAlias } from '@zhixing/terminal-ui/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { DeviceCapacityArbiterPort, DeviceCapacityQuantum } from '@zhixing/core/resources';
import { TerminalInputStore } from '../input-store.js';
import { TerminalInputHistoryReader } from '../input-history.js';
import { TerminalInputSession } from '../../../../terminal-ui/src/input-session.js';
import type { TerminalAction } from '../../../../terminal-ui/src/protocol.js';

const roots: string[] = [];
const stores: TerminalInputStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('zhixing-terminal-input-')) throw Error('Invalid cleanup boundary');
    await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhixing-terminal-input-')); roots.push(root);
  await mkdir(path.join(root, 'input'));
  let active = 0, stored = 0;
  const outstanding = new Map<string, number>();
  const capacity: DeviceCapacityArbiterPort = { async acquire(request) {
    active++; const used: DeviceCapacityQuantum = { readBytes: 0, writeBytes: 0, ioOperations: 0 }; let complete = false;
    return { kind: 'granted', permit: { granted: request.atomic,
      tryBegin: () => ({ claim: (dimension, amount) => {
        if (complete) throw Error('Claim after completion');
        const key = dimension as keyof DeviceCapacityQuantum; used[key] += amount;
        if (used[key] > request.atomic.quantum[key]) throw Error('Physical quantum exceeded');
      }, complete: () => { complete = true; } }),
      release: () => { expect(complete).toBe(true); active--; },
    } };
  } };
  const account = {
    reserve: vi.fn(async (_bucket: 'display' | 'input', bytes: number) => { const token = randomUUID(); outstanding.set(token, bytes); return token; }),
    settle: vi.fn(async (token: string, bytes: number) => { expect(bytes).toBeLessThanOrEqual(outstanding.get(token)!); outstanding.delete(token); stored += bytes; }),
    released: vi.fn(async (_bucket: 'display' | 'input', bytes: number) => { stored -= bytes; }),
  };
  const store = new TerminalInputStore(root, capacity, account, new AbortController().signal); stores.push(store);
  return { root, account, store, counts: () => ({ active, outstanding: outstanding.size, stored }) };
}

async function draft(store: TerminalInputStore, text: string): Promise<string> {
  const id = randomUUID(); store.begin(id, 'draft'); await store.part(id, 0, text, true); return id;
}

describe('terminal cold original references', () => {
  it('replays accepted input in cold pages with the same literal/token order as expansion', async () => {
    const h = await setup(), paste = randomUUID();
    h.store.begin(paste, 'paste'); await h.store.part(paste, 0, '\uFEFF原文🦞\r\n[Pasted #999 +1 lines · 1B]', true);
    const token = h.store.completePaste(paste).token;
    const original = 'a'.repeat(256 * 1024 - 5) + token + '汉🦞'.repeat(20_000) + '[File #99 · literal]' + token + ' tail\r\n';
    const id = randomUUID(); h.store.begin(id, 'draft');
    let index = 0;
    for (let at = 0; at < original.length;) {
      let end = Math.min(original.length, at + 8192);
      if (/[\uD800-\uDBFF]/u.test(original[end - 1]!)) end--;
      await h.store.part(id, index++, original.slice(at, end), false); at = end;
    }
    await h.store.part(id, index, '', true);
    const pages: string[] = [];
    for await (const page of h.store.expandedPages(id)) { expect(Buffer.byteLength(page)).toBeLessThanOrEqual(260 * 1024); pages.push(page); }
    expect(pages.join('')).toBe(await h.store.expand(id, 8 * 1024 * 1024));
    const empty = await draft(h.store, '');
    const emptyPages: string[] = []; for await (const page of h.store.expandedPages(empty)) emptyPages.push(page);
    expect(emptyPages).toEqual([]);
  });

  it('keeps repeated material handles unique and preserves shared owner references', async () => {
    const h = await setup(), id = await draft(h.store, '/synthetic/reused.txt');
    const token = '[File #1 · reused.txt · 7B]';
    expect(h.store.registerHandles(id, Array(100).fill(token).join('\n'))).toEqual([{ token, id }]);
    h.store.retain('current', new Set([id])); h.store.transfer('current', 'saved');
    h.store.published([id]); h.store.forget('current'); await h.store.collect();
    expect(await h.store.text(id, 2 * 1024 * 1024)).toBe('/synthetic/reused.txt');
    h.store.forget('saved'); await h.store.collect();
    expect(h.store.retainedCount).toBe(0);
  });
  it('preserves a leading UTF-8 BOM in original pages and edit windows', async () => {
    const h = await setup(), original = '\uFEFF汉字🦞\r\n  ', id = await draft(h.store, original);
    expect(await h.store.text(id, 2 * 1024 * 1024)).toBe(original);
    const page = await h.store.window(id, 0);
    expect(page.text).toBe(original); expect(page.end).toBe(Buffer.byteLength(original));
  });
  it('reads and edits immutable windows without joining the cold original or cutting handles', async () => {
    const h = await setup(), id = randomUUID();
    const material = await draft(h.store, '/synthetic/image.png');
    const token = '[Pasted #1 +2 lines · 9B]';
    // Register through the actual handle owner, so edge checks distinguish a
    // literal lookalike from a live atomic handle.
    const paste = randomUUID(); h.store.begin(paste, 'paste'); await h.store.part(paste, 0, '原文\n', true);
    const handle = h.store.completePaste(paste).token;
    h.store.registerHandles(material, token);
    const piece = '汉字🙂 x\r\n  '.repeat(1024);
    const original = piece.repeat(12) + handle + piece.repeat(12);
    h.store.begin(id, 'draft');
    let index = 0;
    for (let at = 0; at < original.length;) {
      let end = Math.min(original.length, at + 8192);
      if (/[\uD800-\uDBFF]/u.test(original[end - 1]!)) end--;
      await h.store.part(id, index++, original.slice(at, end), false); at = end;
    }
    await h.store.part(id, index, '', true); await h.store.retainDraft('current', id);
    const encoded = Buffer.from(original);
    const handleStart = Buffer.byteLength(piece.repeat(12));
    const page = await h.store.window(id, handleStart + 12 * 1024 + 2);
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(32 * 1024);
    expect(encoded.subarray(page.start, page.end).toString()).toBe(page.text);
    expect(page.text).toContain(handle);
    expect(page.handles).toContainEqual({ token: handle, id: paste, paste: true });
    const endPage = await h.store.window(id, encoded.length);
    expect(endPage.end).toBe(encoded.length);
    const replacement = await draft(h.store, 'edited 中文🙂\n');
    const next = await h.store.splice(id, page.start, page.end, replacement);
    const hash = createHash('sha256');
    for await (const part of h.store.pages(next)) hash.update(part);
    const expected = Buffer.concat([encoded.subarray(0, page.start), Buffer.from('edited 中文🙂\n'), encoded.subarray(page.end)]);
    expect(hash.digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(h.store.bytes(id)).toBe(encoded.length);
    const oldHash = createHash('sha256'); for await (const part of h.store.pages(id)) oldHash.update(part);
    expect(oldHash.digest('hex')).toBe(createHash('sha256').update(encoded).digest('hex'));
    expect(h.counts().active).toBe(0);
  });

  it('keeps the previous draft readable when replacement admission fails', async () => {
    const h = await setup(), id = await draft(h.store, 'before 中文 after');
    await h.store.retainDraft('current', id);
    const replacement = await draft(h.store, 'new');
    h.account.reserve.mockRejectedValueOnce(Error('synthetic capacity unavailable'));
    await expect(h.store.splice(id, 7, 13, replacement)).rejects.toThrow('capacity unavailable');
    expect(await h.store.text(id, 2 * 1024 * 1024)).toBe('before 中文 after');
  });

  it('edits an ordinary draft larger than J through bounded windows and preserves both versions', async () => {
    const h = await setup(), id = randomUUID(), size = 65 * 1024 * 1024;
    const originalHash = createHash('sha256');
    h.store.begin(id, 'draft', size);
    for (let index = 0; index < size / (32 * 1024); index++) {
      const part = `${index}: `.padEnd(32 * 1024, 'x'); originalHash.update(part);
      await h.store.part(id, index, part, index === size / (32 * 1024) - 1);
      if (process.memoryUsage().rss > 1024 ** 3) throw Error('Isolated input RSS stop');
    }
    await h.store.retainDraft('current', id);
    const page = await h.store.window(id, 32 * 1024 * 1024);
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(32 * 1024);
    const replacement = await draft(h.store, 'edited 中文🙂\n');
    const started = performance.now();
    const next = await h.store.splice(id, page.start, page.end, replacement);
    const spliceMs = performance.now() - started;
    expect(h.store.bytes(next)).toBe(size - (page.end - page.start) + Buffer.byteLength('edited 中文🙂\n'));
    const oldHash = createHash('sha256'), actualHash = createHash('sha256'), expectedHash = createHash('sha256');
    let position = 0, inserted = false;
    for await (const part of h.store.pages(id)) {
      oldHash.update(part); const bytes = Buffer.from(part), end = position + bytes.length;
      if (position < page.start) expectedHash.update(bytes.subarray(0, Math.min(bytes.length, page.start - position)));
      if (!inserted && end >= page.start) { expectedHash.update('edited 中文🙂\n'); inserted = true; }
      if (end > page.end) expectedHash.update(bytes.subarray(Math.max(0, page.end - position)));
      position = end;
    }
    for await (const part of h.store.pages(next)) actualHash.update(part);
    expect(oldHash.digest('hex')).toBe(originalHash.digest('hex'));
    expect(actualHash.digest('hex')).toBe(expectedHash.digest('hex'));
    expect(h.counts().active).toBe(0);
    console.info(JSON.stringify({ inputWindowEvidence: { bytes: size, spliceMs, maxRSS: process.resourceUsage().maxRSS * 1024 } }));

    await h.store.retainDraft(`history:${id}`, id);
    const reader = new TerminalInputHistoryReader(h.store);
    let submitted: string | undefined;
    const request = async (action: TerminalAction): Promise<unknown> => {
      switch (action.kind) {
        case 'input-history': return reader.open(id);
        case 'input-history-end': return reader.close(action.ticket);
        case 'input-window': return h.store.window(action.inputId, action.position);
        case 'input-begin': return h.store.begin(action.inputId, action.purpose, action.bytes);
        case 'input-part': return h.store.part(action.inputId, action.index, action.text, action.final);
        case 'input-splice': { const inputId = await h.store.splice(action.inputId, action.start, action.end, action.replacementId); return { inputId, bytes: h.store.bytes(inputId) }; }
        case 'input-references': await h.store.retainReferences('surface', new Set(action.ids)); h.store.published(action.completed); return { removed: await h.store.collect() };
        case 'input-submit': submitted = action.inputId; await h.store.retainDraft(`frozen:${submitted}`, submitted); return {};
        default: throw Error(`Unexpected input action ${action.kind}`);
      }
    };
    const session = new TerminalInputSession(request, vi.fn()); session.edit('saved 中文', 6);
    await session.history(-1);
    expect(Buffer.byteLength(session.draft.text)).toBeLessThanOrEqual(32 * 1024); expect(session.beforeWindow).toBe(true);
    const tailStart = session.windowStart, tail = session.draft.text;
    session.edit('新🙂' + tail, 3); const submittedAt = performance.now(); await session.submit();
    const integratedMs = performance.now() - submittedAt;
    expect(submitted).not.toBe(id);
    const integratedActual = createHash('sha256'), integratedExpected = createHash('sha256');
    let offset = 0, insert = false;
    for await (const part of h.store.pages(id)) {
      const bytes = Buffer.from(part);
      if (!insert && offset + bytes.length >= tailStart) {
        const cut = tailStart - offset; integratedExpected.update(bytes.subarray(0, cut)); integratedExpected.update('新🙂'); integratedExpected.update(bytes.subarray(cut)); insert = true;
      } else integratedExpected.update(bytes);
      offset += bytes.length;
    }
    for await (const part of h.store.pages(submitted!)) integratedActual.update(part);
    expect(integratedActual.digest('hex')).toBe(integratedExpected.digest('hex'));
    session.edit(session.draft.text + 'newer', session.draft.text.length + 5);
    // The exact receipt version is older than the further local edit.
    const receiptVersion = session.draft.version - 1;
    expect(session.settle({ inputId: submitted!, version: receiptVersion, accepted: true })).toBe(true);
    expect(session.draft.text.endsWith('newer')).toBe(true);
    await session.history(1); expect(session.draft).toMatchObject({ text: 'saved 中文', cursor: 6 });
    await reader.close();
    console.info(JSON.stringify({ inputWindowSurfaceEvidence: { bytes: size, integratedMs, maxRSS: process.resourceUsage().maxRSS * 1024, actualStoreAndSession: true, actualIPCAndRenderer: false } }));
  }, 120_000);

  it('retains material handles outside the visible window until the last cold draft owner is removed', async () => {
    const h = await setup(), paste = randomUUID(); h.store.begin(paste, 'paste'); await h.store.part(paste, 0, '材料原文', true);
    const handle = h.store.completePaste(paste).token, id = randomUUID(); h.store.begin(id, 'draft');
    await h.store.part(id, 0, handle + '\n', false);
    for (let index = 1; index <= 8; index++) await h.store.part(id, index, 'x'.repeat(32 * 1024), index === 8);
    const page = await h.store.window(id, h.store.bytes(id)); expect(page.text).not.toContain(handle);
    await h.store.retainReferences('current', new Set([id])); h.store.published([paste]);
    await h.store.collect(); expect(h.store.bytes(paste)).toBe(Buffer.byteLength('材料原文'));
    const empty = await draft(h.store, '');
    const next = await h.store.splice(id, 0, Buffer.byteLength(handle + '\n'), empty);
    await h.store.retainReferences('current', new Set([next])); h.store.published([empty]);
    const removed = await h.store.collect(); expect(removed).toContain(paste); expect(removed).toContain(id);
    expect(h.store.bytes(next)).toBe(8 * 32 * 1024);
  });

  it('replaces old paste tokens outside the current window across scan-page boundaries without dropping surrounding text', async () => {
    const h = await setup(), old = randomUUID(), incoming = randomUUID();
    for (const id of [old, incoming]) { h.store.begin(id, 'paste'); await h.store.part(id, 0, id === old ? 'old原文' : 'new原文', true); }
    const oldToken = h.store.completePaste(old).token;
    const prefix = 'a'.repeat(256 * 1024 - 5), suffix = '🙂\r\n  '.repeat(8192);
    const original = prefix + oldToken + suffix + oldToken + '\nTAIL';
    const source = randomUUID(); h.store.begin(source, 'draft'); let index = 0;
    for (let offset = 0; offset < original.length;) {
      let end = Math.min(original.length, offset + 8192); if (/[\uD800-\uDBFF]/u.test(original[end - 1]!)) end--;
      await h.store.part(source, index++, original.slice(offset, end), false); offset = end;
    }
    await h.store.part(source, index, '', true); await h.store.retainDraft(`history:${source}`, source);
    const end = h.store.bytes(source);
    const result = await h.store.applyPaste(source, end, end, incoming, end);
    expect(result.end - result.start).toBe(Buffer.byteLength('new原文'));
    const text = await h.store.text(result.inputId, 4 * 1024 * 1024);
    expect(text).toBe(prefix + suffix + '\nTAIL' + 'new原文');
    expect(text).not.toContain(oldToken);
    expect((await h.store.text(source, 4 * 1024 * 1024))).toBe(original);
  });

  it.each([false, true])('keeps each finite extent charged and settles completion/cancellation (unknown length %s)', async unknown => {
    const h = await setup(), id = randomUUID(), size = 2 * 1024 * 1024 + 9;
    h.store.begin(id, 'paste', unknown ? undefined : size);
    for (let index = 0; index < 64; index++) {
      await h.store.part(id, index, 'x'.repeat(32 * 1024), false);
      expect(h.counts().outstanding).toBe(1);
    }
    await h.store.part(id, 64, '汉字abc', true);
    expect(h.counts()).toEqual({ active: 0, outstanding: 0, stored: 2 * 1024 * 1024 + 4096 });
    expect(h.account.reserve.mock.calls.map(call => call[1])).toEqual([1024 * 1024, 1024 * 1024, unknown ? 1024 * 1024 : 4096]);
    expect(h.store.bytes(id)).toBe(size);
    const cancelled = randomUUID(); h.store.begin(cancelled, 'paste', 1024 * 1024);
    await h.store.part(cancelled, 0, 'partial', false);
    expect(h.counts().outstanding).toBe(1);
    await h.store.release(cancelled);
    expect(h.counts()).toEqual({ active: 0, outstanding: 0, stored: 2 * 1024 * 1024 + 4096 });
    await expect(stat(path.join(h.root, 'input', cancelled))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects overrun and premature completion without publishing an incomplete original', async () => {
    const h = await setup(), id = randomUUID(); h.store.begin(id, 'paste', 6);
    await h.store.part(id, 0, '汉', false);
    await expect(h.store.part(id, 1, '', true)).rejects.toThrow('size-mismatch');
    await expect(h.store.part(id, 1, '字xx', true)).rejects.toThrow('size-mismatch');
    expect(() => h.store.completePaste(id)).toThrow('incomplete');
    expect(h.counts().outstanding).toBe(1);
    await h.store.part(id, 1, '字', true);
    expect(await h.store.text(id, 2 * 1024 * 1024)).toBe('汉字');
    expect(h.counts()).toEqual({ active: 0, outstanding: 0, stored: 4096 });
  });

  it('retains an extent on unknown settlement at rollover without writing the next part', async () => {
    const h = await setup(), id = randomUUID(); h.store.begin(id, 'paste', 2 * 1024 * 1024);
    for (let index = 0; index < 32; index++) await h.store.part(id, index, 'x'.repeat(32 * 1024), false);
    h.account.settle.mockRejectedValueOnce(Error('synthetic lost extent receipt'));
    await expect(h.store.part(id, 32, 'next', false)).rejects.toThrow('lost extent receipt');
    await expect(h.store.release(id)).rejects.toThrow('settlement-unknown');
    expect(h.counts()).toEqual({ active: 0, outstanding: 1, stored: 0 });
    await expect(stat(path.join(h.root, 'input', id))).resolves.toMatchObject({ size: 1024 * 1024 });
  });

  it('charges expanded originals by UTF-8 bytes and independent copies, preserving unknown handles literally', async () => {
    const h = await setup(), id = randomUUID();
    const piece = 'x'.repeat(32 * 1024);
    h.store.begin(id, 'paste');
    for (let index = 0; index < 128; index++) await h.store.part(id, index, piece, index === 127);
    const bytes = 4 * 1024 * 1024;
    const exact = bytes * 2 + 1024 * 1024;
    expect((await h.store.text(id, exact)).length).toBe(bytes);
    await expect(h.store.text(id, exact - 1)).rejects.toThrow('工作区不足');
    const { token } = h.store.completePaste(id);
    const draftId = await draft(h.store, `head ${token} tail`);
    expect(await h.store.expand(draftId, 10 * 1024 * 1024)).toBe(`head ${piece.repeat(128)} tail`);
    const literal = '[Pasted #999 +2 lines · 10B]';
    expect(await h.store.expand(await draft(h.store, literal), 2 * 1024 * 1024)).toBe(literal);
  });

  it('pages an ordinary history draft beyond 128 KiB without losing UTF-8, whitespace, or its read pin', async () => {
    const h = await setup(), id = randomUUID();
    const piece = 'before\r\n汉字 🦞\t \u001b[0m end  '.repeat(512);
    h.store.begin(id, 'draft');
    for (let index = 0; index < 32; index++) await h.store.part(id, index, piece, false);
    await h.store.part(id, 32, '\nlast  ', true);
    await h.store.retainDraft(`history:${id}`, id);
    const reader = new TerminalInputHistoryReader(h.store);
    const first = await reader.open(id);
    expect(first.bytes).toBeGreaterThan(256 * 1024);
    h.store.forget(`history:${id}`);
    await h.store.collect();
    const pages: string[] = [];
    for (;;) {
      const page = await reader.next(first.ticket);
      if (page.end) break;
      expect(Buffer.byteLength(page.text!)).toBeLessThanOrEqual(32 * 1024);
      pages.push(page.text!);
    }
    expect(pages.join('')).toBe(piece.repeat(32) + '\nlast  ');
    expect(Buffer.byteLength(pages.join(''))).toBe(first.bytes);
    await reader.close(first.ticket); await h.store.collect();
    await expect(stat(path.join(h.root, 'input', id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(reader.next(first.ticket)).rejects.toThrow('expired');
  });

  it('retains five distinct 15 MiB originals past J, restores first/last, and only frees the 101st evictee after its last reference', async () => {
    const h = await setup();
    const originals: { id: string; draftId: string; token: string; hash: string }[] = [];
    const history: string[] = [];
    for (let sample = 0; sample < 101; sample++) {
      const id = randomUUID(); h.store.begin(id, 'paste');
      const bytes = sample < 5 ? 15 * 1024 * 1024 : 64 * 1024;
      const hash = createHash('sha256'); let index = 0;
      const piece = `${sample}: 汉字🦞 \r\n`.repeat(2048);
      for (let written = 0; written < bytes;) {
        // Exact byte sizes, independent content, and no full original in the test.
        const text = written + Buffer.byteLength(piece) <= bytes ? piece : ' '.repeat(bytes - written);
        for (let offset = 0; offset < text.length;) {
          let end = Math.min(text.length, offset + 8192);
          if (/[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
          const part = text.slice(offset, end); hash.update(part);
          await h.store.part(id, index++, part, false); written += Buffer.byteLength(part); offset = end;
        }
      }
      await h.store.part(id, index, '', true);
      const { token } = h.store.completePaste(id);
      const draftId = await draft(h.store, `prefix\n${token}\n suffix  `);
      await h.store.retainDraft(`history:${sample}`, draftId); h.store.published([id]); history.push(draftId);
      if (sample < 5) originals.push({ id, draftId, token, hash: hash.digest('hex') });
      if (sample === 0) {
        h.store.transfer('history:0', 'saved'); h.store.transfer('history:0', 'frozen'); h.store.retain('current', new Set([id]));
      }
      if (sample === 4) expect(h.store.retainedBytes).toBeGreaterThan(75 * 1024 * 1024);
      expect(h.counts().active).toBe(0); expect(h.counts().outstanding).toBe(0);
      if (process.memoryUsage().rss > 1024 * 1024 * 1024) throw Error('Isolated material RSS stop');
    }
    for (const original of [originals[0]!, originals[4]!]) {
      const hash = createHash('sha256'); let read = 0;
      for await (const page of h.store.pages(original.id)) { hash.update(page); read += Buffer.byteLength(page); }
      expect(read).toBe(15 * 1024 * 1024); expect(hash.digest('hex')).toBe(original.hash);
      const expanded = await h.store.expand(original.draftId, 256 * 1024 * 1024);
      expect(expanded.startsWith('prefix\n')).toBe(true); expect(expanded.endsWith('\n suffix  ')).toBe(true);
      expect(createHash('sha256').update(expanded.slice(7, -10)).digest('hex')).toBe(original.hash);
    }
    h.store.forget('history:0'); await h.store.collect();
    await expect(stat(path.join(h.root, 'input', originals[0]!.id))).resolves.toMatchObject({ size: 15 * 1024 * 1024 });
    h.store.forget('saved'); h.store.forget('current'); await h.store.collect();
    await expect(stat(path.join(h.root, 'input', originals[0]!.id))).resolves.toBeDefined();
    h.store.forget('frozen'); await h.store.collect();
    await expect(stat(path.join(h.root, 'input', originals[0]!.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.counts().active).toBe(0); expect(h.counts().stored).toBeGreaterThan(64 * 1024 * 1024);
  }, 120_000);

  it('keeps an earlier draft usable when a new paste write has unknown settlement', async () => {
    const h = await setup(); const old = await draft(h.store, ' unchanged 汉字 🦞\n');
    await h.store.retainDraft('current', old);
    const incoming = randomUUID(); h.store.begin(incoming, 'paste');
    h.account.settle.mockRejectedValueOnce(Error('synthetic lost receipt'));
    await expect(h.store.part(incoming, 0, 'partial', true)).rejects.toThrow('lost receipt');
    h.store.published([incoming]); await h.store.collect();
    expect(await h.store.text(old, 1024 * 1024 * 2)).toBe(' unchanged 汉字 🦞\n');
    expect(h.counts().outstanding).toBe(1); expect(h.counts().active).toBe(0);
    await expect(stat(path.join(h.root, 'input', incoming))).resolves.toBeDefined();
  });

  it.each([
    ['a'.repeat(199), false], ['a'.repeat(200), true], ['中'.repeat(66) + 'a', false], ['中'.repeat(66) + 'ab', true],
    ['one\ntwo\nthree\n\n\n', false], ['one\ntwo\nthree\nfour\n\n', true],
    ['one\r\ntwo\r\nthree\r\n\r\n', false], ['one\r\ntwo\r\nthree\r\nfour\r\n\r\n', true],
  ] as const)('uses the 200 UTF-8 byte / four nontrailing-line threshold (%s)', async (text, fold) => {
    const h = await setup(), id = randomUUID(); h.store.begin(id, 'paste'); await h.store.part(id, 0, text, true);
    expect(h.store.completePaste(id).fold).toBe(fold);
  });

  it('folds the first long paste inside surrounding text and settles its token extent before the suffix copy', async () => {
    const h = await setup(), incoming = randomUUID(); h.store.begin(incoming, 'paste'); await h.store.part(incoming, 0, '中'.repeat(80), true);
    const paste = h.store.completePaste(incoming), source = await draft(h.store, 'beforeMARKafter');
    const result = await h.store.applyPaste(source, 6, 10, incoming, 15);
    expect(await h.store.text(result.inputId, 2 * 1024 * 1024)).toBe('before' + paste.token + 'after');
    expect(result.cursor).toBe(result.bytes); expect(h.counts().outstanding).toBe(0);
  });

  it('expands a replacement larger than the U window, finds cold old tokens, preserves chips and rebases intervening edits', async () => {
    const h = await setup();
    const upload = async (text: string, purpose: 'draft' | 'paste') => {
      const id = randomUUID(); h.store.begin(id, purpose); let index = 0;
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + 8192);
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
        await h.store.part(id, index++, text.slice(offset, end), false); offset = end;
      }
      await h.store.part(id, index, '', true); return id;
    };
    const old = await upload('old'.repeat(100), 'paste'), oldToken = h.store.completePaste(old).token;
    const material = await upload('synthetic-file-path', 'paste'), chip = '[File #1 · keep.txt · 7B]';
    h.store.registerHandles(material, chip);
    const prefix = 'a'.repeat(256 * 1024 - 5), suffix = 'b'.repeat(64 * 1024) + chip + ' tail';
    const source = await upload(prefix + oldToken + suffix, 'draft'); await h.store.retainDraft(`history:${source}`, source);
    const reader = new TerminalInputHistoryReader(h.store);
    const incoming = '\uFEFF新原文 🙂\r\n'.repeat(30_000);
    let entered!: () => void, release!: () => void, applies = 0, submitted: string | undefined;
    const applying = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const noWholeRead = vi.spyOn(h.store, 'text').mockRejectedValue(Error('whole original read forbidden'));
    const request = async (action: TerminalAction): Promise<unknown> => {
      switch (action.kind) {
        case 'input-history': return reader.open(source);
        case 'input-history-end': return reader.close(action.ticket);
        case 'input-window': return h.store.window(action.inputId, action.position);
        case 'input-begin': return h.store.begin(action.inputId, action.purpose, action.bytes);
        case 'input-part': return h.store.part(action.inputId, action.index, action.text, action.final);
        case 'input-splice': return h.store.editWindow(action.inputId, action.start, action.end, action.replacementId);
        case 'input-references': return h.store.reconcileReferences(action.version, action.ids, action.completed, action.cached);
        case 'paste-finish': {
          const paste = h.store.completePaste(action.inputId);
          if (!action.draft) return { textEdit: true, text: paste.token, paste: true };
          const edit = await h.store.applyPaste(action.draft.inputId, action.draft.start, action.draft.end, action.inputId, action.draft.cursor);
          if (++applies === 1) { entered(); await held; }
          return { edit };
        }
        case 'input-submit': submitted = action.inputId; await h.store.retainDraft(`frozen:${submitted}`, submitted); return {};
        default: throw Error(`Unexpected paste action ${action.kind}`);
      }
    };
    const session = new TerminalInputSession(request, vi.fn()); await session.history(-1);
    expect(session.draft.text).not.toContain(oldToken); const oldStart = session.windowStart;
    const work = session.paste(Buffer.from(incoming)); await applying;
    session.edit('X' + session.draft.text + 'Y', session.draft.text.length + 2);
    release(); await work;
    expect(applies).toBe(2); expect(noWholeRead).not.toHaveBeenCalled();
    expect(Buffer.byteLength(session.draft.text)).toBeLessThanOrEqual(32 * 1024);
    expect(session.draft.text).not.toContain('[Pasted'); expect(session.beforeWindow).toBe(true);
    // Both inserted keystrokes belong to the newer draft. The cold token only
    // precedes its window, so deleting it shifts X's absolute position.
    const original = prefix + oldToken + suffix;
    const encoded = Buffer.from(original);
    const edited = encoded.subarray(0, oldStart).toString('utf8') + 'X' + encoded.subarray(oldStart).toString('utf8') + incoming + 'Y';
    const expected = edited.replace(oldToken, '');
    session.edit(session.draft.text, 0); await session.navigate('left');
    expect(session.afterWindow).toBe(true); await session.submit();
    const hash = createHash('sha256'); for await (const page of h.store.pages(submitted!)) hash.update(page);
    expect(hash.digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(h.counts().active).toBe(0); await reader.close();
  });

});


it('keeps folded slash-like paste bodies out of the raw command source and original history', async () => {
  const h = await setup();
  for (const prefix of ['\u3001clear', '/clear']) {
    const paste = randomUUID(), body = prefix + '\n' + 'paragraph'.repeat(1000);
    h.store.begin(paste, 'paste'); await h.store.part(paste, 0, body, true);
    const token = h.store.completePaste(paste).token, id = await draft(h.store, token);
    const head = await h.store.window(id, 0);
    expect(normalizeLeadingSlashAlias(head.text.trim()).startsWith('/')).toBe(false);
    expect(head.text).toBe(token); expect(await h.store.expand(id, 4 * 1024 * 1024)).toBe(body);
    expect((await h.store.window(id, 0)).text).toBe(token);
  }
});
