import { describe, expect, it, vi } from 'vitest';
import type { SessionAdvancementDetailResult } from '@zhixing/rpc';
import type { TrustAdministrationRule } from '@zhixing/core/trust-administration';
import { TerminalDecisionCommands, type TerminalDecisionController, type TerminalDecisionOptions, type TerminalDecisionScope } from '../decision-commands.js';
import type { TerminalSelectionPort } from '../selection.js';

const rule = (id: string): TrustAdministrationRule => ({ id, pattern: { tool: 'bash', argument: 'ls *' }, decision: 'allow',
  scope: 'context', contextId: { kind: 'main' }, createdAt: 0, lastMatchedAt: 0, matchCount: 0 });
type Uncertain = Awaited<ReturnType<TerminalDecisionController['uncertainRuns']>>[number];
const notice = (runId = 'run-1'): Uncertain => ({ v: 1, state: 'uncertain', statusRevision: 3,
  ref: { execution: 'conversation', conversationId: 'conv-1', runId, ownerEpoch: 2 },
  openFactDigest: 'sha256:seen', actions: ['verify-side-effects', 'abandon', 'retry-risk-ack'], at: '2026-10-06T00:00:00.000Z' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const controller = {
    current: { conversationId: 'conv-1' },
    advancementDetail: vi.fn(async (): Promise<SessionAdvancementDetailResult> => ({ conversationId: 'conv-1', detail: null })),
    uncertainRuns: vi.fn(async (): Promise<Uncertain[]> => []),
    resolveUncertain: vi.fn<TerminalDecisionController['resolveUncertain']>(async () => {}),
  };
  let current: TerminalDecisionController | undefined = controller;
  const management = {
    trustList: vi.fn(async () => [rule('rule-1')]), trustRevoke: vi.fn(async () => true),
    securityStatus: vi.fn<TerminalDecisionOptions['management']['securityStatus']>(async () => ({
      contextId: { kind: 'main' }, workspacePath: null, permissionRules: [], builtinRules: [], rateLimits: [], confirmations: [],
    })),
  };
  const choose = vi.fn<TerminalSelectionPort>(async () => ({ itemId: 'return' }));
  const publish = vi.fn<TerminalDecisionOptions['publish']>(async () => {});
  const resumeRubric = vi.fn<TerminalDecisionOptions['resumeRubric']>(async scope => { scope.assertCurrent(); });
  const abort = new AbortController();
  const owner = new TerminalDecisionCommands({ controller: () => current, management, choose, publish, resumeRubric, signal: abort.signal });
  const text = () => [...choose.mock.calls.map(([page]) => page.message ?? ''), ...publish.mock.calls.map(([page]) => page.message)].join('\n');
  return { owner, controller, management, choose, publish, resumeRubric, abort, text,
    replace(value: TerminalDecisionController | undefined) { current = value; } };
}
const pendingDetail = (): SessionAdvancementDetailResult => ({
  conversationId: 'conv-1', detail: { advancementSessionId: 'adv-1', status: 'awaiting-rubric-confirmation', rubricTitle: '验收标准',
    facts: { sessionId: 'adv-1', conversationId: 'conv-1', status: 'awaiting-rubric-confirmation', reviewedRunCount: 0,
      criteria: [], attemptedStrategies: [], lastEvidence: [], usage: { judge: { inputTokens: 0, outputTokens: 0 }, run: { inputTokens: 0, outputTokens: 0 }, totalTokens: 0 } } },
});

describe('terminal decision commands', () => {
  it('reuses trust scope/contributor wording and keeps help independent of a query', async () => {
    const f = fixture();
    f.management.trustList.mockResolvedValueOnce([rule('main'), { ...rule('all'), scope: 'global', contributors: [{ origin: 'user', timestamp: 0 }] }]);
    await f.owner.run('trust', '');
    expect(f.text()).toContain('主模式'); expect(f.text()).toContain('全局'); expect(f.text()).toContain('[你]');
    expect(f.management.trustList).toHaveBeenCalledWith('conv-1');
    await f.owner.run('trust', 'help');
    expect(f.management.trustList).toHaveBeenCalledTimes(1); expect(f.text()).toContain('/trust revoke <id>');
  });
  it('checks typed revoke membership and uses the captured conversation, including false receipts', async () => {
    const f = fixture();
    await f.owner.run('trust', 'revoke missing');
    expect(f.management.trustRevoke).not.toHaveBeenCalled(); expect(f.text()).toContain('不存在');
    f.management.trustRevoke.mockResolvedValueOnce(false);
    await f.owner.run('trust', 'revoke rule-1');
    expect(f.management.trustRevoke).toHaveBeenCalledWith('rule-1', 'conv-1'); expect(f.text()).not.toContain('已撤销');
    await f.owner.run('trust', 'revoke'); expect(f.text()).toContain('用法');
  });
  it('shows the security overview and rules explanation as structured pages, keeps help and explicit lookup failures', async () => {
    const f = fixture();
    // 概览：结构化信息、默认选中“返回输入”、可进入规则说明；说明页返回回到概览，同一份快照不重复查询
    f.choose.mockResolvedValueOnce({ itemId: 'option:rules' }).mockResolvedValueOnce({ itemId: 'option:back' }).mockResolvedValueOnce({ itemId: 'option:done' });
    await f.owner.run('security', '');
    const pages = f.choose.mock.calls.map(([page]) => page);
    expect(pages.map(page => page.title)).toEqual(['安全状态', '规则说明', '安全状态']);
    expect(pages[0]!.message).toBeUndefined();
    expect(pages[0]!.summary?.sections.map(section => section.title)).toEqual(['信任规则 · 共 0 条', '允许累计', '调用频率（当前窗口）']);
    expect(pages[0]!.initialItemId).toBe('option:done');
    expect(pages[0]!.choices?.map(choice => choice.label)).toEqual(['返回输入', '查看规则说明']);
    expect(pages[1]!.choices?.map(choice => choice.label)).toEqual(['返回安全状态']);
    expect(f.management.securityStatus).toHaveBeenCalledTimes(1);
    // 说明页按 Esc 回到概览；/security rules 直接打开说明页，返回即结束
    f.choose.mockClear();
    f.choose.mockResolvedValueOnce({ itemId: 'option:rules' }).mockResolvedValueOnce({ itemId: 'return', cancelCause: 'escape' });
    await f.owner.run('security', '');
    expect(f.choose.mock.calls.map(([page]) => page.title)).toEqual(['安全状态', '规则说明', '安全状态']);
    f.choose.mockClear();
    await f.owner.run('security', 'rules');
    expect(f.choose.mock.calls.map(([page]) => [page.title, page.choices?.map(choice => choice.label)])).toEqual([['规则说明', ['返回输入']]]);
    await f.owner.run('security', 'help');
    expect(f.text()).toContain('/security rules');
    // 读取失败如实显示失败，不变成零记录的页面
    f.management.securityStatus.mockRejectedValueOnce(Error('offline'));
    const shown = f.choose.mock.calls.length;
    await f.owner.run('security', '');
    expect(f.choose.mock.calls.length).toBe(shown);
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ title: '安全状态', error: true, message: expect.stringContaining('安全状态不可用：offline') }));
  });
  it('carries trust lookup and revoke failures as typed failures instead of success-shaped text', async () => {
    const f = fixture(); f.management.trustList.mockRejectedValueOnce(Error('offline'));
    await f.owner.run('trust');
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ error: true, message: expect.stringContaining('offline') }));
    await f.owner.run('trust', 'revoke missing');
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ error: true, message: expect.stringContaining('不存在') }));
    expect(f.choose).not.toHaveBeenCalled(); expect(f.management.trustRevoke).not.toHaveBeenCalled();
  });
  it('paginates a long trust result through the shared selection port without retaining hidden extra pages', async () => {
    const f = fixture();
    f.management.trustList.mockResolvedValueOnce(Array.from({ length: 150 }, (_, i) => ({ ...rule(`rule-${i}`), pattern: { tool: 'read', argument: 'x'.repeat(100) } })));
    f.choose.mockResolvedValueOnce({ itemId: 'next' });
    await f.owner.run('trust', '');
    expect(f.choose).toHaveBeenCalledTimes(2);
    expect(f.choose.mock.calls[0]![0].choices?.some(item => item.id === 'next')).toBe(true);
    expect(f.choose.mock.calls[1]![0].choices?.some(item => item.id === 'previous')).toBe(true);
    expect(f.choose.mock.calls.every(([page]) => (page.message?.length ?? 0) < 4200)).toBe(true);
  });
  it('does not revoke after a context switch while the membership query is pending', async () => {
    const f = fixture(), gate = deferred<TrustAdministrationRule[]>();
    f.management.trustList.mockReturnValueOnce(gate.promise);
    const work = f.owner.run('trust', 'revoke rule-1');
    f.controller.current = { conversationId: 'scene-2' }; gate.resolve([rule('rule-1')]); await work;
    expect(f.management.trustRevoke).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });
  it('drops old results across disconnect/reconnect to the same controller and allows no concurrent operation', async () => {
    const f = fixture(), gate = deferred<TrustAdministrationRule[]>();
    f.management.trustList.mockReturnValueOnce(gate.promise);
    const work = f.owner.run('trust');
    await expect(f.owner.run('security')).rejects.toThrow('尚未结束');
    f.owner.invalidate(); gate.resolve([rule('rule-1')]); await work;
    expect(f.choose).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
    await f.owner.run('security', 'help'); expect(f.choose).toHaveBeenCalledOnce();
  });
  it('shows absent and pending advancement, handing resume to the one existing rubric owner', async () => {
    const f = fixture();
    await f.owner.run('advancement'); expect(f.text()).toContain('没有推进任务');
    // 页头说明是哪个对话的推进；没有名字时不造空说明
    expect(f.choose.mock.calls.at(-1)![0]).not.toHaveProperty('chromeDescription');
    f.controller.current = { conversationId: 'conv-1', name: '整理周报' } as typeof f.controller.current;
    await f.owner.run('advancement');
    expect(f.choose.mock.calls.at(-1)![0]).toMatchObject({ title: '任务推进', chromeDescription: '对话：整理周报' });
    f.controller.advancementDetail.mockResolvedValueOnce(pendingDetail());
    f.choose.mockResolvedValueOnce({ itemId: 'option:resume' });
    await f.owner.run('advancement');
    expect(f.resumeRubric).toHaveBeenCalledOnce();
    const scope = f.resumeRubric.mock.calls[0]![0];
    expect(scope.controller).toBe(f.controller); expect(scope.conversationId).toBe('conv-1');
    expect(scope.signal.aborted).toBe(true);
  });
  it('keeps an awaiting rubric on Esc and invalidates a resumed loop before its later action', async () => {
    const f = fixture();
    f.controller.advancementDetail.mockResolvedValue(pendingDetail());
    await f.owner.run('advancement'); expect(f.resumeRubric).not.toHaveBeenCalled();
    const gate = deferred<void>(); let captured: TerminalDecisionScope | undefined;
    f.choose.mockResolvedValueOnce({ itemId: 'option:resume' });
    f.resumeRubric.mockImplementationOnce(async scope => { captured = scope; await gate.promise; scope.assertCurrent(); });
    const work = f.owner.run('advancement');
    await vi.waitFor(() => expect(captured).toBeDefined());
    f.owner.invalidate(); gate.resolve(); await work;
    expect(captured!.signal.aborted).toBe(true); expect(f.publish).not.toHaveBeenCalled();
  });
  it.each(['user-abandoned', 'user-verified-side-effects', 'user-retry-acknowledged'] as const)('preserves uncertainty risks and the original %s authority fence', async decision => {
    const f = fixture(), pending = notice(); f.controller.uncertainRuns.mockResolvedValueOnce([pending]);
    f.choose.mockResolvedValueOnce({ itemId: `option:${decision}` });
    await f.owner.run('resolve');
    expect(f.controller.resolveUncertain).toHaveBeenCalledExactlyOnceWith(pending, decision);
    expect(f.text()).toContain('文件修改等操作可能已经发生'); expect(f.text()).toContain('重新执行可能产生重复效果');
    expect(f.choose.mock.calls[0]![0].choices?.slice(0, 4).map(item => item.id)).toEqual([
      'option:return', 'option:user-abandoned', 'option:user-verified-side-effects', 'option:user-retry-acknowledged',
    ]);
    expect(f.publish).toHaveBeenCalledOnce();
  });
  it.each([undefined, { itemId: 'option:return' }])('does not default to any resolution on dismissal %j', async response => {
    const f = fixture(); f.controller.uncertainRuns.mockResolvedValueOnce([notice()]);
    f.choose.mockResolvedValueOnce(response); await f.owner.run('resolve');
    expect(f.controller.resolveUncertain).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });
  it('rejects a stale selected resolution and suppresses a late successful receipt', async () => {
    const f = fixture(), choice = deferred<{ itemId: string }>();
    f.controller.uncertainRuns.mockResolvedValue([notice()]); f.choose.mockReturnValueOnce(choice.promise);
    const first = f.owner.run('resolve'); await vi.waitFor(() => expect(f.choose).toHaveBeenCalledOnce());
    f.owner.invalidate(); choice.resolve({ itemId: 'option:user-abandoned' }); await first;
    expect(f.controller.resolveUncertain).not.toHaveBeenCalled();
    const receipt = deferred<void>(); f.choose.mockResolvedValueOnce({ itemId: 'option:user-abandoned' });
    f.controller.resolveUncertain.mockReturnValueOnce(receipt.promise);
    const second = f.owner.run('resolve'); await vi.waitFor(() => expect(f.controller.resolveUncertain).toHaveBeenCalledOnce());
    f.abort.abort(); receipt.resolve(); await second;
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('reports a failed mutation without claiming success or automatically retrying', async () => {
    const f = fixture(); f.controller.uncertainRuns.mockResolvedValueOnce([notice(), notice('run-2')]);
    f.choose.mockResolvedValueOnce({ itemId: 'option:user-retry-acknowledged' });
    f.controller.resolveUncertain.mockRejectedValueOnce(Error('receipt unavailable'));
    await f.owner.run('resolve');
    expect(f.controller.resolveUncertain).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ error: true, message: expect.stringContaining('不会自动重试') }));
  });
});
