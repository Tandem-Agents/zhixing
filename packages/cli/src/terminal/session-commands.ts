import { NO_MATCH_HINT, type CommandDef, type ArgChoiceProvider } from '@zhixing-ai/core/typeahead';
import type { PostTurnControlOutcome } from '@zhixing-ai/core/types';
import { ADVANCEMENT_PROPOSED_NOTICE, describeAdvancementProposalStage } from '@zhixing-ai/core/advancement/proposal-messages';
import type { SessionAdvancementStateSnapshot } from '@zhixing-ai/rpc';
import type { ActiveConversation, ConversationController, TurnOutcome } from '../runtime/conversation-controller.js';
import type { RpcWorksceneFacade } from '../runtime/rpc-workscene-facade.js';
import { BUILTIN_COMMANDS } from '../commands/builtin-definitions.js';
import { boundedControlProjection } from '../runtime/control-projection.js';
import { formatRelativeTimeText } from '../commands/format.js';
import { modelFailureText } from './model-failure.js';
import type { TerminalSelectionPort } from './selection.js';

/** 场景内选 /work 的引导：进入路径、命令路径与候选空提示同一说明。 */
const SCENE_SWITCH_GUIDANCE = '已在工作场景中，请先 /exit 返回主对话。';
// “没有数据”的说明各按所在表面确实可用的动作写：候选面板有 Ctrl+N，选择页有“新建工作场景”选项
const NO_SCENES_PANEL = '暂无工作场景，Ctrl+N 新建';
const NO_SCENES_PAGE = '暂无工作场景，可选择“新建工作场景”。';
const NO_CONVERSATIONS = '暂无可切换对话';
const NO_MATCH_PAGE = '没有匹配项，可返回修改名称。';

type Navigation = Extract<PostTurnControlOutcome['intent'], { kind: 'enter' | 'exit' | 'set_workdir' }>;
export interface TerminalTurnOutcome {
  readonly reason: TurnOutcome['result']['reason'];
  readonly message: string;
  /** 这一轮以“结果待确认”结束：由状态行的持续义务说明承载，不再写进一次性说明，免得同一信息占两行 */
  readonly uncertain?: true;
  readonly bodyPending?: true;
  readonly control?: { readonly navigation?: Navigation; readonly handedOff: boolean; readonly conflict: boolean; readonly advancementProposal?: true };
}
export function projectCommittedTerminalOutcome(summary: import('@zhixing-ai/core/contracts').ConversationCommitSummary): TerminalTurnOutcome {
  // 提议运行结束不是任务完成：状态取推进领域的“已提出推进”
  return { reason: 'completed', message: summary.advancementProposal ? ADVANCEMENT_PROPOSED_NOTICE : '本次运行已提交。', bodyPending: true,
    control: { navigation: summary.navigation, handedOff: summary.handedOff, conflict: summary.conflict,
      ...(summary.advancementProposal ? { advancementProposal: true as const } : {}) } };
}

/** Keep navigation, never the task handoff body or the complete agent result. */
export function projectTerminalTurnOutcome(outcome: TurnOutcome): TerminalTurnOutcome {
  const result = outcome.result, reason = result.reason;
  let message: string;
  switch (result.reason) {
    case 'completed': message = '本次运行已结束。'; break;
    case 'max_turns': message = `本次运行已达到轮次上限（${result.maxTurns}）并停止。`; break;
    case 'aborted': message = '本次运行已中止。'; break;
    case 'error': {
      const text = modelFailureText(result.error.message);
      message = `任务未完成：${text.slice(0, 2048)}${text.length > 2048 ? '…（完整错误见运行记录）' : ''}`; break;
    }
    default: { const unhandled: never = result; throw Error(`terminal-turn-result:${unhandled}`); }
  }
  const control = outcome.postTurnControl, intent = control?.intent;
  if (result.reason === 'error' && result.error.name === 'RunUncertain') return { reason, message, uncertain: true };
  if (!control || !intent) return { reason, message };
  if (intent.kind === 'propose_advancement' && reason === 'completed') {
    return { reason, message: ADVANCEMENT_PROPOSED_NOTICE, control: { handedOff: false, conflict: !!control.conflict, advancementProposal: true } };
  }
  const handedOff = !!intent.handoff?.remaining.length;
  const navigation = handedOff ? undefined : intent.kind === 'enter' ? { kind: 'enter' as const, sceneId: intent.sceneId }
    : intent.kind === 'exit' ? { kind: 'exit' as const }
      : intent.kind === 'set_workdir' ? { kind: 'set_workdir' as const, sceneId: intent.sceneId, workspace: intent.workspace } : undefined;
  return boundedControlProjection({ reason, message, control: { navigation, handedOff, conflict: !!control.conflict } }, 16 * 1024);
}

export interface TerminalSessionOptions {
  readonly controller: () => ConversationController<TerminalTurnOutcome> | undefined;
  readonly workscene: RpcWorksceneFacade;
  readonly signal: AbortSignal;
  readonly choose: TerminalSelectionPort;
  /** 仍需用户留意的说明（失败、待核对、警告）：保持到被别的说明取代 */
  readonly publish: (message: string) => Promise<void>;
  /** 已结束、没有后续动作的结果：由应用持有凭据，下一次有效操作时撤回 */
  readonly result: (message: string) => Promise<void>;
  readonly changed: (advancement?: SessionAdvancementStateSnapshot) => Promise<void>;
  readonly activeTurn: () => Promise<unknown> | null;
  /** 返回实际创建的场景名；取消或未创建时为空。 */
  readonly createScene: (input: string, current: () => void) => Promise<string | undefined>;
  readonly deleting: (conversationId: string) => () => void;
  readonly deletedCurrent: () => void;
}

/** Surface navigation only. All durable effects stay in the existing facades. */
export class TerminalSessionCommands {
  #generation = 0;
  #mainReturn?: ActiveConversation;
  readonly commands: readonly CommandDef[];
  constructor(readonly options: TerminalSessionOptions) {
    const initial = options.controller()?.current;
    if (initial?.mode.kind === 'main') this.#mainReturn = { ...initial };
    // 场景内不提供跨场景切换与场景管理：/work 不列可进入项，空提示直接说明怎么做
    const inScene = () => { const mode = this.options.controller()?.current.mode.kind; return mode !== undefined && mode !== 'main'; };
    const provider = (command: 'resume' | 'work'): ArgChoiceProvider => ({
      mode: 'picker',
      get inlineActions() { return command !== 'work' ? { delete: true } : inScene() ? {} : { delete: true, rename: true, create: true }; },
      // 空态说明随本次结果返回，按这次读到的数据判断“没有数据”还是“过滤后没有匹配”
      list: async (context, abort) => {
        if (command === 'work' && inScene()) return { choices: [], emptyHint: SCENE_SWITCH_GUIDANCE };
        const scope = this.#scope();
        const entries = await this.#entries(command, context.query); scope.current();
        if (abort.aborted) return [];
        const query = context.query.toLocaleLowerCase();
        const choices = entries.filter(item => `${item.name} ${item.id}`.toLocaleLowerCase().includes(query)).slice(0, 100)
          .map(item => ({ value: item.id, label: item.name, description: item.description }));
        // /work 读到的是完整场景列表；/resume 由服务端按查询词过滤，不为计数另查
        const emptyHint = command === 'work' ? (entries.length ? NO_MATCH_HINT : NO_SCENES_PANEL) : query ? NO_MATCH_HINT : NO_CONVERSATIONS;
        return { choices, emptyHint };
      },
    });
    this.commands = ['new', 'name', 'clear', 'resume', 'work'].map(name => ({ ...BUILTIN_COMMANDS[`${name}:repl` as keyof typeof BUILTIN_COMMANDS],
      ...(name === 'resume' || name === 'work' ? { args: [{ kind: 'async-enum' as const, name: name === 'work' ? 'scene' : 'conversation',
        required: true, description: '名称或 ID', provider: provider(name) }] } : {}) }));
  }
  invalidate(): void { ++this.#generation; }
  #scope() {
    const controller = this.options.controller(), generation = this.#generation;
    if (!controller || this.options.signal.aborted) throw Error('连接不可用，请重新连接。');
    const conversationId = controller.current.conversationId;
    return { controller, conversationId, current: (switched = false) => {
      if (this.options.signal.aborted || this.options.controller() !== controller || generation !== this.#generation ||
          (!switched && controller.current.conversationId !== conversationId)) throw Error('对话已变化，请重新打开后操作。');
    } };
  }
  /**
   * 改名：就地字段，Enter 保存、Esc 取消，名称预填。initial 是带参数直接改名的值（不经字段先保存一次）。
   * 空值与保存失败都留在字段里：按提交时的值重开并写明原因，由用户修改或再次提交，不自动重试。
   * 未改变如实说明；取消不留结果（上一条结果已在本次操作受理时撤回）。每次等待后由 current() 核对上下文：
   * 换会话、断线、失效时流程随之结束，不重开旧字段、不改旧目标。
   */
  async #rename(page: { readonly title: string; readonly label: string; readonly original: string },
    initial: string | undefined, save: (value: string) => Promise<unknown>, current: () => void, saved: (value: string) => Promise<string>): Promise<void> {
    let value = initial, error: string | undefined;
    for (;;) {
      if (value === undefined || error !== undefined) {
        const response = await this.options.choose({ kind: 'selection', inline: true, title: page.title,
          field: { id: 'name', label: page.label, value: value ?? page.original, secret: false, ...(error !== undefined ? { error } : {}) },
          fieldSubmit: { id: 'save', label: '保存' }, cancelLabel: '取消' });
        current();
        if (response?.itemId !== 'save') return;
        value = response.input?.trim() ?? ''; error = undefined;
      }
      if (!value) { error = '名称不能为空。'; continue; }
      if (value === page.original) { await this.options.result('名称未改变。'); return; }
      try { await save(value); }
      catch (failure) {
        current();
        const reason = (failure instanceof Error ? failure.message : String(failure)).replace(/[。.\s]+$/u, '').slice(0, 200);
        error = `保存失败：${reason}。可修改后再按 Enter 保存，或按 Esc 取消。`;
        continue;
      }
      current();
      await this.options.result(await saved(value));
      return;
    }
  }
  async #entries(command: 'resume' | 'work', query?: string) {
    const entries = command === 'resume'
      ? (await this.options.controller()!.listConversationPage({ limit: 100, query })).conversations.map(item => ({ id: item.conversationId, name: item.name,
        description: item.advancementPreparing ? '升级校验中' : item.advancement?.status === 'awaiting-rubric-confirmation' ? '待确认推进任务'
          : item.advancement?.status === 'active' ? '推进中'
            : item.advancement ? describeAdvancementProposalStage(item.advancement.status) : formatRelativeTimeText(item.lastActiveAt) }))
      : (await this.options.workscene.list()).map(item => ({ id: item.sceneId, name: item.name,
        description: item.workspace ? [item.workspace.deviceName, item.workspace.workspaceName].filter(Boolean).join(' / ') : '未绑定工作区' }));
    return boundedControlProjection(entries, 1024 * 1024);
  }
  async run(name: string, argument: string): Promise<void> {
    const scope = this.#scope();
    const active = this.options.activeTurn(); if (active) await active.catch(() => {});
    scope.current();
    if (name === 'new') {
      const created = await scope.controller.newConversation(); scope.current(true);
      this.#mainReturn = created; await this.options.changed(); await this.options.result(`已创建新对话 ${created.name}`); return;
    }
    if (name === 'name') {
      await this.#rename({ title: '重命名对话', label: '新名称', original: scope.controller.current.name }, argument.trim() || undefined,
        value => scope.controller.rename(value), scope.current,
        async value => { await this.options.changed(); return `已改名为「${value}」。`; });
      return;
    }
    if (name === 'clear') {
      await scope.controller.clear(); scope.current(); await this.options.changed(); await this.options.result('对话历史已清空。'); return;
    }
    if (name === 'exit') { await this.navigate({ kind: 'exit' }); return; }
    if (name !== 'resume' && name !== 'work') throw Error('未知会话命令。');
    // 场景内不直接跨场景切换：这是规则引导不是故障，与进入路径同一说明
    if (name === 'work' && scope.controller.current.mode.kind !== 'main') { await this.options.result(SCENE_SWITCH_GUIDANCE); return; }
    if (name === 'resume') { await this.#resume(argument, scope); return; }
    const entries = await this.#entries(name); scope.current();
    const query = argument.trim().toLocaleLowerCase();
    const exact = entries.find(item => item.id === argument.trim());
    const matches = exact ? [exact] : entries.filter(item => !query || item.name.toLocaleLowerCase().includes(query));
    let target = query && matches.length === 1 ? matches[0] : undefined;
    if (!target) {
      let page = 0;
      for (;;) {
        const response = await this.options.choose({ kind: 'selection', title: name === 'work' ? '工作场景' : '切换对话',
          // 手里是完整场景列表：一个都没有时说暂无并指向新建，有场景而匹配为空才说没有匹配
          message: !matches.length ? (entries.length ? NO_MATCH_PAGE : NO_SCENES_PAGE) : `第 ${page + 1} 页`,
          choices: [...matches.slice(page * 20, page * 20 + 20).map(item => ({ id: item.id, label: item.name, detail: item.description })),
            ...(page ? [{ id: 'previous', label: '上一页' }] : []), ...(matches.length > (page + 1) * 20 ? [{ id: 'next', label: '下一页' }] : []),
            ...(name === 'work' ? [{ id: 'create', label: '新建工作场景' }] : []), { id: 'cancel', label: '返回' }] });
        scope.current();
        if (!response || response.cancelCause || response.itemId === 'cancel') return;
        if (response.itemId === 'previous') { page--; continue; }
        if (response.itemId === 'next') { page++; continue; }
        if (response.itemId === 'create') { await this.manage('work', 'create'); return; }
        target = matches.find(item => item.id === response.itemId); if (target) break;
      }
    }
    await this.navigate({ kind: 'enter', sceneId: target.id });
  }
  async #resume(argument: string, scope: { controller: ConversationController<TerminalTurnOutcome>; current(switched?: boolean): void }): Promise<void> {
    const pages: Array<import('@zhixing-ai/core/conversation/application').ConversationDirectoryCursor | undefined> = [undefined];
    for (;;) {
      const page = await scope.controller.listConversationPage({ limit: 20, after: pages.at(-1), query: argument.trim() || undefined }); scope.current();
      const exact = argument.trim() && page.conversations.find(item => item.conversationId === argument.trim());
      let target = exact || (argument.trim() && page.conversations.length === 1 && !page.next ? page.conversations[0] : undefined);
      if (!target) {
        // 服务端按查询词过滤：带查询词而为空是没有匹配，不带查询词而为空才是暂无
        const response = await this.options.choose({ kind: 'selection', title: '切换对话',
          message: page.conversations.length ? `第 ${pages.length} 页` : argument.trim() ? NO_MATCH_PAGE : `${NO_CONVERSATIONS}。`,
          choices: [...page.conversations.map(item => ({ id: item.conversationId, label: item.name, detail: item.lastActiveAt })),
            ...(pages.length > 1 ? [{ id: 'previous', label: '上一页' }] : []), ...(page.next ? [{ id: 'next', label: '下一页' }] : []), { id: 'cancel', label: '返回' }] });
        scope.current();
        if (!response || response.cancelCause || response.itemId === 'cancel') return;
        if (response.itemId === 'previous') { pages.pop(); continue; }
        if (response.itemId === 'next' && page.next) { pages.push(page.next); continue; }
        target = page.conversations.find(item => item.conversationId === response.itemId);
      }
      if (!target) continue;
      const resumed = await scope.controller.resume(target.conversationId); scope.current(true);
      if (resumed.active.mode.kind === 'main') this.#mainReturn = resumed.active;
      await this.options.changed(resumed.advancement);
      await (resumed.adoptionReview ? this.options.publish(resumed.adoptionReview.message) : this.options.result(`已切换到 ${resumed.active.name}`)); return;
    }
  }

  async navigate(intent: Navigation): Promise<void> {
    const scope = this.#scope(), controller = scope.controller;
    if (intent.kind === 'enter') {
      if (controller.current.mode.kind !== 'main') { await this.options.result(SCENE_SWITCH_GUIDANCE); return; }
      this.#mainReturn = { ...controller.current };
      const entered = await controller.enterScene(intent.sceneId); scope.current(true);
      await this.options.changed(entered.advancement); await this.options.result(`已进入工作场景 ${entered.active.name}`); return;
    }
    if (intent.kind === 'set_workdir') {
      const changed = await controller.setCurrentSceneWorkdirAndReenter(intent.sceneId, intent.workspace); scope.current(true);
      if (changed.kind === 'reentered') {
        await this.options.changed(changed.advancement); await (changed.scene.workspaceWarning ? this.options.publish(changed.scene.workspaceWarning) : this.options.result('工作场景配置已更新。')); return;
      }
      if (changed.kind === 'set-failed' || changed.kind === 'scene-mismatch') {
        await this.options.publish(changed.kind === 'set-failed' ? '工作区更改失败，仍在原场景。' : '场景请求已过期，请重新核对。'); return;
      }
    }
    if (controller.current.mode.kind !== 'workscene') return;
    if (!this.#mainReturn) throw Error('返回主对话的身份不可用，请用 /resume 选择主对话。');
    const target = this.#mainReturn;
    const exited = await controller.exitScene(target); scope.current(true);
    this.#mainReturn = exited.active;
    await this.options.changed(exited.kind === 'not-in-workscene' ? undefined : exited.advancement);
    await this.options.result(exited.kind === 'fallback-new' ? '原主对话已不存在，已创建新主对话。'
      : exited.kind === 'fallback-latest' ? '原主对话已不存在，已回到最近主对话。' : '已退出工作场景，返回主对话。');
  }
  /** label 是候选上显示的当前名称：改名时预填并点明改的是哪个场景。 */
  async manage(command: 'resume' | 'work', action: 'delete' | 'rename' | 'create', id?: string, label?: string): Promise<void> {
    const scope = this.#scope();
    if (action === 'create' || action === 'rename') {
      if (command !== 'work') throw Error('当前候选不支持此操作。');
      if (action === 'rename') {
        // 改的是候选里选中的场景，不一定是屏上这个对话：标题写明对象
        if (!id) throw Error('候选已失效。');
        const current = label?.trim() ?? '';
        await this.#rename({ title: current ? `重命名工作场景「${current}」` : '重命名工作场景', label: '新的场景名称', original: current }, undefined,
          value => this.options.workscene.rename(id, value), scope.current, async value => `工作场景已改名为「${value}」。`);
        return;
      }
      // 新建：整页保留说明；空提交留在页面说明，不当作取消
      let value = '', error: string | undefined;
      for (;;) {
        const response = await this.options.choose({ kind: 'selection', title: '新建工作场景',
          field: { id: 'scene', secret: false, label: '描述用途和工作目录，或输入名称', value, ...(error ? { error } : {}) },
          fieldSubmit: { id: 'save', label: '继续创建' }, cancelLabel: '取消' });
        scope.current();
        if (response?.itemId !== 'save') return;
        value = response.input?.trim() ?? '';
        if (value) break;
        error = '请描述用途和工作目录，或输入名称。';
      }
      const created = await this.options.createScene(value, () => scope.current());
      if (created) await this.options.result(`已创建工作场景「${created}」。`);
      return;
    }
    if (!id) throw Error('候选已失效。');
    if (command === 'work') { await this.options.workscene.delete(id); scope.current(); return; }
    const current = id === scope.conversationId, finish = this.options.deleting(id);
    let deleted = false;
    try {
      await scope.controller.deleteConversation(id); deleted = true; scope.current();
      if (current) {
        await scope.controller.newConversation(); scope.current(true); await this.options.changed();
      }
    } catch (error) {
      if (current && deleted && scope.controller.current.conversationId === id) this.options.deletedCurrent();
      throw error;
    } finally { finish(); }
  }
}
