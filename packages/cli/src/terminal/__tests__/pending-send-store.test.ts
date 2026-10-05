import { describe, expect, it, vi } from 'vitest';
import type { DeviceCapacityArbiterPort } from '@zhixing/core/resources';
import type { TerminalManagedFiles } from '../managed-files.js';
import { TerminalPendingSendStore } from '../pending-send-store.js';

function fixture() {
  const files = new Map<string, Buffer>();
  let readGate: Promise<void> | undefined;
  const port = {
    runOperation: <T>(operation: () => Promise<T>) => operation(),
    async write(name: string, bytes: Buffer, offset: number, size: number, _step: unknown, identity?: string) {
      expect(offset).toBe(files.get(name)?.length ?? 0); expect(identity).toBe(offset ? 'snapshot-identity' : undefined);
      const next = Buffer.alloc(size); files.get(name)?.copy(next); bytes.copy(next, offset); files.set(name, next);
      return { identity: 'snapshot-identity' };
    },
    async read(name: string, size: number, offset: number, length: number, identity: string) {
      await readGate; expect(identity).toBe('snapshot-identity'); expect(size).toBe(files.get(name)!.length);
      return Buffer.from(files.get(name)!.subarray(offset, offset + length));
    },
    async unlink(name: string, identity: string) { expect(identity).toBe('snapshot-identity'); files.delete(name); },
  } as unknown as TerminalManagedFiles;
  const account = { reserve: vi.fn(async (_bucket: string, bytes: number) => { expect(bytes).toBeLessThanOrEqual(1024 * 1024); return 'reservation'; }), settle: vi.fn(async () => {}), released: vi.fn(async () => {}) };
  const capacity = { async acquire() { return { kind: 'granted', permit: { tryBegin: () => ({ claim() {}, complete() {} }), release() {} } }; } } as DeviceCapacityArbiterPort;
  const abort = new AbortController();
  const store = new TerminalPendingSendStore(port, capacity, account, abort.signal);
  return { store, files, account, gate(value: Promise<void>) { readGate = value; } };
}

describe('pending session.send disk ownership', () => {
  it('pins before preparation and deletes only after the actual read borrower releases', async () => {
    const h = fixture(), gate = Promise.withResolvers<void>();
    const source = (await h.store.prepare(async write => { await write(Buffer.from('{}')); return 2; }))!;
    await expect(h.store.prepare(async () => 0)).rejects.toThrow('仍在清理');
    h.gate(gate.promise);
    const reader = source.open(), read = reader.read(0, 2, new AbortController().signal);
    let disposed = false; const disposing = source.dispose().then(() => { disposed = true; });
    await Promise.resolve(); expect(disposed).toBe(false); expect(h.files.size).toBe(1);
    expect(() => source.open()).toThrow('unavailable'); expect(() => reader.release()).toThrow('not-drained');
    gate.resolve(); expect((await read).toString()).toBe('{}');
    expect(h.files.size).toBe(1); reader.release(); await disposing;
    expect(h.files.size).toBe(0); expect(h.account.released).toHaveBeenCalledWith('input', 4096);
  });

  it('cleans a known partial preparation without publishing it or losing its charge early', async () => {
    const h = fixture();
    await expect(h.store.prepare(async write => { await write(Buffer.alloc(32 * 1024)); throw Error('synthetic prepare capacity'); })).rejects.toThrow('synthetic');
    expect(h.files.size).toBe(0); expect(h.account.released).toHaveBeenCalledWith('input', 32 * 1024);
    const source = await h.store.prepare(async write => { await write(Buffer.from('{}')); return 2; });
    await source!.dispose();
  });

  it.each(['settle', 'released'])('retains unknown %s accounting and does not admit another pending source', async operation => {
    const h = fixture();
    h.account[operation].mockRejectedValueOnce(Error('synthetic account response lost'));
    if (operation === 'settle') {
      await expect(h.store.prepare(async write => { await write(Buffer.from('{}')); return 2; })).rejects.toThrow('response lost');
      expect(h.files.size).toBe(1); expect(h.account.released).not.toHaveBeenCalled();
    } else {
      const source = (await h.store.prepare(async write => { await write(Buffer.from('{}')); return 2; }))!;
      await expect(source.dispose()).rejects.toThrow('response lost');
      expect(h.files.size).toBe(0);
    }
    await expect(h.store.prepare(async () => 0)).rejects.toThrow('仍在清理');
  });
});
