import { describe, expect, it } from 'vitest';
import { applyDisplayEdit, DraftDisplayAdapter, displayText, displayToRaw, locateDisplayEdit, rawToDisplay, type TerminalEditStep } from './draft-projection.js';

const edit = (raw: string, after: string, cursorAfter: number) => {
  const located = locateDisplayEdit(displayText(raw), after, cursorAfter);
  return located ? applyDisplayEdit(raw, located).raw : raw;
};
// 步序取自真实原生编辑器的操作边界（collab/work/batch3-followup/f2/native/fast-result.json）
const run = (raw: string, steps: readonly [TerminalEditStep['kind'], string, number][]) => {
  const adapter = new DraftDisplayAdapter(); adapter.reset(raw);
  let before = displayText(raw);
  for (const [kind, after, cursorAfter] of steps) { adapter.step({ kind, before, after, cursorAfter }); before = after; }
  return adapter;
};

describe('draft display projection', () => {
  it('projects CR, LF and CRLF to LF and maps offsets both ways without splitting a CRLF', () => {
    const raw = '﻿🦞\r\n汉\rx\ny';
    expect(displayText(raw)).toBe('﻿🦞\n汉\nx\ny');
    expect(rawToDisplay(raw, 5)).toBe(4); expect(rawToDisplay(raw, 4)).toBe(4);
    expect(displayToRaw(raw, 4)).toBe(5); expect(displayToRaw(raw, 3)).toBe(3);
    expect(displayToRaw(raw, displayText(raw).length)).toBe(raw.length);
    expect(rawToDisplay('plain', 3)).toBe(3); expect(displayToRaw('plain', 9)).toBe(5);
  });

  it('places an inserted line break before or after an existing CRLF by the cursor after the edit', () => {
    // 同样的前后显示文本 A\nB → A\n\nB，只有编辑后光标区分两种改动
    expect(edit('A\r\nB', 'A\n\nB', 2)).toBe('A\n\r\nB');
    expect(edit('A\r\nB', 'A\n\nB', 3)).toBe('A\r\n\nB');
  });

  it('deletes whole original line breaks, keeps untouched CR/CRLF and replaces selections exactly', () => {
    expect(edit('A\r\nB', 'AB', 1)).toBe('AB');
    expect(edit('ab\r\ncd\r\nef', 'ab\nef', 3)).toBe('ab\r\nef');
    expect(edit('A\r\n\r\nB', 'A\nB', 1)).toBe('A\r\nB');
    expect(edit('x\ry\r\nz', 'x\ryQ\r\nz'.replace(/\r\n?/g, '\n'), 4)).toBe('x\ryQ\r\nz');
    expect(edit('A\r\nB\r\nC', 'A\nC', 1)).toBe('A\r\nC');
    expect(edit('  head\r\ntail  \r\n', '  head\r\nTAIL  \r\n'.replace(/\r\n?/g, '\n'), 11)).toBe('  head\r\nTAIL  \r\n');
  });
});

describe('original edit history paired with native undo', () => {
  it('restores a deleted CRLF on undo and removes it again on redo (F2 step order)', () => {
    const adapter = new DraftDisplayAdapter(); adapter.reset('A\r\nB');
    adapter.step({ kind: 'edit', before: 'A\nB', after: 'AB', cursorAfter: 1 }); expect(adapter.raw).toBe('AB');
    adapter.step({ kind: 'undo', before: 'AB', after: 'A\nB', cursorAfter: 2 }); expect(adapter.raw).toBe('A\r\nB');
    adapter.step({ kind: 'redo', before: 'A\nB', after: 'AB', cursorAfter: 1 }); expect(adapter.raw).toBe('AB');
    adapter.step({ kind: 'undo', before: 'AB', after: 'A\nB', cursorAfter: 2 }); expect(adapter.raw).toBe('A\r\nB');
    expect(adapter.mismatch).toBe(false);
  });

  it('follows fast type/delete/type then two undos one native step at a time (F3)', () => {
    const adapter = run('A\r\nB', [['edit', 'Ap\nB', 2], ['edit', 'A\nB', 1], ['edit', 'Aq\nB', 2], ['undo', 'A\nB', 1], ['undo', 'Ap\nB', 2]]);
    expect(adapter.raw).toBe('Ap\r\nB'); expect(adapter.mismatch).toBe(false);
  });

  it('treats a selection replacement as the two native steps it is (F4)', () => {
    const adapter = run('A\r\nB\r\nC', [['edit', 'A\nC', 1], ['edit', 'AX\nC', 2]]);
    expect(adapter.raw).toBe('AX\r\nC');
    adapter.step({ kind: 'undo', before: 'AX\nC', after: 'A\nC', cursorAfter: 1 });
    adapter.step({ kind: 'undo', before: 'A\nC', after: 'A\nB\nC', cursorAfter: 3 });
    expect(adapter.raw).toBe('A\r\nB\r\nC');
  });

  it('keeps both steps when an edit returns to the same display text (F5)', () => {
    const adapter = run('A\r\nB', [['edit', 'Ax\nB', 2], ['edit', 'A\nB', 1]]);
    expect(adapter.raw).toBe('A\r\nB');
    adapter.step({ kind: 'undo', before: 'A\nB', after: 'Ax\nB', cursorAfter: 2 });
    expect(adapter.raw).toBe('Ax\r\nB');
  });

  it('marks a mismatch instead of guessing and keeps the last confirmed original', () => {
    const stale = new DraftDisplayAdapter(); stale.reset('A\r\nB');
    stale.step({ kind: 'edit', before: 'unrelated', after: 'unrelated!', cursorAfter: 10 });
    expect(stale.mismatch).toBe(true); expect(stale.raw).toBe('A\r\nB');
    const empty = new DraftDisplayAdapter(); empty.reset('A\r\nB');
    empty.step({ kind: 'undo', before: 'A\nB', after: 'A\nBC', cursorAfter: 4 });
    expect(empty.mismatch).toBe(true); expect(empty.raw).toBe('A\r\nB');
  });

  it('charges history bytes, drops redo on a new edit, and releases everything on reset', () => {
    const adapter = run('A\r\nB', [['edit', 'AB', 1]]);
    const one = adapter.historyBytes; expect(one).toBeGreaterThan(0);
    adapter.step({ kind: 'undo', before: 'AB', after: 'A\nB', cursorAfter: 2 });
    adapter.step({ kind: 'edit', before: 'A\nB', after: 'Az\nB', cursorAfter: 2 });
    // 新编辑丢弃的重做项已释放，只剩这一次编辑自己的占用
    expect(adapter.historyBytes).toBe(run('A\r\nB', [['edit', 'Az\nB', 2]]).historyBytes);
    adapter.reset('next'); expect(adapter.historyBytes).toBe(0); expect(adapter.tracking).toBe(false);
  });

  // Windows Terminal 的 Ctrl+V 交付单独 CR：LF 落在单独 CR 之后时，两个逻辑换行不能被拼成一个 CRLF
  it('keeps two logical breaks when an LF lands right after a lone CR, and undoes to the exact bytes', () => {
    const inserted = run('a\rb', [['edit', 'a\n\nb', 3]]);
    expect(inserted.mismatch).toBe(false); expect(inserted.raw).toBe('a\r\n\nb');
    inserted.step({ kind: 'undo', before: 'a\n\nb', after: 'a\nb', cursorAfter: 2 }); expect(inserted.raw).toBe('a\rb');
    inserted.step({ kind: 'redo', before: 'a\nb', after: 'a\n\nb', cursorAfter: 3 }); expect(inserted.raw).toBe('a\r\n\nb');
    const deleted = run('a\rX\nb', [['edit', 'a\n\nb', 2]]);
    expect(deleted.mismatch).toBe(false); expect(deleted.raw).toBe('a\r\n\nb');
    deleted.step({ kind: 'undo', before: 'a\n\nb', after: 'a\nX\nb', cursorAfter: 3 }); expect(deleted.raw).toBe('a\rX\nb');
    // 在单独 CR 之前插入不会拼合；行尾单独 CR 之后插入换行同样保留两个逻辑换行；不紧接 LF 的删除不补编码
    expect(run('a\rb', [['edit', 'a\n\nb', 2]]).raw).toBe('a\n\rb');
    expect(run('a\r', [['edit', 'a\n\n', 3]]).raw).toBe('a\r\n\n');
    expect(run('a\rXb', [['edit', 'a\nb', 2]]).raw).toBe('a\rb');
    expect(run('a\r\r\nb', [['edit', 'a\n\nQb', 4]]).raw).toBe('a\r\r\nQb');
  });

  it('commits a step only after its candidate matches, leaving the confirmed original and history intact', () => {
    const adapter = run('a\r\nb', [['edit', 'a\nbX', 4]]);
    const raw = adapter.raw, bytes = adapter.historyBytes, depth = adapter.historyLength;
    adapter.step({ kind: 'undo', before: 'a\nbX', after: 'something else', cursorAfter: 0 });
    expect([adapter.mismatch, adapter.raw, adapter.historyBytes, adapter.historyLength]).toEqual([true, raw, bytes, depth]);
    const edited = run('a\rb', []);
    edited.step({ kind: 'edit', before: 'a\nb', after: 'a\nb\r', cursorAfter: 4 });
    expect([edited.mismatch, edited.raw, edited.historyLength]).toEqual([true, 'a\rb', { undo: 0, redo: 0 }]);
  });

  it('needs no steps for a draft without CR: the editor text is the original', () => {
    const adapter = new DraftDisplayAdapter(); adapter.reset('plain');
    expect(adapter.tracking).toBe(false);
    adapter.follow('plain!'); expect(adapter.raw).toBe('plain!');
    adapter.reset('a\rb'); expect(adapter.tracking).toBe(true);
    adapter.follow('ignored'); expect(adapter.raw).toBe('a\rb');
  });
});
