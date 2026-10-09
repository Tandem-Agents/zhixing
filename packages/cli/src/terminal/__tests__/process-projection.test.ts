import { describe, expect, it, vi } from 'vitest';
import type { SessionEventProjection } from '@zhixing/core/types';
import type { AgentYield } from '@zhixing/core/loop';
import { TerminalProcessProjection } from '../process-projection.js';
import { processArtifactText } from '../process-presentation.js';
function setup(source: 'legacy' | 'assignment' = 'legacy') {
  const block = vi.fn(), changed = vi.fn(), gap = vi.fn();
  const p = new TerminalProcessProjection({ block, changed, gap, columns: () => 40 });
  p.begin({ conversationId: 'c', turnId: 't', runId: 'r', generation: 1, source });
  let seq = 0;
  const event = (event: SessionEventProjection, lineage = 'main', sequence = seq++) => p.acceptEvent({ conversationId: 'c',
    runId: 't', seq: sequence, scope: 'run', event: event.event, payload: event.payload, meta: { lineage } }, 1);
  const yieldValue = (value: AgentYield) => p.acceptYield(value, { conversationId: 'c', turnId: 't', runId: 'r' }, 1);
  return { p, block, changed, gap, event, yieldValue };
}
const child = { parentToolCallId: 'task', childLineage: 'main/sub-child', childAgentId: 'child' };
const request = (inputTokens: number, extra = {}) => ({ event: 'llm:request_end' as const,
  payload: { model: 'model', duration: 1, usage: { inputTokens, outputTokens: 2, ...extra }, stopReason: 'end_turn' as const } });
describe('terminal process fold', () => {
  it('explains watchdog auto-cancellation without inventing a keyboard action', () => {
    const s = setup();
    s.event({ event: 'interrupt:warn', payload: { kind: 'idle-timeout-warn', elapsedMs: 8001, timeoutMs: 10000, chunksReceived: 0 } });
    expect(s.p.snapshot().notice).toBe('模型流暂未响应；若仍无响应，约 2 秒后自动取消');
    expect(s.p.snapshot().notice).not.toContain('再次取消');
  });
  it('publishes changed activity and real termination without resending it for every text delta', () => {
    const s = setup(); s.changed.mockClear();
    for (let i = 0; i < 100; i++) s.yieldValue({ type: 'text_delta', text: `part-${i}` });
    expect(s.changed).toHaveBeenCalledOnce();
    expect(s.changed.mock.calls[0]![0].phase).toBe('正在回复');
    s.event(request(5)); expect(s.changed).toHaveBeenCalledTimes(2);
    s.p.end(1, true); expect(s.changed).toHaveBeenCalledTimes(3);
    expect(s.changed.mock.calls.at(-1)![0].phase).toBe('本轮已结束');
    s.p.begin({ conversationId: 'c', turnId: 't2', runId: 'r2', generation: 1, source: 'legacy' });
    expect(s.changed).toHaveBeenCalledTimes(4);
  });
  it('keeps only a finite thinking tail, seals once, and leaves resize to the pure U adapter', () => {
    const s = setup(); s.yieldValue({ type: 'thinking_block_start' });
    s.yieldValue({ type: 'thinking_delta', thinking: '汉字🦞'.repeat(10000) + '最新尾部' });
    expect(s.p.snapshot().thinking!.text.length).toBeLessThanOrEqual(8192);
    expect(s.p.snapshot().thinking!.text.endsWith('最新尾部')).toBe(true);
    s.yieldValue({ type: 'thinking_block_end' }); s.yieldValue({ type: 'thinking_block_end' });
    expect(s.block).toHaveBeenCalledOnce(); expect(s.block.mock.calls[0]![0]).toMatchObject({ role: 'thinking' });
    expect(s.p.snapshot().thinking!.active).toBe(false);
  });
  it('adds request actuals once, uses canonical input, clears missing recent main cache, and separates context estimates', () => {
    const s = setup();
    s.event(request(2, { totalInputTokens: 10, cacheReadTokens: 8 }), 'main', 1);
    s.event(request(2, { totalInputTokens: 10, cacheReadTokens: 8 }), 'main', 1);
    s.event({ event: 'tool:child_start', payload: { ...child, label: '检查' } }, 'main', 2);
    s.event(request(5), child.childLineage, 3);
    s.event({ event: 'context:tokens_snapshot', payload: { totalTokens: 900, turnCount: 1 } }, 'main', 4);
    expect(s.p.snapshot().usage).toEqual({ inputTokens: 15, outputTokens: 4, cacheReadTokens: 8, cacheWriteTokens: undefined, contextTokens: 900 });
    s.event(request(3), 'main', 5);
    expect(s.p.snapshot().usage).toMatchObject({ inputTokens: 18, outputTokens: 6, contextTokens: 900 });
    expect(s.p.snapshot().usage.cacheReadTokens).toBeUndefined();
  });
  it('keeps real child identity, ignores wrong/duplicate terminal facts, and never closes parent on child end', () => {
    const s = setup();
    s.event({ event: 'tool:child_start', payload: { ...child, label: '检查' } });
    s.event({ event: 'tool:call_start', payload: { id: 'inner', name: 'read' } }, child.childLineage);
    s.event({ event: 'tool:child_end', payload: { ...child, parentToolCallId: 'other', status: 'failed', duration: 1 } });
    expect(s.p.snapshot().children[0]?.status).toBe('running');
    s.event({ event: 'tool:child_end', payload: { ...child, status: 'aborted', duration: 4 } });
    s.event({ event: 'tool:child_end', payload: { ...child, status: 'succeeded', duration: 9 } });
    expect(s.p.snapshot().children[0]).toMatchObject({ id: 'child', parentToolCallId: 'task', status: 'aborted', latestTool: 'read', durationMs: 4 });
    s.yieldValue({ type: 'text_delta', text: 'parent continues' });
    expect(s.p.snapshot().phase).toBe('正在回复');
    expect(s.block).toHaveBeenCalledTimes(2);
    s.p.end(1); expect(s.block).toHaveBeenCalledTimes(2);
  });
  it('does not add child result artifact usage again or render a second final card', () => {
    const s = setup();
    s.event({ event: 'tool:child_start', payload: { ...child, label: '检查' } });
    s.event(request(7), child.childLineage);
    s.event({ event: 'tool:child_end', payload: { ...child, status: 'failed', duration: 4 } });
    const value: AgentYield = { type: 'tool_end', id: 'task', name: 'Task', duration: 4, result: { content: 'failure', isError: true,
      presentation: { kind: 'sub-agent-result', toolCallId: 'task', subAgentId: 'child', description: '检查', status: 'failed', durationMs: 4,
        toolUses: 1, usage: { inputTokens: 7, outputTokens: 2 }, diagnostics: ['真实失败原因'] } } };
    s.yieldValue(value); s.yieldValue(value); s.p.end(1);
    expect(s.p.snapshot().usage.inputTokens).toBe(7);
    expect(s.block).toHaveBeenCalledTimes(2); expect(s.block.mock.calls[0]![0].text).toContain('真实失败原因');
    expect(s.block.mock.calls[1]![0].text).toContain('1 个子任务');
  });
  it('uses one lifecycle aggregate when the observer receives no optional Task artifact', () => {
    const s = setup();
    s.event({ event: 'tool:child_start', payload: { ...child, label: '检查' } });
    s.event({ event: 'tool:child_end', payload: { ...child, status: 'succeeded', duration: 4 } });
    s.yieldValue({ type: 'tool_end', id: 'task', name: 'Task', duration: 4, result: { content: 'done' } });
    s.p.end(1);
    expect(s.block).toHaveBeenCalledOnce();
    expect(s.block.mock.calls[0]![0].text).toContain('1 个子任务');
    expect(s.block.mock.calls[0]![0].text).toContain('用量未提供');
  });
  it('batches exploration, preserves side effects and failures, and marks clipped result summaries', () => {
    const s = setup();
    for (let i = 0; i < 4; i++) {
      s.yieldValue({ type: 'tool_start', id: 'read' + i, name: 'read', input: { path: 'a.ts' } });
      s.yieldValue({ type: 'tool_end', id: 'read' + i, name: 'read', duration: 1, result: { content: 'long\n'.repeat(5000) } });
    }
    expect(s.block).not.toHaveBeenCalled();
    s.yieldValue({ type: 'tool_end', id: 'write', name: 'write', duration: 2, result: { content: 'ok' } });
    s.yieldValue({ type: 'tool_end', id: 'fail', name: 'read', duration: 2, result: { content: 'permission denied', isError: true } });
    expect(s.block.mock.calls.map(c => c[0].text).join('\n')).toContain('阅读了 4 个文件');
    expect(s.block.mock.calls[0]![0].text).toContain('结果片段');
    expect(s.block.mock.calls[1]![0]).toMatchObject({ role: 'tool-action' });
    expect(s.block.mock.calls.every(c => c[0].text.startsWith('◆'))).toBe(true);
    expect(s.block.mock.calls[2]![0].text).toContain('permission denied');
  });
  it('accepts intentionally filtered assignment sequence gaps but ignores repeats and the other source leg', () => {
    const s = setup('assignment');
    s.event(request(999));
    const source = { conversationId: 'c', runId: 'r', assignmentId: 'assignment', streamEpoch: 1, sourceSeq: 10, lineage: 'main' };
    const dto = { version: 1 as const, source, payload: { kind: 'event' as const, event: request(3) } };
    s.p.accept(dto, 1); s.p.accept(dto, 1);
    s.p.accept({ ...dto, source: { ...source, sourceSeq: 20 } }, 1);
    expect(s.p.snapshot().usage.inputTokens).toBe(6); expect(s.gap).not.toHaveBeenCalled();
  });
  it.each(['closed', 'gap'] as const)('accepts one same-source %s at the last real payload sequence', kind => {
    const s = setup('assignment');
    const source = { conversationId: 'c', runId: 'r', assignmentId: 'assignment', streamEpoch: 1, sourceSeq: 3 };
    s.p.accept({ version: 1, source, payload: { kind: 'event', event: request(4) } }, 1);
    const dto = { version: 1 as const, source, payload: kind === 'closed' ? { kind } : { kind, reason: '尾部不可读取' } };
    s.p.accept(dto, 1); s.p.accept(dto, 1);
    if (kind === 'closed') {
      expect(s.p.snapshot().activity).toBe('reconciling'); expect(s.gap).not.toHaveBeenCalled();
      s.p.end(1, true); expect(s.p.snapshot().activity).toBe('complete');
    }
    else expect(s.gap).toHaveBeenCalledOnce();
    expect(s.p.snapshot().usage.inputTokens).toBe(4);
  });
  it('rejects late scope/generation events, keeps parent open until explicit close and does not restart a closed scope', () => {
    const s = setup();
    s.p.acceptYield({ type: 'text_delta', text: 'other' }, { conversationId: 'other', turnId: 't' }, 1);
    s.p.acceptYield({ type: 'text_delta', text: 'late' }, { conversationId: 'c', turnId: 't' }, 0);
    expect(s.p.snapshot().phase).toBe('正在准备');
    s.p.end(1); s.yieldValue({ type: 'text_delta', text: 'late' }); s.p.resume(1);
    expect(s.p.snapshot().activity).toBe('reconciling');
    s.p.end(1, true); expect(s.p.snapshot().activity).toBe('complete');
  });
  it('pauses once on capacity, retains finite child finality, and contains display callback failure', () => {
    const s = setup();
    for (let i = 0; i < 17; i++) s.event({ event: 'tool:child_start', payload: { ...child, childAgentId: 'c' + i, childLineage: 'main/sub-' + i, label: 'child' } });
    expect(s.gap).toHaveBeenCalledOnce(); expect(s.p.snapshot().children).toHaveLength(16);
    s.event({ event: 'tool:child_end', payload: { ...child, childAgentId: 'c0', childLineage: 'main/sub-0', status: 'failed', duration: 4 } });
    expect(s.p.snapshot().children[0]).toMatchObject({ id: 'c0', status: 'failed' });
    expect(s.block).not.toHaveBeenCalled();
    s.p.resume(0); expect(s.p.snapshot().notice).toContain('超出容量');
    s.p.resume(1); expect(s.p.snapshot().notice).toContain('已恢复');
    const broken = new TerminalProcessProjection({ changed: () => { throw Error('closed'); }, block: () => {}, gap: () => {}, columns: () => 40 });
    expect(() => broken.begin({ conversationId: 'c', turnId: 't', generation: 1, source: 'legacy' })).not.toThrow();
  });
  it('retains unavailable diff counts and final diagnostics in the cache text', () => {
    const text = processArtifactText({ kind: 'file-diff', path: 'a.ts', operation: 'modified', changeStats: { kind: 'unavailable', reason: 'input-too-large' }, hunks: [], truncated: true });
    expect(text).toContain('增删行数不可用'); expect(text).toContain('已截断'); expect(text).not.toContain('+0');
  });
});
