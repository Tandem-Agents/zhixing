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
