import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { terminalStorageFullMessage } from '../failure.js';

// 命令的进页交接：生产的 #command、#background、#publish、#dropHandoff、#toUi、#ownsPage 与模块级 CommandHandoff 原样运行，
// 只替换传输（可挡住发送）与命令分派（由用例给出操作）。command 请求在本命令首帧真正写出、判定无效、或操作无可见结果时返回。
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const handoffClass = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'CommandHandoff');
if (!handoffClass) throw Error('Missing CommandHandoff');
const methods = ['#command', '#background', '#publish', '#dropHandoff', '#toUi', '#ownsPage'].map(name => {
  const node = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  if (!node) throw Error(`Missing production method ${name}`);
  return node.getText(source).replace(/#/gu, '');
}).join('\n');
// 断线回调原样取自构造函数里的 this.#connection.onDisconnect(...)，作为 disconnect() 运行
let disconnectBody: string | undefined;
const findDisconnect = (node: ts.Node): void => {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'this.#connection.onDisconnect' && node.arguments[0] && ts.isArrowFunction(node.arguments[0])) {
    disconnectBody = node.arguments[0].body.getText(source).replace(/#/gu, '');
  }
  ts.forEachChild(node, findDisconnect);
};
findDisconnect(owner);
if (!disconnectBody) throw Error('Missing production disconnect callback');
const failures: unknown[] = [];
const make = (waitMs: number) => new Function('AsyncLocalStorage', 'terminalEnvironment', 'recordTerminalFailure', 'ConfigurationEditPendingError',
  'terminalStorageFullMessage', 'COMMAND_HANDOFF_WAIT_MS', ts.transpile(`${handoffClass.getText(source)}
class Fixture {
  abort = new AbortController(); generation = 0; logging = { records: undefined }; commandScope = new AsyncLocalStorage();
  uiOpen = true; uiReady = Promise.resolve(); closed = [];
  mainView = { kind: 'conversation', title: 'chat', connected: true };
  processSession = { reset() {} }; conversationEpoch = 0; candidates = { close() {} };
  drainConfirmations() {} invalidateAuxiliary() {} close(code, reason) { this.closed.push(reason); return Promise.resolve(); }
  disconnect() ${disconnectBody}
  ${methods}
} return Fixture;`, { target: ts.ScriptTarget.ES2022 }))(AsyncLocalStorage, () => undefined, (_records: unknown, error: unknown) => { failures.push(error); },
  class extends Error {}, terminalStorageFullMessage, waitMs);
const Fixture = make(60_000);

const turns = async (count = 10) => { for (let i = 0; i < count; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok; }); return { promise, resolve }; };
function fixture(Class = Fixture) {
  const target = new Class(), sent: any[] = [];
  let gate: Promise<void> | undefined;
  target.channel = { send: async (message: any) => { const wait = gate; if (wait) await wait; sent.push(message.view); } };
  // 挡住接下来的发送，直到调用返回的放行函数
  const block = () => { const held = deferred(); gate = held.promise; return () => { gate = undefined; held.resolve(); }; };
  // 运行一条命令：operation 是命令受理后在后台执行的操作；记录 command 返回时界面已收到的消息
  const run = (operation?: () => Promise<void>, outcome: unknown = { accepted: true }, token?: string) => {
    target.dispatchCommand = async () => { if (operation) target.background(operation); return outcome; };
    const state: { returned: boolean; deliveredAtReturn?: string[]; result?: unknown } = { returned: false };
    const done = target.command('resolve', '', token).then((result: unknown) => {
      state.returned = true; state.deliveredAtReturn = sent.map(view => view.message); state.result = result;
    });
    return { state, done };
  };
  return { target, sent, block, run };
}
const messages = (sent: any[]) => sent.map(view => view.message);

describe('command handoff settles on the delivered first frame', () => {
  it('keeps the in-place result while a refresh is in flight and an unrelated notice replaces the queued main view', async () => {
    const { target, sent, block, run } = fixture();
    const release = block();
    void target.publish({ ...target.mainView, message: '刷新' });
    const { state, done } = run(async () => { await target.publish({ ...target.mainView, message: '当前对话没有结果待确认的运行。' }); });
    await turns();
    // 作用域外的后台通知：真正改变 message 的普通刷新，只能排在交接帧之后，不能顶掉它
    void target.publish({ ...target.mainView, message: '后台通知' });
    await turns();
    expect(state.returned).toBe(false);
    release(); await done; await turns();
    expect(messages(sent)).toEqual(['刷新', '当前对话没有结果待确认的运行。', '后台通知']);
    expect(state.deliveredAtReturn).toContain('当前对话没有结果待确认的运行。');
    expect(state.result).toEqual({ accepted: true });
  });

  it('settles without delivering when a real preemption takes the foreground before the frame is written', async () => {
    const { target, sent, block, run } = fixture();
    const release = block();
    void target.publish({ ...target.mainView, message: '刷新' });
    const { state, done } = run(async () => { await target.publish({ kind: 'selection', title: '任务推进', requestId: 'advancement' }); });
    await turns();
    target.presentingConfirmation = true;
    void target.publish({ kind: 'confirmation', title: '确认', requestId: 'confirm' });
    release(); await done; await turns();
    expect(sent.map(view => view.title)).toEqual(['chat', '确认']);
    expect(state.returned).toBe(true);
  });

  it('is not settled by publishes outside the command scope', async () => {
    const { target, sent, run } = fixture();
    const work = deferred();
    const { state, done } = run(async () => { await work.promise; await target.publish({ kind: 'selection', title: '命令帮助', requestId: 'help' }); });
    await turns();
    await target.publish({ ...target.mainView, message: '刷新' });
    await turns();
    expect(messages(sent)).toEqual(['刷新']); expect(state.returned).toBe(false);
    work.resolve(); await done;
    expect(sent.at(-1).title).toBe('命令帮助');
  });

  it('returns when the operation ends with no visible result or fails', async () => {
    const quiet = fixture();
    const first = quiet.run(async () => {});
    await first.done; expect(first.state.returned).toBe(true); expect(quiet.sent).toHaveLength(0);
    const failing = fixture();
    const second = failing.run(async () => { throw Error('boom'); });
    await second.done;
    expect(second.state.deliveredAtReturn?.at(-1)).toMatch(/操作未完成：boom/);
  });

  it('settles a queued frame when the conversation changes, the connection drops or the application closes', async () => {
    for (const end of ['invalidate', 'disconnect', 'close'] as const) {
      const { target, sent, block, run } = fixture();
      const release = block();
      void target.publish({ ...target.mainView, message: '刷新' });
      const { state, done } = run(async () => { await target.publish({ kind: 'selection', title: '任务推进', requestId: 'advancement' }); });
      await turns();
      // 换代、断线当场结算，过期页面不补发；关闭时正在写的那一帧结束后发送循环停下，未发出的交接帧作废并结算（界面随关闭销毁）
      if (end !== 'close') { if (end === 'invalidate') target.dropHandoff(); else target.disconnect(); await turns(); expect(state.returned, end).toBe(true); }
      else target.abort.abort();
      release(); await done; await turns(); expect(state.returned, end).toBe(true);
      expect(sent.map(view => view.title), end).toEqual(['chat']);
    }
  });

  it('settles when writing the frame fails', async () => {
    const { target, run } = fixture();
    target.channel = { send: async () => { throw Error('channel-closed'); } };
    const { state, done } = run(async () => { await target.publish({ kind: 'selection', title: '任务推进', requestId: 'advancement' }).catch(() => {}); });
    await done; expect(state.returned).toBe(true);
  });

  it('answers accepted and still opening after a bounded wait, and keeps saying so until the late page is delivered', async () => {
    const { target, sent, run } = fixture(make(30));
    const work = deferred(), started = performance.now();
    const { state, done } = run(async () => { await work.promise; await target.publish({ kind: 'selection', title: '任务推进', requestId: 'advancement' }); });
    await done;
    expect(state.result).toEqual({ accepted: true, pending: true }); expect(performance.now() - started).toBeLessThan(5_000);
    // 回复之前界面已收到带“仍在打开”的会话视图；期间的其他会话刷新同样带着
    expect(sent.at(-1)).toMatchObject({ kind: 'conversation', commandPending: 'resolve' });
    await target.publish({ ...target.mainView, message: '后台通知' });
    expect(sent.at(-1)).toMatchObject({ message: '后台通知', commandPending: 'resolve' });
    // 迟到的页面照常送达，它本身就是结果；之后回到会话不再带标记
    work.resolve(); await turns();
    expect(sent.at(-1)).toMatchObject({ title: '任务推进' }); expect(sent.at(-1)).not.toHaveProperty('commandPending');
    await target.publish(target.mainView);
    expect(sent.at(-1)).toMatchObject({ kind: 'conversation' }); expect(sent.at(-1)).not.toHaveProperty('commandPending');
  });

  it('withdraws the still-opening notice when a late command ends without anything to show', async () => {
    const { target, sent, run } = fixture(make(30));
    const work = deferred();
    const { state, done } = run(async () => { await work.promise; });
    await done; expect(state.result).toEqual({ accepted: true, pending: true });
    expect(sent.at(-1)).toMatchObject({ commandPending: 'resolve' });
    work.resolve(); await turns();
    expect(sent.at(-1)).toMatchObject({ kind: 'conversation' }); expect(sent.at(-1)).not.toHaveProperty('commandPending');
  });

  it('returns at once for a refused command with no operation', async () => {
    const { run } = fixture();
    const { state, done } = run(undefined, { accepted: false });
    await done; expect(state.result).toEqual({ accepted: false });
  });

  // 提交令牌：界面靠它把首个结果帧对回自己的那次提交（/resume 等换会话命令的结果帧先于回复到达）
  it('echoes the submission token only on the handoff frame of an admitted command', async () => {
    // 通过准入：交接帧（这里是换到另一个会话的视图）带令牌；作用域外的刷新、之后的刷新与主视图都不带
    const admitted = fixture();
    const work = deferred();
    const first = admitted.run(async () => { await work.promise; await admitted.target.publish({ ...admitted.target.mainView, conversationId: 'target', message: '已切换' }); }, { accepted: true }, '7');
    await turns();
    await admitted.target.publish({ ...admitted.target.mainView, message: '作用域外' });
    work.resolve(); await first.done;
    await admitted.target.publish(admitted.target.mainView);
    expect(admitted.sent.map(view => [view.message, view.handoff])).toEqual([['作用域外', undefined], ['已切换', '7'], [undefined, undefined]]);
    expect(first.state.deliveredAtReturn).toContain('已切换');
    expect(admitted.target.mainView).not.toHaveProperty('handoff');
    // 未知命令：没有进后台（未通过准入），在作用域内发布的说明帧不带令牌
    const unknown = fixture();
    unknown.target.dispatchCommand = async () => { void unknown.target.publish({ ...unknown.target.mainView, message: '未知命令' }); return { accepted: false }; };
    expect(await unknown.target.command('missing', '', '8')).toEqual({ accepted: false });
    await turns();
    expect(unknown.sent.map(view => [view.message, view.handoff])).toEqual([['未知命令', undefined]]);
    // 准入被拒（另一个操作还占着）：命令报错，同时到达的其他视图不带令牌
    const refused = fixture();
    refused.target.operation = Promise.resolve();
    const second = refused.run(async () => {}, { accepted: true }, '9');
    await expect(second.done).rejects.toThrow('terminal-operation-in-progress');
    await refused.target.publish({ ...refused.target.mainView, conversationId: 'other', message: '运行结束后的场景切换' });
    expect(refused.sent.map(view => view.handoff)).toEqual([undefined]);
    // 不带令牌保持原行为；令牌不是有限十进制序号时拒绝，不发任何帧
    const plain = fixture();
    await plain.run(async () => { await plain.target.publish({ ...plain.target.mainView, message: '无令牌' }); }).done;
    expect(plain.sent.at(-1)).not.toHaveProperty('handoff');
    // 断线后操作失败：生产断线回调把主视图置为不可用，#background 的 catch 释放操作后发布错误视图。它仍是这次已准入命令的
    // 交接帧，照样带令牌，命令也照样回复受理——令牌只说明“这是它的结果”，不说明连接可用；界面须先按断线判定、不消费草稿
    const dropped = fixture();
    const closing = deferred();
    const third = dropped.run(async () => { await closing.promise; throw Error('connection closed before navigation'); }, { accepted: true }, '10');
    await turns(); dropped.target.disconnect(); closing.resolve(); await third.done; await turns();
    expect(dropped.sent).toHaveLength(1);
    expect(dropped.sent[0]).toMatchObject({ connected: false, connectionState: 'unavailable', handoff: '10' });
    expect(dropped.sent[0].message).toMatch(/操作未完成：connection closed before navigation/);
    expect(third.state.result).toEqual({ accepted: true });
    for (const token of ['', '0', '01', 'x7', '1'.repeat(17), 7]) {
      const invalid = fixture();
      await expect(invalid.target.command('resolve', '', token)).rejects.toThrow('terminal-command-handoff');
      expect(invalid.sent).toHaveLength(0);
    }
  });
});
