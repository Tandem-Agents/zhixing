import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { TerminalChannel, TerminalChannelRetiredError } from '../../../../terminal-ui/src/channel.js';
import { TERMINAL_LIMITS } from '../../../../terminal-ui/src/protocol.js';
import { terminalCloseDeadline } from '../close-budget.js';
import { terminalStorageFullMessage } from '../failure.js';

// 生产的接收校验、回执、动作分派、后台操作、视图发布、U 就绪门与早启入口原样运行，启动尝试的开头（含“启动中”视图）也取自
// 生产源码；只把连接、选会话、首屏这段业务链换成可控的等待。对端是真实的 TerminalChannel：门只能由经过握手与校验的请求打开。
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const method = (name: string) => {
  const node = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  if (!node) throw Error(`Missing production method ${name}`);
  return node.getText(source);
};
const methods = ['#receive', '#reply', '#action', '#background', '#beginEarlyStartup', '#toUi', '#publish', '#ownsPage'].map(method).join('\n').replace(/#/gu, '');
const startup = method('#startup');
const headStart = startup.indexOf('const attempt = {};'), headEnd = startup.indexOf('\n', startup.indexOf('else void starting.catch'));
if (headStart < 0 || headEnd < 0) throw Error('Startup head not found');
const head = startup.slice(headStart, headEnd).replace(/#/gu, '');
const failures: { error: unknown; code: string }[] = [];
const Fixture = new Function('TERMINAL_LIMITS', 'terminalCloseDeadline', 'TerminalChannelRetiredError', 'recordTerminalFailure', 'ConfigurationEditPendingError',
  'terminalStorageFullMessage', 'terminalEnvironment', ts.transpile(`class Fixture {
  args = []; abort = new AbortController(); generation = 0; logging = { records: undefined };
  mainView = { kind: 'conversation', title: '知行', message: '', connected: false };
  requests = new Set(); lastRequest = 0; hello = false; started = false; closeDeadline = 0;
  earlyStartup = false; startupReceipt = false;
  uiOpen = false; uiReady = new Promise(resolve => { this.openUi = resolve; });
  chains = 0;
  display = { prepare: async () => {} };
  assets = { receive: () => {} }; hosts = { accept: () => {} };
  drainConfirmations() {} invalidateAuxiliary() {} holdNoticeDisplay() {}
  close() { this.abort.abort(); return Promise.resolve(); }
  async independentCommand() { this.commands = (this.commands ?? 0) + 1; }
  async startup(release) {
    ${head}
    this.chains++;
    await this.chain(this);
    finish();
    await this.publish({ ...this.mainView, connected: true, busy: false, connectionState: undefined, readyForInput: true });
  }
  ${methods}
} return Fixture;`, { target: ts.ScriptTarget.ES2022 }))(TERMINAL_LIMITS, terminalCloseDeadline, TerminalChannelRetiredError,
  (_records: unknown, error: unknown, code: string) => { failures.push({ error, code }); }, class extends Error {}, terminalStorageFullMessage, () => undefined);

const INSTANCE = '00000000-0000-4000-8000-000000000071';
const turns = async (count = 20) => { for (let i = 0; i < count; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

/** N 一侧是生产方法组成的应用，对端（S 转发的 U 一侧）是真实通道；两端经微任务互送分组。 */
function fixture(chain: (target: any) => Promise<void> = async () => {}) {
  const target = new Fixture();
  const received: any[] = [];
  target.chain = chain;
  let peer!: TerminalChannel;
  target.channel = new TerminalChannel(INSTANCE, (packet, done) => { queueMicrotask(() => { peer.accept(packet); done(); }); },
    message => target.receive(message), vi.fn());
  peer = new TerminalChannel(INSTANCE, (packet, done) => { queueMicrotask(() => { target.channel.accept(packet); done(); }); },
    message => { received.push(message); }, vi.fn());
  let id = 0;
  const request = (kind: string) => peer.send({ type: 'request', id: ++id, action: { kind } } as any);
  const announce = () => peer.send({ type: 'hello', role: 'application' } as any);
  const views = () => received.filter(message => message.type === 'view').map(message => message.view);
  const replies = () => received.filter(message => message.type === 'reply');
  return { target, peer, received, request, announce, views, replies };
}

describe('N 早启与 U 就绪门', () => {
  it('hello 之后即开始默认会话启动；门开之前不向 U 发视图，第一次 startup 只领回执、不重做', async () => {
    const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
    const h = fixture(async () => { entered.resolve(); await proceed.promise; });
    h.target.beginEarlyStartup();
    await entered.promise; await turns();
    expect(h.target.chains).toBe(1);
    expect(h.views()).toEqual([]);
    await h.announce(); await h.request('startup'); await turns();
    expect(h.replies()).toEqual([{ type: 'reply', id: 1, value: { accepted: true } }]);
    expect(h.views().map(view => view.connectionState)).toEqual(['starting']);
    proceed.resolve(); await turns();
    expect(h.target.chains).toBe(1);
    expect(h.views().at(-1)).toMatchObject({ readyForInput: true, busy: false });
    expect(h.views().map(view => view.generation)).toEqual([...h.views().map(view => view.generation)].sort((a, b) => a - b));
  });

  it('尝试已失败时第一次 startup 仍只领回执；再次 startup 照旧拒绝', async () => {
    const h = fixture(async () => { throw Error('connection failed'); });
    h.target.beginEarlyStartup(); await turns();
    expect(h.views()).toEqual([]);
    await h.announce(); await h.request('startup'); await turns();
    expect(h.replies()[0]).toEqual({ type: 'reply', id: 1, value: { accepted: true } });
    expect(h.views().at(-1)?.message).toContain('connection failed');
    await h.request('startup'); await turns();
    expect(h.replies()[1]).toMatchObject({ type: 'reply', id: 2, error: expect.any(String) });
    expect(h.target.chains).toBe(1);
  });

  it('资产结果与宿主状态不开门；先到的非 startup 请求开门，之后的 startup 仍只领回执', async () => {
    const proceed = Promise.withResolvers<void>();
    const h = fixture(() => proceed.promise);
    const assets = vi.spyOn(h.target.assets, 'receive'), hosts = vi.spyOn(h.target.hosts, 'accept');
    h.target.beginEarlyStartup();
    await h.announce();
    await h.peer.send({ type: 'assets-result', id: 1 } as any);
    await h.peer.send({ type: 'host-state', id: 'h' } as any);
    await turns();
    expect(assets).toHaveBeenCalledTimes(1); expect(hosts).toHaveBeenCalledTimes(1);
    expect(h.target.uiOpen).toBe(false); expect(h.views()).toEqual([]);
    await h.request('synthetic-unavailable'); await turns();
    expect(h.target.uiOpen).toBe(true);
    expect(h.replies()[0]).toMatchObject({ id: 1, error: expect.any(String) });
    expect(h.views().map(view => view.connectionState)).toEqual(['starting']);
    await h.request('startup'); await turns();
    expect(h.replies()[1]).toEqual({ type: 'reply', id: 2, value: { accepted: true } });
    proceed.resolve(); await turns();
    expect(h.target.chains).toBe(1);
  });

  it('门前需要用户的页面在门开后送达，启动链在这一步等应答，不自动代答', async () => {
    const answered = Promise.withResolvers<void>();
    const h = fixture(async target => {
      await target.publish({ kind: 'selection', title: '当前会话能力受限', message: 'limited', choices: [{ id: 'continue', label: '继续' }] });
      await answered.promise;
    });
    h.target.beginEarlyStartup(); await turns();
    expect(h.views()).toEqual([]);
    await h.announce(); await h.request('startup'); await turns();
    expect(h.views().map(view => view.kind)).toContain('selection');
    expect(h.views().some(view => view.readyForInput)).toBe(false);
    answered.resolve(); await turns();
    expect(h.views().at(-1)).toMatchObject({ readyForInput: true });
  });

  it('门开之前关闭：门前等待的发送随中止结束，不开门、不送出任何视图', async () => {
    const stopped = Promise.withResolvers<void>();
    const h = fixture(target => new Promise<void>((_resolve, reject) => {
      target.abort.signal.addEventListener('abort', () => { stopped.resolve(); reject(Error('aborted')); }, { once: true });
    }));
    h.target.beginEarlyStartup(); await turns();
    await h.target.close();
    await stopped.promise; await turns();
    expect(h.target.uiOpen).toBe(false);
    expect(h.views()).toEqual([]);
    expect(h.target.chains).toBe(1);
  });

  it('独立命令不早启，仍由 U 的 startup 发起', async () => {
    const h = fixture();
    h.target.args = ['status'];
    h.target.beginEarlyStartup(); await turns();
    expect(h.target.chains).toBe(0); expect(h.target.started).toBe(false);
    await h.announce(); await h.request('startup'); await turns();
    expect(h.target.commands).toBe(1); expect(h.target.chains).toBe(0);
  });
});
