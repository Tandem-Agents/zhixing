import { describe, expect, it, vi } from 'vitest';
import type { TaskListState } from '@zhixing/core/conversation';
import type { TaskView } from '@zhixing/core/scheduler';
import type { SessionTaskListAction } from '@zhixing/rpc/session-wire';
import { RpcConversationFacade } from '../../runtime/rpc-conversation-facade.js';
import { RpcSchedulerFacade } from '../../runtime/rpc-scheduler-facade.js';
import { makeFakeHostLink } from '../../runtime/__tests__/fake-host-link.js';
import { TerminalTasks, type TerminalTaskController, type TerminalTasksOptions } from '../tasks.js';
import type { TerminalSelectionPort } from '../selection.js';

const state = (content = '处理当前任务'): TaskListState => ({ items: [
  { id: 'first-id', content, status: 'in_progress' }, { id: 'second-id', content: '验收', status: 'pending' },
  { id: 'third-id', content: '准备', status: 'completed' },
] });
const scheduled = (id = 'schedule-1'): TaskView => ({ id, name: '日报', enabled: true, priority: 'normal',
  schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'Asia/Shanghai' }, action: { kind: 'agent-turn', prompt: '汇总日报' },
  state: { consecutiveErrors: 0, runCount: 0 }, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const controller = { current: { conversationId: 'conv-1' } }; let current: TerminalTaskController | undefined = controller;
  const conversation = {
    taskList: vi.fn<TerminalTasksOptions['conversation']['taskList']>(async () => ({ taskList: state() })),
    taskListUpdate: vi.fn<TerminalTasksOptions['conversation']['taskListUpdate']>(async () => ({ ok: true, message: '✓ 权威已确认', taskList: state() })),
  };
  const scheduler = { list: vi.fn<TerminalTasksOptions['scheduler']['list']>(async () => [scheduled()]) };
  const choose = vi.fn<TerminalSelectionPort>(async () => ({ itemId: 'return' }));
  const publish = vi.fn<TerminalTasksOptions['publish']>(async () => {}), changed = vi.fn<TerminalTasksOptions['changed']>();
  const abort = new AbortController();
  const tasks = new TerminalTasks({ controller: () => current, conversation, scheduler, choose, publish, changed, signal: abort.signal });
  return { tasks, controller, conversation, scheduler, choose, publish, changed, abort,
    text: () => [...choose.mock.calls.map(([page]) => page.message), ...publish.mock.calls.map(([result]) => result.message)].join('\n'),
    replace(next: TerminalTaskController | undefined) { current = next; } };
}

describe('terminal task commands and current projection', () => {
  it('uses the real conversation/scheduler facades and authority update receipt', async () => {
    const fake = makeFakeHostLink();
    fake.setResponder(method => method === 'session.taskList' ? { taskList: state() }
      : method === 'session.taskListUpdate' ? { ok: false, message: '没有匹配该前缀的任务', taskList: state() } : [scheduled()]);
    const f = fixture(); const tasks = new TerminalTasks({ controller: () => f.controller,
      conversation: new RpcConversationFacade(fake.link), scheduler: new RpcSchedulerFacade({ connection: fake.link }),
      signal: f.abort.signal, choose: f.choose, publish: f.publish, changed: f.changed });
    await tasks.run('tasklist'); await tasks.run('task', 'done prefix'); await tasks.run('tasks');
    expect(fake.requests.map(item => item.method)).toEqual(['session.taskList', 'session.taskListUpdate', 'schedule.list']);
    expect(fake.requests[1]!.params).toMatchObject({ conversationId: 'conv-1', action: { kind: 'done', token: 'prefix' }, requestId: expect.stringMatching(/^task-list:/u) });
    expect(f.publish).toHaveBeenCalledWith({ title: '当前对话任务列表', message: '没有匹配该前缀的任务', error: true });
  });
  it.each<[string, SessionTaskListAction]>([
    ['new 写周报', { kind: 'add', content: '写周报' }], ['买牛奶', { kind: 'add', content: '买牛奶' }],
    ['done 2', { kind: 'done', token: '2' }], ['done bad-prefix', { kind: 'done', token: 'bad-prefix' }],
    ['new', { kind: 'add', content: '' }], ['done', { kind: 'done', token: '' }],
    ['New 保持旧大小写语义', { kind: 'add', content: 'New 保持旧大小写语义' }],
  ])('preserves %s syntax and delegates all task token/business validation', async (text, action) => {
    const f = fixture(); await f.tasks.run('task', text);
    expect(f.conversation.taskListUpdate).toHaveBeenCalledWith('conv-1', action);
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ message: '✓ 权威已确认', error: false }));
  });
  it('keeps usage and ephemeral rejection free of mutations', async () => {
    const f = fixture(); await f.tasks.run('task', '  '); expect(f.text()).toContain('new 简写');
    f.controller.current = { conversationId: '' }; await f.tasks.run('task', 'new 内容');
    expect(f.text()).toContain('仅在持久化对话'); expect(f.conversation.taskListUpdate).not.toHaveBeenCalled();
  });
  it('shows the original task ordering/statuses and a stable current-only tail', async () => {
    const f = fixture(); await f.tasks.run('tasklist');
    expect(f.text()).toContain('1. ● 处理当前任务'); expect(f.text()).toContain('2. ○ 验收'); expect(f.text()).toContain('3. ✓ 准备');
    expect(f.tasks.summary).toEqual({ conversationId: 'conv-1', state: 'ready', text: '处理当前任务 (1/3)' });
    f.tasks.apply({ conversationId: 'other', change: 'taskList', taskList: state('别的会话') });
    expect(f.tasks.summary?.text).toBe('处理当前任务 (1/3)');
    f.tasks.apply({ conversationId: 'conv-1', change: 'taskList', taskList: { items: [{ id: 'a', content: '已完成', status: 'completed' }] } });
    expect(f.tasks.summary?.text).toBe('');
    f.conversation.taskList.mockResolvedValueOnce({ taskList: null }); await f.tasks.run('tasklist');
    expect(f.text()).toContain('任务列表为空'); expect(f.tasks.summary?.state).toBe('ready');
  });
  it('does not call a failed or malformed query an empty task list, and refresh recovers', async () => {
    const f = fixture(); f.conversation.taskList.mockRejectedValueOnce(Error('read unavailable'));
    await f.tasks.run('tasklist'); expect(f.text()).toContain('read unavailable'); expect(f.text()).not.toContain('任务列表为空');
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: true, message: expect.stringContaining('read unavailable') }));
    expect(f.choose).not.toHaveBeenCalled();
    expect(f.tasks.summary?.state).toBe('error');
    await f.tasks.refresh(); expect(f.tasks.summary?.state).toBe('ready');
    f.tasks.apply({ conversationId: 'conv-1', change: 'taskList', taskList: state('x'.repeat(1100 * 1024)) });
    expect(f.tasks.summary?.state).toBe('error'); expect(f.tasks.summary?.text).toContain('容量');
  });
  it('never lets a slow read or its error overwrite a newer pushed state', async () => {
    const f = fixture(), gate = deferred<{ taskList: TaskListState }>(); f.conversation.taskList.mockReturnValueOnce(gate.promise);
    const read = f.tasks.refresh(); f.tasks.apply({ conversationId: 'conv-1', change: 'taskList', taskList: state('实时新状态') });
    gate.resolve({ taskList: state('旧读取') }); await read; expect(f.tasks.summary?.text).toBe('实时新状态 (1/3)');
    f.conversation.taskList.mockImplementationOnce(async () => {
      f.tasks.apply({ conversationId: 'conv-1', change: 'taskList', taskList: state('错误前的新状态') }); throw Error('late failure');
    });
    await f.tasks.refresh(); expect(f.tasks.summary?.text).toBe('错误前的新状态 (1/3)');
  });
  it('coalesces refresh bursts and reads the successor conversation after an invalidated old read', async () => {
    const f = fixture(), gate = deferred<{ taskList: TaskListState }>(); f.conversation.taskList.mockReturnValueOnce(gate.promise);
    const work = f.tasks.refresh();
    for (let i = 0; i < 100; i++) f.tasks.refresh();
    expect(f.conversation.taskList).toHaveBeenCalledTimes(1);
    f.tasks.invalidate(); f.controller.current = { conversationId: 'conv-2' }; f.tasks.refresh();
    f.conversation.taskList.mockResolvedValueOnce({ taskList: state('第二个会话') });
    gate.resolve({ taskList: state('迟到的第一个会话') }); await work;
    expect(f.conversation.taskList).toHaveBeenCalledTimes(2); expect(f.conversation.taskList).toHaveBeenLastCalledWith('conv-2');
    expect(f.tasks.summary).toMatchObject({ conversationId: 'conv-2', text: '第二个会话 (1/3)' });
  });
  it('does not assume a mutation receipt is newer than an intervening push and rereads Authority', async () => {
    const f = fixture(), gate = deferred<Awaited<ReturnType<TerminalTasksOptions['conversation']['taskListUpdate']>>>();
    f.conversation.taskListUpdate.mockReturnValueOnce(gate.promise);
    const work = f.tasks.run('task', 'done 1');
    f.tasks.apply({ conversationId: 'conv-1', change: 'taskList', taskList: state('并发推送') });
    f.conversation.taskList.mockResolvedValueOnce({ taskList: state('权威最新') });
    gate.resolve({ ok: true, message: '已完成', taskList: state('较旧回执') }); await work;
    expect(f.conversation.taskList).toHaveBeenCalledExactlyOnceWith('conv-1'); expect(f.tasks.summary?.text).toBe('权威最新 (1/3)');
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ message: '已完成', error: false }));
  });
  it.each(['controller', 'conversation', 'generation', 'close'] as const)('suppresses a late mutation display on %s invalidation without rolling it back', async kind => {
    const f = fixture(), gate = deferred<Awaited<ReturnType<TerminalTasksOptions['conversation']['taskListUpdate']>>>();
    f.conversation.taskListUpdate.mockReturnValueOnce(gate.promise); const work = f.tasks.run('task', 'done 1');
    await expect(f.tasks.run('task', 'new duplicate')).rejects.toThrow('尚未结束');
    if (kind === 'controller') f.replace({ current: { conversationId: 'conv-1' } });
    if (kind === 'conversation') f.controller.current = { conversationId: 'conv-2' };
    if (kind === 'generation') f.tasks.invalidate();
    if (kind === 'close') f.abort.abort();
    gate.resolve({ ok: true, message: '原写入已提交', taskList: state() }); await work;
    expect(f.publish).not.toHaveBeenCalled(); expect(f.conversation.taskListUpdate).toHaveBeenCalledTimes(1);
  });
  it('reports failed writes explicitly and never retries or changes task state optimistically', async () => {
    const f = fixture(); await f.tasks.refresh(); f.conversation.taskListUpdate.mockRejectedValueOnce(Error('receipt unavailable'));
    await f.tasks.run('task', 'done 1'); expect(f.conversation.taskListUpdate).toHaveBeenCalledTimes(1);
    expect(f.tasks.summary?.text).toBe('处理当前任务 (1/3)');
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ error: true, message: expect.stringContaining('不会自动重试') }));
  });
  it('preserves scheduled-task variants without inventing current running state', async () => {
    const f = fixture(); f.scheduler.list.mockResolvedValueOnce([
      scheduled(), { ...scheduled('once'), enabled: false, schedule: { kind: 'once', at: '2026-10-06T08:00:00.000Z' } },
      ...[30_000, 120_000, 7_200_000].map((everyMs, index): TaskView => ({ ...scheduled(`every-${index}`), schedule: { kind: 'interval', everyMs },
        state: { runCount: 1, consecutiveErrors: 0, lastRunAt: new Date().toISOString(), lastStatus: 'ok', nextRunAt: '2026-10-07T08:00:00.000Z' } })),
    ]);
    await f.tasks.run('tasks');
    for (const text of ['定时任务 (5 个)', 'Asia/Shanghai', '○ 日报 (once)', '一次性', '每 30 秒', '每 2 分钟', '每 2 小时', '上次: ok', '下次:', '未执行过']) expect(f.text()).toContain(text);
    expect(f.text()).not.toContain('执行中'); expect(f.conversation.taskList).not.toHaveBeenCalled();
    f.scheduler.list.mockResolvedValueOnce([]); await f.tasks.run('tasks'); expect(f.text()).toContain('没有定时任务');
    f.scheduler.list.mockRejectedValueOnce(Error('schedule unavailable')); await f.tasks.run('tasks');
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ error: true, message: expect.stringContaining('schedule unavailable') }));
  });
  it('paginates long lists, keeps controls inert and closes without leaving retained state', async () => {
    const f = fixture(); f.conversation.taskList.mockResolvedValueOnce({ taskList: { items: Array.from({ length: 150 }, (_, index) =>
      ({ id: String(index), content: `${index} ${'文'.repeat(40)}`, status: 'pending' as const })) } });
    f.choose.mockResolvedValueOnce({ itemId: 'next' }); await f.tasks.run('tasklist');
    expect(f.choose).toHaveBeenCalledTimes(2); expect(f.choose.mock.calls[1]![0].choices?.some(choice => choice.id === 'previous')).toBe(true);
    f.tasks.apply({ conversationId: 'conv-1', change: 'taskList', taskList: state('\x1b[31m内容\n第二行\u202e') });
    expect(f.tasks.summary?.text).toBe('内容 第二行  (1/3)');
    f.tasks.dispose(); f.tasks.dispose(); expect(f.tasks.summary).toBeUndefined();
    f.changed.mockClear(); f.tasks.apply({ conversationId: 'conv-1', change: 'taskList', taskList: state() }); await f.tasks.refresh();
    expect(f.changed).not.toHaveBeenCalled(); await expect(f.tasks.run('tasklist')).rejects.toThrow('连接不可用');
  });
});
