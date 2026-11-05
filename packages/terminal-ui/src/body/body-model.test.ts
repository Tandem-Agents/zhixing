import { describe, expect, it } from 'vitest';
import { BODY_STYLE, bodyWindows, decodeBodyPage, encodeBodyPage, sameBodyPageContent, sliceBodyNodes, validateBodyMetadata, type BodyPage, type BodyNode } from '../body-model.js';
import { bodyCell, bodyRenderBlocks, retainBodyBlocks, renderedToSource, sourceToRendered } from './layout.js';
import { bodyTableGeometry, bodyTableRule } from './geometry.js';

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
  it('gives a source node split by other content a distinct stable key and still joins its adjacent continuation', () => {
    const part = (from: number, text: string) => ({ blockId: 'live', contentOffset: from, role: 'assistant', text, final: false,
      body: { version: 1 as const, revision: 1, kind: 'markdown' as const, end: false, context: { nodes: [{ from, to: from + text.length, origin: 0,
        kind: 'paragraph' as const, runs: [{ from, to: from + text.length, text, style: 0 }] }] } } });
    const split = (tail: string): BodyPage => ({ first: 0, last: 4, start: 0, follow: true, segments: [
      part(0, '前段'), { blockId: 'notice', contentOffset: 0, role: 'notice', text: '到点通知', final: true }, part(2, '后段'), part(4, tail),
    ] });
    const blocks = bodyRenderBlocks(split('续写'));
    expect(blocks.map(block => block.text)).toEqual(['前段', '到点通知', '后段续写']);
    expect(new Set(blocks.map(block => block.key)).size).toBe(3);
    // 续写增长不改键：视图沿用同一挂载块
    expect(bodyRenderBlocks(split('续写更多'))[2]?.key).toBe(blocks[2]?.key);
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
describe('reading presentation metadata', () => {
  const row = (extra: Partial<BodyNode>, style = 0): BodyNode => ({ from: 0, to: 4, kind: 'table', table: 0, columns: 2, header: true, labels: ['甲', '乙'],
    runs: [{ from: 0, to: 2, text: '甲', style, cell: 0 }, { from: 2, to: 4, text: '乙', style: 0, cell: 1 }], ...extra });
  const meta = (value: BodyNode) => ({ version: 1, revision: 1, kind: 'markdown', end: true, context: { nodes: [value] } });
  it('accepts declared column alignment and list marker style, and rejects forged ones', () => {
    expect(validateBodyMetadata(meta(row({ align: ['left', 'right'] })), 0, 4)).toBe(true);
    expect(validateBodyMetadata(meta(row({}, BODY_STYLE.marker)), 0, 4)).toBe(true);
    expect(validateBodyMetadata(meta(row({ align: ['right'] })), 0, 4)).toBe(false);
    expect(validateBodyMetadata(meta(row({ align: ['left', 'justify' as 'left'] })), 0, 4)).toBe(false);
    expect(validateBodyMetadata(meta(row({}, 128)), 0, 4)).toBe(false);
    // 取值必须本身是字符串：['left'] 经字符串化也是 'left'，不能借此通过
    expect(validateBodyMetadata(meta(row({ align: [['left'], 'left'] as unknown as BodyNode['align'] })), 0, 4)).toBe(false);
  });
  it('knows whether a table row piece holds the real row start and end', () => {
    const text = '| a | b |\n| c | d |\n';
    const rowNode = (from: number, to: number, header: boolean): BodyNode => ({ from, to, kind: 'table', table: 0, columns: 2, header, labels: ['a', 'b'],
      runs: [{ from: from + 2, to: from + 3, text: text[from + 2]!, style: 0, cell: 0 }, { from: from + 6, to: from + 7, text: text[from + 6]!, style: 0, cell: 1 }] });
    const nodes = [rowNode(0, 10, true), rowNode(10, 20, false)];
    const part = (blockId: string, from: number, to: number, end: boolean) => ({ blockId, contentOffset: from, text: text.slice(from, to), role: 'assistant', final: end,
      body: { version: 1 as const, revision: 1, kind: 'markdown' as const, end, context: { nodes: sliceBodyNodes(nodes, from, to) } } });
    const notice = { blockId: 'notice', contentOffset: 0, text: '通知', role: 'notice', final: true };
    // 第一片在表头行中间（第 5 个字符后）结束，中间插入其他消息：前段既无行尾，后段也不是行的起点
    const split = bodyRenderBlocks({ first: 0, last: 3, start: 0, follow: false, segments: [part('t', 0, 5, false), notice, part('t', 5, 20, false)] })
      .filter(block => block.node.kind === 'table');
    expect(split.map(block => [block.node.from === (block.node.origin ?? block.node.from), !!block.rowEnd])).toEqual([[true, false], [false, true], [true, true]]);
    // 两片紧邻时并为一行：起点与行尾都在
    const joined = bodyRenderBlocks({ first: 0, last: 2, start: 0, follow: false, segments: [part('t', 0, 5, false), part('t', 5, 20, false)] });
    expect(joined.map(block => [block.node.from === (block.node.origin ?? block.node.from), !!block.rowEnd])).toEqual([[true, true], [true, true]]);
    // 来源真实结束：最后一行即使没有换行也有行尾
    const eof = bodyRenderBlocks({ first: 0, last: 1, start: 0, follow: false, segments: [part('t', 0, 19, true)] });
    expect(eof.map(block => !!block.rowEnd)).toEqual([true, true]);
    // 表格后接空行时换行不算在行内；片段恰好切在行与换行之间，本段看不到换行，由同源的后继节点证明行已写完（中间隔着其他消息也一样）
    const tail = '| a | b |\n\nx\n';
    const tailNodes: BodyNode[] = [{ from: 0, to: 9, kind: 'table', table: 0, columns: 2, header: true, labels: ['a', 'b'],
      runs: [{ from: 2, to: 3, text: 'a', style: 0, cell: 0 }, { from: 6, to: 7, text: 'b', style: 0, cell: 1 }] },
      { from: 9, to: 11, kind: 'space', runs: [] }, { from: 11, to: 13, kind: 'paragraph', runs: [{ from: 11, to: 12, text: 'x', style: 0 }] }];
    const tailPart = (from: number, to: number, end: boolean) => ({ blockId: 'u', contentOffset: from, text: tail.slice(from, to), role: 'assistant', final: end,
      body: { version: 1 as const, revision: 1, kind: 'markdown' as const, end, context: { nodes: sliceBodyNodes(tailNodes, from, to) } } });
    const alone = bodyRenderBlocks({ first: 0, last: 2, start: 0, follow: false, segments: [tailPart(0, 9, false)] });
    expect(alone.map(block => !!block.rowEnd)).toEqual([false]);
    const proven = bodyRenderBlocks({ first: 0, last: 3, start: 0, follow: false, segments: [tailPart(0, 9, false), notice, tailPart(9, 13, true)] });
    expect(proven.filter(block => block.node.kind === 'table').map(block => !!block.rowEnd)).toEqual([true]);
  });
  it('marks only the last node of a real source end, and keeps the mark on a joined continuation', () => {
    const text = '甲乙丙丁';
    const nodes: BodyNode[] = [{ from: 0, to: 2, kind: 'paragraph', runs: [{ from: 0, to: 2, text: '甲乙', style: 0 }] },
      { from: 2, to: 4, kind: 'paragraph', runs: [{ from: 2, to: 4, text: '丙丁', style: 0 }] }];
    const of = (end: boolean, cut = 4): BodyPage => ({ first: 0, last: cut < 4 ? 2 : 1, start: 0, follow: false, segments: (cut < 4 ? [0, cut] : [0]).map((offset, index, all) => {
      const to = all[index + 1] ?? 4;
      return { blockId: 'b', contentOffset: offset, text: text.slice(offset, to), role: 'assistant', final: true,
        body: { version: 1, revision: 1, kind: 'markdown', end: end && to === 4, context: { nodes: sliceBodyNodes(nodes, offset, to) } } };
    }) });
    expect(bodyRenderBlocks(of(false)).map(block => !!block.sourceEnd)).toEqual([false, false]);
    expect(bodyRenderBlocks(of(true)).map(block => !!block.sourceEnd)).toEqual([false, true]);
    // 最后一个节点跨两片：并入的续段带来收尾事实
    expect(bodyRenderBlocks(of(true, 3)).map(block => [block.text, !!block.sourceEnd])).toEqual([['甲乙', false], ['丙丁', true]]);
  });
  it('splits table columns from visible labels and width only, with one shared fallback', () => {
    const width = (text: string) => [...text].reduce((sum, char) => sum + (/[一-鿿]/u.test(char) ? 2 : 1), 0);
    const wide = bodyTableGeometry(['名称', 'x', '很长很长的说明'], 3, 60, width);
    expect(wide.stacked).toBe(false);
    expect(wide.width).toBe(60);
    // 每列先容下自己的表头（4、3、14），余下 29 格平均分，余数按列序补足
    expect(wide.widths).toEqual([14, 13, 23]);
    // 超长表头按平均宽封顶（33 格两列封顶 16），其余照常平均分
    const capped = bodyTableGeometry(['甲'.repeat(40), '乙'], 2, 40, width);
    expect(capped.widths).toEqual([23, 10]);
    expect(capped.width).toBe(40);
    // 任一列分到不足 10 格就改窄布局：平均不足，或长表头占去宽度后别的列不足
    expect(bodyTableGeometry(['a', 'b', 'c'], 3, 1 + 9 + 29, width).stacked).toBe(true);
    expect(bodyTableGeometry(['a', 'b', 'c'], 3, 1 + 9 + 30, width).stacked).toBe(false);
    expect(bodyTableGeometry(['甲'.repeat(10), '乙'.repeat(10), 'c'], 3, 1 + 9 + 33, width).stacked).toBe(true);
    expect(bodyTableRule([1, 2], '┌', '┬', '┐', '─')).toBe('┌───┬────┐');
  });
});
