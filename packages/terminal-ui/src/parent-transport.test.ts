import { describe, expect, it } from 'vitest';
import { TerminalJsonFrames } from './parent-transport.js';

describe('private JSON frame boundaries', () => {
  it('preserves split UTF-8 and consecutive frames across workspace reuse', () => {
    const frames = new TerminalJsonFrames(65536), observed: unknown[] = [];
    const expected = [{ text: '中文🙂'.repeat(3000) }, { text: 'short' }, { text: '\n\"\\' }];
    const wire = Buffer.from(expected.map(value => JSON.stringify(value) + '\n').join(''));
    for (let offset = 0; offset < wire.length; offset += 137) frames.accept(wire.subarray(offset, offset + 137), value => observed.push(value));
    expect(observed).toEqual(expected);
  });
  it('counts bytes before delivery, allows the exact limit and rejects a fragmented excess', () => {
    const observed: unknown[] = [], frames = new TerminalJsonFrames(4);
    frames.accept(Buffer.from('1234\n'), value => observed.push(value));
    frames.accept(Buffer.from('1234'), value => observed.push(value));
    expect(() => frames.accept(Buffer.from('5\n'), value => observed.push(value))).toThrow('capacity');
    expect(observed).toEqual([1234]);
  });
  it('discards a cleared partial frame and stops on invalid JSON or a failed receiver', () => {
    const frames = new TerminalJsonFrames(32), observed: unknown[] = [];
    frames.accept(Buffer.from('{"old":'), value => observed.push(value)); frames.clear();
    frames.accept(Buffer.from('true\n'), value => observed.push(value));
    expect(() => frames.accept(Buffer.from('{bad}\nfalse\n'), value => observed.push(value))).toThrow();
    expect(() => frames.accept(Buffer.from('null\nfalse\n'), () => { throw Error('owner closed'); })).toThrow('owner closed');
    expect(observed).toEqual([true]);
  });
});
