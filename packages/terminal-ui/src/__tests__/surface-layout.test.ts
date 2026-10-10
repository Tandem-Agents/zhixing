import { expect, it } from 'vitest';
import { initialChoiceIndex, nextChoiceIndex, candidateLayout, selectedLabel } from '../surface-layout.js';
import type { TerminalView } from '../protocol.js';

const view: TerminalView = { generation: 1, kind: 'selection', title: '选择', initialItemId: 'last', choices: [
  { id: 'disabled', label: '禁用', disabled: true }, { id: 'first', label: '第一项' },
  { id: 'disabled-middle', label: '禁用', disabled: true }, { id: 'last', label: '末项' },
] };
it('reserves one physical candidate viewport and leaves the editor/reading budget intact', () => {
  expect(candidateLayout(32)).toEqual({ editor: 4, process: 3, rows: 16 });
  expect(candidateLayout(20)).toEqual({ editor: 2, process: 2, rows: 8 });
  for (let height = 8; height <= 60; height++) {
    const result = candidateLayout(height);
    if (result.rows) expect(2 + result.process + result.editor + 2 + result.rows).toBeLessThan(height);
  }
  expect(selectedLabel('a  b', true, false, 7, text => text.length)).toBe('a  b░░░');
});
it('honors initial choice, preserves an enabled selection on refresh, and skips disabled defaults', () => {
  expect(initialChoiceIndex(view)).toBe(3); expect(initialChoiceIndex(view, 'first')).toBe(1);
  expect(initialChoiceIndex(view, 'disabled')).toBe(3);
  expect(initialChoiceIndex({ ...view, initialItemId: 'disabled' })).toBe(1);
  expect(initialChoiceIndex({ ...view, choices: [{ id: 'disabled', label: '', disabled: true }] })).toBe(-1);
});
it('skips disabled items without wrapping at either boundary', () => {
  expect(nextChoiceIndex(view, 1, 1)).toBe(3); expect(nextChoiceIndex(view, 3, -1)).toBe(1);
  expect(nextChoiceIndex(view, 1, -1)).toBe(1); expect(nextChoiceIndex(view, 3, 1)).toBe(3);
});
