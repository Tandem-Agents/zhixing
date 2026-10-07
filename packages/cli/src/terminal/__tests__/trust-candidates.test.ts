import { describe, expect, it, vi } from 'vitest';
import { ArgumentProvider, DefaultCommandRegistry, type RuntimeContext, type SuggestionItem } from '@zhixing/core/typeahead';
import type { TrustAdministrationRule } from '@zhixing/core/trust-administration';
import { TerminalTrustCandidates, type TerminalTrustController } from '../trust-candidates.js';

const runtime: RuntimeContext = { sessionBusy: false, workspaceId: null, cwd: '/tmp', target: 'cli', features: {}, now: 0 };
const rule = (id: string): TrustAdministrationRule => ({ id, pattern: { tool: 'bash', argument: `ls ${id}` }, decision: 'allow',
  scope: 'context', contextId: { kind: 'main' }, createdAt: 0, lastMatchedAt: 0, matchCount: 0 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(rules = [rule('rule-1'), rule('rule-2')]) {
  const controller = { current: { conversationId: 'conv-1' } };
  let current: TerminalTrustController | undefined = controller;
  const management = { trustList: vi.fn(async () => rules), trustRevoke: vi.fn(async () => true) };
  const abort = new AbortController();
  const binding = new TerminalTrustCandidates({ controller: () => current, management, signal: abort.signal });
  const registry = new DefaultCommandRegistry(); registry.register(binding.command);
  const provider = new ArgumentProvider({ registry });
  const match = (query = '') => {
    const draft = `/trust ${query}`, result = provider.matchTrigger({ draft, cursor: Array.from(draft).length, mode: 'prompt', runtime });
    if (!result) throw Error('trust argument trigger missing');
    return result;
  };
  const query = async (text = '', signal = new AbortController().signal): Promise<SuggestionItem[]> => provider.query(match(text), signal);
  return { controller, management, abort, binding, registry, provider, match, query,
    replace(value: TerminalTrustController | undefined) { current = value; } };
}

describe('terminal trust candidates', () => {
  it('uses the real argument provider and shared authority scope wording in management mode', async () => {
    const f = fixture([rule('main'), { ...rule('global'), scope: 'global', contributors: [{ origin: 'user', timestamp: 0 }] },
      { ...rule('scene'), contextId: { kind: 'scene', sceneId: 'scene-1' } }]);
    const items = await f.query();
    expect(f.provider.computePanelMode(f.match())).toBe('management');
    expect(f.provider.computeInlineActions(f.match())).toEqual({ delete: true });
    expect(items.map(item => item.description)).toEqual(['主模式 · [—] · 未匹配', '全局 · [你] · 未匹配', '当前工作场景 · [—] · 未匹配']);
    expect(f.management.trustList).toHaveBeenCalledWith('conv-1');
    f.binding.retain(4, items);
    await expect(f.binding.revoke(4, items[2]!.id)).resolves.toEqual({ revoked: true, message: '已撤销信任规则。' });
    expect(f.management.trustRevoke).toHaveBeenCalledWith('scene', 'conv-1');
  });
  it('only revokes the retained N-side row and consumes it exactly once', async () => {
    const f = fixture(), items = await f.query(); f.binding.retain(3, items);
    await expect(f.binding.revoke(2, items[0]!.id)).rejects.toThrow('变化');
    await expect(f.binding.revoke(3, 'rule-1')).rejects.toThrow('变化');
    expect(f.management.trustRevoke).not.toHaveBeenCalled();
    await f.binding.revoke(3, items[0]!.id);
    await expect(f.binding.revoke(3, items[0]!.id)).rejects.toThrow('变化');
    expect(f.management.trustRevoke).toHaveBeenCalledTimes(1);
  });
  it('rejects forged provider metadata and clears any previous retained mapping', async () => {
    const f = fixture(), items = await f.query(); f.binding.retain(1, items);
    const forged = { ...items[0]!, acceptPayload: { ...items[0]!.acceptPayload,
      metadata: { commandId: 'trust:repl', argName: 'rule', argValue: 'not-authorized' } } };
    expect(() => f.binding.retain(2, [forged])).toThrow('身份');
    await expect(f.binding.revoke(1, items[0]!.id)).rejects.toThrow();
    expect(f.management.trustRevoke).not.toHaveBeenCalled();
  });
  it('keeps empty management distinct from lookup failure and permits a successful refresh', async () => {
    const f = fixture([]);
    const empty = await f.query(); expect(empty).toEqual([]); f.binding.retain(1, empty);
    await expect(f.binding.revoke(1, 'anything')).rejects.toThrow();
    f.management.trustList.mockRejectedValueOnce(Error('authority unavailable'));
    await expect(f.query()).rejects.toThrow('authority unavailable');
    expect(() => f.binding.retain(2, [])).toThrow('失效');
    f.management.trustList.mockResolvedValueOnce([rule('recovered')]);
    const refreshed = await f.query(); f.binding.retain(3, refreshed);
    await f.binding.revoke(3, refreshed[0]!.id);
    expect(f.management.trustRevoke).toHaveBeenCalledWith('recovered', 'conv-1');
  });
  it('bounds a long result after filtering and keeps later rules reachable by search', async () => {
    const f = fixture(Array.from({ length: 250 }, (_, i) => rule(`rule-${i}`)));
    const items = await f.query(); expect(items).toHaveLength(100); f.binding.retain(1, items);
    const last = await f.query('RULE-249'); expect(last).toHaveLength(1); f.binding.retain(2, last);
    await expect(f.binding.revoke(1, items[0]!.id)).rejects.toThrow('变化');
    await f.binding.revoke(2, last[0]!.id); expect(f.management.trustRevoke).toHaveBeenCalledWith('rule-249', 'conv-1');
  });
  it('rejects oversized or ambiguous authority results without leaving a deletable row', async () => {
    const f = fixture([rule('duplicate'), rule('duplicate')]);
    await expect(f.query()).rejects.toThrow('重复');
    f.management.trustList.mockResolvedValueOnce([{ ...rule('huge'), pattern: { tool: 'bash', argument: 'x'.repeat(1100 * 1024) } }]);
    await expect(f.query()).rejects.toThrow('容量'); expect(() => f.binding.retain(1, [])).toThrow('失效');
  });
  it('makes terminal control text inert while retaining the real rule identity', async () => {
    const f = fixture([{ ...rule('clean-id'), pattern: { tool: 'bash', argument: '\x1b[31mls\n\u202e*' } }]);
    const items = await f.query(); expect(items[0]!.displayText).toBe('bash ls  *');
    f.binding.retain(1, items); await f.binding.revoke(1, items[0]!.id);
    expect(f.management.trustRevoke).toHaveBeenCalledWith('clean-id', 'conv-1');
  });
  it.each(['conversation', 'controller', 'generation', 'close'] as const)('invalidates the pending query on %s change', async kind => {
    const f = fixture(), gate = deferred<TrustAdministrationRule[]>(); f.management.trustList.mockReturnValueOnce(gate.promise);
    const work = f.query();
    if (kind === 'conversation') f.controller.current = { conversationId: 'conv-2' };
    if (kind === 'controller') f.replace({ current: { conversationId: 'conv-1' } });
    if (kind === 'generation') f.binding.invalidate();
    if (kind === 'close') f.abort.abort();
    gate.resolve([rule('late')]); await expect(work).rejects.toThrow();
    expect(() => f.binding.retain(1, [])).toThrow('失效'); expect(f.management.trustRevoke).not.toHaveBeenCalled();
  });
  it('drops superseded and aborted query results instead of letting them overwrite the retained successor', async () => {
    const f = fixture(), gate = deferred<TrustAdministrationRule[]>(); f.management.trustList.mockReturnValueOnce(gate.promise);
    const old = f.query(); const current = await f.query('rule-2'); f.binding.retain(2, current);
    gate.resolve([rule('old')]); await expect(old).rejects.toThrow('失效');
    await f.binding.revoke(2, current[0]!.id);
    const abort = new AbortController(), next = await f.query('', abort.signal); abort.abort();
    expect(() => f.binding.retain(3, next)).toThrow('失效');
  });
  it('binds deletion to the original context and prevents concurrent/replayed actions or refresh', async () => {
    const f = fixture(), items = await f.query(); f.binding.retain(1, items);
    const gate = deferred<boolean>(); f.management.trustRevoke.mockReturnValueOnce(gate.promise);
    const work = f.binding.revoke(1, items[0]!.id);
    await expect(f.binding.revoke(1, items[1]!.id)).rejects.toThrow();
    await expect(f.query()).rejects.toThrow('正在撤销');
    f.controller.current = { conversationId: 'conv-2' }; gate.resolve(true);
    await expect(work).rejects.toThrow('变化'); expect(f.management.trustRevoke).toHaveBeenCalledWith('rule-1', 'conv-1');
    expect(f.management.trustRevoke).toHaveBeenCalledTimes(1);
    const next = await f.query(); f.binding.retain(2, next); await f.binding.revoke(2, next[0]!.id);
    expect(f.management.trustRevoke).toHaveBeenLastCalledWith('rule-1', 'conv-2');
  });
  it('does not turn false or failed mutation receipts into success or retry them automatically', async () => {
    const f = fixture(); let items = await f.query(); f.binding.retain(1, items);
    f.management.trustRevoke.mockResolvedValueOnce(false);
    await expect(f.binding.revoke(1, items[0]!.id)).resolves.toMatchObject({ revoked: false, message: expect.stringContaining('已不存在') });
    items = await f.query(); f.binding.retain(2, items); f.management.trustRevoke.mockRejectedValueOnce(Error('receipt missing'));
    await expect(f.binding.revoke(2, items[0]!.id)).rejects.toThrow('receipt missing');
    await expect(f.binding.revoke(2, items[0]!.id)).rejects.toThrow('变化'); expect(f.management.trustRevoke).toHaveBeenCalledTimes(2);
  });
});
