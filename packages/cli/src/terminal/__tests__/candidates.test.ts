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
    expect(response?.value).toBe('cancel-work-stop');
  });
});
