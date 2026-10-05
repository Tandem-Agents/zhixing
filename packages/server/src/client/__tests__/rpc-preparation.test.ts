import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { RpcMessagePump } from '../rpc-message-pump.js';
import type { RpcReceiverEdge } from '../rpc-receiver-body.js';

describe('RPC preparation message boundary and actual drain', () => {
  let server: WebSocketServer, client: WebSocket, pump: RpcMessagePump;
  afterEach(async () => {
    pump?.close(); client?.terminate();
    for (const socket of server?.clients ?? []) socket.terminate();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function connect(dispatch: (text: string) => void | Promise<void>, compressed = false) {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: compressed ? { threshold: 0 } : false });
    await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw Error('missing fixture endpoint');
    const peer = once(server, 'connection');
    client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    client.on('error', () => {}); await once(client, 'open');
    pump = new RpcMessagePump(client, dispatch, () => client.terminate());
    client.on('message', bytes => pump.accept(bytes));
    return (await peer)[0] as WebSocket;
  }

  it.each([false, true])('waits for a non-final message and its consumer, then gates a same-chunk successor (compressed=%s)', async compressed => {
    const consumer = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const seen: string[] = [];
    const peer = await connect(async text => { seen.push(text); if (seen.length === 1) await consumer.promise; }, compressed);
    const prefix = 'a'.repeat(64 * 1024);
    peer.send(prefix, { fin: false, compress: compressed });
    const receiver = (client as unknown as { _receiver: RpcReceiverEdge })._receiver;
    await vi.waitFor(() => expect(receiver._fragmented).toBeTruthy());
    const prepare = vi.fn(async () => { entered.resolve(); await release.promise; return 'prepared'; });
    const prepared = pump.prepare(prepare, { deadline: Date.now() + 2_000 });
    await new Promise(resolve => setImmediate(resolve)); expect(prepare).not.toHaveBeenCalled();
    const transport = (peer as unknown as { _socket: Socket })._socket;
    transport.cork(); peer.send('tail', { fin: true, compress: compressed }); peer.send('successor'); transport.uncork();
    await vi.waitFor(() => expect(seen).toHaveLength(1)); expect(prepare).not.toHaveBeenCalled();
    consumer.resolve(); await entered.promise;
    expect(seen).toEqual([prefix + 'tail']);
    release.resolve(); expect(await prepared).toBe('prepared');
    await vi.waitFor(() => expect(seen).toEqual([prefix + 'tail', 'successor']));
  });

  it('grants an idle lease without another incoming message and retains real work across EOF', async () => {
    const seen = vi.fn(); const peer = await connect(seen);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const prepared = pump.prepare(async signal => { entered.resolve(); await release.promise; expect(signal.aborted).toBe(true); return 'late'; }, { deadline: Date.now() + 2_000 }).catch(error => error);
    await entered.promise; peer.terminate();
    expect(await prepared).toBeInstanceOf(Error);
    let drained = false; const draining = pump.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
    release.resolve(); await draining; expect(seen).not.toHaveBeenCalled();
  });

  it('does not grant across a partial header and does not renew the waiting deadline', async () => {
    const seen = vi.fn(); const peer = await connect(seen);
    const transport = (peer as unknown as { _socket: Socket })._socket;
    transport.write(Buffer.from([0x81]));
    const receiver = (client as unknown as { _receiver: RpcReceiverEdge })._receiver;
    await vi.waitFor(() => expect(receiver._bufferedBytes).toBe(1));
    const prepare = vi.fn(async () => 'wrong');
    await expect(pump.prepare(prepare, { deadline: Date.now() + 30 })).rejects.toThrow('deadline');
    expect(prepare).not.toHaveBeenCalled();
    transport.write(Buffer.from([2, 0x6f, 0x6b]));
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith('ok'));
  });
});
