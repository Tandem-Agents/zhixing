import type { AgentYield } from '@zhixing/core/loop';
import type { SessionProcessProjection } from '@zhixing/rpc/session-wire';
import type { SessionEventEnvelope } from '@zhixing/rpc/session-events';
import type { TerminalProcessStatus } from '@zhixing/terminal-ui/protocol';
import type { ConversationOutputSource } from '../runtime/conversation-output.js';
import { TerminalProcessProjection, type ProcessProjectionPorts, type ProcessScope } from './process-projection.js';

/** Retain finite display tails after a business waiter settles. Only the most
 * recent run owns the activity area; older tails may finish their cached blocks. */
export class TerminalProcessSession {
  readonly #scopes = new Map<string, { scope: ProcessScope; projection: TerminalProcessProjection }>();
  #generation = 0;
  #active?: string;
  #paused = false;
  constructor(readonly ports: Omit<ProcessProjectionPorts, 'changed'> & {
    currentConversation(): string | undefined;
    changed(status: TerminalProcessStatus | undefined): void;
  }) {}

  accept(value: SessionProcessProjection): void {
    if (value.source.conversationId !== this.ports.currentConversation()) return;
    const entry = this.#entry({ ...value.source, source: 'assignment' });
    if (!entry || entry.projection.closed) return;
    entry.projection.accept(value, this.#generation);
  }
  acceptYield(delta: AgentYield, source: ConversationOutputSource): void {
    if (source.kind !== 'delta' || source.conversationId !== this.ports.currentConversation()) return;
    const entry = this.#entry({ ...source, source: 'legacy' });
    if (entry && !entry.projection.closed) entry.projection.acceptYield(delta, source, this.#generation);
  }
  acceptEvent(event: SessionEventEnvelope): void {
    if (event.scope !== 'run' || event.conversationId !== this.ports.currentConversation()) return;
    // An assignment already owns its canonical event leg. Only an actual
    // legacy delta can create this legacy projection; never infer a second run.
    for (const entry of this.#scopes.values()) if (entry.scope.source === 'legacy' && entry.scope.turnId === event.runId) {
      entry.projection.acceptEvent(event, this.#generation); return;
    }
  }
  end(conversationId: string, turnId?: string, runId?: string): void {
    for (const entry of this.#scopes.values()) {
      if (entry.scope.source !== 'legacy' || entry.scope.conversationId !== conversationId ||
          !(runId && entry.scope.runId === runId || turnId && entry.scope.turnId === turnId)) continue;
      entry.projection.end(this.#generation);
    }
  }
  pause(reason: string): void {
    this.#paused = true;
    for (const entry of this.#scopes.values()) if (!entry.projection.closed) entry.projection.pause(reason);
  }
  resume(): void {
    this.#paused = false;
    for (const entry of this.#scopes.values()) if (!entry.projection.closed) entry.projection.resume(this.#generation);
  }
  reset(): void {
    this.#generation++;
    for (const entry of this.#scopes.values()) entry.projection.dispose();
    this.#scopes.clear(); this.#active = undefined; this.ports.changed(undefined);
  }
  #entry(source: Omit<ProcessScope, 'generation'>) {
    const key = JSON.stringify([source.conversationId, source.source, source.runId ?? source.turnId]);
    let entry = this.#scopes.get(key);
    if (entry) return entry;
    if (this.#scopes.size >= 8) {
      const closed = [...this.#scopes].find(([, value]) => value.projection.closed);
      if (closed) { closed[1].projection.dispose(); this.#scopes.delete(closed[0]); }
      else { this.ports.gap('待收束的过程展示超出容量，请刷新正文。'); return; }
    }
    const scope = { ...source, generation: this.#generation };
    const projection = new TerminalProcessProjection({ ...this.ports,
      changed: view => {
        if (this.#active === key && scope.generation === this.#generation && scope.conversationId === this.ports.currentConversation()) {
          this.ports.changed({ conversationId: scope.conversationId, runId: scope.runId, turnId: scope.turnId, view });
        }
      },
    });
    entry = { scope, projection }; this.#scopes.set(key, entry); this.#active = key;
    projection.begin(scope);
    if (this.#paused) projection.pause('过程展示已暂停；请先重试展示。');
    return entry;
  }
}
