import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalOutputProjection } from '../output.js';
import type { ConversationOutputSource } from '../../runtime/conversation-output.js';
import type { AgentYield } from '@zhixing/core/loop';
const source = { conversationId: 'synthetic', turnId: 'turn', kind: 'delta' } as ConversationOutputSource;
afterEach(() => vi.useRealTimers());

describe('terminal output projection', () => {
  it.each([false, true])('resets output offsets only after actual append and while the captured generation is current (%s)', async current => {
    vi.useFakeTimers(); let appendDone!: () => void;
    const append = vi.fn(async () => { if (append.mock.calls.length === 1) await new Promise<void>(resolve => { appendDone = resolve; }); });
    const projection = new TerminalOutputProjection(append, async () => {}, async () => {});
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
    const projection = new TerminalOutputProjection(() => new Promise<void>(resolve => { appendDone = resolve; }), async () => {}, async () => {});
    projection.accept({ type: 'text_delta', text: 'recovered' }, source);
    let settled = false; const drain = projection.drain().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(50); expect(settled).toBe(false);
    appendDone(); await drain; expect(settled).toBe(true); await projection.close();
    let gapDone!: () => void;
    const failed = new TerminalOutputProjection(async () => { throw Error('disk-full'); }, async () => {}, () => new Promise<void>(resolve => { gapDone = resolve; }));
    failed.accept({ type: 'text_delta', text: 'retained authority body' }, source);
    settled = false; const gap = failed.drain().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(50); expect(settled).toBe(false);
    gapDone(); await gap; expect(settled).toBe(true); await failed.close();
  });
  it('holds output until the accepted input is cached, then emits the missing final tail once', async () => {
    vi.useFakeTimers();
    const text: string[] = [], gap = vi.fn(async () => {});
    const projection = new TerminalOutputProjection(async part => { text.push(part.text); }, async () => {}, gap);
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
    const projection = new TerminalOutputProjection(append, async () => {}, gap);
    expect(projection.accept({ type: 'text_delta', text: 'partial' } as AgentYield, source)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50);
    projection.accept({ type: 'text_delta', text: 'later' } as AgentYield, source); await vi.advanceTimersByTimeAsync(50);
    expect(append).toHaveBeenCalledOnce(); expect(gap).toHaveBeenCalledOnce(); expect(projection.paused).toBe(true); await projection.close();
  });
  it('accounts normalized UTF-8 at admission and stops a large producer without retaining its whole event', async () => {
    const gap = vi.fn(async () => {}), projection = new TerminalOutputProjection(async () => {}, async () => {}, gap);
    const release = projection.hold();
    projection.accept({ type: 'text_delta', text: '汉'.repeat(400000) } as AgentYield, source);
    expect(gap).toHaveBeenCalledOnce(); release(); await projection.close();
  });
});
