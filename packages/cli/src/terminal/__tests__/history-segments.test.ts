import { describe, expect, it } from 'vitest';
import { textFragments, projectHistorySegments, projectRenderedHistoryReverse } from '../history-segments.js';

describe('history segment projection', () => {
  it('uses source kind and real logical EOF when restoring Markdown and literal user history', async () => {
    const assistant = '# 标题\r\n\r\n- 中文 🦞\r\n\r\n```ts\r\nconst n = 1;\r\n```\r\n';
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: '**保持原文**' }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: assistant }] },
    ];
    const result = [];
    for await (const segment of projectRenderedHistoryReverse([{ shardId: 'own', record: { type: 'run', runIndex: 0, timestamp: '2026-10-05', messages } }])) result.push(segment);
    const rendered = result.filter(item => item.role === 'assistant').reverse();
    expect(rendered.map(item => item.text).join('')).toBe(assistant);
    expect(rendered.at(-1)?.body?.end).toBe(true);
    expect(rendered.every(item => item.body?.kind === 'markdown')).toBe(true);
    expect(rendered.flatMap(item => item.body!.context.nodes).some(node => node.kind === 'code' && node.language === 'ts')).toBe(true);
    expect(result.find(item => item.role === 'user')).toMatchObject({ text: '**保持原文**', contentOffset: 0, body: { kind: 'plain', end: true } });
    for (const segment of rendered) expect(assistant.slice(segment.contentOffset, segment.contentOffset + segment.text.length)).toBe(segment.text);
  });

  it('preserves multi-byte characters, surrogate pairs, whitespace and original offsets within byte limits', () => {
    const original = '  开始\r\n' + '汉字🦞 e\u0301\t\n'.repeat(20_000) + '  结束\n';
    const chunks = [...textFragments(original)];
    expect(chunks.map(chunk => chunk.text).join('')).toBe(original);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(32 * 1024);
      expect(original.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
      const last = chunk.text.charCodeAt(chunk.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(chunks.at(-1)?.final).toBe(true);
  });
  it('keeps durable run and block identity while presenting pages in chronological order', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: ' original\n' }] }];
    const result = [...projectHistorySegments([
      { shardId: 'second', record: { type: 'run', runIndex: 2, timestamp: '2026-10-04', messages } },
      { shardId: 'first', record: { type: 'run', runIndex: 1, timestamp: '2026-10-03', messages } },
    ])];
    expect(result.map(segment => segment.blockId)).toEqual(['first:1:0:0', 'second:2:0:0']);
    expect(result.map(segment => segment.text)).toEqual([' original\n', ' original\n']);
  });
});
