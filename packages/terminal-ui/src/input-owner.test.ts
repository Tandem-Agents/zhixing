import { afterEach, expect, it, vi } from 'vitest';
import { TerminalInputOwner } from './input-owner.js';
import { TERMINAL_MODES } from './mode-policy.js';

const descriptors = ['isTTY', 'setRawMode'].map(key => [key, Object.getOwnPropertyDescriptor(process.stdin, key)] as const);
const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
let owner: TerminalInputOwner | undefined;
afterEach(() => {
  owner?.cancel(); vi.restoreAllMocks(); vi.useRealTimers();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(process.stdin, key, descriptor);
    else Reflect.deleteProperty(process.stdin, key);
  }
  if (outputTTY) Object.defineProperty(process.stdout, 'isTTY', outputTTY);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
});
function query() {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: vi.fn() });
  vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  owner = new TerminalInputOwner(vi.fn());
  return owner.query(new AbortController().signal);
}
it('collects fragmented mode replies while preserving actual early Unicode input', async () => {
  const pending = query();
  const bytes = Buffer.from('你好' + TERMINAL_MODES.map(({ id }) => `\x1b[?${id};2$y`).join(''));
  for (const byte of bytes) process.stdin.emit('data', Buffer.from([byte]));
  expect(await pending).toEqual({ originalMask: 0, mutableMask: 511 });
  const input: Buffer[] = [], collect = (chunk: Buffer) => input.push(chunk);
  owner!.handoff({ setupInput: () => process.stdin.on('data', collect) });
  process.stdin.off('data', collect);
  expect(Buffer.concat(input).toString()).toBe('你好');
});
it('bounds missing terminal replies and removes its listener on timeout', async () => {
  vi.useFakeTimers(); const before = process.stdin.listenerCount('data');
  const pending = query(), rejected = expect(pending).rejects.toThrow('terminal-mode-query-timeout');
  await vi.advanceTimersByTimeAsync(800); await rejected;
  expect(process.stdin.listenerCount('data')).toBe(before);
});
