import { describe, expect, it, vi } from 'vitest';
import { TerminalCandidateSession } from './candidate-session.js';
import type { TerminalInputSession } from './input-session.js';

function input(text: string) {
  const draft = { text, cursor: text.length, version: 1 };
  const clear = vi.fn(() => { draft.text = ''; draft.cursor = 0; draft.version += 1; });
  return { draft, clear, candidate: vi.fn(), windowStart: 0 } as unknown as TerminalInputSession & { clear: typeof clear };
}

async function opened(text: string, mode: 'prompt' | 'management' = 'prompt') {
  const session = input(text);
  // 管理面板在查询为空时区间为空（光标处）；普通命令候选替换斜杠后的词
  const request = vi.fn(async () => ({ revision: 1, start: mode === 'management' ? text.length : 1, end: text.length, mode,
    items: [{ id: 'quit', label: '/quit', description: '退出' }] }));
  const candidates = new TerminalCandidateSession(session, request as never, () => {});
  candidates.sync(true);
  await vi.waitFor(() => expect(candidates.value?.items.length ?? -1).toBeGreaterThanOrEqual(0));
  return { session, candidates };
}

describe('TerminalCandidateSession escape', () => {
  it('collapses ordinary candidates without touching the draft, and stays collapsed until the draft changes', async () => {
    const { session, candidates } = await opened('/qu');
    candidates.escape();
    expect(session.clear).not.toHaveBeenCalled();
    expect(session.candidate).not.toHaveBeenCalled();
    expect(session.draft.text).toBe('/qu');
    expect(candidates.open).toBe(false);
    candidates.sync(true);
    expect(candidates.open).toBe(false);
  });

  it('returns from the /trust management view to an empty main input', async () => {
    const { session, candidates } = await opened('/trust ', 'management');
    candidates.escape();
    expect(session.clear).toHaveBeenCalledOnce();
    expect(candidates.open).toBe(false);
  });
});

describe('TerminalCandidateSession accept cancellation', () => {
  // 候选查询立即应答；接纳的应答由用例逐个放行
  function pendingAccepts(text: string) {
    const session = input(text), replies: ((value: unknown) => void)[] = [], failures: ((error: unknown) => void)[] = [];
    const request = vi.fn(async (action: { kind: string; revision?: number }) => action.kind === 'input-candidates'
      ? { revision: action.revision, start: 1, end: text.length, items: [{ id: 'quit', label: '/quit' }] }
      : new Promise((resolve, reject) => { replies.push(resolve); failures.push(reject); }));
    const candidates = new TerminalCandidateSession(session, request as never, () => {});
    const query = async () => { candidates.sync(true); await vi.waitFor(() => expect(candidates.value?.items.length).toBe(1)); };
    return { session, candidates, replies, failures, query };
  }

  it('a cancelled accept leaves the draft alone and never executes, and a new accept can start at once', async () => {
    const f = pendingAccepts('/qu'); await f.query();
    const first = f.candidates.accept();
    f.candidates.cancelAccept();
    await f.query();
    const second = f.candidates.accept();
    expect(f.replies).toHaveLength(2);
    f.replies[0]!({ text: 'quit', execute: true });
    expect(await first).toBe(false);
    expect(f.session.candidate).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'quit' }), undefined);
    f.replies[1]!({ text: 'quit', execute: true });
    expect(await second).toBe(true);
  });

  it('leaving the main input cancels an in-flight accept, even after coming back to the same draft', async () => {
    const f = pendingAccepts('/qu'); await f.query();
    const accept = f.candidates.accept();
    f.candidates.sync(false); f.candidates.sync(true);
    f.replies[0]!({ text: 'quit', execute: true });
    expect(await accept).toBe(false);
    expect(f.session.candidate).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'quit' }), undefined);
  });

  it('a cancelled accept that fails reports nothing', async () => {
    const f = pendingAccepts('/qu'); await f.query();
    const accept = f.candidates.accept();
    f.candidates.cancelAccept();
    f.failures[0]!(Error('late failure'));
    await expect(accept).resolves.toBe(false);
  });
});
