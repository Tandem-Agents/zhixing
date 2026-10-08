import { describe, expect, it, vi } from 'vitest';
import { PERSPECTIVES_CONVERGENCE_NODE_ID, PERSPECTIVES_DELIBERATION_DEFINITION_ID } from '@zhixing/core/conversation/application';
import { createTextRunFeedback } from '../text-run-feedback.js';
import { makeFakeHostLink } from './fake-host-link.js';

function fixture() {
  const host = makeFakeHostLink(), line = vi.fn();
  const watched = new Set(['c']);
  const feedback = createTextRunFeedback({ link: host.link, watching: id => watched.has(id), line });
  const process = (seq: number, payload: unknown, conversationId = 'c') => host.notify('session.process', {
    version: 1, source: { conversationId, turnId: 't', runId: 'r', assignmentId: 'a', streamEpoch: 1, sourceSeq: seq, lineage: 'main' }, payload,
  });
  const event = (seq: number, name: string, payload: unknown, conversationId = 'c') => host.notify('session.event', {
    conversationId, scope: 'run', runId: 'host-turn', seq, event: name, payload, meta: { lineage: 'main' },
  });
  return { host, line, watched, feedback, process, event, text: () => line.mock.calls.map(([text]) => text) };
}
const safe = { event: 'security:steward_review', payload: { decision: 'safe', confidence: 1, operation: '读取文件', tool: 'read', reason: '已请求' } };
const common = { runId: 'orchestration', definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID };

describe('text run feedback binding', () => {
  it('renders canonical audits exactly once and ignores legacy duplicates, yields and tools', () => {
    const t = fixture();
    t.event(1, safe.event, safe.payload);
    t.process(1, { kind: 'event', event: safe }); t.process(1, { kind: 'event', event: safe });
    t.process(2, { kind: 'yield', delta: { type: 'text_delta', text: 'body belongs to controller' } });
    t.process(3, { kind: 'yield', delta: { type: 'thinking_delta', thinking: 'private thinking' } });
    t.process(4, { kind: 'event', event: { event: 'tool:call_start', payload: { id: 'tool', name: 'read' } } });
    t.process(5, { kind: 'event', event: { ...safe, payload: { ...safe.payload, decision: 'needs-confirm' } } });
    t.process(5, { kind: 'closed' });
    t.process(6, { kind: 'event', event: safe });
    expect(t.text()).toEqual(['◆ 安全助理放行 read 读取文件（理由：已请求）']);
    expect(t.host.requests).toEqual([]);
    t.feedback.dispose(); t.feedback.dispose();
    expect(t.host.handlerCount('session.process')).toBe(0); expect(t.host.handlerCount('session.event')).toBe(0);
    t.process(7, { kind: 'event', event: safe }); expect(t.line).toHaveBeenCalledOnce();
  });
  it('keeps Host event-only perspectives before any yield and preserves every existing phase', () => {
    const t = fixture();
    t.event(0, 'orchestration:run_start', { ...common, nodeCount: 3, maxParallel: 2 });
    t.event(0, 'orchestration:run_start', { ...common, nodeCount: 3, maxParallel: 2 });
    t.event(1, 'orchestration:node_start', { ...common, nodeId: 'cross-one', nodeKind: 'agent' });
    t.event(2, 'orchestration:node_start', { ...common, nodeId: 'cross-two', nodeKind: 'agent' });
    t.event(3, 'orchestration:node_start', { ...common, nodeId: PERSPECTIVES_CONVERGENCE_NODE_ID, nodeKind: 'agent' });
    t.event(4, 'orchestration:run_end', { ...common, status: 'failed', durationMs: 2, error: '执行失败' });
    expect(t.text()).toEqual(['◆ 多视角评议：3 个节点开始协作', '◆ 交叉吸收中', '◆ 收敛最终版本中', '◆ 多视角评议未完成：执行失败']);
    t.feedback.dispose();
  });
  it('retains the canonical automatic trust rule notice without subscribing to legacy audit duplicates', () => {
    const t = fixture();
    const rule = { event: 'security:rule_sedimented', payload: { tool: 'bash', operation: 'run',
      pattern: { tool: 'bash', argument: 'git status' }, scope: 'context', contextId: { kind: 'main' },
      ruleId: 'rule', contributors: [{ origin: 'user', timestamp: 1 }] } };
    t.event(1, rule.event, rule.payload); t.process(1, { kind: 'event', event: rule });
    expect(t.text()).toEqual(['◆ 已在 主模式 记住 1 次同类操作，自动建立放行规则：git status（进 /trust 可查看/撤销）']);
    t.feedback.dispose();
  });
  it('isolates current/pending conversations, filters unwatched sources and drops disposed subscriptions', () => {
    const t = fixture(); t.watched.add('pending');
    const start = { ...common, nodeCount: 2, maxParallel: 1 };
    t.event(0, 'orchestration:run_start', start); t.event(0, 'orchestration:run_start', start, 'pending');
    t.process(1, { kind: 'event', event: safe }, 'outside');
    expect(t.line).toHaveBeenCalledTimes(2);
    t.watched.delete('c');
    t.event(1, 'orchestration:node_start', { ...common, nodeId: 'cross-one', nodeKind: 'agent' });
    t.event(1, 'orchestration:node_start', { ...common, nodeId: 'cross-one', nodeKind: 'agent' }, 'pending');
    expect(t.text().at(-1)).toBe('◆ 交叉吸收中'); expect(t.line).toHaveBeenCalledTimes(3);
    t.feedback.dispose();
  });
  it('reports canonical gaps as display limitations and never replays body to repair them', () => {
    const t = fixture(); t.process(1, { kind: 'event', event: safe });
    t.process(1, { kind: 'gap', reason: 'feedback-gap' });
    t.process(2, { kind: 'event', event: safe });
    expect(t.text()).toEqual(['◆ 安全助理放行 read 读取文件（理由：已请求）', 'feedback-gap']);
    expect(() => t.host.notify('session.process', { version: 1, source: null })).not.toThrow();
    expect(t.text().at(-1)).toContain('过程反馈不可读取');
    t.feedback.dispose();
  });
});
