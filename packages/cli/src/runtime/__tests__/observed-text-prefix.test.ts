import { describe, expect, it } from 'vitest';
import type { Message } from '@zhixing/core/types';
import { ObservedTextPrefix } from '../observed-text-prefix.js';

const message = (...texts: string[]): Message => ({ role: 'assistant', content: texts.map(text => ({ type: 'text', text })) });

describe('observed final text without retaining the streamed prefix', () => {
  it('matches the prior startsWith contract across multiple blocks, mismatches and resets', () => {
    const prefix = new ObservedTextPrefix(); prefix.append('first'); prefix.append('\nsec');
    expect([...prefix.remaining(message('first', 'second'))].join('')).toBe('ond');
    expect([...prefix.remaining(message('changed', 'second'))].join('')).toBe('changed\nsecond');
    expect([...prefix.remaining(message('short'))].join('')).toBe('short');
    expect([...prefix.remaining(undefined)]).toEqual([]);
    prefix.reset(); expect([...prefix.remaining(message('first', '', 'last'))].join('')).toBe('first\n\nlast');
  });
  it('compares UTF-16 code units exactly when events split a surrogate pair', () => {
    const prefix = new ObservedTextPrefix(); prefix.append('a\ud83e'); prefix.append('\udd9e');
    expect([...prefix.remaining(message('a🦞tail'))].join('')).toBe('tail');
    prefix.reset(); prefix.append('a\ud83e');
    expect([...prefix.remaining(message('a🦞tail'))].join('')).toBe('\udd9etail');
  });
  it('emits a long remaining body in bounded UTF-8 fragments without cutting complete pairs', () => {
    const prefix = new ObservedTextPrefix(), text = '汉🦞\r\n'.repeat(30_000);
    prefix.append(text.slice(0, 1200));
    const parts = [...prefix.remaining(message(text))];
    expect(parts.join('')).toBe(text.slice(1200));
    expect(parts.length).toBeGreaterThan(4);
    for (const part of parts) { expect(Buffer.byteLength(part)).toBeLessThanOrEqual(32 * 1024); expect(Buffer.from(part).toString()).toBe(part); }
  });
});
