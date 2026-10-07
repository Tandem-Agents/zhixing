import { describe, expect, it } from 'vitest';
import { TerminalTrustCandidateControls, type TrustCandidateSnapshot } from './trust-candidate-controls.js';

const snapshot = (overrides: Partial<TrustCandidateSnapshot> = {}): TrustCandidateSnapshot => ({ mode: 'management', revision: 3,
  items: [{ id: 'row-a' }, { id: 'row-b' }], selected: 0, draftVersion: 8, cursor: 7, pageKey: 'main', canDelete: true, safe: true, ...overrides });
const remove = { name: 'd', ctrl: true };

describe('trust candidate keyboard ownership', () => {
  it.each([{}, { items: [] }, { busy: true }, { error: 'offline' }, { safe: false }])('owns Enter and Tab even for unavailable management state %j', overrides => {
    const control = new TerminalTrustCandidateControls(), current = snapshot(overrides);
    for (const name of ['return', 'enter', 'tab']) {
      expect(control.key(current, { name })).toEqual({ kind: 'none' });
      expect(control.key(current, { name, ctrl: true })).toEqual({ kind: 'none' });
    }
  });
  it('requires two distinct Ctrl+D presses against the same confirmed row and revision', () => {
    const control = new TerminalTrustCandidateControls(), current = snapshot();
    expect(control.key(current, remove)).toMatchObject({ kind: 'armed', id: 'row-a' });
    expect(control.key(current, remove)).toEqual({ kind: 'revoke', id: 'row-a', revision: 3 });
    expect(control.armedId).toBeUndefined();
    expect(control.key(snapshot({ busy: true }), remove).kind).toBe('none');
  });
  it.each([
    { revision: 4 }, { selected: 1 }, { draftVersion: 9 }, { cursor: 6 }, { pageKey: 'scene' },
    { items: [{ id: 'replacement' }] }, { busy: true }, { error: 'offline' }, { canDelete: false }, { safe: false },
  ])('disarms on an observable identity/input/page change %j', change => {
    const control = new TerminalTrustCandidateControls(), current = snapshot(); control.key(current, remove);
    expect(control.sync(snapshot(change))).toBe(true); expect(control.armedId).toBeUndefined();
    expect(control.sync(snapshot(change))).toBe(false);
  });
  it('does not retain a preparation across typing, paste synchronization, navigation or Enter', () => {
    const control = new TerminalTrustCandidateControls(), current = snapshot();
    for (const name of ['a', 'up', 'pagedown', 'enter']) {
      control.key(current, remove); control.key(current, { name }); expect(control.armedId).toBeUndefined();
      expect(control.key(current, remove).kind).toBe('armed'); control.reset();
    }
    control.key(current, remove); control.sync(snapshot({ draftVersion: 10, cursor: 30 }));
    expect(control.key(snapshot({ draftVersion: 10, cursor: 30 }), remove).kind).toBe('armed');
  });
  it('returns Esc to the existing progressive draft owner without editing or accepting a rule', () => {
    const control = new TerminalTrustCandidateControls(), current = snapshot(); control.key(current, remove);
    expect(control.key(current, { name: 'escape' })).toEqual({ kind: 'dismiss' }); expect(control.armedId).toBeUndefined();
    expect(current.cursor).toBe(7); expect(current.draftVersion).toBe(8);
    expect(control.key(snapshot({ items: [], safe: false }), { name: 'escape' })).toEqual({ kind: 'dismiss' });
  });
  it('keeps navigation within root-owned movement and blocks unsafe small-screen actions', () => {
    const control = new TerminalTrustCandidateControls();
    expect(control.key(snapshot(), { name: 'up' })).toEqual({ kind: 'move', direction: -1 });
    expect(control.key(snapshot(), { name: 'pagedown' })).toEqual({ kind: 'move', direction: 1, page: true });
    expect(control.key(snapshot({ safe: false }), { name: 'up' }).kind).toBe('none');
    expect(control.key(snapshot({ safe: false }), remove).kind).toBe('none');
    expect(control.key(snapshot({ items: [] }), remove).kind).toBe('none');
  });
  it('does not borrow picker ownership or treat modified letters as delete confirmation', () => {
    const control = new TerminalTrustCandidateControls();
    expect(control.key(snapshot({ mode: 'picker' }), { name: 'return' })).toEqual({ kind: 'unhandled' });
    control.key(snapshot(), remove);
    expect(control.key(snapshot(), { name: 'd', ctrl: true, shift: true })).toEqual({ kind: 'unhandled' });
    expect(control.armedId).toBeUndefined(); expect(control.key(snapshot(), remove).kind).toBe('armed');
  });
});
