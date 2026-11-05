import { describe, expect, it } from 'vitest';
import { chooseTerminalSelection, terminalSelectionActions, type TerminalSelectionPage, type TerminalSelectionResponse } from '../selection.js';
import { type SelectionRequest } from '../../tui/selection/types.js';

const cancelled = (cancelCause: 'escape' | 'ctrl-c' | 'ctrl-d' | 'aborted'): TerminalSelectionResponse => ({ itemId: 'cancelled', cancelCause });
const request: SelectionRequest = { title: '选择', initialValue: 'other', details: { body: ['总览'] }, options: [
  { value: 'disabled', label: '禁用', hotkey: 'x', disabled: true },
  { value: 'edit', label: '说明', hotkey: 'e', input: { placeholder: '原因' } },
  { value: 'other', label: '业务操作', hotkey: 'y', details: { body: ['后果'] }, confirm: { title: '再次确认' } },
] };

describe('terminal selection contract', () => {
  it('preserves the requested actions without adding a duplicate dismissal; Escape still cancels', async () => {
    const result = await chooseTerminalSelection({ title: '停止', options: [
      { value: 'stop', label: '停止' }, { value: 'cancel', label: '返回' },
    ] }, async page => {
      expect(page.choices?.map(choice => choice.label)).toEqual(['停止', '返回']);
      return cancelled('escape');
    });
    expect(result).toEqual({ kind: 'cancelled', cause: 'escape' });
  });
  it('projects explicit initial item, hotkeys and details independently from activation', async () => {
    const pages: TerminalSelectionPage[] = [];
    const answers = [{ itemId: 'details:other' }, { itemId: 'return' }, cancelled('escape')];
    const result = await chooseTerminalSelection(request, async page => { pages.push(page); return answers.shift(); });
    expect(result).toEqual({ kind: 'cancelled', cause: 'escape' });
    expect(pages.map(page => page.selectionLayer)).toEqual(['select', 'details', 'select']);
    expect(pages[0]!.initialItemId).toBe('option:other');
    expect(pages[0]!.choices![2]).toMatchObject({ hotkey: 'y', detailsActionId: 'details:other' });
    expect(pages[1]!.message).toContain('后果');
    expect(pages[2]!.initialItemId).toBe('option:other');
  });
  it('activates an option without opening its details and defaults the second Enter to confirm', async () => {
    const pages: TerminalSelectionPage[] = [];
    const result = await chooseTerminalSelection(request, async page => { pages.push(page); return { itemId: page.selectionLayer === 'confirm' ? page.initialItemId! : 'option:other' }; });
    expect(result).toEqual({ kind: 'selected', value: 'other' });
    expect(pages.map(page => page.selectionLayer)).toEqual(['select', 'confirm']);
  });
  for (const layer of ['input', 'confirm', 'details'] as const) {
    const itemId = layer === 'input' ? 'option:edit' : layer === 'confirm' ? 'option:other' : 'details:other';
    it(`returns from ${layer} on Escape without selecting or submitting`, async () => {
      const pages: TerminalSelectionPage[] = []; const answers = [{ itemId }, cancelled('escape'), cancelled('ctrl-d')];
      const result = await chooseTerminalSelection(request, async page => { pages.push(page); return answers.shift(); });
      expect(result).toEqual({ kind: 'cancelled', cause: 'ctrl-d' });
      expect(pages.map(page => page.selectionLayer)).toEqual(['select', layer, 'select']);
    });
    for (const cause of ['ctrl-c', 'ctrl-d', 'aborted'] as const) it(`ends ${layer} on ${cause}`, async () => {
      let count = 0;
      expect(await chooseTerminalSelection(request, async () => count++ ? cancelled(cause) : { itemId })).toEqual({ kind: 'cancelled', cause });
      expect(count).toBe(2);
    });
  }
  it('accepts the readonly text port undefined dismissal and never chooses a default', async () => {
    expect(await chooseTerminalSelection(request, async () => undefined)).toBeUndefined();
  });
  it('does not activate disabled business or details actions', async () => {
    let page!: TerminalSelectionPage; let count = 0;
    const result = await chooseTerminalSelection(request, async view => { page = view; return count++ ? undefined : { itemId: 'option:disabled' }; });
    expect(result).toBeUndefined();
    const allowed = terminalSelectionActions(page);
    expect(allowed.has('option:disabled')).toBe(false); expect(allowed.has('details:disabled')).toBe(false);
    expect(allowed.has('details:other')).toBe(true);
  });
  it('authorizes a declared field submit and rejects it without a field or mixed with an action list', () => {
    const field = { id: 'name', label: '名称', secret: false };
    expect(terminalSelectionActions({ kind: 'selection', title: '', field, fieldSubmit: { id: 'save', label: '保存' }, cancelLabel: '取消' }).has('save')).toBe(true);
    expect(() => terminalSelectionActions({ kind: 'selection', title: '', fieldSubmit: { id: 'save', label: '保存' } })).toThrow('field-submit');
    expect(() => terminalSelectionActions({ kind: 'selection', title: '', field, fieldSubmit: { id: 'save', label: '保存' }, choices: [{ id: 'cancel', label: '取消' }] })).toThrow('field-submit');
  });
  it('turns the input layer into a single field: Enter submits, Escape returns, and a required empty input stays with its reason', async () => {
    const pages: TerminalSelectionPage[] = [];
    const answers: TerminalSelectionResponse[] = [{ itemId: 'option:edit' }, { itemId: 'submit', input: '  ' }, { itemId: 'submit', input: '理由' }];
    const result = await chooseTerminalSelection(request, async page => { pages.push(page); return answers.shift(); });
    expect(result).toEqual({ kind: 'selected', value: 'edit', input: '理由' });
    expect(pages[1]).toMatchObject({ selectionLayer: 'input', fieldSubmit: { id: 'submit', label: '提交说明' }, cancelLabel: '返回' });
    expect(pages[1]).not.toHaveProperty('choices'); expect(pages[1]).not.toHaveProperty('initialItemId');
    expect(pages[2]).toMatchObject({ selectionLayer: 'input', field: { value: '  ', error: '请填写说明后再提交。' } });
    const optional: SelectionRequest = { title: '选择', options: [{ value: 'note', label: '备注', input: { placeholder: '可留空', allowEmpty: true } }] };
    const empty = [{ itemId: 'option:note' }, { itemId: 'submit', input: '' }];
    expect(await chooseTerminalSelection(optional, async () => empty.shift())).toEqual({ kind: 'selected', value: 'note', input: '' });
  });
  it('rejects nonexistent/disabled initial values, duplicate shortcuts and detail/action collisions', async () => {
    await expect(chooseTerminalSelection({ ...request, initialValue: 'disabled' }, async () => undefined)).rejects.toThrow('initial');
    expect(() => terminalSelectionActions({ kind: 'selection', title: '', choices: [{ id: 'a', label: '', hotkey: 'a' }, { id: 'b', label: '', hotkey: 'A' }] })).toThrow('hotkey');
    expect(() => terminalSelectionActions({ kind: 'selection', title: '', detailsActionId: 'a', choices: [{ id: 'a', label: '' }] })).toThrow('details');
  });
});
