import { describe, expect, it } from 'vitest';
import { HistoryBodyRangeCache } from '../body-projection.js';

describe('bounded Markdown source history', () => {
  it('keeps fenced Markdown and Unicode intact across reverse pages without scanning from the beginning each time', async () => {
    const source = '## Header\n\n```typescript\n' + 'const 中文 = "hello😀";\n'.repeat(6000) + '```\n\n**End**';
    const cache = new HistoryBodyRangeCache(); let reads = 0, before = source.length, output = '', pages = 0;
    const read = async (offset: number) => { reads++; let end = Math.min(source.length, offset + 8192); if (/[\ud800-\udbff]/u.test(source[end - 1]!)) end--; return source.slice(offset, end); };
    try {
      while (before > 0) {
        const result = await cache.read('immutable-block', source.length, read, before);
        if (!result.ready) continue;
        expect(result.items.length).toBeGreaterThan(0);
        for (const item of result.items) {
          expect(item.contentOffset + item.text.length).toBe(before);
          before = item.contentOffset; output = item.text + output;
        }
        expect(++pages).toBeLessThan(100);
      }
      expect(output).toBe(source);
      expect(reads).toBeLessThan(pages * Math.ceil(source.length / 8192));
    } finally { cache.close(); }
  });
});
