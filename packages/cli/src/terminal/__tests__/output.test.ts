import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalOutputProjection, type TerminalOutputBody } from '../output.js';
import { processArtifactText, processArtifactLines, processArtifactSpans } from '../process-presentation.js';
import type { ConversationOutputSource } from '../../runtime/conversation-output.js';
import type { AgentYield } from '@zhixing/core/loop';
import { bodyPageSegments, decodeBodyPage, encodeBodyPage, type BodySegment } from '@zhixing/terminal-ui/body-model';
const source = { conversationId: 'synthetic', turnId: 'turn', kind: 'delta' } as ConversationOutputSource;
const body: TerminalOutputBody = { last: 0, work: action => action(), amend: async () => {}, seal: async () => {} };
afterEach(() => vi.useRealTimers());

describe('terminal output projection', () => {
  it('acknowledges a recovered live delta after publication without waiting for its future block-end', async () => {
    vi.useFakeTimers();
    const append = vi.fn(async () => {}), updated = vi.fn(async () => {});
    const projection = new TerminalOutputProjection(append, updated, async () => {}, body);
    projection.updateThinking({ blockId: 'recovered', role: 'thinking', text: 'live' }, 0, false);
    let finished = false; const drain = projection.drain().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(45); await drain;
    expect(finished).toBe(true); expect(append).not.toHaveBeenCalled(); expect(updated).toHaveBeenCalledOnce();
    projection.updateThinking({ blockId: 'recovered', role: 'thinking', text: 'live end' }, 0, true);
    const final = projection.drain(); await vi.advanceTimersByTimeAsync(45); await final;
    expect(append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'live end', final: true }), true);
    await projection.close();
  });
  it('publishes live thinking in queue order and replaces it only after final append acknowledgement', async () => {
    vi.useFakeTimers();
    const segments: import('@zhixing/terminal-ui/body-model').BodySegment[] = [];
    let acknowledge: (() => void) | undefined;
    const projection = new TerminalOutputProjection(async segment => {
      await new Promise<void>(resolve => { acknowledge = resolve; }); segments.push(segment);
    }, async () => {}, async () => {}, body);
    const page = () => ({ first: 0, last: segments.length, start: 0, follow: true, segments: [...segments] });
    projection.updateThinking({ blockId: 'thinking', role: 'thinking', text: 'first' }, 90, false);
    await vi.advanceTimersByTimeAsync(45);
    expect(segments).toHaveLength(0);
    expect(projection.projectPage(page()).transient).toMatchObject({ blockId: 'thinking', text: 'first', contentOffset: 90 });
    projection.updateThinking({ blockId: 'thinking', role: 'thinking', text: 'last' }, 96, true);
    projection.updateThinking({ blockId: 'thinking-2', role: 'thinking', text: 'next' }, 0, false);
    await vi.advanceTimersByTimeAsync(45);
    expect(projection.projectPage(page()).transient?.text).toBe('last');
    acknowledge!(); await vi.advanceTimersByTimeAsync(45);
    const next = projection.projectPage(page());
    expect(next.segments[0]).toMatchObject({ blockId: 'thinking', text: 'last', contentOffset: 96, final: true });
    expect(next.transient?.blockId).toBe('thinking-2');
    const offPage = projection.projectPage({ first: 0, last: 10, start: 0, follow: false, segments: [segments[0]!] });
    expect(offPage.transient).toBeUndefined();
    await projection.close();
  });
  it('retains a bounded failed thinking tail without pretending append succeeded', async () => {
    vi.useFakeTimers();
    const gap = vi.fn(async () => {});
    const projection = new TerminalOutputProjection(async () => { throw Error('disk'); }, async () => {}, gap, body);
    projection.updateThinking({ blockId: 'thinking', role: 'thinking', text: 'retained' }, 8, true);
    await vi.advanceTimersByTimeAsync(50);
    expect(projection.paused).toBe(true); expect(gap).toHaveBeenCalledOnce();
    expect(projection.projectPage({ first: 0, last: 0, start: 0, follow: true, segments: [] }).interrupted?.[0]?.segment.text).toBe('retained');
    await projection.close();
  });
  it('keeps an interrupted tail before new output through recovery instead of moving it to the latest message', async () => {
    vi.useFakeTimers(); let fail = true;
    const segments: import('@zhixing/terminal-ui/body-model').BodySegment[] = [];
    const projection = new TerminalOutputProjection(async segment => { if (fail) throw Error('disk'); segments.push(segment); }, async () => {}, async () => {}, body);
    const page = () => ({ first: 0, last: segments.length, start: 0, follow: true, segments: [...segments] });
    projection.updateThinking({ blockId: 'thinking', role: 'thinking', text: 'interrupted' }, 10, true);
    await vi.advanceTimersByTimeAsync(50);
    expect(projection.projectPage(page()).interrupted?.[0]?.before).toBe(0);
    fail = false; projection.resume();
    projection.appendProcessBlock({ blockId: 'later', role: 'process', text: 'after recovery' });
    const done = projection.drain(); await vi.advanceTimersByTimeAsync(50); await done;
    projection.updateThinking({ blockId: 'next-thinking', role: 'thinking', text: 'next' }, 0, false);
    await vi.advanceTimersByTimeAsync(50);
    const result = projection.projectPage(page());
    expect(result.interrupted).toMatchObject([{ before: 0, segment: { text: 'interrupted' } }]);
    expect(result.interrupted![0]!.segment.blockId).not.toBe('thinking');
    expect(result.segments.map(segment => segment.text)).toEqual(['after recovery']);
    expect(result.transient?.text).toBe('next');
    await projection.close();
  });
  it('retires a paused in-flight thinking overlay when that actual append succeeds', async () => {
    vi.useFakeTimers(); let acknowledge!: () => void;
    const projection = new TerminalOutputProjection(() => new Promise<void>(resolve => { acknowledge = resolve; }), async () => {}, async () => {}, body);
    projection.updateThinking({ blockId: 'thinking', role: 'thinking', text: 'retained' }, 0, true);
    await vi.advanceTimersByTimeAsync(50); projection.pause();
    acknowledge(); await projection.settlePaused();
    expect(projection.projectPage({ first: 0, last: 0, start: 0, follow: true, segments: [] }).interrupted).toBeUndefined();
    await projection.close();
  });
  it('retains successive failed tails at their actual boundaries even without an intervening page read', async () => {
    vi.useFakeTimers(); let fail = true;
    const segments: BodySegment[] = [], gap = vi.fn(async () => {});
    const projection = new TerminalOutputProjection(async segment => { if (fail) throw Error('disk'); segments.push(segment); },
      async () => {}, gap, { ...body, get last() { return segments.length; } });
    const page = (start = 0, follow = false) => projection.projectPage({ first: 0, last: segments.length, start, follow, segments: segments.slice(start, start + 4) });
    try {
      for (let i = 0; i < 3; i++) {
        if (i) {
          projection.resume(); fail = false;
          projection.appendProcessBlock({ blockId: `middle-${i}`, role: 'process', text: `middle-${i}` });
          await vi.advanceTimersByTimeAsync(50);
        }
        fail = true;
        projection.updateThinking({ blockId: `thinking-${i}`, role: 'thinking', text: `failed-${i}` }, i * 10, true);
        await vi.advanceTimersByTimeAsync(50); expect(projection.paused).toBe(true);
      }
      // The first page read happens AFTER all three failures; it cannot move
      // older tails to the boundary of the latest failure.
      const first = decodeBodyPage(encodeBodyPage(page(), 1)).page;
      expect(bodyPageSegments(first).map(segment => segment.text)).toEqual(['failed-0', 'middle-1', 'failed-1']);
      const second = decodeBodyPage(encodeBodyPage(page(1), 2)).page;
      expect(bodyPageSegments(second).map(segment => segment.text)).toEqual(['failed-1', 'middle-2', 'failed-2']);
      projection.resume();
      projection.updateThinking({ blockId: 'overflow', role: 'thinking', text: 'never admitted' }, 0, false);
      expect(projection.paused).toBe(true);
      expect(gap).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'terminal-output-retained-capacity' }));
      expect(bodyPageSegments(page()).map(segment => segment.text)).toContain('failed-0');
      expect(bodyPageSegments(page(1)).map(segment => segment.text)).toContain('failed-2');
      await projection.reset(() => true); expect(page().interrupted).toBeUndefined();
    } finally { await projection.close(); }
  });
  it('does not retire a retained tail when pause skips a queued physical append', async () => {
    vi.useFakeTimers(); let release!: () => void;
    const append = vi.fn(async () => {});
    const projection = new TerminalOutputProjection(append, async () => {}, async () => {}, { ...body,
      work: async action => { await new Promise<void>(resolve => { release = resolve; }); await action(); } });
    projection.updateThinking({ blockId: 'held', role: 'thinking', text: 'visible' }, 0, true);
    await vi.advanceTimersByTimeAsync(50); projection.pause(); release(); await projection.settlePaused();
    expect(append).not.toHaveBeenCalled();
    expect(projection.projectPage({ first: 0, last: 0, start: 0, follow: true, segments: [] }).interrupted?.[0]?.segment.text).toBe('visible');
    await projection.close();
  });
  it.each([
    ['trailing', ['alpha();', '']], ['only', ['']], ['two', ['', '']],
    ['middle', ['alpha();', '', 'omega();']], ['fragmented', ['界'.repeat(12000), '']],
  ] as [string, string[]][])('preserves real blank diff rows at EOF and fragment boundaries: %s', async (_name, contents) => {
    const segments: import('@zhixing/terminal-ui/protocol').TerminalDisplaySegment[] = [], gap = vi.fn();
    const projection = new TerminalOutputProjection(async segment => { segments.push(segment); }, async () => {}, gap, body);
    const artifact = { kind: 'file-diff' as const, path: 'blank.ts', operation: 'modified' as const,
      changeStats: { kind: 'exact' as const, addedLines: contents.length, removedLines: 0 },
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: contents.length,
        lines: contents.map((content, index) => ({ type: 'added' as const, newLineNumber: index + 1, content })) }] };
    const text = processArtifactText(artifact);
    try {
      projection.appendProcessBlock({ blockId: 'blank-diff', role: 'tool-diff', text, spans: processArtifactSpans(artifact), lines: processArtifactLines(artifact) });
      await projection.drain();
      expect(gap).not.toHaveBeenCalled();
      expect(segments.map(segment => segment.text).join('')).toBe(text);
      const rows = new Map<number, string>();
      for (const segment of segments) for (const node of segment.body!.context.nodes) if (node.decoration) {
        rows.set(node.origin!, (rows.get(node.origin!) ?? '') + node.runs.map(run => run.text).join(''));
        if (node.from === node.to) expect(segment.final).toBe(true);
      }
      expect([...rows.values()]).toEqual(contents);
    } finally { await projection.close(); }
  });
  it('keeps structured diff gutters out of source across Unicode fragment boundaries', async () => {
    vi.useFakeTimers();
    const segments: import('@zhixing/terminal-ui/protocol').TerminalDisplaySegment[] = [];
    const gap = vi.fn();
    const projection = new TerminalOutputProjection(async segment => { segments.push(segment); }, async () => {}, gap, body);
    const code = 'const 中文 = "🙂";'.repeat(2600);
    const artifact = { kind: 'file-diff' as const, path: 'a.ts', operation: 'modified' as const,
      changeStats: { kind: 'exact' as const, addedLines: 1, removedLines: 1 },
      hunks: [{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 1, lines: [
        { type: 'removed' as const, oldLineNumber: 12, content: 'old' },
        { type: 'added' as const, newLineNumber: 12, content: code }] }] };
    const text = processArtifactText(artifact);
    projection.appendProcessBlock({ blockId: 'diff', role: 'tool-diff', text, spans: processArtifactSpans(artifact), lines: processArtifactLines(artifact) });
    await vi.advanceTimersByTimeAsync(200);
    expect(gap).not.toHaveBeenCalled();
    expect(segments.map(s => s.text).join('')).toBe(text);
    const nodes = segments.flatMap(s => s.body!.context.nodes);
    expect(nodes.filter(n => n.decoration?.startsWith('+')).map(n => n.runs.map(r => r.text).join('')).join('')).toBe(code);
    expect(nodes.filter(n => n.decoration?.startsWith('-')).map(n => n.runs.map(r => r.text).join('')).join('')).toBe('old');
    expect(text).not.toContain('+ 12  ');
    expect(new Set(nodes.filter(n => n.decoration?.startsWith('+')).map(n => n.origin)).size).toBe(1);
    await projection.close();
  });
  it('yields between finite batches without adding a coalescing delay to a backlog', async () => {
    vi.useFakeTimers();
    const append = vi.fn(async () => {}), published: number[] = [];
    const updated = vi.fn(async () => { published.push(append.mock.calls.length); });
    const projection = new TerminalOutputProjection(append, updated, async () => {}, body);
    for (let i = 0; i < 12; i++) projection.appendProcessBlock({ blockId: `notice-${i}`, role: 'process', text: `${i}` });
    await vi.advanceTimersByTimeAsync(39); expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(append).toHaveBeenCalledTimes(12);
    expect(published).toEqual([4, 12]); // All text retained; final frame cannot be skipped.
    await projection.drain(); await projection.close();
  });
  it('retains completed process text once as immutable plain fragments with exact source offsets', async () => {
    vi.useFakeTimers();
    const text = '**literal** 中文🙂\r\n'.repeat(1800);
    const parts: import('@zhixing/terminal-ui/protocol').TerminalDisplaySegment[] = [];
    const amend = vi.fn(), seal = vi.fn(), gap = vi.fn(async () => {});
    const projection = new TerminalOutputProjection(async part => { parts.push(part); }, async () => {}, gap,
      { work: action => action(), amend, seal });
    projection.appendProcessBlock({ blockId: 'notice', role: 'process', text });
    const done = projection.drain(); await vi.runAllTimersAsync(); await done;
    expect(parts.map(part => part.text).join('')).toBe(text);
    let offset = 0;
    for (const [index, part] of parts.entries()) {
      expect(part).toMatchObject({ blockId: 'notice', role: 'process', contentOffset: offset, final: index === parts.length - 1 });
      expect(part.body?.kind).toBe('plain'); expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(32 * 1024);
      offset += part.text.length;
    }
    expect(amend).not.toHaveBeenCalled(); expect(seal).not.toHaveBeenCalled(); expect(gap).not.toHaveBeenCalled();
    await projection.close();
  });
  it('preserves the first display failure for observation without retrying or blocking the producer', async () => {
    vi.useFakeTimers();
    const error = Object.assign(Error('synthetic IO failure'), { code: 'ENOSPC' });
    const gap = vi.fn(async (_error?: unknown) => {}), append = vi.fn(async () => { throw error; });
    const projection = new TerminalOutputProjection(append, async () => {}, gap, body);
    projection.accept({ type: 'text_delta', text: 'first' }, source);
    await vi.advanceTimersByTimeAsync(60);
    expect(projection.paused).toBe(true); expect(gap).toHaveBeenCalledExactlyOnceWith(error);
    projection.accept({ type: 'text_delta', text: 'later' }, source);
    await projection.drain(); expect(append).toHaveBeenCalledTimes(1);
    await projection.close();
  });
  it('waits for the old physical append before resuming with distinct retained block identities', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const parts: import('@zhixing/terminal-ui/protocol').TerminalDisplaySegment[] = [];
    const projection = new TerminalOutputProjection(async segment => {
      if (!parts.length) await new Promise<void>(resolve => { finish = resolve; });
      parts.push(segment);
    }, async () => {}, async () => {}, body);
    projection.accept({ type: 'text_delta', text: 'retained prefix' }, source);
    await vi.advanceTimersByTimeAsync(50);
    projection.pause();
    expect(() => projection.resume()).toThrow('terminal-output-recovery-unavailable');
    let settled = false;
    const pending = projection.settlePaused().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    finish(); await pending;
    projection.resume();
    projection.accept({ type: 'text_delta', text: 'new content' }, source);
    await vi.advanceTimersByTimeAsync(50);
    expect(parts.map(part => part.text)).toEqual(['retained prefix', 'new content']);
    expect(parts[1]!.blockId).not.toBe(parts[0]!.blockId);
    expect(parts[1]!.contentOffset).toBe(0);
    await projection.close();
  });
  it('shares the actual run block across assignment-only identity, recovered turn identity and end', async () => {
    vi.useFakeTimers();
    const parts: import('@zhixing/terminal-ui/protocol').TerminalDisplaySegment[] = [], seal = vi.fn(async () => {});
    const projection = new TerminalOutputProjection(async segment => { parts.push(segment); }, async () => {}, async () => {}, { ...body, seal });
    const live: ConversationOutputSource = { conversationId: 'c', runId: 'r', kind: 'stream', frame: {
      v: 1, ref: { execution: 'conversation', conversationId: 'c', runId: 'r', ownerEpoch: 0 },
      assignmentId: 'a', streamEpoch: 1, seq: 1, payload: { kind: 'agent-yield', yield: { type: 'text_delta', text: 'live' } }, meta: {},
    } };
    const recovered: ConversationOutputSource = { conversationId: 'c', turnId: 'actual-turn', runId: 'r', kind: 'history',
      final: { v: 1, conversationId: 'c', runId: 'r', commitRevision: 1, digest: `sha256:${'a'.repeat(64)}` } };
    projection.accept({ type: 'text_delta', text: 'live' }, live); await vi.advanceTimersByTimeAsync(50);
    projection.accept({ type: 'text_delta', text: ' tail' }, recovered);
    projection.end('c', 'actual-turn', 'r'); await vi.advanceTimersByTimeAsync(100);
    expect(parts.map(part => part.text).join('')).toBe('live tail');
    expect(new Set(parts.map(part => part.blockId))).toEqual(new Set(['live:c:r:0']));
    expect(parts.at(-1)?.contentOffset).toBe(4); expect(seal).toHaveBeenCalledWith('live:c:r:0');
    await projection.close();
  });
  it('uses the existing body queue for immutable process blocks, with one tool display owner', async () => {
    vi.useFakeTimers();
    const segments: import('@zhixing/terminal-ui/protocol').TerminalDisplaySegment[] = [];
    const seal = vi.fn(async () => {}), accept = vi.fn();
    const projection = new TerminalOutputProjection(async segment => { segments.push(segment); }, async () => {}, async () => {},
      { ...body, seal }, { accept });
    projection.accept({ type: 'tool_start', id: 't', name: 'edit', input: {} }, source);
    projection.accept({ type: 'tool_end', id: 't', name: 'edit', duration: 1, result: { content: 'modified' } }, source);
    projection.appendProcessBlock({ blockId: 'process:actual-tool', role: 'tool-diff', text: '◆ 已修改 a.ts\n+ 1  actual' });
    await vi.advanceTimersByTimeAsync(100);
    expect(accept).toHaveBeenCalledTimes(2);
    expect(segments.map(segment => segment.text).join('')).toBe('◆ 已修改 a.ts\n+ 1  actual');
    expect(segments.every(segment => segment.role === 'tool-diff' && segment.body?.kind === 'plain')).toBe(true);
    expect(segments.at(-1)?.final).toBe(true);
    expect(seal).not.toHaveBeenCalled();
    projection.end(source.conversationId, source.turnId, source.runId);
    await projection.close();
  });
  it('waits for logical EOF amendment and sealing before the completion drain resolves', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const seal = vi.fn(async () => {}), gap = vi.fn(async () => {});
    let latest: import('@zhixing/terminal-ui/protocol').TerminalDisplaySegment | undefined;
    const projection = new TerminalOutputProjection(async segment => { latest = segment; }, async () => {}, gap, {
      last: 0, work: action => action(), seal,
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
    expect(append).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: 'new', contentOffset: current ? 0 : 3 }), false);
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
    projection.accept({ type: 'text_delta', text: '汉'.repeat(2000000) } as AgentYield, source);
    expect(gap).toHaveBeenCalledOnce(); release(); await projection.close();
  });
});
