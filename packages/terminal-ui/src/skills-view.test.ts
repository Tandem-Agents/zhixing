import { describe, expect, it } from 'vitest';
import { SKILLS_PAGE_MAX, skillsActionForKey, skillsDisplayText, skillsPageSize, skillsVisibleItems, validateSkillsAction, validateSkillsView, type TerminalSkillsView } from './skills-model.js';

function view(): TerminalSkillsView {
  return { sessionId: 'session', revision: 7, state: 'ready', busy: false, total: 30, offset: 16, pageSize: 8, selectedIndex: 22, selectedId: 'skill-22',
    items: Array.from({ length: 8 }, (_, index) => ({ id: `skill-${index + 16}`, name: `技能 ${index + 16}`, description: '做事', pinned: false, disabled: false, mode: 'main', source: 'own', hitCount: null })) };
}
describe('skills page projection and input ownership', () => {
  it('addresses every mutation by the current identity and version after reordering', () => {
    const current = view();
    for (const [key, kind] of [['p', 'pin'], ['d', 'disable'], ['m', 'mode'], ['a', 'archive']]) {
      expect(skillsActionForKey(current, { name: key! })).toEqual({ sessionId: 'session', revision: 7, kind, skillId: 'skill-22' });
    }
    const reordered = { ...current, revision: 8, selectedIndex: 16, selectedId: 'skill-22', items: [current.items[6]!, ...current.items.filter(item => item.id !== 'skill-22')] };
    expect(skillsActionForKey(reordered, { name: 'a' })).toMatchObject({ revision: 8, skillId: 'skill-22' });
  });
  it('keeps cancellation available during loading, errors and too-small layouts', () => {
    for (const state of ['loading', 'ready', 'error'] as const) {
      const current = { ...view(), state, busy: true };
      expect(skillsActionForKey(current, { name: 'escape' }, false)?.kind).toBe('cancel');
      expect(skillsActionForKey(current, { name: 'c', ctrl: true }, false)?.kind).toBe('cancel');
      expect(skillsActionForKey(current, { name: 'a' })).toBeUndefined();
    }
    expect(skillsActionForKey(view(), { name: 'a' }, false)).toBeUndefined();
    expect(skillsActionForKey({ ...view(), state: 'error' }, { name: 'a' })).toBeUndefined();
    expect(skillsActionForKey({ ...view(), state: 'error' }, { name: 'r' })?.kind).toBe('refresh');
    expect(skillsActionForKey(view(), { name: 'return' })).toBeUndefined();
  });
  it('preserves the selected item while shrinking a long page and bounds any growth', () => {
    expect(skillsVisibleItems(view(), 10).map(item => item.id)).toEqual(['skill-21', 'skill-22']);
    expect(skillsVisibleItems(view(), 8).map(item => item.id)).toEqual(['skill-22']);
    expect(skillsPageSize(10000)).toBe(SKILLS_PAGE_MAX);
    expect(skillsPageSize(0)).toBe(1);
    expect(skillsActionForKey(view(), { name: 'pageup' })).toMatchObject({ kind: 'move', direction: -1, page: true });
  });
  it('rejects forged identities, page overflow and malformed actions before display/dispatch', () => {
    expect(validateSkillsView(view())).toBe(true);
    expect(validateSkillsView({ ...view(), selectedId: 'other' })).toBe(false);
    expect(validateSkillsView({ ...view(), pageSize: 2 })).toBe(false);
    expect(validateSkillsView({ ...view(), items: view().items.map(item => ({ ...item, description: 'a'.repeat(1025) })) })).toBe(false);
    expect(validateSkillsAction({ sessionId: 'session', revision: 7, kind: 'archive' })).toBe(false);
    expect(validateSkillsAction({ sessionId: 'session', revision: 7, kind: 'resize', pageSize: 25 })).toBe(false);
    expect(validateSkillsAction({ sessionId: 'session', revision: 7, kind: 'cancel', method: 'arbitrary.rpc' })).toBe(false);
    expect(skillsDisplayText('a\x1b[1m\n\u202eb')).toBe('a [1m  b');
  });
});
