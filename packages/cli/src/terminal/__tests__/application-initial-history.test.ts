import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { runOutcomeSegment, runOutcomeText } from '../display-replay.js';

// Exercise the production history owner. Only its RPC and confirmed display
// ports are replaced; parsing, page progression and publication order are real.
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const methods = ['#onlineHistoryPage', '#readOnlineHistoryPage', '#historyPage', '#historyPageNow', '#displayEarlier', '#noteHistoryView'].map(name => {
  const node = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  if (!node) throw Error(`Missing production online history method ${name}`);
  return node.getText(source);
}).join('\n');
// 历史结果行用到的模块级记忆函数原样抽出
const moduleText = (match: (node: ts.Statement) => boolean) => source.statements.find(match)!.getText(source);
const remember = moduleText(node => ts.isVariableStatement(node) && node.getText(source).includes('HISTORY_OUTCOME_RUNS =')) + '\n' +
  moduleText(node => ts.isFunctionDeclaration(node) && node.name?.text === 'rememberOutcomeRun') + '\n' +
  moduleText(node => ts.isFunctionDeclaration(node) && node.name?.text === 'withOutcomeShown');
const Fixture = new Function('observeStartupPhase', 'runOutcomeText', 'runOutcomeSegment', ts.transpile(`${remember}
class Fixture {
  abort = new AbortController(); mainView = { readyForInput: false }; logging = { records: undefined };
  historyParser = { close() {} }; bodyWork = { run: work => work() };
  displayed = 0; published = 0; historyTail = Promise.resolve(); historyRead = undefined; earlierWork = 0; earlierPreparing = -1;
  async offlineHistoryPage() { throw Error('offline path not exercised'); }
  async displayPage() { this.displayed++; }
  async publishHistoryView() { this.published++; }
  ${methods.replace(/#/gu, '')}
} return Fixture;`, { target: ts.ScriptTarget.ES2022 }))((_records: unknown, _phase: string, work: () => Promise<unknown>) => work(), runOutcomeText, runOutcomeSegment);

function fixture() {
  const target = new Fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const history: Record<string, unknown> = { conversationId: 'current', generation: 1, hasMore: true, offline: false };
  const fragments = Array.from({ length: 4 }, (_, index) => ({ runId: `run-${index}`, message: index, block: 0,
    role: 'user', type: 'text', text: `message-${index}`, length: 9, offset: 0, final: true,
    cursor: { conversationId: 'current', ownerEpoch: 1, revision: 1, message: index, block: 0, offset: 0 } }));
  target.history = history;
  target.conversation = { bodyPage: vi.fn(async () => ({ fragments, hasMore: false })),
    runOutcomes: vi.fn(async (_id: string, runIds: string[]) => ({ entries: runIds.map(runId => ({ runId, state: 'committed' })) })) };
  const stored: string[] = [];
  const order: string[] = [];
  target.conversation.bodyPage.mockImplementation(async () => { order.push('rpc'); return { fragments, hasMore: false }; });
  target.display = { first: 0, last: 0,
    reserveInitialHistory: vi.fn(() => { order.push('reserve'); }),
    releaseInitialHistory: vi.fn(async () => { order.push('release'); }),
    append: vi.fn(async (segment: { text: string }) => { stored.push(segment.text); }),
    appendInitialHistory: vi.fn(async (items: { segment: { text: string } }[], current: () => boolean, committed: (index: number) => void) => {
      entered.resolve(); await release.promise;
      if (!current()) return false;
      for (const [index, item] of items.entries()) { stored.push(item.segment.text); committed(index); }
      return true;
    }) };
  return { target, history, fragments, stored, entered, release, order };
}

describe('initial history cursor follows confirmed display', () => {
  it('keeps the cursor and page unpublished until the batch is confirmed', async () => {
    const h = fixture(), work = h.target.onlineHistoryPage(h.history);
    await h.entered.promise;
    expect(h.history).toEqual({ conversationId: 'current', generation: 1, hasMore: true, offline: false });
    expect(h.target.displayed).toBe(0); expect(h.target.published).toBe(0);
    expect(h.target.mainView.readyForInput).toBe(false);
    h.release.resolve(); await work;
    expect(h.history).toMatchObject({ hasMore: false, bodyCursor: { message: 3, offset: 0 } });
    expect(h.stored).toEqual(h.fragments.map(fragment => fragment.text));
    expect(h.target.conversation.bodyPage).toHaveBeenCalledTimes(1);
    expect(h.target.display.append).not.toHaveBeenCalled(); expect(h.target.displayed).toBe(1);
    // 首屏预留在首页 RPC 之前发起，读取结束时交还未用的部分
    expect(h.order).toEqual(['reserve', 'rpc', 'release']);
  });

  it('leaves the original page available after an unconfirmed batch failure', async () => {
    const h = fixture(); h.target.display.appendInitialHistory.mockRejectedValueOnce(Error('unknown IO'));
    await expect(h.target.onlineHistoryPage(h.history)).rejects.toThrow('unknown IO');
    expect(h.history).toEqual({ conversationId: 'current', generation: 1, hasMore: true, offline: false });
    expect(h.target.displayed).toBe(0); expect(h.target.published).toBe(0);
    expect(h.order).toEqual(['reserve', 'rpc', 'release']);
  });

  it('returns the early reservation when the first page request fails', async () => {
    const h = fixture(); h.target.conversation.bodyPage.mockRejectedValueOnce(Error('rpc failed'));
    await expect(h.target.onlineHistoryPage(h.history)).rejects.toThrow('rpc failed');
    expect(h.target.display.reserveInitialHistory).toHaveBeenCalledTimes(1);
    expect(h.target.display.releaseInitialHistory).toHaveBeenCalledTimes(1);
    expect(h.target.display.appendInitialHistory).not.toHaveBeenCalled();
  });

  it('takes no early reservation for a page after this reading has settled', async () => {
    const h = fixture(); h.history.settled = true;
    await h.target.onlineHistoryPage(h.history);
    expect(h.target.display.reserveInitialHistory).not.toHaveBeenCalled();
    expect(h.target.display.releaseInitialHistory).not.toHaveBeenCalled();
  });

  it('never installs an old page or its cursor after the conversation epoch changes', async () => {
    const h = fixture(), work = h.target.onlineHistoryPage(h.history);
    await h.entered.promise;
    const next = { conversationId: 'next', generation: 2, hasMore: true, offline: false }; h.target.history = next;
    h.release.resolve(); await work;
    expect(h.history).toEqual({ conversationId: 'current', generation: 1, hasMore: true, offline: false });
    expect(h.target.history).toBe(next); expect(h.target.displayed).toBe(0); expect(h.stored).toEqual([]);
    expect(h.history.settled).toBeUndefined(); expect(next).not.toHaveProperty('settled');
  });

  it('does not declare a reset display to contain a page that was not published', async () => {
    const h = fixture(); h.target.display.appendInitialHistory.mockResolvedValueOnce(false);
    await expect(h.target.onlineHistoryPage(h.history)).rejects.toThrow('generation-changed');
    expect(h.history).toEqual({ conversationId: 'current', generation: 1, hasMore: true, offline: false });
    expect(h.target.displayed).toBe(0);
  });

  it('resumes exactly after a confirmed fallback prefix without skipping or duplicating a fragment', async () => {
    const h = fixture();
    h.target.display.appendInitialHistory.mockImplementationOnce(async (items: { segment: { text: string } }[], _current: () => boolean, committed: (index: number) => void) => {
      h.stored.push(items[0]!.segment.text); h.target.display.first = -1; committed(0); throw Error('fallback partial');
    });
    await expect(h.target.onlineHistoryPage(h.history)).rejects.toThrow('fallback partial');
    expect(h.history).toMatchObject({ hasMore: true, bodyCursor: { message: 0 }, buffered: { fragments: h.fragments.slice(1) } });
    await h.target.onlineHistoryPage(h.history);
    expect(h.stored).toEqual(h.fragments.map(fragment => fragment.text));
    expect(h.target.display.append).toHaveBeenCalledTimes(3); expect(h.target.conversation.bodyPage).toHaveBeenCalledTimes(1);
    expect(h.history).toMatchObject({ hasMore: false });
  });

  it('publishes an empty history without allocating or advancing a display batch', async () => {
    const h = fixture(); h.target.conversation.bodyPage.mockResolvedValueOnce({ fragments: [], hasMore: false });
    await h.target.onlineHistoryPage(h.history);
    expect(h.history).toMatchObject({ hasMore: false }); expect(h.target.display.appendInitialHistory).not.toHaveBeenCalled();
    expect(h.target.displayed).toBe(1);
  });
});

describe('history marks each run with its outcome once', () => {
  // 逆序读：一个运行的第一个片段即它在正文里的末尾，结果行前插后落在它之后
  const items = (h: ReturnType<typeof fixture>) => h.target.display.appendInitialHistory.mock.calls.flatMap((call: unknown[]) => call[0] as { segment: { text: string }; replay: { kind: string } }[]);
  it('adds one line per run that failed, stopped, is still running, awaits /resolve or has no record; none for completed or unknown', async () => {
    const h = fixture(), release = h.release; release.resolve();
    const states: Record<string, { state: string; reason?: string }> = { 'run-0': { state: 'failed', reason: 'Connection error.' }, 'run-1': { state: 'committed' },
      'run-2': { state: 'uncertain' }, 'run-3': { state: 'unknown' } };
    h.target.conversation.runOutcomes.mockImplementation(async (_id: string, runIds: string[]) => ({ entries: runIds.map(runId => ({ runId, ...states[runId] })) }));
    await h.target.onlineHistoryPage(h.history);
    expect(h.target.conversation.runOutcomes).toHaveBeenCalledOnce();
    expect(h.target.conversation.runOutcomes).toHaveBeenCalledWith('current', ['run-0', 'run-1', 'run-2', 'run-3']);
    // 每批至多 4 项：失败行、run-0、run-1、待确认行
    expect(h.stored).toEqual([runOutcomeText('failed', 'Connection error.'), 'message-0', 'message-1', runOutcomeText('uncertain')]);
    expect(items(h).map(item => item.replay.kind)).toEqual(['outcome', 'owner', 'owner', 'outcome']);
    expect(h.stored[0]).toMatch(/^⚠ 这次运行未完成：/u);
    await h.target.onlineHistoryPage(h.history);
    // 接着读：run-2 的片段不再重复结果行；run-3 无法判断不出行；不再为已读过的运行查询状态
    expect(h.stored.slice(4)).toEqual(['message-2', 'message-3']);
    expect(h.target.conversation.runOutcomes).toHaveBeenCalledOnce();
  });
  it('keeps the history readable when the outcome read fails, and fills the line in on the next reload', async () => {
    const h = fixture(); h.release.resolve();
    h.target.conversation.runOutcomes.mockRejectedValue(Error('temporarily unavailable'));
    await h.target.onlineHistoryPage(h.history);
    expect(h.stored).toEqual(h.fragments.map(fragment => fragment.text));
    // 同一次阅读不重试、不当作已标出
    expect(h.target.conversation.runOutcomes).toHaveBeenCalledOnce();
    expect(h.history.outcomeShown).toBeUndefined();
    // 重连或重新载入历史是新的历史状态：再读一次并补出
    h.target.conversation.runOutcomes.mockImplementation(async (_id: string, runIds: string[]) => ({ entries: runIds.map(runId => ({ runId, state: runId === 'run-0' ? 'failed' : 'committed', reason: 'Connection error.' })) }));
    const reloaded = { conversationId: 'current', generation: 2, hasMore: true, offline: false };
    h.target.history = reloaded; h.target.display.first = 0; h.target.display.last = 0; h.stored.length = 0;
    await h.target.onlineHistoryPage(reloaded);
    expect(h.stored[0]).toBe(runOutcomeText('failed', 'Connection error.'));
  });
  it('does not lose a line whose item was not confirmed before a batch failure', async () => {
    const h = fixture();
    h.target.conversation.runOutcomes.mockImplementation(async (_id: string, runIds: string[]) => ({ entries: runIds.map(runId => ({ runId, state: runId === 'run-1' ? 'cancelled' : 'committed' })) }));
    h.target.display.appendInitialHistory.mockImplementationOnce(async (batch: { segment: { text: string } }[], _current: () => boolean, committed: (index: number) => void) => {
      h.stored.push(batch[0]!.segment.text); h.target.display.first = -1; committed(0); throw Error('fallback partial');
    });
    await expect(h.target.onlineHistoryPage(h.history)).rejects.toThrow('fallback partial');
    await h.target.onlineHistoryPage(h.history);
    expect(h.stored.filter(text => text === runOutcomeText('cancelled'))).toHaveLength(1);
    expect(h.stored).toEqual(['message-0', runOutcomeText('cancelled'), 'message-1', 'message-2', 'message-3']);
  });
});

describe('earlier page for the reading window (display-earlier)', () => {
  // 存储替身：前插让 first 前移；before() 回紧邻 before 的至多 4 段
  const store = (target: InstanceType<typeof Fixture>, first: number) => {
    const texts = new Map<number, string>();
    for (let ordinal = first; ordinal < 0; ordinal++) texts.set(ordinal, `stored-${ordinal}`);
    target.display = { first, last: 0,
      append: vi.fn(async (segment: { text: string }, prepend: boolean) => { if (prepend) texts.set(--target.display.first, segment.text); }),
      before: vi.fn(async (before: number) => {
        const end = Math.max(target.display.first, before), from = Math.max(target.display.first, end - 4);
        return { first: target.display.first, last: 0, start: from, follow: false,
          segments: Array.from({ length: end - from }, (_, index) => ({ blockId: `b${from + index}`, role: 'user', contentOffset: 0, final: true, text: texts.get(from + index) })) };
      }) };
  };
  it('answers from the stored range without a source read or any display publication', async () => {
    const h = fixture(); store(h.target, -8); h.history.settled = true; h.target.mainView = { message: '已恢复最近对话。' };
    const reply = await h.target.displayEarlier(-4, 1);
    expect(reply.page.segments.map((segment: { text: string }) => segment.text)).toEqual(['stored--8', 'stored--7', 'stored--6', 'stored--5']);
    expect(reply.hasEarlier).toBe(true);
    expect(h.target.conversation.bodyPage).not.toHaveBeenCalled();
    expect(h.target.displayed).toBe(0); expect(h.target.published).toBe(0);
  });
  it('does not start a source read before the first page of this reading settles, whatever the view readiness', async () => {
    const h = fixture(); store(h.target, -4); h.target.mainView = { readyForInput: true };
    const reply = await h.target.displayEarlier(-4, 1);
    expect(reply).toEqual({ accepted: true, hasEarlier: true, stale: true });
    expect(h.target.conversation.bodyPage).not.toHaveBeenCalled();
  });
  it('reads the source once the reading has settled even if the rebuilt view dropped readiness', async () => {
    const h = fixture(); store(h.target, -4); h.history.settled = true; h.target.mainView = { kind: 'conversation' };
    h.target.conversation.bodyPage.mockImplementation(async () => ({ fragments: h.fragments.slice(0, 2), hasMore: true }));
    const reply = await h.target.displayEarlier(-4, 1);
    expect(h.target.conversation.bodyPage).toHaveBeenCalledTimes(1); expect(reply.page.segments).toHaveLength(2);
  });
  it('answers a request of an older generation without reading or advancing the new cursor', async () => {
    const h = fixture(); store(h.target, -4); h.history.settled = true;
    const reply = await h.target.displayEarlier(-4, 0);
    expect(reply).toEqual({ accepted: true, hasEarlier: true, stale: true });
    expect(h.target.conversation.bodyPage).not.toHaveBeenCalled(); expect(h.target.display.before).not.toHaveBeenCalled();
    expect(h.history.bodyCursor).toBeUndefined();
  });
  it('turns a generation change during the source step into a stale reply instead of a failure', async () => {
    const h = fixture(); store(h.target, -4); h.history.settled = true;
    h.target.conversation.bodyPage.mockImplementation(async () => { h.target.history = { conversationId: 'next', generation: 2, hasMore: true, offline: false }; return { fragments: h.fragments.slice(0, 1), hasMore: true }; });
    await expect(h.target.displayEarlier(-4, 1)).resolves.toEqual({ accepted: true, hasEarlier: true, stale: true });
  });
  it('never reads or advances the next conversation when the switch lands between the stored reads', async () => {
    const h = fixture(); store(h.target, -4); h.history.settled = true;
    const next: Record<string, unknown> = { conversationId: 'next', generation: 2, hasMore: true, offline: false, settled: true };
    // 请求发出后立即排入切换：它落在两次读已存范围之间；之后不得替旧请求去读新会话的源
    const reply = h.target.displayEarlier(-4, 1);
    queueMicrotask(() => { h.target.history = next; });
    await expect(reply).resolves.toEqual({ accepted: true, hasEarlier: true, stale: true });
    expect(h.target.conversation.bodyPage).not.toHaveBeenCalled();
    expect(next).toEqual({ conversationId: 'next', generation: 2, hasMore: true, offline: false, settled: true });
    expect(h.history.bodyCursor).toBeUndefined();
  });
  it('drops a queued source step bound to a replaced reading when its turn comes', async () => {
    const h = fixture(); store(h.target, -4); h.history.settled = true;
    const gate = Promise.withResolvers<void>();
    h.target.historyTail = gate.promise;                      // 前面还有一步读取在排队
    const reply = h.target.displayEarlier(-4, 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    const next: Record<string, unknown> = { conversationId: 'next', generation: 2, hasMore: true, offline: false, settled: true };
    h.target.history = next; gate.resolve();
    await expect(reply).resolves.toEqual({ accepted: true, hasEarlier: true, stale: true });
    expect(h.target.conversation.bodyPage).not.toHaveBeenCalled(); expect(next).not.toHaveProperty('bodyCursor');
  });
  it('reads one bounded quiet source step, then answers the page right before the old first', async () => {
    const h = fixture(); store(h.target, -4); h.history.settled = true; h.target.mainView = { message: '已恢复最近对话。' };
    // 源页只有 2 个片段且源端还有更多：没有“一步一页”的上限时会接着再取下一页
    h.target.conversation.bodyPage.mockImplementation(async () => ({ fragments: h.fragments.slice(0, 2), hasMore: true }));
    const reply = await h.target.displayEarlier(-4, 1);
    expect(h.target.conversation.bodyPage).toHaveBeenCalledTimes(1);
    expect(reply.page.segments).toHaveLength(2); expect(reply.page.start + reply.page.segments.length).toBe(-4);
    // 安静：不写进度、不改状态行、不发布显示页，也不发整页 view（界面收到 view 会重置候选里的两步操作）；
    // “还有更早”只记在 N 的页面投影里，阅读窗从回复里取得
    expect(h.target.mainView.message).toBe('已恢复最近对话。');
    expect(h.target.displayed).toBe(0); expect(h.target.published).toBe(0);
    expect(h.target.mainView.historyHasMore).toBe(true); expect(reply.hasEarlier).toBe(true);
  });
  it('binds a queued read to the conversation it was queued for', async () => {
    const h = fixture(); store(h.target, -4); h.history.settled = true;
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    let calls = 0;
    h.target.conversation.bodyPage.mockImplementation(async () => { calls++; entered.resolve(); await gate.promise; return { fragments: h.fragments.slice(0, 1), hasMore: true }; });
    const first = h.target.historyPage({ quiet: true });      // 对话 A 的一步，源读挂起
    const queued = h.target.historyPage({ quiet: true });     // A 的第二步，排在后面
    await entered.promise;
    const other = { conversationId: 'other', generation: 2, hasMore: true, offline: false };
    h.target.history = other;                                  // 切到对话 B
    gate.resolve(); await first; await queued;
    expect(calls).toBe(1);                                     // 排队的 A 步轮到时发现已换对话，不读
    expect(other).toEqual({ conversationId: 'other', generation: 2, hasMore: true, offline: false });
  });
  it('reports no progress when the source stays at the same cursor', async () => {
    const h = fixture(); store(h.target, -4); h.history.settled = true;
    h.target.conversation.bodyPage.mockImplementation(async () => ({ fragments: [], hasMore: true, cursor: undefined }));
    h.history.bodyCursor = undefined;
    const reply = await h.target.displayEarlier(-4, 1);
    expect(reply.page).toBeUndefined(); expect(reply.progressed).toBe(false);
  });
  it('counts a preparing source page as one step without progress text', async () => {
    const h = fixture(); store(h.target, -4); h.history.settled = true; h.target.mainView = { message: '已恢复最近对话。' };
    h.target.conversation.bodyPage.mockImplementation(async () => ({ fragments: [], hasMore: true, preparing: { bytes: 1024, total: 8192 }, cursor: h.fragments[0]!.cursor }));
    const reply = await h.target.displayEarlier(-4, 1);
    expect(h.target.conversation.bodyPage).toHaveBeenCalledTimes(1);
    expect(reply.page).toBeUndefined(); expect(reply.hasEarlier).toBe(true);
    expect(h.target.mainView.message).toBe('已恢复最近对话。'); expect(h.target.published).toBe(0);
  });
});
