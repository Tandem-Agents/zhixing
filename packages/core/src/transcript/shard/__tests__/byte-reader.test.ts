import { describe, expect, it } from 'vitest';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempDir } from '@zhixing/test-utils';
import { TranscriptByteReader, type TranscriptBodyCursor } from '../byte-reader.js';

describe('legacy byte history', () => {
  it.each([false, true])('rejects retired cursors after clear, including cold reopen and cross-shard=%s', async crossShard => {
    const root = await createTempDir('byte-history-clear');
    const record = (i: number, text: string) => JSON.stringify({ type: 'run', runIndex: i, messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] }) + '\n';
    await writeFile(path.join(root, '000001.jsonl'), record(0, 'old saved body'));
    const cache = path.join(root, '.read-index'); let reader = new TranscriptByteReader(root, cache);
    try {
      const cursor = (await reader.page()).fragments[0]!.cursor;
      await appendFile(path.join(root, crossShard ? '000002.jsonl' : '000001.jsonl'), record(1, 'new body'));
      expect((await reader.page({ cursor, forward: true })).fragments[0]?.text).toBe('old saved body');
      await appendFile(path.join(root, crossShard ? '000002.jsonl' : '000001.jsonl'), JSON.stringify({ type: 'clear', timestamp: '2026-10-09T00:00:00Z' }) + '\n');
      await expect(reader.page({ cursor, forward: true })).rejects.toThrow('generation-changed');
      expect((await reader.page()).fragments).toEqual([]);
      await reader.close(); reader = new TranscriptByteReader(root, cache);
      await expect(reader.page({ cursor, forward: true })).rejects.toThrow('generation-changed');
      expect((await reader.page()).hasMore).toBe(false);
    } finally { await reader.close(); }
  });
  it('reads a giant JSONL record without a transcript index, preserves source and reuses verified positions', async () => {
    const root = await createTempDir('byte-history'), body = '中🙂\\\n'.repeat(220000);
    const record = (runIndex: number, text: string) => JSON.stringify({ type: 'run', runIndex, messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });
    await writeFile(path.join(root, '000001.jsonl'), record(0, 'invisible') + '\n' + JSON.stringify({ type: 'clear', timestamp: '2026-10-09T00:00:00Z' }) + '\n' + record(1, body) + '\n');
    const cache = path.join(root, '.read-index'); let reader = new TranscriptByteReader(root, cache), cursor: TranscriptBodyCursor | undefined, output = '', preparing = 0;
    try {
      for (;;) {
        const page = await reader.page({ cursor }); cursor = page.cursor;
        if (page.preparing) { expect(++preparing).toBeLessThan(20); continue; }
        for (const part of page.fragments) { expect(part.runIndex).toBe(1); expect(part.offset + part.text.length).toBe(body.length - output.length); output = part.text + output; }
        if (!page.hasMore) break;
      }
      expect(output).toBe(body);
      await reader.close(); reader = new TranscriptByteReader(root, cache);
      const tail = await reader.page(); expect(tail.preparing).toBeUndefined(); expect(tail.fragments.length).toBeGreaterThan(0);
      const first = tail.fragments[0]!;
      const forward = await reader.page({ cursor: { ...first.cursor, offset: 17 }, forward: true });
      expect(forward.fragments[0]?.text).toBe(body.slice(17, 17 + forward.fragments[0]!.text.length));
      const boundary = first.offset + 7;
      const partial = await reader.page({ cursor: { ...first.cursor, offset: boundary } });
      expect(partial.fragments[0]!.offset + partial.fragments[0]!.text.length).toBe(boundary);
      await appendFile(path.join(root, '000001.jsonl'), record(2, 'new') + '\n');
      const oldPage = await reader.page({ cursor: first.cursor });
      expect(oldPage.fragments[0]?.runIndex).toBe(1);
      await writeFile(path.join(root, '000001.jsonl'), record(2, 'replacement') + '\n');
      await expect(reader.page({ cursor: first.cursor })).rejects.toThrow('generation-changed');
    } finally { await reader.close(); }
  }, 30000);
  it('crosses shards and empty message blocks without inventing content', async () => {
    const root = await createTempDir('byte-history-shards');
    await writeFile(path.join(root, '000001.jsonl'), JSON.stringify({ type: 'run', runIndex: 0, messages: [{ role: 'user', content: [{ type: 'text', text: 'old' }] }] }) + '\n');
    await writeFile(path.join(root, '000002.jsonl'), JSON.stringify({ type: 'run', runIndex: 1, messages: [{ role: 'assistant', content: [] }] }) + '\n');
    const reader = new TranscriptByteReader(root);
    try { expect((await reader.page()).fragments[0]?.text).toBe('old'); } finally { await reader.close(); }
  });
});
