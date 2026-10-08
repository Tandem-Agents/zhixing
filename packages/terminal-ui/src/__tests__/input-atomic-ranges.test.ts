import { describe, it, expect } from 'vitest';
import { TerminalInputSession } from '../input-session.js';

const first = { token: '[A B]', id: '11111111-1111-1111-1111-111111111111' };
const second = { token: '[C D]', id: '22222222-2222-2222-2222-222222222222' };
const session = () => new TerminalInputSession(async () => ({ accepted: true }), () => {});

describe('shared atomic layout and editing ranges', () => {
  it('does not infer handles from arbitrary brackets and invalidates on admitted metadata', () => {
    const input = session(); input.edit('x[A B][C D]', 1);
    expect(input.atomicRanges()).toEqual([]);
    input.candidate({ text: '', execute: false, handles: [first] });
    const firstRanges = input.atomicRanges();
    expect(firstRanges).toEqual([{ start: 1, end: 6 }]);
    input.edit(input.draft.text, 3);
    expect(input.atomicRanges()).toBe(firstRanges);
    input.candidate({ text: '', execute: false, handles: [second] });
    expect(input.atomicRanges()).toEqual([{ start: 1, end: 6 }, { start: 6, end: 11 }]);
    expect(input.atomicRanges()).not.toBe(firstRanges);
  });
  it('uses identical repeated-token ranges for movement and deletion', () => {
    const input = session(); input.candidate({ text: '', execute: false, handles: [first] });
    input.edit('[A B] [A B]', 0);
    const ranges = input.atomicRanges();
    expect(ranges).toEqual([{ start: 0, end: 5 }, { start: 6, end: 11 }]);
    expect(input.atomic('right')).toBe(true); expect(input.draft.cursor).toBe(5);
    expect(input.atomicRanges()).toBe(ranges);
    expect(input.atomic('backspace')).toBe(true); expect(input.draft.text).toBe(' [A B]');
    expect(input.atomicRanges()).toEqual([{ start: 1, end: 6 }]);
  });
});
