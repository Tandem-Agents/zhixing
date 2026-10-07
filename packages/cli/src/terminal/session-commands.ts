import type { CommandDef, ArgChoiceProvider } from '@zhixing/core/typeahead';
import type { PostTurnControlOutcome } from '@zhixing/core/types';
import type { SessionAdvancementStateSnapshot } from '@zhixing/rpc';
import type { ActiveConversation, ConversationController, TurnOutcome } from '../runtime/conversation-controller.js';
import type { RpcWorksceneFacade } from '../runtime/rpc-workscene-facade.js';
import { BUILTIN_COMMANDS } from '../commands/builtin-definitions.js';
import { boundedControlProjection } from '../runtime/control-projection.js';
import type { TerminalSelectionPort } from './selection.js';

type Navigation = Extract<PostTurnControlOutcome['intent'], { kind: 'enter' | 'exit' | 'set_workdir' }>;
export interface TerminalTurnOutcome {
  readonly message: string;
  readonly control?: { readonly navigation?: Navigation; readonly handedOff: boolean; readonly conflict: boolean };
}

/** Keep navigation, never the task handoff body or the complete agent result. */
export function projectTerminalTurnOutcome(outcome: TurnOutcome): TerminalTurnOutcome {
  const error = outcome.result.reason === 'error' ? outcome.result.error.message : undefined;
  const message = error === undefined ? outcome.result.reason === 'aborted' ? '本次运行已中止。' : '本次运行已结束。'
    : `任务未完成：${error.slice(0, 2048)}${error.length > 2048 ? '…（完整错误见运行记录）' : ''}`;
  const control = outcome.postTurnControl, intent = control?.intent;
  if (!control || !intent) return { message };
  const handedOff = !!intent.handoff?.remaining.length;
  const navigation = handedOff ? undefined : intent.kind === 'enter' ? { kind: 'enter' as const, sceneId: intent.sceneId }
    : intent.kind === 'exit' ? { kind: 'exit' as const }
      : intent.kind === 'set_workdir' ? { kind: 'set_workdir' as const, sceneId: intent.sceneId, workspace: intent.workspace } : undefined;
  return boundedControlProjection({ message, control: { navigation, handedOff, conflict: !!control.conflict } }, 16 * 1024);
}

export interface TerminalSessionOptions {
  readonly controller: () => ConversationController<TerminalTurnOutcome> | undefined;
  readonly workscene: RpcWorksceneFacade;
  readonly signal: AbortSignal;
  readonly choose: TerminalSelectionPort;
  readonly publish: (message: string) => Promise<void>;
  readonly changed: (advancement?: SessionAdvancementStateSnapshot) => Promise<void>;
  readonly activeTurn: () => Promise<unknown> | null;
  readonly createScene: (input: string, current: () => void) => Promise<void>;
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
    const provider = (command: 'resume' | 'work'): ArgChoiceProvider => ({
      mode: 'picker', inlineActions: command === 'work' ? { delete: true, rename: true, create: true } : { delete: true },
      emptyHint: command === 'work' ? '暂无工作场景，Ctrl+N 新建' : '暂无可切换对话',
      list: async (context, abort) => {
        const scope = this.#scope();
        const entries = await this.#entries(command); scope.current();
        if (abort.aborted) return [];
        const query = context.query.toLocaleLowerCase();
        return entries.filter(item => `${item.name} ${item.id}`.toLocaleLowerCase().includes(query)).slice(0, 100)
          .map(item => ({ value: item.id, label: item.name, description: item.description }));
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
  async #entries(command: 'resume' | 'work') {
    const entries = command === 'resume'
      ? (await this.options.controller()!.listConversations()).map(item => ({ id: item.conversationId, name: item.name,
        description: item.advancement?.status === 'awaiting-rubric-confirmation' ? '待确认推进任务' : item.advancement?.status === 'active' ? '推进中' : item.lastActiveAt }))
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
      this.#mainReturn = created; await this.options.changed(); await this.options.publish(`已创建新对话 ${created.name}`); return;
    }
    if (name === 'name') {
      let value = argument.trim();
      if (!value) {
        const response = await this.options.choose({ kind: 'selection', title: '对话名称', field: { id: 'name', label: '输入新名称', value: scope.controller.current.name, secret: false },
          choices: [{ id: 'save', label: '保存名称' }, { id: 'cancel', label: '取消' }] }); scope.current();
        if (response?.itemId !== 'save') return;
        value = response.input?.trim() ?? '';
      }
      if (!value) return;
      await scope.controller.rename(value); scope.current(); await this.options.changed(); await this.options.publish('名称已保存。'); return;
    }
    if (name === 'clear') {
      await scope.controller.clear(); scope.current(); await this.options.changed(); await this.options.publish('对话历史已清空。'); return;
    }
    if (name === 'exit') { await this.navigate({ kind: 'exit' }); return; }
    if (name !== 'resume' && name !== 'work') throw Error('未知会话命令。');
    if (name === 'work' && scope.controller.current.mode.kind !== 'main') throw Error('已在工作场景中，请先 /exit 返回主对话。');
    const entries = await this.#entries(name); scope.current();
    const query = argument.trim().toLocaleLowerCase();
    const exact = entries.find(item => item.id === argument.trim());
    const matches = exact ? [exact] : entries.filter(item => !query || item.name.toLocaleLowerCase().includes(query));
    let target = query && matches.length === 1 ? matches[0] : undefined;
    if (!target) {
      let page = 0;
      for (;;) {
        const response = await this.options.choose({ kind: 'selection', title: name === 'work' ? '工作场景' : '切换对话',
          message: !matches.length ? '没有匹配项，可返回修改名称。' : `第 ${page + 1} 页`,
          choices: [...matches.slice(page * 20, page * 20 + 20).map(item => ({ id: item.id, label: item.name, detail: item.description })),
            ...(page ? [{ id: 'previous', label: '上一页' }] : []), ...(matches.length > (page + 1) * 20 ? [{ id: 'next', label: '下一页' }] : []),
            ...(name === 'work' ? [{ id: 'create', label: '新建工作场景' }] : []), { id: 'cancel', label: '返回' }] });
        scope.current();
        if (!response || response.itemId === 'cancel') return;
        if (response.itemId === 'previous') { page--; continue; }
        if (response.itemId === 'next') { page++; continue; }
        if (response.itemId === 'create') { await this.manage('work', 'create'); return; }
        target = matches.find(item => item.id === response.itemId); if (target) break;
      }
    }
    if (name === 'work') { await this.navigate({ kind: 'enter', sceneId: target.id }); return; }
    const resumed = await scope.controller.resume(target.id); scope.current(true);
    if (resumed.active.mode.kind === 'main') this.#mainReturn = resumed.active;
    await this.options.changed(resumed.advancement);
    await this.options.publish(resumed.adoptionReview?.message ?? `已切换到 ${resumed.active.name}`);
  }
  async navigate(intent: Navigation): Promise<void> {
    const scope = this.#scope(), controller = scope.controller;
    if (intent.kind === 'enter') {
      if (controller.current.mode.kind !== 'main') { await this.options.publish('已在工作场景中，请先 /exit 返回主对话。'); return; }
      this.#mainReturn = { ...controller.current };
      const entered = await controller.enterScene(intent.sceneId); scope.current(true);
      await this.options.changed(entered.advancement); await this.options.publish(`已进入工作场景 ${entered.active.name}`); return;
    }
    if (intent.kind === 'set_workdir') {
      const changed = await controller.setCurrentSceneWorkdirAndReenter(intent.sceneId, intent.workspace); scope.current(true);
      if (changed.kind === 'reentered') {
        await this.options.changed(changed.advancement); await this.options.publish(changed.scene.workspaceWarning ?? '工作场景配置已更新。'); return;
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
    await this.options.publish(exited.kind === 'fallback-new' ? '原主对话已不存在，已创建新主对话。'
      : exited.kind === 'fallback-latest' ? '原主对话已不存在，已回到最近主对话。' : '已退出工作场景，返回主对话。');
  }
  async manage(command: 'resume' | 'work', action: 'delete' | 'rename' | 'create', id?: string): Promise<void> {
    const scope = this.#scope();
    if (action === 'create' || action === 'rename') {
      if (command !== 'work') throw Error('当前候选不支持此操作。');
      const response = await this.options.choose({ kind: 'selection', title: action === 'create' ? '新建工作场景' : '工作场景改名',
        field: { id: 'scene', secret: false, label: action === 'create' ? '描述用途和工作目录，或输入名称' : '输入新名称' },
        choices: [{ id: 'save', label: action === 'create' ? '继续创建' : '保存名称' }, { id: 'cancel', label: '取消' }] });
      scope.current();
      if (response?.itemId !== 'save' || !response.input?.trim()) return;
      if (action === 'create') await this.options.createScene(response.input.trim(), () => scope.current());
      else { if (!id) throw Error('候选已失效。'); await this.options.workscene.rename(id, response.input.trim()); scope.current(); }
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
