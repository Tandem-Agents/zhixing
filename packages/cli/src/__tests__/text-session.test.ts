import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreHostConnection } from '../runtime/core-host-connection.js';
import type { StartupCheckResult } from '../startup.js';
import type { LogRecordPort } from '@zhixing/core/logging';
import { PERSPECTIVES_DELIBERATION_DEFINITION_ID } from '@zhixing/core/conversation/application';
import { DEFAULT_LOG_POLICY } from '@zhixing/core/logging';

const f = vi.hoisted(() => ({
  options: undefined as any,
  beforeInitial: undefined as undefined | (() => void),
  initial: { active: { conversationId: 'main-1', name: '恢复对话', mode: { kind: 'main' } }, resumedConversationName: '恢复对话' },
  current: { conversationId: 'main-1', name: '恢复对话', mode: { kind: 'main' } } as any,
  begin: vi.fn(), rename: vi.fn(), clear: vi.fn(), resume: vi.fn(), create: vi.fn(),
  start: vi.fn(), abort: vi.fn(), dispose: vi.fn(), observe: vi.fn(),
  skillQuery: vi.fn(), skillDetach: vi.fn(), config: vi.fn(), startupFailure: vi.fn(),
  logStatus: vi.fn(), logApplyPolicy: vi.fn(), trustList: vi.fn(), trustRevoke: vi.fn(),
  taskList: vi.fn(),
  confirm: undefined as undefined | ((request: any) => void), resolve: vi.fn(),
  changed: undefined as undefined | ((change: any) => void),
}));
vi.mock('../logging/runtime.js', () => ({ observeStartupPhase: (_records: unknown, _phase: string, operation: () => Promise<unknown>) => operation(), recordRuntimeFailure: vi.fn(), recordStartupFailure: f.startupFailure }));
vi.mock('../logging/runtime-source.js', () => ({ recordFirstSurfaceOutput: vi.fn() }));
vi.mock('../startup.js', () => ({ runStartupCheck: f.config }));
vi.mock('../runtime/runtime-configuration-provider.js', () => ({ createRuntimeConfigurationProvider: vi.fn() }));
vi.mock('../runtime/repl-local-view.js', () => ({ ReplLocalView: class {
  primaryModel = { providerId: 'test', model: 'model' }; workspaceRoot = process.cwd();
  networkProxy = { mode: 'off', hasResolvedProxy: false, display: '' }; hostInfo = null;
  async refresh() {}
} }));
vi.mock('../runtime/rpc-conversation-facade.js', () => ({ RpcConversationFacade: class {
  taskList = f.taskList;
  onChanged(callback: typeof f.changed) { f.changed = callback; return () => { f.changed = undefined; }; }
} }));
vi.mock('../runtime/rpc-workscene-facade.js', () => ({ RpcWorksceneFacade: class { async list() { return []; } } }));
vi.mock('../runtime/rpc-management-facade.js', () => ({ RpcManagementFacade: class {
  logs() { return { status: f.logStatus, applyPolicy: f.logApplyPolicy }; } async serverInfo() { return {}; }
  trustList = f.trustList; trustRevoke = f.trustRevoke;
} }));
vi.mock('../runtime/rpc-scheduler-facade.js', () => ({ RpcSchedulerFacade: class { onEvent() { return () => {}; } } }));
vi.mock('../runtime/rpc-confirmation-broker.js', () => ({ RpcConfirmationBroker: class {
  onRequest(callback: typeof f.confirm) { f.confirm = callback; return () => { f.confirm = undefined; }; }
  resolve = f.resolve; async refresh() {} dispose() {}
} }));
vi.mock('../runtime/observed-turn-presenter.js', () => ({ createObservedTurnPresenter: () => ({
  decorateRunBus: vi.fn(() => () => {}), onObservedInputs: vi.fn(), onObservedTurnDelta: vi.fn(), onObservedTurnComplete: vi.fn(),
}) }));
vi.mock('../runtime/advancement-control-presenter.js', () => ({ createAdvancementControlPresenter: () => ({ dispose() {} }) }));
vi.mock('../runtime/publish-result-presenter.js', () => ({ createPublishResultPresenter: () => ({ dispose() {} }) }));
vi.mock('@zhixing/rpc/skill-catalog-client', () => ({ SkillCatalogRpcClient: class {
  query = f.skillQuery; onFact() { return f.skillDetach; }
} }));
vi.mock('../user-turn-input.js', () => ({ prepareUserTurnInput: async (text: string) => ({ input: { parts: [{ type: 'text', text }] }, errors: [] }) }));
vi.mock('../session-engage.js', () => ({ prepareSessionSendEngage: async () => undefined }));
vi.mock('../runtime/conversation-controller.js', () => ({
  selectInitialConversation: vi.fn(async () => { f.beforeInitial?.(); return f.initial; }),
  ConversationController: class {
    constructor(options: unknown) { f.options = options; f.current = structuredClone(f.initial.active); }
    get current() { return f.current; }
    start = f.start; beginUserTurn = f.begin; dispose = f.dispose; abort = f.abort;
    rename = f.rename; clear = f.clear; resume = f.resume; newConversation = f.create;
    reattachActiveObserver = f.observe;
    isWatching(id: string) { return f.current.conversationId === id; }
    isLocalTurn() { return false; }
    applySessionChanged() { return { kind: 'ignored' }; }
    async history() { return { runs: [], hasMore: false, inputsOutsideHistory: [] }; }
    async listConversations() { return [{ conversationId: 'main-1', name: '恢复对话', lastActiveAt: '2026-10-08' }]; }
    async abortBackgroundTask() { return false; }
  },
}));

import { startTextSession } from '../text-session.js';

function fixture() {
  const input = new PassThrough(), signals = new EventEmitter(); let output = '', error = '';
  let disconnected: (() => void) | undefined, notice: ((value: unknown) => Promise<void>) | undefined;
  const notifications = new Map<string, Set<(value: unknown) => void>>();
  const connection = {
    onNotification(method: string, handler: (value: unknown) => void) {
      let handlers = notifications.get(method); if (!handlers) notifications.set(method, handlers = new Set());
      handlers.add(handler); return () => { handlers.delete(handler); };
    },
    ensure: vi.fn(async () => {}), getStatus: () => ({ kind: 'connected' }), dispose: vi.fn(async () => {}),
    onDisconnect(callback: () => void) { disconnected = callback; return () => { disconnected = undefined; }; },
    onLifecycleNotice(callback: typeof notice) { notice = callback; return () => { notice = undefined; }; },
  };
  return { input, signals, connection,
    notify: (method: string, value: unknown) => { for (const handler of notifications.get(method) ?? []) handler(value); },
    handlerCount: (method: string) => notifications.get(method)?.size ?? 0,
    output: () => output, error: () => error,
    disconnect: () => disconnected?.(), reconnect: () => notice?.({ kind: 'reconnected', reason: 'connection-closed' }),
    run: (extra: Parameters<typeof startTextSession>[2] = {}) => startTextSession('E:/text-test', 'E:/text-test/config.jsonc', {
      input, signals, connection: connection as unknown as CoreHostConnection,
      output: { write: text => { output += text; } }, error: { write: text => { error += text; } }, ...extra,
    }),
  };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('cancels startup without entering configuration or readonly recovery after a surface interrupt', async () => {
  const h = fixture(); let reject!: (error: Error) => void;
  h.connection.ensure.mockImplementationOnce(() => new Promise<void>((_yes, no) => { reject = no; }));
  h.connection.dispose.mockImplementation(async () => { reject?.(Error('connection disposed')); });
  const running = h.run(); await tick(); h.signals.emit('SIGINT');
  expect(await running).toBe(0);
  expect(f.config).not.toHaveBeenCalled();
  expect(h.error()).toBe(''); expect(h.output()).not.toContain('仅显示最近');
});

beforeEach(() => {
  vi.clearAllMocks(); f.beforeInitial = undefined; f.options = undefined; f.confirm = undefined; f.changed = undefined;
  f.initial = { active: { conversationId: 'main-1', name: '恢复对话', mode: { kind: 'main' } }, resumedConversationName: '恢复对话' };
  f.start.mockResolvedValue(undefined); f.abort.mockResolvedValue(undefined); f.observe.mockResolvedValue(undefined);
  f.begin.mockImplementation(async (input: any) => {
    f.options.onYield({ type: 'text_delta', text: `reply:${input.parts[0].text}` });
    return { kind: 'accepted', turn: { outcome: Promise.resolve({ message: '本次运行已结束。' }) } };
  });
  f.rename.mockImplementation(async (name: string) => { f.current.name = name; });
  f.clear.mockResolvedValue(undefined);
  f.create.mockImplementation(async () => f.current = { conversationId: 'main-2', name: '新对话', mode: { kind: 'main' } });
  f.resume.mockImplementation(async (id: string) => ({ active: f.current = { conversationId: id, name: '恢复对话', mode: { kind: 'main' } } }));
  f.skillQuery.mockResolvedValue({ entries: [{ id: 'custom-skill', name: 'custom-skill', description: 'custom' }] });
  f.taskList.mockResolvedValue({ taskList: null });
});

describe('text session application binding', () => {
  it.each(['error', 'completed', 'max_turns', 'aborted'] as const)('aggregates %s without allowing a later successful line to hide failure', async reason => {
    const t = fixture();
    f.begin.mockResolvedValueOnce({ kind: 'accepted', turn: { outcome: Promise.resolve({ reason, message: `terminal:${reason}` }) } });
    const run = t.run(); t.input.end('first\nsecond\n');
    expect(await run).toBe(reason === 'error' ? 1 : 0);
    expect(t.output()+t.error()).toContain(`terminal:${reason}`);
    expect(t.output()).toContain('reply:second'); expect(f.begin).toHaveBeenCalledTimes(2);
  });
  it('aggregates command presentation failures and still processes subsequent input', async () => {
    f.logStatus.mockRejectedValueOnce(Error('policy unavailable'));
    const t = fixture(), run = t.run(); t.input.end('/config logs\nnext\n');
    expect(await run).toBe(1); expect(t.error()).toContain('policy unavailable'); expect(t.output()).toContain('reply:next');
  });
  it('does not treat the shared trust formatter failure as a successful readonly page', async () => {
    f.trustList.mockRejectedValueOnce(Error('trust unavailable'));
    const t = fixture(), run = t.run(); t.input.end('/trust\nnext\n');
    expect(await run).toBe(1); expect(t.error()).toContain('trust unavailable'); expect(t.output()).toContain('reply:next');
  });
  it('treats an explicit task list read failure as failure, while later input remains usable', async () => {
    f.taskList.mockRejectedValue(Error('task list unavailable'));
    const t = fixture(), run = t.run(); t.input.end('/tasklist\nnext\n');
    expect(await run).toBe(1); expect(t.error()).toContain('task list unavailable');
    expect(t.output()).toContain('reply:next'); expect(f.begin).toHaveBeenCalledOnce();
  });
  it('does not report successful EOF when connection cleanup fails', async () => {
    const t = fixture(); t.connection.dispose.mockRejectedValueOnce(Error('cleanup failed'));
    const run = t.run(); t.input.end('one\n');
    expect(await run).toBe(1); expect(t.error()).toContain('cleanup failed');
    expect(t.connection.dispose).toHaveBeenCalledOnce();
  });
  it('retains noninteractive log policy query and CAS updates while ordinary config still requires interaction', async () => {
    const policy = { version: 4, effective: DEFAULT_LOG_POLICY };
    f.logStatus.mockResolvedValue({ policy }); f.logApplyPolicy.mockResolvedValue({ policy: { ...policy, version: 5 } });
    const t = fixture(), run = t.run(); t.input.end('/config logs\n/config logs 64 2 4\n/config\n');
    expect(await run).toBe(0); expect(f.logStatus).toHaveBeenCalledTimes(2);
    expect(f.logApplyPolicy).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 4,
      patch: expect.objectContaining({ maxBytes: 64 * 1024 * 1024, criticalTtlMs: 2 * 86_400_000 }) }));
    expect(t.output()).toContain('日志策略版本 4'); expect(t.output()).toContain('日志策略版本 5');
    expect(t.output()).toContain('此命令需要交互终端'); expect(f.begin).not.toHaveBeenCalled();
  });
  it('deduplicates the same runtime guidance warning across control and run windows', async () => {
    const t = fixture();
    const warning = { runtimeId: 'runtime-test', hookId: 'zhixing-guidance', phase: 'onWindowOpen', windowIndex: 0, message: 'guidance-first-test' };
    f.beforeInitial = () => t.notify('session.event', { conversationId: 'main-1', scope: 'control', seq: 1,
      event: 'lifecycle:warning', payload: warning, meta: { lineage: 'main' } });
    f.begin.mockImplementationOnce(async () => {
      for (const [seq, message] of [[1, 'guidance-first-test'], [2, 'guidance-changed-test']] as const) {
        t.notify('session.event', { conversationId: 'main-1', scope: 'run', runId: 'guidance-run', seq,
          event: 'lifecycle:warning', payload: { ...warning, windowIndex: 1, message }, meta: { lineage: 'main' } });
      }
      return { kind: 'accepted', turn: { outcome: Promise.resolve({ message: 'done' }) } };
    });
    const run = t.run(); t.input.end('one\n'); expect(await run).toBe(0);
    for (const message of ['guidance-first-test', 'guidance-changed-test']) expect(t.output().split(message).length - 1).toBe(1);
    expect(t.handlerCount('session.event')).toBe(0);
  });
  it('binds actual run diagnostics once without duplicating canonical body or audit ownership', async () => {
    const t = fixture();
    f.begin.mockImplementationOnce(async (input: any) => {
      let seq = 0;
      const event = (name: string, payload: unknown, conversationId = 'main-1') => ({ conversationId, scope: 'run', runId: 'diagnostic-turn', seq: ++seq, event: name, payload, meta: { lineage: 'main' } });
      const frames = [
        event('retry:attempt', { errorType: 'network', attempt: 1, maxRetries: 3, delayMs: 100, willRetry: true }),
        event('retry:success', { errorType: 'network', attemptsTaken: 1, totalDelayMs: 100 }),
        event('retry:exhausted', { errorType: 'network', totalAttempts: 3, lastError: 'retry-end-test' }),
        event('segment:emergency_floor', { segmentId: 'segment-test', tokensBefore: 1000, tokensAfter: 100, droppedTurns: 7, error: 'floor-test' }),
        event('lifecycle:hook_failed', { hookId: 'hook-test', phase: 'onBeforeRun', error: 'hook-failure-test' }),
        event('lifecycle:warning', { runtimeId: 'runtime-test', hookId: 'hook-test', phase: 'onBeforeRun', windowIndex: 0, message: 'warning-test' }),
        event('lifecycle:prompt_rebuilt', { reason: 'compact' }),
        event('interrupt:warn', { kind: 'idle-timeout-warn', elapsedMs: 800, timeoutMs: 1000, chunksReceived: 0 }),
        event('interrupt:fired', { reason: null, interruptedTurnIndex: 0, toolGraceMs: 0 }),
      ];
      for (const frame of frames) {
        t.notify('session.event', frame); t.notify('session.event', frame);
        t.notify('session.event', { ...frame, conversationId: 'outside' });
        t.notify('session.process', { version: 1, source: { conversationId: 'main-1', turnId: 'diagnostic-turn', runId: 'canonical-run', assignmentId: 'a', streamEpoch: 1, sourceSeq: frame.seq, lineage: 'main' }, payload: { kind: 'event', event: { event: frame.event, payload: frame.payload } } });
      }
      t.notify('session.event', { ...frames[0], seq: ++seq, lifecycle: 'closed', event: 'run:closed', payload: null });
      t.notify('session.event', { ...frames[0], seq: ++seq }); // Late frame cannot reopen a closed run.
      f.options.onYield({ type: 'text_delta', text: 'single-body-test' });
      return { kind: 'accepted', turn: { outcome: Promise.resolve({ message: 'done' }) } };
    });
    const run = t.run(); t.input.end('one\n'); expect(await run).toBe(0);
    for (const marker of ['第 1/3 次重试', '重试成功', '重试耗尽', '较早的 7 轮已截断', 'hook-failure-test', 'warning-test', '系统提示词已随注意力窗口重建', 'will auto-cancel', '[interrupted]', 'single-body-test']) {
      expect(t.output().split(marker).length - 1, marker).toBe(1);
    }
    expect(t.handlerCount('session.event')).toBe(0);
  });
  it('binds audits and perspectives before auto-resume without duplicating local body text', async () => {
    const t = fixture();
    f.beforeInitial = () => {
      t.notify('session.process', { version: 1,
        source: { conversationId: 'main-1', turnId: 'audit-turn', runId: 'audit-run', assignmentId: 'a', streamEpoch: 1, sourceSeq: 1, lineage: 'main' },
        payload: { kind: 'event', event: { event: 'security:steward_review', payload: { tool: 'read', operation: '读取文件', decision: 'safe', reason: '已请求', confidence: 1 } } } });
      t.notify('session.event', { conversationId: 'main-1', scope: 'run', runId: 'host-turn', seq: 0,
        event: 'orchestration:run_start', payload: { runId: 'orchestration', definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID, nodeCount: 3, maxParallel: 2 }, meta: {} });
    };
    const run = t.run(); t.input.end('one\n');
    expect(await run).toBe(0);
    expect(t.output()).toContain('安全助理放行'); expect(t.output()).toContain('多视角评议：3 个节点开始协作');
    expect(t.output().match(/reply:one/gu)).toHaveLength(1);
    expect(t.handlerCount('session.process')).toBe(0); expect(t.handlerCount('session.event')).toBe(0);
  });
  it('recovers a conversation and drains piped input that reaches EOF during startup', async () => {
    const t = fixture(); const run = t.run(); t.input.end('one\ntwo\nthree');
    expect(await run).toBe(0);
    expect(f.begin.mock.calls.map(([input]) => input.parts[0].text)).toEqual(['one', 'two', 'three']);
    expect(t.output()).toContain('恢复对话'); expect(t.output()).toContain('reply:one'); expect(t.output()).toContain('reply:three');
    expect(f.dispose).toHaveBeenCalledOnce(); expect(t.connection.dispose).toHaveBeenCalledOnce();
    expect(t.signals.listenerCount('SIGINT')).toBe(0);
  });
  it('uses the existing session commands and dynamic skills without sending local commands as user turns', async () => {
    const t = fixture(); const run = t.run();
    t.input.end('/new\n/name changed\n/resume main-1\n/clear\n/custom-skill ask\n/quit\nnever-send\n');
    expect(await run).toBe(0);
    expect(f.create).toHaveBeenCalledOnce(); expect(f.rename).toHaveBeenCalledWith('changed');
    expect(f.resume).toHaveBeenCalledWith('main-1'); expect(f.clear).toHaveBeenCalledOnce();
    expect(f.begin.mock.calls.map(([input]) => input.parts[0].text)).toEqual(['/custom-skill ask']);
    expect(f.skillDetach).toHaveBeenCalledOnce();
  });
  it('reports missing non-TTY setup with code 2 and records the original failure', async () => {
    const t = fixture(); t.connection.ensure.mockRejectedValue(Error('not configured'));
    const result = { kind: 'non-tty', missingLabels: ['模型'] } as const;
    const records = { record: vi.fn() } as unknown as LogRecordPort;
    t.input.end('must-not-send\n');
    expect(await t.run({ runtimeRecords: records, checkConfiguration: async () => result as unknown as StartupCheckResult })).toBe(2);
    expect(t.error()).toContain('非交互终端'); expect(t.error()).toContain('模型');
    expect(f.startupFailure).toHaveBeenCalledWith(records, result); expect(f.begin).not.toHaveBeenCalled();
  });
  it('preserves malformed config classification rather than reporting a transport error', async () => {
    const t = fixture(); t.connection.ensure.mockRejectedValue(Error('unavailable')); t.input.end();
    const result = { kind: 'schema-error', message: 'invalid JSON', filePath: 'config.jsonc' } as const;
    const records = { record: vi.fn() } as unknown as LogRecordPort;
    expect(await t.run({ runtimeRecords: records, checkConfiguration: async () => result })).toBe(2);
    expect(f.startupFailure).toHaveBeenCalledWith(records, result); expect(t.error()).toContain('invalid JSON');
  });
  it('does not send an already accepted line again after disconnect/reconnect', async () => {
    const t = fixture(); let finish!: (outcome: { message: string }) => void;
    f.begin.mockImplementationOnce(async () => ({ kind: 'accepted', turn: {
      outcome: new Promise(resolve => { finish = resolve; }),
    } }));
    const run = t.run(); t.input.end('one\ntwo\n');
    for (let attempt = 0; attempt < 20 && !finish; attempt++) await tick();
    expect(f.begin).toHaveBeenCalledOnce(); t.disconnect(); await t.reconnect();
    finish({ message: 'done' }); expect(await run).toBe(0);
    expect(f.begin.mock.calls.map(([input]) => input.parts[0].text)).toEqual(['one', 'two']);
    expect(f.observe).toHaveBeenCalledOnce();
  });
  it('denies a safety request without stealing the next input line', async () => {
    const t = fixture();
    f.begin.mockImplementationOnce(async () => {
      f.confirm!({ id: 'request-1', display: { title: '允许？', body: { kind: 'file-read', path: '/tmp/file' } },
        options: [{ kind: 'allow-once', label: '允许' }, { kind: 'deny', label: '拒绝' }] });
      await tick(); return { kind: 'accepted', turn: { outcome: Promise.resolve({ message: 'denied safely' }) } };
    });
    const run = t.run(); t.input.end('one\nyes\n'); expect(await run).toBe(0);
    expect(f.resolve).toHaveBeenCalledWith('request-1', { kind: 'deny' });
    expect(f.begin.mock.calls.map(([input]) => input.parts[0].text)).toEqual(['one', 'yes']);
  });
  it('interrupts an active run and waits for its outcome before cleaning up', async () => {
    const t = fixture(); let finish!: (outcome: { message: string }) => void;
    f.begin.mockImplementationOnce(async () => ({ kind: 'accepted', turn: {
      outcome: new Promise(resolve => { finish = resolve; }),
    } }));
    const run = t.run(); t.input.end('one\n');
    for (let attempt = 0; attempt < 20 && !finish; attempt++) await tick();
    t.signals.emit('SIGINT'); expect(f.abort).toHaveBeenCalledOnce(); expect(t.connection.dispose).not.toHaveBeenCalled();
    finish({ message: '本次运行已中止。' }); expect(await run).toBe(0);
    expect(t.output()).toContain('本次运行已中止。'); expect(t.connection.dispose).toHaveBeenCalledOnce();
  });
});


it('routes leading Chinese slash aliases locally and preserves ordinary punctuation payloads', async () => {
  const t = fixture(), run = t.run();
  t.input.end('\u3001help\n\u3001clear\n\u3001custom-skill ask\nbody\u3001clear\n\u3001quit\nnever-send\n');
  expect(await run).toBe(0); expect(f.clear).toHaveBeenCalledOnce();
  expect(f.begin.mock.calls.map(([input]) => input.parts[0].text)).toEqual(['/custom-skill ask', 'body\u3001clear']);
  expect(t.output()).toContain('/help');
});
