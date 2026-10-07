import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOG_POLICY } from '@zhixing/core/logging';
import { LogRpcClient } from '@zhixing/rpc';
import type { SessionUsageResult, SessionCompactResult } from '@zhixing/rpc/session-wire';
import { RpcConversationFacade } from '../../runtime/rpc-conversation-facade.js';
import { makeFakeHostLink } from '../../runtime/__tests__/fake-host-link.js';
import { TerminalInformationCommands, type TerminalInformationController, type TerminalInformationOptions } from '../information-commands.js';
import type { TerminalSelectionPort } from '../selection.js';

const budget = { currentTokens: 40_000, effectiveWindow: 80_000, contextWindow: 100_000, usageRatio: 0.5, status: 'normal' } as const;
const usage = (): SessionUsageResult => ({ budget, turnCount: 2, calibrationFactor: 1, subUsages: [] });
type LogStatus = Awaited<ReturnType<TerminalInformationOptions['logs']['status']>>;
const logStatus = (version = 4): LogStatus => ({ layout: 'zxlog/1', storeId: 'test-store',
  policy: { version, effective: { ...DEFAULT_LOG_POLICY, maxBytes: 128 * 1024 * 1024, criticalTtlMs: 7 * 86_400_000 } },
  bytes: 0, files: 0, upper: 0, retainedSegments: 0, pendingReclaims: 0, overdue: false });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
function fixture() {
  const controller = { current: { conversationId: 'conv-1' },
    usage: vi.fn<TerminalInformationController['usage']>(async () => usage()),
    contextBudget: vi.fn<TerminalInformationController['contextBudget']>(async () => usage()),
    compact: vi.fn<TerminalInformationController['compact']>(async () => ({ modified: true, tokensBefore: 40_000, tokensAfter: 10_000 })),
  };
  let current: TerminalInformationController | undefined = controller;
  const getPrimaryModel = vi.fn(() => ({ model: 'model-a', providerId: 'provider-a' }));
  const logs = { status: vi.fn<TerminalInformationOptions['logs']['status']>(async () => logStatus()),
    applyPolicy: vi.fn<TerminalInformationOptions['logs']['applyPolicy']>(async () => logStatus(5)) };
  const choose = vi.fn<TerminalSelectionPort>(async () => ({ itemId: 'return' }));
  const publish = vi.fn<TerminalInformationOptions['publish']>(async (_result, scope) => { scope.assertCurrent(); });
  const abort = new AbortController();
  const owner = new TerminalInformationCommands({ controller: () => current, getPrimaryModel, logs, choose, publish, signal: abort.signal });
  return { owner, controller, getPrimaryModel, logs, choose, publish, abort,
    text: () => choose.mock.calls.map(([page]) => page.message ?? '').join('\n'),
    messages: () => publish.mock.calls.map(([result]) => result.message).join('\n'),
    replace(value: TerminalInformationController | undefined) { current = value; } };
}

describe('terminal information commands', () => {
  it('uses the existing real facade and LogRpcClient paths without a second domain authority', async () => {
    const fake = makeFakeHostLink();
    fake.setResponder(method => method === 'session.usage' || method === 'session.contextBudget' ? usage()
      : method === 'session.compact' ? { modified: false } : logStatus());
    const f = fixture(), facade = new RpcConversationFacade(fake.link);
    const controller: TerminalInformationController = { current: { conversationId: 'conv-1' },
      usage: () => facade.usage('conv-1'), contextBudget: () => facade.contextBudget('conv-1'), compact: () => facade.compact('conv-1') };
    const owner = new TerminalInformationCommands({ controller: () => controller, getPrimaryModel: f.getPrimaryModel,
      logs: new LogRpcClient(fake.link), signal: f.abort.signal, choose: f.choose, publish: f.publish });
    await owner.run('usage'); await owner.run('context'); await owner.run('compact'); await owner.run('config', 'logs');
    await owner.run('config', 'logs 64 2 4');
    expect(fake.requests.map(request => request.method)).toEqual(['session.usage', 'session.contextBudget', 'session.compact', 'logs.status', 'logs.status', 'logs.apply-policy']);
    for (const request of fake.requests.slice(0, 3)) expect(request.params).toMatchObject({ conversationId: 'conv-1' });
    expect(fake.requests.at(-1)?.params).toMatchObject({ expectedVersion: 4, patch: { maxBytes: 64 * 1024 * 1024, criticalTtlMs: 2 * 86_400_000 } });
  });
  it('reads the current model each invocation and does not invent a model-switch mutation', async () => {
    const f = fixture(); await f.owner.run('model');
    f.getPrimaryModel.mockReturnValueOnce({ model: 'model-b', providerId: 'provider-b' }); await f.owner.run('model', 'ignored-original-argument');
    expect(f.text()).toContain('model-a'); expect(f.text()).toContain('model-b'); expect(f.text()).toContain('provider-b');
    expect(f.getPrimaryModel).toHaveBeenCalledTimes(2); expect(f.controller.compact).not.toHaveBeenCalled(); expect(f.logs.applyPolicy).not.toHaveBeenCalled();
  });
  it('paginates long structured child usage through the shared selection and keeps returning side-effect free', async () => {
    const f = fixture(); f.controller.usage.mockResolvedValueOnce({ ...usage(), subUsages: Array.from({ length: 180 }, (_, index) => ({
      index: index + 1, description: `子任务 ${index + 1} 👩‍💻`, status: 'succeeded', tokens: index, toolUses: 0, durationMs: 0,
    })) });
    f.choose.mockImplementation(async page => page.choices?.some(choice => choice.id === 'next') ? { itemId: 'next' } : { itemId: 'return' });
    await f.owner.run('usage');
    expect(f.choose.mock.calls.length).toBeGreaterThan(1); expect(f.text()).toContain('#180 ✓ 成功'); expect(f.text()).toContain('子任务总计');
    expect(f.choose.mock.calls.every(([page]) => (page.message?.length ?? 0) < 4200)).toBe(true);
    expect(f.controller.usage).toHaveBeenCalledOnce(); expect(f.controller.compact).not.toHaveBeenCalled();
  });
  it.each(['usage', 'context'] as const)('reports %s lookup errors without a fake empty or zero result and can retry explicitly', async name => {
    const f = fixture(), method = name === 'usage' ? f.controller.usage : f.controller.contextBudget;
    method.mockRejectedValueOnce(Error('host query unavailable'));
    await f.owner.run(name); expect(f.messages()).toContain(name === 'usage' ? '用量信息不可用' : '上下文信息不可用');
    expect(f.messages()).toContain('host query unavailable'); expect(f.choose).not.toHaveBeenCalled();
    await f.owner.run(name); expect(f.choose).toHaveBeenCalledOnce();
  });
  it('preserves compression progress, emergency disclosure, no-op, missing counts and failure', async () => {
    const f = fixture(); f.controller.compact.mockResolvedValueOnce({ modified: true, tokensBefore: 40_000, tokensAfter: 0,
      emergencyFloor: { droppedTurns: 3, error: 'summary failed' } });
    await f.owner.run('compact');
    expect(f.publish.mock.calls[0]?.[0]).toMatchObject({ busy: true, message: '正在压缩上下文…' });
    expect(f.messages()).toContain('摘要服务不可用'); expect(f.messages()).toContain('3 轮已截断');
    expect(f.messages()).toContain('完整原文仍在对话历史中'); expect(f.text()).toContain('40k → 0k');
    f.controller.compact.mockResolvedValueOnce({ modified: false }); await f.owner.run('compact'); expect(f.text()).toContain('已无可压缩内容');
    f.controller.compact.mockResolvedValueOnce({ modified: true }); await f.owner.run('compact'); expect(f.text()).toContain('窗口已折叠');
    f.publish.mockClear(); f.choose.mockClear(); f.controller.compact.mockRejectedValueOnce(Error('no summarizer'));
    await f.owner.run('compact'); expect(f.messages()).toContain('压缩失败：no summarizer'); expect(f.messages()).not.toContain('压缩完成'); expect(f.choose).not.toHaveBeenCalled();
  });
  it('checks scope again after progress delivery and before starting compression', async () => {
    const f = fixture(), gate = deferred<void>(); f.publish.mockReturnValueOnce(gate.promise);
    const work = f.owner.run('compact'); expect(f.publish).toHaveBeenCalledOnce();
    f.owner.invalidate(); gate.resolve(); await work;
    expect(f.controller.compact).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
  });
  it('does not describe a committed compression as failed when only its result page failed', async () => {
    const f = fixture(); f.choose.mockRejectedValueOnce(Error('view unavailable')); await f.owner.run('compact');
    expect(f.controller.compact).toHaveBeenCalledOnce(); expect(f.messages()).toContain('操作已有回执，但结果显示未完成');
    expect(f.messages()).toContain('不会自动重试或回滚'); expect(f.messages()).not.toContain('压缩失败');
  });
  it('shows effective and desired log policies plus blocked reason without applying on read', async () => {
    const f = fixture(), status = logStatus(); f.logs.status.mockResolvedValueOnce({ ...status,
      policy: { ...status.policy, desired: { ...status.policy.effective, maxBytes: 32 * 1024 * 1024 }, blocked: '等待治理释放空间' } });
    await f.owner.run('config', 'logs');
    for (const expected of ['日志策略版本 4', '已生效容量 128 MiB', '关键记录保留 7 天', '待生效容量 32 MiB', '等待治理释放空间', '/config logs <容量MiB> <关键记录天数> 4']) expect(f.text()).toContain(expected);
    expect(f.logs.applyPolicy).not.toHaveBeenCalled();
  });
  it('reuses the exact versioned policy handler and desired baseline dependent TTLs', async () => {
    const f = fixture(), status = logStatus(); f.logs.status.mockResolvedValueOnce({ ...status, policy: { ...status.policy,
      desired: { ...status.policy.effective, detailTtlMs: 12 * 86_400_000, attachmentTtlMs: 86_400_000 } } });
    await f.owner.run('config', 'logs 64 2 4');
    expect(f.logs.applyPolicy).toHaveBeenCalledExactlyOnceWith({ expectedVersion: 4, patch: {
      maxBytes: 64 * 1024 * 1024, criticalTtlMs: 2 * 86_400_000, detailTtlMs: 2 * 86_400_000, attachmentTtlMs: 86_400_000,
    } });
    expect(f.text()).toContain('日志策略版本 5');
  });
  it.each(['logs 64', 'logs 64 2', 'logs 0 2 4', 'logs 64 -1 4', 'logs 64 2 0', 'logs 1.5 2 4', 'logs no 2 4'])('keeps invalid policy arguments %s free of host reads and writes', async args => {
    const f = fixture(); await f.owner.run('config', args);
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ error: true }), expect.anything());
    expect(f.logs.status).not.toHaveBeenCalled(); expect(f.logs.applyPolicy).not.toHaveBeenCalled();
  });
  it('preserves log version conflicts and query failures and never retries a write automatically', async () => {
    const f = fixture(); f.logs.applyPolicy.mockRejectedValueOnce(Error('LOG_POLICY_VERSION_CONFLICT'));
    await f.owner.run('config', 'logs 64 2 4'); expect(f.messages()).toContain('LOG_POLICY_VERSION_CONFLICT'); expect(f.choose).not.toHaveBeenCalled();
    expect(f.logs.applyPolicy).toHaveBeenCalledOnce();
    f.logs.status.mockRejectedValueOnce(Error('logs unavailable')); await f.owner.run('config', 'logs');
    expect(f.messages()).toContain('logs unavailable'); expect(f.logs.applyPolicy).toHaveBeenCalledOnce();
  });
  it.each(['controller', 'conversation', 'generation', 'disconnect', 'close'] as const)('rejects a CAS submission after %s changes during its baseline read', async kind => {
    const f = fixture(), gate = deferred<LogStatus>(); f.logs.status.mockReturnValueOnce(gate.promise);
    const work = f.owner.run('config', 'logs 64 2 4');
    if (kind === 'controller') f.replace({ ...f.controller });
    if (kind === 'conversation') f.controller.current = { conversationId: 'conv-2' };
    if (kind === 'generation') f.owner.invalidate();
    if (kind === 'disconnect') f.replace(undefined);
    if (kind === 'close') f.abort.abort();
    gate.resolve(logStatus()); await work;
    expect(f.logs.applyPolicy).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
  });
  it.each(['success', 'failure'] as const)('drops late query %s and bounds a blocked operation without allowing concurrent queues', async outcome => {
    const f = fixture(), gate = deferred<SessionUsageResult>(); f.controller.usage.mockReturnValueOnce(gate.promise);
    const work = f.owner.run('usage'); await expect(f.owner.run('context')).rejects.toThrow('尚未结束'); f.owner.invalidate();
    if (outcome === 'success') gate.resolve(usage()); else gate.reject(Error('late query failure'));
    await work; expect(f.choose).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
    await f.owner.run('context'); expect(f.controller.contextBudget).toHaveBeenCalledOnce();
  });
  it.each(['compact', 'policy'] as const)('drops a late %s receipt without rollback or a second submission', async kind => {
    const f = fixture(), compact = deferred<SessionCompactResult>(), policy = deferred<LogStatus>();
    f.controller.compact.mockReturnValueOnce(compact.promise); f.logs.applyPolicy.mockReturnValueOnce(policy.promise);
    const work = kind === 'compact' ? f.owner.run('compact') : f.owner.run('config', 'logs 64 2 4');
    await vi.waitFor(() => expect(kind === 'compact' ? f.controller.compact : f.logs.applyPolicy).toHaveBeenCalledOnce());
    f.owner.invalidate(); f.publish.mockClear();
    if (kind === 'compact') compact.resolve({ modified: true }); else policy.resolve(logStatus(5));
    await work; expect(f.publish).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
    expect(kind === 'compact' ? f.controller.compact : f.logs.applyPolicy).toHaveBeenCalledOnce();
  });
  it('ends a stale page without reopening it and disposes both pending and future work', async () => {
    const f = fixture(), gate = deferred<{ itemId: string }>(); f.choose.mockReturnValueOnce(gate.promise);
    const work = f.owner.run('model'); expect(f.choose).toHaveBeenCalledOnce(); f.owner.dispose(); f.owner.dispose();
    gate.resolve({ itemId: 'next' }); await work;
    expect(f.choose).toHaveBeenCalledOnce(); await expect(f.owner.run('model')).rejects.toThrow('连接不可用');
  });
  it('exposes an operation scope so delayed sinks cannot commit into a successor view', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>(); let committed = false;
    f.publish.mockImplementationOnce(async (_result, scope) => { entered.resolve(); await release.promise; if (scope.isCurrent()) committed = true; });
    const work = f.owner.run('compact'); await entered.promise; f.owner.invalidate(); release.resolve(); await work;
    expect(committed).toBe(false); expect(f.publish.mock.calls[0]?.[1].signal.aborted).toBe(true); expect(f.controller.compact).not.toHaveBeenCalled();
  });
  it('does not leak a stale error-view delivery failure into the successor context', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>();
    f.controller.usage.mockRejectedValueOnce(Error('query failed'));
    f.publish.mockImplementationOnce(async (_result, scope) => { entered.resolve(); await release.promise; scope.assertCurrent(); });
    const work = f.owner.run('usage'); await entered.promise; f.owner.invalidate(); release.resolve();
    await expect(work).resolves.toBeUndefined(); expect(f.choose).not.toHaveBeenCalled();
  });
  it('rejects oversized results visibly and preserves command boundaries', async () => {
    const f = fixture(); f.getPrimaryModel.mockReturnValueOnce({ model: 'x'.repeat(2 * 1024 * 1024), providerId: 'p' });
    await f.owner.run('model'); expect(f.messages()).toContain('容量'); expect(f.choose).not.toHaveBeenCalled();
    await expect(f.owner.run('config', 'models')).rejects.toThrow('用法');
    await expect(f.owner.run('logs', '')).rejects.toThrow('未知信息命令');
    await expect(f.owner.run('usage', '中'.repeat(8192))).rejects.toThrow('参数过长');
    expect(f.logs.status).not.toHaveBeenCalled(); expect(f.logs.applyPolicy).not.toHaveBeenCalled();
  });
});
