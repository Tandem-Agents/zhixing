/**
 * 控制恢复从历史边界起步时客户端可见行为不变：同一脚本分别对着两种 owner 运行——
 * 旧：从日志起点全量扫描（边界前的输入跳过、状态标记为已由历史覆盖）；
 * 新：边界前只给当前集合，其后照常扫描，本进程仍有义务的运行经精确端口补齐。
 * 比较显示输出（有序）与业务副作用（等待结果、后台任务、终态通知）。旧扫描对已结束历史
 * 运行发出的终态通知没有承接方（没有本地等待、过程展示或旁观状态），这是有意省掉的部分。
 */

import { describe, expect, it, vi } from 'vitest';
import type { ConversationCommitSummary, ConversationControlCursor, ConversationControlFact, ConversationControlPage, ConversationRunFactsPage } from '@zhixing/core/contracts';
import { ConversationController } from '../conversation-controller.js';
import type { RpcConversationFacade } from '../rpc-conversation-facade.js';
import type { RpcWorksceneFacade } from '../rpc-workscene-facade.js';

const NOW = '2026-10-24T00:00:00.000Z';
const OPEN = ['queued', 'dispatched', 'running', 'cancel-requested', 'uncertain'];
const checkpoint = (lsn: number) => ({ logId: 'fake-log', lsn, frameEndOffset: lsn, prefixDigest: 'fake-proof' });
type Mode = 'old' | 'new';
interface Run { runId: string; communication: boolean; continuation: boolean; text: string; revision: number; state: string; statusLsn: number;
  commit?: { revision: number; summary: ConversationCommitSummary; reply: string; lsn: number } }
type Entry = { lsn: number } & ({ kind: 'input'; runId: string } | { kind: 'status'; runId: string; revision: number } | { kind: 'final'; runId: string });

/** 一个会话的 owner：按日志位置记录控制事实，两种模式给出各自的控制页 */
class Owner {
  lsn = 0; commitRevision = 0; through = 0;
  readonly entries: Entry[] = []; readonly runs = new Map<string, Run>();
  constructor(readonly conversationId: string, readonly mode: Mode) {}
  admit(runId: string, options: { communication?: boolean; continuation?: boolean } = {}) {
    const run: Run = { runId, communication: !!options.communication, continuation: !!options.continuation, text: 'input ' + runId, revision: 0, state: 'queued', statusLsn: 0 };
    this.runs.set(runId, run); this.lsn++;
    this.entries.push({ lsn: this.lsn, kind: 'input', runId });
    this.#state(run, 'queued', this.lsn);
  }
  state(runId: string, state: string) { this.lsn++; this.#state(this.runs.get(runId)!, state, this.lsn); }
  commit(runId: string, reply: string, summary: Partial<ConversationCommitSummary> = {}) {
    const run = this.runs.get(runId)!; this.lsn++;
    run.commit = { revision: ++this.commitRevision, summary: { runIndex: this.commitRevision - 1, handedOff: false, conflict: false, ...summary }, reply, lsn: this.lsn };
    this.#state(run, 'committed', this.lsn);
    this.entries.push({ lsn: this.lsn, kind: 'final', runId });
  }
  #state(run: Run, state: string, lsn: number) {
    run.revision++; run.state = state; run.statusLsn = lsn;
    this.entries.push({ lsn, kind: 'status', runId: run.runId, revision: run.revision });
  }
  /** 历史页冻结边界 */
  freezeHistory() { this.through = this.lsn; }
  #status(run: Run, covered: boolean): ConversationControlFact | undefined {
    if (run.state === 'committed') return;
    return { kind: 'status', ...(covered ? { historyCovered: true } : {}), communication: run.communication, ...(run.continuation ? { continuation: true } : {}),
      notice: { v: 1, ref: { execution: 'conversation', conversationId: this.conversationId, ownerEpoch: 1, runId: run.runId }, state: run.state, statusRevision: run.revision,
        actions: run.state === 'uncertain' ? ['verify-side-effects', 'abandon', 'retry-risk-ack'] : [], at: NOW,
        ...(run.state === 'uncertain' ? { openFactDigest: 'sha256:' + '1'.repeat(64) } : {}) } as never };
  }
  #final(run: Run): ConversationControlFact {
    return { kind: 'final', frame: { v: 1, conversationId: this.conversationId, runId: run.runId, commitRevision: run.commit!.revision, digest: 'sha256:' + '2'.repeat(64) } };
  }
  #fact(entry: Entry, covered: boolean): ConversationControlFact | undefined {
    const run = this.runs.get(entry.runId)!;
    if (entry.kind === 'input') return { kind: 'input', cursor: { conversationId: this.conversationId, runId: run.runId, ownerEpoch: 1, clearedThroughLsn: 0, inputKey: run.runId,
      upper: checkpoint(entry.lsn), position: entry.lsn, part: 0, offset: 0, contentOffset: 0 } };
    if (entry.kind === 'final') return this.#final(run);
    return entry.revision === run.revision ? this.#status(run, covered) : undefined;
  }
  controlPage(cursor: ConversationControlCursor | undefined, through: unknown): ConversationControlPage {
    const H = this.through, historyThroughCommitRevision = Math.max(0, ...[...this.runs.values()].flatMap(run => run.commit && run.commit.lsn <= H ? [run.commit.revision] : []));
    const after = cursor?.after.lsn ?? 0, facts: ConversationControlFact[] = [];
    const currentOrder: string[] = [];
    if (!cursor && this.mode === 'new') {
      expect(through).toEqual(checkpoint(H));
      for (const run of [...this.runs.values()].filter(run => OPEN.includes(run.state) && run.statusLsn <= H).sort((a, b) => a.statusLsn - b.statusLsn)) {
        facts.push(this.#status(run, true)!); currentOrder.push(this.#order(run, 'status'));
      }
    }
    const from = !cursor && this.mode === 'new' ? H : after;
    for (const entry of this.entries) if (entry.lsn > from) {
      if (!cursor && this.mode === 'old' && entry.kind === 'input' && entry.lsn <= H) continue;
      const fact = this.#fact(entry, entry.lsn <= H);
      if (fact) facts.push(fact);
    }
    return { facts, ...(currentOrder.length ? { currentOrder } : {}), hasMore: false, reset: false, cursor: { conversationId: this.conversationId, ownerEpoch: 1, clearedThroughLsn: 0, baseItem: 0,
      historyThroughCommitRevision: cursor?.historyThroughCommitRevision ?? historyThroughCommitRevision,
      // 旧客户端不读游标里的边界：旧模式不给出它，客户端也就不会走精确补齐
      ...(this.mode === 'new' ? { historyThroughInputLsn: cursor?.historyThroughInputLsn ?? H } : {}),
      upper: checkpoint(this.lsn), after: checkpoint(this.lsn), item: 0 } };
  }
  /** 源顺序键：日志位置加条目序号（这里用条目在日志里的序号） */
  #order(run: Run, kind: 'status' | 'final') {
    const index = this.entries.findIndex(entry => entry.runId === run.runId && (kind === 'final' ? entry.kind === 'final' : entry.kind === 'status' && entry.revision === run.revision));
    return 'l:' + String(this.entries[index]!.lsn).padStart(16, '0') + ':' + String(index).padStart(16, '0');
  }
  /** 边界之前、已不在当前集合里的终态与 final，按源顺序 */
  runFacts(runIds: readonly string[], through: number): ConversationRunFactsPage {
    const entries = runIds.flatMap(id => {
      const run = this.runs.get(id); if (!run) return [];
      const status = !OPEN.includes(run.state) && run.statusLsn <= through ? this.#status(run, true) : undefined;
      return [...(status ? [{ order: this.#order(run, 'status'), fact: status }] : []),
        ...(run.commit && run.commit.lsn <= through ? [{ order: this.#order(run, 'final'), fact: this.#final(run) }] : [])];
    }) as ConversationRunFactsPage['entries'][number][];
    return { entries: entries.sort((a, b) => a.order < b.order ? -1 : 1) };
  }
}

function harness(mode: Mode) {
  const owners = new Map<string, Owner>([['conv-1', new Owner('conv-1', mode)], ['conv-2', new Owner('conv-2', mode)]]);
  const owner = owners.get('conv-1')!;
  const visible: string[] = [], effects: string[] = [], runFactCalls: string[][] = [];
  let resets = 0, afterFreeze: (() => void) | undefined;
  let nextRun = 0;
  const handlers = new Map<string, ((value: never) => void)[]>();
  const on = (name: string) => (handler: (value: never) => void) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; };
  const conversation = {
    onDelta: on('delta'), onComplete: on('complete'), onFinal: on('final'), onStatus: on('status'), onActivity: on('activity'),
    onPostTurnControlIntent: on('intent'), onAssignmentStream: on('assignment'), onProcess: on('process'),
    subscribe: vi.fn(async () => true), unsubscribe: vi.fn(async () => {}), abort: vi.fn(async () => {}),
    send: vi.fn(async (_input: unknown, conversationId: string, turnId: string) => {
      const runId = 'local-' + ++nextRun; owners.get(conversationId)!.admit(runId);
      return { conversationId, sessionId: conversationId, turnId, runId };
    }),
    history: vi.fn(async () => ({ runs: [], hasMore: false })),
    controlTargets: vi.fn(async () => ({ targets: [] })),
    statusHistory: vi.fn(async () => ({ notices: [], next: [] })),
    controlPage: vi.fn(async (conversationId: string, cursor?: ConversationControlCursor, _runs?: readonly string[], through?: unknown) => owners.get(conversationId)!.controlPage(cursor, through)),
    runFacts: vi.fn(async (conversationId: string, runIds: readonly string[], through: number) => {
      runFactCalls.push([...runIds]); expect(through).toBe(owners.get(conversationId)!.through); return owners.get(conversationId)!.runFacts(runIds, through);
    }),
    completion: vi.fn(async (conversationId: string, runId: string) => {
      const commit = owners.get(conversationId)!.runs.get(runId)?.commit;
      return { conversationId, runId, ownerEpoch: 1, ...(commit ? { commitRevision: commit.revision, summary: commit.summary } : {}) };
    }),
    consumeInputPage: vi.fn(async (conversationId: string, runId: string, cursor: unknown, consume: (page: unknown) => Promise<unknown>) => {
      const run = owners.get(conversationId)!.runs.get(runId)!;
      return consume({ input: { identity: { id: runId, source: run.communication ? { kind: 'conversation', conversationId: 'sender' } : { kind: 'user' } }, text: run.text, contentOffset: 0, final: true },
        cursor, hasMore: false, reset: false });
    }),
    bodyPage: vi.fn(async (conversationId: string, cursor: unknown, options: { runId: string }) => {
      const reply = owners.get(conversationId)!.runs.get(options.runId)!.commit!.reply;
      const position = { conversationId, ownerEpoch: 1, revision: 1, message: 1, block: 0, offset: 0 };
      return { fragments: [{ cursor: position, runId: options.runId, runIndex: 0, message: 1, block: 0, role: 'assistant', type: 'text', text: reply, offset: 0, length: reply.length, final: true }],
        hasMore: false, reset: false, cursor: cursor ?? position };
    }),
  };
  const workscene = { tasks: vi.fn(async () => [...owner.runs.values()].map(run => ({ conversationId: 'conv-1', runId: run.runId, goal: 'g' }))),
    stopTask: vi.fn(async (_id: string, target: { runId: string }) => { effects.push('stop-task:' + target.runId); }) };
  const states: string[] = [];
  const controller = new ConversationController({
    conversation: conversation as unknown as RpcConversationFacade, workscene: workscene as unknown as RpcWorksceneFacade, pagedRecovery: true,
    onYield: () => {}, projectCommittedOutcome: summary => summary,
    onRecoveryYield: async (event, source) => { visible.push(`yield:${source.runId}:${source.kind}:${'text' in event ? event.text : event.type}`); },
    onObservedInputFragment: async input => { visible.push(`input:${input.runId}:${input.text}`); },
    onNotice: message => { visible.push('notice:' + message); },
    onObservedTurnComplete: turn => { effects.push('observed-complete:' + turn.runId); },
    onRecoveryDrain: async turn => { effects.push('drain:' + turn.runId); },
    onRunTerminal: turn => { effects.push('terminal:' + turn.runId); },
    onRecoveryReset: async conversationId => { resets++; owners.get(conversationId)!.freezeHistory(); const next = afterFreeze; afterFreeze = undefined; next?.(); },
    onRecoveryState: state => { states.push(state); },
    historyThrough: () => checkpoint(owners.get(controller.current.conversationId)!.through),
  }, { conversationId: 'conv-1', name: 'test', mode: { kind: 'main' } });
  /** 等到两条恢复链都追平当前日志 */
  const settle = async () => {
    for (let round = 0; round < 3; round++) {
      await vi.waitFor(() => expect(states.at(-1)).toBe('idle'));
      for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  const wake = (conversationId = 'conv-1') => { for (const handler of handlers.get('status') ?? []) handler({ v: 1, ref: { execution: 'conversation', conversationId, ownerEpoch: 1, runId: 'wake' }, state: 'cancelled', statusRevision: 0, actions: [], at: NOW } as never); };
  return { controller, owner, owners, visible, effects, runFactCalls, conversation, settle, wake, resets: () => resets,
    /** 下一次历史快照冻结之后、首个控制页之前落下的事实 */
    afterNextFreeze: (append: () => void) => { afterFreeze = append; } };
}
type Harness = ReturnType<typeof harness>;

/** 同一脚本对两种 owner 运行；返回可比较的结果 */
async function compare(script: (h: Harness) => Promise<unknown[]>) {
  const results = [];
  for (const mode of ['old', 'new'] as const) {
    const h = harness(mode);
    try {
      const outcomes = await script(h);
      results.push({ mode, visible: h.visible, effects: h.effects, outcomes, runFactCalls: h.runFactCalls });
    } finally { h.controller.dispose(); }
  }
  const [old, next] = results as [typeof results[0], typeof results[0]];
  expect(next.visible).toEqual(old.visible);
  expect(next.outcomes).toEqual(old.outcomes);
  // 终态通知：新路径对没有承接方的已结束历史运行不再发出，其余副作用完全相同。本地回合的 drain 不比较：
  // 等待落定时接入面自己结束该回合的输出投影，恢复链的 drain 是第二次结束，出现与否取决于哪条链先到 final（新旧相同）
  const historyOnly = (effects: string[]) => effects.filter(effect => !effect.startsWith('terminal:') && !effect.startsWith('drain:local-')).sort();
  expect(historyOnly(next.effects)).toEqual(historyOnly(old.effects));
  const terminals = (effects: string[]) => new Set(effects.filter(effect => effect.startsWith('terminal:')));
  for (const terminal of terminals(next.effects)) expect(terminals(old.effects).has(terminal)).toBe(true);
  return { old, next };
}

describe('control recovery from the history boundary keeps client-visible behaviour', () => {
  it('first open: unfinished runs before the boundary, then the live tail', async () => {
    const { old, next } = await compare(async h => {
      const o = h.owner;
      o.admit('done-1'); o.state('done-1', 'running'); o.commit('done-1', 'reply 1');
      o.admit('mail-old', { communication: true }); o.state('mail-old', 'cancelled');
      o.admit('task-old', { continuation: true }); o.state('task-old', 'failed');
      o.admit('unsure'); o.state('unsure', 'running'); o.state('unsure', 'uncertain');
      o.admit('waiting', { communication: true });
      o.freezeHistory();
      await h.controller.start(); await h.settle();
      o.admit('mail-new', { communication: true }); o.state('mail-new', 'cancelled');
      o.admit('task-new', { continuation: true }); o.state('task-new', 'running'); o.commit('task-new', 'continued reply');
      h.wake(); await h.settle();
      return [];
    });
    expect(old.visible.some(line => line.includes('来信处理已停止') && line.includes('mail-new'))).toBe(true);
    expect(old.visible.some(line => line.includes('unsure'))).toBe(true);
    expect(old.effects.filter(effect => effect.startsWith('terminal:')).length).toBeGreaterThan(next.effects.filter(effect => effect.startsWith('terminal:')).length);
    expect(next.runFactCalls).toEqual([]);
  }, 30_000);

  it.each(['switch-back', 'reconnect'] as const)('%s: a local waiter whose final was lost before the new boundary still completes', async how => {
    const { next } = await compare(async h => {
      h.owner.admit('older'); h.owner.commit('older', 'older reply'); h.owner.freezeHistory();
      await h.controller.start(); await h.settle();
      const turn = await h.controller.beginTurn('hello');
      await h.settle();
      if (how === 'switch-back') {
        h.controller.setActive({ conversationId: 'conv-2', name: 'other', mode: { kind: 'main' } }); h.wake('conv-2'); await h.settle();
        h.owner.state('local-1', 'running'); h.owner.commit('local-1', 'hello reply');
        h.controller.setActive({ conversationId: 'conv-1', name: 'test', mode: { kind: 'main' } });
      } else {
        h.owner.state('local-1', 'running'); h.owner.commit('local-1', 'hello reply');
        await h.controller.reattachActiveObserver({ reloadHistory: true });
      }
      h.wake(); const outcome = await turn.outcome; await h.settle();
      return [outcome];
    });
    expect(next.outcomes).toEqual([{ runIndex: 1, handedOff: false, conflict: false }]);
    expect(next.runFactCalls.flat()).toContain('local-1');
    expect(next.runFactCalls.flat().every(runId => runId.startsWith('local-'))).toBe(true);
  }, 30_000);

  it('a handed-off task and its post-turn navigation reach the waiter and the stop control', async () => {
    const { next } = await compare(async h => {
      h.owner.freezeHistory(); await h.controller.start(); await h.settle();
      const turn = await h.controller.beginTurn('delegate');
      h.owner.state('local-1', 'running'); h.owner.commit('local-1', 'handed off', { handedOff: true, navigation: { kind: 'exit' } });
      await h.controller.reattachActiveObserver({ reloadHistory: true }); h.wake();
      const outcome = await turn.outcome; await h.settle();
      const stopped = await h.controller.abortBackgroundTask();
      return [outcome, stopped];
    });
    expect(next.outcomes).toEqual([{ runIndex: 0, handedOff: true, conflict: false, navigation: { kind: 'exit' } }, true]);
    expect(next.effects).toContain('stop-task:local-1');
  }, 30_000);

  it.each(['covered', 'after-boundary'] as const)('a terminal local run with incomplete text (%s) keeps one display', async where => {
    await compare(async h => {
      h.owner.freezeHistory(); await h.controller.start(); await h.settle();
      const turn = await h.controller.beginTurn('long answer');
      h.owner.state('local-1', 'running');
      if (where === 'covered') {
        h.owner.commit('local-1', 'long answer reply');
        await h.controller.reattachActiveObserver({ reloadHistory: true }); h.wake();
      } else {
        await h.controller.reattachActiveObserver({ reloadHistory: true }); h.wake(); await h.settle();
        h.owner.commit('local-1', 'long answer reply'); h.wake();
      }
      const outcome = await turn.outcome; await h.settle();
      return [outcome];
    });
  }, 30_000);
});

describe('exact facts keep the source order of the facts they stand for', () => {
  /** 注入尚未结算的旁观运行（来信），与真实恢复链建立的状态相同 */
  const observe = (h: Harness, runIds: readonly string[]) => {
    const observed = (h.controller as unknown as { observedContinuations: Map<string, unknown> }).observedContinuations;
    for (const runId of runIds) observed.set(runId, { conversationId: 'conv-1', settled: false, communication: true, sequences: new Map(), terminalInputsReconciled: true });
  };

  it('two outstanding observed runs whose terminals landed in the other order', async () => {
    await compare(async h => {
      h.owner.admit('mail-a', { communication: true }); h.owner.admit('mail-b', { communication: true });
      observe(h, ['mail-a', 'mail-b']);
      h.owner.state('mail-b', 'cancelled'); h.owner.state('mail-a', 'failed'); h.owner.freezeHistory();
      await h.controller.start(); await h.settle();
      return [];
    });
  }, 30_000);

  it('more than one batch of outstanding runs, interleaved with an unfinished run and followed by the tail', async () => {
    const { next } = await compare(async h => {
      const ids = Array.from({ length: 40 }, (_, n) => 'mail-' + String(n).padStart(2, '0'));
      for (const runId of ids) h.owner.admit(runId, { communication: true });
      observe(h, ids);
      // 终态按打乱的顺序落下，中间夹一个 uncertain（在当前集合里）
      const order = ids.map((runId, n) => [runId, (n * 17) % 40] as const).sort((a, b) => a[1] - b[1]).map(([runId]) => runId);
      for (const [index, runId] of order.entries()) {
        h.owner.state(runId, index % 3 ? 'cancelled' : 'failed');
        if (index === 20) { h.owner.admit('unsure'); h.owner.state('unsure', 'running'); h.owner.state('unsure', 'uncertain'); }
      }
      h.owner.freezeHistory();
      await h.controller.start(); await h.settle();
      h.owner.admit('mail-late', { communication: true }); h.owner.state('mail-late', 'cancelled'); h.wake(); await h.settle();
      return [];
    });
    // 两条恢复链各自把 40 个运行分两批精确读取
    expect(next.runFactCalls.map(call => call.length).sort((x, y) => x - y)).toEqual([8, 8, 32, 32]);
  }, 30_000);
});

describe('facts between the history snapshot and the first control page', () => {
  it('keep their log order instead of being consumed ahead of the page', async () => {
    const { old } = await compare(async h => {
      h.owner.freezeHistory(); await h.controller.start(); await h.settle();
      const turn = await h.controller.beginTurn('question');
      h.owner.admit('mail', { communication: true }); h.owner.state('local-1', 'running');
      h.afterNextFreeze(() => { h.owner.state('mail', 'cancelled'); h.owner.commit('local-1', 'answer'); });
      await h.controller.reattachActiveObserver({ reloadHistory: true }); h.wake();
      const outcome = await turn.outcome; await h.settle();
      return [outcome];
    });
    const order = old.visible.filter(line => line.startsWith('yield:'));
    expect(order.findIndex(line => line.startsWith('yield:mail'))).toBeLessThan(order.findIndex(line => line.startsWith('yield:local-1')));
  }, 30_000);
});

describe('exact reconciliation is required', () => {
  it('leaves the waiter pending when the exact port answers nothing (counter-proof)', async () => {
    const h = harness('new');
    h.conversation.runFacts.mockImplementation(async () => ({ facts: [] }));
    try {
      h.owner.freezeHistory(); await h.controller.start(); await h.settle();
      const turn = await h.controller.beginTurn('hello');
      h.owner.state('local-1', 'running'); h.owner.commit('local-1', 'hello reply');
      await h.controller.reattachActiveObserver({ reloadHistory: true }); h.wake(); await h.settle();
      const result = await Promise.race([turn.outcome.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 200))]);
      expect(result).toBe('pending');
      expect(h.conversation.runFacts.mock.calls.flatMap(call => call[1])).toContain('local-1');
    } finally { h.controller.dispose(); }
  }, 30_000);
});

describe('local turn display ownership', () => {
  it('is reclaimed once recovery has consumed the run terminal, and never evicted while unfinished', async () => {
    const h = harness('new');
    try {
      h.owner.freezeHistory(); await h.controller.start(); await h.settle();
      const local = (h.controller as unknown as { localRunTurns: Map<string, unknown> }).localRunTurns;
      const turn = await h.controller.beginTurn('first');
      h.owner.state('local-1', 'running'); h.owner.commit('local-1', 'first reply'); h.wake();
      await turn.outcome; await h.settle();
      // 完成链结束等待后归属转给本地回合，恢复链消费完 final 即回收
      expect(local.has('local-1')).toBe(false);
      expect(h.visible.filter(line => line.startsWith('yield:local-1'))).toEqual(['yield:local-1:history:first reply']);
      // 恢复链落后时：未完成的归属不被数量挤掉；超过上限触发一次从历史重建，重建后显示改由历史与恢复事实承担
      for (let n = 0; n < 512; n++) local.set('pending-' + n, { turnId: 't-' + n, text: { reset() {} } });
      const deleted = vi.spyOn(local, 'delete'), before = h.resets();
      const second = await h.controller.beginTurn('second');
      h.owner.state('local-2', 'running'); h.owner.commit('local-2', 'second reply'); h.wake();
      await second.outcome; await h.settle();
      expect(deleted.mock.calls.map(call => call[0]).filter(key => String(key).startsWith('pending-'))).toEqual([]);
      expect(h.resets()).toBeGreaterThan(before);
      expect(local.size).toBe(0);
    } finally { h.controller.dispose(); }
  }, 30_000);
});
