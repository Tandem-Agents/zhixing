import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Exercise the production history owner. Only its RPC and confirmed display
// ports are replaced; parsing, page progression and publication order are real.
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === '#onlineHistoryPage');
if (!method) throw Error('Missing production online history method');
const Fixture = new Function('observeStartupPhase', ts.transpile(`class Fixture {
  abort = new AbortController(); mainView = { readyForInput: false }; logging = { records: undefined };
  historyParser = { close() {} }; bodyWork = { run: work => work() };
  displayed = 0; published = 0;
  async displayPage() { this.displayed++; }
  async publishHistoryView() { this.published++; }
  ${method.getText(source).replace(/#/gu, '')}
} return Fixture;`, { target: ts.ScriptTarget.ES2022 }))((_records: unknown, _phase: string, work: () => Promise<unknown>) => work());

function fixture() {
  const target = new Fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const history = { conversationId: 'current', hasMore: true, offline: false };
  const fragments = Array.from({ length: 4 }, (_, index) => ({ runId: `run-${index}`, message: index, block: 0,
    role: 'user', type: 'text', text: `message-${index}`, length: 9, offset: 0, final: true,
    cursor: { conversationId: 'current', ownerEpoch: 1, revision: 1, message: index, block: 0, offset: 0 } }));
  target.history = history;
  target.conversation = { bodyPage: vi.fn(async () => ({ fragments, hasMore: false })) };
  const stored: string[] = [];
  target.display = { first: 0, last: 0,
    append: vi.fn(async (segment: { text: string }) => { stored.push(segment.text); }),
    appendInitialHistory: vi.fn(async (items: { segment: { text: string } }[], current: () => boolean, committed: (index: number) => void) => {
      entered.resolve(); await release.promise;
      if (!current()) return false;
      for (const [index, item] of items.entries()) { stored.push(item.segment.text); committed(index); }
      return true;
    }) };
  return { target, history, fragments, stored, entered, release };
}

describe('initial history cursor follows confirmed display', () => {
  it('keeps the cursor and page unpublished until the batch is confirmed', async () => {
    const h = fixture(), work = h.target.onlineHistoryPage(h.history);
    await h.entered.promise;
    expect(h.history).toEqual({ conversationId: 'current', hasMore: true, offline: false });
    expect(h.target.displayed).toBe(0); expect(h.target.published).toBe(0);
    expect(h.target.mainView.readyForInput).toBe(false);
    h.release.resolve(); await work;
    expect(h.history).toMatchObject({ hasMore: false, bodyCursor: { message: 3, offset: 0 } });
    expect(h.stored).toEqual(h.fragments.map(fragment => fragment.text));
    expect(h.target.conversation.bodyPage).toHaveBeenCalledTimes(1);
    expect(h.target.display.append).not.toHaveBeenCalled(); expect(h.target.displayed).toBe(1);
  });

  it('leaves the original page available after an unconfirmed batch failure', async () => {
    const h = fixture(); h.target.display.appendInitialHistory.mockRejectedValueOnce(Error('unknown IO'));
    await expect(h.target.onlineHistoryPage(h.history)).rejects.toThrow('unknown IO');
    expect(h.history).toEqual({ conversationId: 'current', hasMore: true, offline: false });
    expect(h.target.displayed).toBe(0); expect(h.target.published).toBe(0);
  });

  it('never installs an old page or its cursor after the conversation epoch changes', async () => {
    const h = fixture(), work = h.target.onlineHistoryPage(h.history);
    await h.entered.promise;
    const next = { conversationId: 'next', hasMore: true, offline: false }; h.target.history = next;
    h.release.resolve(); await work;
    expect(h.history).toEqual({ conversationId: 'current', hasMore: true, offline: false });
    expect(h.target.history).toBe(next); expect(h.target.displayed).toBe(0); expect(h.stored).toEqual([]);
  });

  it('does not declare a reset display to contain a page that was not published', async () => {
    const h = fixture(); h.target.display.appendInitialHistory.mockResolvedValueOnce(false);
    await expect(h.target.onlineHistoryPage(h.history)).rejects.toThrow('generation-changed');
    expect(h.history).toEqual({ conversationId: 'current', hasMore: true, offline: false });
    expect(h.target.displayed).toBe(0);
  });

  it('resumes exactly after a confirmed fallback prefix without skipping or duplicating a fragment', async () => {
    const h = fixture();
    h.target.display.appendInitialHistory.mockImplementationOnce(async (items: { segment: { text: string } }[], _current: () => boolean, committed: (index: number) => void) => {
      h.stored.push(items[0]!.segment.text); h.target.display.first = -1; committed(0); throw Error('fallback partial');
    });
    await expect(h.target.onlineHistoryPage(h.history)).rejects.toThrow('fallback partial');
    expect(h.history).toMatchObject({ hasMore: true, bodyCursor: { message: 0 }, buffered: { fragments: h.fragments.slice(1) } });
    await h.target.onlineHistoryPage(h.history);
    expect(h.stored).toEqual(h.fragments.map(fragment => fragment.text));
    expect(h.target.display.append).toHaveBeenCalledTimes(3); expect(h.target.conversation.bodyPage).toHaveBeenCalledTimes(1);
    expect(h.history).toMatchObject({ hasMore: false });
  });

  it('publishes an empty history without allocating or advancing a display batch', async () => {
    const h = fixture(); h.target.conversation.bodyPage.mockResolvedValueOnce({ fragments: [], hasMore: false });
    await h.target.onlineHistoryPage(h.history);
    expect(h.history).toMatchObject({ hasMore: false }); expect(h.target.display.appendInitialHistory).not.toHaveBeenCalled();
    expect(h.target.displayed).toBe(1);
  });
});
