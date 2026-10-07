import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { createRpcConnection } from '../connection.js';
import { buildSessionSubscribeMethod, buildSessionUnsubscribeMethod } from '../methods/session.js';
import type { HandlerContext } from '../handlers.js';
function setup() {
  const socket = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn() });
  const connection = createRpcConnection(socket as unknown as WebSocket);
  connection.authenticated = true;
  const history = vi.fn(async (): Promise<any[]> => []);
  const removeObserver = vi.fn();
  const ctx = { connection, server: { conversation: { has: () => true, addObserver: () => true, removeObserver }, conversationFinalHistory: history } } as unknown as HandlerContext;
  return { connection, socket, history, ctx, removeObserver };
}
describe('connection-scoped accepted presentation', () => {
  it('reads actual socket writability without sending a probe', () => {
    const { socket, connection } = setup();
    expect(connection.writable).toBe(true);
    socket.readyState = 2; expect(connection.writable).toBe(false);
    socket.readyState = 1; expect(connection.writable).toBe(true);
    socket.emit('close'); expect(connection.writable).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
  });
  it('defaults old requests, negotiates per conversation, and isolates connections', async () => {
    const a = setup(), b = setup(), method = buildSessionSubscribeMethod();
    expect(await method.handler({ conversationId: 'c' }, a.ctx)).toEqual({ subscribed: true, presentation: 'default' });
    expect(await method.handler({ conversationId: 'c', presentation: 'bounded-v1' }, a.ctx)).toEqual({ subscribed: true, presentation: 'bounded-v1' });
    expect(a.connection.presentationProfile!('other')).toBe('default');
    expect(b.connection.presentationProfile!('c')).toBe('default');
    await expect(method.handler({ conversationId: 'c', presentation: 'future' }, a.ctx)).rejects.toMatchObject({ code: -32602 });
  });
  it('does not cancel pending final/publish replay when display pauses without another replay', async () => {
    const s = setup(), method = buildSessionSubscribeMethod();
    let finish!: (value: any[]) => void;
    s.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const initial = method.handler({ conversationId: 'c', presentation: 'bounded-v1' }, s.ctx);
    const revision = s.connection.observationRevision!('c');
    await method.handler({ conversationId: 'c', presentation: 'default', replayFinals: false }, s.ctx);
    expect(s.connection.observationRevision!('c')).toBe(revision);
    finish([{ frame: { conversationId: 'c', runId: 'r', commitRevision: 2 },
      publishResults: [{ conversationId: 'c', runId: 'r', seq: 1 }] }]);
    await initial;
    const messages = s.socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(messages.map(m => m.method)).toEqual(['session.final', 'session.event']);
    expect(messages[1].params.event).toBe('publish:result');
  });
  it.each(['unsubscribe', 'close'])('invalidates late control replay only at actual %s', async action => {
    const s = setup(); let finish!: (value: any[]) => void;
    s.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const initial = buildSessionSubscribeMethod().handler({ conversationId: 'c', presentation: 'bounded-v1' }, s.ctx);
    if (action === 'unsubscribe') await buildSessionUnsubscribeMethod().handler({ conversationId: 'c' }, s.ctx);
    else s.socket.emit('close');
    finish([{ frame: { conversationId: 'c' }, publishResults: [] }]);
    expect(await initial).toEqual({ subscribed: false, presentation: 'default' });
    expect(s.socket.send).not.toHaveBeenCalled();
    expect(s.connection.presentationProfile!('c')).toBe('default');
  });
  it('caps subscription profile storage and accepts replacement of an existing profile at capacity', () => {
    const { connection } = setup();
    for (let i = 0; i < 128; i++) expect(connection.setPresentationProfile!('c' + i, 'bounded-v1')).toBe(true);
    expect(connection.setPresentationProfile!('overflow', 'bounded-v1')).toBe(false);
    expect(connection.setPresentationProfile!('c0', 'default')).toBe(true);
    connection.dropPresentationProfile!('c0');
    expect(connection.setPresentationProfile!('next', 'bounded-v1')).toBe(true);
  });
});
