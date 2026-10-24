import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempDir } from '@zhixing/test-utils';
import type { Message } from '../../../types/messages.js';
import { TranscriptByteReader, type TranscriptBodyCursor } from '../byte-reader.js';
import { ShardedTranscriptStore } from '../store.js';

const run = (messages: Message[]) => ({ timestamp: '2026-10-09T00:00:00.000Z', messages });
const assistant = (text: string): Message[] => [{ role: 'assistant', content: [{ type: 'text', text }] }];

describe('byte history', () => {
  it.each([false, true])('rejects retired cursors after clear, including cold reopen and cross-shard=%s', async crossShard => {
    const home = await createTempDir('byte-history-clear');
    const store = new ShardedTranscriptStore(home, crossShard ? { maxShardBytes: 1 } : undefined);
    const dir = path.join(home, 'c', 'transcript');
    await store.appendRunRecord('c', run(assistant('old saved body')));
    const cache = path.join(home, '.read-index'); let reader = new TranscriptByteReader(dir, cache);
    try {
      const cursor = (await reader.page()).fragments[0]!.cursor;
      await store.appendRunRecord('c', run(assistant('new body')));
      expect((await reader.page({ cursor, forward: true })).fragments[0]?.text).toBe('old saved body');
      await store.appendClear('c');
      await expect(reader.page({ cursor, forward: true })).rejects.toThrow('generation-changed');
      expect((await reader.page()).fragments).toEqual([]);
      await reader.close(); reader = new TranscriptByteReader(dir, cache);
      await expect(reader.page({ cursor, forward: true })).rejects.toThrow('generation-changed');
      expect((await reader.page()).hasMore).toBe(false);
    } finally { await reader.close(); }
  });
  it('reads a giant record after clear, preserves source and reuses verified positions', async () => {
    const home = await createTempDir('byte-history'), body = '中🙂\\\n'.repeat(220000);
    const store = new ShardedTranscriptStore(home);
    const dir = path.join(home, 'c', 'transcript');
    await store.appendRunRecord('c', run(assistant('invisible')));
    await store.appendClear('c');
    await store.appendRunRecord('c', run(assistant(body)));
    const cache = path.join(home, '.read-index'); let reader = new TranscriptByteReader(dir, cache), cursor: TranscriptBodyCursor | undefined, output = '', preparing = 0;
    try {
      for (;;) {
        const page = await reader.page({ cursor }); cursor = page.cursor;
        if (page.preparing) { expect(++preparing).toBeLessThan(20); continue; }
        for (const part of page.fragments) { expect(part.runIndex).toBe(1); expect(part.offset + part.text.length).toBe(body.length - output.length); output = part.text + output; }
        if (!page.hasMore) break;
      }
      expect(output).toBe(body);
      await reader.close(); reader = new TranscriptByteReader(dir, cache);
      const tail = await reader.page(); expect(tail.preparing).toBeUndefined(); expect(tail.fragments.length).toBeGreaterThan(0);
      const first = tail.fragments[0]!;
      const forward = await reader.page({ cursor: { ...first.cursor, offset: 17 }, forward: true });
      expect(forward.fragments[0]?.text).toBe(body.slice(17, 17 + forward.fragments[0]!.text.length));
      const boundary = first.offset + 7;
      const partial = await reader.page({ cursor: { ...first.cursor, offset: boundary } });
      expect(partial.fragments[0]!.offset + partial.fragments[0]!.text.length).toBe(boundary);
      await store.appendRunRecord('c', run(assistant('new')));
      const oldPage = await reader.page({ cursor: first.cursor });
      expect(oldPage.fragments[0]?.runIndex).toBe(1);
      // 直接改写分片文件（等长，已发布范围仍完整）：身份改变，旧游标必须拒绝
      const shardPath = path.join(dir, '000001.jsonl');
      await writeFile(shardPath, (await readFile(shardPath, 'utf-8')).replace('中', '囗'));
      await expect(reader.page({ cursor: first.cursor })).rejects.toThrow('generation-changed');
    } finally { await reader.close(); }
  }, 30000);
  it('crosses shards and empty message blocks without inventing content', async () => {
    const home = await createTempDir('byte-history-shards');
    const store = new ShardedTranscriptStore(home, { maxShardBytes: 1 });
    await store.appendRunRecord('c', run([{ role: 'user', content: [{ type: 'text', text: 'old' }] }]));
    await store.appendRunRecord('c', run([{ role: 'assistant', content: [] }]));
    const reader = new TranscriptByteReader(path.join(home, 'c', 'transcript'));
    try { expect((await reader.page()).fragments[0]?.text).toBe('old'); } finally { await reader.close(); }
  });
  it('reports a published shard cut short at a line boundary as damage, not as missing history', async () => {
    const home = await createTempDir('byte-history-truncated');
    const store = new ShardedTranscriptStore(home, { maxShardBytes: 1 });
    const dir = path.join(home, 'c', 'transcript');
    for (const text of ['first', 'second', 'third']) await store.appendRunRecord('c', run(assistant(text)));
    // 只留 header 行：截在行边界，剩下的字节本身都可解析
    const cut = async (name: string) => {
      const file = path.join(dir, name), text = await readFile(file, 'utf-8');
      await writeFile(file, text.slice(0, text.indexOf('\n') + 1));
    };
    await cut('000001.jsonl'); // 更早的封存片：封片长度记在后继片的位置文件头
    let reader = new TranscriptByteReader(dir);
    try {
      await expect((async () => { for await (const _ of reader.records()) { /* 读到底 */ } })()).rejects.toThrow('shard-truncated');
    } finally { await reader.close(); }
    await cut('000003.jsonl'); // 活跃片
    reader = new TranscriptByteReader(dir);
    try { await expect(reader.page()).rejects.toThrow('shard-truncated'); } finally { await reader.close(); }
  });
  it('reads nothing from shard bytes that are not covered by a published root', async () => {
    const home = await createTempDir('byte-history-unpublished');
    const dir = path.join(home, 'c', 'transcript');
    await new ShardedTranscriptStore(home).init('c');
    await writeFile(path.join(dir, '000001.jsonl'), JSON.stringify({ type: 'run', runIndex: 0, messages: assistant('unpublished') }) + '\n');
    const reader = new TranscriptByteReader(dir);
    try { expect((await reader.page()).fragments).toEqual([]); } finally { await reader.close(); }
  });
});
