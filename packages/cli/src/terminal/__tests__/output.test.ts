import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalOutputProjection, type TerminalOutputBody } from '../output.js';
import type { ConversationOutputSource } from '../../runtime/conversation-output.js';
import type { AgentYield } from '@zhixing/core/loop';
const source = { conversationId: 'synthetic', turnId: 'turn', kind: 'delta' } as ConversationOutputSource;
const body: TerminalOutputBody = { work: action => action(), amend: async () => {}, seal: async () => {} };
afterEach(() => vi.useRealTimers());

describe('terminal output projection', () => {
  it('waits for logical EOF amendment and sealing before the completion drain resolves', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const seal = vi.fn(async () => {}), gap = vi.fn(async () => {});
    let latest: import('@zhixing/terminal-ui/protocol').TerminalDisplaySegment | undefined;
    const projection = new TerminalOutputProjection(async segment => { latest = segment; }, async () => {}, gap, {
      work: action => action(), seal,
      amend: async (_block, change) => {
        const next = change.project(latest!.contentOffset, latest!.text.length, latest!.body);
        if (next.end) await new Promise<void>(resolve => { release = resolve; });
        latest = { ...latest!, body: next, final: next.end };
      },
    });
    projection.accept({ type: 'text_delta', text: '**retained' }, source);
    await vi.advanceTimersByTimeAsync(50);
    expect(latest?.body?.end).toBe(false);
    projection.end(source.conversationId, source.turnId, source.runId);
    let complete = false; const done = projection.drain().then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(50);
    expect(complete).toBe(false); expect(seal).not.toHaveBeenCalled();
    release(); await done;
    expect(latest?.body?.end).toBe(true); expect(latest?.text).toBe('**retained');
    expect(seal).toHaveBeenCalledOnce(); expect(gap).not.toHaveBeenCalled(); await projection.close();
  });

  it.each([false, true])('resets output offsets only after actual append and while the captured generation is current (%s)', async current => {
    vi.useFakeTimers(); let appendDone!: () => void;
    const append = vi.fn(async () => { if (append.mock.calls.length === 1) await new Promise<void>(resolve => { appendDone = resolve; }); });
    const projection = new TerminalOutputProjection(append, async () => {}, async () => {}, body);
    projection.accept({ type: 'text_delta', text: 'old' }, source);
    let settled = false; const reset = projection.reset(() => current).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(50); expect(settled).toBe(false);
    appendDone(); await reset;
    projection.accept({ type: 'text_delta', text: 'new' }, source);
    await vi.advanceTimersByTimeAsync(50);
    expect(append).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: 'new', contentOffset: current ? 0 : 3 }));
    await projection.close();
  });
  it('keeps a recovery drain pending until actual append or explicit gap presentation completes', async () => {
    vi.useFakeTimers();
    let appendDone!: () => void;
    const projection = new TerminalOutputProjection(() => new Promise<void>(resolve => { appendDone = resolve; }), async () => {}, async () => {}, body);
    projection.accept({ type: 'text_delta', text: 'recovered' }, source);
    let settled = false; const drain = projection.drain().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(50); expect(settled).toBe(false);
    appendDone(); await drain; expect(settled).toBe(true); await projection.close();
    let gapDone!: () => void;
    const failed = new TerminalOutputProjection(async () => { throw Error('disk-full'); }, async () => {}, () => new Promise<void>(resolve => { gapDone = resolve; }), body);
    failed.accept({ type: 'text_delta', text: 'retained authority body' }, source);
    settled = false; const gap = failed.drain().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(50); expect(settled).toBe(false);
    gapDone(); await gap; expect(settled).toBe(true); await failed.close();
  });
  it('holds output until the accepted input is cached, then emits the missing final tail once', async () => {
    vi.useFakeTimers();
    const text: string[] = [], gap = vi.fn(async () => {});
    const projection = new TerminalOutputProjection(async part => { text.push(part.text); }, async () => {}, gap, body);
    const release = projection.hold();
    projection.accept({ type: 'text_delta', text: '中文 🦞 ' } as AgentYield, source);
    projection.accept({ type: 'assistant_message', message: { role: 'assistant', content: [{ type: 'text', text: '中文 🦞 完成' }] } } as AgentYield, source);
    await vi.advanceTimersByTimeAsync(50); expect(text).toEqual([]);
    release(); release(); await vi.advanceTimersByTimeAsync(50);
    expect(text.join('')).toBe('中文 🦞 完成'); expect(gap).not.toHaveBeenCalled(); await projection.close();
  });
  it('seals a failed output consumer once while the producer remains synchronous and cancellable', async () => {
    vi.useFakeTimers();
    const append = vi.fn(async () => { throw Error('own disk failure'); }), gap = vi.fn(async () => {});
    const projection = new TerminalOutputProjection(append, async () => {}, gap, body);
    expect(projection.accept({ type: 'text_delta', text: 'partial' } as AgentYield, source)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50);
    projection.accept({ type: 'text_delta', text: 'later' } as AgentYield, source); await vi.advanceTimersByTimeAsync(50);
    expect(append).toHaveBeenCalledOnce(); expect(gap).toHaveBeenCalledOnce(); expect(projection.paused).toBe(true); await projection.close();
  });
  it('accounts normalized UTF-8 at admission and stops a large producer without retaining its whole event', async () => {
    const gap = vi.fn(async () => {}), projection = new TerminalOutputProjection(async () => {}, async () => {}, gap, body);
    const release = projection.hold();
    projection.accept({ type: 'text_delta', text: '汉'.repeat(400000) } as AgentYield, source);
    expect(gap).toHaveBeenCalledOnce(); release(); await projection.close();
  });
});
