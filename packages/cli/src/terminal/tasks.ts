import type { TaskListState } from '@zhixing/core/conversation';
import type { TaskView } from '@zhixing/core/scheduler';
import type { SessionChangedPayload, SessionTaskListAction } from '@zhixing/rpc/session-wire';
import type { RpcConversationFacade } from '../runtime/rpc-conversation-facade.js';
import type { RpcSchedulerFacade } from '../runtime/rpc-scheduler-facade.js';
import { boundedControlProjection } from '../runtime/control-projection.js';
import { formatRelativeTime } from '../commands/format.js';
import { stripAnsi } from '../tui/ansi.js';
import { chooseTerminalSelection, type TerminalSelectionPort } from './selection.js';

export interface TerminalTaskController { readonly current: { readonly conversationId: string } }
export interface TerminalTaskSummary {
  readonly conversationId: string;
  readonly state: 'loading' | 'ready' | 'error';
  /** Plain, finite status-tail text; an empty ready string hides the task tail. */
  readonly text: string;
}
export interface TerminalTaskResult { readonly title: string; readonly message: string; readonly error?: boolean }
export interface TerminalTasksOptions {
  readonly controller: () => TerminalTaskController | undefined;
  readonly conversation: Pick<RpcConversationFacade, 'taskList' | 'taskListUpdate'>;
  readonly scheduler: Pick<RpcSchedulerFacade, 'list'>;
  readonly signal: AbortSignal;
  readonly choose: TerminalSelectionPort;
  readonly publish: (result: TerminalTaskResult) => Promise<void>;
  /** A synchronous projection update; the application owns/coalesces actual UI writes. */
  readonly changed: (summary: TerminalTaskSummary | undefined) => void;
}
interface Scope { readonly controller: TerminalTaskController; readonly conversationId: string; readonly generation: number }
interface Snapshot extends Scope { readonly state: TaskListState | null }
const STATE_BYTES = 1024 * 1024;
const TEXT_BYTES = 256 * 1024;
const USAGE = '用法：/task new <内容> · /task done <序号或 id> · /task <内容>（new 简写）';
export const TERMINAL_TASK_COMMANDS = ['tasklist', 'task', 'tasks'] as const;

/** One current-conversation read projection. Authority owns task identities,
 * index/prefix resolution, transitions and persistence; no local write model. */
export class TerminalTasks {
  #generation = 0;
  #version = 0;
  #snapshot?: Snapshot;
  #summary?: TerminalTaskSummary;
  #refresh?: Promise<void>;
  #refreshAgain = false;
  #running = false;
  #disposed = false;
  constructor(readonly options: TerminalTasksOptions) {}
  get summary(): TerminalTaskSummary | undefined { return this.#summary; }

  invalidate(): void {
    ++this.#generation; ++this.#version; this.#snapshot = undefined; this.#refreshAgain = false;
    this.#setSummary(undefined);
  }
  dispose(): void { if (this.#disposed) return; this.invalidate(); this.#disposed = true; }

  /** Route taskList changes here before controller.applySessionChanged (which
   * deliberately ignores them). Other conversations never grow this slot. */
  apply(change: SessionChangedPayload): void {
    if (change.change !== 'taskList' || !this.#available()) return;
    const scope = this.#scope();
    if (scope.conversationId !== change.conversationId) return;
    ++this.#version;
    try { this.#accept(scope, change.taskList); }
    catch (error) { this.#failure(scope, error); }
  }

  /** One in-flight read and one coalesced successor across refresh/context changes. */
  refresh(): Promise<void> {
    if (!this.#available()) return Promise.resolve();
    this.#refreshAgain = true;
    if (!this.#refresh) this.#refresh = this.#read().finally(() => { this.#refresh = undefined; });
    return this.#refresh;
  }

  async run(name: string, argument = ''): Promise<void> {
    if (!TERMINAL_TASK_COMMANDS.some(command => command === name)) throw Error('未知任务命令。');
    if (typeof argument !== 'string' || Buffer.byteLength(argument) > 8192) throw Error('任务命令参数过长。');
    if (this.#running) throw Error('另一个任务命令尚未结束。');
    const scope = this.#scope(); this.#running = true;
    const choose: TerminalSelectionPort = async page => {
      this.#assert(scope); const result = await this.options.choose(page); this.#assert(scope); return result;
    };
    const show = async (title: string, lines: readonly string[]) => {
      this.#assert(scope); boundedControlProjection(lines, TEXT_BYTES);
      await chooseTerminalSelection({ title, body: lines, options: [{ value: 'done', label: '返回输入' }] }, choose);
    };
    try {
      if (!scope.conversationId && name !== 'tasks') {
        await show('任务列表', ['任务列表在一次性 run / 定时任务中不可用 —— 仅在持久化对话中工作。']); return;
      }
      if (name === 'tasks') {
        const tasks = await this.options.scheduler.list(); this.#assert(scope);
        boundedControlProjection(tasks, STATE_BYTES);
        await show('定时任务', scheduledTaskLines(tasks)); return;
      }
      if (name === 'tasklist') {
        await this.refresh(); this.#assert(scope);
        if (!this.#snapshot || this.#summary?.state !== 'ready') {
          await this.options.publish({ title: '任务列表暂不可用', error: true,
            message: this.#summary?.text ?? '尚未读取当前对话的任务列表，请重试。' }); return;
        }
        this.#assert(this.#snapshot);
        await show('当前对话任务列表', taskListLines(this.#snapshot.state)); return;
      }
      const rest = argument.trim();
      if (!rest) { await show('管理任务', [USAGE]); return; }
      const action = taskAction(rest), version = this.#version;
      // Keep one captured identity throughout the write and any resulting refresh.
      this.#assert(scope);
      const result = await this.options.conversation.taskListUpdate(scope.conversationId, action);
      this.#assert(scope); boundedControlProjection(result, STATE_BYTES);
      if (version === this.#version) { ++this.#version; this.#accept(scope, result.taskList); }
      else {
        // The wire snapshot has no revision. A push received during the write
        // and its receipt cannot be ordered locally: reread Authority once.
        await this.refresh(); this.#assert(scope);
      }
      await this.options.publish({ title: '当前对话任务列表', message: plain(result.message), error: !result.ok });
    } catch (error) {
      if (!this.#current(scope)) return;
      await this.options.publish({ title: '任务操作暂未确认', error: true,
        message: `${shortError(error)}\n请重新查看当前状态；不会自动重试或撤销已经提交的操作。` });
    } finally { this.#running = false; }
  }

  async #read(): Promise<void> {
    while (this.#refreshAgain && this.#available()) {
      this.#refreshAgain = false;
      const scope = this.#scope(), version = this.#version;
      this.#setSummary({ conversationId: scope.conversationId, state: 'loading', text: '正在读取任务列表…' });
      try {
        const result = await this.options.conversation.taskList(scope.conversationId);
        if (!this.#current(scope) || version !== this.#version) continue;
        boundedControlProjection(result, STATE_BYTES); this.#accept(scope, result.taskList);
      } catch (error) {
        if (this.#current(scope) && version === this.#version) this.#failure(scope, error);
      }
    }
  }
  #accept(scope: Scope, state: TaskListState | null): void {
    this.#assert(scope); boundedControlProjection(state, STATE_BYTES);
    // Copy only the current read DTO: callers cannot mutate a retained snapshot.
    const snapshot = state === null ? null : { items: state.items.map(item => ({ id: item.id, content: item.content, status: item.status })) };
    const text = taskTail(snapshot);
    this.#snapshot = { ...scope, state: snapshot };
    this.#setSummary({ conversationId: scope.conversationId, state: 'ready', text });
  }
  #failure(scope: Scope, error: unknown): void {
    this.#snapshot = undefined;
    this.#setSummary({ conversationId: scope.conversationId, state: 'error', text: `任务列表暂不可用：${shortError(error)}` });
  }
  #setSummary(summary: TerminalTaskSummary | undefined): void {
    this.#summary = summary;
    if (!this.#disposed && !this.options.signal.aborted) this.options.changed(summary);
  }
  #available(): boolean { return !this.#disposed && !this.options.signal.aborted && !!this.options.controller(); }
  #scope(): Scope {
    const controller = this.options.controller();
    if (!controller || this.#disposed || this.options.signal.aborted) throw Error('连接不可用，请重新连接后查看任务。');
    return { controller, conversationId: controller.current.conversationId, generation: this.#generation };
  }
  #current(scope: Scope): boolean {
    return !this.#disposed && !this.options.signal.aborted && this.#generation === scope.generation &&
      this.options.controller() === scope.controller && scope.controller.current.conversationId === scope.conversationId;
  }
  #assert(scope: Scope): void { if (!this.#current(scope)) throw Error('页面或对话已变化，请重新查看任务。'); }
}

/** Only translates the established command syntax, never resolves task tokens. */
function taskAction(rest: string): SessionTaskListAction {
  const split = rest.search(/\s/u), first = split < 0 ? rest : rest.slice(0, split), remaining = split < 0 ? '' : rest.slice(split + 1).trim();
  return first === 'done' ? { kind: 'done', token: remaining }
    : { kind: 'add', content: first === 'new' ? remaining : rest };
}
function taskListLines(state: TaskListState | null): readonly string[] {
  if (!state?.items.length) return ['任务列表为空。LLM 调用 task_list 工具或用 /task new <内容> 创建任务。'];
  const counts = countTasks(state);
  return [`任务列表 · ${state.items.length} 项 · ${counts.active} 进行 · ${counts.pending} 待办 · ${counts.completed} 已完成`,
    ...state.items.map((item, index) => `${String(index + 1).padStart(2, ' ')}. ${item.status === 'in_progress' ? '●' : item.status === 'completed' ? '✓' : '○'} ${plain(item.content)}`)];
}
function taskTail(state: TaskListState | null): string {
  if (!state?.items.length) return '';
  const counts = countTasks(state); if (!counts.active && !counts.pending) return '';
  const active = state.items.find(item => item.status === 'in_progress');
  const main = active ? `${plain(active.content).replace(/\s/gu, ' ').slice(0, 512)}${active.content.length > 512 ? '…' : ''}${counts.active > 1 ? ` +${counts.active - 1}` : ''}` : `${counts.pending} 个任务待办`;
  return `${main} (${counts.completed}/${state.items.length})`;
}
function countTasks(state: TaskListState): { active: number; pending: number; completed: number } {
  let active = 0, pending = 0, completed = 0;
  for (const item of state.items) {
    if (typeof item.id !== 'string' || typeof item.content !== 'string') throw Error('任务列表格式不可用。');
    if (item.status === 'in_progress') active++;
    else if (item.status === 'pending') pending++;
    else if (item.status === 'completed') completed++;
    else throw Error('任务列表状态不可用。');
  }
  return { active, pending, completed };
}
function scheduledTaskLines(tasks: readonly TaskView[]): readonly string[] {
  if (!tasks.length) return ['没有定时任务。对话中说“每天早上8点提醒我…”可以创建任务。'];
  return [`定时任务 (${tasks.length} 个)`, ...tasks.flatMap(task => {
    const last = task.state.lastRunAt ? ` · 上次: ${task.state.lastStatus ?? '?'} ${formatRelativeTime(new Date(task.state.lastRunAt))}` : ' · 未执行过';
    const next = task.state.nextRunAt ? ` · 下次: ${new Date(task.state.nextRunAt).toLocaleString()}` : '';
    return [`${task.enabled ? '●' : '○'} ${plain(task.name)} (${plain(task.id)})`, `  ${plain(scheduleText(task.schedule))}${last}${next}`];
  })];
}
function scheduleText(schedule: TaskView['schedule']): string {
  switch (schedule.kind) {
    case 'once': return `一次性 ${new Date(schedule.at).toLocaleString()}`;
    case 'interval': return schedule.everyMs < 60_000 ? `每 ${Math.round(schedule.everyMs / 1000)} 秒`
      : schedule.everyMs < 3_600_000 ? `每 ${Math.round(schedule.everyMs / 60_000)} 分钟` : `每 ${Math.round(schedule.everyMs / 3_600_000)} 小时`;
    case 'cron': return `cron "${schedule.expr}"${schedule.tz ? ` (${schedule.tz})` : ''}`;
  }
}
function plain(text: string): string { return stripAnsi(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' '); }
function shortError(error: unknown): string { return plain(error instanceof Error ? error.message : String(error)).slice(0, 512); }
