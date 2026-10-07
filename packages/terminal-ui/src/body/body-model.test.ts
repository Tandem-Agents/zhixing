import { describe, expect, it } from 'vitest';
import { bodyWindows, sliceBodyNodes, validateBodyMetadata, type BodyPage, type BodyNode } from '../body-model.js';
import { bodyCell, bodyRenderBlocks, renderedToSource, sourceToRendered } from './layout.js';

const source = '甲**🙂文字**尾';
const node: BodyNode = { from: 0, to: source.length, kind: 'paragraph', anchor: true, runs: [
  { from: 0, to: 1, text: '甲', style: 0 }, { from: 3, to: 7, text: '🙂文字', style: 1 }, { from: 9, to: 10, text: '尾', style: 0 },
] };
const page = (): BodyPage => ({ first: 0, last: 2, start: 0, follow: false, segments: [0, 5].map((offset, index) => {
  const text = source.slice(offset, index ? source.length : 5);
  return { blockId: 'block', contentOffset: offset, text, role: 'assistant', final: true,
    body: { version: 1, revision: 2, kind: 'markdown', end: !!index, context: { nodes: sliceBodyNodes([node], offset, offset + text.length) } } };
}) });
describe('finite body page source positions', () => {
  it('joins a semantic continuation with one decoration and no source replay', () => {
    const blocks = bodyRenderBlocks(page());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('甲🙂文字尾');
    expect(blocks[0]?.node.anchor).toBe(true);
    expect(renderedToSource(blocks[0]!, 3)).toEqual({ blockId: 'block', contentOffset: 5 });
    expect(sourceToRendered(blocks[0]!, { blockId: 'block', contentOffset: 5 })).toBe(3);
  });
  it('treats transport final as unrelated to typed logical EOF', () => {
    expect(bodyWindows(page())[0]?.end).toBe(false);
  });
  it('rejects forged source ranges, oversized pages and unknown schema fields', () => {
    const first = page().segments[0]!;
    expect(validateBodyMetadata({ ...first.body, extra: true }, 0, 5)).toBe(false);
    expect(validateBodyMetadata({ ...first.body, context: { nodes: [{ ...node, to: 10000 }] } }, 0, 5)).toBe(false);
    expect(() => bodyWindows({ ...page(), segments: Array(5).fill(first) })).toThrow('terminal-body-page-capacity');
  });
  it('replaces controls only in rendered runs and keeps original UTF-16 coordinates', () => {
    const value = page();
    const plain: BodyPage = { ...value, segments: [{ blockId: 'plain', contentOffset: 0, role: 'user', text: 'a\x1bb', final: true }] };
    expect(bodyRenderBlocks(plain)[0]?.text).toBe('a␛b');
    expect(plain.segments[0]?.text).toBe('a\x1bb');
  });
  it('restores a table anchor only into its owning cell after reflow', () => {
    const row = { key: 'row', blockId: 'table', role: 'assistant', text: '左列右列',
      node: { from: 0, to: 12, kind: 'table' as const, columns: 2, runs: [] }, runs: [
        { from: 2, to: 4, text: '左列', style: 0, cell: 0 }, { from: 7, to: 9, text: '右列', style: 0, cell: 1 },
      ] };
    const anchor = { blockId: 'table', contentOffset: 8 };
    expect(sourceToRendered(bodyCell(row, 0), anchor)).toBeUndefined();
    expect(sourceToRendered(bodyCell(row, 1), anchor)).toBe(1);
    expect(renderedToSource(bodyCell(row, 1), 1)).toEqual(anchor);
  });
});
