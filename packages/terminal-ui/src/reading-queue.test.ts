import { describe, expect, it } from 'vitest';
import { ReadingQueue, type ReadingIntent } from './reading-queue.js';

describe('one bounded reader across history and display', () => {
  it('coalesces wheel bursts and preserves the last reverse/follow intention', async () => {
    const calls: ReadingIntent[] = [], releases: (() => void)[] = [];
    const queue = new ReadingQueue(intent => { calls.push(intent); return new Promise<void>(resolve => releases.push(resolve)); });
    const initial = queue.request({ kind: 'previous' }); await Promise.resolve();
    for (let i = 0; i < 12; i++) void queue.request({ kind: 'previous' });
    void queue.request({ kind: 'page', start: 12, follow: false });
    void queue.request({ kind: 'page', follow: true });
    expect(calls).toEqual([{ kind: 'previous' }]); releases.shift()!();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toEqual([{ kind: 'previous' }, { kind: 'page', follow: true }]);
    releases.shift()!(); await initial;
  });
  it('retires queued scope work but still admits the new scope after its predecessor', async () => {
    const calls: ReadingIntent[] = []; let release!: () => void;
    const active = { promise: new Promise<void>(resolve => { release = resolve; }), resolve: () => release() };
    const queue = new ReadingQueue(async intent => { calls.push(intent); if (calls.length === 1) await active.promise; });
    const work = queue.request({ kind: 'previous' }); await Promise.resolve();
    void queue.request({ kind: 'page', start: 20, follow: false });
    queue.reset(); void queue.request({ kind: 'previous' }); active.resolve(); await work;
    expect(calls).toEqual([{ kind: 'previous' }, { kind: 'previous' }]);
  });
  it('reports a failed current read and allows an explicit retry', async () => {
    let calls = 0; const queue = new ReadingQueue(async () => { if (++calls === 1) throw Error('read failed'); });
    await expect(queue.request({ kind: 'previous' })).rejects.toThrow('read failed');
    await queue.request({ kind: 'previous' }); expect(calls).toBe(2);
  });
});
