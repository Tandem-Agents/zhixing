import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';

// 从只读历史（F2）返回：运行生产的 #action（history-close、display-retry）、#readOnly、#restoreReturnReading、#leaveHistoryRead、
// #openHistory、#loadOfflineHistory、#historyPage、#historyPageNow、#offlineHistoryPage、#displayPage 与 #publish。
// 只替换只读目录与读取器、显示存储与传输；读取器按会话给出空页，故障在读取器上注入。
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const methods = ['#action', '#readOnly', '#restoreReturnReading', '#leaveHistoryRead', '#openHistory', '#loadOfflineHistory', '#historyPage', '#historyPageNow',
  '#offlineHistoryPage', '#publish', '#dropHandoff', '#ownsPage', '#publishHistoryView', '#noteHistoryView', '#displayPage'].map(name => {
  const node = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  if (!node) throw Error(`Missing production method ${name}`);
  return node.getText(source).replace(/#/gu, '');
}).join('\n');
const failures: unknown[] = [];
const Harness = new Function('formatRelativeTimeText', 'terminalEnvironment', 'recordTerminalFailure', 'AsyncLocalStorage',
  ts.transpile(`class Harness {\ncommandScope = new AsyncLocalStorage();\n${methods}\n} return Harness;`, { target: ts.ScriptTarget.ES2022 }))(
  () => '', () => undefined, (_records: unknown, error: unknown) => { failures.push(error); }, AsyncLocalStorage);

const disconnected = { kind: 'conversation', title: 'A', connected: false, connectionState: 'unavailable', readyForInput: true, message: '连接已断开，输入与已有内容保留。按 Enter 重试。' };
function fixture(options: { controller?: boolean; opened?: string } = {}) {
  const h = new Harness(), events: any[] = [], resets: string[] = [], failing = new Set<string>(), reads: string[] = [];
  let recoveries = 0;
  const opened = options.opened ?? 'B';
  Object.assign(h, {
    args: [], abort: new AbortController(), generation: 40, readingGeneration: 1, displayRevision: 8, startupAttempt: undefined, logging: { records: undefined },
    mainView: { ...disconnected }, historyTail: Promise.resolve(), offlineReader: undefined,
    controller: options.controller === false ? undefined : { current: { conversationId: 'A' }, retryRecovery() { recoveries++; } },
    history: { conversationId: 'A', generation: 1, hasMore: false, offline: false, settled: true },
    drainConfirmations() {}, close() {}, background(operation: (release: () => void) => Promise<void>) { void operation(() => {}); },
    choose: async () => opened,
    readOnlyStorage: async () => ({
      listPage: async () => ({ records: [{ conversationId: opened, name: opened }] }),
      openBodyReader: (conversationId: string) => ({ close: async () => {}, page: async () => {
        reads.push(conversationId);
        if (failing.has(conversationId)) throw Error('fixture-local-file-in-use');
        return { fragments: [], hasMore: false };
      } }),
    }),
    outputProjection: { revision: 0, drain: async () => {}, projectPage: (page: unknown) => page },
    display: { first: 0, last: 0, reset: async () => { resets.push(h.history?.conversationId); },
      // 显示存储替身：页内容是当前历史范围独有的标记
      page: async () => ({ first: -1, last: 0, start: -1, follow: true, segments: [{ blockId: `own-${h.history.conversationId}`, role: 'assistant', contentOffset: 0, final: true, text: `MARK-${h.history.conversationId}` }] }) },
    toUi: async (message: unknown) => { events.push(message); },
  });
  return { h, events, resets, failing, reads, recoveries: () => recoveries, settle: async () => { for (let i = 0; i < 4; i++) { await h.historyRead?.catch(() => {}); await tick(); } } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const last = (events: any[], type: string) => events.filter(event => event.type === type).at(-1);

describe('returning from read-only history', () => {
  for (const opened of ['A', 'B']) it(`restores the disconnected conversation's own body after reading ${opened}`, async () => {
    const f = fixture({ opened });
    await f.h.readOnly(); await f.settle();
    expect(last(f.events, 'display-page').page.segments[0].text).toBe(`MARK-${opened}`);
    await f.h.action({ kind: 'history-close' }); await f.settle();
    const view = last(f.events, 'view').view, base = last(f.events, 'display-page');
    // 返回页声明的正文代次与刚建立的基准相同（严格匹配才显示），内容是 A 自己的
    expect(view.reading).toEqual(base.reading);
    expect(base.reading.conversationId).toBe('A'); expect(base.page.segments[0].text).toBe('MARK-A');
    // 返回页的连接、输入状态与提示不变：断线仍是断线，不新增在线许可
    expect(view).toMatchObject({ kind: 'conversation', conversationId: 'A', connected: false, connectionState: 'unavailable', readyForInput: true, message: disconnected.message });
    expect(view.localBodyFailed).toBeUndefined();
    expect(f.h.history).toMatchObject({ conversationId: 'A', offline: true, settled: true });
    expect(f.resets.at(-1)).toBe('A');
  });
  it('reports a failed local restore on the return page and retries the same conversation without connecting', async () => {
    const f = fixture();
    await f.h.readOnly(); await f.settle();
    f.failing.add('A'); failures.length = 0;
    await f.h.action({ kind: 'history-close' }); await f.settle();
    let view = last(f.events, 'view').view;
    // 失败可见：返回页带“本机正文恢复失败”；断线提示、连接与输入状态不变；不显示 B（返回页声明的是未落定的 A 代次）
    expect(failures).toHaveLength(1);
    expect(view).toMatchObject({ conversationId: 'A', connected: false, connectionState: 'unavailable', readyForInput: true, message: disconnected.message, localBodyFailed: true });
    expect(view.reading.conversationId).toBe('A'); expect(last(f.events, 'display-page').reading).not.toEqual(view.reading);
    // 故障未解除时重试：仍失败，提示仍在，可再次点（动作带上提示所属的阅读身份）
    let reads = f.reads.length;
    await expect(f.h.action({ kind: 'local-body-retry', ...view.reading })).resolves.toEqual({ accepted: true }); await f.settle();
    view = last(f.events, 'view').view;
    expect(f.reads.slice(reads)).toEqual(['A']); expect(failures).toHaveLength(2); expect(view.localBodyFailed).toBe(true);
    // 解除故障后连点两次、再补一次过期的点击：只重读本机 A 一次，成功即清除失败；在线恢复入口一次也不调用
    f.failing.delete('A'); reads = f.reads.length;
    const failed = view.reading;
    await expect(f.h.action({ kind: 'local-body-retry', ...failed })).resolves.toEqual({ accepted: true });
    await expect(f.h.action({ kind: 'local-body-retry', ...failed })).resolves.toEqual({ accepted: true });
    await f.settle();
    await expect(f.h.action({ kind: 'local-body-retry', ...failed })).resolves.toEqual({ accepted: true }); await f.settle();
    view = last(f.events, 'view').view; const base = last(f.events, 'display-page');
    expect(f.reads.slice(reads)).toEqual(['A']);
    expect(view.reading).toEqual(base.reading); expect(base.reading).not.toEqual(failed); expect(base.page.segments[0].text).toBe('MARK-A');
    expect(view.localBodyFailed).toBeUndefined();
    expect(view).toMatchObject({ connected: false, connectionState: 'unavailable', message: disconnected.message });
    expect(f.recoveries()).toBe(0);
  });
  it('ignores a local retry whose reading is not the failed current one', async () => {
    const f = fixture();
    await f.h.readOnly(); await f.settle();
    f.failing.add('A');
    await f.h.action({ kind: 'history-close' }); await f.settle();
    const failed = last(f.events, 'view').view.reading, reads = f.reads.length;
    f.failing.delete('A');
    await f.h.action({ kind: 'local-body-retry', conversationId: 'B', generation: failed.generation }); await f.settle();
    await f.h.action({ kind: 'local-body-retry', conversationId: 'A', generation: failed.generation - 1 }); await f.settle();
    expect(f.reads.slice(reads)).toEqual([]); expect(last(f.events, 'view').view.localBodyFailed).toBe(true);
    expect(f.recoveries()).toBe(0);
  });
  it('lets an overtaken return neither clear the newer range nor read for it', async () => {
    const f = fixture(), drain = Promise.withResolvers<void>();
    f.h.outputProjection.drain = () => drain.promise;
    const old = f.h.restoreReturnReading();
    // 等待期间另一次换代（重连恢复、再次打开历史等）已建立新范围
    const next = f.h.openHistory('A', false); next.settled = true;
    drain.resolve(); await old; await f.settle();
    expect(f.resets).toEqual([]); expect(f.reads).toEqual([]);
    expect(f.h.history).toBe(next); expect(next).not.toHaveProperty('offline', true);
  });
  it('presents a connection page without a conversation by its own state', async () => {
    const f = fixture({ controller: false });
    f.h.history = undefined;
    await f.h.readOnly(); await f.settle();
    const bases = f.events.filter(event => event.type === 'display-page').length;
    await f.h.action({ kind: 'history-close' }); await f.settle();
    const view = last(f.events, 'view').view;
    expect(view.kind).toBe('conversation'); expect(view).not.toHaveProperty('reading');
    expect(f.events.filter(event => event.type === 'display-page')).toHaveLength(bases);
  });
});
