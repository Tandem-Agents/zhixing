/**
 * 状态行的唯一说明与停止主体：先按权威生命周期判定当前对话里的实际状态，再合成待确认义务。
 * 只读控制器的生命周期快照与过程展示的原始状态，不保存业务事实；同一输入总得到同一输出。
 *
 * 顺序：
 * 1. 有派发、执行或取消中的运行：执行中且当前尝试已确证、过程展示正是它时显示过程；否则只给生命周期文案。
 * 2. 尚未开始的输入：本终端已接纳的未知或排队输入，以及当前会话的其他排队运行；主体先取本终端最近接纳的一条，
 *    没有时取最近进入跟踪的排队运行；合成等待说明，携带主体的身份。
 * 3. 只有待确认义务：给出 /resolve 说明（等待活动，不随一次性说明让位），不携带身份（没有可停止的对象）。
 * 4. 其他：沿用过程展示；属于排队或待确认运行的旧过程不压过前面的说明，也不单独占据状态行。
 */
import type { TerminalProcessStatus } from '@zhixing-ai/terminal-ui/protocol';
import type { RunLifecycle } from '../runtime/run-lifecycle.js';

type TerminalProcessView = TerminalProcessStatus['view'];

export function presentRunActivity(input: {
  readonly conversationId: string | undefined;
  readonly lifecycles: readonly RunLifecycle[];
  readonly process: TerminalProcessStatus | undefined;
  /** 合成视图的修订号，由调用方单调递增 */
  readonly revision: number;
}): TerminalProcessStatus | undefined {
  const { conversationId, process } = input;
  if (!conversationId) return process;
  const runs = input.lifecycles.filter((run) => run.conversationId === conversationId);
  const latest = (items: readonly RunLifecycle[]) => [...items].sort((a, b) => b.order - a.order)[0];
  const view = (phase: string, activity?: TerminalProcessView['activity']): TerminalProcessView =>
    ({ revision: input.revision, phase, ...(activity ? { activity } : {}), tools: [], children: [], usage: {} });
  const about = (run: RunLifecycle, phase: string, activity?: TerminalProcessView['activity']): TerminalProcessStatus =>
    ({ conversationId, runId: run.runId, ...(run.turnId ? { turnId: run.turnId } : {}), view: view(phase, activity) });

  const active = latest(runs.filter((run) => run.state === 'dispatched' || run.state === 'running' || run.state === 'cancel-requested'));
  if (active) {
    if (active.state === 'cancel-requested') return about(active, '正在取消…', 'running');
    const ownProcess = process?.conversationId === conversationId && process.runId === active.runId;
    if (active.assignmentId && ownProcess) return process;
    return about(active, active.state === 'running' ? '正在处理…' : '已派发，正在准备执行', 'running');
  }

  const uncertain = runs.some((run) => run.state === 'uncertain');
  // 未知只来自本终端的回执；排队不分来源：本地归属只存在于进程内，终端重开后自己的输入、其他接入面的输入同样是当前会话已接纳的消息
  const own = runs.filter((run) => run.local && (run.state === 'unknown' || run.state === 'queued'));
  const queuedRuns = runs.filter((run) => run.state === 'queued');
  // 主体先取本终端最近接纳的一条；没有时取最近进入跟踪的排队运行，只带它的运行身份
  const subject = latest(own) ?? latest(queuedRuns);
  if (subject) {
    const queued = queuedRuns.length;
    const phase = subject.state === 'queued'
      // 待确认义务是权威的阻塞原因，可以说明；只有排队事实时不捏造原因
      ? uncertain ? `${queued > 1 ? `${queued} 条消息` : '消息'}已排队，需先处理上次运行结果 · /resolve` : '消息已排队，等待执行'
      : uncertain ? '正在核对消息状态；上次运行结果待确认 · /resolve' : '已接收，正在核对状态';
    return about(subject, phase, 'waiting');
  }
  // 持续义务同样占住状态行（等待活动，不随一次性说明让位）；不带身份，没有可停止的对象
  if (uncertain) return { conversationId, view: view('上次运行结果待确认 · /resolve 处理', 'waiting') };

  if (process?.conversationId === conversationId && process.runId) {
    const shown = runs.find((run) => run.runId === process.runId);
    if (shown && (shown.state === 'queued' || shown.state === 'uncertain' || shown.state === 'unknown')) return undefined;
  }
  return process;
}
