import { PERSPECTIVES_CONVERGENCE_NODE_ID, PERSPECTIVES_DELIBERATION_DEFINITION_ID } from '@zhixing/core/conversation/application';
import { validateSessionEventProjection } from '@zhixing/core/protocol';
import type { SessionEventProjection } from '@zhixing/core/types';
import { boundedProcessValue, processText } from '@zhixing/rpc/session-wire';
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
  readonly #perspectives = new Map<string, { seq: number; runId: string; cross: boolean; convergence: boolean; started: boolean }>();
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
    if (this.#acceptPerspective(event)) return;
    // An assignment already owns its canonical event leg. Only an actual
    // legacy delta can create this legacy projection; never infer a second run.
    for (const entry of this.#scopes.values()) if (entry.scope.source === 'legacy' && entry.scope.turnId === event.runId) {
      entry.projection.acceptEvent(event, this.#generation); return;
    }
  }
  /** Perspectives is a Host-owned event-only bus, independent of assignment
   * process frames. Publish finite notices without inventing a second run or
   * letting its close frame end the canonical parent projection. */
  #acceptPerspective(event: SessionEventEnvelope): boolean {
    if (event.lifecycle === 'closed') { this.#perspectives.delete(event.runId); return false; }
    if (!['orchestration:run_start', 'orchestration:node_start', 'orchestration:run_end'].includes(event.event)) return false;
    try {
      if (!event.runId || event.runId.length > 1024 || !Number.isSafeInteger(event.seq) || event.seq < 0) throw Error('perspective-source');
      const value = { event: event.event, payload: event.payload } as SessionEventProjection;
      validateSessionEventProjection(value); boundedProcessValue(value, 64 * 1024);
      if (value.event !== 'orchestration:run_start' && value.event !== 'orchestration:node_start' && value.event !== 'orchestration:run_end') return true;
      const p = value.payload;
      if (p.definitionId !== PERSPECTIVES_DELIBERATION_DEFINITION_ID) return true;
      let state = this.#perspectives.get(event.runId);
      if (state && event.seq <= state.seq) return true;
      if (!state) {
        if (value.event !== 'orchestration:run_start') return true;
        if (this.#perspectives.size >= 8) throw Error('perspective-capacity');
        state = { seq: -1, runId: p.runId, cross: false, convergence: false, started: false };
        this.#perspectives.set(event.runId, state);
      }
      state.seq = event.seq;
      if (state.runId !== p.runId) return true;
      let text: string | undefined;
      if (value.event === 'orchestration:run_start' && !state.started) {
        state.started = true; text = `多视角评议：${value.payload.nodeCount} 个节点开始协作`;
      } else if (value.event === 'orchestration:node_start') {
        if (value.payload.nodeId.startsWith('cross-') && !state.cross) { state.cross = true; text = '交叉吸收中'; }
        else if (value.payload.nodeId === PERSPECTIVES_CONVERGENCE_NODE_ID && !state.convergence) { state.convergence = true; text = '收敛最终版本中'; }
      } else if (value.event === 'orchestration:run_end' && value.payload.status !== 'completed') {
        text = `多视角评议未完成：${processText(value.payload.error ?? value.payload.status, 1024)}`;
      }
      if (text && !this.#paused) this.ports.block({ blockId: `event-notice:${JSON.stringify([event.conversationId, event.runId, this.#generation, event.seq])}`, role: 'process', text: `◆ ${text}` });
    } catch { this.ports.gap('多视角进度暂不可显示，请核对最终结果。'); }
    return true;
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
    this.#generation++; this.#perspectives.clear();
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
