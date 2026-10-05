import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DeviceCapacityArbiterPort } from '@zhixing/core/resources';
import type { TerminalManagedFiles } from '../managed-files.js';
import { TerminalInputStore } from '../input-store.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const entries = new Map<string, { bytes: Buffer; identity: string }>();
  const deleted: string[] = [];
  const abort = new AbortController();
  let gate: ((name: string) => Promise<void>) | undefined;
  let deleting: (() => Promise<void>) | undefined;
  let liveReads = 0, maximumReads = 0, reads = 0;
  const files = {
    // Deliberately no serialization here: the production input transaction
    // itself, rather than any particular Windows native scheduling, must own it.
    runOperation: <T>(operation: () => Promise<T>) => operation(),
    async write(name: string, value: Buffer, position: number, size: number, _step: unknown, identity?: string) {
      const bytes = Buffer.alloc(size); entries.get(name)?.bytes.copy(bytes); value.copy(bytes, position);
      const entry = { bytes, identity: identity ?? randomUUID() }; entries.set(name, entry);
      return { identity: entry.identity };
    },
    async read(name: string, _size: number, position: number, length: number, identity: string) {
      reads++; maximumReads = Math.max(maximumReads, ++liveReads);
      try {
        await gate?.(name);
        const entry = entries.get(name)!; expect(entry.identity).toBe(identity);
        return Buffer.from(entry.bytes.subarray(position, position + length));
      } finally { liveReads--; }
    },
    async unlink(name: string, identity: string) {
      await deleting?.();
      expect(entries.get(name)?.identity).toBe(identity); entries.delete(name); deleted.push(name);
    },
  } as unknown as TerminalManagedFiles;
  const capacity = { async acquire() { return { kind: 'granted', permit: {
    tryBegin: () => ({ claim() {}, complete() {} }), release() {},
  } }; } } as DeviceCapacityArbiterPort;
  const account = { async reserve() { return randomUUID(); }, async settle() {}, async released() {} };
  const store = new TerminalInputStore('synthetic-reference-fixture', capacity, account, abort.signal, files);
  const add = async (text: string, purpose: 'draft' | 'paste' = 'draft') => {
    const id = randomUUID(); store.begin(id, purpose, Buffer.byteLength(text)); await store.part(id, 0, text, true); return id;
  };
  const material = await add('m', 'paste'), token = store.completePaste(material).token;
  const old = await add(`old draft ${token}`), next = await add(`new draft ${token}`);
  return { store, abort, old, next, material, deleted, add,
    deleting(value: typeof deleting) { deleting = value; },
    gate(value: typeof gate) { gate = value; }, counts: () => ({ reads, liveReads, maximumReads }) };
}

afterEach(() => { vi.useRealTimers(); });

describe('input reference transactions across a surface timeout', () => {
  it('queues the new revision, rejects the late old commit and never unlinks the new draft', async () => {
    const h = await fixture(), entered = deferred(), resume = deferred();
    let paused = false;
    h.gate(async name => { if (name === `input/${h.old}` && !paused) { paused = true; entered.resolve(); await resume.promise; } });
    const old = h.store.reconcileReferences(1, [h.old], [h.old]);
    const oldFailure = expect(old).rejects.toThrow('superseded');
    await entered.promise;
    // Same bounded fake-IO interleaving as the independent v2→v1 counterexample.
    // U's 30-second timeout releases only U's waiter; the N transaction survives.
    vi.useFakeTimers();
    const timeout = Promise.race([old, new Promise((_, reject) => setTimeout(() => reject(Error('surface-timeout')), 30_000))]);
    const timedOut = expect(timeout).rejects.toThrow('surface-timeout');
    await vi.advanceTimersByTimeAsync(30_000); await timedOut; vi.useRealTimers();
    let nextDone = false;
    const next = h.store.reconcileReferences(2, [h.next, h.old], [h.old, h.next]).then(value => { nextDone = true; return value; });
    await Promise.resolve();
    expect(nextDone).toBe(false); expect(h.counts().maximumReads).toBe(1);
    await h.store.release(h.next); expect(h.store.missing([h.next])).toEqual([]);
    expect(await h.store.collect()).toEqual([]);
    resume.resolve(); await oldFailure;
    expect((await next).removed).not.toContain(h.next);
    expect(h.deleted).not.toContain(`input/${h.next}`);
    expect(h.store.missing([h.old, h.next, h.material])).toEqual([]);
    expect(h.counts().maximumReads).toBe(1);
    await expect(h.store.reconcileReferences(1, [h.old], [h.next])).rejects.toThrow('superseded');
    await h.store.collect(); expect(h.store.missing([h.next])).toEqual([]);
    await h.store.close();
  });

  it('admits only two scans and does not let an overflow revision poison the admitted retry', async () => {
    const h = await fixture(), entered = deferred(), resume = deferred();
    h.gate(async () => { entered.resolve(); await resume.promise; });
    const first = h.store.reconcileReferences(1, [h.old], [h.old]);
    const failed = expect(first).rejects.toThrow('superseded'); await entered.promise;
    const second = h.store.reconcileReferences(2, [h.next, h.old], [h.next]);
    for (let version = 3; version < 35; version++) await expect(h.store.reconcileReferences(version, [h.old], [h.next])).rejects.toThrow('busy');
    await expect(h.store.retainDraft('frozen', h.next)).rejects.toThrow('busy');
    expect(h.counts()).toMatchObject({ reads: 1, liveReads: 1, maximumReads: 1 });
    h.gate(undefined); resume.resolve(); await failed; await second;
    await expect(h.store.reconcileReferences(3, [h.next], [h.old])).resolves.toMatchObject({ accepted: true });
    expect(h.store.missing([h.next, h.material])).toEqual([]);
    await h.store.close();
  });

  it('keeps the previous owner and unpublished originals if a scan fails, then permits a fresh retry', async () => {
    const h = await fixture();
    await h.store.reconcileReferences(1, [h.old], [h.old]);
    h.gate(async () => { throw Error('synthetic-read-failed'); });
    await expect(h.store.reconcileReferences(2, [h.next], [h.next])).rejects.toThrow('synthetic-read-failed');
    expect(await h.store.collect()).not.toContain(h.next);
    expect(h.store.missing([h.old, h.next, h.material])).toEqual([]);
    h.gate(undefined);
    const retry = await h.store.reconcileReferences(3, [h.next], [h.next]);
    expect(retry.removed).toContain(h.old); expect(h.store.missing([h.next, h.material])).toEqual([]);
    await h.store.close();
  });

  it.each(['abort', 'close'] as const)('prevents a late commit and publication after %s', async boundary => {
    const h = await fixture();
    await h.store.reconcileReferences(1, [h.old], [h.old]);
    const entered = deferred(), resume = deferred();
    h.gate(async () => { entered.resolve(); await resume.promise; });
    const operation = h.store.reconcileReferences(2, [h.next], [h.next]);
    const failed = expect(operation).rejects.toThrow(); await entered.promise;
    const queued = h.store.retainDraft('frozen', h.next), queuedFailure = expect(queued).rejects.toThrow();
    const closed = boundary === 'close' ? h.store.close() : undefined;
    if (boundary === 'abort') h.abort.abort(Error('synthetic-stop'));
    resume.resolve(); await failed; await queuedFailure; await closed;
    expect(h.deleted).toEqual([]); expect(h.store.missing([h.old, h.next, h.material])).toEqual([]);
    await h.store.close();
  });

  it('rejects a reference admission during an already-started unlink without advancing its revision', async () => {
    const h = await fixture();
    await h.store.reconcileReferences(1, [h.old], [h.old]);
    const unused = await h.add('unused original'), entered = deferred(), resume = deferred();
    h.deleting(async () => { entered.resolve(); await resume.promise; });
    const release = h.store.release(unused); await entered.promise;
    await expect(h.store.reconcileReferences(2, [h.next], [h.next])).rejects.toThrow('busy');
    expect(h.store.missing([h.old, h.next, h.material])).toEqual([]);
    resume.resolve(); await release; h.deleting(undefined);
    await expect(h.store.reconcileReferences(2, [h.next], [h.next])).resolves.toMatchObject({ accepted: true });
    expect(h.store.missing([h.next, h.material])).toEqual([]);
    await h.store.close();
  });
});
