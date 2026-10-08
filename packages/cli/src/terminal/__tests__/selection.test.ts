import { describe, expect, it } from 'vitest';
import { chooseTerminalSelection, terminalSelectionActions, type TerminalSelectionPage, type TerminalSelectionResponse } from '../selection.js';
import type { SelectionRequest } from '../../tui/selection/types.js';

const cancelled = (cancelCause: 'escape' | 'ctrl-c' | 'ctrl-d' | 'aborted'): TerminalSelectionResponse => ({ itemId: 'cancelled', cancelCause });
const request: SelectionRequest = { title: '选择', initialValue: 'other', details: { body: ['总览'] }, options: [
  { value: 'disabled', label: '禁用', hotkey: 'x', disabled: true },
  { value: 'edit', label: '说明', hotkey: 'e', input: { placeholder: '原因' } },
  { value: 'other', label: '业务操作', hotkey: 'y', details: { body: ['后果'] }, confirm: { title: '再次确认' } },
] };

describe('terminal selection contract', () => {
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
  it('rejects nonexistent/disabled initial values, duplicate shortcuts and detail/action collisions', async () => {
    await expect(chooseTerminalSelection({ ...request, initialValue: 'disabled' }, async () => undefined)).rejects.toThrow('initial');
    expect(() => terminalSelectionActions({ kind: 'selection', title: '', choices: [{ id: 'a', label: '', hotkey: 'a' }, { id: 'b', label: '', hotkey: 'A' }] })).toThrow('hotkey');
    expect(() => terminalSelectionActions({ kind: 'selection', title: '', detailsActionId: 'a', choices: [{ id: 'a', label: '' }] })).toThrow('details');
  });
});
