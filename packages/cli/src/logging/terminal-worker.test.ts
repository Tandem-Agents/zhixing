import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { serialize } from 'node:v8';
import { afterEach, expect, it, vi } from 'vitest';
import { createTerminalOwnedProcessFactory } from '../terminal/host-launch.js';
import { LogWorkerChannel, createTerminalLogWorker } from './terminal-worker.js';

vi.mock('../terminal/host-launch.js', () => ({ createTerminalOwnedProcessFactory: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it('preserves binary logging values over fragmented and consecutive frames', () => {
  const input = new PassThrough(), output = new PassThrough();
  const channel = new LogWorkerChannel(input, output, 1024);
  const messages: unknown[] = []; channel.on('message', message => messages.push(message));
  const value = { bytes: new Uint8Array([0, 128, 255]), text: '日志\n"' };
  const body = serialize(value), frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32BE(body.length); body.copy(frame, 4);
  input.write(frame.subarray(0, 2)); input.write(frame.subarray(2, 7));
  input.write(Buffer.concat([frame.subarray(7), frame]));
  expect(messages).toEqual([value, value]);
  expect((messages[0] as typeof value).bytes).toBeInstanceOf(Uint8Array);
  channel.close(); output.destroy();
});

it('rejects an oversized announced frame before accepting its body', () => {
  const input = new PassThrough(), output = new PassThrough();
  const channel = new LogWorkerChannel(input, output, 16);
  const errors: Error[] = []; channel.on('error', error => errors.push(error));
  const header = Buffer.alloc(4); header.writeUInt32BE(17); input.write(header);
  expect(errors[0]?.message).toBe('log-worker-frame-capacity');
  expect(channel.connected).toBe(false); expect(input.destroyed).toBe(true);
});

it.each([false, true])('reports close only after an actual owner receipt, unknown=%s', async unknown => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  let resolve!: (result: { code: number; signal: null }) => void, reject!: (error: Error) => void;
  const closed = new Promise<{ code: number; signal: null }>((yes, no) => { resolve = yes; reject = no; });
  vi.mocked(createTerminalOwnedProcessFactory).mockReturnValue(vi.fn(() => ({ child, ready: Promise.resolve(), closed })) as any);
  const owner = createTerminalLogWorker('log-files', ['synthetic-worker']);
  const close = vi.fn(), uncertain = vi.fn(); owner.worker.on('close', close); owner.worker.on('completion-unknown', uncertain);
  await owner.ready; expect(owner.worker.connected).toBe(true);
  owner.worker.kill(); child.stdout.end(); await new Promise<void>(setImmediate);
  expect(close).not.toHaveBeenCalled();
  if (unknown) reject(Error('synthetic-unknown')); else resolve({ code: 0, signal: null });
  await new Promise<void>(setImmediate);
  expect(close).toHaveBeenCalledTimes(unknown ? 0 : 1);
  expect(uncertain).toHaveBeenCalledTimes(unknown ? 1 : 0);
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});
