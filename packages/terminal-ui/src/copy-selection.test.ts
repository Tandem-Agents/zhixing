import { describe, expect, it } from 'vitest';
import { copySource, joinSelectedLeaves, onScreen, type SelectionLeaf } from './copy-selection.js';

type Leaf = SelectionLeaf & { isDestroyed: boolean; visible: boolean; parent: Leaf | null };
const root: Leaf = { x: 0, y: 0, isDestroyed: false, visible: true, parent: null, getSelectedText: () => '' };
const leaf = (x: number, y: number, text: string, parent: Leaf = root): Leaf => ({ x, y, isDestroyed: false, visible: true, parent, getSelectedText: () => text });
const plain = { root, isBodyLeaf: () => false, bodySelected: false };

describe('copy selection', () => {
  it('joins leaves on the same display line without a newline and separates lines like the native selection', () => {
    const left = leaf(2, 5, '正在'), right = leaf(10, 5, '处理'), below = leaf(2, 6, '下一行');
    expect(joinSelectedLeaves([below, right, left])).toBe('正在处理\n下一行');
    const multi = leaf(0, 3, '甲\n乙'), beside = leaf(6, 4, '丙');
    expect(joinSelectedLeaves([beside, multi])).toBe('甲\n乙丙');
  });
  it('joins semantic leaves by meaning: a wrapped paragraph stays one source text, a value follows its label with a tab, paragraphs with newlines', () => {
    // 段落节点跨多行（原生软折行，选中文字即源文）；标签与值同一行；混入非语义节点时退回通用拼接
    const paragraph = leaf(2, 1, 'alpha  beta 中文，标点。D:\\long\\path END'), label = leaf(4, 4, 'bash · npm test *'), value = leaf(26, 4, '已允许 2 次');
    const marks = new Map<SelectionLeaf, { key: object; after?: object; joiner?: string }>();
    const labelKey = {};
    marks.set(paragraph, { key: {} }); marks.set(label, { key: labelKey }); marks.set(value, { key: {}, after: labelKey });
    const options = { ...plain, semanticLeaf: (item: SelectionLeaf) => marks.get(item) };
    expect(copySource({ isDragging: false, selectedRenderables: [value, label, paragraph] }, options))
      .toEqual({ kind: 'text', text: 'alpha  beta 中文，标点。D:\\long\\path END\nbash · npm test *\t已允许 2 次' });
    // 同一串并列条目：分在两行显示，复制仍是“甲 · 乙 · 丙”
    const first = leaf(2, 6, 'Git 内部文件写保护'), second = leaf(22, 6, '· SSH 密钥保护'), third = leaf(2, 7, '· 环境变量注入防护');
    const k1 = {}, k2 = {};
    marks.set(first, { key: k1 }); marks.set(second, { key: k2, after: k1, joiner: ' ' }); marks.set(third, { key: {}, after: k2, joiner: ' ' });
    expect(copySource({ isDragging: false, selectedRenderables: [third, second, first] }, options))
      .toEqual({ kind: 'text', text: 'Git 内部文件写保护 · SSH 密钥保护 · 环境变量注入防护' });
    const other = leaf(0, 9, '信息行');
    expect(copySource({ isDragging: false, selectedRenderables: [label, value, other] }, options)).toEqual({ kind: 'text', text: 'bash · npm test *已允许 2 次\n信息行' });
  });
  it('keeps whitespace-only selections and skips empty leaves', () => {
    expect(copySource({ isDragging: false, selectedRenderables: [leaf(0, 1, '   ')] }, plain)).toEqual({ kind: 'text', text: '   ' });
    expect(copySource({ isDragging: false, selectedRenderables: [leaf(0, 1, '')] }, plain)).toBeUndefined();
  });
  it('only takes leaves still on screen: not destroyed, visible up the chain, attached to the root', () => {
    const hiddenParent: Leaf = { ...leaf(0, 0, ''), visible: false };
    const destroyed = { ...leaf(0, 1, '旧页'), isDestroyed: true }, hidden = leaf(0, 2, '隐藏', hiddenParent), detached = leaf(0, 3, '游离', { ...leaf(0, 0, ''), parent: null });
    const live = leaf(0, 4, '在屏');
    expect([destroyed, hidden, detached, live].map(item => onScreen(item, root))).toEqual([false, false, false, true]);
    expect(copySource({ isDragging: false, selectedRenderables: [destroyed, hidden, detached, live] }, plain)).toEqual({ kind: 'text', text: '在屏' });
    expect(copySource({ isDragging: false, selectedRenderables: [destroyed] }, plain)).toBeUndefined();
  });
  it('decides by the owners of the selected leaves: body, the editor alone, or the plain joined text across regions', () => {
    const body = leaf(0, 1, '正文'), editor = leaf(4, 9, '输入'), other = leaf(0, 8, '说明');
    const options = { root, isBodyLeaf: (item: SelectionLeaf) => item === body, bodySelected: true, editor };
    expect(copySource({ isDragging: false, selectedRenderables: [body] }, options)).toEqual({ kind: 'body' });
    expect(copySource({ isDragging: false, selectedRenderables: [editor] }, options)).toEqual({ kind: 'text', text: '输入' });
    expect(copySource({ isDragging: false, selectedRenderables: [editor, body] }, options)).toEqual({ kind: 'text', text: '正文\n输入' });
    expect(copySource({ isDragging: false, selectedRenderables: [other, editor] }, options)).toEqual({ kind: 'text', text: '说明\n输入' });
    expect(copySource({ isDragging: false, selectedRenderables: [body] }, { ...options, bodySelected: false })).toBeUndefined();
  });
  it('lets the body own a pure-newline selection that has no selected character leaf', () => {
    expect(copySource({ isDragging: false, selectedRenderables: [] }, { ...plain, bodySelected: true })).toEqual({ kind: 'body' });
    expect(copySource({ isDragging: false, selectedRenderables: [] }, plain)).toBeUndefined();
  });
  it('reports a selection still being dragged without reading it', () => {
    expect(copySource({ isDragging: true, selectedRenderables: [leaf(0, 1, '半截')] }, plain)).toEqual({ kind: 'dragging' });
    expect(copySource(null, plain)).toBeUndefined();
  });
});
