/**
 * 历史外输入的直接定位：读目录维护的候选行，加上新的选取，与早期的全量折叠实现逐例对照。
 *
 * 两边读同一份日志与同一个读目录；新实现的投递事实由同一批记录折叠注入（生产里来自运行状态的合并视图），
 * 所以差分检验的是候选行的维护与选取规则本身，另含总控点名的情形。
 */

import { describe, expect, it, vi } from 'vitest';
import { fixture, ID, lcg, run, type Path } from './outside-history-test-support.js';

describe('outside-history candidates against the full fold', () => {
  it('random local histories select the same inputs, order, truncation and interruptible runs', async () => {
    const paths: Path[] = ['queued', 'cancelled', 'committed', 'committed', 'failed', 'uncertain', 'resolved', 'running'];
    for (let seed = 1; seed <= 12; seed++) {
      const f = await fixture(), rand = lcg(seed);
      for (let n = 0, count = 6 + rand(14); n < count; n++) {
        if (rand(9) === 0) await f.append(f.r.lifecycle('clear'));
        await run(f, `s${seed}-r${n}`, paths[rand(paths.length)]!, { conversation: rand(3) === 0, appended: rand(3), consumeAll: rand(2) === 0 });
        if (rand(4) === 0) await f.compare();
      }
      await f.compare();
    }
  }, 120_000);

  it('keeps an early uncertain input ahead of 201 later candidates', async () => {
    const f = await fixture();
    await run(f, 'early-uncertain', 'uncertain');
    for (let n = 0; n < 201; n++) await run(f, 'later-' + n, 'cancelled');
    const page = await f.compare();
    expect(page.inputs).toHaveLength(200); expect(page.truncated).toBe(true);
    expect(page.inputs[0]?.[0]).toBe('early-uncertain');
  }, 120_000);

  it('takes the first 200 uncertain inputs by position when there are more', async () => {
    const f = await fixture();
    await run(f, 'remote', 'queued', { conversation: true });
    for (let n = 0; n < 205; n++) await run(f, 'uncertain-' + n, 'uncertain');
    const bodies = vi.spyOn(f.directory, 'inputsAt');
    const page = await f.compare();
    expect(page.inputs).toHaveLength(200); expect(page.truncated).toBe(true);
    expect(page.inputs.at(-1)?.[0]).toBe('uncertain-199');
    // 控制目标在显示上限之外照样找到，且不读它的正文；新实现只读被选中的 200 条正文
    expect(page.interruptibleRuns).toEqual([{ runId: 'remote', state: 'queued' }]);
    const read = bodies.mock.calls.flatMap(call => call[1]);
    expect(read.some(pointer => pointer.runId === 'remote')).toBe(false);
    bodies.mockRestore();
  }, 120_000);

  it('merges an in-memory imported base with local inputs and hides the base after a local clear', async () => {
    const f = await fixture();
    await f.prime([
      [f.r.admitted('base-queued'), f.r.state('base-queued', 'queued')],
      [f.r.admitted('base-cancelled'), f.r.state('base-cancelled', 'queued')], [f.r.state('base-cancelled', 'cancelled')],
      [f.r.admitted('base-uncertain'), f.r.state('base-uncertain', 'queued')],
      [await f.r.assigned('base-uncertain'), f.r.state('base-uncertain', 'dispatched', 'a-base-uncertain')],
      [f.r.resolution('base-uncertain'), f.r.state('base-uncertain', 'uncertain', 'a-base-uncertain')],
    ]);
    await run(f, 'local-queued', 'queued');
    await run(f, 'local-committed', 'committed', { appended: 2 });
    const before = await f.compare();
    expect(before.inputs.map(input => input[0])).toEqual(expect.arrayContaining(['base-queued', 'base-cancelled', 'base-uncertain', 'local-queued']));
    await f.append(f.r.lifecycle('clear'));
    await run(f, 'after-clear', 'queued');
    const after = await f.compare();
    expect(after.inputs.map(input => input[0])).toEqual(['after-clear']);
  }, 60_000);

  it('reports initial and appended delivery without opening execution artifacts', async () => {
    const f = await fixture();
    await run(f, 'r', 'running', { appended: 2 });
    const get = vi.spyOn(f.artifacts, 'get').mockRejectedValue(Error('Execution artifacts must not be opened'));
    const page = await f.next.messageInputsOutsideHistory();
    expect(page.inputs.map(({ consumed, disposition, message }) => [message.inputIdentity?.id, consumed, disposition]))
      .toEqual([['r', true, 'consumed'], ['r-append-0', true, 'consumed'], ['r-append-1', false, 'stopped']]);
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
    await f.compare();
    await f.append(await f.r.committed('r'), f.r.state('r', 'committed', 'a-r'));
    expect((await f.compare()).inputs.map(input => input[0])).toEqual(['r-append-1']);
    expect(await f.next.messageStatus('r')).toMatchObject({ consumed: true, state: 'committed' });
  }, 30_000);

  it('keeps one copy when the base and the local log carry the same input key', async () => {
    // 合法日志里不会出现（运行状态重放拒绝重复接纳）；这里只验证防御去重与参照实现一致
    const f = await fixture();
    await f.prime([[f.r.admitted('shared'), f.r.state('shared', 'queued')], [f.r.state('shared', 'cancelled')]]);
    await f.append({ ...f.r.admitted('local-copy'), ingressKey: 'shared' }, f.r.state('local-copy', 'queued'));
    const page = await f.compare();
    expect(page.inputs.map(input => input[1])).toEqual(['local-copy']);
  }, 30_000);

  it('drops a replaced in-memory base and its messages', async () => {
    const f = await fixture();
    await f.prime([[f.r.admitted('base'), f.r.state('base', 'queued')]]);
    expect(await f.next.messageStatus('base')).toMatchObject({ state: 'queued' });
    await f.prime([[f.r.admitted('replacement'), f.r.state('replacement', 'queued')]]);
    expect(await f.next.messageStatus('base')).toBeUndefined();
    expect((await f.compare()).inputs.map(input => input[0])).toEqual(['replacement']);
  }, 30_000);

  it('does not return an old body after the read base changes during materialization', async () => {
    const f = await fixture();
    await f.prime([[f.r.admitted('old'), f.r.state('old', 'queued')]]);
    const original = f.directory.inputsAt.bind(f.directory);
    const bodies = vi.spyOn(f.directory, 'inputsAt').mockImplementationOnce(async (id, pointers) => {
      const result = await original(id, pointers);
      await f.prime([[f.r.admitted('new'), f.r.state('new', 'queued')]]);
      return result;
    });
    expect((await f.next.messageInputsOutsideHistory()).inputs.map(input => input.message.inputIdentity?.id)).toEqual(['new']);
    bodies.mockRestore();
  }, 30_000);

  it('gives an input identity only when the admission carried one', async () => {
    const f = await fixture();
    await run(f, 'legacy', 'cancelled', { legacy: true }); await run(f, 'current', 'cancelled');
    const page = await f.next.messageInputsOutsideHistory();
    expect(page.inputs.map(input => input.message.inputIdentity?.id)).toEqual([undefined, 'current']);
    await f.compare();
    // 按消息 id 查询仍以兜底身份定位较早的接纳
    expect(await f.next.messageStatus('legacy')).toMatchObject({ runId: 'legacy', state: 'cancelled' });
  }, 30_000);

  it('returns nothing after delete', async () => {
    const f = await fixture();
    await run(f, 'queued', 'queued'); await run(f, 'uncertain', 'uncertain');
    await f.append(f.r.lifecycle('delete'));
    expect(await f.compare()).toEqual({ inputs: [], truncated: false, interruptibleRuns: [] });
  }, 30_000);

  it('removes a candidate row once its run is committed and the input consumed', async () => {
    const f = await fixture();
    await run(f, 'done', 'committed', { appended: 3 });
    await run(f, 'stopped', 'cancelled');
    const rows = (await f.directory.outsidePage(ID, 'outside', false, undefined)).entries.map(entry => entry.pointer.inputKey);
    // 首条输入与被消费的追加输入随提交消除；未消费的追加输入与取消的运行保留
    expect(rows.sort()).toEqual(['done-append-1', 'stopped'].sort());
    expect((await f.directory.outsidePage(ID, 'outside-uncertain', false, undefined)).entries).toEqual([]);
    await f.compare();
  }, 30_000);
});
