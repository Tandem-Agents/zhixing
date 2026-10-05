import { describe, expect, it } from 'vitest';
import { textFragments, projectHistorySegments } from '../history-segments.js';

describe('history segment projection', () => {
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
