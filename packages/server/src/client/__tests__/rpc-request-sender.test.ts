import { setImmediate as turn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RpcRequestSender } from '../rpc-request-sender.js';

function controlledSender(maximumQueuedBytes?: number) {
  const frames: { text: string; bytes: Buffer; final: boolean; complete(error?: Error): void }[] = [];
  const failure = vi.fn();
  const socket = { send(value: string | Uint8Array, options: { fin: boolean }, complete: (error?: Error) => void) {
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
    frames.push({ text: bytes.toString(), bytes, final: options.fin, complete });
  } } as unknown as Pick<WebSocket, 'send'>;
  return { frames, failure, sender: new RpcRequestSender(socket, failure, maximumQueuedBytes) };
}

describe('RPC request transmission ownership', () => {
  it('does not retire an ordinary request until its actual write callback has returned after close', async () => {
    const h = controlledSender(), retired = vi.fn(), done = vi.fn();
    h.sender.send(() => 'queued text', () => true, done, retired);
    await turn(); h.sender.close(Error('cancelled'));
    let drained = false;
    const draining = h.sender.drain().then(() => { drained = true; });
    await turn(); expect(drained).toBe(false); expect(retired).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce(); h.frames[0]!.complete();
    expect(retired).not.toHaveBeenCalled();
    await draining; expect(retired).toHaveBeenCalledOnce();
  });

  it('charges aggregate encoded UTF-8 bytes and releases cancelled queued text', async () => {
    const h = controlledSender(12), rejected = vi.fn();
    const cancel = h.sender.send(() => '汉'.repeat(3), () => true, vi.fn());
    h.sender.send(() => 'abcd', () => true, rejected);
    expect(rejected).toHaveBeenCalledWith(expect.any(Error));
    cancel();
    h.sender.send(() => 'abcd', () => true, vi.fn());
    await turn(); expect(h.frames).toHaveLength(1); expect(h.frames[0]!.text).toBe('abcd');
    h.frames[0]!.complete(); h.sender.close(Error('fixture finished')); await h.sender.drain();
  });
  it('streams one immutable cold params source without interleaving or an aggregate JSON buffer', async () => {
    const h = controlledSender();
    const params = Buffer.from(JSON.stringify({ text: '汉🦞\n'.repeat(20_000) }));
    const released = vi.fn(), done = vi.fn();
    h.sender.sendEncoded(7, 'session.send', { byteLength: params.length, open: () => ({
      async read(offset, maximum) { return Buffer.from(params.subarray(offset, offset + maximum)); }, release: released,
    }) }, new AbortController().signal, () => true, done);
    h.sender.send(() => '{"next":true}', () => true, vi.fn());
    await turn();
    const received: Buffer[] = [];
    for (let index = 0;; index++) {
      const frame = h.frames[index]!; expect(frame).toBeDefined();
      expect(frame.bytes.length).toBeLessThanOrEqual(32 * 1024);
      received.push(frame.bytes); frame.complete();
      if (frame.final) break;
      await turn();
    }
    expect(JSON.parse(Buffer.concat(received).toString())).toEqual({ jsonrpc: '2.0', id: 7, method: 'session.send', params: JSON.parse(params.toString()) });
    expect(released).toHaveBeenCalledOnce(); expect(done).toHaveBeenCalledOnce();
    await turn(); expect(h.frames.at(-1)?.text).toBe('{"next":true}');
    h.frames.at(-1)!.complete(); h.sender.close(Error('fixture finished'));
  });

  it.each(['read', 'write'])('keeps the cold-source borrow until the actual %s finishes after cancellation', async stage => {
    const h = controlledSender(), gate = Promise.withResolvers<Uint8Array>(), released = vi.fn();
    const cancel = h.sender.sendEncoded(1, 'session.send', { byteLength: 2, open: () => ({
      read: () => stage === 'read' ? gate.promise : Promise.resolve(Buffer.from('{}')), release: released,
    }) }, new AbortController().signal, () => true, vi.fn());
    await turn(); h.frames[0]!.complete(); await turn();
    expect(cancel()).toBe(true); h.sender.close(Error('expired'));
    let drained = false; const draining = h.sender.drain().then(() => { drained = true; });
    await turn(); expect(released).not.toHaveBeenCalled(); expect(drained).toBe(false);
    if (stage === 'read') gate.resolve(Buffer.from('{}')); else h.frames[1]!.complete();
    await draining; expect(released).toHaveBeenCalledOnce();
    expect(h.frames).toHaveLength(stage === 'read' ? 1 : 2);
  });
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
