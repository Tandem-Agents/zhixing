/** Index order is the private U → S → R wire contract. One table defines the
 * effects U needs and generates R's mode IDs; restore only mutable modes. */
export const TERMINAL_MODES = [
  { id: 1000, effect: 'on' },
  { id: 1002, effect: 'on' },
  { id: 1003, effect: 'off' },
  { id: 1006, effect: 'on' },
  { id: 1004, effect: 'optional-on' },
  { id: 2004, effect: 'on' },
  { id: 1049, effect: 'enter-leave' },
  { id: 25, effect: 'mutable' },
  { id: 1005, effect: 'off' },
] as const;

export interface TerminalModeBaseline { originalMask: number; mutableMask: number }

export function admitTerminalModes(values: ReadonlyMap<number, number>): TerminalModeBaseline {
  let originalMask = 0, mutableMask = 0;
  TERMINAL_MODES.forEach(({ id, effect }, index) => {
    const state = values.get(id);
    if (state === undefined || !Number.isInteger(state) || state < 0 || state > 4) throw Error('terminal-original-modes-unavailable');
    const mutable = state === 1 || state === 2, on = state === 1 || state === 3;
    const compatible = mutable || (effect === 'on' && on) || (effect === 'off' && !on) || effect === 'optional-on';
    if (!compatible || (effect === 'enter-leave' && state !== 2)) throw Error('terminal-original-modes-unavailable');
    if (on) originalMask |= 1 << index;
    if (mutable) mutableMask |= 1 << index;
  });
  if (((originalMask & 7) && ((originalMask & 7) & ((originalMask & 7) - 1))) ||
      ((originalMask & 8) && (originalMask & 256))) throw Error('terminal-original-modes-contradictory');
  return { originalMask, mutableMask };
}
