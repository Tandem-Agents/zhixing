import { describe, expect, it } from 'vitest';
import { TERMINAL_MODES, admitTerminalModes } from './mode-policy.js';

describe('terminal capability admission and recovery baseline', () => {
  const base = () => new Map<number, number>(TERMINAL_MODES.map(mode => [mode.id, 2]));
  it.each([0, 2, 4])('allows inactive obsolete UTF8 mouse mode %i without requiring mutability', state => {
    const values = base(); values.set(1005, state);
    const result = admitTerminalModes(values);
    expect(result.originalMask).toBe(0);
    expect(result.mutableMask & 256).toBe(state === 2 ? 256 : 0);
  });
  it('rejects permanently conflicting encodings and unknown mandatory capabilities', () => {
    for (const [id, state] of [[1005, 3], [1006, 0], [2004, 4], [1049, 1], [1049, 3], [25, 3]]) {
      const values = base(); values.set(id!, state!);
      expect(() => admitTerminalModes(values)).toThrow();
    }
    const missing = base(); missing.delete(1005);
    expect(() => admitTerminalModes(missing)).toThrow();
  });
  it('retains permanent compatible capabilities without trying to restore them', () => {
    const values = base(); values.set(1006, 3); values.set(1004, 0); values.set(2004, 3);
    expect(admitTerminalModes(values)).toEqual({ originalMask: 40, mutableMask: 511 & ~56 });
  });
});
