import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  RpcClientClosedError,
  RpcClientError,
  RpcRequestInterruptedError,
} from '@zhixing-ai/server/client';
import { chooseTerminalSelection } from '../selection.js';
import { createStopSelectionRequest, shutdownStrategyForChoice } from '../../runtime/stop-selection.js';

const source = ts.createSourceFile(
  'application.ts',
  readFileSync(new URL('../application.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const owner = source.statements.find(
  (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication',
)!;
const handoffClass = source.statements.find(
  (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'CommandHandoff',
)!;
const accessors = owner.members.filter(
  member =>
    (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
    member.name.getText(source) === '#mainView',
);
if (accessors.length !== 2) throw Error('Missing production #mainView accessors');
const methods = ['#stop', '#publish', '#dropHandoff', '#toUi', '#ownsPage'].map(name => {
  const node = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  if (!node) throw Error(`Missing production method ${name}`);
  return node.getText(source);
});
const body = [...accessors.map(node => node.getText(source)), ...methods].join('\n').replace(/#/gu, '');

const Fixture = new Function(
  'AsyncLocalStorage',
  'terminalEnvironment',
  'recordTerminalFailure',
  'chooseTerminalSelection',
  'createStopSelectionRequest',
  'shutdownStrategyForChoice',
  'RpcClientError',
  'RpcClientClosedError',
  'RpcRequestInterruptedError',
  ts.transpile(
    `${handoffClass.getText(source)}
class Fixture {
  abort = new AbortController();
  generation = 0;
  logging = { records: undefined };
  commandScope = new AsyncLocalStorage();
  uiOpen = true;
  uiReady = Promise.resolve();
  closed = [];
  failures = [];
  view = { kind: 'conversation', title: 'chat-main', conversationId: 'conv-1', connected: true, busy: true };
  writingResult = false;
  state = { activeTurnPromise: undefined };
  drainConfirmations() {}
  selectionFlow(op) { return op(); }
  choosePage(view) { return this.onChoosePage(view); }
  close(code, reason) { this.closed.push({ code, reason }); return Promise.resolve(); }
  ${body}
}
return Fixture;`,
    { target: ts.ScriptTarget.ES2022 },
  ),
)(
  AsyncLocalStorage,
  () => undefined,
  (_records: unknown, error: unknown, code: string) => {
    lastFailures?.push({ code, error });
  },
  chooseTerminalSelection,
  createStopSelectionRequest,
  shutdownStrategyForChoice,
  RpcClientError,
  RpcClientClosedError,
  RpcRequestInterruptedError,
);

let lastFailures: Array<{ code: string; error: unknown }> | undefined;

function createStopFixture(choiceItemId = 'option:wait') {
  const target = new Fixture();
  const sent: any[] = [];
  const failures: Array<{ code: string; error: unknown }> = [];
  lastFailures = failures;
  target.channel = {
    send: async (message: any) => {
      if (message.type === 'view') sent.push(message.view);
    },
  };
  target.onChoosePage = async (view: any) => {
    sent.push(view);
    return { itemId: choiceItemId };
  };
  target.management = {
    serverInfoIfConnected: vi.fn(async () => ({
      version: '0.1.0',
      protocol: 1,
      pid: 999,
      startedAt: '2026-11-14T00:00:00.000Z',
      uptimeSec: 12,
      activeConversations: 1,
      busyConversations: 1,
      connectionCount: 1,
      memoryRssBytes: 1024,
    })),
    serverShutdown: vi.fn(async () => ({ ok: true as const })),
  };
  return { target, sent, failures };
}

describe('TerminalApplication #stop lifecycle & UX', () => {
  it('returns to main view with waiting message preserving busy=true while drain waits, then drains activeTurnPromise and closes cleanly', async () => {
    const { target, sent } = createStopFixture('option:wait');
    let releaseShutdown!: () => void;
    const shutdownGate = new Promise<void>(resolve => {
      releaseShutdown = resolve;
    });
    let releaseTurn!: () => void;
    let turnFinished = false;
    target.state.activeTurnPromise = new Promise<void>(resolve => {
      releaseTurn = () => {
        turnFinished = true;
        resolve();
      };
    });
    target.management.serverShutdown = vi.fn(async () => {
      await shutdownGate;
      return { ok: true as const };
    });

    const stopPromise = target.stop();
    await vi.waitFor(() => {
      expect(target.management.serverShutdown).toHaveBeenCalledWith({
        reason: 'user-stop',
        strategy: 'drain',
        timeoutMs: 30_000,
      });
    });

    // While serverShutdown is still waiting on drain, UI has already returned to mainView with busy: true!
    const conversationViews = sent.filter(v => v.kind === 'conversation');
    expect(conversationViews).toHaveLength(1);
    expect(conversationViews[0]).toMatchObject({
      kind: 'conversation',
      conversationId: 'conv-1',
      busy: true,
      message: '正在等待当前运行完成后停止知行服务…',
    });
    expect(target.closed).toEqual([]);

    releaseShutdown();
    await new Promise(resolve => setTimeout(resolve, 25));
    // Still waiting for activeTurnPromise to finish draining final output
    expect(target.closed).toEqual([]);

    releaseTurn();
    await stopPromise;
    expect(turnFinished).toBe(true);
    expect(target.closed).toEqual([{ code: 0, reason: 'user-stop' }]);
  });

  it('keeps TUI and busy=true alive on retry-same-request business timeout without closing', async () => {
    const { target, sent } = createStopFixture('option:wait');
    target.management.serverShutdown = vi.fn(async () => {
      throw new RpcClientError(
        -32004,
        '还有对话运行在收尾，这次没有停止',
        { action: 'retry-same-request', pendingOwner: 'conversation' },
      );
    });

    await target.stop();

    expect(target.closed).toEqual([]);
    expect(target.mainView.busy).toBe(true);
    expect(target.mainView.message).toContain('还有对话运行在收尾，这次没有停止');
    expect(target.mainView.message).toContain('当前运行继续进行，完成后可再次执行 /stop 继续停止。');
    expect(sent.at(-1)).toMatchObject({
      kind: 'conversation',
      busy: true,
      message: target.mainView.message,
    });
  });

  it.each([
    ['RpcClientClosedError', () => new RpcClientClosedError('socket closed')],
    [
      'RpcRequestInterruptedError(waiting-receipt)',
      () => new RpcRequestInterruptedError('waiting-receipt', false),
    ],
  ])('surfaces uncertain-outcome guidance on %s without claiming stopped or retrying side effects', async (_label, makeError) => {
    const { target, sent, failures } = createStopFixture('option:wait');
    target.management.serverShutdown = vi.fn(async () => {
      throw makeError();
    });

    await target.stop();

    expect(target.management.serverShutdown).toHaveBeenCalledTimes(1);
    expect(target.closed).toEqual([]);
    expect(target.mainView.busy).toBe(true);
    expect(target.mainView.message).toContain('停止请求结果尚未确认');
    expect(failures.map(item => item.code)).toEqual(['terminal-stop-outcome-uncertain']);
    expect(sent.at(-1)).toMatchObject({
      kind: 'conversation',
      busy: true,
      message: target.mainView.message,
    });
  });
});
