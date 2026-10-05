import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createRpcClient, RpcClientClosedError, type RpcClient } from '../rpc-client.js';

const captured = vi.hoisted(() => ({ socket: undefined as WebSocket | undefined }));
vi.mock('ws', async original => {
  const real = await original<typeof import('ws')>();
  return { ...real, WebSocket: class extends real.WebSocket {
    constructor(...args: ConstructorParameters<typeof real.WebSocket>) { super(...args); captured.socket = this; }
  } };
});

type Receiver = {
  _state: number; _bufferedBytes: number; _fragmented: number; _messageLength: number;
  destroyed: boolean; destroy(error?: Error): void;
  _extensions: Record<string, { decompress(data: Buffer, fin: boolean, done: (error: Error | null, bytes: Buffer) => void): void }>;
};
const receiverOf = (socket: WebSocket) => (socket as unknown as { _receiver: Receiver })._receiver;
const transportOf = (socket: WebSocket) => (socket as unknown as { _socket: Socket })._socket;

describe('RPC close settles the actual receiver in every body phase', () => {
  let client: RpcClient, server: WebSocketServer, socket: WebSocket, peer: WebSocket;
  afterEach(async () => {
    // Also retires a pre-fix hung receiver when a regression assertion fails.
    if (socket) { if (!receiverOf(socket).destroyed) receiverOf(socket).destroy(Error('fixture cleanup')); socket.terminate(); }
    for (const current of server?.clients ?? []) current.terminate();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (client) await client.close();
  });
  async function connect(compressed: boolean) {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: compressed ? { threshold: 0 } : false });
    await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw Error('missing fixture endpoint');
    const connection = once(server, 'connection');
    client = createRpcClient({ url: `ws://127.0.0.1:${address.port}`, timeout: 2_000 });
    await client.connect(); socket = captured.socket!; peer = (await connection)[0] as WebSocket;
  }
  async function closed(pending: Promise<unknown>) {
    const first = client.close(), second = client.close();
    expect(second).toBe(first);
    let completed = false; void first.then(() => { completed = true; });
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 700 });
    expect(await pending).toBeInstanceOf(RpcClientClosedError);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(transportOf(socket).destroyed).toBe(true);
    expect(receiverOf(socket).destroyed).toBe(true);
  }

  it.each(['header', 'payload', 'non-final'])('closes an incomplete uncompressed %s without accepting a successor', async stage => {
    await connect(false); const seen = vi.fn(); client.onNotification('late', seen);
    const requested = once(peer, 'message'); const pending = client.request('partial').catch(error => error); await requested;
    if (stage === 'header') transportOf(peer).write(Buffer.from([0x81]));
    else if (stage === 'payload') transportOf(peer).write(Buffer.concat([Buffer.from([0x81, 126, 4, 0]), Buffer.alloc(64, 0x61)]));
    else peer.send('partial', { fin: false, compress: false });
    await vi.waitFor(() => expect(stage === 'header' ? receiverOf(socket)._bufferedBytes === 1 : stage === 'payload' ? receiverOf(socket)._state === 4 : !!receiverOf(socket)._fragmented).toBe(true));
    await closed(pending); expect(seen).not.toHaveBeenCalled();
  });

  it.each(['inflating', 'decoded-immediate'])('closes during %s without dropping the only writable completion path', async stage => {
    await connect(true); const entered = Promise.withResolvers<void>();
    const extension = receiverOf(socket)._extensions['permessage-deflate']!, decompress = extension.decompress;
    let onceOnly = true, callbackReturned = false; let closing: Promise<void> | undefined;
    const closeAtBoundary = () => {
      expect(receiverOf(socket)._state).toBe(5);
      closing = client.close(); entered.resolve();
    };
    extension.decompress = function(data, fin, done) {
      decompress.call(this, data, fin, (error, decoded) => {
        done(error, decoded);
        callbackReturned = true;
        if (stage === 'decoded-immediate' && onceOnly) { onceOnly = false; queueMicrotask(closeAtBoundary); }
      });
      if (stage === 'inflating' && onceOnly) { onceOnly = false; queueMicrotask(closeAtBoundary); }
    };
    peer.on('message', raw => peer.send(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(raw.toString()).id, result: 'x'.repeat(256 * 1024) }), { compress: true }));
    const pending = client.request('compressed').catch(error => error);
    await entered.promise; expect(closing).toBeDefined(); await closed(pending);
    expect(callbackReturned).toBe(true);
  });

  it('closes a complete message during asynchronous consumption without waiting for consumer IO', async () => {
    await connect(true); const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), seen = vi.fn();
    client.onNotification('late', seen);
    peer.on('message', raw => {
      transportOf(peer).cork();
      peer.send(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(raw.toString()).id, result: {} }), { compress: true });
      peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'late', params: {} }), { compress: true });
      transportOf(peer).uncork();
    });
    const pending = client.consume!('held', {}, async () => { entered.resolve(); await finish.promise; }).catch(error => error);
    await entered.promise;
    try { await closed(pending); expect(seen).not.toHaveBeenCalled(); }
    finally { finish.resolve(); }
  });
});
