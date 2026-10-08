import { describe, expect, it, vi } from 'vitest';
import { createTextRunEventBinding } from '../text-run-event-binding.js';
import { makeFakeHostLink } from './fake-host-link.js';

describe('text diagnostic source ownership', () => {
  it('uses one legacy bus, isolates pending/current, drops duplicates and closed tails, and unsubscribes', () => {
    const host = makeFakeHostLink(), line = vi.fn(), onError = vi.fn();
    const watched = new Set(['current', 'pending']);
    const binding = createTextRunEventBinding({ link: host.link, watching: id => watched.has(id),
      writer: { line, notify: line, appendInline: vi.fn(), ensureSegmentBreak: vi.fn() }, observed: () => () => {}, onError });
    const emit = (conversationId: string, seq: number, event = 'retry:attempt', payload: unknown = { errorType: 'network', attempt: 1, maxRetries: 3, delayMs: 100, willRetry: true }, extra = {}) => {
      const value = { conversationId, runId: 'same-turn', seq, event, payload, scope: 'run', meta: { lineage: 'main' }, ...extra };
      host.notify('session.event', value); return value;
    };
    const first = emit('current', 1); host.notify('session.event', first);
    emit('pending', 1); emit('other', 1);
    expect(line).toHaveBeenCalledTimes(2);
    host.notify('session.process', { version: 1, source: { conversationId: 'current', turnId: 'same-turn', runId: 'run', assignmentId: 'a', streamEpoch: 1, sourceSeq: 1 }, payload: { kind: 'event', event: { event: first.event, payload: first.payload } } });
    emit('current', 2, 'tool:call_start', { id: 'tool', name: 'read' });
    emit('current', 3, 'security:steward_review', {});
    emit('current', 4, 'orchestration:run_start', {});
    expect(line).toHaveBeenCalledTimes(2);
    watched.delete('current'); emit('current', 5);
    emit('pending', 2, 'run:closed', null, { lifecycle: 'closed' }); emit('pending', 3);
    expect(line).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled(); expect(host.requests).toEqual([]);
    binding.dispose(); binding.dispose();
    expect(host.handlerCount('session.event')).toBe(0); expect(host.handlerCount('session.process')).toBe(0);
    emit('pending', 4); expect(line).toHaveBeenCalledTimes(2);
  });
  it('preserves main-lineage filtering and shared segment/lifecycle formatting', () => {
    const host = makeFakeHostLink(), line = vi.fn();
    const binding = createTextRunEventBinding({ link: host.link, watching: () => true,
      writer: { line, notify: line, appendInline: vi.fn(), ensureSegmentBreak: vi.fn() }, observed: () => () => {}, onError: error => { throw error; } });
    const emit = (seq: number, event: string, payload: unknown, lineage = 'main') => host.notify('session.event', { conversationId: 'c', runId: 't', seq, event, payload, scope: 'run', meta: { lineage } });
    emit(1, 'segment:transition_start', { segmentId: 's', reason: 'risk-exceeded', currentTokens: 1000 });
    emit(2, 'segment:new_started', { segmentId: 's', bufferTurns: 2, tokensBefore: 1000, tokensAfter: 100 });
    emit(3, 'segment:transition_failed', { segmentId: 's', error: 'failed-test', retriesExhausted: true });
    emit(4, 'lifecycle:warning', { hookId: 'h', runtimeId: 'r', phase: 'onBeforeRun', windowIndex: 0, message: 'sub-warning' }, 'main/sub-child');
    const text = line.mock.calls.map(([text]) => text).join('\n');
    expect(text).toContain('整理上下文中'); expect(text).toContain('上下文已整理'); expect(text).toContain('failed-test'); expect(text).not.toContain('sub-warning');
    binding.dispose();
  });
});
