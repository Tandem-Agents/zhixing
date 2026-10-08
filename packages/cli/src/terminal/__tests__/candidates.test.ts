import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TerminalAction, TerminalCandidates } from '../../../../terminal-ui/src/protocol.js';
import { TerminalCandidatesOwner } from '../candidates.js';
import { TerminalInputSession } from '../../../../terminal-ui/src/input-session.js';
import { TerminalCandidateSession } from '../../../../terminal-ui/src/candidate-session.js';
import { chooseTerminalSelection } from '../selection.js';
import { createStopSelectionRequest } from '../../runtime/stop-selection.js';
import type { ServerInfoResult } from '../../runtime/rpc-management-facade.js';

function owner(root = process.cwd()) {
  return new TerminalCandidatesOwner(() => ({ cwd: root, target: 'cli', features: { chrome: true }, now: 0, workspaceId: null, sessionBusy: false }));
}
const result = (revision: number): TerminalCandidates => ({ revision, start: 0, end: 2, items: [{ id: 'config:repl', label: '/config' }] });

describe('terminal candidates and control commands', () => {
  it('owns trust management immediately even behind an older query and preserves the draft through a failed revoke', async () => {
    const pending: ((value: unknown) => void)[] = [], actions: TerminalAction[] = [];
    const request = async (action: TerminalAction) => {
      actions.push(action);
      if (action.kind === 'input-candidates') return new Promise(resolve => pending.push(resolve));
      if (action.kind === 'candidate-revoke') throw Error('synthetic offline');
    };
    const input = new TerminalInputSession(request, vi.fn()), surface = new TerminalCandidateSession(input, request, vi.fn());
    input.edit('/t', 2); surface.sync();
    input.edit('/trust abc', 10); surface.sync();
    expect(surface.value?.mode).toBe('management'); expect(await surface.accept()).toBe(false);
    pending.shift()!({ revision: 1, start: 0, end: 2, items: [] });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const revision = (actions.filter(action => action.kind === 'input-candidates').at(-1) as Extract<TerminalAction, { kind: 'input-candidates' }>).revision;
    pending.shift()!({ revision, mode: 'management', canDelete: true, start: 7, end: 10, items: [{ id: 'rule-a', label: '允许读取' }] });
    await vi.waitFor(() => expect(surface.value?.items).toHaveLength(1));
    const original = { ...input.draft };
    expect(await surface.revoke(revision, 'rule-a')).toContain('synthetic offline');
    expect(input.draft).toEqual(original); expect(surface.value?.mode).toBe('management');
    expect(await surface.accept()).toBe(false);
    surface.escape(); expect(input.draft.text).toBe('/trust ');
    surface.escape(); expect(input.draft.text).toBe('');
    expect(actions.some(action => action.kind === 'candidate-accept' || action.kind === 'input-submit')).toBe(false);
  });
  it('shares aliases and command priority while rejecting stale acceptances', async () => {
    const source = owner();
    const choices = await source.query(1, '/qui', 4);
    expect(choices.items[0]!.id).toBe('exit:repl');
    expect(source.registry.findByName('quit')?.name).toBe('exit');
    await source.query(2, '/c', 2);
    expect(() => source.accept(1, choices.items[0]!.id)).toThrow('expired');
    expect(source.accept(2, 'config:repl').acceptPayload.replacement).toBe('/config');
    expect(() => source.accept(2, 'config:repl')).toThrow('expired');
  });
  it('converts code point provider offsets to UTF-16 and enumerates only the fixture directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'zhixing-candidates-'));
    try {
      await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'note.txt'), 'synthetic');
      const source = owner(root), text = '🦞中文 @file:';
      const candidates = await source.query(1, text, text.length);
      expect(candidates.start).toBe(text.indexOf('@')); expect(candidates.end).toBe(text.length);
      expect(candidates.items.map(item => item.label)).toEqual(['folder/', 'note.txt']);
      const selected = source.accept(1, 'file:note.txt');
      expect(selected.acceptPayload.metadata?.resolvedPath).toBe(path.join(root, 'note.txt').replaceAll('\\', '/'));
    } finally {
      if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('zhixing-candidates-')) throw Error('fixture cleanup boundary');
      await rm(root, { recursive: true, force: true });
    }
  });
  it('coalesces queries and ignores a late result after cursor movement or dismissal', async () => {
    const pending: ((value: unknown) => void)[] = [], actions: TerminalAction[] = [];
    const request = async (action: TerminalAction) => {
      actions.push(action);
      if (action.kind === 'input-candidates') return new Promise(resolve => pending.push(resolve));
    };
    const input = new TerminalInputSession(request, vi.fn()), surface = new TerminalCandidateSession(input, request, vi.fn());
    input.edit('/c', 2); surface.sync();
    input.edit('/co', 3); surface.sync(); input.edit('/con', 4); surface.sync();
    expect(pending).toHaveLength(1); pending.shift()!(result(1));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(surface.value).toBeUndefined();
    const queries = actions.filter(action => action.kind === 'input-candidates');
    expect(queries.map(query => query.text)).toEqual(['/c', '/con']);
    surface.dismiss(); pending.shift()!(result(queries[1]!.revision));
    await Promise.resolve(); expect(surface.value).toBeUndefined();
  });
  it('never inserts a selected material into a newer draft and releases its unclaimed reference', async () => {
    let accepted!: (value: unknown) => void;
    const calls: TerminalAction[] = [];
    const request = async (action: TerminalAction) => {
      calls.push(action);
      if (action.kind === 'input-candidates') return result(action.revision);
      if (action.kind === 'candidate-accept') return new Promise(resolve => { accepted = resolve; });
      return { removed: [] };
    };
    const input = new TerminalInputSession(request, vi.fn()), surface = new TerminalCandidateSession(input, request, vi.fn());
    input.edit('/c', 2); surface.sync(); await vi.waitFor(() => expect(surface.value).toBeDefined());
    const operation = surface.accept(); input.edit('new 🦞 draft', 6); surface.sync();
    const id = '00000000-0000-0000-0000-000000000001';
    accepted({ text: '[File #1 · synthetic]', execute: false, inputId: id, handles: [{ token: '[File #1 · synthetic]', id }] });
    expect(await operation).toBe(false); expect(input.draft.text).toBe('new 🦞 draft');
    await vi.waitFor(() => expect(calls.some(action => action.kind === 'input-references' && action.completed.includes(id) && !action.ids.includes(id))).toBe(true));
  });
  it('keeps stop unavailable without authority, and cancellation requires a separate confirmation', async () => {
    expect(createStopSelectionRequest(null).options.map(option => option.value)).toEqual(['cancel']);
    const status = { activeWork: { count: 2, cancellableCount: 1, drainOnlyCount: 1, cancellableWork: [], drainOnlyWork: [] } } as unknown as ServerInfoResult;
    const pages: string[] = []; let index = 0;
    const response = await chooseTerminalSelection(createStopSelectionRequest(status), async page => {
      pages.push(page.title);
      return [{ itemId: 'option:cancel-work-stop' }, { itemId: 'back' }, { itemId: 'option:cancel-work-stop' }, { itemId: 'confirm' }][index++];
    });
    expect(pages).toEqual(['停止知行', '取消工作并停止知行', '停止知行', '取消工作并停止知行']);
    expect(response).toEqual({ kind: 'selected', value: 'cancel-work-stop' });
  });
});


it('projects alias prefix ghosts separately and accepts them without execution', async () => {
  const source = owner(); const value = await source.query(1, '/qui', 4);
  expect(value.ghost).toEqual({ fullValue: '/quit' });
  expect(source.acceptGhost(1)).toEqual({ text: '/quit', execute: false });
  expect(() => source.acceptGhost(1)).toThrow('expired');
  expect(() => source.accept(1, 'exit:repl')).toThrow('expired');
  expect((await source.query(2, '/c', 2)).ghost).toBeUndefined();
  expect((await source.query(3, '/quit', 5)).ghost).toBeUndefined();
  await source.query(4, '/qui', 4); source.accept(4, 'exit:repl');
  expect(() => source.acceptGhost(4)).toThrow('expired');
});
it('projects progressive argument and empty-list hints from the shared provider', async () => {
  const source = owner();
  source.bindCommands([{ id: 'hint-test', name: 'hint', description: 'hint', category: 'tools', tag: 'builtin', execution: 'local',
    args: [{ name: 'name', kind: 'text', placeholder: '输入名称', required: true }] }]);
  const text = await source.query(1, '/hint ', 6);
  expect(text.items).toEqual([]); expect(text.argumentHint).toContain('输入名称');
  source.bindCommands([{ id: 'hint-empty', name: 'empty', description: 'empty', category: 'tools', tag: 'builtin', execution: 'local',
    args: [{ name: 'scene', kind: 'async-enum', required: true, provider: { mode: 'picker', emptyHint: '暂无场景', list: async () => [] } }] }]);
  expect((await source.query(2, '/empty ', 7)).argumentHint).toBe('暂无场景');
});
it('accepts a ghost through the same draft snapshot guard without submitting', async () => {
  let resolve!: (value: unknown) => void;
  const actions: TerminalAction[] = [];
  const request = async (action: TerminalAction) => {
    actions.push(action);
    if (action.kind === 'input-candidates') return { revision: action.revision, start: 0, end: 4, ghost: { fullValue: '/quit' }, items: [{ id: 'exit:repl', label: '/exit' }] };
    if (action.kind === 'candidate-ghost') return new Promise(done => { resolve = done; });
  };
  const input = new TerminalInputSession(request, vi.fn()), surface = new TerminalCandidateSession(input, request, vi.fn());
  input.edit('/qui', 4); surface.sync(); await vi.waitFor(() => expect(surface.value?.ghost).toBeDefined());
  const accepted = surface.accept(true); input.edit('later', 5); surface.sync();
  resolve({ text: '/quit', execute: false }); expect(await accepted).toBe(false); expect(input.draft.text).toBe('later');
  expect(actions.some(action => action.kind === 'candidate-accept' || action.kind === 'input-submit')).toBe(false);
});


it('uses a leading Chinese slash alias for commands and ghosts without moving UTF-16 ranges', async () => {
  const source = owner();
  const value = await source.query(1, '\u3001he', 3, true);
  expect(value.items.some(item => item.id === 'help:repl')).toBe(true);
  expect(value.ghost).toEqual({ fullValue: '/help' }); expect(value.start).toBe(0); expect(value.end).toBe(3);
  expect(source.acceptGhost(1)).toEqual({ text: '/help', execute: false });
  expect((await source.query(2, '\u3001he', 3, false)).items).toEqual([]);
  expect((await source.query(3, 'body\u3001he', 7, true)).items).toEqual([]);
  expect((await source.query(4, '[Pasted #1 +2 lines]\u3001he', '[Pasted #1 +2 lines]\u3001he'.length, true)).ghost).toBeUndefined();
});
it('owns an alias trust management page while loading, without sending it as a turn', async () => {
  let settle!: (value: unknown) => void; const actions: TerminalAction[] = [];
  const request = async (action: TerminalAction) => { actions.push(action); if (action.kind === 'input-candidates') return new Promise(done => { settle = done; }); };
  const input = new TerminalInputSession(request, vi.fn()), surface = new TerminalCandidateSession(input, request, vi.fn());
  input.edit('\u3001trust ', 7); surface.sync();
  expect(surface.value?.mode).toBe('management'); expect(await surface.accept()).toBe(false);
  expect(actions[0]).toMatchObject({ kind: 'input-candidates', atStart: true, text: '\u3001trust ' });
  surface.dismiss(); settle({ revision: 1, start: 7, end: 7, items: [] }); await Promise.resolve();
});
