import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnedMcpStdioTransport } from '../owned-stdio.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  let end!: () => void, unknown!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => { end = resolve; unknown = reject; });
  const transport = new OwnedMcpStdioTransport(() => ({ child, ready: Promise.resolve(), closed }));
  return { child, transport, end, unknown, cleanup: () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); } };
}

it('keeps SDK framing and waits for actual completion after TERM/KILL', async () => {
  vi.useFakeTimers(); const f = fixture();
  const onclose = vi.fn(), onmessage = vi.fn(); f.transport.onclose = onclose; f.transport.onmessage = onmessage;
  await f.transport.start();
  f.child.stdout.write('{"jsonrpc":"2.0","method":"synthetic'); f.child.stdout.write('"}\n');
  expect(onmessage).toHaveBeenCalledWith({ jsonrpc: '2.0', method: 'synthetic' });
  let settled = false; const closing = f.transport.close().then(() => { settled = true; });
  expect(f.transport.close()).not.toBeUndefined();
  await vi.advanceTimersByTimeAsync(4001);
  expect(f.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  expect(settled).toBe(false); expect(onclose).not.toHaveBeenCalled();
  f.end(); await closing; expect(onclose).toHaveBeenCalledTimes(1); f.cleanup();
});

it('does not report normal close for an unknown owner completion', async () => {
  const f = fixture(), onclose = vi.fn(), onerror = vi.fn();
  f.transport.onclose = onclose; f.transport.onerror = onerror; await f.transport.start();
  const closing = f.transport.close(); const rejection = expect(closing).rejects.toThrow('synthetic-unknown');
  expect(f.transport.close()).toBe(closing);
  f.unknown(Error('synthetic-unknown')); await rejection;
  expect(onclose).not.toHaveBeenCalled(); expect(onerror).toHaveBeenCalledTimes(1); f.cleanup();
});
