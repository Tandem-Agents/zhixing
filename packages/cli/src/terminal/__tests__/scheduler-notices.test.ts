import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SchedulerNoticePage, SchedulerNoticeView } from '../../runtime/rpc-scheduler-facade.js';
import {
  schedulerNoticeProgressFile, TerminalSchedulerNotices,
  type SchedulerNoticeProgress, type SchedulerNoticeProgressStore,
} from '../scheduler-notices.js';

// 按源端分页语义的宿主替身：每页至多 perPage 条，可截在同一修订中间并给出续读条数
function host(source = 'source-a', perPage = 3) {
  const notices: SchedulerNoticeView[] = [];
  const state = { head: 0, source: source as string | undefined };
  let live: (() => void) | undefined;
  return {
    notices, state,
    add(id: string, options: { revision?: number; audience?: 'first-party' | 'channel'; kind?: string } = {}) {
      const revision = options.revision ?? state.head + 1;
      state.head = Math.max(state.head, revision);
      notices.push({ noticeId: id, revision, kind: options.kind ?? 'missed-summary', reason: `汇总 ${id}`,
        ...(options.audience === undefined ? { audience: 'first-party' as const } : { audience: options.audience }) });
    },
    read: vi.fn(async (requestedAfter: number, requestedSkip: number, cursorSource?: string): Promise<SchedulerNoticePage> => {
      if (!state.source) return { notices: [], next: requestedAfter, skip: 0, more: false };
      // 与源端同一语义：游标属于另一代时从这一代起点读并标明换代
      const reset = cursorSource !== undefined && cursorSource !== state.source;
      const after = reset ? 0 : requestedAfter, skip = reset ? 0 : requestedSkip;
      const mark = reset ? { reset: true as const } : {};
      let dropped = 0;
      const list = notices.filter(notice => notice.revision > after).sort((a, b) => a.revision - b.revision)
        .filter(notice => !(notice.revision === after + 1 && dropped++ < skip));
      const taken = list.slice(0, perPage);
      if (list.length <= perPage) return { notices: taken, next: Math.max(after, state.head), skip: 0, more: false, source: state.source, ...mark };
      const last = taken.at(-1)!;
      if (list[perPage]!.revision === last.revision) {
        const inRevision = taken.filter(notice => notice.revision === last.revision).length + (last.revision === after + 1 ? skip : 0);
        return { notices: taken, next: last.revision - 1, skip: inRevision, more: true, source: state.source, ...mark };
      }
      return { notices: taken, next: last.revision, skip: 0, more: true, source: state.source, ...mark };
    }),
    subscribe: (arrived: () => void) => { live = arrived; return () => { live = undefined; }; },
    arrive() { live?.(); },
  };
}

function memoryStore(initial?: SchedulerNoticeProgress) {
  const box = { value: initial };
  const store: SchedulerNoticeProgressStore = {
    load: vi.fn(async () => box.value),
    save: vi.fn(async (progress: SchedulerNoticeProgress) => { box.value = progress; return true; }),
  };
  return { box, store };
}

function terminal(fake: ReturnType<typeof host>, store: SchedulerNoticeProgressStore, show = vi.fn(async (_message: string) => true)) {
  const notices = new TerminalSchedulerNotices({ read: fake.read, subscribe: fake.subscribe, progress: store, show,
    signal: new AbortController().signal });
  return { notices, show };
}

async function settle(notices: TerminalSchedulerNotices) {
  notices.catchUp();
  for (let i = 0; i < 20; i++) await notices.idle();
}

describe('first-party scheduler notices in the terminal', () => {
  it('shows an offline missed summary once after reopening and never again on re-entry', async () => {
    const fake = host(), { box, store } = memoryStore();
    fake.add('other-kind', { kind: 'capability-gap' });
    fake.add('missed-1');
    const first = terminal(fake, store);
    await settle(first.notices);
    expect(first.show.mock.calls.map(([message]) => message)).toEqual(['汇总 missed-1']);
    expect(box.value).toEqual({ source: 'source-a', watermark: 2, skip: 0 });
    first.notices.dispose();
    const second = terminal(fake, store);
    await settle(second.notices);
    expect(second.show).not.toHaveBeenCalled();
    // 读从持久位置开始，不从头重读
    expect(fake.read).toHaveBeenLastCalledWith(2, 0, 'source-a');
  });

  it('only claims first-party summaries; channel audience, unmarked and other kinds stay out', async () => {
    const fake = host(), { store } = memoryStore();
    fake.add('channel', { audience: 'channel' });
    fake.notices.push({ noticeId: 'unmarked', revision: 2, kind: 'missed-summary', reason: '旧事实' });
    fake.state.head = 2;
    fake.add('publish', { kind: 'publish-result' });
    fake.add('mine');
    const { notices, show } = terminal(fake, store);
    await settle(notices);
    expect(show.mock.calls.map(([message]) => message)).toEqual(['汇总 mine']);
  });

  it('merges a live trigger arriving during catch-up without double display', async () => {
    const fake = host(), { store } = memoryStore();
    fake.add('missed-1');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = fake.read.getMockImplementation()!;
    fake.read.mockImplementationOnce(async (after, skip) => { await gate; return read(after, skip); });
    const { notices, show } = terminal(fake, store);
    notices.catchUp();
    // 补读进行中到达新通知：只记一次再走一轮，不并发也不重复
    fake.add('missed-2');
    fake.arrive(); fake.arrive();
    release();
    await settle(notices);
    expect(show.mock.calls.map(([message]) => message)).toEqual(['汇总 missed-1', '汇总 missed-2']);
  });

  it('keeps same-revision notices recoverable at the entry boundary when display stops midway', async () => {
    const fake = host(), { box, store } = memoryStore();
    fake.add('before');
    fake.add('pair-a', { revision: 5 });
    fake.add('pair-b', { revision: 5 });
    fake.add('after', { revision: 6 });
    const show = vi.fn(async (message: string) => message !== '汇总 pair-b');
    const first = terminal(fake, store, show);
    await settle(first.notices);
    // 停在同修订第二条之前：复合位置是“修订 4 之后、修订 5 已处理 1 条”
    expect(box.value).toEqual({ source: 'source-a', watermark: 4, skip: 1 });
    const second = terminal(fake, store);
    await settle(second.notices);
    expect(second.show.mock.calls.map(([message]) => message)).toEqual(['汇总 pair-b', '汇总 after']);
    expect(box.value).toEqual({ source: 'source-a', watermark: 6, skip: 0 });
  });

  it('resumes a long same-revision run at the entry boundary after an interruption, without replay', async () => {
    // 36 条合法通知同一修订，跨多页；显示完前 33 条后停下，重开只补后 3 条，总共恰好 36 次
    const fake = host('source-a', 10), { box, store } = memoryStore();
    for (let index = 1; index <= 36; index++) fake.add(`same-${index}`, { revision: 5 });
    let budget = 33;
    const interrupted = vi.fn(async (_message: string) => budget-- > 0);
    const first = terminal(fake, store, interrupted);
    await settle(first.notices);
    expect(box.value).toEqual({ source: 'source-a', watermark: 4, skip: 33 });
    const second = terminal(fake, store);
    await settle(second.notices);
    const shown = [...interrupted.mock.calls.slice(0, 33), ...second.show.mock.calls].map(([message]) => message);
    expect(shown).toHaveLength(36);
    expect(new Set(shown).size).toBe(36);
    expect(box.value).toEqual({ source: 'source-a', watermark: 5, skip: 0 });
    // 进度大小与这个信封的条数无关
    expect(Object.keys(box.value!)).toEqual(['source', 'watermark', 'skip']);
  });

  it('does not advance past a summary that could not be displayed', async () => {
    const fake = host(), { box, store } = memoryStore();
    fake.add('missed-1');
    const show = vi.fn(async () => false);
    const { notices } = terminal(fake, store, show);
    await settle(notices);
    expect(box.value).toEqual({ source: 'source-a', watermark: 0, skip: 0 });
    show.mockResolvedValue(true);
    await settle(notices);
    expect(show).toHaveBeenCalledTimes(2);
    expect(box.value).toEqual({ source: 'source-a', watermark: 1, skip: 0 });
  });

  it('isolates progress by notice source generation and waits while the source is not ready', async () => {
    const fake = host('source-a'), { box, store } = memoryStore({ source: 'source-old', watermark: 50, skip: 2 });
    fake.add('missed-1');
    fake.state.source = undefined;
    const { notices, show } = terminal(fake, store);
    await settle(notices);
    expect(show).not.toHaveBeenCalled();
    expect(box.value).toEqual({ source: 'source-old', watermark: 50, skip: 2 });
    fake.state.source = 'source-a';
    await settle(notices);
    // 换代：旧位置连同其代际交给源端，源端从这一代起点读并标明换代，不再重读
    expect(fake.read).toHaveBeenLastCalledWith(50, 2, 'source-old');
    expect(show.mock.calls.map(([message]) => message)).toEqual(['汇总 missed-1']);
    expect(box.value).toEqual({ source: 'source-a', watermark: 1, skip: 0 });
  });

  it('continues from another terminal\'s position when it already moved to the new generation', async () => {
    const fake = host('source-b'), { box, store } = memoryStore({ source: 'source-a', watermark: 9, skip: 0 });
    fake.add('seen-by-other');
    fake.add('new-one');
    const { notices, show } = terminal(fake, store);
    // 首次读到 source-b 之前，另一个终端已把文件推进到 source-b 的修订 1
    box.value = { source: 'source-b', watermark: 1, skip: 0 };
    await settle(notices);
    expect(show.mock.calls.map(([message]) => message)).toEqual(['汇总 new-one']);
  });

  it('pages through a long backlog and stops when a page does not advance', async () => {
    const fake = host(), { box, store } = memoryStore();
    for (let i = 1; i <= 7; i++) fake.add(`missed-${i}`);
    const { notices, show } = terminal(fake, store);
    await settle(notices);
    expect(show).toHaveBeenCalledTimes(7);
    expect(box.value).toEqual({ source: 'source-a', watermark: 7, skip: 0 });
    // 7 条按每页 3 条读了 3 页；再给一页声称还有更多却不前进：只读这一次就停，不空转
    expect(fake.read).toHaveBeenCalledTimes(3);
    fake.read.mockResolvedValueOnce({ notices: [], next: 7, skip: 0, more: true, source: 'source-a' });
    await settle(notices);
    expect(fake.read).toHaveBeenCalledTimes(4);
  });

  it('continues inside one revision with the source skip and loses nothing', async () => {
    const view = (id: string) => ({ noticeId: id, revision: 5, kind: 'missed-summary', reason: `汇总 ${id}`, audience: 'first-party' as const });
    const { box, store } = memoryStore();
    const pages = new Map<string, SchedulerNoticePage>([
      ['0:0', { notices: [view('a'), view('b')], next: 4, skip: 2, more: true, source: 's' }],
      ['4:2', { notices: [view('c')], next: 6, skip: 0, more: false, source: 's' }],
    ]);
    const read = vi.fn(async (after: number, skip: number) => pages.get(`${after}:${skip}`) ?? { notices: [], next: after, skip: 0, more: false, source: 's' });
    const show = vi.fn(async (_message: string) => true);
    const notices = new TerminalSchedulerNotices({ read, subscribe: () => () => {}, progress: store, show, signal: new AbortController().signal });
    await settle(notices);
    expect(read.mock.calls).toEqual([[0, 0, undefined], [4, 2, 's']]);
    expect(show.mock.calls.map(([message]) => message)).toEqual(['汇总 a', '汇总 b', '汇总 c']);
    expect(box.value).toEqual({ source: 's', watermark: 6, skip: 0 });
  });
});

describe('scheduler notice progress file under concurrent terminals', () => {
  const fileIn = async () => join(await mkdtemp(join(tmpdir(), 'zx-notice-race-')), 'runtime', 'terminal-scheduler-notices.json');

  it('serializes read-merge-write so a stale writer cannot lower the position', async () => {
    const file = await fileIn();
    await schedulerNoticeProgressFile(file).save({ source: 's', watermark: 1, skip: 0 });
    // 两个终端都从位置 1 读起：旧的一方保存 5 时停在“读完、写入前”，新的一方随后保存 20；
    // 没有互斥时新的一方先写成 20、旧的一方再写 5 覆盖，读回是 5
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const stale = schedulerNoticeProgressFile(file, { beforeWrite: async () => { entered(); await gate; } });
    const fresh = schedulerNoticeProgressFile(file);
    await fresh.load(); await stale.load();
    const staleSave = stale.save({ source: 's', watermark: 5, skip: 0 });
    await reached;
    const freshSave = fresh.save({ source: 's', watermark: 20, skip: 0 });
    // 给新的一方足够时间：若不互斥，它此时已写完
    await new Promise(resolve => setTimeout(resolve, 200));
    release();
    await Promise.all([staleSave, freshSave]);
    expect(await schedulerNoticeProgressFile(file).load()).toEqual({ source: 's', watermark: 20, skip: 0 });
  });

  it('rejects every late write from a replaced generation and lets the same instance continue on the new one', async () => {
    const file = await fileIn();
    await schedulerNoticeProgressFile(file).save({ source: 'A', watermark: 9, skip: 0 });
    const mover = schedulerNoticeProgressFile(file), late = schedulerNoticeProgressFile(file);
    await mover.load(); await late.load();
    // 一个终端先读到新代并换代；另一个还持着旧代的进度，连续两次迟到写入
    expect(await mover.save({ source: 'B', watermark: 3, skip: 0 })).toBe(true);
    expect(await late.save({ source: 'A', watermark: 40, skip: 0 })).toBe(false);
    expect(await late.save({ source: 'A', watermark: 41, skip: 0 })).toBe(false);
    expect(await schedulerNoticeProgressFile(file).load()).toEqual({ source: 'B', watermark: 3, skip: 0 });
    // 即使它随后读到了文件现状，换下的 A 也不能再成为当前代
    await late.load();
    expect(await late.save({ source: 'A', watermark: 42, skip: 0 })).toBe(false);
    // 真正按 B 接续可以推进
    expect(await late.save({ source: 'B', watermark: 5, skip: 1 })).toBe(true);
    expect(await schedulerNoticeProgressFile(file).load()).toEqual({ source: 'B', watermark: 5, skip: 1 });
  });
});

describe('scheduler notice progress file', () => {
  it('persists across processes, merges by composite position and treats damage as fresh progress', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'zx-notice-progress-')), 'runtime', 'terminal-scheduler-notices.json');
    const a = schedulerNoticeProgressFile(file), b = schedulerNoticeProgressFile(file);
    expect(await a.load()).toBeUndefined();
    await a.save({ source: 's', watermark: 4, skip: 2 });
    // 同一代按（修订，条数）字典序取大
    await b.save({ source: 's', watermark: 4, skip: 1 });
    expect(await a.load()).toEqual({ source: 's', watermark: 4, skip: 2 });
    await b.save({ source: 's', watermark: 5, skip: 0 });
    expect(await a.load()).toEqual({ source: 's', watermark: 5, skip: 0 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ v: 2, consumer: 'first-party-terminal', retired: [] });
    // 从文件现状出发的换代：写入并记下换下的代际
    await b.save({ source: 't', watermark: 1, skip: 0 });
    expect(await a.load()).toEqual({ source: 't', watermark: 1, skip: 0 });
    expect(JSON.parse(await readFile(file, 'utf8')).retired).toEqual(['s']);
    await writeFile(file, '{not json');
    expect(await a.load()).toBeUndefined();
    await writeFile(file, JSON.stringify({ v: 1, source: 's', watermark: 3, shown: [] }));
    expect(await a.load()).toBeUndefined();
    await writeFile(file, 'x'.repeat(17 * 1024));
    expect(await a.load()).toBeUndefined();
  });
});
