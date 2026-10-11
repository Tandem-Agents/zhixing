import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { createRpcClient } from '@zhixing/server/client';
import { RpcConversationFacade } from '../../../../cli/src/runtime/rpc-conversation-facade.js';
import type { CoreHostRpcLink } from '../../../../cli/src/runtime/core-host-connection.js';

it('keeps an actually timed-out command single while querying its later acceptance over WebSocket', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || !address) throw Error('fixture address');
  let sends = 0, checks = 0, originalRequest: number | undefined;
  server.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(bytes.toString());
    if (request.method === 'session.send') { sends++; originalRequest = request.id; return; }
    expect(request.method).toBe('session.inputReceipt');
    expect(request.params).toEqual({ conversationId: 'conv', turnId: 'turn' });
    checks++;
    const result = checks === 1 ? { status: 'unknown' }
      : { status: 'accepted', conversationId: 'conv', turnId: 'turn', runId: 'run' };
    if (checks === 2) socket.send(JSON.stringify({ jsonrpc: '2.0', id: originalRequest, result: { conversationId: 'conv', turnId: 'turn', runId: 'run' } }));
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  }));
  const client = createRpcClient({ url: `ws://127.0.0.1:${address.port}`, timeout: 150 });
  const link = { getClient: async () => client } as CoreHostRpcLink;
  const pending = vi.fn(), disposed = vi.fn(async () => {});
  try {
    await client.connect();
    const result = await new RpcConversationFacade(link).sendPrepared(async identity => {
      const bytes = Buffer.from(JSON.stringify({ ...identity, text: '中文输入' }));
      return { byteLength: bytes.length, dispose: disposed, open: () => ({
        read: async (offset: number, maximum: number) => bytes.subarray(offset, offset + maximum), release() {},
      }) };
    }, 'conv', 'turn', undefined, undefined, { pending, waitForRetry: async () => { throw Error('unexpected manual retry'); } });
    expect(result).toMatchObject({ conversationId: 'conv', turnId: 'turn', runId: 'run' });
    expect(sends).toBe(1); expect(checks).toBe(2); expect(disposed).toHaveBeenCalledOnce();
    expect(pending.mock.calls[0]?.[0]).toMatchObject({ code: 'RPC_DEADLINE_EXCEEDED', stage: 'waiting-receipt' });
  } finally {
    await client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
