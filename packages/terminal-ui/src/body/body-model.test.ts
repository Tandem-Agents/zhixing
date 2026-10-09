import { describe, expect, it } from 'vitest';
import { bodyWindows, decodeBodyPage, encodeBodyPage, sameBodyPageContent, sliceBodyNodes, validateBodyMetadata, type BodyPage, type BodyNode } from '../body-model.js';
import { bodyCell, bodyRenderBlocks, retainBodyBlocks, renderedToSource, sourceToRendered } from './layout.js';

const source = '甲**🙂文字**尾';
it('keeps a decorated empty EOF row in exactly one nonempty encoded carrier', () => {
  const blank: BodyNode = { from: 12, to: 12, origin: 12, kind: 'paragraph', decoration: '+ 2  ', runs: [] };
  expect(sliceBodyNodes([blank], 0, 6)).toEqual([]);
  expect(sliceBodyNodes([blank], 6, 12)).toEqual([blank]);
  expect(sliceBodyNodes([blank], 12, 12)).toEqual([]);
  expect(sliceBodyNodes([blank], 12, 20)).toEqual([]);
});
const node: BodyNode = { from: 0, to: source.length, kind: 'paragraph', anchor: true, runs: [
  { from: 0, to: 1, text: '甲', style: 0 }, { from: 3, to: 7, text: '🙂文字', style: 1 }, { from: 9, to: 10, text: '尾', style: 0 },
] };
const page = (): BodyPage => ({ first: 0, last: 2, start: 0, follow: false, segments: [0, 5].map((offset, index) => {
  const text = source.slice(offset, index ? source.length : 5);
  return { blockId: 'block', contentOffset: offset, text, role: 'assistant', final: true,
    body: { version: 1, revision: 2, kind: 'markdown', end: !!index, context: { nodes: sliceBodyNodes([node], offset, offset + text.length) } } };
}) });
describe('finite body page source positions', () => {
  it('distinguishes range growth from changed reading content, navigation and follow mode', () => {
    const before = page(), after = { ...before, first: -8, last: 100 };
    expect(sameBodyPageContent(before, after)).toBe(true);
    expect(sameBodyPageContent(before, { ...after, follow: true })).toBe(false);
    expect(sameBodyPageContent(before, { ...after, start: 1 })).toBe(false);
    expect(sameBodyPageContent(before, { ...after, segments: [after.segments[0]!] })).toBe(false);
    expect(sameBodyPageContent(before, { ...after, segments: after.segments.map(segment => ({ ...segment })) })).toBe(false);
    const blocks = bodyRenderBlocks(before);
    expect(retainBodyBlocks(bodyRenderBlocks(after), blocks)).toBe(blocks);
  });
  it('reuses immutable validated snapshots without admitting mutation or a different source range', () => {
    const value = page(), windows = bodyWindows(value), body = value.segments[0]!.body!;
    expect(bodyWindows(value)).toBe(windows);
    expect(() => Object.assign(body.context.nodes[0]!.runs[0]!, { text: 'changed' })).toThrow();
    expect(() => Object.assign(value.segments[0]!, { text: 'changed' })).toThrow();
    expect(() => Object.assign(value, { segments: [] })).toThrow();
    expect(validateBodyMetadata(body, 0, 4)).toBe(false);
    expect(validateBodyMetadata(body, 0, 100)).toBe(true);
    expect(validateBodyMetadata(body, 0, 5)).toBe(true);
    expect(validateBodyMetadata({ ...body, extra: true }, 0, 5)).toBe(false);
  });
  it('joins immutable plain fragments by source identity without merging adjacent blocks', () => {
    const fragments: BodyPage = { first: 0, last: 3, start: 0, follow: false, segments: [
      { blockId: 'plain', contentOffset: 0, role: 'process', text: '**原样**🙂', final: false },
      { blockId: 'plain', contentOffset: 8, role: 'process', text: '\r\n继续', final: true },
      { blockId: 'next', contentOffset: 0, role: 'process', text: '下条', final: true },
    ] };
    const blocks = bodyRenderBlocks(fragments);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toBe('**原样**🙂\r\n继续');
    expect(renderedToSource(blocks[0]!, 11)).toEqual({ blockId: 'plain', contentOffset: 11 });
    expect(sourceToRendered(blocks[0]!, { blockId: 'plain', contentOffset: 11 })).toBe(11);
    expect(blocks[1]?.text).toBe('下条');
  });
  it('reuses only the exact previous wire page and rejects stale or missing bases', () => {
    const source = page(), first = decodeBodyPage(encodeBodyPage(source, 1));
    const next = { ...source, follow: true, segments: [source.segments[0]!, { ...source.segments[1]!, text: 'different', body: undefined }] };
    const patch = encodeBodyPage(next, 2, { revision: 1, page: source });
    expect(patch.segments[0]).toBe(0);
    const decoded = decodeBodyPage(patch, first);
    expect(decoded.page.segments[0]).toBe(first.page.segments[0]);
    expect(decoded.page).toEqual(next);
    expect(() => decodeBodyPage(patch)).toThrow('revision');
    expect(() => decodeBodyPage(patch, decoded)).toThrow('revision');
    expect(() => decodeBodyPage({ ...patch, segments: [4] }, first)).toThrow('reference');
    expect(() => decodeBodyPage({ ...patch, base: undefined, segments: [0] }, first)).toThrow('reference');
    expect(decodeBodyPage(encodeBodyPage(source, 3), decoded).page).toEqual(source);
  });
  it('retains only unchanged leaf identities, including their source coordinates and style', () => {
    const previous = bodyRenderBlocks(page()), copy = structuredClone(previous);
    expect(retainBodyBlocks(copy, previous)[0]).toBe(previous[0]);
    const changed = { ...copy[0]!, runs: copy[0]!.runs.map(run => ({ ...run, style: 2 })) };
    expect(retainBodyBlocks([changed], previous)[0]).toBe(changed);
    const moved = { ...copy[0]!, node: { ...copy[0]!.node, from: 1 } };
    expect(retainBodyBlocks([moved], previous)[0]).toBe(moved);
    expect(retainBodyBlocks([], previous)).toEqual([]);
  });
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
    expect(() => bodyWindows({ ...page(), last: 257, segments: Array(257).fill(first) })).toThrow('terminal-body-page-capacity');
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
