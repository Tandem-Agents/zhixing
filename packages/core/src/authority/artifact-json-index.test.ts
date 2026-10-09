import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactJsonIndex } from './artifact-json-index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(value: unknown, directory?: string) {
  const bytes = Buffer.from(JSON.stringify(value));
  const ref = { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length };
  let largestRead = 0, totalRead = 0;
  const store = { readRange: async (_ref: typeof ref, offset: number, limit: number) => {
    largestRead = Math.max(largestRead, limit); totalRead += limit; return bytes.subarray(offset, offset + limit);
  } };
  const index = new ArtifactJsonIndex(store, directory); cleanups.push(() => index.close());
  return { index, ref, store, stats: () => ({ largestRead, totalRead }) };
}
async function ready(f: ReturnType<typeof fixture>) {
  let progress = await f.index.prepare(f.ref, undefined, 64 * 1024);
  while (!progress.ready) progress = await f.index.prepare(f.ref, undefined, 64 * 1024);
}
describe('artifact JSON byte index', () => {
  it('rejects a changed physical source before trusting cached positions or values', async () => {
    let bytes = Buffer.from('{"text":"first"}'), identity = 'generation-1';
    const ref = { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length };
    const index = new ArtifactJsonIndex({ readIdentity: async () => identity,
      readRange: async (_, offset, size) => bytes.subarray(offset, offset + size) });
    cleanups.push(() => index.close());
    await index.prepare(ref); expect(await index.value(ref, ['text'])).toBe('first');
    bytes = Buffer.from('{"text":"other"}'); identity = 'generation-2';
    await expect(index.value(ref, ['text'])).rejects.toThrow();
    await expect(index.prepare(ref)).rejects.toThrow('invalid');
  });
  it('proves canonical bytes across Unicode string chunks, and rejects noncanonical key order', async () => {
    const f = fixture({ a: '😀中文\\\"\n'.repeat(10000), z: [null, false, -3.5] });
    await ready(f); expect(await f.index.canonical(f.ref)).toBe(true);
    const unordered = fixture({ z: 1, a: 2 }); await ready(unordered);
    expect(await unordered.index.canonical(unordered.ref)).toBe(false);
  });
  it('indexes nested metadata and Unicode string pieces without whole-body reads', async () => {
    const body = '你好😀\\\"\n'.repeat(32000);
    const f = fixture({ messages: [{ role: 'assistant', content: [{ type: 'text', text: body }] }], runIndex: 7, nullable: null });
    const initial = await f.index.prepare(f.ref, undefined, 64 * 1024);
    expect(initial).toMatchObject({ ready: false, bytes: 64 * 1024 });
    await ready(f);
    expect(await f.index.value(f.ref, ['runIndex'])).toBe(7);
    expect(await f.index.value(f.ref, ['nullable'])).toBe(null);
    expect(await f.index.value(f.ref, ['absent'])).toBeUndefined();
    const node = (await f.index.node(f.ref, ['messages', 0, 'content', 0, 'text']))!;
    let before = Number.MAX_SAFE_INTEGER, text = '';
    while (true) {
      const pieces = await f.index.text(f.ref, node, before);
      if (!pieces.length) break;
      for (const piece of pieces) text = piece.text + text;
      before = pieces.at(-1)!.offset;
    }
    expect(text).toBe(body);
    expect(node.units).toBe(body.length);
    expect(f.stats().largestRead).toBeLessThanOrEqual(64 * 1024);
  });
  it('uses persistent indexes on a second reader without rescanning the body', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zx-json-index-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const f = fixture({ body: 'x'.repeat(200000), usage: { outputTokens: 12 } }, directory);
    await ready(f); await f.index.close();
    const next = new ArtifactJsonIndex(f.store, directory); cleanups.push(() => next.close());
    const before = f.stats().totalRead;
    expect((await next.prepare(f.ref)).ready).toBe(true);
    expect(await next.value(f.ref, ['usage'])).toEqual({ outputTokens: 12 });
    expect(f.stats().totalRead - before).toBeLessThan(100);
  });
  it('does not publish partial, cancelled, or digest-mismatched scans', async () => {
    const f = fixture({ body: 'x'.repeat(200000) });
    await f.index.prepare(f.ref, undefined, 64 * 1024);
    await expect(f.index.node(f.ref, ['body'])).rejects.toThrow('not-ready');
    const cancellation = new AbortController(); cancellation.abort();
    await expect(f.index.prepare(f.ref, cancellation.signal)).rejects.toBeDefined();
    await f.index.close(); await ready(f);
    await expect(f.index.prepare({ ...f.ref, digest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow('invalid');
  });
  it('rebuilds a corrupt derived database without modifying source artifacts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zx-json-index-corrupt-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(path.join(directory, 'positions-v1.sqlite'), 'not a sqlite database');
    const f = fixture({ text: 'original 中文' }, directory); await ready(f);
    expect(await f.index.value(f.ref, ['text'])).toBe('original 中文');
  });
  it('lets interleaved readers finish distinct large artifacts without resetting progress', async () => {
    const values = [fixture({ text: 'a'.repeat(300000) }), fixture({ text: 'b'.repeat(300000) })];
    const index = new ArtifactJsonIndex({ readRange: (ref, at, size) => values.find(f => f.ref.digest === ref.digest)!.store.readRange(ref, at, size) });
    cleanups.push(() => index.close());
    let complete = [false, false], steps = 0;
    while (!complete.every(Boolean)) {
      for (let i = 0; i < values.length; i++) if (!complete[i]) complete[i] = (await index.prepare(values[i]!.ref, undefined, 65536)).ready;
      expect(++steps).toBeLessThan(8);
    }
    expect(await index.value(values[0]!.ref, ['text'], 400000)).toHaveLength(300000);
    expect(await index.value(values[1]!.ref, ['text'], 400000)).toHaveLength(300000);
  });
});
