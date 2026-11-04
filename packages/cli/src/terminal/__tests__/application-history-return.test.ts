import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// 从只读历史（F2）返回：运行生产的 #action（history-close）、#readOnly、#restoreReturnReading、#leaveHistoryRead、
// #openHistory、#loadOfflineHistory、#historyPage、#historyPageNow、#offlineHistoryPage、#displayPage 与 #publish。
// 只替换只读目录与读取器、显示存储与传输；读取器按会话给出空页。
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const methods = ['#action', '#readOnly', '#restoreReturnReading', '#leaveHistoryRead', '#openHistory', '#loadOfflineHistory', '#historyPage', '#historyPageNow',
  '#offlineHistoryPage', '#publish', '#ownsPage', '#publishHistoryView', '#noteHistoryView', '#displayPage'].map(name => {
  const node = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  if (!node) throw Error(`Missing production method ${name}`);
  return node.getText(source).replace(/#/gu, '');
}).join('\n');
const failures: unknown[] = [];
const Harness = new Function('formatRelativeTimeText', 'terminalEnvironment', 'recordTerminalFailure', ts.transpile(`class Harness {\n${methods}\n} return Harness;`, { target: ts.ScriptTarget.ES2022 }))(
  () => '', () => undefined, (_records: unknown, error: unknown) => { failures.push(error); });

const disconnected = { kind: 'conversation', title: 'A', connected: false, connectionState: 'unavailable', readyForInput: true, message: '连接已断开，输入与已有内容保留。按 Enter 重试。' };
function fixture(options: { controller?: boolean; opened?: string } = {}) {
  const h = new Harness(), events: any[] = [], resets: string[] = [], reads: string[] = [];
  const opened = options.opened ?? 'B';
  Object.assign(h, {
    args: [], abort: new AbortController(), generation: 40, readingGeneration: 1, displayRevision: 8, startupAttempt: undefined, logging: { records: undefined },
    mainView: { ...disconnected }, historyTail: Promise.resolve(), offlineReader: undefined,
    controller: options.controller === false ? undefined : { current: { conversationId: 'A' } },
    history: { conversationId: 'A', generation: 1, hasMore: false, offline: false, settled: true },
    drainConfirmations() {}, close() {}, background(operation: (release: () => void) => Promise<void>) { void operation(() => {}); },
    choose: async () => opened,
    readOnlyStorage: async () => ({
      listPage: async () => ({ records: [{ conversationId: opened, name: opened }] }),
      openBodyReader: (conversationId: string) => ({ close: async () => {}, page: async () => {
        reads.push(conversationId);
        return { fragments: [], hasMore: false };
      } }),
    }),
    outputProjection: { revision: 0, drain: async () => {}, projectPage: (page: unknown) => page },
    display: { first: 0, last: 0, reset: async () => { resets.push(h.history?.conversationId); },
      // 显示存储替身：页内容是当前历史范围独有的标记
      page: async () => ({ first: -1, last: 0, start: -1, follow: true, segments: [{ blockId: `own-${h.history.conversationId}`, role: 'assistant', contentOffset: 0, final: true, text: `MARK-${h.history.conversationId}` }] }) },
    toUi: async (message: unknown) => { events.push(message); },
  });
  return { h, events, resets, reads, settle: async () => { for (let i = 0; i < 4; i++) { await h.historyRead?.catch(() => {}); await tick(); } } };
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
    expect(f.h.history).toMatchObject({ conversationId: 'A', offline: true, settled: true });
    expect(f.resets.at(-1)).toBe('A');
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
