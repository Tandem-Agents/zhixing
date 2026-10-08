import type { DecorateRunBusFn } from '@zhixing/orchestrator/runtime';
import type { SessionEventEnvelope } from '@zhixing/rpc/session-events';
import { validateSessionEventProjection } from '@zhixing/core/protocol';
import type { SessionEventProjection } from '@zhixing/core/types';
import { boundedProcessValue } from '@zhixing/rpc/session-wire';
import type { CliWriter } from '../screen/index.js';
import { createRunEventSubscribers } from '../render-events.js';
import type { LifecycleWarningDeduper } from '../lifecycle-diagnostics-presentation.js';
import type { CoreHostNotificationLink } from './core-host-connection.js';
import { RpcEventBus } from './rpc-event-bus.js';

const diagnostics = new Set([
  'retry:attempt', 'retry:success', 'retry:exhausted',
  'segment:transition_start', 'segment:emergency_floor', 'segment:new_started', 'segment:transition_failed',
  'interrupt:warn', 'interrupt:fired',
  'lifecycle:warning', 'lifecycle:hook_failed', 'lifecycle:prompt_rebuilt',
]);
const observed = new Set(['agent:run_start', 'agent:input_received', 'agent:run_end']);

/** One existing RPC bus owns legacy run notices and observed-turn anchors.
 * Host's run decorator always publishes this leg, including assignment runs.
 * Canonical process audits and Host perspectives keep their existing owners. */
export function createTextRunEventBinding(options: {
  readonly link: CoreHostNotificationLink;
  readonly watching: (conversationId: string) => boolean;
  readonly writer: CliWriter;
  readonly lifecycleWarningDeduper?: LifecycleWarningDeduper;
  readonly observed: DecorateRunBusFn;
  readonly onError: (error: unknown, event: string) => void;
}): { dispose(): void } {
  const decorate = createRunEventSubscribers({ writer: options.writer, lifecycleWarningDeduper: options.lifecycleWarningDeduper });
  // Retain finite closed-run watermarks: a late repeat must not establish a
  // fresh bus after disposal. RpcEventBus still owns active bus lifecycle.
  const sources = new Map<string, { conversationId: string; seq: number; closed: boolean }>();
  let capacityReported = false;
  const filter = (event: SessionEventEnvelope): boolean => {
    if (!event || event.scope !== 'run' || typeof event.conversationId !== 'string' || !event.conversationId || event.conversationId.length > 1024 ||
      typeof event.runId !== 'string' || !event.runId || event.runId.length > 1024 ||
      !Number.isSafeInteger(event.seq) || event.seq < 0 || !event.meta || typeof event.meta !== 'object' ||
      !options.watching(event.conversationId)) return false;
    const closed = event.lifecycle === 'closed';
    if (!closed && !diagnostics.has(event.event) && !observed.has(event.event)) return false;
    if (!closed && diagnostics.has(event.event)) {
      try {
        const projection = { event: event.event, payload: event.payload } as SessionEventProjection;
        validateSessionEventProjection(projection); boundedProcessValue(projection, 64 * 1024);
      } catch { options.writer.line('运行反馈不可读取，请核对最终结果。'); return false; }
    }
    const key = JSON.stringify([event.conversationId, event.runId]);
    let state = sources.get(key);
    if (state && (state.closed || event.seq <= state.seq)) return false;
    if (!state) {
      // The same conversation has one serial run, as in RpcEventBus itself.
      for (const value of sources.values()) if (value.conversationId === event.conversationId) value.closed = true;
      if (sources.size >= 128) {
        const old = [...sources].find(([, value]) => value.closed || !options.watching(value.conversationId));
        if (old) sources.delete(old[0]);
        else { if (!capacityReported) { capacityReported = true; options.writer.line('运行反馈超出显示容量，请核对最终结果。'); } return false; }
      }
      state = { conversationId: event.conversationId, seq: -1, closed: false }; sources.set(key, state);
    }
    state.seq = event.seq; state.closed = closed;
    return true;
  };
  const bus = new RpcEventBus({ link: options.link, source: 'legacy', filter, onListenerError: options.onError,
    decorate: ctx => {
      const stopObserved = options.observed(ctx), stopDiagnostics = decorate(ctx);
      return () => { try { stopObserved(); } finally { stopDiagnostics(); } };
    } });
  return { dispose() { bus.dispose(); sources.clear(); } };
}
