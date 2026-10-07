import { describe, expect, it, vi } from 'vitest';
import { DefaultCommandRegistry } from '@zhixing/core/typeahead';
import type { SkillCatalogClient, SkillCatalogEntry, SkillCatalogChangedFact } from '@zhixing/core/skills/catalog';
import { TerminalSkillCommands, terminalSkillCommandRoute } from '../skill-commands.js';
import { BUILTIN_COMMANDS } from '../../commands/builtin-definitions.js';

const entry = (id: string, name = id): SkillCatalogEntry => ({ id, name, description: '技能', pinned: false, disabled: false, mode: 'main', source: 'own',
  createdAt: '2026-10-06T00:00:00.000Z', usage: null, revision: 1, digest: `sha256:${'a'.repeat(64)}`, contentRef: { bytes: 1, digest: `sha256:${'a'.repeat(64)}` } });
function fixture(initial = [entry('my-skill')]) {
  let entries = initial;
  const facts = new Set<(fact: SkillCatalogChangedFact) => void>(), registry = new DefaultCommandRegistry(), onError = vi.fn();
  registry.register(BUILTIN_COMMANDS['help:repl']);
  const query = vi.fn(async () => ({ entries, catalogRevision: 1 })), command = vi.fn();
  const client: SkillCatalogClient = { query, command, onFact: handler => { facts.add(handler); return () => { facts.delete(handler); }; } };
  const binding = new TerminalSkillCommands({ registry, client, onError });
  return { binding, registry, query, command, onError, facts, set(value: SkillCatalogEntry[]) { entries = value; },
    emit() { for (const handler of facts) handler({ kind: 'skill-catalog-changed', catalogRevision: 2 }); } };
}

describe('terminal dynamic Skill commands', () => {
  it('reserves every builtin name and alias even when its page is not yet installed', async () => {
    const f = fixture([entry('new'), entry('QUIT'), entry('skills'), entry('valid', 'exit'), entry('my-skill', 'Readable')]);
    expect(f.query).not.toHaveBeenCalled(); await f.binding.refresh();
    expect(f.registry.findByName('new')).toBeNull(); expect(f.registry.findByName('quit')).toBeNull();
    expect(f.registry.findByName('skills')).toBeNull(); expect(f.registry.findByName('exit')).toBeNull();
    expect(f.registry.findByName('valid')?.execution).toBe('agent');
    expect(f.registry.findByName('Readable')?.name).toBe('my-skill');
    expect(f.registry.findByName('help')?.id).toBe('help:repl'); f.binding.dispose();
  });
  it('reports swallowed source failures, preserves old/static commands and recovers', async () => {
    const f = fixture(); await f.binding.refresh();
    f.query.mockRejectedValueOnce(Error('catalog unavailable'));
    await expect(f.binding.refresh()).rejects.toThrow('catalog unavailable');
    expect(f.onError).toHaveBeenCalledTimes(1); expect(f.registry.findByName('my-skill')).not.toBeNull();
    expect(f.registry.findByName('help')).not.toBeNull();
    f.set([]); await f.binding.refresh(); expect(f.registry.findByName('my-skill')).toBeNull(); f.binding.dispose();
  });
  it('merges fact bursts with a pending query into one trailing authoritative reread', async () => {
    const f = fixture(); let finish!: () => void;
    f.query.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { entries: [entry('old')], catalogRevision: 1 }; });
    const refreshing = f.binding.refresh();
    for (let index = 0; index < 50; index++) f.emit();
    expect(f.query).toHaveBeenCalledTimes(1); f.set([entry('new-skill')]); finish(); await refreshing;
    expect(f.query).toHaveBeenCalledTimes(2); expect(f.registry.findByName('old')).toBeNull();
    expect(f.registry.findByName('new-skill')).not.toBeNull(); f.binding.dispose();
  });
  it('cannot resurrect a disposed source when a Catalog query resolves late', async () => {
    const f = fixture(); let finish!: () => void;
    f.query.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { entries: [entry('late')], catalogRevision: 1 }; });
    const refreshing = f.binding.refresh(); f.binding.dispose(); finish(); await refreshing;
    expect(f.facts.size).toBe(0); expect(f.registry.findByName('late')).toBeNull();
    expect(f.registry.findByName('help')).not.toBeNull(); expect(f.onError).not.toHaveBeenCalled();
    await f.binding.refresh(); expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('retains existing source semantics and routes skill names/aliases without submitting input', async () => {
    const f = fixture([{ ...entry('manual-skill', '唤醒技能'), disabled: true, mode: 'work' }]); await f.binding.refresh();
    expect(terminalSkillCommandRoute(f.registry, 'manual-skill')).toEqual({ route: 'input' });
    expect(terminalSkillCommandRoute(f.registry, '唤醒技能')).toEqual({ route: 'input' });
    expect(terminalSkillCommandRoute(f.registry, 'help')).toBeUndefined();
    expect(terminalSkillCommandRoute(f.registry, 'unknown')).toBeUndefined(); expect(f.command).not.toHaveBeenCalled();
    f.binding.dispose(); expect(terminalSkillCommandRoute(f.registry, 'manual-skill')).toBeUndefined();
  });
});
