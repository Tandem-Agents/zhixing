import { describe, expect, it, vi } from 'vitest';
import type { SkillCatalogClient, SkillCatalogEntry, SkillCatalogChangedFact, SkillCatalogCommand } from '@zhixing/core/skills/catalog';
import { validateSkillsView, type TerminalSkillsAction, type TerminalSkillsView } from '../../../../terminal-ui/src/skills-model.js';
import { TerminalSkillsOwner } from '../skills.js';

const entry = (id: string): SkillCatalogEntry => ({ id, name: id, description: '做事', pinned: false, disabled: false, mode: 'main', source: 'own',
  createdAt: '2026-10-06T00:00:00.000Z', usage: null, revision: 1, digest: `sha256:${'a'.repeat(64)}`, contentRef: { bytes: 1, digest: `sha256:${'a'.repeat(64)}` } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(ids = ['alpha', 'beta', 'gamma']) {
  let entries = ids.map(entry), revision = 0;
  const facts = new Set<(fact: SkillCatalogChangedFact) => void>(), views: TerminalSkillsView[] = [], abort = new AbortController();
  const query = vi.fn(async () => ({ entries: [...entries], catalogRevision: revision }));
  const command = vi.fn(async (operation: SkillCatalogCommand) => {
    if (operation.kind === 'archive') entries = entries.filter(item => item.id !== operation.skillId);
    else entries = entries.map(item => item.id === operation.skillId ? { ...item, ...operation.patch } : item);
    entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.id.localeCompare(b.id)); revision++;
  });
  const client: SkillCatalogClient = { query, command, onFact: handler => { facts.add(handler); return () => { facts.delete(handler); }; } };
  const refreshCommands = vi.fn(async () => {});
  const owner = new TerminalSkillsOwner({ client, refreshCommands, signal: abort.signal, publish: async view => { views.push(view); } });
  const done = owner.open();
  const latest = () => views.at(-1)!;
  const ready = () => vi.waitFor(() => expect(latest()).toMatchObject({ busy: false, state: 'ready' }));
  const action = (action: Omit<TerminalSkillsAction, 'sessionId' | 'revision'> | Record<string, unknown>) => owner.act({ sessionId: latest().sessionId, revision: latest().revision, ...action } as TerminalSkillsAction);
  return { owner, done, views, latest, ready, action, query, command, refreshCommands, facts, abort,
    emit() { for (const handler of facts) handler({ kind: 'skill-catalog-changed', catalogRevision: ++revision }); },
    replace(next: SkillCatalogEntry[]) { entries = next; },
  };
}

describe('terminal Skill page lifetime', () => {
  it('preserves all four actions and selected identity across pin reorder and archive', async () => {
    const f = fixture(); await f.ready();
    await f.action({ kind: 'move', direction: 1 });
    expect(f.latest().selectedId).toBe('beta');
    await f.action({ kind: 'pin', skillId: 'beta' });
    expect(f.latest()).toMatchObject({ selectedId: 'beta', selectedIndex: 0 });
    await f.action({ kind: 'disable', skillId: 'beta' });
    await f.action({ kind: 'mode', skillId: 'beta' });
    expect(f.latest().items[0]).toMatchObject({ id: 'beta', pinned: true, disabled: true, mode: 'work' });
    await f.action({ kind: 'archive', skillId: 'beta' });
    expect(f.latest()).toMatchObject({ total: 2, selectedId: 'alpha', selectedIndex: 0 });
    expect(f.refreshCommands).toHaveBeenCalledTimes(4);
    expect(f.views.every(validateSkillsView)).toBe(true);
    await f.action({ kind: 'cancel' }); await f.done; expect(f.facts.size).toBe(0);
  });
  it('rejects stale revisions, stale sessions and forged selected IDs without writing', async () => {
    const f = fixture(); await f.ready(); const first = f.latest();
    await f.action({ kind: 'move', direction: 1 });
    expect(await f.owner.act({ sessionId: first.sessionId, revision: first.revision, kind: 'archive', skillId: 'alpha' })).toBe(false);
    expect(await f.action({ kind: 'archive', skillId: 'alpha' })).toBe(false);
    expect(await f.owner.act({ sessionId: 'old', revision: f.latest().revision, kind: 'cancel' })).toBe(false);
    expect(f.command).not.toHaveBeenCalled();
    f.owner.close(); await f.done;
  });
  it('bounds long pages, resizes around selection and follows identity on fact reorder', async () => {
    const f = fixture(Array.from({ length: 75 }, (_, index) => `skill-${String(index).padStart(2, '0')}`)); await f.ready();
    await f.action({ kind: 'resize', pageSize: 5 }); await f.action({ kind: 'move', direction: 1, page: true });
    expect(f.latest()).toMatchObject({ total: 75, offset: 5, selectedId: 'skill-05' }); expect(f.latest().items).toHaveLength(5);
    f.replace([entry('skill-05'), entry('skill-00'), entry('skill-01')]); f.emit(); await f.ready();
    expect(f.latest()).toMatchObject({ total: 3, selectedId: 'skill-05', selectedIndex: 0 });
    f.owner.close(); await f.done;
  });
  it('keeps a maximum page inside the control frame even with escaped identifiers and descriptions', async () => {
    const f = fixture(); await f.ready();
    f.replace(Array.from({ length: 24 }, (_, index) => ({ ...entry(`${index}${'\0'.repeat(478)}`), name: '\0'.repeat(480), description: '\0'.repeat(4096) })));
    await f.action({ kind: 'resize', pageSize: 24 }); f.emit(); await f.ready();
    expect(f.latest().items).toHaveLength(24); expect(validateSkillsView(f.latest())).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(f.latest()))).toBeLessThan(224 * 1024);
    expect(f.latest().items[0]?.description.endsWith('…')).toBe(true);
    f.owner.close(); await f.done;
  });
  it('keeps a committed write when post-write refresh fails and recovers through r', async () => {
    const f = fixture(); await f.ready();
    f.query.mockRejectedValueOnce(Error('list unavailable'));
    await f.action({ kind: 'pin', skillId: 'alpha' });
    expect(f.latest()).toMatchObject({ state: 'error', busy: false }); expect(f.latest().message).toContain('变更已保存');
    expect(f.refreshCommands).toHaveBeenCalledTimes(1);
    expect(await f.action({ kind: 'archive', skillId: 'alpha' })).toBe(false);
    await f.action({ kind: 'refresh' }); expect(f.latest().items[0]?.pinned).toBe(true);
    expect(f.latest().state).toBe('ready'); f.owner.close(); await f.done;
  });
  it('closes immediately during an issued write, releases subscription and suppresses late UI', async () => {
    const f = fixture(); await f.ready(); const gate = deferred();
    f.command.mockImplementationOnce(async () => { await gate.promise; });
    const mutation = f.action({ kind: 'archive', skillId: 'alpha' });
    await vi.waitFor(() => expect(f.command).toHaveBeenCalledTimes(1));
    const count = f.views.length, queries = f.query.mock.calls.length;
    await f.action({ kind: 'cancel' }); await f.done;
    expect(f.facts.size).toBe(0); gate.resolve(); await mutation;
    expect(f.views).toHaveLength(count); expect(f.query).toHaveBeenCalledTimes(queries);
    expect(f.refreshCommands).toHaveBeenCalledTimes(1);
  });
  it('coalesces a burst of invalidations into one trailing read, with no queued writes', async () => {
    const f = fixture(); await f.ready(); const gate = deferred();
    f.query.mockImplementationOnce(async () => { await gate.promise; return { entries: [entry('alpha')], catalogRevision: 1 }; });
    f.emit(); await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 30; index++) f.emit();
    expect(await f.action({ kind: 'archive', skillId: 'alpha' })).toBe(false);
    expect(f.query).toHaveBeenCalledTimes(2); gate.resolve();
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(3)); await f.ready();
    expect(f.command).not.toHaveBeenCalled(); f.abort.abort(); await f.done; expect(f.facts.size).toBe(0);
  });
  it('shows recoverable initial and command-refresh errors without clearing the list', async () => {
    const f = fixture(); await f.ready();
    f.refreshCommands.mockRejectedValueOnce(Error('unavailable'));
    await f.action({ kind: 'disable', skillId: 'alpha' });
    expect(f.latest().items[0]?.disabled).toBe(true); expect(f.latest().message).toContain('命令刷新失败');
    await f.action({ kind: 'refresh' }); expect(f.latest().message).toBeUndefined();
    f.owner.close(); await f.done;
    const abort = new AbortController(), views: TerminalSkillsView[] = [], unsub = vi.fn();
    const owner = new TerminalSkillsOwner({ signal: abort.signal, refreshCommands: vi.fn(),
      client: { query: vi.fn().mockRejectedValue(Error('unavailable')), command: vi.fn(), onFact: () => unsub },
      publish: async view => { views.push(view); } });
    const done = owner.open(); await vi.waitFor(() => expect(views.at(-1)?.state).toBe('error'));
    owner.close(); await done; expect(unsub).toHaveBeenCalledTimes(1);
  });
});
