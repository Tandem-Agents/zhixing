import { describe, expect, it, vi } from 'vitest';
import { RpcConversationFacade } from '../rpc-conversation-facade.js';
import { RpcEventBus } from '../rpc-event-bus.js';
import { makeFakeHostLink } from './fake-host-link.js';
describe('RPC process adapters', () => {
  it('keeps the original subscribe request compatible with old exact-key Servers', async () => {
    const f = makeFakeHostLink(); f.setResponder((_method, params) => {
      expect(Object.keys(params as object).sort()).toEqual(['afterCommitRevision', 'conversationId', 'replayFinals']);
      return { subscribed: true };
    });
    expect(await new RpcConversationFacade(f.link).subscribe('c', 4, false)).toBe(true);
  });
  it('returns actual accepted profile and keeps process subscriptions passive/disposable', async () => {
    const f = makeFakeHostLink(); f.setResponder(() => ({ subscribed: true, presentation: 'default' }));
    const facade = new RpcConversationFacade(f.link), received = vi.fn(), stop = facade.onProcess(received);
    expect(f.requests).toEqual([]);
    expect(await facade.subscribePresentation('c', 'bounded-v1', 3, false)).toEqual({ subscribed: true, presentation: 'default' });
    expect(f.requests[0]!.params).toEqual({ conversationId: 'c', presentation: 'bounded-v1', afterCommitRevision: 3, replayFinals: false });
    f.notify('session.process', { source: 'test' }); expect(received).toHaveBeenCalledOnce();
    stop(); expect(f.handlerCount('session.process')).toBe(0);
  });
  it('selects one event source and never fabricates turnId from a real assignment runId', () => {
    const f = makeFakeHostLink(), contexts: any[] = [], events: string[] = [], dispose = vi.fn();
    const bus = new RpcEventBus({ link: f.link, source: 'process', onListenerError: vi.fn(), decorate: ctx => {
      contexts.push(ctx); ctx.bus.onAny(event => { events.push(event); }); return dispose;
    } });
    const source = { conversationId: 'c', runId: 'actual-run', assignmentId: 'assignment', streamEpoch: 1, sourceSeq: 2, lineage: 'main' };
    const payload = { kind: 'event', event: { event: 'llm:request_start', payload: { model: 'm', messageCount: 1, hasTools: false } } };
    f.notify('session.process', { version: 1, source, payload });
    f.notify('session.process', { version: 1, source, payload });
    expect(contexts[0].turnContext.turnId).toBeUndefined(); expect(events).toEqual(['llm:request_start']);
    expect(f.handlerCount('session.event')).toBe(0);
    f.notify('session.process', { version: 1, source, payload: { kind: 'closed' } });
    expect(dispose).toHaveBeenCalledOnce();
    bus.dispose(); expect(dispose).toHaveBeenCalledOnce(); expect(f.handlerCount('session.process')).toBe(0);
  });
});
