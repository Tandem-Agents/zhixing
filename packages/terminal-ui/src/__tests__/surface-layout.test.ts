import { expect, it } from 'vitest';
import { initialChoiceIndex, nextChoiceIndex } from '../surface-layout.js';
import type { TerminalView } from '../protocol.js';

const view: TerminalView = { generation: 1, kind: 'selection', title: '选择', initialItemId: 'last', choices: [
  { id: 'disabled', label: '禁用', disabled: true }, { id: 'first', label: '第一项' },
  { id: 'disabled-middle', label: '禁用', disabled: true }, { id: 'last', label: '末项' },
] };
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
