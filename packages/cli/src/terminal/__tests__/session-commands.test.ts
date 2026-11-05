import { describe, expect, it, vi } from 'vitest';
import { type ActiveConversation, type ConversationController, type TurnOutcome } from '../../runtime/conversation-controller.js';
import { type RpcWorksceneFacade } from '../../runtime/rpc-workscene-facade.js';
import { TerminalSessionCommands, projectCommittedTerminalOutcome, projectTerminalTurnOutcome, type TerminalTurnOutcome } from '../session-commands.js';
import { ADVANCEMENT_PROPOSED_NOTICE } from '@zhixing/core/advancement/proposal-messages';
import { type TerminalSelectionPort } from '../selection.js';
import { TerminalCandidatesOwner } from '../candidates.js';

function fixture() {
  let active: ActiveConversation = { conversationId: 'main-1', name: '主对话', mode: { kind: 'main' } };
  const controller = {
    get current() { return active; },
    newConversation: vi.fn(async () => active = { conversationId: 'main-2', name: '新对话', mode: { kind: 'main' } }),
    listConversationPage: vi.fn(async () => ({ conversations: [{ conversationId: 'main-1', name: '主对话', lastActiveAt: '2026-10-06' }] })),
    resume: vi.fn(async (id: string) => ({ active: active = { conversationId: id, name: id, mode: { kind: 'main' } } })),
    rename: vi.fn(async (name: string) => { active = { ...active, name }; }),
    clear: vi.fn(async () => {}), deleteConversation: vi.fn(async () => {}),
    enterScene: vi.fn(async (id: string) => ({ active: active = { conversationId: `ws:${id}:1`, name: '场景', mode: { kind: 'workscene', sceneId: id, sceneName: '场景' } } })),
    exitScene: vi.fn(async (target: ActiveConversation) => ({ kind: 'returned' as const, active: active = target })),
  };
  const workscene = { list: vi.fn(async () => [{ sceneId: 'scene-1', name: '场景' }]), rename: vi.fn(async () => ({})), delete: vi.fn(async () => {}) };
  const changed = vi.fn(async () => {}), publish = vi.fn(async () => {}), choose = vi.fn<TerminalSelectionPort>(async () => undefined), result = vi.fn(async () => {});
  const deletedCurrent = vi.fn(), settleDelete = vi.fn(), deleting = vi.fn(() => settleDelete), createScene = vi.fn(async (): Promise<string | undefined> => undefined);
  const owner = new TerminalSessionCommands({ controller: () => controller as unknown as ConversationController<TerminalTurnOutcome>,
    workscene: workscene as unknown as RpcWorksceneFacade, changed, publish, result, choose, deletedCurrent, deleting, createScene,
    activeTurn: () => null, signal: new AbortController().signal });
  return { owner, controller, workscene, changed, publish, result, choose, deletedCurrent, deleting, settleDelete, createScene };
}

describe('terminal session navigation', () => {
  it('returns from a scene to the exact main conversation that preceded it', async () => {
    const f = fixture();
    await f.owner.run('work', 'scene-1');
    expect(f.controller.current.mode.kind).toBe('workscene');
    await f.owner.run('exit', '');
    expect(f.controller.exitScene).toHaveBeenCalledWith({ conversationId: 'main-1', name: '主对话', mode: { kind: 'main' } });
    expect(f.controller.current.conversationId).toBe('main-1'); expect(f.changed).toHaveBeenCalledTimes(2);
  });
  it('guides instead of failing when /work targets another scene from inside a scene', async () => {
    const f = fixture();
    await f.owner.run('work', 'scene-1');
    await expect(f.owner.run('work', 'scene-2')).resolves.toBeUndefined();
    expect(f.result).toHaveBeenLastCalledWith('已在工作场景中，请先 /exit 返回主对话。'); expect(f.publish).not.toHaveBeenCalled();
    expect(f.controller.enterScene).toHaveBeenCalledTimes(1);
  });
  it('lists and manages scenes only from the main conversation; inside a scene /work shows the guidance', async () => {
    const f = fixture();
    f.workscene.list.mockResolvedValue([{ sceneId: 'scene-1', name: '场景' }, { sceneId: 'scene-2', name: '另一场景' }]);
    const source = new TerminalCandidatesOwner(() => ({ cwd: process.cwd(), target: 'cli', features: { chrome: true }, now: 0, workspaceId: null, sessionBusy: false }));
    source.bindCommands(f.owner.commands);
    expect(await source.query(1, '/work ', 6)).toMatchObject({ canDelete: true, canRename: true, canCreate: true,
      hint: 'Esc 返回 · Enter 进入 · Ctrl+D 删除 · Ctrl+R 改名 · Ctrl+N 新建', items: [{ label: '场景' }, { label: '另一场景' }] });
    // 空列表只列此刻可用的操作，空提示在列表里
    f.workscene.list.mockResolvedValueOnce([]);
    expect(await source.query(2, '/work ', 6)).toMatchObject({ items: [], argumentHint: '暂无工作场景，Ctrl+N 新建', hint: 'Esc 返回 · Ctrl+N 新建' });
    await f.owner.run('work', 'scene-1');
    const inScene = await source.query(3, '/work ', 6);
    expect(inScene).toMatchObject({ items: [], argumentHint: '已在工作场景中，请先 /exit 返回主对话。', canDelete: false, canRename: false, canCreate: false, hint: 'Esc 返回' });
    expect(() => source.manage(3, 'create')).toThrow('不支持');
  });
  it('renames the selected scene in place, naming that scene rather than the visible conversation', async () => {
    const f = fixture(); f.choose.mockResolvedValueOnce({ itemId: 'save', input: '新名' } as never);
    await f.owner.manage('work', 'rename', 'scene-1', '场景');
    const page = f.choose.mock.calls[0]![0];
    expect(page).toMatchObject({ inline: true, title: '重命名工作场景「场景」', field: { value: '场景', label: '新的场景名称' }, fieldSubmit: { id: 'save', label: '保存' }, cancelLabel: '取消' });
    expect(page).not.toHaveProperty('choices');
    expect(f.workscene.rename).toHaveBeenCalledWith('scene-1', '新名'); expect(f.result).toHaveBeenLastCalledWith('工作场景已改名为「新名」。');
  });
  it('renames the conversation in place: a single field with save and cancel, no action list', async () => {
    const f = fixture(); f.choose.mockResolvedValueOnce({ itemId: 'save', input: '  新名称  ' } as never);
    await f.owner.run('name', '');
    const page = f.choose.mock.calls[0]![0];
    expect(page).toMatchObject({ kind: 'selection', inline: true, title: '重命名对话', field: { id: 'name', value: '主对话' }, fieldSubmit: { id: 'save', label: '保存' }, cancelLabel: '取消' });
    expect(page).not.toHaveProperty('choices');
    expect(f.controller.rename).toHaveBeenCalledWith('新名称'); expect(f.changed).toHaveBeenCalled();
    expect(f.result).toHaveBeenLastCalledWith('已改名为「新名称」。');
  });
  it('keeps an empty or failed save in the field with the submitted value and the reason, and never retries by itself', async () => {
    const f = fixture();
    f.choose.mockResolvedValueOnce({ itemId: 'save', input: '   ' } as never)
      .mockResolvedValueOnce({ itemId: 'save', input: '坏名' } as never)
      .mockResolvedValueOnce({ itemId: 'save', input: '好名' } as never);
    f.controller.rename.mockRejectedValueOnce(Error('名称含不支持的字符。'));
    await f.owner.run('name', '');
    const pages = f.choose.mock.calls.map(([page]) => page);
    expect(pages).toHaveLength(3);
    expect(pages[1]).toMatchObject({ field: { value: '', error: '名称不能为空。' } });
    expect(pages[2]).toMatchObject({ field: { value: '坏名', error: '保存失败：名称含不支持的字符。可修改后再按 Enter 保存，或按 Esc 取消。' } });
    expect(f.controller.rename.mock.calls.map(([name]) => name)).toEqual(['坏名', '好名']);
    expect(f.result).toHaveBeenLastCalledWith('已改名为「好名」。');
  });
  it('opens the field with the submitted value when a direct /name argument fails', async () => {
    const f = fixture(); f.controller.rename.mockRejectedValueOnce(Error('暂不可用'));
    await f.owner.run('name', '想要的名字');
    expect(f.choose.mock.calls[0]![0]).toMatchObject({ field: { value: '想要的名字', error: '保存失败：暂不可用。可修改后再按 Enter 保存，或按 Esc 取消。' } });
    expect(f.publish).not.toHaveBeenCalled(); expect(f.result).not.toHaveBeenCalled();
  });
  it('says nothing changed for the same name, and a cancel leaves no result of its own', async () => {
    const f = fixture();
    await f.owner.run('name', '改过');
    expect(f.result).toHaveBeenLastCalledWith('已改名为「改过」。');
    f.choose.mockResolvedValueOnce({ itemId: 'save', input: '改过' } as never);
    await f.owner.run('name', '');
    expect(f.result).toHaveBeenLastCalledWith('名称未改变。'); expect(f.controller.rename).toHaveBeenCalledTimes(1);
    // 上一条结果由应用在本次命令受理时撤回（见 application-operation-result.test.ts）；取消本身不发布任何说明
    f.result.mockClear();
    f.choose.mockResolvedValueOnce({ itemId: 'cancelled', cancelCause: 'escape' } as never);
    await f.owner.run('name', '');
    expect(f.result).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });
  it('ends the rename when the conversation changes while saving, without reopening the old field', async () => {
    const f = fixture();
    f.choose.mockResolvedValueOnce({ itemId: 'save', input: '新名' } as never);
    f.controller.rename.mockImplementationOnce(async () => { await f.controller.newConversation(); throw Error('对话已切换'); });
    await expect(f.owner.run('name', '')).rejects.toThrow('对话已变化');
    expect(f.choose).toHaveBeenCalledTimes(1); expect(f.publish).not.toHaveBeenCalled(); expect(f.result).not.toHaveBeenCalled();
  });
  it('keeps an empty new-scene description on its page instead of treating it as a cancel', async () => {
    const f = fixture();
    f.choose.mockResolvedValueOnce({ itemId: 'save', input: '' } as never).mockResolvedValueOnce({ itemId: 'save', input: '论文场景' } as never);
    f.createScene.mockResolvedValueOnce('论文');
    await f.owner.manage('work', 'create');
    const pages = f.choose.mock.calls.map(([page]) => page);
    expect(pages[0]).toMatchObject({ title: '新建工作场景', fieldSubmit: { id: 'save', label: '继续创建' }, cancelLabel: '取消' });
    expect(pages[0]).not.toHaveProperty('inline'); expect(pages[0]).not.toHaveProperty('choices');
    expect(pages[1]).toMatchObject({ field: { error: '请描述用途和工作目录，或输入名称。' } });
    expect(f.createScene).toHaveBeenCalledWith('论文场景', expect.any(Function));
  });
  it('reports a created scene by name and stays quiet when nothing was created', async () => {
    const f = fixture(); f.choose.mockResolvedValue({ itemId: 'save', input: '用途说明' } as never);
    f.createScene.mockResolvedValueOnce('页面场景');
    await f.owner.manage('work', 'create'); expect(f.result).toHaveBeenLastCalledWith('已创建工作场景「页面场景」。');
    f.result.mockClear(); await f.owner.manage('work', 'create'); expect(f.result).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });
  it('keeps a local delete echo owned until a replacement conversation is installed', async () => {
    const f = fixture();
    await f.owner.manage('resume', 'delete', 'main-1');
    expect(f.deleting).toHaveBeenCalledWith('main-1');
    expect(f.controller.deleteConversation).toHaveBeenCalledWith('main-1');
    expect(f.controller.current.conversationId).toBe('main-2'); expect(f.settleDelete).toHaveBeenCalledOnce();
    expect(f.deletedCurrent).not.toHaveBeenCalled();
  });
  it('leaves an explicitly recoverable deleted-current state if replacement fails', async () => {
    const f = fixture(); f.controller.newConversation.mockRejectedValueOnce(Error('unavailable'));
    await expect(f.owner.manage('resume', 'delete', 'main-1')).rejects.toThrow('unavailable');
    expect(f.deletedCurrent).toHaveBeenCalledOnce(); expect(f.settleDelete).toHaveBeenCalledOnce();
  });
  it('does not rename or create after a modal response from an invalidated context', async () => {
    const f = fixture();
    let finish!: (value: { itemId: string; input: string }) => void;
    f.choose.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    const running = f.owner.manage('work', 'rename', 'scene-1');
    f.owner.invalidate(); finish({ itemId: 'save', input: '另一场景' });
    await expect(running).rejects.toThrow('对话已变化'); expect(f.workscene.rename).not.toHaveBeenCalled();
  });
  it('a cancelled scene editor does not create a scene or authorize a workspace', async () => {
    const f = fixture(); await f.owner.manage('work', 'create');
    expect(f.createScene).not.toHaveBeenCalled();
  });
  it('retains only bounded navigation and the handoff fact from a completed turn', () => {
    const result = { reason: 'completed' } as unknown as TurnOutcome['result'];
    expect(projectTerminalTurnOutcome({ result, postTurnControl: { intent: { kind: 'enter', sceneId: 'scene-1' } } }).control?.navigation)
      .toEqual({ kind: 'enter', sceneId: 'scene-1' });
    const outcome = projectTerminalTurnOutcome({ result, postTurnControl: { intent: { kind: 'enter', sceneId: 'scene-1',
      handoff: { goal: 'x'.repeat(1024 * 1024), constraints: [], completed: [], remaining: ['continue'] } } } });
    expect(outcome.control).toEqual({ handedOff: true, navigation: undefined, conflict: false });
    expect(JSON.stringify(outcome).length).toBeLessThan(512);
  });
  it('shows a proposing run as proposed, not completed, from both the live intent and the committed summary', () => {
    const result = { reason: 'completed' } as unknown as TurnOutcome['result'];
    expect(projectTerminalTurnOutcome({ result, postTurnControl: { intent: { kind: 'propose_advancement' } } }))
      .toEqual({ reason: 'completed', message: ADVANCEMENT_PROPOSED_NOTICE, control: { handedOff: false, conflict: false, advancementProposal: true } });
    expect(projectCommittedTerminalOutcome({ runIndex: 1, handedOff: false, conflict: false, advancementProposal: true }))
      .toMatchObject({ message: ADVANCEMENT_PROPOSED_NOTICE, control: { advancementProposal: true } });
    expect(projectCommittedTerminalOutcome({ runIndex: 1, handedOff: false, conflict: false }).control).not.toHaveProperty('advancementProposal');
  });
  it('keeps completed, turn-limit, aborted and error outcomes distinct', () => {
    const project = (result: unknown) => projectTerminalTurnOutcome({ result: result as TurnOutcome['result'] });
    expect(project({ reason: 'completed' })).toEqual({ reason: 'completed', message: '本次运行已结束。' });
    expect(project({ reason: 'max_turns', maxTurns: 7 })).toEqual({ reason: 'max_turns', message: '本次运行已达到轮次上限（7）并停止。' });
    expect(project({ reason: 'aborted' }).message).toContain('中止');
    expect(project({ reason: 'error', error: { message: 'unavailable' } }).message).toBe('任务未完成：unavailable');
    expect(project({ reason: 'error', error: { message: 'x'.repeat(10000) } }).message.length).toBeLessThan(2100);
  });
  it('explains a model service connection failure instead of showing the SDK text', () => {
    const project = (message: string) => projectTerminalTurnOutcome({ result: { reason: 'error', error: { message }, usage: { inputTokens: 0, outputTokens: 0 } } as TurnOutcome['result'] }).message;
    expect(project('Connection error.')).toBe('任务未完成：无法连接模型服务：请检查网络、代理或服务地址后重试。');
    expect(project('Request timed out.')).toContain('模型服务响应超时');
    // 已是中文说明或未知原因的保持原文
    expect(project('当前模型不支持图片输入。请切换到支持图片输入的模型，或移除图片后重试。')).toBe('任务未完成：当前模型不支持图片输入。请切换到支持图片输入的模型，或移除图片后重试。');
  });
  it('states the real first cause before a budget stop and explains a real budget exhaustion', () => {
    const project = (message: string) => projectTerminalTurnOutcome({ result: { reason: 'error', error: { message }, usage: { inputTokens: 0, outputTokens: 0 } } as TurnOutcome['result'] }).message;
    expect(project('Model usage budget exhausted while retrying after: Connection error.'))
      .toBe('任务未完成：无法连接模型服务：请检查网络、代理或服务地址后重试。（重试时本次运行的模型用量已达上限，已停止重试。）');
    expect(project('Resource commitments tokens exceeds budget'))
      .toBe('任务未完成：本次运行的模型用量已达上限，已停止：发送新消息会按新的额度继续；对话很长时可先用 /compact 整理上下文。');
  });
});
