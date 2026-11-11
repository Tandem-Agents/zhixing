import { describe, expect, it, vi } from 'vitest';
import { projectProcessYield, type SessionProcessProjection } from '@zhixing-ai/rpc/session-wire';
import { processViewRows } from '@zhixing-ai/terminal-ui/process-model';
import { TerminalProcessSession } from '../process-session.js';
import { TerminalOutputProjection } from '../output.js';

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
  it('does not turn observer closure or body drain into a domain completion', async () => {
    const f = fixture();
    const output = new TerminalOutputProjection(async () => {}, async () => {}, async () => {},
      { last: 0, work: action => action(), amend: async () => {}, seal: async () => {} },
      { accept: (event, source) => f.session.acceptYield(event, source) });
    for (const kind of ['closed', 'gap'] as const) {
      f.emit(kind, 1, { kind: 'yield', delta: { type: 'text_delta', text: 'answer' } });
      f.emit(kind, 1, kind === 'closed' ? { kind } : { kind, reason: 'lost frames' });
      output.end('conversation', undefined, kind); await output.drain();
      expect(f.changed.mock.calls.at(-1)![0].view.activity).toBe('reconciling');
      f.session.end('conversation', undefined, kind);
      expect(f.changed.mock.calls.at(-1)![0].view.activity).toBe('complete');
    }
    await output.close();
  });
  it('drops an old attempt display on restart so the confirmed new attempt shows again', () => {
    const f = fixture();
    f.emit('retry', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'old attempt' } });
    f.emit('retry', 1, { kind: 'gap', reason: '过程来源已换代，请刷新正文。' });
    f.changed.mockClear();
    // 关闭后的旧展示仍会挡住同一运行的帧
    f.emit('retry', 2, { kind: 'yield', delta: { type: 'text_delta', text: 'blocked' } });
    expect(f.changed).not.toHaveBeenCalled();
    f.session.restart('conversation', 'retry');
    expect(f.changed).toHaveBeenLastCalledWith(undefined);
    f.emit('retry', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'new attempt' } });
    expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ runId: 'retry', view: { activity: 'running' } });
  });
  it('lets a confirmed new attempt run after the old uncertain waiter ended the display', () => {
    const f = fixture();
    f.session.followLocal('conversation', 'turn-retry', 'retry');
    f.emit('retry', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'old attempt' } });
    // 待确认结清本地等待时会调用 end：这只是旧尝试的展示结束，不是运行的业务终态
    f.session.end('conversation', 'turn-retry', 'retry');
    f.session.restart('conversation', 'retry', 'turn-retry');
    f.emit('retry', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'new attempt' } });
    expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ runId: 'retry', view: { activity: 'running' } });
  });
  it('remembers completion before the first process frame and does not steal a newer activity', () => {
    const f = fixture(); f.session.end('conversation', undefined, 'early');
    f.emit('early', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'late body' } });
    expect(f.changed.mock.calls.every(([status]) => status.view.activity === 'complete')).toBe(true);
    f.emit('new', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'new body' } });
    f.session.end('conversation', undefined, 'older'); f.changed.mockClear();
    f.emit('older', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'old body' } });
    expect(f.changed).not.toHaveBeenCalled();
    f.switchConversation(); f.emit('early', 2, { kind: 'closed' });
    expect(f.changed.mock.calls.at(-1)![0]).toBeUndefined();
  });
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
    expect(view.phase).toBe('正在核对运行结果');
    expect(view.activity).toBe('reconciling');
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
    expect(f.changed.mock.calls.at(-1)![0].view.phase).toBe('正在核对运行结果');
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
    for (let i = 0; i < 9; i++) {
      f.emit(`gap-${i}`, 0, { kind: 'yield', delta: { type: 'text_delta', text: 'answer' } });
      f.emit(`gap-${i}`, 1, { kind: 'gap', reason: '过程缺口' });
    }
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
    expect(f.changed.mock.calls.at(-1)![0].view.phase).toBe('正在核对运行结果');
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
    expect(f.changed.mock.calls.at(-1)![0].view.activity).toBe('complete');
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

describe('terminal process session activity', () => {
  it('reports whether the run shown in the activity area is still in progress', () => {
    const f = fixture();
    expect(f.session.running).toBe(false);
    // 重进后接上的运行：只有过程帧，没有本地等待者
    f.emit('adopted', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'still streaming' } });
    expect(f.session.running).toBe(true);
    f.session.end('conversation', undefined, 'adopted');
    expect(f.session.running).toBe(false);
    f.emit('next', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'another' } });
    f.switchConversation();
    expect(f.session.running).toBe(false);
  });
  it('shows the run duration only for runs this terminal started; attached runs have no trusted start', () => {
    const f = fixture();
    const duration = () => f.changed.mock.calls.at(-1)![0].view.durationMs;
    // 接上的运行（不是本终端提交的）：重进后回放几秒就收尾，本地计时不是运行用时
    f.emit('attached', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'replayed' } });
    f.session.end('conversation', undefined, 'attached');
    expect(duration()).toBeUndefined();
    // 接纳先于首帧到达
    f.session.followLocal('conversation', 'turn-early', 'early');
    f.emit('early', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'local' } });
    f.session.end('conversation', 'turn-early', 'early');
    expect(duration()).toEqual(expect.any(Number));
    // 首帧先于接纳到达
    f.emit('late', 1, { kind: 'yield', delta: { type: 'text_delta', text: 'local' } });
    f.session.followLocal('conversation', 'turn-late', 'late');
    f.session.end('conversation', 'turn-late', 'late');
    expect(duration()).toEqual(expect.any(Number));
  });
});
