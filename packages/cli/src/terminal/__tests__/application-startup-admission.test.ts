import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// 生产的提交入口、后台操作、视图发布与启动末段（启动尝试开头 + await displayPrepared 之后到方法结束）原样运行，
// 只替换传输、验收方式处理与确认核对的异步闸门：可发送帧与实际准入门必须一致。
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const method = (name: string) => {
  const node = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  if (!node) throw Error(`Missing production method ${name}`);
  return node.getText(source);
};
const methods = ['#action', '#background', '#publish', '#ownsPage', '#unavailable', '#confirmationRefreshFailed'].map(method).join('\n').replace(/#/gu, '');
const startup = method('#startup');
const prologueStart = startup.indexOf('const attempt = {};'), finishLine = startup.indexOf('const finish =');
const tailStart = startup.indexOf('await displayPrepared;');
if (prologueStart < 0 || finishLine < 0 || tailStart < 0) throw Error('Startup completion segment not found');
const prologue = startup.slice(prologueStart, startup.indexOf('\n', finishLine)).replace(/#/gu, '');
const tail = startup.slice(tailStart, startup.lastIndexOf('}')).replace(/#/gu, '');
const failures: { error: unknown; code: string }[] = [];
const Fixture = new Function('terminalEnvironment', 'recordTerminalFailure', 'ConfigurationEditPendingError', ts.transpile(`class Fixture {
  args = []; abort = new AbortController(); generation = 0; logging = { records: undefined };
  mainView = { kind: 'conversation', title: 'chat', message: '已恢复最近对话。', connected: true };
  connection = { getStatus: () => ({ kind: 'connected' }) };
  submitted = [];
  noticeResumes = 0;
  drainConfirmations() {} resumeNoticeDisplay() { this.noticeResumes++; } invalidateAuxiliary() {} close() { return Promise.resolve(); }
  skillsFailed() {} ensureSkillsBinding() { return Promise.resolve({ commands: { refresh: async () => {} } }); }
  async submit(inputId) { this.submitted.push(inputId); }
  async resolveRubric() {}
  async finishStartup(release) {
    ${prologue}
    const displayPrepared = this.displayPrepared ?? Promise.resolve();
    try {
    ${tail}
  }
  ${methods}
} return Fixture;`, { target: ts.ScriptTarget.ES2022 }))(() => undefined,
  (_records: unknown, error: unknown, code: string) => { failures.push({ error, code }); }, class extends Error {});

function fixture(options: { controller?: boolean } = {}) {
  const target = new Fixture(), views: any[] = [], submissions: any[] = [];
  if (options.controller !== false) target.controller = { current: { conversationId: 'chat', name: 'chat' } };
  target.channel = { send: async (message: any) => { if (message.type === 'view') views.push(message.view); if (message.type === 'submission') submissions.push(message); } };
  target.confirmations = { refresh: async () => {} };
  const submit = () => target.action({ kind: 'input-submit', inputId: 'draft', version: 0 });
  return { target, views, submissions, submit };
}
const gate = () => { const entered = Promise.withResolvers<void>(), opened = Promise.withResolvers<void>(); return { entered, opened }; };
const settle = async (target: any) => { while (target.operation) await target.operation; await new Promise(resolve => setImmediate(resolve)); };

describe('startup admission matches the ready frame', () => {
  it('accepts input after the ready frame while pending confirmations are still being reconciled', async () => {
    const { target, views, submissions, submit } = fixture(), refresh = gate();
    target.confirmations.refresh = async () => { refresh.entered.resolve(); await refresh.opened.promise; };
    target.background((release: () => void) => target.finishStartup(release));
    await refresh.entered.promise;
    expect(views.at(-1)).toMatchObject({ readyForInput: true, busy: false });
    expect(views.at(-1).connectionState).toBeUndefined();
    expect(target.operation).toBeUndefined();
    await expect(submit()).resolves.toEqual({ accepted: true });
    expect(submissions.filter(message => message.accepted === false)).toEqual([]);
    refresh.opened.resolve(); await settle(target);
    expect(target.submitted).toEqual(['draft']);
  });

  it('opens admission before the ready frame is delivered', async () => {
    const { target, views, submit } = fixture(), delivery = gate();
    target.channel.send = async (message: any) => {
      if (message.type !== 'view') return;
      views.push(message.view);
      if (message.view.readyForInput) { delivery.entered.resolve(); await delivery.opened.promise; }
    };
    target.background((release: () => void) => target.finishStartup(release));
    await delivery.entered.promise;
    expect(target.operation).toBeUndefined();
    expect(target.startupAttempt).toBeUndefined();
    await expect(submit()).resolves.toEqual({ accepted: true });
    delivery.opened.resolve(); await settle(target);
  });

  it('keeps the starting projection and rejects input until a pending rubric is handled', async () => {
    const { target, views, submissions, submit } = fixture(), rubric = gate();
    target.deferredRubric = { kind: 'awaiting-rubric-confirmation', conversationId: 'chat' };
    target.resolveRubric = async () => {
      await target.publish({ ...target.mainView, message: '请确认当前验收方式。' });
      rubric.entered.resolve(); await rubric.opened.promise;
      target.deferredRubric = undefined;
    };
    target.background((release: () => void) => target.finishStartup(release));
    await rubric.entered.promise;
    expect(views.at(-1)).toMatchObject({ connectionState: 'starting', message: '请确认当前验收方式。' });
    expect(views.some(view => view.readyForInput && view.connectionState !== 'starting')).toBe(false);
    await expect(submit()).resolves.toEqual({ accepted: false });
    expect(submissions.at(-1)).toMatchObject({ accepted: false, message: '当前无法接纳输入，草稿已保留。' });
    rubric.opened.resolve(); await settle(target);
    expect(views.at(-1)).toMatchObject({ readyForInput: true });
    expect(views.at(-1).connectionState).toBeUndefined();
    await expect(submit()).resolves.toEqual({ accepted: true });
    await settle(target);
  });

  it('reports a failed confirmation reconciliation without blocking input or allowing anything', async () => {
    failures.length = 0;
    const { target, views, submit } = fixture();
    target.confirmations.refresh = async () => { throw Error('confirmation list unavailable'); };
    target.background((release: () => void) => target.finishStartup(release));
    await settle(target);
    expect(failures.map(failure => failure.code)).toEqual(['terminal-confirmation-refresh-failed']);
    expect(views.at(-1)).toMatchObject({ readyForInput: true, choices: [{ id: 'confirmation-retry', label: '重新核对待处理确认' }] });
    expect(views.at(-1).connectionState).toBeUndefined();
    await expect(submit()).resolves.toEqual({ accepted: true });
    await settle(target);
  });

  it('shows a retryable unavailable state when startup fails before a conversation exists', async () => {
    failures.length = 0;
    const { target, views } = fixture({ controller: false });
    target.displayPrepared = Promise.reject(Error('history directory unavailable'));
    target.background((release: () => void) => target.finishStartup(release));
    await settle(target);
    expect(failures.map(failure => failure.code)).toEqual(['terminal-startup-failed']);
    expect(views.at(-1)).toMatchObject({ connectionState: 'unavailable', connected: false });
    expect(views.at(-1).message).toContain('启动未完成：history directory unavailable');
    expect(target.operation).toBeUndefined();
    expect(target.startupAttempt).toBeUndefined();
  });

  it('releases admission before publishing an ordinary operation failure', async () => {
    failures.length = 0;
    const { target, views, submit } = fixture(), delivery = gate();
    target.deferredRubric = { kind: 'awaiting-rubric-confirmation', conversationId: 'chat' };
    target.resolveRubric = async () => { throw Error('rubric reconciliation failed'); };
    target.channel.send = async (message: any) => {
      if (message.type !== 'view') return;
      views.push(message.view);
      if (String(message.view.message).startsWith('操作未完成')) { delivery.entered.resolve(); await delivery.opened.promise; }
    };
    target.background((release: () => void) => target.finishStartup(release));
    await delivery.entered.promise;
    expect(views.at(-1).connectionState).toBeUndefined();
    expect(target.operation).toBeUndefined();
    await expect(submit()).resolves.toEqual({ accepted: true });
    delivery.opened.resolve(); await settle(target);
  });

  it('stops quietly when the application closes during a pending rubric', async () => {
    const { target, views } = fixture(), rubric = gate();
    target.deferredRubric = { kind: 'awaiting-rubric-confirmation', conversationId: 'chat' };
    target.resolveRubric = async () => { rubric.entered.resolve(); await rubric.opened.promise; throw Error('aborted'); };
    target.background((release: () => void) => target.finishStartup(release));
    await rubric.entered.promise;
    const published = views.length;
    target.abort.abort(); rubric.opened.resolve(); await settle(target);
    expect(views).toHaveLength(published);
    expect(target.operation).toBeUndefined();
    expect(target.startupAttempt).toBeUndefined();
  });

  it('does not let a finished attempt clear the starting state or notice hold of a newer one', async () => {
    const { target, views } = fixture(), delivery = gate();
    target.channel.send = async (message: any) => {
      if (message.type !== 'view') return;
      views.push(message.view);
      if (message.view.readyForInput) { delivery.entered.resolve(); await delivery.opened.promise; }
    };
    target.background((release: () => void) => target.finishStartup(release));
    await delivery.entered.promise;
    const newer = {}; target.startupAttempt = newer;
    const resumes = target.noticeResumes;
    delivery.opened.resolve(); await settle(target);
    expect(target.startupAttempt).toBe(newer);
    expect(target.noticeResumes).toBe(resumes);
    await target.publish({ ...target.mainView, message: '正在准备最近的对话…' });
    expect(views.at(-1).connectionState).toBe('starting');
  });
});
