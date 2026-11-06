import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// 用生产的 #interrupt 与 #stopShown 方法体核按键与处理之间的交错：按键时屏上的运行身份随请求带来，
// 能否停以处理时的权威状态为准；停不到时不退出终端，也不停后来的运行。
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const methods = ['#interrupt', '#stopShown', '#showResult'].map(name => owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name)!.getText(source)).join('\n');
const Fixture = new Function(ts.transpile(
  'class Fixture { mainView = {}; args = []; ' + methods.replace(/#/gu, '') + ' } return Fixture;',
  { target: ts.ScriptTarget.ES2022 },
))();

const ENDED = '这次运行已经结束，无需再停止。', REQUESTED = '已请求停止当前工作；已发生的动作不会回滚。';
function fixture(state: { local?: { conversationId: string; turnId: string; runId?: string; inputId?: string }; submitting?: boolean; submittingInputId?: string; active?: string[]; task?: boolean; conversationId?: string; followed?: string[] } = {}) {
  const target = new Fixture();
  target.activeTurn = state.local;
  target.submittingInput = state.submitting ?? false;
  target.submittingInputId = state.submittingInputId;
  target.requestRunStop = vi.fn(async () => !!state.local || !!state.submitting);
  target.controller = {
    current: { conversationId: state.conversationId ?? 'conv-1' },
    abortRunIfActive: vi.fn(async (runId: string) => (state.active ?? []).includes(runId)),
    abortWorksceneTask: vi.fn(async () => state.task ?? false),
    runLifecycles: vi.fn(() => [] as { runId: string; state: string; local?: boolean }[]),
    followsRun: vi.fn((runId: string) => (state.followed ?? []).includes(runId)),
  };
  target.publish = vi.fn(async () => {});
  target.close = vi.fn(async () => {});
  return target;
}

describe('Ctrl+C carries the run shown at the key press', () => {
  it('stops the shown local turn', async () => {
    const target = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a' } });
    await target.interrupt({ conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a' });
    expect(target.requestRunStop).toHaveBeenCalledWith('Ctrl+C');
    expect(target.close).not.toHaveBeenCalled();
  });

  it('stays open when the shown run ended before the request was handled', async () => {
    const target = fixture();
    await target.interrupt({ conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a' });
    expect(target.controller.abortRunIfActive).toHaveBeenCalledWith('run-a');
    expect(target.mainView.message).toBe(ENDED);
    expect(target.close).not.toHaveBeenCalled();
    expect(target.requestRunStop).not.toHaveBeenCalled();
  });

  it('does not stop a later local turn that started after the key press', async () => {
    const target = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-b', runId: 'run-b' }, active: ['run-b'] });
    await target.interrupt({ conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a' });
    expect(target.requestRunStop).not.toHaveBeenCalled();
    expect(target.controller.abortRunIfActive).toHaveBeenCalledWith('run-a');
    expect(target.mainView.message).toBe(ENDED);
    expect(target.close).not.toHaveBeenCalled();
  });

  it('neither stops nor exits after the conversation changed', async () => {
    const target = fixture({ conversationId: 'conv-2', local: { conversationId: 'conv-2', turnId: 'turn-b' }, active: ['run-a'] });
    await target.interrupt({ conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a' });
    expect(target.requestRunStop).not.toHaveBeenCalled();
    expect(target.controller.abortRunIfActive).not.toHaveBeenCalled();
    expect(target.mainView.message).toBe(ENDED);
    expect(target.close).not.toHaveBeenCalled();
  });

  it('stops a queued own input shown as waiting by its run identity, not the newer local turn', async () => {
    // 等待说明的主体是较早排队的输入：按它的运行身份停，不把较新的本地轮次当成它
    const target = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-new', runId: 'run-new' }, active: ['run-queued'] });
    await target.interrupt({ conversationId: 'conv-1', turnId: 'turn-queued', runId: 'run-queued' });
    expect(target.requestRunStop).not.toHaveBeenCalled();
    expect(target.controller.abortRunIfActive).toHaveBeenCalledWith('run-queued');
    expect(target.mainView.message).toBe(REQUESTED);
    expect(target.close).not.toHaveBeenCalled();
  });

  it('keeps the actual result when the stopped run ended before the stop request returned', async () => {
    // 排队中的输入被即时取消：终态先于请求回复到达，运行跟随已写出实际结果，不能再被“已请求”覆盖。
    // 跟随记录在终态到达时即释放，所以“有本地跟随”要在等待停止请求之前取
    const followed = ['run-queued'];
    const target = fixture({ active: ['run-queued'], followed });
    target.controller.abortRunIfActive = vi.fn(async () => {
      followed.length = 0;
      target.mainView = { ...target.mainView, message: '本次运行已中止。' };
      target.controller.runLifecycles = vi.fn(() => [{ runId: 'run-queued', state: 'terminal', local: true }]);
      return true;
    });
    expect(await target.stopShown({ conversationId: 'conv-1', turnId: 'turn-queued', runId: 'run-queued' }, 'Esc')).toBe(true);
    expect(target.mainView.message).toBe('本次运行已中止。');
    expect(target.close).not.toHaveBeenCalled();
  });

  it('states that the run has ended when nothing local will report the result', async () => {
    // 没有本地跟随：终端重开后的排队输入、其他接入面的运行，或本地运行以待确认结束后经 /resolve 重新执行（local 仍为真，跟随已结清）。
    // 请求返回时已是终态，只知道已结束，不说成已取消
    const target = fixture({ active: ['run-retried'] });
    target.controller.abortRunIfActive = vi.fn(async () => {
      target.controller.runLifecycles = vi.fn(() => [{ runId: 'run-retried', state: 'terminal', local: true }]);
      return true;
    });
    expect(await target.stopShown({ conversationId: 'conv-1', turnId: 'turn-old', runId: 'run-retried' }, 'Esc')).toBe(true);
    expect(target.mainView.message).toBe('这次运行已结束；已发生的动作不会回滚。');
    expect(target.close).not.toHaveBeenCalled();
  });

  it('stops an attached run that is still interruptible', async () => {
    const target = fixture({ active: ['run-a'] });
    await target.interrupt({ conversationId: 'conv-1', runId: 'run-a' });
    expect(target.mainView.message).toBe(REQUESTED);
    expect(target.close).not.toHaveBeenCalled();
  });

  it('stops the own submission in flight when the busy page had only its input identity', async () => {
    const target = fixture({ submitting: true, submittingInputId: 'input-a' });
    await target.interrupt({ conversationId: 'conv-1', inputId: 'input-a' });
    expect(target.requestRunStop).toHaveBeenCalledOnce();
    expect(target.close).not.toHaveBeenCalled();
  });

  it('does not stop a later run for an old busy key press that carried no identity', async () => {
    const target = fixture({ local: { conversationId: 'conv-1', turnId: 'later-turn', runId: 'later-run' }, active: ['later-run'] });
    await target.interrupt({ conversationId: 'conv-1' });
    expect(target.requestRunStop).not.toHaveBeenCalled();
    expect(target.controller.abortRunIfActive).not.toHaveBeenCalled();
    expect(target.mainView.message).toBe(ENDED);
    expect(target.close).not.toHaveBeenCalled();
  });

  it('does not stop a later turn or submission from a different input', async () => {
    const later = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-b', inputId: 'input-b' }, active: ['run-b'] });
    await later.interrupt({ conversationId: 'conv-1', inputId: 'input-a' });
    expect(later.requestRunStop).not.toHaveBeenCalled();
    const submitting = fixture({ submitting: true, submittingInputId: 'input-b' });
    await submitting.interrupt({ conversationId: 'conv-1', inputId: 'input-a' });
    expect(submitting.requestRunStop).not.toHaveBeenCalled();
    for (const target of [later, submitting]) { expect(target.mainView.message).toBe(ENDED); expect(target.close).not.toHaveBeenCalled(); }
  });

  it('requires turn and run identities to agree when both are given', async () => {
    const target = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-b' } });
    await target.interrupt({ conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a' });
    expect(target.requestRunStop).not.toHaveBeenCalled();
    expect(target.controller.abortRunIfActive).toHaveBeenCalledWith('run-a');
    expect(target.mainView.message).toBe(ENDED);
  });

  it('requires the input identity to agree with the matched turn when both are given', async () => {
    // 按键时屏上是 turn-a，同时带的输入身份却是另一份：不按“停当前”处理，只按精确运行身份停
    const turnOnly = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a', inputId: 'input-a' }, active: ['run-a'] });
    await turnOnly.interrupt({ conversationId: 'conv-1', turnId: 'turn-a', inputId: 'input-b' });
    expect(turnOnly.requestRunStop).not.toHaveBeenCalled();
    expect(turnOnly.controller.abortRunIfActive).not.toHaveBeenCalled();
    expect(turnOnly.mainView.message).toBe(ENDED);
    expect(turnOnly.close).not.toHaveBeenCalled();
    const withRun = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a', inputId: 'input-a' }, active: ['run-a'] });
    await withRun.interrupt({ conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a', inputId: 'input-b' });
    expect(withRun.requestRunStop).not.toHaveBeenCalled();
    expect(withRun.controller.abortRunIfActive).toHaveBeenCalledWith('run-a');
    expect(withRun.mainView.message).toBe(REQUESTED);
    const agreeing = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a', inputId: 'input-a' } });
    await agreeing.interrupt({ conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a', inputId: 'input-a' });
    expect(agreeing.requestRunStop).toHaveBeenCalledWith('Ctrl+C');
  });

  it('does not treat a missing local run identity as matching an older run', async () => {
    // 按键带旧运行 A 的 runId（无轮次）；处理时本地是新轮次 B、其运行身份尚未取得：不停 B，只按 A 查权威
    const later = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-b' } });
    await later.interrupt({ conversationId: 'conv-1', runId: 'run-a' });
    expect(later.requestRunStop).not.toHaveBeenCalled();
    expect(later.controller.abortRunIfActive).toHaveBeenCalledWith('run-a');
    expect(later.mainView.message).toBe(ENDED);
    expect(later.close).not.toHaveBeenCalled();
    // 同样，带输入身份时本地缺输入身份也不当作匹配；旧运行仍在可停目标里则只停它
    const stillActive = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-b' }, active: ['run-a'] });
    await stillActive.interrupt({ conversationId: 'conv-1', runId: 'run-a', inputId: 'input-a' });
    expect(stillActive.requestRunStop).not.toHaveBeenCalled();
    expect(stillActive.controller.abortRunIfActive).toHaveBeenCalledWith('run-a');
    expect(stillActive.mainView.message).toBe(REQUESTED);
    // 正例：本地已取得同一运行身份时照常停当前
    const matched = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a' } });
    await matched.interrupt({ conversationId: 'conv-1', runId: 'run-a' });
    expect(matched.requestRunStop).toHaveBeenCalledWith('Ctrl+C');
  });

  it('stops only the matched older turn by its run when a newer submission is in flight', async () => {
    const target = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a', inputId: 'input-a' }, submitting: true, submittingInputId: 'input-b', active: ['run-a'] });
    await target.interrupt({ conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a' });
    expect(target.requestRunStop).not.toHaveBeenCalled();
    expect(target.controller.abortRunIfActive).toHaveBeenCalledWith('run-a');
    expect(target.mainView.message).toBe(REQUESTED);
  });
});

describe('Ctrl+C when the page was idle at the key press', () => {
  it('closes the terminal when truly idle', async () => {
    const target = fixture();
    await target.interrupt();
    expect(target.close).toHaveBeenCalledWith(0, 'user-interrupt');
    expect(target.mainView.message).toBeUndefined();
  });

  it('does not stop a run that started after the idle key press', async () => {
    const target = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-b', runId: 'run-b' }, active: ['run-b'] });
    await target.interrupt();
    expect(target.requestRunStop).not.toHaveBeenCalled();
    expect(target.controller.abortRunIfActive).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalledWith(0, 'user-interrupt');
  });

  it('cancels its own submission still in flight instead of exiting', async () => {
    const target = fixture({ submitting: true });
    await target.interrupt();
    expect(target.requestRunStop).toHaveBeenCalledOnce();
    expect(target.close).not.toHaveBeenCalled();
  });

  it('stops entrusted work instead of exiting', async () => {
    const target = fixture({ task: true });
    await target.interrupt();
    expect(target.mainView.message).toBe(REQUESTED);
    expect(target.close).not.toHaveBeenCalled();
  });
});

describe('Esc uses the same decision and never exits', () => {
  it('reports an ended run without stopping a later one', async () => {
    const target = fixture({ local: { conversationId: 'conv-1', turnId: 'turn-b' }, active: ['run-b'] });
    expect(await target.stopShown({ conversationId: 'conv-1', turnId: 'turn-a', runId: 'run-a' }, 'Esc')).toBe(false);
    expect(target.requestRunStop).not.toHaveBeenCalled();
    expect(target.mainView.message).toBe(ENDED);
    expect(target.close).not.toHaveBeenCalled();
  });
});
