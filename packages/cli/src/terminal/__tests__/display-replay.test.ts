import { expect, it } from 'vitest';
import { TerminalDisplayReplay } from '../display-replay.js';
import { HistoryBodyRangeCache } from '../body-projection.js';

it('revalidates a fully cached Markdown range after its source is retired', async () => {
  const text = '**old saved body**'; let cleared = false;
  const replay = new TerminalDisplayReplay(async (_, offset) => {
    if (cleared) throw Error('transcript-byte-generation-changed');
    return text.slice(offset);
  });
  const record = { replay: { kind: 'shard' as const, conversationId: 'c', length: text.length, markdown: true,
    cursor: { shard: '000001.jsonl', identity: 'identity', from: 0, to: 100, message: 0, block: 0, offset: 0 } },
    blockId: 'b', role: 'assistant', contentOffset: 0, length: text.length, final: true, digest: '' };
  try {
    expect((await replay.read(record)).text).toBe(text); cleared = true;
    await expect(replay.read(record)).rejects.toThrow('generation-changed');
  } finally { replay.close(); }
});

it('reconstructs cold Markdown fragments with their original source, styles and coordinates', async () => {
  const text = '# Heading\n\n```typescript\n' + 'const 中文 = "hello😀";\n'.repeat(7000) + '```\n\n**End**';
  const read = async (offset: number) => {
    let end = Math.min(text.length, offset + 8192);
    if (/[\ud800-\udbff]/u.test(text[end - 1]!)) end--;
    return text.slice(offset, end);
  };
  const cache = new HistoryBodyRangeCache(), replay = new TerminalDisplayReplay((_, offset) => read(offset));
  const source = { kind: 'owner' as const, conversationId: 'c', runId: 'r', length: text.length, markdown: true,
    cursor: { conversationId: 'c', ownerEpoch: 1, revision: 1, message: 0, block: 0, offset: 0 } };
  try {
    let page = await cache.read('source', text.length, read);
    while (!page.ready) page = await cache.read('source', text.length, read);
    for (const item of page.items) {
      const restored = await replay.read({ replay: source, blockId: 'b', groupId: 'g', role: 'assistant',
        contentOffset: item.contentOffset, length: item.text.length, final: item.body.end, digest: '' });
      expect(restored.text).toBe(item.text);
      expect(restored.body?.context.nodes).toEqual(item.body.context.nodes);
    }
  } finally { cache.close(); replay.close(); }
});
