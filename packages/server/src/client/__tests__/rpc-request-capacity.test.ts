import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { createRpcClient } from '../rpc-client.js';

describe('RPC correlation lifetime', () => {
  it('keeps admission after transmission and through a cancelled, still-running consumer', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw Error('fixture address');
    let live = 0;
    const client = createRpcClient({ url: `ws://127.0.0.1:${address.port}`, timeout: 1000, maximumPendingRequests: 1,
      acquireRequest: () => { live++; return () => { live--; }; } });
    const consumer = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    try {
      const connected = once(server, 'connection'); await client.connect();
      const peer = (await connected)[0] as WebSocket;
      const received = once(peer, 'message');
      const pending = client.consume!('fixture', {}, async () => { entered.resolve(); await consumer.promise; return 7; }).catch(error => error);
      const request = JSON.parse((await received)[0].toString());
      expect(live).toBe(1);
      await expect(client.request('after-write')).rejects.toThrow('capacity');
      peer.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { text: 'held' } }));
      await entered.promise;
      await expect(client.request('during-consume')).rejects.toThrow('capacity');
      await client.close(); expect(await pending).toBeInstanceOf(Error); expect(live).toBe(1);
      consumer.resolve(); await client.drain!(); expect(live).toBe(0);
    } finally {
      consumer.resolve(); await client.close();
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
