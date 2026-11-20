import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { terminalSelectionActions } from '../selection.js';

// Run the production publisher/selection owner with only its transport replaced.
// In-flight history and IPC delivery are independently controlled at real awaits.
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const methods = ['#publish', '#dropHandoff', '#toUi', '#ownsPage', '#choosePage', '#publishHistoryView', '#offlineHistoryPage'].map(name => {
  const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  if (!method) throw Error(`Missing production method ${name}`);
  return method.getText(source).replace(/#/gu, '');
}).join('\n');
const Fixture = new Function('randomUUID', 'terminalSelectionActions', 'terminalEnvironment', 'AsyncLocalStorage', ts.transpile(`class Fixture {
  abort = new AbortController(); generation = 0; mainView = {kind:'conversation',title:'chat'};
  uiOpen = true; uiReady = Promise.resolve(); commandScope = new AsyncLocalStorage();
  drainConfirmations() {};
  ${methods}
} return Fixture;`, { target: ts.ScriptTarget.ES2022 }))(randomUUID, terminalSelectionActions, () => undefined, AsyncLocalStorage);
function fixture() {
  const target = new Fixture(), views: any[] = [];
  target.channel = { send: async (message: any) => { views.push(message.view); } };
  return { target, views };
}
describe('foreground terminal page ownership', () => {
  it('retains a WORK input page and its response target when history finishes in the background', async () => {
    const { target, views } = fixture();
    const response = target.choosePage({kind:'selection',title:'WORK',field:{id:'name',label:'名字',value:'',secret:false},choices:[{id:'save',label:'保存'}]});
    await target.publishing;
    const selected = views.at(-1);
    target.history = {hasMore:true};
    await target.publishHistoryView();
    expect(views.at(-1)).toBe(selected);
    expect(target.mainView.historyHasMore).toBe(true);
    const selection = target.selection; target.selection = undefined;
    selection.resolve({itemId:'save',input:'工作'});
    await expect(response).resolves.toEqual({itemId:'save',input:'工作'});
    await target.publish(target.mainView);
    expect(views.at(-1).kind).toBe('conversation');
  });
  it.each(['editor','skills','presentingConfirmation'])('keeps background main updates out of an active %s page', async kind => {
    const { target, views } = fixture(); target[kind] = true;
    await target.publishHistoryView(); expect(views).toHaveLength(0);
    target[kind] = undefined; await target.publishHistoryView();
    expect(views.at(-1).kind).toBe('conversation');
  });
  it('declares the current reading generation when a foreground page that hid the main view closes', async () => {
    const { target, views } = fixture(); target.controller = { current: { conversationId: 'c' } };
    target.history = { conversationId: 'c', generation: 1, hasMore: true, offline: false, settled: true };
    target.presentingConfirmation = true;
    // 前台确认页期间发生重建：新代次的视图发布被挡住
    target.history = { conversationId: 'c', generation: 2, hasMore: true, offline: false, settled: true };
    await target.publishHistoryView(); expect(views).toHaveLength(0);
    target.presentingConfirmation = undefined;
    await target.publish(target.mainView);
    expect(views.at(-1)).toMatchObject({ kind: 'conversation', conversationId: 'c', reading: { conversationId: 'c', generation: 2 } });
  });
  it('stamps the reading at delivery, so a restored snapshot view never declares a stale generation', async () => {
    const { target, views } = fixture(); target.controller = { current: { conversationId: 'c' } };
    target.history = { conversationId: 'c', generation: 3, hasMore: true, offline: false };
    await target.publish(target.mainView);
    const snapshot = target.mainView;
    expect(views.at(-1).reading).toEqual({ conversationId: 'c', generation: 3 });
    target.history = { conversationId: 'c', generation: 4, hasMore: true, offline: false };
    await target.publish(snapshot);
    expect(views.at(-1).reading).toEqual({ conversationId: 'c', generation: 4 });
    expect(snapshot).not.toHaveProperty('reading');
  });
  it('declares no reading for a view whose conversation is not the one being read', async () => {
    const { target, views } = fixture(); target.controller = { current: { conversationId: 'next' } };
    target.history = { conversationId: 'previous', generation: 5, hasMore: true, offline: false, settled: true };
    await target.publish(target.mainView);
    expect(views.at(-1).conversationId).toBe('next'); expect(views.at(-1)).not.toHaveProperty('reading');
  });
  it('keeps every conversation update in the starting projection until startup admits input', async () => {
    const { target, views } = fixture(); target.startupAttempt = {};
    await target.publish({ ...target.mainView, message: '正在准备最近的对话…' });
    expect(views.at(-1)).toMatchObject({ kind: 'conversation', connectionState: 'starting', message: '正在准备最近的对话…' });
    target.history = { hasMore: true }; await target.publishHistoryView();
    expect(views.at(-1).connectionState).toBe('starting');
    await target.publish({ ...target.mainView, connectionState: 'unavailable' });
    expect(views.at(-1).connectionState).toBe('unavailable');
    await target.publish({ kind: 'configuration', title: '配置' });
    expect(views.at(-1).connectionState).toBeUndefined();
    target.startupAttempt = undefined;
    await target.publish({ ...target.mainView, readyForInput: true });
    expect(views.at(-1).connectionState).toBeUndefined();
  });
  it('rechecks ownership of an already queued main update before delivering it', async () => {
    const { target, views } = fixture(), delivery = Promise.withResolvers<void>();
    target.channel.send = async (message: any) => { views.push(message.view); await delivery.promise; };
    const pending = target.publish(target.mainView);
    void target.publishHistoryView();
    target.selection = {id:'new-input-page'};
    delivery.resolve(); await pending;
    expect(views).toHaveLength(1);
  });
  it('clears active selection ownership and invalidates the UI request when choosePage signal aborts', async () => {
    const { target } = fixture();
    const sent: any[] = [];
    target.channel.send = async (message: any) => { sent.push(message); };
    const abort = new AbortController();
    const waitPromise = target.choosePage(
      { kind: 'selection', title: '刷新模型目录', busy: true, choices: [{ id: 'back-list', label: '返回模型列表' }] },
      abort.signal,
    );
    await target.publishing;
    const publishedRequestId = sent.find((m) => m.type === 'view')?.view?.requestId;
    expect(typeof publishedRequestId).toBe('string');
    expect(target.selection?.id).toBe(publishedRequestId);
    abort.abort();
    await expect(waitPromise).resolves.toEqual({ itemId: 'cancelled', cancelCause: 'aborted' });
    expect(target.selection).toBeUndefined();
    expect(sent.some((m) => m.type === 'invalidate' && m.requestId === publishedRequestId)).toBe(true);
    // Subsequent selection page can be opened cleanly without hitting terminal-selection-capacity
    const nextAbort = new AbortController();
    const nextPromise = target.choosePage(
      { kind: 'selection', title: '切换模型', choices: [{ id: 'close', label: '返回' }] },
      nextAbort.signal,
    );
    await target.publishing;
    nextAbort.abort();
    await expect(nextPromise).resolves.toEqual({ itemId: 'cancelled', cancelCause: 'aborted' });
  });
  it('updates an active selection page in place under the same requestId and drops late updates after settlement', async () => {
    const { target } = fixture();
    const sent: any[] = [];
    target.channel.send = async (message: any) => { sent.push(message); };
    let liveHandle: { isActive(): boolean; update(view: any): Promise<boolean> } | undefined;
    const responsePromise = target.choosePage(
      {
        kind: 'selection',
        title: '模型管理（/model）',
        message: '⏳ 目录刷新仍在后台进行中',
        choices: [
          { id: 'option:action:refresh-progress', label: '查看目录刷新进度' },
          { id: 'option:model:a', label: 'model-a' },
        ],
      },
      { onActive: (handle: any) => { liveHandle = handle; } },
    );
    await target.publishing;
    const firstView = sent.at(-1)?.view;
    expect(typeof firstView?.requestId).toBe('string');
    expect(liveHandle?.isActive()).toBe(true);

    // 原地更新：保持同一 requestId（U 侧 sameInteraction 保留实时焦点）、无 invalidate、同步切换 allowed 集合
    const updated = await liveHandle!.update({
      kind: 'selection',
      title: '模型管理（/model）',
      message: '✓ 目录已更新至修订 ui-review-catalog-1',
      choices: [
        { id: 'option:action:refresh-catalog', label: '刷新模型目录' },
        { id: 'option:model:a', label: 'model-a' },
        { id: 'option:model:b', label: 'model-b' },
      ],
    });
    expect(updated).toBe(true);
    const secondView = sent.at(-1)?.view;
    expect(secondView.requestId).toBe(firstView.requestId);
    expect(secondView.message).toContain('ui-review-catalog-1');
    expect(sent.some((m) => m.type === 'invalidate')).toBe(false);
    expect(target.selection.allowed.has('option:action:refresh-catalog')).toBe(true);
    expect(target.selection.allowed.has('option:model:b')).toBe(true);
    expect(target.selection.allowed.has('option:action:refresh-progress')).toBe(false);

    // 用户结束选择后，迟到的原地更新必须被丢弃且不再写出视图
    const selection = target.selection;
    target.selection = undefined;
    selection.resolve({ itemId: 'option:model:b' });
    await expect(responsePromise).resolves.toEqual({ itemId: 'option:model:b' });
    const countBeforeLate = sent.length;
    expect(liveHandle!.isActive()).toBe(false);
    await expect(
      liveHandle!.update({
        kind: 'selection',
        title: '模型管理（/model）',
        message: 'stale',
        choices: [{ id: 'option:action:close', label: '返回输入' }],
      }),
    ).resolves.toBe(false);
    expect(sent.length).toBe(countBeforeLate);
  });
});

it.each([false,true])('finishes the offline history loading notice after the real reader page settles (content=%s)', async content => {
  const {target,views}=fixture();
  const history={conversationId:'owned-history',hasMore:true,offline:true};target.history=history;
  target.mainView={kind:'history',title:'local',connected:false,message:'正在读取本机历史…'};
  target.display={first:0,last:0,append:async()=>{target.display.last++;}};
  target.displayPage=async()=>{};
  let calls=0;
  target.offlineReader={history,reader:{page:async()=>content&&calls++===0
    ?{hasMore:true,fragments:[{type:'text',role:'user',text:'owned saved input',length:17,offset:0,final:true,
      runIndex:0,message:0,block:0,cursor:{shard:'owned',from:0,run:0,message:0,block:0,offset:0}}]}
    :{hasMore:false,fragments:[]}}};
  await target.offlineHistoryPage(history);
  expect(views.at(-1).message).toBe(content?undefined:'暂无已保存的内容。');
  expect(target.mainView.busy).toBe(false);
});