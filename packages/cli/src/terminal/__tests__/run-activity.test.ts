import { describe, expect, it } from 'vitest';
import type { TerminalProcessStatus } from '@zhixing-ai/terminal-ui/protocol';
import type { RunLifecycle } from '../../runtime/run-lifecycle.js';
import { presentRunActivity } from '../run-activity.js';

let order = 0;
const run = (runId: string, state: RunLifecycle['state'], extra: Partial<RunLifecycle> = {}): RunLifecycle =>
  ({ conversationId: 'conv', runId, state, statusRevision: 1, local: false, order: ++order, ...extra });
const processOf = (runId: string, phase = '正在回复'): TerminalProcessStatus =>
  ({ conversationId: 'conv', runId, view: { revision: 1, phase, activity: 'running', tools: ['读取 a.ts'], children: [], usage: {} } });
const present = (lifecycles: readonly RunLifecycle[], process?: TerminalProcessStatus) =>
  presentRunActivity({ conversationId: 'conv', lifecycles, process, revision: 9 });

describe('presentRunActivity', () => {
  it('shows the process only for a running run whose current attempt is confirmed', () => {
    expect(present([run('r', 'running', { assignmentId: 'a' })], processOf('r'))).toEqual(processOf('r'));
    // 当前尝试无法确证：只给生命周期文案，不显示过程细节
    expect(present([run('r', 'running')], processOf('r'))).toMatchObject({ runId: 'r', view: { phase: '正在处理…', activity: 'running', tools: [] } });
    // 派发不等于执行：没有当前尝试的过程时写“已派发”
    expect(present([run('r', 'dispatched', { assignmentId: 'a' })])).toMatchObject({ view: { phase: '已派发，正在准备执行' } });
    // 取消中：过程尾部不能退回执行状态，也不撤掉取消说明
    expect(present([run('r', 'cancel-requested', { assignmentId: 'a' })], processOf('r', '还在回复'))).toMatchObject({ runId: 'r', view: { phase: '正在取消…' } });
  });

  it('merges the waiting input and the uncertain obligation into one statement with the subject identity', () => {
    const uncertain = run('old', 'uncertain');
    const a = run('a', 'queued', { local: true, turnId: 'turn-a' }), b = run('b', 'queued', { local: true, turnId: 'turn-b' });
    expect(present([uncertain, a, b])).toEqual({ conversationId: 'conv', runId: 'b', turnId: 'turn-b',
      view: { revision: 9, phase: '2 条消息已排队，需先处理上次运行结果 · /resolve', activity: 'waiting', tools: [], children: [], usage: {} } });
    expect(present([uncertain, a])).toMatchObject({ runId: 'a', view: { phase: '消息已排队，需先处理上次运行结果 · /resolve', activity: 'waiting' } });
    // 只有排队事实、没有权威的阻塞原因时，不捏造“等前面的运行”
    expect(present([a])).toMatchObject({ view: { phase: '消息已排队，等待执行' } });
    // 只有回执：未知时不写“已排队”
    const unknown = run('u', 'unknown', { local: true, turnId: 'turn-u' });
    expect(present([uncertain, unknown])).toMatchObject({ runId: 'u', view: { phase: '正在核对消息状态；上次运行结果待确认 · /resolve', activity: 'waiting' } });
    expect(present([unknown])).toMatchObject({ view: { phase: '已接收，正在核对状态' } });
    // 只有待确认义务：等待活动占住状态行，但不带身份（没有可停止的对象）
    expect(present([uncertain])).toEqual({ conversationId: 'conv', view: { revision: 9, phase: '上次运行结果待确认 · /resolve 处理', activity: 'waiting', tools: [], children: [], usage: {} } });
  });

  it('states queued runs without local attribution and lets the latest one be stopped by its run identity', () => {
    // 本地归属只存在于进程内：终端重开后自己的排队输入、以及其他接入面的排队输入都没有本地归属，仍是当前会话已接纳的消息
    const uncertain = run('old', 'uncertain');
    const p = run('peer-1', 'queued'), q = run('peer-2', 'queued');
    expect(present([uncertain, p, q])).toEqual({ conversationId: 'conv', runId: 'peer-2',
      view: { revision: 9, phase: '2 条消息已排队，需先处理上次运行结果 · /resolve', activity: 'waiting', tools: [], children: [], usage: {} } });
    expect(present([p])).toMatchObject({ runId: 'peer-1', view: { phase: '消息已排队，等待执行', activity: 'waiting' } });
    // 主体先取本终端最近接纳的输入，条数数全部排队
    const own = run('own', 'queued', { local: true, turnId: 'turn-own' });
    expect(present([uncertain, own, q])).toMatchObject({ runId: 'own', turnId: 'turn-own', view: { phase: '2 条消息已排队，需先处理上次运行结果 · /resolve' } });
  });

  it('keeps old process views from masking the obligation or a requeued run', () => {
    const uncertain = run('old', 'uncertain');
    expect(present([uncertain], processOf('old'))).toMatchObject({ view: { phase: '上次运行结果待确认 · /resolve 处理' } });
    expect(present([uncertain], processOf('old'))).not.toHaveProperty('runId');
    // 重试后回到排队：旧尝试的过程不显示，状态行如实说明它在排队（排队不分来源）
    expect(present([run('retry', 'queued')], processOf('retry'))).toMatchObject({ runId: 'retry', view: { phase: '消息已排队，等待执行', activity: 'waiting', tools: [] } });
    // 已结束的运行沿用过程展示（完成后的用时等）
    const finished: TerminalProcessStatus = { conversationId: 'conv', runId: 'done', view: { revision: 3, phase: '本轮已结束', activity: 'complete', durationMs: 2000, tools: [], children: [], usage: {} } };
    expect(present([run('done', 'terminal')], finished)).toEqual(finished);
    // 没有生命周期事实的过程（例如没有状态通知的路径）沿用现状
    expect(present([], processOf('legacy'))).toEqual(processOf('legacy'));
  });

  it('ignores other conversations', () => {
    expect(presentRunActivity({ conversationId: 'conv', lifecycles: [{ ...run('x', 'uncertain'), conversationId: 'other' }], process: undefined, revision: 1 })).toBeUndefined();
  });
});
