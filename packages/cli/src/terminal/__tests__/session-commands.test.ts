import { describe, expect, it, vi } from 'vitest';
import type { ActiveConversation, ConversationController, TurnOutcome } from '../../runtime/conversation-controller.js';
import type { RpcWorksceneFacade } from '../../runtime/rpc-workscene-facade.js';
import { TerminalSessionCommands, projectTerminalTurnOutcome, type TerminalTurnOutcome } from '../session-commands.js';
import type { TerminalSelectionPort } from '../selection.js';

function fixture() {
  let active: ActiveConversation = { conversationId: 'main-1', name: '主对话', mode: { kind: 'main' } };
  const controller = {
    get current() { return active; },
    newConversation: vi.fn(async () => active = { conversationId: 'main-2', name: '新对话', mode: { kind: 'main' } }),
    listConversations: vi.fn(async () => [{ conversationId: 'main-1', name: '主对话', lastActiveAt: '2026-10-06' }]),
    resume: vi.fn(async (id: string) => ({ active: active = { conversationId: id, name: id, mode: { kind: 'main' } } })),
    rename: vi.fn(async (name: string) => { active = { ...active, name }; }),
    clear: vi.fn(async () => {}), deleteConversation: vi.fn(async () => {}),
    enterScene: vi.fn(async (id: string) => ({ active: active = { conversationId: `ws:${id}:1`, name: '场景', mode: { kind: 'workscene', sceneId: id, sceneName: '场景' } } })),
    exitScene: vi.fn(async (target: ActiveConversation) => ({ kind: 'returned' as const, active: active = target })),
  };
  const workscene = { list: vi.fn(async () => [{ sceneId: 'scene-1', name: '场景' }]), rename: vi.fn(async () => ({})), delete: vi.fn(async () => {}) };
  const changed = vi.fn(async () => {}), publish = vi.fn(async () => {}), choose = vi.fn<TerminalSelectionPort>(async () => undefined);
  const deletedCurrent = vi.fn(), settleDelete = vi.fn(), deleting = vi.fn(() => settleDelete), createScene = vi.fn(async () => {});
  const owner = new TerminalSessionCommands({ controller: () => controller as unknown as ConversationController<TerminalTurnOutcome>,
    workscene: workscene as unknown as RpcWorksceneFacade, changed, publish, choose, deletedCurrent, deleting, createScene,
    activeTurn: () => null, signal: new AbortController().signal });
  return { owner, controller, workscene, changed, publish, choose, deletedCurrent, deleting, settleDelete, createScene };
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
  it('keeps completed, turn-limit, aborted and error outcomes distinct', () => {
    const project = (result: unknown) => projectTerminalTurnOutcome({ result: result as TurnOutcome['result'] });
    expect(project({ reason: 'completed' })).toEqual({ reason: 'completed', message: '本次运行已结束。' });
    expect(project({ reason: 'max_turns', maxTurns: 7 })).toEqual({ reason: 'max_turns', message: '本次运行已达到轮次上限（7）并停止。' });
    expect(project({ reason: 'aborted' }).message).toContain('中止');
    expect(project({ reason: 'error', error: { message: 'unavailable' } }).message).toBe('任务未完成：unavailable');
    expect(project({ reason: 'error', error: { message: 'x'.repeat(10000) } }).message.length).toBeLessThan(2100);
  });
});
