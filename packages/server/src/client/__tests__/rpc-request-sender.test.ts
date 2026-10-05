import { setImmediate as turn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RpcRequestSender } from '../rpc-request-sender.js';

function controlledSender() {
  const frames: { text: string; final: boolean; complete(error?: Error): void }[] = [];
  const failure = vi.fn();
  const socket = { send(text: string, options: { fin: boolean }, complete: (error?: Error) => void) {
    frames.push({ text, final: options.fin, complete });
  } } as unknown as Pick<WebSocket, 'send'>;
  return { frames, failure, sender: new RpcRequestSender(socket, failure) };
}

describe('RPC request transmission ownership', () => {
  it('preserves one UTF-8 JSON message across bounded frames and cannot interleave a queued request', async () => {
    const h = controlledSender();
    const original = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: '汉🦞\r\n"'.repeat(20_000) });
    const firstDone = vi.fn(), secondDone = vi.fn(), secondEncode = vi.fn(() => '{"id":2}');
    h.sender.send(() => original, () => true, firstDone);
    h.sender.send(secondEncode, () => true, secondDone);
    await turn();
    const received: Buffer[] = [];
    for (let index = 0;; index++) {
      expect(h.frames.length).toBe(index + 1);
      expect(secondEncode).toHaveBeenCalledOnce();
      const frame = h.frames[index]!;
      const bytes = Buffer.from(frame.text);
      expect(bytes.length).toBeLessThanOrEqual(32 * 1024);
      expect(bytes.toString()).toBe(frame.text);
      received.push(bytes);
      await turn(); expect(h.frames.length).toBe(index + 1); // A blocked write admits no successor.
      frame.complete();
      if (frame.final) break;
      await turn();
    }
    expect(Buffer.concat(received).toString()).toBe(original);
    expect(firstDone).toHaveBeenCalledExactlyOnceWith();
    expect(secondEncode).toHaveBeenCalledOnce();
    await turn();
    expect(h.frames.at(-1)?.text).toBe('{"id":2}');
    h.frames.at(-1)!.complete();
    expect(secondDone).toHaveBeenCalledExactlyOnceWith();
    h.sender.close(Error('fixture finished'));
    expect(h.failure).not.toHaveBeenCalled();
  });

  it('drops an expired queued message and identifies a partial message that must close the connection', async () => {
    const h = controlledSender(), encode = vi.fn(() => '{"id":2}'), done = vi.fn();
    const cancelActive = h.sender.send(() => 'x'.repeat(100_000), () => true, done);
    const cancelQueued = h.sender.send(encode, () => false, vi.fn());
    await turn();
    expect(cancelQueued()).toBe(false);
    expect(cancelActive()).toBe(true);
    h.sender.close(Error('original request deadline'));
    h.frames[0]!.complete(); await turn();
    expect(encode).toHaveBeenCalledOnce();
    expect(h.frames).toHaveLength(1);
    expect(done).toHaveBeenCalledOnce();
  });

  it('settles active and queued sends once on a write failure without writing the next request', async () => {
    const h = controlledSender(), active = vi.fn(), queued = vi.fn(), encode = vi.fn(() => '{"id":2}');
    h.sender.send(() => 'x'.repeat(100_000), () => true, active);
    h.sender.send(encode, () => true, queued);
    await turn();
    const error = Error('synthetic transport failure');
    h.frames[0]!.complete(error); await turn();
    expect(active).toHaveBeenCalledExactlyOnceWith(error);
    expect(queued).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.failure).toHaveBeenCalledExactlyOnceWith(error);
    expect(encode).toHaveBeenCalledOnce();
    expect(h.frames).toHaveLength(1);
  });

  it('snapshots accepted params before a caller can mutate them during write backpressure', async () => {
    const h = controlledSender(), params = { text: 'original' };
    h.sender.send(() => 'x'.repeat(100_000), () => true, vi.fn());
    h.sender.send(() => JSON.stringify(params), () => true, vi.fn());
    params.text = 'mutated'; await turn();
    for (let index = 0;; index++) {
      const frame = h.frames[index]!; frame.complete();
      await turn(); if (frame.final) break;
    }
    expect(h.frames.at(-1)?.text).toBe('{"text":"original"}');
    h.frames.at(-1)!.complete(); h.sender.close(Error('fixture finished'));
  });
});
