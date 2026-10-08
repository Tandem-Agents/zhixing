import { SESSION_NOTIFICATIONS, validateSessionProcessProjection } from '@zhixing/rpc/session-wire';
import type { SessionEventEnvelope } from '@zhixing/rpc/session-events';
import type { CoreHostNotificationLink } from './core-host-connection.js';
import { TerminalProcessSession } from '../terminal/process-session.js';

/** Passive text binding for the two existing notice sources. Body/thinking/tool
 * yields remain exclusively owned by ConversationController and its presenters. */
export function createTextRunFeedback(options: {
  readonly link: CoreHostNotificationLink;
  readonly watching: (conversationId: string) => boolean;
  readonly line: (text: string) => void;
}): { dispose(): void } {
  // A switch RPC can report its target before the current pointer moves. Keep
  // those two conversations separate, including event-only orchestration IDs.
  const sessions = new Map<string, TerminalProcessSession>();
  let disposed = false;
  const session = (conversationId: string, create: boolean): TerminalProcessSession | undefined => {
    if (disposed || !options.watching(conversationId)) return;
    for (const [id, value] of sessions) if (!options.watching(id)) {
      value.reset(); sessions.delete(id);
    }
    let value = sessions.get(conversationId);
    if (!value && create) {
      // Before auto-resume resolves, the binding has no current pointer yet.
      // Never allow malformed/excessive sources to grow that startup window.
      if (sessions.size >= 8) { options.line('过程反馈超出显示容量，请核对最终结果。'); return; }
      value = new TerminalProcessSession({ currentConversation: () => conversationId,
        changed: () => {}, columns: () => 100,
        block: block => { if (block.role === 'process') options.line(block.text); },
        gap: options.line });
      sessions.set(conversationId, value);
    }
    return value;
  };
  const offProcess = options.link.onNotification(SESSION_NOTIFICATIONS.process, input => {
    if (disposed) return;
    try { validateSessionProcessProjection(input); }
    catch { options.line('过程反馈不可读取，请核对最终结果。'); return; }
    const { payload, source } = input;
    const audit = payload.kind === 'event' && (payload.event.event === 'security:steward_review' || payload.event.event === 'security:rule_sedimented');
    // Feed closure/gap only to an existing notice projection; no yield or tool
    // event ever enters it, so even final flushing cannot duplicate a tool card.
    if (audit || payload.kind === 'closed' || payload.kind === 'gap') {
      session(source.conversationId, audit)?.accept(input);
    }
  });
  const offEvents = options.link.onNotification(SESSION_NOTIFICATIONS.event, input => {
    if (disposed || !input || typeof input !== 'object') return;
    const event = input as SessionEventEnvelope;
    if (event.scope !== 'run' || typeof event.conversationId !== 'string' ||
        !event.conversationId || event.conversationId.length > 1024 ||
        typeof event.runId !== 'string' || !event.runId || event.runId.length > 1024 ||
        !Number.isSafeInteger(event.seq) || event.seq < 0) return;
    const perspective = ['orchestration:run_start', 'orchestration:node_start', 'orchestration:run_end'].includes(event.event);
    if (perspective || event.lifecycle === 'closed') {
      session(event.conversationId, perspective)?.acceptEvent(event);
    }
  });
  return { dispose() {
    if (disposed) return;
    disposed = true; offProcess(); offEvents();
    for (const value of sessions.values()) value.reset();
    sessions.clear();
  } };
}
