import { describe, expect, it, vi } from 'vitest';
import { PERSPECTIVES_DELIBERATION_DEFINITION_ID, PERSPECTIVES_CONVERGENCE_NODE_ID } from '@zhixing/core/conversation/application';
import { TerminalProcessSession } from '../process-session.js';

function setup() {
  const block = vi.fn(), changed = vi.fn(), gap = vi.fn();
  const session = new TerminalProcessSession({ currentConversation: () => 'c', block, changed, gap, columns: () => 40 });
  return { session, block, changed, gap };
}
describe('terminal existing run feedback', () => {
  it('shows canonical safe audits once and keeps needs-confirm on its own surface', () => {
    const s = setup();
    const send = (seq: number, decision: 'safe' | 'needs-confirm') => s.session.accept({
      version: 1, source: { conversationId: 'c', turnId: 't', runId: 'r', assignmentId: 'a', streamEpoch: 1, sourceSeq: seq, lineage: 'main' },
      payload: { kind: 'event', event: { event: 'security:steward_review', payload: { confidence: 1, decision, operation: '读取文件', tool: 'read', reason: '用户已明确请求' } } },
    });
    send(1, 'safe'); send(1, 'safe'); send(2, 'needs-confirm');
    expect(s.block).toHaveBeenCalledOnce();
    expect(s.block.mock.calls[0]![0]).toMatchObject({ role: 'process', text: expect.stringContaining('安全助理放行') });
    expect(s.gap).not.toHaveBeenCalled();
  });
  it('shows Host event-only perspectives before any yield without starting a second process run', () => {
    const s = setup();
    const send = (seq: number, event: string, payload: object) => s.session.acceptEvent({ conversationId: 'c', scope: 'run', runId: 't', seq, event, payload, meta: { lineage: 'main' } });
    const common = { runId: 'orchestration', definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID };
    send(0, 'orchestration:run_start', { ...common, nodeCount: 3, maxParallel: 2 });
    send(0, 'orchestration:run_start', { ...common, nodeCount: 3, maxParallel: 2 });
    send(1, 'orchestration:node_start', { ...common, nodeId: 'cross-one', nodeKind: 'agent' });
    send(2, 'orchestration:node_start', { ...common, nodeId: 'cross-two', nodeKind: 'agent' });
    send(3, 'orchestration:node_start', { ...common, nodeId: PERSPECTIVES_CONVERGENCE_NODE_ID, nodeKind: 'agent' });
    send(4, 'orchestration:run_end', { ...common, status: 'failed', durationMs: 5, error: '执行失败' });
    expect(s.block.mock.calls.map(args => args[0].text)).toEqual([
      '◆ 多视角评议：3 个节点开始协作', '◆ 交叉吸收中', '◆ 收敛最终版本中', '◆ 多视角评议未完成：执行失败',
    ]);
    expect(s.changed).not.toHaveBeenCalled();
    expect(s.gap).not.toHaveBeenCalled();
    s.session.acceptEvent({ conversationId: 'c', scope: 'run', runId: 't', seq: 5, lifecycle: 'closed', event: 'run:closed', payload: null, meta: {} });
    send(6, 'orchestration:node_start', { ...common, nodeId: 'cross-three', nodeKind: 'agent' });
    expect(s.block).toHaveBeenCalledTimes(4);
  });
});
