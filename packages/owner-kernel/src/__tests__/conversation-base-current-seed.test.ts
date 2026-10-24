/**
 * 导入基底的当前集合：冻结时仍排队的运行，其历史外候选、当前集合与可中断候选在收编时播种进本地，
 * 目标端完成这些运行后真实删除，基底里只剩永不变化的候选。
 *
 * 规模对照：固定 6 条已取消的基底输入与 1 个仍排队的基底运行，只放大目标端提交并消费的排队基底运行数；
 * 三条读取（导入段历史外候选、当前集合、可中断候选）的本地与基底底层扫描次数、条目数与字节数都不变。
 * 目标端的运行事实按读目录记录合同直接写入（绕开剩余工作台账里已登记的收编后取消/接纳 backpressure 缺陷）。
 */

import { expect, it, vi } from 'vitest';
import type { DurableProjectionReadContext } from '@zhixing/core/authority';
import { BASE_CONVERSATION, BASE_TRANSFER, baseVerifier, createConversationBaseHarness } from './conversation-base-harness.js';
import { recordBuilders, type Body } from './outside-history-test-support.js';
import { ConversationReadIndex } from '../conversation-read-index.js';
import { ConversationBaseSource } from '../conversation-base-source.js';

const ID = BASE_CONVERSATION, P = JSON.stringify(ID) + ':';

/** 计量一个读取上下文的底层访问：扫描与单键读的次数、返回条目数与字节数 */
function counter() {
  const counts = { scans: 0, gets: 0, rows: 0, bytes: 0 };
  const size = (value: unknown) => value === undefined ? 0 : JSON.stringify(value).length;
  const wrap = (view: DurableProjectionReadContext): DurableProjectionReadContext => ({
    ...view,
    get: async key => { counts.gets++; const value = await view.get(key); counts.bytes += size(value); if (value !== undefined) counts.rows++; return value; },
    scan: async (range, limit) => { counts.scans++; const page = await view.scan(range, limit); counts.rows += page.entries.length; counts.bytes += page.entries.reduce((sum, entry) => sum + entry.key.length + size(entry.value), 0); return page; },
  });
  return { counts, wrap };
}

it('keeps imported current-set reads constant while queued base runs complete on the target', async () => {
  const rows: Record<string, unknown>[] = [];
  for (const completed of [8, 32, 128]) {
    const h = await createConversationBaseHarness();
    for (let n = 0; n < 6; n++) await h.input(h.sourceJournal, 'stopped-' + n, n);
    for (let n = 0; n <= completed; n++) await h.admit(h.sourceJournal, 'queued-' + String(n).padStart(3, '0'), 6 + n);
    await h.transfer();
    const source = (await h.importer.committedBaseSource(BASE_TRANSFER)).source;
    // 种子准备之后：基底可扫描前缀里只剩已取消的候选，排队运行的行在种子区
    const baseScan = async (prefix: string) => (await source.read(view => view.scan({ gte: 'directory/' + P + prefix, lt: 'directory/' + P + prefix + '\uffff' }, 256))).entries.length;
    expect(await baseScan('outside:b:')).toBe(6);
    expect(await baseScan('open-run:')).toBe(0);
    expect(await baseScan('control-candidate:')).toBe(0);
    // 目标端把前 completed 个排队的基底运行走到提交并消费（每个运行一个信封）
    const writer = h.reopen('target');
    const { r, startRevision } = recordBuilders(ID, h.target.artifacts, { ownerEpoch: 2 });
    for (let n = 0; n < completed; n++) {
      const runId = 'queued-' + String(n).padStart(3, '0'), a = 'a-' + runId;
      startRevision(runId, 1);
      const committed = await r.committed(runId);
      const bodies: Body[] = [await r.assigned(runId), r.state(runId, 'dispatched', a), r.state(runId, 'running', a), committed, r.state(runId, 'committed', a), r.final(committed)];
      await writer.log.append(bodies.map(body => ({ stream: body.t === 'final' ? 'final-outbox' : 'run:' + ID, body })));
    }
    const directory = new ConversationReadIndex(h.target.log, h.target.artifacts, baseVerifier);
    directory.installBaseView(source);
    const local = counter(), base = counter();
    const index = directory.index, original = { get: index.get.bind(index), scan: index.scan.bind(index) };
    const wrapped = local.wrap(original);
    vi.spyOn(index, 'scan').mockImplementation(wrapped.scan);
    vi.spyOn(index, 'get').mockImplementation(wrapped.get);
    const read = ConversationBaseSource.prototype.read;
    const spy = vi.spyOn(ConversationBaseSource.prototype, 'read').mockImplementation(function (this: ConversationBaseSource, operation) {
      return read.call(this, view => operation(base.wrap(view)));
    });
    try {
      // 先让读目录追平（不计入），再分别计量三条读取
      await directory.state(ID);
      const measure = async (name: string, readPath: () => Promise<number>) => {
        Object.assign(local.counts, { scans: 0, gets: 0, rows: 0, bytes: 0 }); Object.assign(base.counts, { scans: 0, gets: 0, rows: 0, bytes: 0 });
        const returned = await readPath();
        return { [name]: { returned, local: { ...local.counts }, base: { ...base.counts } } };
      };
      const outside = await measure('outside', async () => (await directory.outsidePage(ID, 'outside', true, undefined)).entries.length);
      const current = await measure('openRun', async () => (await directory.openRunPage(ID, undefined)).entries.length);
      const targets = await measure('controlTargets', async () => (await directory.controlCandidates(ID)).length);
      // 本地 clear 之后：导入基底整体隐藏（历史外读取不再读基底段），当前集合的读取量不变
      await writer.log.append([{ stream: 'run:' + ID, body: r.lifecycle('clear') }]);
      const hidden = (await directory.outsideVisibility(ID)).baseHidden;
      const cleared = await measure('openRunAfterClear', async () => (await directory.openRunPage(ID, undefined)).entries.length);
      rows.push({ completed, fixed: '6 cancelled base inputs + 1 queued base run', ...outside, ...current, ...targets, ...cleared, baseHiddenAfterClear: hidden });
      // 本地维护的行在完成时真实删除，不留墓碑
      const localRows = (await original.scan({ gte: P + 'outside:b:', lt: P + 'outside:b:\uffff' }, 256)).entries;
      expect(localRows.map(row => (row.value as { inputKey?: string }).inputKey)).toEqual(['queued-' + String(completed).padStart(3, '0')]);
    } finally { spy.mockRestore(); vi.restoreAllMocks(); }
  }
  console.log(JSON.stringify(rows));
  // 次数与条目精确相同；字节只随位置编号的位数略变（例如 lsn 从两位变三位），不随已完成的运行数增长
  type Work = { returned: number; local: Record<string, number>; base: Record<string, number> };
  const shape = (work: Work) => ({ returned: work.returned, local: { ...work.local, bytes: 0 }, base: { ...work.base, bytes: 0 } });
  for (const row of rows) expect(row.baseHiddenAfterClear).toBe(true);
  for (const row of rows) for (const name of ['outside', 'openRun', 'controlTargets', 'openRunAfterClear']) {
    const work = row[name] as Work, first = rows[0]![name] as Work;
    expect(shape(work)).toEqual(shape(first));
    for (const side of ['local', 'base'] as const) expect(Math.abs(work[side].bytes! - first[side].bytes!)).toBeLessThanOrEqual(Math.ceil(first[side].bytes! * 0.05));
  }
  expect(rows[0]).toMatchObject({ outside: { returned: 7 }, openRun: { returned: 1 }, controlTargets: { returned: 1 } });
}, 600_000);
