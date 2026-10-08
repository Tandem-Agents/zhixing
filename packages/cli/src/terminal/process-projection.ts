import type { AgentYield } from '@zhixing/core/loop';
import { getTotalInputTokens, type SessionEventProjection } from '@zhixing/core/types';
import { validateSessionEventProjection } from '@zhixing/core/protocol';
import { boundedProcessValue, processText, projectSessionArtifact, validateSessionProcessProjection, type SessionProcessProjection, type SessionProcessSource } from '@zhixing/rpc/session-wire';
import type { SessionEventEnvelope } from '@zhixing/rpc/session-events';
import type { TerminalProcessView, ProcessChildView } from '@zhixing/terminal-ui/process-model';
import { getToolRenderStrategy, processArtifactText, processBatch, processToolInput, processToolSnapshot, processToolSummary, type ProcessBlock, type ProcessToolSnapshot } from './process-presentation.js';

export interface ProcessScope {
  readonly conversationId: string; readonly turnId?: string; readonly runId?: string;
  readonly generation: number; readonly source: 'legacy' | 'assignment'; readonly mainLineage?: string;
}
export interface ProcessProjectionPorts {
  readonly changed: (view: TerminalProcessView) => void;
  /** Synchronous enqueue into TerminalOutputProjection's existing finite queue. */
  readonly block: (block: ProcessBlock) => void;
  readonly gap: (reason: string) => void;
  readonly columns: () => number;
}
interface Child extends ProcessChildView { readonly lineage?: string; readonly toolUses?: number }
interface Tool { readonly name: string; readonly input: Record<string, unknown>; ended?: boolean }
/** Display-only fold over already authorized facts. One current scope, fixed
 * tables and short tails. No domain task state, transcript or artifact store. */
export class TerminalProcessProjection {
  #scope?: ProcessScope; #closed = false; #paused = false; #revision = 0; #block = 0;
  #phase = ''; #notice?: string; #thinking = ''; #thinkingActive = false; #thinkingSealed = true;
  readonly #seq = new Map<string, number>();
  readonly #tools = new Map<string, Tool>(); readonly #children = new Map<string, Child>();
  readonly #endedParents = new Set<string>(); readonly #sealedChildren = new Set<string>();
  readonly #summarizedChildren = new Set<string>();
  #batch: ProcessToolSnapshot[] = [];
  #usage: TerminalProcessView['usage'] = {};
  #published?: string;
  constructor(readonly ports: ProcessProjectionPorts) {}
  begin(scope: ProcessScope): void {
    this.#scope = { ...scope }; this.#closed = false; this.#paused = false; this.#block = 0;
    this.#phase = '正在准备'; this.#notice = undefined; this.#thinking = ''; this.#thinkingActive = false; this.#thinkingSealed = true; this.#published = undefined;
    this.#seq.clear(); this.#tools.clear(); this.#children.clear(); this.#endedParents.clear(); this.#sealedChildren.clear(); this.#summarizedChildren.clear(); this.#batch = []; this.#usage = {}; this.#publish();
  }
  #matches(source: Pick<SessionProcessSource, 'conversationId' | 'turnId' | 'runId'>, generation: number): boolean {
    const s = this.#scope;
    return !!s && !this.#closed && generation === s.generation && source.conversationId === s.conversationId &&
      (s.runId && source.runId ? s.runId === source.runId : !!s.turnId && s.turnId === source.turnId);
  }
  get closed(): boolean { return this.#closed; }
  accept(value: SessionProcessProjection, generation: number): void {
    if (this.#scope?.source !== 'assignment') return;
    try { validateSessionProcessProjection(value); } catch { this.pause('过程展示超出容量或不可读取'); return; }
    if (!this.#matches(value.source, generation)) return;
    const key = JSON.stringify([value.source.assignmentId, value.source.streamEpoch]);
    if (value.payload.kind === 'closed' || value.payload.kind === 'gap') {
      // These cite an existing canonical watermark, not another data frame.
      const previous = this.#seq.get(key);
      if (this.#seq.size && previous === undefined || previous !== undefined && value.source.sourceSeq < previous) return;
      if (value.payload.kind === 'closed') this.end(generation);
      else {
        // A canonical gap ends this observer stream; it does not prove that
        // the business run ended. Retire its display scope with the gap intact.
        this.pause(value.payload.reason); this.#closed = true;
      }
      return;
    }
    if (!this.#sequence(key, value.source.sourceSeq)) return;
    if (this.#paused && (value.payload.kind !== 'event' || !this.#isLifecycle(value.payload.event))) return;
    try {
      switch (value.payload.kind) {
        case 'yield': this.#yield(value.payload.delta, value.source, value.payload.artifact); break;
        case 'event': this.#event(value.payload.event, value.source); break;
      }
    } catch { this.pause('过程展示无法解析'); return; }
    this.#publish();
  }
  acceptYield(delta: AgentYield, source: Pick<SessionProcessSource, 'conversationId' | 'turnId' | 'runId'>, generation: number): void {
    if (this.#scope?.source !== 'legacy' || this.#paused || !this.#matches(source, generation)) return;
    try { this.#yield(delta, { ...source, sourceSeq: 0 }); }
    catch { this.pause('过程展示无法解析'); return; }
    this.#publish();
  }
  acceptEvent(envelope: SessionEventEnvelope, generation: number): void {
    if (this.#scope?.source !== 'legacy' || envelope.scope !== 'run') return;
    // Legacy forwarder documents runId as the actual turnContext.turnId.
    const source = { conversationId: envelope.conversationId, turnId: envelope.runId,
      sourceSeq: envelope.seq, lineage: envelope.meta.lineage };
    if (!this.#matches(source, generation)) return;
    if (envelope.lifecycle === 'closed') {
      if (Number.isSafeInteger(envelope.seq) && envelope.seq >= (this.#seq.get('legacy-events') ?? 0)) this.end(generation);
      return;
    }
    if (!this.#sequence('legacy-events', envelope.seq)) return;
    const event = { event: envelope.event, payload: envelope.payload } as SessionEventProjection;
    try { validateSessionEventProjection(event); boundedProcessValue(event, 64 * 1024); }
    catch { this.pause('过程事件不可显示'); return; }
    if (this.#paused && !this.#isLifecycle(event)) return;
    try { this.#event(event, source); } catch { this.pause('过程事件无法解析'); return; }
    this.#publish();
  }
  #isLifecycle(event: SessionEventProjection): boolean {
    return event.event === 'tool:child_start' || event.event === 'tool:child_end' || event.event === 'tool:call_end';
  }
  #sequence(key: string, seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq <= (this.#seq.get(key) ?? -1)) return false;
    if (!this.#seq.has(key) && this.#seq.size >= 32) { this.pause('过程来源超出容量'); return false; }
    this.#seq.set(key, seq); return true;
  }
  #main(lineage?: string): boolean { return lineage === undefined || lineage === (this.#scope?.mainLineage ?? 'main'); }
  #child(lineage?: string): Child | undefined {
    if (!lineage) return;
    let found: Child | undefined;
    for (const child of this.#children.values()) if (child.lineage && (lineage === child.lineage || lineage.startsWith(child.lineage + '/'))) {
      if (!found || child.lineage.length > (found.lineage?.length ?? 0)) found = child;
    }
    return found;
  }
  #yield(delta: AgentYield, source: SessionProcessSource, artifactInput?: unknown): void {
    if (!this.#main(source.lineage)) return;
    switch (delta.type) {
      case 'thinking_block_start': this.#flushBatch(); this.#sealThinking(); this.#thinking = ''; this.#thinkingSealed = false; this.#thinkingActive = true; this.#phase = '正在思考'; break;
      case 'thinking_delta': {
        this.#thinkingSealed = false; this.#thinkingActive = true;
        let tail = (this.#thinking + delta.thinking.slice(-8192)).slice(-8192);
        if (/^[\udc00-\udfff]/u.test(tail)) tail = tail.slice(1);
        this.#thinking = processText(tail, 32 * 1024); break;
      }
      case 'thinking_block_end': this.#sealThinking(); break;
      case 'text_delta': this.#sealThinking(); this.#flushBatch(); this.#flushSubtasks(); this.#phase = '正在回复'; break;
      case 'assistant_message': this.#sealThinking(); this.#flushBatch(); this.#flushSubtasks(); break;
      case 'tool_start': {
        this.#sealThinking(); this.#phase = '正在执行';
        const old = this.#tools.get(delta.id);
        if (!old && this.#tools.size >= 256) { this.pause('工具展示超出容量'); return; }
        if (!old?.ended) this.#tools.set(delta.id, { name: delta.name, input: processToolInput(delta.input) });
        break;
      }
      case 'tool_end': {
        const tool = this.#tools.get(delta.id);
        if (tool?.ended) return;
        if (!tool && this.#tools.size >= 256) { this.pause('工具展示超出容量'); return; }
        this.#tools.set(delta.id, { name: delta.name, input: tool?.input ?? {}, ended: true });
        const item = processToolSnapshot(delta, tool?.input ?? {}), strategy = getToolRenderStrategy(delta.name);
        const artifact = projectSessionArtifact(artifactInput ?? delta.result.presentation, delta.id);
        if (artifact) {
          this.#flushBatch();
          if (artifact.kind === 'sub-agent-result') {
            const child = this.#children.get(artifact.subAgentId);
            if (child && child.parentToolCallId !== delta.id) { this.pause('子任务结果身份不一致'); return; }
            if (!child && this.#children.size >= 16) { this.pause('子任务展示超出容量'); return; }
            this.#children.set(artifact.subAgentId, { ...(child ?? { id: artifact.subAgentId, parentToolCallId: delta.id, label: artifact.description }),
              status: artifact.status, durationMs: artifact.durationMs, toolUses: artifact.toolUses,
              inputTokens: child?.inputTokens ?? artifact.usage.inputTokens, outputTokens: child?.outputTokens ?? artifact.usage.outputTokens });
            if (artifact.status !== 'succeeded') {
              this.#sealedChildren.add(artifact.subAgentId);
              this.#emit('tool-error', processArtifactText(artifact), `artifact:${delta.id}`);
            }
          } else this.#emit('tool-diff', processArtifactText(artifact), `artifact:${delta.id}`);
        } else if (strategy === 'sub-agent-status' && [...this.#children.values()].some(c => c.parentToolCallId === delta.id)) {
          // Lifecycle-backed children already own their aggregate completion.
          // A missing optional artifact must not add a second successful Task card.
          if (delta.result.isError) {
            this.#flushBatch();
            const children = [...this.#children.values()].filter(c => c.parentToolCallId === delta.id);
            for (const child of children) this.#sealedChildren.add(child.id);
            this.#emit('tool-error', `${processToolSummary(item, true)}\n  子任务 ${children.map(c => `[${c.id}]`).join(' ')}`, `tool:${delta.id}`);
          }
        } else if (delta.result.isError || strategy !== 'default') {
          this.#flushBatch(); this.#emit(delta.result.isError ? 'tool-error' : strategy === 'side-effect' ? 'tool-action' : 'tool',
            processToolSummary(item, !!delta.result.isError, strategy === 'side-effect'), `tool:${delta.id}`);
        } else {
          this.#batch.push(item); if (this.#batch.length >= 32) this.#flushBatch();
        }
        break;
      }
      // turn_complete is a loop boundary, not the parent run's terminal fact.
      case 'turn_complete': this.#sealThinking(); this.#flushBatch(); this.#flushSubtasks(); break;
    }
  }
  #event(event: SessionEventProjection, source: SessionProcessSource): void {
    const main = this.#main(source.lineage), child = this.#child(source.lineage);
    switch (event.event) {
      case 'tool:child_start': {
        const p = event.payload, existing = this.#children.get(p.childAgentId);
        if (existing || this.#endedParents.has(p.parentToolCallId)) return;
        if (this.#children.size >= 16) { this.pause('子任务展示超出容量'); return; }
        this.#children.set(p.childAgentId, { id: p.childAgentId, parentToolCallId: p.parentToolCallId, lineage: p.childLineage,
          label: processText(p.label, 1024), status: 'running' }); break;
      }
      case 'tool:child_end': {
        const p = event.payload, found = this.#children.get(p.childAgentId);
        if (!found || found.parentToolCallId !== p.parentToolCallId || found.lineage !== p.childLineage || found.status !== 'running') return;
        this.#children.set(found.id, { ...found, status: p.status, durationMs: p.duration });
        // A paused display consumes finality, but never backfills missed body blocks.
        if (this.#paused) this.#summarizedChildren.add(found.id);
        break;
      }
      case 'tool:call_start':
        if (child?.status === 'running') this.#children.set(child.id, { ...child, latestTool: processText(event.payload.name, 256) });
        else if (main) this.#phase = `正在执行 ${processText(event.payload.name, 224)}`;
        break;
      case 'tool:call_end':
        if (main) {
          if (!this.#endedParents.has(event.payload.id) && this.#endedParents.size >= 256) { this.pause('工具展示超出容量'); return; }
          this.#endedParents.add(event.payload.id); this.#phase = event.payload.success ? '继续处理' : '工具未完成';
        }
        break;
      case 'llm:request_end': {
        const u = event.payload.usage, input = getTotalInputTokens(u);
        const inputTokens = (this.#usage.inputTokens ?? 0) + input, outputTokens = (this.#usage.outputTokens ?? 0) + u.outputTokens;
        if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) { this.pause('请求用量超出展示范围'); return; }
        this.#usage = { ...this.#usage, inputTokens, outputTokens,
          ...(main ? { cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens } : {}) };
        if (child) this.#children.set(child.id, { ...child, inputTokens: (child.inputTokens ?? 0) + input, outputTokens: (child.outputTokens ?? 0) + u.outputTokens });
        break;
      }
      case 'context:tokens_snapshot': if (main) this.#usage = { ...this.#usage, contextTokens: event.payload.totalTokens }; break;
      case 'llm:request_start': if (main) this.#phase = '正在请求模型'; break;
      case 'security:steward_review': {
        const p = event.payload;
        if (p.decision !== 'safe') break;
        this.#flushBatch();
        this.#emit('process', `◆ ${main ? '' : '子任务 · '}安全助理放行 ${processText(p.tool, 256)} ${processText(p.operation, 768)}（理由：${processText(p.reason, 1024)}）`);
        break;
      }
      case 'security:rule_sedimented': {
        const p = event.payload, scope = p.contextId.kind === 'main' ? '主模式' : '当前工作场景';
        this.#flushBatch();
        this.#emit('process', `◆ ${main ? '' : '子任务 · '}已在 ${scope} 记住 ${p.contributors.length} 次同类操作，自动建立放行规则：${processText(p.pattern.argument, 1024)}（进 /trust 可查看/撤销）`);
        break;
      }
      case 'retry:attempt': if (main) this.#notice = `请求重试 ${event.payload.attempt}/${event.payload.maxRetries} · ${event.payload.errorType}`; break;
      case 'retry:success': if (main) this.#notice = undefined; break;
      case 'retry:exhausted': if (main) this.#notice = `重试未成功：${processText(event.payload.lastError, 768)}`; break;
      case 'segment:transition_start': if (main) this.#phase = '正在整理上下文'; break;
      case 'segment:new_started': if (main) this.#notice = '上下文已整理'; break;
      case 'segment:transition_failed': if (main) this.#notice = `上下文整理未完成：${processText(event.payload.error, 768)}`; break;
      case 'segment:emergency_floor': if (main) this.#notice = `上下文已紧急截断 ${event.payload.droppedTurns} 轮：${processText(event.payload.error, 512)}`; break;
      case 'interrupt:warn': if (main) {
        const remaining = Math.max(0, Math.ceil((event.payload.timeoutMs - event.payload.elapsedMs) / 1000));
        this.#notice = `模型流暂未响应；若仍无响应，约 ${remaining} 秒后自动取消`;
      } break;
      case 'interrupt:fired': if (main) this.#notice = '正在停止'; break;
      case 'lifecycle:hook_failed': if (main) this.#notice = `运行钩子未完成：${processText(event.payload.error, 768)}`; break;
      case 'lifecycle:warning': if (main) this.#notice = processText(event.payload.message, 1024); break;
      // agent:run_end may be a nested child; explicit parent closure owns end().
      default: break;
    }
  }
  #sealThinking(): void {
    if (this.#thinkingSealed) return;
    this.#thinkingActive = false; this.#thinkingSealed = true;
    // Keep only this bounded display tail; U chooses its last two rows on every resize.
    if (this.#thinking) this.#emit('thinking', this.#thinking);
  }
  #flushBatch(): void { if (this.#batch.length) { this.#emit('tool', processBatch(this.#batch)); this.#batch = []; } }
  #flushSubtasks(): void {
    const children = [...this.#children.values()].filter(c => c.status !== 'running' && !this.#summarizedChildren.has(c.id));
    if (!children.length) return;
    const count = (status: Child['status']) => children.filter(c => c.status === status).length;
    const known = children.filter(c => c.inputTokens !== undefined && c.outputTokens !== undefined);
    const tokens = known.length ? known.reduce((sum, c) => sum + c.inputTokens! + c.outputTokens!, 0) : undefined;
    if (tokens !== undefined && !Number.isFinite(tokens)) { this.pause('子任务用量超出展示范围'); return; }
    this.#emit('process', `◆ ${children.length} 个子任务 · ${count('succeeded')} 成功 ${count('failed')} 失败 ${count('aborted')} 中止` +
      (tokens === undefined ? ' · 用量未提供' : ` · ${tokens} token${known.length < children.length ? '（部分）' : ''}`));
    for (const child of children) {
      this.#summarizedChildren.add(child.id);
      if (child.status !== 'succeeded' && !this.#sealedChildren.has(child.id)) {
        this.#sealedChildren.add(child.id);
        this.#emit('tool-error', `◆ 子任务${child.status === 'failed' ? '失败' : '已停止'} · [${child.id}] · ${child.label}`, `child:${child.id}`);
      }
    }
  }
  #emit(role: ProcessBlock['role'], text: string, id?: string): void {
    if (!this.#scope || this.#paused) return;
    const scope = this.#scope;
    try { this.ports.block({ blockId: `process:${JSON.stringify([scope.conversationId, scope.runId ?? scope.turnId, scope.generation, id ?? this.#block++])}`, role, text }); }
    catch { this.pause('过程展示写入失败'); }
  }
  #publish(): void {
    try {
      const view = this.snapshot(), { revision: _revision, ...visible } = view;
      // Text deltas often leave the activity area unchanged. Its own animation
      // clock keeps running; unchanged content needs no extra IPC/render pass.
      const encoded = JSON.stringify(visible);
      if (encoded === this.#published) return;
      this.ports.changed(view); this.#published = encoded;
    } catch { if (!this.#paused) this.pause('过程显示暂不可用'); }
  }
  snapshot(): TerminalProcessView {
    return { revision: ++this.#revision, phase: this.#phase,
      ...(this.#thinking ? { thinking: { text: this.#thinking, active: this.#thinkingActive } } : {}),
      tools: this.#batch.slice(-3).map(e => processText(processToolSummary(e), 1024)), children: [...this.#children.values()].map(({ lineage: _lineage, toolUses: _toolUses, ...child }) => child),
      usage: { ...this.#usage }, ...(this.#notice ? { notice: this.#notice } : {}) };
  }
  pause(reason = '过程展示已暂停'): void {
    if (this.#paused || this.#closed) return;
    this.#paused = true; this.#batch = []; this.#thinking = ''; this.#tools.clear();
    for (const child of this.#children.values()) if (child.status !== 'running') this.#summarizedChildren.add(child.id);
    this.#notice = processText(reason, 1024); this.#publish();
    try { this.ports.gap(this.#notice); } catch { /* The parent lifecycle handles transport closure. */ }
  }
  end(generation: number): void {
    if (this.#closed || generation !== this.#scope?.generation) return;
    this.#sealThinking(); this.#flushBatch(); this.#flushSubtasks(); this.#closed = true; this.#phase = '本轮已结束';
    if (this.#notice) this.#notice = processText(`${this.#phase}；${this.#notice}`, 1024);
    this.#tools.clear(); this.#seq.clear(); this.#publish();
  }
  /** Re-enable only this live scope; the Server profile watermark excludes old artifacts. */
  resume(generation: number): void {
    if (this.#closed || generation !== this.#scope?.generation || !this.#paused) return;
    this.#paused = false; this.#notice = '过程显示已恢复；暂停期间的内容请查历史与用量'; this.#publish();
  }
  dispose(): void { this.#closed = true; this.#scope = undefined; this.#seq.clear(); this.#tools.clear(); this.#children.clear(); this.#endedParents.clear(); this.#sealedChildren.clear(); this.#summarizedChildren.clear(); this.#batch = []; this.#thinking = ''; }
}
