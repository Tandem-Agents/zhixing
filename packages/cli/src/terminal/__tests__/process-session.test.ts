import { describe, expect, it, vi } from 'vitest';
import { projectProcessYield, type SessionProcessProjection } from '@zhixing/rpc/session-wire';
import { processViewRows } from '@zhixing/terminal-ui/process-model';
import { TerminalProcessSession } from '../process-session.js';

function fixture() {
  let conversationId = 'conversation';
  const changed = vi.fn(), block = vi.fn(), gap = vi.fn();
  const session = new TerminalProcessSession({ currentConversation: () => conversationId, changed, block, gap, columns: () => 80 });
  const emit = (runId: string, sourceSeq: number, payload: SessionProcessProjection['payload']) => session.accept({
    version: 1, source: { conversationId: 'conversation', runId, assignmentId: `assignment-${runId}`, streamEpoch: 1, sourceSeq }, payload,
  });
  return { session, changed, block, gap, emit, switchConversation: () => { conversationId = 'next'; session.reset(); } };
}

describe('terminal process session ownership', () => {
  it('consumes same-watermark closure during pause and keeps finality and the gap visible after resume', () => {
    const f = fixture();
    f.emit('run', 1, { kind: 'yield', delta: { type: 'thinking_delta', thinking: 'old thought' } });
    f.session.pause('容量不足，正文存在缺口');
    const missed = projectProcessYield({ conversationId: 'conversation', runId: 'run', assignmentId: 'assignment-run',
      streamEpoch: 1, sourceSeq: 2 }, { type: 'tool_end', id: 'edit', name: 'edit', duration: 1,
      result: { content: 'saved', presentation: { kind: 'file-diff', path: 'file.ts', operation: 'modified',
        changeStats: { kind: 'exact', addedLines: 1, removedLines: 0 },
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
          lines: [{ type: 'added', newLineNumber: 1, content: 'missed artifact' }] }] } } });
    f.session.accept(missed);
    f.emit('run', 2, { kind: 'closed' });
    const view = f.changed.mock.calls.at(-1)![0].view;
    expect(view.phase).toBe('本轮已结束');
    expect(processViewRows(view, 80, 4)[0]!.text).toContain('本轮已结束');
    expect(view.notice).toContain('正文存在缺口');
    const count = f.changed.mock.calls.length;
    f.session.resume(); f.emit('run', 2, { kind: 'closed' }); f.session.accept(missed);
    expect(f.changed).toHaveBeenCalledTimes(count);
    expect(f.block).not.toHaveBeenCalled(); expect(f.gap).toHaveBeenCalledOnce();
  });

  it('retains child terminal facts while paused without replaying their missed body after recovery', () => {
    const f = fixture(), child = { parentToolCallId: 'task', childLineage: 'main/sub-child', childAgentId: 'child' };
    f.emit('run', 1, { kind: 'event', event: { event: 'tool:child_start', payload: { ...child, label: '检查' } } });
    f.session.pause('正文缺口');
    f.emit('run', 2, { kind: 'event', event: { event: 'tool:child_end', payload: { ...child, status: 'failed', duration: 4 } } });
    expect(f.changed.mock.calls.at(-1)![0].view.children).toMatchObject([{ id: 'child', status: 'failed' }]);
    f.session.resume();
    f.emit('run', 3, { kind: 'yield', delta: { type: 'text_delta', text: 'fresh answer' } });
    f.emit('run', 3, { kind: 'closed' });
    expect(f.changed.mock.calls.at(-1)![0].view.phase).toBe('本轮已结束');
    expect(f.block).not.toHaveBeenCalled();
  });

  it('ignores a stale terminal and retires canonical gaps without inventing business finality', () => {
    const f = fixture();
    f.emit('run', 5, { kind: 'yield', delta: { type: 'thinking_delta', thinking: 'current thought' } });
    f.emit('run', 4, { kind: 'closed' });
    f.emit('run', 6, { kind: 'yield', delta: { type: 'text_delta', text: 'answer' } });
    expect(f.changed.mock.calls.at(-1)![0].view.phase).toBe('正在回复');
    f.emit('run', 6, { kind: 'gap', reason: '过程缺口' });
    f.emit('run', 6, { kind: 'closed' });
    expect(f.changed.mock.calls.at(-1)![0].view.phase).not.toBe('本轮已结束');
    expect(f.changed.mock.calls.at(-1)![0].view.notice).toContain('过程缺口');
    for (let i = 0; i < 9; i++) f.emit(`gap-${i}`, 1, { kind: 'gap', reason: '过程缺口' });
    f.emit('fresh', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'new answer' } });
    expect(f.changed.mock.calls.at(-1)![0].runId).toBe('fresh');
    expect(f.gap.mock.calls.every(([reason]) => reason === '过程缺口')).toBe(true);
  });

  it('also settles a paused legacy scope at its existing event watermark', () => {
    const f = fixture();
    const delta = { type: 'thinking_delta' as const, thinking: 'old legacy thought' };
    f.session.acceptYield(delta, { kind: 'delta', conversationId: 'conversation', turnId: 'turn',
      notification: { conversationId: 'conversation', sessionId: 'conversation', turnId: 'turn', delta } });
    const event = { conversationId: 'conversation', runId: 'turn', seq: 1, scope: 'run' as const,
      event: 'tool:call_start' as const, payload: { id: 'tool', name: 'read' }, meta: { lineage: 'main' } };
    f.session.acceptEvent(event); f.session.pause('legacy gap');
    f.session.acceptEvent({ ...event, lifecycle: 'closed' });
    const count = f.changed.mock.calls.length;
    f.session.resume(); f.session.acceptEvent({ ...event, lifecycle: 'closed' });
    expect(f.changed.mock.calls.at(-1)![0].view.phase).toBe('本轮已结束');
    expect(f.changed).toHaveBeenCalledTimes(count); expect(f.block).not.toHaveBeenCalled();
  });

  it('keeps new scopes paused until recovery and only renders their later content', () => {
    const f = fixture();
    f.session.pause('capacity');
    f.emit('new', 1, { kind: 'yield', delta: { type: 'thinking_delta', thinking: 'paused thought' } });
    expect(f.block).not.toHaveBeenCalled();
    f.session.resume();
    f.emit('new', 2, { kind: 'yield', delta: { type: 'thinking_delta', thinking: 'fresh thought' } });
    f.emit('new', 2, { kind: 'closed' });
    expect(f.block).toHaveBeenCalled();
    const text = f.block.mock.calls.map(([block]) => block.text).join('');
    expect(text).toContain('fresh thought'); expect(text).not.toContain('paused thought');
  });
  it('keeps an assignment tail after business completion until its explicit same-sequence close', () => {
    const f = fixture();
    f.emit('run', 1, { kind: 'yield', delta: { type: 'thinking_delta', thinking: 'pending thought' } });
    f.session.end('conversation', undefined, 'run');
    expect(f.changed.mock.calls.at(-1)![0].view.phase).not.toBe('本轮已结束');
    f.emit('run', 2, { kind: 'yield', delta: { type: 'text_delta', text: 'answer' } });
    f.emit('run', 2, { kind: 'closed' });
    expect(f.changed.mock.calls.at(-1)![0].view.phase).toBe('本轮已结束');
    const count = f.changed.mock.calls.length;
    f.emit('run', 3, { kind: 'yield', delta: { type: 'thinking_delta', thinking: 'late' } });
    expect(f.changed).toHaveBeenCalledTimes(count);
    expect(f.gap).not.toHaveBeenCalled();
  });

  it('lets an older pending tail settle its blocks without replacing the newer activity area', () => {
    const f = fixture();
    f.emit('old', 1, { kind: 'yield', delta: { type: 'thinking_delta', thinking: 'old thought' } });
    f.emit('new', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'new answer' } });
    f.changed.mockClear();
    f.emit('old', 1, { kind: 'closed' });
    expect(f.block).toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('releases all tails at conversation replacement and rejects old conversation notifications', () => {
    const f = fixture();
    f.emit('old', 1, { kind: 'yield', delta: { type: 'thinking_delta', thinking: 'old thought' } });
    f.switchConversation(); f.changed.mockClear(); f.block.mockClear();
    f.emit('old', 2, { kind: 'closed' });
    expect(f.changed).not.toHaveBeenCalled(); expect(f.block).not.toHaveBeenCalled();
  });
});
