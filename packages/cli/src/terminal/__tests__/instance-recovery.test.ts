import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CheckpointFilesystemSession } from '@zhixing/mesh/filesystem';
import type { DeviceCapacityArbiterPort } from '@zhixing/core/resources';
import { TerminalInstanceAssets, type TerminalProcessIdentity } from '../instance-assets.js';

type Node = { kind: 'file' | 'directory'; identity: string; data?: Buffer; children: Map<string, Node> };
function fixture(mode: 'plain' | 'gated' | 'legacy-intent' | 'legacy-next' | 'next' | 'unknown-next' | 'final-directory' | 'final-absent' | 'final-replaced' | 'writer-absent' | 'writer-alive' | 'collector-alive' | 'writer-gated' | 'wrapped-unknown') {
  let sequence = 0;
  const make = (kind: Node['kind'], data?: string | Buffer): Node => ({ kind, identity: `1:${++sequence}`, data: data === undefined ? undefined : Buffer.from(data), children: new Map() });
  const root = make('directory'); root.children.set('owner.lock', make('file', ''));
  const deleted: string[] = [], promoted: string[] = [];
  const markers: Buffer[] = [];
  function handle(node: Node): any {
    const get = (name: string) => { const child = node.children.get(name); if (!child) throw Object.assign(Error('absent'), { code: 'ENOENT' }); return child; };
    return { identity: node.identity, node, async close() {}, async sync() {}, async tryLock() { return async () => {}; }, async availableDiskBytes() { return 20 * 1024 ** 3; },
      async openDirectory(name: string, create: boolean) { if (!node.children.has(name) && create) node.children.set(name, make('directory')); const child = get(name); expect(child.kind).toBe('directory'); return handle(child); },
      async listEntries(limit: number) { const names = [...node.children.keys()].sort(); expect(names.length).toBeLessThanOrEqual(limit); return names; },
      async listEntryPage(offset: number, limit: number) { const names = [...node.children.keys()].sort(); return { names: names.slice(offset, offset + limit), end: offset + limit >= names.length }; },
      async statEntry(name: string) { const child = get(name); return { kind: child.kind, identity: child.identity, bytes: child.data?.length ?? 0, allocatedBytes: 4096 }; },
      async statFile(name: string) { const child = get(name); expect(child.kind).toBe('file'); return { identity: child.identity, bytes: child.data!.length }; },
      async readFile(name: string, declared: number, offset: number, limit: number, identity: string) { const child = get(name); expect(child.identity).toBe(identity); expect(child.data!.length).toBe(declared); return Buffer.from(child.data!.subarray(offset, offset + limit)); },
      async writeFile(name: string, bytes: Buffer) { if (node.children.has(name)) throw Object.assign(Error('exists'), { code: 'EEXIST' }); node.children.set(name, make('file', bytes)); },
      async renameTo(name: string, target: any, next: string) { const source = get(name); target.node.children.set(next, source); node.children.delete(name); promoted.push(name); if (next.startsWith('cleanup-')) markers.push(Buffer.from(source.data!)); },
      async unlink(name: string, directory: boolean, identity: string) { const child = get(name); expect(child.identity).toBe(identity); if (directory) expect(child.children.size).toBe(0); node.children.delete(name); deleted.push(name); },
    };
  }
  for (let index = 0; index < 8; index++) {
    const id = randomUUID(), directory = make('directory'); root.children.set(`instance-${id}`, directory);
    for (const name of ['input', 'display', 'runtime']) directory.children.set(name, make('directory'));
    const record = { version: mode === 'legacy-intent' || mode === 'legacy-next' ? 2 : 3, id, directoryIdentity: directory.identity,
      owner: { pid: 70000 + index, birth: 'old-owner', spawnId: randomUUID() },
      roles: { recovery: { pid: 80000 + index, birth: 'old-R', spawnId: randomUUID() } },
      pendingRoles: mode === 'legacy-intent' ? ['ui'] : mode === 'gated' ? [{ role: 'ui', spawnId: randomUUID(), state: 'gate-unreleased' }] : [],
      displayBytes: 16 * 1024 ** 2, inputBytes: 0, reservations: {}, previousIdentity: '',
      ...(mode === 'legacy-intent' || mode === 'legacy-next' ? {} : { writers: {} as Record<string, unknown> }),
    };
    if (mode.startsWith('writer-') || mode === 'wrapped-unknown') {
      const spawnId = randomUUID();
      record.writers![spawnId] = { role: 'filesystem', owner: record.owner.spawnId,
        state: mode === 'writer-gated' ? 'gate-unreleased' : 'bound',
        ...(mode === 'writer-gated' ? {} : { identity: { pid: 91000, birth: 'file-worker', spawnId } }),
        ...(mode === 'wrapped-unknown' ? { wrapped: true } : {}),
      };
    }
    const current = make('file', JSON.stringify(record)); directory.children.set('owner.json', current);
    if (mode === 'legacy-next') directory.children.set('owner.next', make('file', JSON.stringify(record)));
    if (mode === 'next' || mode === 'unknown-next') directory.children.set('owner.next', make('file', JSON.stringify({ ...record,
      inputBytes: 1024, previousIdentity: mode === 'next' ? current.identity : '1:unknown',
    })));
    if (mode.startsWith('final-')) {
      directory.children.clear();
      root.children.set(`cleanup-${id}.json`, make('file', JSON.stringify({ ...record, cleanup: { pid: 90000 + index, birth: 'old-collector', spawnId: randomUUID() } })));
      if (mode === 'final-absent') root.children.delete(`instance-${id}`);
      if (mode === 'final-replaced') root.children.set(`instance-${id}`, make('directory'));
    }
    if (mode === 'collector-alive') directory.children.set('owner.json', make('file', JSON.stringify({ ...record,
      cleanup: { pid: 92000, birth: 'old-collector', spawnId: randomUUID() },
      cleanupWriters: [{ pid: 91000, birth: 'file-worker', spawnId: randomUUID() }],
    })));
  }
  const session = { openPath: async () => handle(root), close: async () => {} } as unknown as CheckpointFilesystemSession;
  const capacity = { async acquire() { return { kind: 'granted', permit: { tryBegin: () => ({ claim() {}, complete() {} }), release() {} } }; } } as DeviceCapacityArbiterPort;
  const identity = { async read(pid: number) { return pid === process.pid || (pid === 91000 && ['writer-alive', 'collector-alive'].includes(mode)) ? { kind: 'present' as const, birth: pid === process.pid ? 'self' : 'file-worker' } : { kind: 'absent' as const }; } };
  return { root, deleted, promoted, markers, create: (writer?: () => Promise<TerminalProcessIdentity>) => new TerminalInstanceAssets('/in-memory-only', capacity, identity, session, writer) };
}

describe('terminal recoverable creation and publication states', () => {
  it('carries the actual bootstrap and collector writer identity through first publication and finalization', async () => {
    const memory = fixture('plain'), writer = { pid: process.pid, birth: 'self', spawnId: randomUUID() };
    const assets = memory.create(async () => writer), id = randomUUID();
    try {
      await assets.admit(id, { pid: process.pid, birth: 'self', spawnId: randomUUID() }, new AbortController().signal);
      const record = JSON.parse(memory.root.children.get(`instance-${id}`)!.children.get('owner.json')!.data!.toString());
      expect(record.writers[writer.spawnId]).toMatchObject({ state: 'bound', identity: writer });
      await assets.release(new AbortController().signal);
      const marker = memory.markers.map(bytes => JSON.parse(bytes.toString())).find(value => value.id === id);
      expect(marker.cleanupWriters).toEqual([writer]);
      expect(memory.root.children.has(`instance-${id}`)).toBe(false);
    } finally { await assets.close(); }
  });
  it.each(['plain', 'gated', 'next', 'final-directory', 'final-absent', 'writer-absent', 'writer-gated'] as const)('reclaims eight positively resolved %s instances', async mode => {
    const memory = fixture(mode), assets = memory.create();
    try {
      await assets.admit(randomUUID(), { pid: process.pid, birth: 'self', spawnId: randomUUID() }, new AbortController().signal);
      expect([...memory.root.children.keys()].filter(name => name.startsWith('instance-'))).toHaveLength(1);
      expect(memory.deleted.filter(name => name.startsWith('instance-'))).toHaveLength(mode === 'final-absent' ? 0 : 8);
      expect([...memory.root.children.keys()].filter(name => name.startsWith('cleanup-'))).toHaveLength(0);
      if (mode === 'next') expect(memory.promoted.length).toBeGreaterThanOrEqual(16);
    } finally { await assets.close(); }
  });
  it.each(['legacy-intent', 'legacy-next', 'unknown-next', 'final-replaced', 'writer-alive', 'collector-alive', 'wrapped-unknown'] as const)('preserves %s without inventing missing evidence', async mode => {
    const memory = fixture(mode);
    for (let attempt = 0; attempt < 2; attempt++) {
      const assets = memory.create();
      try { await expect(assets.admit(randomUUID(), { pid: process.pid, birth: 'self', spawnId: randomUUID() }, new AbortController().signal)).rejects.toThrow(); }
      finally { await assets.close(); }
    }
    expect(memory.deleted).toEqual([]); expect(memory.promoted).toHaveLength(mode === 'legacy-next' ? 8 : 0);
    expect([...memory.root.children.keys()].filter(name => name.startsWith('instance-'))).toHaveLength(8);
  });
});
