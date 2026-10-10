import { describe, expect, it } from 'vitest';
import { BodyReadingWindow } from './body-window.js';
import { bodyRenderBlocks } from './body/layout.js';
import type { BodyPage } from './body-model.js';
import { decodeBodyPage, encodeBodyPage } from './body-model.js';
const page = (start: number, follow = false): BodyPage => ({ first: 0, last: 1000, start, follow,
  segments: Array.from({ length: 4 }, (_, n) => ({ blockId: `message-${start + n}`, role: 'assistant', contentOffset: 0, text: `line-${start + n}`, final: true })) });
describe('continuous bounded body reading', () => {
  it('retains interrupted thinking at a disk boundary without consuming an ordinal or moving it after later output', () => {
    const window = new BodyReadingWindow();
    const interrupted = [{ before: 2, segment: { blockId: 'interrupted', role: 'thinking', contentOffset: 10, text: 'retained', final: true } }];
    const first = { ...page(0), segments: page(0).segments.slice(0, 3), interrupted };
    const decoded = decodeBodyPage(encodeBodyPage(first, 1)).page;
    expect(bodyRenderBlocks(decoded).map(block => block.blockId)).toEqual(['message-0', 'message-1', 'interrupted', 'message-2']);
    window.accept(decoded);
    const next = window.accept(page(3));
    expect(next.interrupted).toEqual(interrupted); expect(next.segments).toHaveLength(7);
    expect(bodyRenderBlocks(next).map(block => block.blockId).slice(0, 4)).toEqual(['message-0', 'message-1', 'interrupted', 'message-2']);
    expect(() => decodeBodyPage(encodeBodyPage({ ...first, interrupted: [{ ...interrupted[0]!, before: 90 }] }, 1))).toThrow('terminal-body-transient-range');
    expect(() => decodeBodyPage(encodeBodyPage({ ...page(0), interrupted }, 1))).toThrow('terminal-body-page-revision');
  });
  it('keeps repeated interrupted tails in source order across wire and reading windows', () => {
    const interrupted = [0, 1, 1].map((before, i) => ({ before, segment: { blockId: `failed-${i}`, role: 'thinking', contentOffset: 0, text: `tail-${i}`, final: true } }));
    const value = { ...page(0), segments: page(0).segments.slice(0, 1), interrupted };
    const decoded = decodeBodyPage(encodeBodyPage(value, 1)).page;
    expect(bodyRenderBlocks(decoded).map(block => block.blockId)).toEqual(['failed-0', 'message-0', 'failed-1', 'failed-2']);
    const window = new BodyReadingWindow(); window.accept(decoded);
    const next = window.accept(page(2));
    expect(next.interrupted).toBeUndefined();
    expect(() => decodeBodyPage(encodeBodyPage({ ...value, interrupted: [...interrupted].reverse() }, 2))).toThrow('terminal-body-transient-range');
  });
  it('joins wire pages in either direction without replacing the visible history', () => {
    const window = new BodyReadingWindow(); window.accept(page(8));
    expect(window.accept(page(4)).segments).toHaveLength(8);
    expect(window.accept(page(12)).segments).toHaveLength(12);
    const unchanged = window.accept({ ...page(4), segments: page(4).segments });
    expect(unchanged.start).toBe(4); expect(unchanged.segments).toHaveLength(12);
  });
  it('bounds memory independently of conversation size and resets on noncontiguous navigation', () => {
    const window = new BodyReadingWindow();
    for (let start = 0; start < 512; start += 4) {
      const result = window.accept(page(start, true));
      expect(result.segments.length).toBeLessThanOrEqual(256);
      expect(result.start + result.segments.length).toBe(start + 4);
    }
    expect(window.accept(page(0)).segments).toHaveLength(4);
    window.reset(); expect(window.accept(page(4)).start).toBe(4);
  });
  it('does not evict a protected reading anchor', () => {
    const window = new BodyReadingWindow();
    for (let start = 0; start < 256; start += 4) window.accept(page(start));
    expect(window.accept(page(256), { blockId: 'message-0', contentOffset: 0 }).start).toBe(0);
    expect(window.notice).toContain('选区');
    expect(window.accept(page(256)).start).toBe(4);
    expect(window.notice).toBeUndefined();
  });
  it('adds one gap between semantic groups and none between tool fragments', () => {
    const value: BodyPage = { first: 0, last: 4, start: 0, follow: false, segments: [
      { blockId: 'user', role: 'user', groupId: 'u', contentOffset: 0, text: '你好', final: true },
      { blockId: 'tool-header', role: 'tool', groupId: 't', contentOffset: 0, text: 'Read', final: true },
      { blockId: 'tool-result', role: 'tool', groupId: 't', contentOffset: 0, text: 'result', final: true },
      { blockId: 'answer', role: 'assistant', groupId: 'a', contentOffset: 0, text: '完成', final: true },
    ] };
    expect(bodyRenderBlocks(value).map(block => block.gapBefore)).toEqual([0, 1, 0, 1]);
  });
});
