import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { terminalStorageFullMessage } from '../failure.js';
import { opensManagedCandidates } from '../candidates.js';

// 操作结果的生命周期：主视图存取器、#showResult、#retractResult、#retractResultFrame、#command、#background、#publish、#dropHandoff、
// #toUi、#ownsPage、#action（候选查询、面板管理）、#readOnly 与 #publishHistoryView 取自生产源码原样运行；
// 只替换传输（记录送达顺序）、命令分派、候选来源与本机历史目录。
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const handoffClass = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'CommandHandoff')!;
const accessors = owner.members.filter(member => (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name.getText(source) === '#mainView');
if (accessors.length !== 2) throw Error('Missing production #mainView accessors');
const methods = ['#showResult', '#retractResult', '#retractResultFrame', '#command', '#background', '#publish', '#dropHandoff', '#toUi', '#ownsPage',
  '#action', '#readOnly', '#publishHistoryView'].map(name => {
  const node = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  if (!node) throw Error(`Missing production method ${name}`);
  return node.getText(source);
});
const body = [...accessors.map(node => node.getText(source)), ...methods].join('\n').replace(/#/gu, '');
const Fixture = new Function('AsyncLocalStorage', 'terminalEnvironment', 'recordTerminalFailure', 'ConfigurationEditPendingError',
  'terminalStorageFullMessage', 'COMMAND_HANDOFF_WAIT_MS', 'opensManagedCandidates', 'formatRelativeTimeText', ts.transpile(`${handoffClass.getText(source)}
class Fixture {
  args = []; abort = new AbortController(); generation = 0; logging = { records: undefined }; commandScope = new AsyncLocalStorage();
  uiOpen = true; uiReady = Promise.resolve(); closed = [];
  view = { kind: 'conversation', title: 'chat', connected: true };
  writingResult = false;
  drainConfirmations() {} close(code, reason) { this.closed.push(reason); return Promise.resolve(); }
  ${body}
} return Fixture;`, { target: ts.ScriptTarget.ES2022 }))(AsyncLocalStorage, () => undefined, () => {}, class extends Error {},
  terminalStorageFullMessage, 60_000, opensManagedCandidates, () => '');

const RESULT = '已取消本次配置编辑。';
const turns = async (count = 10) => { for (let i = 0; i < count; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
function fixture() {
  const target = new Fixture(), sent: any[] = [], log: string[] = [];
  target.channel = { send: async (message: any) => { sent.push(message.view); log.push(`frame:${message.view.kind}:${message.view.message ?? ''}`); } };
  target.candidates = {
    registry: { findByName: (name: string) => ['name', 'config', 'status', 'resume'].includes(name) ? { name } : undefined },
    query: vi.fn(async (revision: number) => { log.push(`query:${revision}`); return { revision, start: 0, end: 0, items: [] }; }),
    manage: vi.fn(() => ({ command: 'work', value: 'scene-1', label: '场景' })),
  };
  target.ensureDecisionBinding = async () => {};
  target.selectionFlow = async (operation: () => Promise<unknown>) => operation();
  target.ensureSessionBinding = () => ({ manage: async () => { log.push('manage'); } });
  // 命令受理后由用例给出的操作：打开一页（交接帧）后结束
  target.dispatchCommand = async (name: string) => {
    target.background(async () => { await target.publish({ kind: 'selection', title: name, requestId: `page:${name}` }); });
    return { accepted: true };
  };
  const show = (message = RESULT) => target.showResult({ ...target.mainView, message });
  return { target, sent, log, show };
}

describe('operation result ownership', () => {
  it('retracts the result before a recognized command, delivering the retraction frame ahead of the command’s first frame', async () => {
    const { target, sent, show } = fixture();
    show();
    // 页面稍后才到：命令的回复仍要等到它自己的首帧（页面）送达，撤回帧不能顶替交接帧
    target.dispatchCommand = async (name: string) => {
      target.background(async () => { await new Promise(resolve => setTimeout(resolve, 20)); await target.publish({ kind: 'selection', title: name, requestId: `page:${name}` }); });
      return { accepted: true };
    };
    const reply = await target.command('name', '');
    const atReply = sent.map(view => [view.kind, view.message]);
    expect(reply).toEqual({ accepted: true });
    expect(atReply).toEqual([['conversation', undefined], ['selection', undefined]]);
    expect(target.mainView.message).toBeUndefined(); expect(target.result).toBeUndefined();
  });
  it('sends nothing extra when no result is held, so the command’s first frame stays the handoff frame', async () => {
    const { target, sent } = fixture();
    target.mainView = { ...target.mainView, message: '连接已断开，输入与已有内容保留。' };
    await target.command('status', ''); await turns();
    expect(sent.map(view => view.kind)).toEqual(['selection']);
    expect(target.mainView.message).toBe('连接已断开，输入与已有内容保留。');
  });
  it('keeps the result for an unknown command, which is not an operation', async () => {
    const { target, show } = fixture();
    show(); target.dispatchCommand = async () => ({ accepted: false });
    await target.command('nosuch', ''); await turns();
    expect(target.mainView.message).toBe(RESULT); expect(target.result).toBeDefined();
  });
  it('drops ownership when an ordinary write replaces the message, so a later trigger never clears that message', async () => {
    const { target, sent, show } = fixture();
    show();
    target.mainView = { ...target.mainView, message: '确认应答未获得成功回执；正在重新核对请求状态，不会自动允许。' };
    expect(target.result).toBeUndefined();
    // 之后普通写入恰好写回同一句，也不会让凭据复活
    target.mainView = { ...target.mainView, message: RESULT };
    expect(target.result).toBeUndefined();
    await target.command('name', ''); await turns();
    expect(target.mainView.message).toBe(RESULT);
    expect(sent.map(view => view.kind)).toEqual(['selection']);
  });
  it('keeps ownership across ordinary writes that leave the message as it is', async () => {
    const { target, show } = fixture();
    show();
    target.mainView = { ...target.mainView, busy: true };
    target.mainView = { ...target.mainView, busy: false, title: '新标题' };
    expect(target.result).toBeDefined();
    expect(target.retractResult()).toBe(true);
    expect(target.mainView).toMatchObject({ title: '新标题', message: undefined });
    expect(target.retractResult()).toBe(false);
  });
  it('does not resurrect a retracted result in any later publish of the main view', async () => {
    const { target, sent, show } = fixture();
    show();
    await target.command('config', ''); await turns();
    await target.publish(target.mainView); await turns();
    expect(sent.filter(view => view.kind === 'conversation').map(view => view.message)).toEqual([undefined, undefined]);
  });
  it('retracts before querying when a management or picker panel opens, once per panel, and not for ordinary candidates', async () => {
    const { target, log, show } = fixture();
    show();
    await target.action({ kind: 'input-candidates', revision: 1, text: '/re', cursor: 3, atStart: true });
    await target.action({ kind: 'input-candidates', revision: 2, text: '@src', cursor: 4, atStart: true });
    expect(target.mainView.message).toBe(RESULT);
    await target.action({ kind: 'input-candidates', revision: 3, text: '/resume ', cursor: 8, atStart: true });
    await target.action({ kind: 'input-candidates', revision: 4, text: '/resume 06', cursor: 10, atStart: true });
    await turns();
    expect(log).toEqual(['query:1', 'query:2', 'frame:conversation:', 'query:3', 'query:4']);
    for (const text of ['/work ', '/trust ', '、trust x']) {
      const other = fixture(); other.show();
      await other.target.action({ kind: 'input-candidates', revision: 1, text, cursor: text.length, atStart: true });
      expect(other.log).toEqual(['frame:conversation:', 'query:1']);
    }
  });
  it('retracts in memory only for a panel management action, without a frame that would reload the panel', async () => {
    const { target, log, show } = fixture();
    show();
    await target.action({ kind: 'candidate-manage', revision: 1, action: 'rename', id: 'scene-1' });
    expect(log[0]).not.toMatch(/^frame/u);
    await turns();
    expect(log).toEqual(['manage', 'frame:conversation:']);
    expect(target.result).toBeUndefined();
  });
  it('retracts before taking the local history return snapshot, so leaving history cannot bring it back', async () => {
    const { target, show } = fixture();
    show();
    target.readOnlyStorage = async () => ({ listPage: async () => ({ records: [] }) });
    await target.readOnly(); await turns();
    expect(target.historyReturn).toBeDefined(); expect(target.historyReturn.message).toBeUndefined();
    expect(target.result).toBeUndefined();
  });
});
