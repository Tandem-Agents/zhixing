import { expect, it } from 'vitest';
import { TerminalDisplayReplay, runOutcomeText } from '../display-replay.js';
import { HistoryBodyRangeCache } from '../body-projection.js';

it('rebuilds a run outcome line from its locator and states each outcome in user terms', async () => {
  const replay = new TerminalDisplayReplay(async () => { throw Error('outcome lines never read the transcript'); });
  const text = runOutcomeText('failed', 'Storage maintenance was not admitted: backpressured:readBytes (projection-flush)')!;
  expect(text).toBe('⚠ 这次运行未完成：本机存储当时正忙于维护，运行写入未被接纳而中断。');
  const segment = await replay.read({ replay: { kind: 'outcome', conversationId: 'c', runId: 'r', state: 'failed',
    reason: 'Storage maintenance was not admitted: backpressured:readBytes (projection-flush)', length: text.length, markdown: false },
    blockId: 'owner-log:r:outcome', groupId: 'r:outcome', role: 'notice', contentOffset: 0, length: text.length, final: true, digest: '' });
  expect(segment).toMatchObject({ blockId: 'owner-log:r:outcome', role: 'notice', text });
  expect(runOutcomeText('failed', 'Connection error.')).toBe('⚠ 这次运行未完成：无法连接模型服务：请检查网络、代理或服务地址后重试。');
  expect(runOutcomeText('cancelled')).toBe('这次运行已停止。');
  expect(runOutcomeText('uncertain')).toContain('/resolve');
  expect(runOutcomeText('running')).toContain('仍在进行');
  expect(runOutcomeText('missing')).toContain('找不到这次运行的记录');
  for (const quiet of ['committed', 'unknown'] as const) expect(runOutcomeText(quiet)).toBeUndefined();
  replay.close();
});

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
