/**
 * 控制页从历史边界起步：边界之前（含导入基底）只补发仍未结束的运行，之后照常扫描。
 *
 * 对照方法：同一份日志用早期的全量扫描在边界处切成两段（边界前 A1、边界后 A2），新结果应等于
 * “A1 里现在仍未结束、且边界后没有新状态的运行的状态事实（标记为已由历史覆盖）”加上 A2。
 * 另含过期边界的重置、伪造边界的拒绝、当前集合跨页、按运行精确读取与规模对照。
 */

import { describe, expect, it, vi } from 'vitest';
import { FileAuthorityCommitLog, type DurableLogCheckpoint } from '@zhixing/core/authority';
import type { ConversationBodyPage, ConversationControlCursor, ConversationControlFact, ConversationControlPage, ConversationRunFactsPage, Signature } from '@zhixing/core/contracts';
import { protocolDigest } from '@zhixing/core/protocol';
import { AnchorResourceGovernor } from '../resource-governor.js';
import { ConversationRunJournal } from '../conversation-assignment.js';
import { ConversationReadIndex } from '../conversation-read-index.js';
import { trackAuthorityLog } from './durable-io-test-support.js';
import { fixture, ID, NOW, run, verifier, type Body, type Fixture } from './outside-history-test-support.js';

const signer = { sign(schema: string, version: number, payload: unknown): Signature { return { alg: 'test-sha256', keyId: 'device:test', sig: protocolDigest(schema, version, payload) }; } };

/** 只读的 owner：另开同一目录的日志实例，读路径与生产相同 */
function reader(f: Fixture) {
  const log = trackAuthorityLog(new FileAuthorityCommitLog(f.log.rootDir, f.artifacts, { clock: () => NOW }));
  const resources = new AnchorResourceGovernor({ log, signer, verifier, guard: { assert() {} }, anchorEpoch: 1,
    localExecutorId: 'device:test', reporterKeyFor: () => 'device:test', clock: () => NOW });
  const journal = new ConversationRunJournal({ conversationId: ID, ownerEpoch: 1, log, artifacts: f.artifacts, signer, verifier, resources,
    submission: { authenticate() {}, authorize() {} }, authority: { decideAtPrefix: () => ({ committed: true, commitRevision: 1 }) },
    projection: { async project() {} }, clock: () => NOW });
  return { log, journal };
}

async function scan(journal: ConversationRunJournal, first: { historyThrough?: DurableLogCheckpoint; cursor?: ConversationControlCursor }) {
  const facts: ConversationControlFact[] = [];
  let cursor = first.cursor, pages = 0;
  for (;;) {
    const page = await journal.recoveryPage({ mode: 'control-page', conversationId: ID,
      ...(cursor ? { cursor } : first.historyThrough ? { historyThrough: first.historyThrough } : {}) }) as ConversationControlPage;
    pages++;
    expect(page.facts.length).toBeLessThanOrEqual(32);
    if (page.reset) return { facts, cursor: page.cursor, pages, reset: true };
    facts.push(...page.facts); cursor = page.cursor;
    if (!page.hasMore) return { facts, cursor, pages, reset: false };
  }
}

const open = (state: string) => ['queued', 'dispatched', 'running', 'cancel-requested', 'uncertain'].includes(state);
const normalize = (facts: readonly ConversationControlFact[]) => facts.map(fact => fact.kind === 'status'
  ? ['status', fact.notice.ref.runId, fact.notice.state, fact.notice.statusRevision, !!fact.historyCovered, fact.communication, !!fact.continuation, fact.commitRevision ?? null]
  : fact.kind === 'input' ? ['input', fact.cursor.runId, fact.cursor.inputKey, fact.cursor.position, !!fact.cursor.imported]
  : ['final', fact.frame.runId, fact.frame.commitRevision, fact.frame.digest]);

async function boundary(journal: ConversationRunJournal) {
  const first = await journal.recoveryPage({ mode: 'body-page', conversationId: ID, includeInputs: true }) as ConversationBodyPage;
  expect(first.historyThrough?.lsn).toBe(first.historyThroughInputLsn);
  return first.historyThrough!;
}

describe('control page from the history boundary', () => {
  it('delivers unfinished runs before the boundary once, then exactly the old tail', async () => {
    const f = await fixture();
    for (let n = 0; n < 12; n++) await run(f, 'ended-' + n, n % 3 ? 'committed' : 'cancelled', { appended: n % 4 === 0 ? 1 : 0, consumeAll: true });
    await run(f, 'queued-a', 'queued', { conversation: true });
    await run(f, 'uncertain-a', 'uncertain');
    await run(f, 'running-a', 'running', { appended: 1 });
    await run(f, 'changes-later', 'queued');
    const { journal } = reader(f);
    const through = await boundary(journal);
    const before = await scan(journal, {});
    await run(f, 'after-new', 'queued');
    await f.append(f.r.state('changes-later', 'cancelled'));
    await run(f, 'after-committed', 'committed');
    const after = await scan(journal, { cursor: before.cursor });
    const bounded = await scan(journal, { historyThrough: through });
    const later = new Set(after.facts.flatMap(fact => fact.kind === 'status' ? [fact.notice.ref.runId] : []));
    const current = before.facts.flatMap(fact => fact.kind === 'status' && open(fact.notice.state) && !later.has(fact.notice.ref.runId) ? [{ ...fact, historyCovered: true }] : []);
    // 当前集合与旧扫描同序（按日志位置），逐项相同
    expect(current.map(fact => fact.notice.ref.runId)).toEqual(['queued-a', 'uncertain-a', 'running-a']);
    expect(normalize(bounded.facts.slice(0, current.length))).toEqual(normalize(current));
    expect(normalize(bounded.facts.slice(current.length))).toEqual(normalize(after.facts));
    expect(after.facts.some(fact => fact.kind === 'final')).toBe(true);
  }, 60_000);

  it('pages more than one budget of unfinished runs without repeating or skipping any', async () => {
    const f = await fixture();
    for (let n = 0; n < 70; n++) await run(f, 'waiting-' + String(n).padStart(2, '0'), 'queued');
    await run(f, 'ended', 'committed');
    const { journal } = reader(f);
    const through = await boundary(journal);
    await run(f, 'after', 'queued');
    const bounded = await scan(journal, { historyThrough: through });
    const status = bounded.facts.flatMap(fact => fact.kind === 'status' ? [fact.notice.ref.runId] : []);
    expect(status.slice(0, 70)).toEqual(Array.from({ length: 70 }, (_, n) => 'waiting-' + String(n).padStart(2, '0')));
    expect(status.slice(70)).toEqual(['after']);
    expect(new Set(status).size).toBe(status.length);
    expect(bounded.facts.filter(fact => fact.kind === 'input').map(fact => fact.kind === 'input' && fact.cursor.runId)).toEqual(['after']);
    expect(bounded.pages).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('resets a boundary taken before a later clear and rejects a forged or foreign boundary', async () => {
    const f = await fixture();
    await run(f, 'before', 'queued');
    const { journal } = reader(f);
    const through = await boundary(journal);
    for (const forged of [{ ...through, prefixDigest: 'sha256:' + '0'.repeat(64) }, { ...through, frameEndOffset: through.frameEndOffset + 1 }, { ...through, logId: 'another-log' }, { ...through, lsn: through.lsn + 1 }]) {
      await expect(journal.recoveryPage({ mode: 'control-page', conversationId: ID, historyThrough: forged })).rejects.toThrow();
    }
    await f.append(f.r.lifecycle('clear'));
    const stale = await journal.recoveryPage({ mode: 'control-page', conversationId: ID, historyThrough: through }) as ConversationControlPage;
    expect(stale).toMatchObject({ reset: true, facts: [] });
    expect((await scan(journal, { historyThrough: await boundary(journal) })).reset).toBe(false);
  }, 60_000);

  it('reads the facts of named runs before the boundary exactly, leaving unfinished runs and later facts to the page', async () => {
    const f = await fixture();
    await run(f, 'committed', 'committed'); await run(f, 'stopped', 'cancelled');
    await run(f, 'queued', 'queued', { conversation: true }); await run(f, 'uncertain', 'uncertain');
    const { journal } = reader(f);
    const through = await boundary(journal);
    await run(f, 'later', 'committed'); await f.append(f.r.state('queued', 'cancelled'));
    const facts = async (lsn: number, runIds = ['committed', 'stopped', 'queued', 'uncertain', 'later', 'unknown']) =>
      normalize((await journal.recoveryPage({ mode: 'run-facts', conversationId: ID, runIds, historyThroughInputLsn: lsn }) as ConversationRunFactsPage).entries.map(entry => entry.fact));
    const final = (runId: string, revision: number) => ['final', runId, revision, 'sha256:' + (9).toString(16).padStart(64, '0')];
    // 已提交运行没有状态通知（与扫描相同），由 final 给出；未结束运行与边界之后的事实不在其中
    expect(await facts(through.lsn)).toEqual([final('committed', 1), ['status', 'stopped', 'cancelled', 2, true, false, false, null]]);
    const head = (await f.log.checkpoint()).lsn;
    // 按源顺序返回（later 的提交早于 queued 的取消），与请求里的运行顺序无关
    expect(await facts(head)).toEqual([final('committed', 1), ['status', 'stopped', 'cancelled', 2, true, false, false, null],
      final('later', 2), ['status', 'queued', 'cancelled', 2, true, true, false, null]]);
    expect(await facts(head, ['queued', 'later', 'stopped', 'committed'])).toEqual(await facts(head));
    await expect(journal.recoveryPage({ mode: 'run-facts', conversationId: ID, runIds: Array.from({ length: 33 }, (_, n) => 'run-' + n), historyThroughInputLsn: head })).rejects.toThrow('32');
    await f.append(f.r.lifecycle('delete'));
    expect(await facts(head, ['stopped'])).toEqual([]);
  }, 60_000);
});

describe('source order of exact and current facts', () => {
  it('orders exact facts by envelope position and item, and labels each current fact with its order', async () => {
    const f = await fixture();
    for (const runId of ['x', 'y', 'open-1', 'open-2']) await f.append(f.r.admitted(runId), f.r.state(runId, 'queued'));
    // 同一信封里先 y 后 x
    await f.append(f.r.state('y', 'cancelled'), f.r.state('x', 'cancelled'));
    const { journal } = reader(f);
    const through = await boundary(journal);
    const page = await journal.recoveryPage({ mode: 'run-facts', conversationId: ID, runIds: ['x', 'y'], historyThroughInputLsn: through.lsn }) as ConversationRunFactsPage;
    expect(page.entries.map(entry => entry.fact.kind === 'status' && entry.fact.notice.ref.runId)).toEqual(['y', 'x']);
    expect(page.entries[0]!.order < page.entries[1]!.order).toBe(true);
    const control = await journal.recoveryPage({ mode: 'control-page', conversationId: ID, historyThrough: through }) as ConversationControlPage;
    expect(control.currentOrder).toHaveLength(2);
    expect(control.facts.slice(0, 2).map(fact => fact.kind === 'status' && fact.notice.ref.runId)).toEqual(['open-1', 'open-2']);
    expect([...control.currentOrder!].sort()).toEqual(control.currentOrder);
    // 当前集合与精确结果可直接比较：open-* 的排队状态早于 x/y 的取消
    expect(control.currentOrder!.at(-1)! < page.entries[0]!.order).toBe(true);
  }, 60_000);
});

describe('the current set reads each run at the revision it holds before the boundary', () => {
  /** 每个运行发出的状态：修订号不重复、按日志顺序递增、最后一条是当前状态；边界之后的状态不标已覆盖 */
  const check = (facts: readonly ConversationControlFact[], through: number, after: ReadonlyMap<string, number>) => {
    const byRun = new Map<string, { revision: number; state: string; covered: boolean }[]>();
    for (const fact of facts) if (fact.kind === 'status') {
      const list = byRun.get(fact.notice.ref.runId) ?? []; list.push({ revision: fact.notice.statusRevision, state: fact.notice.state, covered: !!fact.historyCovered });
      byRun.set(fact.notice.ref.runId, list);
    }
    for (const [runId, list] of byRun) {
      expect(list.map(item => item.revision)).toEqual([...new Set(list.map(item => item.revision))].sort((a, b) => a - b));
      // 边界之后才有的修订一律来自尾部
      for (const item of list) if (item.revision >= (after.get(runId) ?? Infinity)) expect(item.covered).toBe(false);
    }
    void through;
    return byRun;
  };

  it.each(['cancelled', 'uncertain'] as const)('hands a state that moves after the boundary to the tail (%s)', async next => {
    const f = await fixture();
    await f.append(f.r.admitted('race', true), f.r.state('race', 'queued'));
    if (next === 'uncertain') await f.append(await f.r.assigned('race'), f.r.state('race', 'dispatched', 'a-race'));
    const { journal } = reader(f);
    const through = await boundary(journal);
    const original = ConversationReadIndex.prototype.control;
    let injected = false;
    const spy = vi.spyOn(ConversationReadIndex.prototype, 'control').mockImplementation(async function (this: ConversationReadIndex, id: string, ids: readonly string[]) {
      if (!injected && ids.includes('race')) {
        injected = true;
        await f.append(...(next === 'cancelled' ? [f.r.state('race', 'cancelled')] : [f.r.resolution('race'), f.r.state('race', 'uncertain', 'a-race')]));
      }
      return original.call(this, id, ids);
    });
    let bounded: Awaited<ReturnType<typeof scan>>;
    try { bounded = await scan(journal, { historyThrough: through }); } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    // 新状态在本轮上界之后：下一次唤醒带游标续读时由尾部给出
    const later = await scan(journal, { cursor: bounded.cursor });
    const states = check([...bounded.facts, ...later.facts], through.lsn, new Map([['race', next === 'cancelled' ? 2 : 3]])).get('race')!;
    expect(states).toEqual([{ revision: next === 'cancelled' ? 2 : 3, state: next, covered: false }]);
  }, 60_000);

  it('stays consistent when runs change between pages of the current set', async () => {
    const f = await fixture();
    for (let n = 0; n < 70; n++) await run(f, 'waiting-' + String(n).padStart(2, '0'), 'queued');
    const { journal } = reader(f);
    const through = await boundary(journal);
    const original = ConversationReadIndex.prototype.openRunPage;
    let calls = 0;
    const spy = vi.spyOn(ConversationReadIndex.prototype, 'openRunPage').mockImplementation(async function (this: ConversationReadIndex, id: string, after: string | undefined) {
      // 第二页读之前：取消一个已在第一页发出的运行和一个还没读到的运行
      if (++calls === 2) await f.append(f.r.state('waiting-03', 'cancelled'), f.r.state('waiting-60', 'cancelled'));
      return original.call(this, id, after);
    });
    let bounded: Awaited<ReturnType<typeof scan>>;
    try { bounded = await scan(journal, { historyThrough: through }); } finally { spy.mockRestore(); }
    const later = await scan(journal, { cursor: bounded.cursor });
    const byRun = check([...bounded.facts, ...later.facts], through.lsn, new Map([['waiting-03', 2], ['waiting-60', 2]]));
    expect(byRun.get('waiting-03')).toEqual([{ revision: 1, state: 'queued', covered: true }, { revision: 2, state: 'cancelled', covered: false }]);
    expect(byRun.get('waiting-60')).toEqual([{ revision: 2, state: 'cancelled', covered: false }]);
    expect(byRun.size).toBe(70);
    for (const [runId, list] of byRun) if (runId !== 'waiting-03' && runId !== 'waiting-60') expect(list).toEqual([{ revision: 1, state: 'queued', covered: true }]);
  }, 120_000);
});

describe('control page work with fixed current obligations and growing ended history', () => {
  it('reads the same amount at 10 / 40 / 160 / 640 committed runs while the full scan grows', async () => {
    const rows: { history: number; current: string; tail: string; returned: number; bounded: Record<string, number>; full: Record<string, number> }[] = [];
    for (const history of [10, 40, 160, 640]) {
      const f = await fixture();
      // 已结束历史每 16 个运行合成一个信封写入（每次追加有固定的文件开销，与被测的读取无关）
      for (let n = 0; n < history; n += 16) {
        const hold: Body[] = [];
        for (let k = n; k < Math.min(history, n + 16); k++) await run(f, 'ended-' + k, 'committed', { appended: k % 4 === 0 ? 1 : 0, consumeAll: true, hold });
        await f.append(...hold);
      }
      for (let n = 0; n < 2; n++) await run(f, 'queued-' + n, 'queued', { conversation: true });
      for (let n = 0; n < 2; n++) await run(f, 'uncertain-' + n, 'uncertain');
      await run(f, 'running', 'running');
      const { log, journal } = reader(f);
      const through = await boundary(journal);
      await run(f, 'after-queued', 'queued'); await run(f, 'after-committed', 'committed');
      const measure = async (first: Parameters<typeof scan>[1]) => {
        const envelopes = vi.spyOn(log, 'readEnvelopesAt');
        const calls = (['controlPage', 'openRunPage', 'control', 'historyCommit', 'state'] as const).map(name => [name, vi.spyOn(ConversationReadIndex.prototype, name)] as const);
        try {
          const result = await scan(journal, first);
          const batches = await Promise.all(envelopes.mock.results.map(item => item.value as Promise<readonly { entries: readonly unknown[] }[]>));
          return { result, counts: { pages: result.pages, envelopeReads: batches.length, envelopes: batches.reduce((sum, batch) => sum + batch.length, 0),
            records: batches.reduce((sum, batch) => sum + batch.reduce((count, envelope) => count + envelope.entries.length, 0), 0),
            ...Object.fromEntries(calls.map(([name, spy]) => [name, spy.mock.calls.length])) } };
        } finally { envelopes.mockRestore(); for (const [, spy] of calls) spy.mockRestore(); }
      };
      const bounded = await measure({ historyThrough: through }), full = await measure({});
      rows.push({ history, current: '2 queued(conversation) + 2 uncertain + 1 running', tail: '1 queued + 1 committed', returned: bounded.result.facts.length,
        bounded: bounded.counts, full: full.counts });
    }
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      expect(row.returned).toBe(rows[0]!.returned);
      expect(row.bounded).toEqual(rows[0]!.bounded);
    }
    expect(rows.at(-1)!.full.records).toBeGreaterThan(rows[0]!.full.records * 10);
  }, 600_000);
});
