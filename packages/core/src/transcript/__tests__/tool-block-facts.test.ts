import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createTempDir } from '@zhixing-ai/test-utils';
import type { Message } from '../../types/messages.js';
import type { ArtifactJsonIndex } from '../../authority/artifact-json-index.js';
import type { ArtifactRef } from '../../contracts/index.js';
import { TranscriptByteReader, type TranscriptBodyCursor, type TranscriptBodyFragment } from '../shard/byte-reader.js';
import { ShardedTranscriptStore } from '../shard/store.js';
import { readTranscriptToolFacts, TranscriptToolPairingCache, type TranscriptToolFactsRead } from '../tool-block-facts.js';

const run = (messages: Message[]) => ({ timestamp: '2026-10-09T00:00:00.000Z', messages });
const bigOk = 'L\n'.repeat(200_000);
const longError = 'boom first line\n' + 'e'.repeat(50_000);

async function readAll(reader: TranscriptByteReader, onPage?: (preparing: boolean) => void): Promise<TranscriptBodyFragment[]> {
  const fragments: TranscriptBodyFragment[] = [];
  let cursor: TranscriptBodyCursor | undefined;
  for (let pages = 0; pages < 2000; pages++) {
    const page = await reader.page({ cursor });
    onPage?.(!!page.preparing);
    if (page.preparing) { cursor = page.cursor; continue; }
    // 与终端投影一致：消费到片段的坐标，下一页从那里续读
    const first = page.fragments[0];
    if (first) { fragments.push(first); cursor = first.cursor; continue; }
    cursor = page.cursor;
    if (!page.hasMore) return fragments;
  }
  throw Error('too many pages');
}

/** 直接读一个结果块的事实，pending 就按读取器的做法从同一位置重读，直到有结论 */
async function settle(json: ArtifactJsonIndex, ref: ArtifactRef, message: number, block: number, cache: TranscriptToolPairingCache):
  Promise<{ read: TranscriptToolFactsRead; pending: number }> {
  for (let pending = 0; pending < 1000; pending++) {
    const read = await readTranscriptToolFacts(json, ref, [], message, block, 'tool_result', cache);
    if (read.kind !== 'pending') return { read, pending };
  }
  throw Error('pairing did not settle');
}

const pairedBlock = (read: TranscriptToolFactsRead) => read.kind === 'facts' && read.facts.kind === 'result' ? read.facts.call?.block : undefined;

/**
 * 在某个块的 type 第一次被读时暂停，直到放行：用来确定地让其它读取在这次扫描进行中插进来。
 * 同时按块计数该消息的 type 读取，用来核对同一条目的扫描没有重复。
 */
function gateTypeRead(json: ArtifactJsonIndex, message: number, block: number) {
  const value = json.value.bind(json), reads = new Map<number, number>();
  let reached!: () => void, release!: () => void, armed = true;
  const hit = new Promise<void>(resolve => { reached = resolve; }), open = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(json, 'value').mockImplementation(async (ref, keys, maximum) => {
    if (keys.length === 5 && keys[1] === message && keys[4] === 'type') {
      reads.set(keys[3] as number, (reads.get(keys[3] as number) ?? 0) + 1);
      if (armed && keys[3] === block) { armed = false; reached(); await open; }
    }
    return value(ref, keys, maximum);
  });
  return { hit, release, reads, restore: () => spy.mockRestore() };
}

const ticks = async (count: number) => { for (let index = 0; index < count; index++) await new Promise<void>(setImmediate); };

describe('恢复历史的工具块事实', () => {
  it('结果块按同一运行里的调用配对成卡片事实，调用块不重复，跨运行同 toolId 不串，读取有界', async () => {
    const home = await createTempDir('tool-block-facts');
    const store = new ShardedTranscriptStore(home);
    await store.appendRunRecord('c', run([
      { role: 'user', content: [{ type: 'text', text: '请看' }] },
      { role: 'assistant', content: [
        { type: 'text', text: '先读文件' },
        { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 't2', name: 'bash', input: { command: 'x'.repeat(6000) } },
        { type: 'tool_use', id: 't3', name: 'write', input: { path: 'b.ts', content: '正文不进卡片' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', toolUseId: 't1', content: bigOk },
        { type: 'tool_result', toolUseId: 't2', content: longError, isError: true },
        { type: 'tool_result', toolUseId: 't3', content: 'Not started: this batch selected the exclusive control call "propose_advancement".', isError: true,
          disposition: { kind: 'not-started', reason: 'exclusive-control', selectedTool: 'propose_advancement' } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: '完成' }] },
    ]));
    await store.appendRunRecord('c', run([
      { role: 'user', content: [{ type: 'text', text: '再来' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'foo' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'x' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'glob', input: { pattern: '*.ts' } }] },
    ]));
    const reader = new TranscriptByteReader(path.join(home, 'c', 'transcript'), path.join(home, '.read-index'));
    try {
      const textRange = vi.spyOn(reader.json, 'textRange'), text = vi.spyOn(reader.json, 'text');
      const fragments = await readAll(reader);
      const shape = fragments.map(fragment => fragment.tool ? `${fragment.runIndex}:${fragment.type}:${fragment.toolId}` : `${fragment.runIndex}:${fragment.text}`);
      expect(shape).toEqual([
        '1:tool_use:t9', '1:tool_result:t1', '1:再来',
        '0:完成', '0:tool_result:t3', '0:tool_result:t2', '0:tool_result:t1', '0:先读文件', '0:请看',
      ]);
      const byKey = (key: string) => fragments[shape.indexOf(key)]!.tool!;
      expect(byKey('1:tool_use:t9')).toEqual({ kind: 'call', name: 'glob', input: { pattern: '*.ts' } });
      expect(byKey('1:tool_result:t1')).toEqual({ kind: 'result', call: { name: 'grep', input: { pattern: 'foo' }, message: 1, block: 0 }, length: 1, isError: false });
      expect(byKey('0:tool_result:t1')).toEqual({ kind: 'result', call: { name: 'read', input: { path: 'a.ts' }, message: 1, block: 1 }, length: bigOk.length, isError: false });
      const failed = byKey('0:tool_result:t2');
      expect(failed).toMatchObject({ kind: 'result', isError: true, length: longError.length, call: { name: 'bash', message: 1, block: 2 } });
      expect(failed.kind === 'result' && failed.call!.input.command).toBe('x'.repeat(512));
      expect(failed.kind === 'result' && failed.head!.length).toBe(1024);
      expect(failed.kind === 'result' && failed.head!.startsWith('boom first line\n')).toBe(true);
      expect(byKey('0:tool_result:t3')).toMatchObject({ kind: 'result', isError: true,
        call: { name: 'write', input: { path: 'b.ts' } },
        disposition: { kind: 'not-started', reason: 'exclusive-control', selectedTool: 'propose_advancement' } });
      // 有界：超长命令与失败开头各只读一个索引片；工具结果正文从不按全文分段读取（成功结果一字不读）
      expect(textRange).toHaveBeenCalledTimes(2);
      expect(textRange.mock.calls.map(([, node]) => node.field).sort()).toEqual(['command', 'content']);
      expect(text.mock.calls.every(([, node]) => node.field === 'text')).toBe(true);

      // 回放：正序重读结果块得到同一事实；清空后重读报失效
      const replay = fragments[shape.indexOf('0:tool_result:t2')]!;
      const again = await reader.page({ cursor: replay.cursor, forward: true });
      expect(again.fragments[0]?.tool).toEqual(replay.tool);
      await store.appendClear('c');
      await expect(reader.page({ cursor: replay.cursor, forward: true })).rejects.toThrow('generation-changed');
    } finally { await reader.close(); }
  });

  it('超过一次预算的配对（130 个调用、调用前有文本与思考、结果消息带尾随文本、长 id）：续查到底，一调用一卡，不提前给出无结果卡片，每页实际读取有界', async () => {
    const home = await createTempDir('tool-block-facts-many');
    const store = new ShardedTranscriptStore(home);
    const count = 130, id = (index: number) => `call-${String(index).padStart(3, '0')}-${'i'.repeat(390)}`;
    await store.appendRunRecord('c', run([
      { role: 'user', content: [{ type: 'text', text: '并行很多' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '先想一想' },
        { type: 'text', text: '开始' },
        ...Array.from({ length: count }, (_, index) => ({ type: 'tool_use' as const, id: id(index), name: 'read', input: { path: `f${index}.ts` } })),
      ] },
      // 结果消息末尾多一个文本块：按尾部对齐猜的位置整体错开一位，第一个被读的结果要从头续查到第 131 块
      { role: 'user', content: [...Array.from({ length: count }, (_, index) => index === count - 1
        ? { type: 'tool_result' as const, toolUseId: id(index), content: 'fail\n' + 'x'.repeat(60_000), isError: true }
        : { type: 'tool_result' as const, toolUseId: id(index), content: `ok ${index}` }),
        { type: 'text' as const, text: '附注' }] },
    ]));
    const reader = new TranscriptByteReader(path.join(home, 'c', 'transcript'), path.join(home, '.read-index'));
    try {
      // 每页实际读出的值与文本字节（按返回内容计；索引定位另计次数）
      let pageBytes = 0, maxPageBytes = 0, pending = 0;
      const value = reader.json.value.bind(reader.json), textRange = reader.json.textRange.bind(reader.json);
      vi.spyOn(reader.json, 'value').mockImplementation(async (...args) => {
        const result = await value(...args); pageBytes += Buffer.byteLength(JSON.stringify(result) ?? ''); return result;
      });
      vi.spyOn(reader.json, 'textRange').mockImplementation(async (...args) => {
        const result = await textRange(...args); pageBytes += Buffer.byteLength(result.text); return result;
      });
      const fragments = await readAll(reader, preparing => {
        if (preparing) pending++;
        maxPageBytes = Math.max(maxPageBytes, pageBytes); pageBytes = 0;
      });
      const tools = fragments.filter(fragment => fragment.tool);
      // 一调用一卡：只有结果卡片，没有“未记录结果”的调用卡片
      expect(tools.every(fragment => fragment.type === 'tool_result' && fragment.tool?.kind === 'result')).toBe(true);
      expect(tools).toHaveLength(count);
      for (const fragment of tools) {
        const facts = fragment.tool!;
        if (facts.kind !== 'result') throw Error('unexpected');
        const index = Number(fragment.toolId!.slice(5, 8));
        expect(facts.call).toMatchObject({ name: 'read', input: { path: `f${index}.ts` }, message: 1, block: index + 2 });
      }
      expect(pending).toBeGreaterThan(0);
      // 两本账合计 64 KiB 内容字节；页内读取器自身读块种类、角色等的小值另有少量开销
      expect(maxPageBytes).toBeLessThan(64 * 1024 + 4096);
    } finally { await reader.close(); }
  }, 120_000);

  it('同一条消息的并发读取与淘汰时仍在进行的扫描：每个结果配到正确位置，之后按缓存重读也正确', async () => {
    const home = await createTempDir('tool-block-facts-concurrent');
    const store = new ShardedTranscriptStore(home);
    // 第 0 组 60 个调用（扫描要跨两次预算），另有 17 组各 8 个调用，用来把第 0 组的条目挤出缓存
    const sizes = [60, ...Array.from({ length: 17 }, () => 8)];
    const id = (group: number, index: number) => `g${group}-c${index}-${'i'.repeat(300)}`;
    await store.appendRunRecord('c', run([
      { role: 'user', content: [{ type: 'text', text: '开始' }] },
      ...sizes.flatMap((size, group): Message[] => [
        { role: 'assistant', content: Array.from({ length: size }, (_, index) => ({ type: 'tool_use' as const, id: id(group, index), name: 'read', input: { path: `g${group}/${index}.ts` } })) },
        // 结果消息末尾多一个文本块：尾部对齐的猜测全部错开一位，配对都要走缓存扫描
        { role: 'user', content: [...Array.from({ length: size }, (_, index) => ({ type: 'tool_result' as const, toolUseId: id(group, index), content: `ok ${index}` })),
          { type: 'text' as const, text: '附注' }] },
      ]),
    ]));
    const reader = new TranscriptByteReader(path.join(home, 'c', 'transcript'), path.join(home, '.read-index'));
    const records = reader.records();
    try {
      const { json, ref } = (await records.next()).value!;
      const results = (group: number) => 2 + 2 * group;
      const expectAll = async (cache: TranscriptToolPairingCache, group: number) => {
        for (let index = 0; index < sizes[group]!; index++) {
          expect(pairedBlock((await settle(json, ref, results(group), index, cache)).read)).toBe(index);
        }
      };

      // 同一条目：第一个读取在扫描中途暂停时，另外两个读取插进来；它们必须排在后面，不能共用、推进同一个扫描位置
      let cache = new TranscriptToolPairingCache();
      let gate = gateTypeRead(json, 1, 20);
      const first = settle(json, ref, results(0), 59, cache);
      await gate.hit;
      const others = [settle(json, ref, results(0), 5, cache), settle(json, ref, results(0), 30, cache)];
      await ticks(20);
      gate.release();
      const [late, early, middle] = await Promise.all([first, ...others]);
      gate.restore();
      expect([pairedBlock(late!.read), pairedBlock(early!.read), pairedBlock(middle!.read)]).toEqual([59, 5, 30]);
      expect(late!.pending).toBeGreaterThan(0);
      // 同一条目的扫描串行：除了三处尾部对齐的猜测位置，每块只扫一次；只有预算用尽处读了种类、没读完 id 的那一块会重读
      const guesses = new Set([58, 4, 29]);
      const repeated = [...gate.reads].filter(([block, count]) => !guesses.has(block) && count > 1);
      expect(repeated.every(([, count]) => count === 2) && repeated.length <= late!.pending).toBe(true);
      await expectAll(cache, 0);

      // 淘汰时在飞：第 0 组的扫描暂停期间读满另外 16 组，第 0 组的条目被挤出；放行后它照常给出正确结果，重读从新条目续查
      cache = new TranscriptToolPairingCache();
      gate = gateTypeRead(json, 1, 20);
      const inFlight = settle(json, ref, results(0), 59, cache);
      await gate.hit;
      for (let group = 1; group <= 16; group++) expect(pairedBlock((await settle(json, ref, results(group), 7, cache)).read)).toBe(7);
      gate.release();
      expect(pairedBlock((await inFlight).read)).toBe(59);
      gate.restore();
      await expectAll(cache, 0);
      await expectAll(cache, 17);
      // 计入的字节只属于仍在缓存里的条目：读满同样 16 组之后，与只读过这 16 组的新缓存一致（被淘汰的扫描没有写回）
      const fresh = new TranscriptToolPairingCache();
      for (const target of [cache, fresh]) {
        for (let group = 1; group <= 16; group++) expect(pairedBlock((await settle(json, ref, results(group), 7, target)).read)).toBe(7);
      }
      expect(cache.bytes).toBeGreaterThan(0);
      expect(cache.bytes).toBe(fresh.bytes);
    } finally { await records.return(undefined); await reader.close(); }
  }, 120_000);

  it('单条消息的 id 超过缓存容量：占用不超过上限，遗漏区间里的结果仍配对正确，确实没有调用的结果核完整条才判定', async () => {
    const home = await createTempDir('tool-block-facts-over-capacity');
    const store = new ShardedTranscriptStore(home);
    // 2300 个 500 字符的 id，按每个 id 的计入字节算超过 2 MiB
    const count = 2300, id = (index: number) => `c${String(index).padStart(4, '0')}-${'i'.repeat(494)}`;
    await store.appendRunRecord('c', run([
      { role: 'user', content: [{ type: 'text', text: '很多调用' }] },
      { role: 'assistant', content: Array.from({ length: count }, (_, index) => ({ type: 'tool_use' as const, id: id(index), name: 'read', input: { path: `f${index}.ts` } })) },
      { role: 'user', content: [
        ...Array.from({ length: count }, (_, index) => ({ type: 'tool_result' as const, toolUseId: id(index), content: `ok ${index}` })),
        { type: 'tool_result' as const, toolUseId: 'missing-call', content: '没有对应调用' },
        { type: 'text' as const, text: '附注' },
      ] },
    ]));
    const reader = new TranscriptByteReader(path.join(home, 'c', 'transcript'), path.join(home, '.read-index'));
    const records = reader.records();
    try {
      const { json, ref } = (await records.next()).value!;
      const cache = new TranscriptToolPairingCache(), cap = 2 * 1024 * 1024;
      const check = async (block: number) => {
        const settled = await settle(json, ref, 2, block, cache);
        expect(cache.bytes).toBeLessThanOrEqual(cap);
        return settled;
      };
      // 最后一个结果：扫完整条消息才找到，途中多次用尽预算
      const last = await check(count - 1);
      expect(pairedBlock(last.read)).toBe(count - 1);
      expect(last.pending).toBeGreaterThan(10);
      // 条目已逼近上限（确实受界而不是没记），前段命中缓存，遗漏区间里的结果按目标续查也配对正确
      expect(cache.bytes).toBeGreaterThan(cap - 128 * 1024);
      for (const block of [0, 100, 1500, 1950, 2000, 2200, count - 2]) expect(pairedBlock((await check(block)).read)).toBe(block);
      // 没有调用的结果：核完遗漏区间才判定没有配对，给出不带调用的结果卡片
      const missing = await check(count);
      expect(missing.read).toMatchObject({ kind: 'facts', facts: { kind: 'result', isError: false } });
      expect(pairedBlock(missing.read)).toBeUndefined();
      expect(missing.pending).toBeGreaterThan(0);
    } finally { await records.return(undefined); await reader.close(); }
  }, 180_000);
});
