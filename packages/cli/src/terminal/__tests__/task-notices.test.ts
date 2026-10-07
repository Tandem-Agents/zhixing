import { describe, expect, it, vi } from 'vitest';
import { SESSION_NOTIFICATIONS } from '@zhixing/rpc/session-wire';
import { RpcSchedulerFacade } from '../../runtime/rpc-scheduler-facade.js';
import { makeFakeHostLink } from '../../runtime/__tests__/fake-host-link.js';
import { TerminalTaskNotices, type TerminalTaskNotice, type TerminalTaskNoticeDelivery, type TerminalTaskNoticesOptions } from '../task-notices.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function publication(conversationId = 'conv-1', seq = 1) {
  return { conversationId, scope: 'control', runId: 'run-1', seq, event: 'publish:result', meta: {},
    payload: { conversationId, runId: 'run-1', commitRevision: 4, assignmentId: 'assignment-1', seq,
      mutation: { kind: 'workscene-create', name: '专注' }, decision: { t: 'granted', targetRevision: 7,
        appliedResult: { kind: 'workscene-applied', operation: 'create', revision: 7,
          scene: { id: 'scene-1', name: '专注', revision: 1, createdAt: '2026-08-05T00:00:00.000Z', lastActiveAt: '2026-08-05T00:00:00.000Z' } } } } };
}
function fixture() {
  const fake = makeFakeHostLink(), abort = new AbortController(), watching = new Set(['conv-1']);
  const callbacks = new Map<string, ((payload: unknown) => void)[]>();
  const link = { onNotification(method: string, handler: (payload: unknown) => void) {
    callbacks.set(method, [...(callbacks.get(method) ?? []), handler]); return fake.link.onNotification(method, handler);
  } };
  const scheduler = new RpcSchedulerFacade({ connection: { ...fake.link, onNotification: link.onNotification } });
  const emitted: TerminalTaskNotice[] = [];
  const emit = vi.fn<TerminalTaskNoticesOptions['emit']>(async (notice, delivery) => { if (delivery.isCurrent()) emitted.push(notice); });
  const gap = vi.fn<TerminalTaskNoticesOptions['gap']>();
  const notices = new TerminalTaskNotices({ link, scheduler, signal: abort.signal, watching: id => watching.has(id), emit, gap });
  const complete = (name = '日报') => fake.notify('schedule.completed', { taskId: 'task-1', name, status: 'ok', durationMs: 2000, summary: '已整理' });
  return { fake, abort, watching, callbacks, emit, emitted, gap, notices, complete };
}

describe('terminal task notification adaptation', () => {
  it('subscribes once through the real scheduler facade without connecting or querying', async () => {
    const f = fixture();
    for (const method of ['schedule.accepted', 'schedule.started', 'schedule.completed', 'schedule.disabled', SESSION_NOTIFICATIONS.event]) expect(f.fake.handlerCount(method)).toBe(1);
    f.notices.resume(); f.notices.resume();
    f.fake.notify('schedule.accepted', { taskId: 'task-1', jobRunId: 'job-1', name: '日报' });
    f.fake.notify('schedule.started', { taskId: 'task-1', name: '日报' });
    await f.notices.drain(); expect(f.emit).not.toHaveBeenCalled(); expect(f.fake.requests).toEqual([]);
  });
  it('keeps success, error and automatic disable notices distinct from current conversation tasks', async () => {
    const f = fixture(); f.complete();
    f.fake.notify('schedule.completed', { taskId: 'task-1', name: '日报', status: 'error', error: '模型不可用', consecutiveErrors: 3, nextRunAt: '2026-10-07T00:00:00.000Z' });
    f.fake.notify('schedule.disabled', { taskId: 'task-1', name: '日报', reason: '错误阈值', lastError: '重试失败' });
    await f.notices.drain();
    expect(f.emitted).toHaveLength(3); expect(f.emitted.every(notice => notice.kind === 'schedule' && notice.taskId === 'task-1' && notice.conversationId === undefined)).toBe(true);
    expect(f.emitted[0]!.message).toContain('定时任务完成: 日报 (2s)');
    expect(f.emitted[1]!.message).toContain('连续 3 次'); expect(f.emitted[1]!.message).toContain('下次重试:');
    expect(f.emitted[2]!.message).toContain('已自动停用'); expect(f.emitted[2]!.message).toContain('错误阈值'); expect(f.emitted[2]!.message).toContain('重试失败');
  });
  it('does not mistake identical schedule results from separate runs for a replay identity', async () => {
    const f = fixture(); f.complete(); await f.notices.drain(); f.complete(); await f.notices.drain();
    expect(f.emitted).toHaveLength(2); expect(f.emitted[0]).toEqual(f.emitted[1]);
  });
  it('uses the real publish presenter identity and preserves its dedupe across reconnect', async () => {
    const f = fixture(), value = publication();
    f.fake.notify(SESSION_NOTIFICATIONS.event, value); f.fake.notify(SESSION_NOTIFICATIONS.event, structuredClone(value));
    await f.notices.drain();
    expect(f.emitted).toEqual([{ kind: 'publish', conversationId: 'conv-1', message: '场景「专注」已创建。' }]);
    f.notices.invalidate(); f.notices.resume(); f.fake.notify(SESSION_NOTIFICATIONS.event, structuredClone(value));
    await f.notices.drain(); expect(f.emitted).toHaveLength(1);
    f.fake.notify(SESSION_NOTIFICATIONS.event, publication('conv-1', 2)); await f.notices.drain(); expect(f.emitted).toHaveLength(2);
  });
  it('preserves authority conflicts and malformed-result warnings without displaying internal diagnostics', async () => {
    const f = fixture();
    f.fake.notify(SESSION_NOTIFICATIONS.event, { conversationId: 'conv-1', scope: 'control', runId: 'run-1', seq: 3, event: 'publish:result', meta: {},
      payload: { conversationId: 'conv-1', runId: 'run-1', commitRevision: 4, assignmentId: 'assignment-1', seq: 3,
        mutation: { kind: 'schedule-delete', taskId: 'task-1', taskRevision: 3 },
        decision: { t: 'conflicted', error: { code: 'revision-conflict', message: 'internal secret diagnostic', retryable: false } } } });
    const invalid = { ...publication('conv-1', 4), payload: null };
    f.fake.notify(SESSION_NOTIFICATIONS.event, invalid); f.fake.notify(SESSION_NOTIFICATIONS.event, structuredClone(invalid));
    await f.notices.drain();
    expect(f.emitted).toHaveLength(2); expect(f.emitted[0]!.message).toContain('相关内容已被其他修改更新');
    expect(f.emitted[0]!.message).not.toContain('internal secret'); expect(f.emitted[1]!.message).toContain('无法安全确认');
  });
  it('filters publish results by the watched conversation both on receipt and before display', async () => {
    const f = fixture(); f.fake.notify(SESSION_NOTIFICATIONS.event, publication('other'));
    f.fake.notify(SESSION_NOTIFICATIONS.event, publication()); f.watching.clear();
    await f.notices.drain(); expect(f.emit).not.toHaveBeenCalled();
  });
  it('invalidates an in-flight display and queued old notices before a successor generation', async () => {
    const f = fixture(), gate = deferred<void>(); let delivery: TerminalTaskNoticeDelivery | undefined;
    f.emit.mockImplementationOnce(async (notice, context) => { delivery = context; await gate.promise; if (context.isCurrent()) f.emitted.push(notice); });
    f.complete('旧在途'); await vi.waitFor(() => expect(delivery).toBeDefined()); f.complete('旧队列');
    f.notices.invalidate(); expect(delivery!.signal.aborted).toBe(true); expect(delivery!.isCurrent()).toBe(false);
    f.complete('断连期间'); f.notices.resume(); f.complete('新代'); gate.resolve(); await f.notices.drain();
    expect(f.emitted.map(item => item.message)).toEqual([expect.stringContaining('新代')]);
    expect(f.gap).toHaveBeenCalledOnce(); expect(f.fake.handlerCount('schedule.completed')).toBe(1);
  });
  it('bounds burst retention and signals a gap once without retrying any task', async () => {
    const f = fixture();
    for (let index = 0; index < 100; index++) f.complete(`通知 ${index}`);
    await f.notices.drain(); expect(f.emitted).toHaveLength(32); expect(f.gap).toHaveBeenCalledOnce(); expect(f.fake.requests).toEqual([]);
    expect(f.gap.mock.calls[0]![0]).toContain('不会自动重发');
  });
  it('halts a failed sink with an explicit gap and resumes only future notifications', async () => {
    const f = fixture(); f.emit.mockRejectedValueOnce(Error('display full'));
    f.complete('失败'); f.complete('未显示'); await f.notices.drain();
    expect(f.emit).toHaveBeenCalledTimes(1); expect(f.emitted).toEqual([]); expect(f.gap).toHaveBeenCalledOnce();
    f.complete('尚未恢复'); await f.notices.drain(); expect(f.emit).toHaveBeenCalledTimes(1);
    f.notices.resume(); f.complete('恢复后'); await f.notices.drain(); expect(f.emitted[0]!.message).toContain('恢复后');
  });
  it('contains display controls/oversized messages and rejects over-capacity source events', async () => {
    const f = fixture(); f.complete('\x1b[31m日报\u202e');
    f.complete('文'.repeat(3000)); f.complete('x'.repeat(70 * 1024));
    await f.notices.drain();
    expect(f.emitted[0]!.message).not.toMatch(/[\x1b\u202e]/u);
    expect(f.emitted[1]!.message).toContain('详细状态请重新查看');
    expect(Buffer.byteLength(JSON.stringify(f.emitted[1]))).toBeLessThan(8192); expect(f.gap).toHaveBeenCalledOnce();
  });
  it('disposes all passive subscriptions, fences saved callbacks and does not clear durable state', async () => {
    const f = fixture(); f.complete('排队'); f.notices.dispose(); f.notices.dispose();
    for (const [method, callbacks] of f.callbacks) {
      expect(f.fake.handlerCount(method)).toBe(0);
      if (method === 'schedule.completed') for (const callback of callbacks) callback({ taskId: 'task-1', name: '迟到', status: 'ok', durationMs: 0 });
      if (method === SESSION_NOTIFICATIONS.event) for (const callback of callbacks) callback(publication());
    }
    f.notices.resume(); await f.notices.drain(); expect(f.emit).not.toHaveBeenCalled(); expect(f.fake.requests).toEqual([]);
  });
  it('fences a global close signal while a sink is waiting', async () => {
    const f = fixture(), gate = deferred<void>(); let delivery: TerminalTaskNoticeDelivery | undefined;
    f.emit.mockImplementationOnce(async (notice, context) => { delivery = context; await gate.promise; if (context.isCurrent()) f.emitted.push(notice); });
    f.complete(); await vi.waitFor(() => expect(delivery).toBeDefined()); f.abort.abort(); gate.resolve(); await f.notices.drain();
    expect(delivery!.signal.aborted).toBe(true); expect(f.emitted).toEqual([]); f.notices.dispose();
  });
});
