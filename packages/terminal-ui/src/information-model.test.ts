import { describe, expect, it, vi } from 'vitest';
import { InformationBoard, informationLayout, fitInformation } from './information-model.js';
import { interactionKey, inputRows } from './surface-layout.js';

const width = (text: string) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text))
  .reduce((sum, item) => sum + (/\p{Script=Han}|\p{Extended_Pictographic}/u.test(item.segment) ? 2 : 1), 0);

describe('common information row', () => {
  it('keeps shared announcements, isolates publishers and releases late page updates', () => {
    const changed = vi.fn(), board = new InformationBoard(changed);
    const shared = board.source(), first = board.source('draft'), second = board.source('draft');
    shared.set('left', 'hint', '公告'); first.set('left', 'hint', '输入'); second.set('right', 'hint', '操作');
    expect(board.snapshot('draft')).toEqual({ left: ['公告', '输入'], right: ['操作'] });
    expect(board.snapshot('configuration')).toEqual({ left: ['公告'], right: [] });
    first.set('left', 'hint', '已更新'); const calls = changed.mock.calls.length;
    first.set('left', 'hint', '已更新'); expect(changed).toHaveBeenCalledTimes(calls);
    board.release('draft'); first.set('left', 'hint', '迟到');
    expect(board.snapshot('draft')).toEqual({ left: ['公告'], right: [] });
    shared.dispose(); board.dispose(); shared.set('left', 'hint', '迟到');
    expect(board.snapshot('draft')).toEqual({ left: [], right: [] });
  });
  it('owns symmetric padding, right alignment and narrow widths for all scenes', () => {
    for (let columns = 0; columns <= 100; columns++) {
      const row = informationLayout({ left: ['输入中文👨‍👩‍👧‍👦', '说明'], right: ['Enter 确认', 'Esc 返回'] }, columns, width);
      expect(row.inset * 2 + width(row.left) + row.gap + width(row.right)).toBe(columns);
      if (row.left && row.right) expect(row.gap).toBeGreaterThanOrEqual(2);
    }
    expect(informationLayout({ left: [], right: [] }, 80, width)).toEqual({ inset: 2, left: '', right: '', rightWidth: 0, gap: 76 });
    // 左侧是操作结果或失败说明时先保证它完整，键位用剩下的宽度（窄到放不下时截短）；其余宽度、对齐与总宽合计不变
    for (let columns = 0; columns <= 100; columns++) {
      const row = informationLayout({ left: ['复制请求未完成，选区已保留。'], right: ['Enter 确认 · Esc 返回'] }, columns, width, true);
      expect(row.inset * 2 + width(row.left) + row.gap + width(row.right)).toBe(columns);
      if (columns >= 34) expect(row.left).toBe('复制请求未完成，选区已保留。');
      if (row.left && row.right) expect(row.gap).toBeGreaterThanOrEqual(2);
    }
    const tight = informationLayout({ left: ['复制请求未完成，选区已保留。'], right: ['Enter 确认 · Esc 返回'] }, 41, width, true);
    expect(tight.left).toBe('复制请求未完成，选区已保留。'); expect(tight.right.endsWith('…')).toBe(true);
    // 不是反馈时仍是键位优先：同样的宽度下左侧让位
    expect(informationLayout({ left: ['复制请求未完成，选区已保留。'], right: ['Enter 确认 · Esc 返回'] }, 41, width).right).toBe('Enter 确认 · Esc 返回');
    expect(fitInformation('a👨‍👩‍👧‍👦b', 4, width)).toBe('a👨‍👩‍👧‍👦b');
    expect(fitInformation('a👨‍👩‍👧‍👦bc', 4, width)).toBe('a👨‍👩‍👧‍👦…');
    expect(fitInformation('long', 1, text => width(text) + (text.includes('…') ? 1 : 0))).toBe('');
  });
  it('does not interpret content as new lines or terminal control', () => {
    expect(fitInformation('a\n\x1bb', 20, width)).toBe('a  b');
  });
  it('keeps interaction identity on refresh and changes it on field or request replacement', () => {
    const page = { kind: 'configuration' as const, title: '字段', generation: 1, editId: 'edit', field: { id: 'url', label: '地址', secret: false } };
    expect(interactionKey(page)).toBe(interactionKey({ ...page, generation: 2, busy: true }));
    expect(interactionKey(page)).not.toBe(interactionKey({ ...page, field: { ...page.field, id: 'model' } }));
    expect(inputRows(1, 24)).toBe(1); expect(inputRows(20, 24)).toBe(8); expect(inputRows(20, 6)).toBe(2);
  });
});
