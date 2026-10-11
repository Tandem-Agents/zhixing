import path from 'node:path';
import { FileArtifactStore, FileAuthorityCommitLog } from '@zhixing/core/authority';
import type { ConversationControlCursor, ConversationControlPage, ConversationInputCursor, ConversationInputPage, Signature } from '@zhixing/core/contracts';
import { protocolDigest } from '@zhixing/core/protocol';
import { createTempDir } from '@zhixing/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { StorageMaintenanceAdmissionError, isHoldingMaintenanceExclusion, runHoldingMaintenanceExclusion, runWithMaintenanceUrgency } from '@zhixing/core/resources';
import { AnchorResourceGovernor } from '../resource-governor.js';
import { ControlAdmissionJournal, createInitialControlEnvelope } from '../control-admission.js';
import { ConversationRunJournal } from '../conversation-assignment.js';
import { ConversationReadIndex } from '../conversation-read-index.js';
import { trackAuthorityLog } from './durable-io-test-support.js';

const NOW = '2026-10-05T00:00:00.000Z';
const signer = { sign(schema: string, version: number, payload: unknown): Signature { return { alg: 'test-sha256', keyId: 'device:test', sig: protocolDigest(schema, version, payload) }; } };
const verifier = { verify(schema: string, version: number, payload: unknown, signature: Signature) { expect(signature).toEqual(signer.sign(schema, version, payload)); } };
async function harness() {
  const root = await createTempDir('conversation-recovery');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, 'log'), artifacts, { clock: () => NOW }));
  const resources = new AnchorResourceGovernor({ log, signer, verifier, guard: { assert() {} }, anchorEpoch: 1,
    localExecutorId: 'device:test', reporterKeyFor: () => 'device:test', clock: () => NOW });
  const journalAt = (epoch = 1) => new ConversationRunJournal({ conversationId: 'recovery-conversation', ownerEpoch: epoch, log, artifacts, signer, verifier,
    resources, submission: { authenticate() {}, authorize() {} }, authority: { decideAtPrefix: () => ({ committed: true, commitRevision: 1 }) }, projection: { async project() {} }, clock: () => NOW });
  return { log, artifacts, resources, journal: journalAt(), journalAt };
}
async function admit(journal: ConversationRunJournal, text = 'original input') {
  await journal.admit({ ingressKey: 'seed-ingress', runId: 'seed-run', queuedPosition: 0,
    userInput: { parts: [{ type: 'text', text }] }, invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: 'seed-ingress', receivedAt: NOW,
      turnOrigin: { channel: 'rpc', messageIdentity: { id: 'seed-message', source: { kind: 'conversation', conversationId: 'source-conversation' } } } } });
}

describe('finite owner recovery pages', () => {
  it('installs empty and sparse recovery views without syncing unrelated resource slices', async () => {
    const h = await harness();
    const coordinate = vi.spyOn(h.resources, 'coordinate');
    const empty = h.journalAt(); await empty.primeRecoverySnapshot(await h.log.readSnapshot());
    expect(empty.hasRecoveredInputProjection).toBe(true);
    await h.log.append(Array.from({length: 4096}, (_, i) => ({stream: 'run:other-conversation', body: {v: 1, index: i}})));
    await admit(h.journal); await h.journal.cancelRun({runId: 'seed-run', requestId: 'seed-cancel'});
    const snapshot = await h.log.readSnapshot(); coordinate.mockClear();
    const recovered = h.journalAt(); await recovered.primeRecoverySnapshot(snapshot);
    expect(coordinate).not.toHaveBeenCalled();
    expect(recovered.hasRecoveredInputProjection).toBe(true);
    expect(await recovered.currentState('seed-run')).toBe('cancelled');
  });

  it('resumes a pressured prefix without re-reading completed records or exposing a partial view', async () => {
    const source = await harness();
    await admit(source.journal, 'bounded artifact input '.repeat(3000));
    await source.journal.cancelRun({ runId: 'seed-run', requestId: 'seed-cancel' });
    const template = (await source.log.readAll()).flatMap(envelope => envelope.entries);
    const entries = Array.from({ length: 80 }, (_, index) => template.map(entry => {
      const record = JSON.parse(JSON.stringify(entry).replaceAll('seed-', 'case-' + index + '-'));
      if (record.body.t === 'admitted') record.body.queuedPosition = index;
      return record;
    })).flat();
    await source.log.append(entries);
    const snapshot = await source.log.readSnapshot();
    const get = source.artifacts.get.bind(source.artifacts);
    const spy = vi.spyOn(source.artifacts, 'get').mockImplementation(get);
    try {
      await source.journalAt().primeRecoverySnapshot(snapshot);
      const baseline = spy.mock.calls.length;
      expect(baseline).toBeGreaterThan(8);
      let count = 0;
      spy.mockClear().mockImplementation(async (...args) => {
        if (++count === 5) {
          expect(isHoldingMaintenanceExclusion()).toBe(false);
          const failure = new StorageMaintenanceAdmissionError({ kind: 'backpressured', blockedBy: 'probe-unavailable', retryAfterMs: 1 });
          // Async-local scope of the test remains outside the journal queue.
          // The production leaf waits here without restarting the enclosing record.
          await new Promise(resolve => setTimeout(resolve, failure.admission.kind === 'backpressured' ? failure.admission.retryAfterMs : 1));
        }
        return get(...args);
      });
      const primed = source.journalAt();
      const pending = primed.primeRecoverySnapshot(snapshot);
      await pending;
      expect(spy.mock.calls.length).toBe(baseline);
      expect((await primed.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation' }) as ConversationControlPage).facts.length).toBeGreaterThan(0);
      const cancelled = new StorageMaintenanceAdmissionError({ kind: 'cancelled' });
      spy.mockClear().mockRejectedValue(cancelled);
      await expect(source.journalAt().primeRecoverySnapshot(snapshot)).rejects.toBe(cancelled);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  }, 30_000);

  it('does not hold the journal while a recovery artifact waits and rejects a replaced base', async () => {
    const h = await harness(); await admit(h.journal, 'bounded artifact input '.repeat(3000));
    const snapshot = await h.log.readSnapshot(), prime = h.journalAt();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const get = h.artifacts.get.bind(h.artifacts);
    const spy = vi.spyOn(h.artifacts, 'get').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return get(...args);
    });
    try {
      const pending = prime.primeRecoverySnapshot(snapshot);
      const outcome = pending.then(() => undefined, error => error);
      await entered.promise;
      // This uses the exact same journal queue; it cannot finish if prime holds it.
      await prime.primeImportedReadBase([]);
      release.resolve(); expect(await outcome).toMatchObject({ message: 'Conversation recovery read base changed' });
    } finally { release.resolve(); spy.mockRestore(); }
  });

  it('retains a newer authoritative cursor while an older snapshot finishes', async () => {
    const h = await harness(); await admit(h.journal, 'large input '.repeat(6000));
    const snapshot = await h.log.readSnapshot(), prime = h.journalAt();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const get = h.artifacts.get.bind(h.artifacts);
    const spy = vi.spyOn(h.artifacts, 'get').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return get(...args);
    });
    try {
      const pending = prime.primeRecoverySnapshot(snapshot);
      await entered.promise;
      await prime.cancelRun({ runId: 'seed-run', requestId: 'concurrent-cancel' });
      release.resolve(); await pending;
      expect(await prime.currentState('seed-run')).toBe('cancelled');
    } finally { release.resolve(); spy.mockRestore(); }
  });

  it('recovers more than 200 old cancelled inputs and advances inside one authority envelope', async () => {
    const source = await harness(); await admit(source.journal);
    await source.journal.cancelRun({ runId: 'seed-run', requestId: 'seed-cancel' });
    const template = (await source.log.readAll()).flatMap(envelope => envelope.entries);
    const target = await harness();
    const entries = Array.from({ length: 205 }, (_, index) => template.map(entry => {
      const record = JSON.parse(JSON.stringify(entry).replaceAll('seed-', `case-${index}-`));
      if (record.body.t === 'admitted') record.body.queuedPosition = index;
      return record;
    })).flat();
    await target.log.append(entries);
    let cursor: ConversationControlCursor | undefined;
    const seen = new Set<string>(), statuses = new Set<string>(); let withinEnvelope = false;
    do {
      const page = await target.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', cursor }) as ConversationControlPage;
      expect(page.reset).toBe(false); expect(page.facts.length).toBeLessThanOrEqual(32);
      withinEnvelope ||= page.cursor.item > 0;
      for (const fact of page.facts) {
        if (fact.kind === 'status') { expect(fact.notice.state).toBe('cancelled'); statuses.add(fact.notice.ref.runId); }
        if (fact.kind !== 'input') continue;
        const input = await target.journal.recoveryPage({ mode: 'input-page', conversationId: 'recovery-conversation', runId: fact.cursor.runId, cursor: fact.cursor }) as ConversationInputPage;
        expect(input.input?.text).toBe('original input'); expect(input.input?.final).toBe(true);
        expect(seen.has(input.input!.identity.id)).toBe(false); seen.add(input.input!.identity.id);
      }
      cursor = page.cursor; if (!page.hasMore) break;
    } while (seen.size <= 205);
    expect(withinEnvelope).toBe(true); expect(seen.size).toBe(205); expect(statuses.size).toBe(205);
    const rebound = await target.journalAt(2).recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', cursor }) as ConversationControlPage;
    expect(rebound.reset).toBe(false); expect(rebound.facts).toEqual([]); expect(rebound.cursor.ownerEpoch).toBe(2);
  }, 60_000);

  it('keeps Unicode source offsets across finite pages and proves empty only after the final fragment', async () => {
    const { journal } = await harness(); const original = '汉🦞\n'.repeat(12000); await admit(journal, original);
    let cursor: ConversationInputCursor | undefined, text = '', fragments = 0;
    for (;;) {
      const page = await journal.recoveryPage({ mode: 'input-page', conversationId: 'recovery-conversation', runId: 'seed-run', cursor }) as ConversationInputPage;
      expect(page.reset).toBe(false);
      if (page.input) {
        expect(page.input.contentOffset).toBe(text.length); expect(Buffer.byteLength(page.input.text)).toBeLessThanOrEqual(32 * 1024);
        expect(page.input.text).not.toMatch(/[\uD800-\uDBFF]$/u); text += page.input.text; fragments++;
      }
      cursor = page.cursor; if (!page.hasMore) break;
    }
    expect(fragments).toBeGreaterThan(4); expect(text).toBe(original);
  });

  it('reads the verified imported prefix even when its source LSN exceeds the target WAL', async () => {
    const source = await harness(); await admit(source.journal);
    const snapshot = await source.log.readSnapshot();
    const target = await harness(); const targetSnapshot = await target.log.readSnapshot();
    await target.journal.primeRecoverySnapshot({ commits: snapshot.commits, cursor: targetSnapshot.cursor });
    const base = { id: 'transfer-synthetic', clearedThroughLsn: 0, records: snapshot.commits.flatMap(envelope => envelope.entries.map(record => ({ ...record, lsn: envelope.lsn, at: envelope.at }))) };
    await target.journal.primeImportedReadBase(base.records as any);
    const page = await target.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation' }, base) as ConversationControlPage;
    const inputFact = page.facts.find(fact => fact.kind === 'input'); expect(inputFact?.kind).toBe('input');
    if (inputFact?.kind !== 'input') throw Error('missing imported input');
    expect(inputFact.cursor.imported).toBe(true); expect(inputFact.cursor.upper.lsn).toBe(0);
    const input = await target.journal.recoveryPage({ mode: 'input-page', conversationId: 'recovery-conversation', runId: 'seed-run', cursor: inputFact.cursor }, base) as ConversationInputPage;
    expect(input.input?.text).toBe('original input');
    const next = await target.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', cursor: page.cursor }, base) as ConversationControlPage;
    expect(next.facts).toEqual([]); expect(next.hasMore).toBe(false);
    const replaced = await target.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', cursor: page.cursor }, { ...base, id: 'transfer-replaced' }) as ConversationControlPage;
    expect(replaced.reset).toBe(true);
  });
});

it('first input reuses the recovered run prefix without rereading old artifacts or sharing mutable projections', async () => {
  const h = await harness();
  await admit(h.journal, 'old artifact-backed input '.repeat(3000));
  await h.journal.cancelRun({ runId:'seed-run', requestId:'seed-cancel' });
  const snapshot = await h.log.readSnapshot(), journal = h.journalAt();
  await journal.primeRecoverySnapshot(snapshot);
  const oldReads = vi.spyOn(h.artifacts, 'get').mockRejectedValue(new Error('old prefix was read again'));
  const source = { principal: { surfacePrincipal:'rpc:test', deviceId:'device:test', connectionId:'input-test' },
    ingress: { kind:'first-party' as const, surfacePrincipal:'rpc:test', deviceId:'device:test', ingressId:'next-ingress', receivedAt:NOW } };
  const envelope = createInitialControlEnvelope({ requestId:'next-request', source, at:NOW, body: { t:'input',
    conversationId:'recovery-conversation', ownerEpoch:1, ingress:{ingressId:'next-ingress',source:'first-party'},
    input:{parts:[{type:'text',text:'next input'}]},invocation:{kind:'agent',source:'interactive'} } });
  try {
    const request = {admission:new ControlAdmissionJournal(h.log,h.artifacts),envelope,source,runId:'next-run'};
    expect((await journal.applyInputControl(request)).kind).toBe('applied');
    expect((await journal.applyInputControl(request)).kind).toBe('replayed');
    expect(await journal.currentState('seed-run')).toBe('cancelled');
    expect(await journal.currentState('next-run')).toBe('queued');
    expect(oldReads).not.toHaveBeenCalled();
  } finally {oldReads.mockRestore();}
}, 20000);


it('failed tail replay leaves the verified run prefix intact and retries each new fact once', async () => {
  const h = await harness(); await admit(h.journal, 'old artifact '.repeat(5000));
  await h.journal.cancelRun({ runId: 'seed-run', requestId: 'seed-cancel' });
  const reader = h.journalAt(); await reader.primeRecoverySnapshot(await h.log.readSnapshot());
  const add = (id: string, text: string, position: number) => h.journal.admit({ ingressKey: id, runId: id, queuedPosition: position,
    userInput: { parts: [{type: 'text', text}] }, invocation: {kind: 'agent', source: 'interactive'},
    ingress: {kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: id, receivedAt: NOW} });
  await add('tail-inline', 'new inline', 1); await add('tail-artifact', 'new artifact '.repeat(5000), 2);
  const get = h.artifacts.get.bind(h.artifacts); let fail = true;
  const spy = vi.spyOn(h.artifacts, 'get').mockImplementation(async ref => {
    const value = await get(ref);
    expect(value.toString()).not.toContain('old artifact');
    if (fail) { fail = false; throw new StorageMaintenanceAdmissionError({kind:'backpressured', blockedBy:'probe-unavailable', retryAfterMs:1}); }
    return value;
  });
  try {
    await expect(reader.currentState('tail-artifact')).resolves.toBe('queued');
    expect(await reader.currentState('tail-inline')).toBe('queued');
    expect(await reader.currentState('tail-artifact')).toBe('queued');
    expect(await reader.currentState('seed-run')).toBe('cancelled');
  } finally {spy.mockRestore();}
}, 20000);

it('cold control and input pages never hydrate execution history or whole stored inputs', async () => {
  const h = await harness(); const original = '汉😀\n'.repeat(12000); await admit(h.journal, original);
  await h.journal.cancelRun({runId:'seed-run',requestId:'seed-cancel'});
  const reader = h.journalAt();
  const get = vi.spyOn(h.artifacts,'get').mockRejectedValue(Error('whole artifact forbidden'));
  const all = vi.spyOn(h.log,'readSnapshot').mockRejectedValue(Error('whole log forbidden'));
  const ranges = vi.spyOn(h.artifacts,'readRange');
  try {
    const controls = await reader.recoveryPage({mode:'control-page',conversationId:'recovery-conversation'}) as ConversationControlPage;
    expect(controls.facts.some(f => f.kind === 'status' && f.notice.state === 'cancelled')).toBe(true);
    const fact = controls.facts.find(f => f.kind === 'input'); if (fact?.kind !== 'input') throw Error('missing input');
    let page: ConversationInputPage | undefined;
    for (let preparing = 0; preparing < 16; preparing++) {
      page = await reader.recoveryPage({mode:'input-page',conversationId:'recovery-conversation',runId:'seed-run',cursor:fact.cursor}) as ConversationInputPage;
      if (page.input) break;
      expect(page.hasMore).toBe(true); expect(page.cursor).toEqual(fact.cursor);
    }
    if (!page?.input) throw Error('input preparation did not finish');
    expect(original.startsWith(page.input!.text)).toBe(true); expect(page.input!.text.length).toBeGreaterThan(0);
    expect(page.input!.text.length).toBeLessThanOrEqual(8192);
    expect(get).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled();
    expect(Math.max(...ranges.mock.calls.map(call => call[2]))).toBeLessThanOrEqual(65536);
  } finally {get.mockRestore();all.mockRestore();ranges.mockRestore();}
}, 20000);


it.each(['capacity-gap', 'cancelled', 'outer-exclusion'] as const)('does not retry a %s read', async kind => {
  const h = await harness(); await admit(h.journal, 'artifact input '.repeat(5000));
  const reader = h.journalAt();
  const failure = new StorageMaintenanceAdmissionError(kind === 'outer-exclusion'
    ? { kind: 'backpressured', blockedBy: 'probe-unavailable', retryAfterMs: 1 }
    : kind === 'cancelled' ? { kind: 'cancelled' }
    : { kind: 'capacity-gap', blockedBy: 'memoryReservationBytes', required: 1, available: 0 });
  const get = vi.spyOn(h.artifacts, 'get').mockRejectedValue(failure);
  try {
    await expect(kind === 'outer-exclusion'
      ? runHoldingMaintenanceExclusion(() => reader.currentState('seed-run'))
      : reader.currentState('seed-run')).rejects.toBe(failure);
    expect(get).toHaveBeenCalledTimes(1);
  } finally { get.mockRestore(); }
}, 20000);

it('cancels a pressured read without retrying or publishing a partial run view', async () => {
  const h = await harness(); await admit(h.journal, 'artifact input '.repeat(5000));
  const reader = h.journalAt(), abort = new AbortController();
  const get = vi.spyOn(h.artifacts, 'get').mockImplementation(async () => {
    abort.abort();
    throw new StorageMaintenanceAdmissionError({ kind: 'backpressured', blockedBy: 'probe-unavailable', retryAfterMs: 1 });
  });
  try {
    await expect(runWithMaintenanceUrgency(() => 'foreground', abort.signal, () => reader.currentState('seed-run'))).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
  } finally { get.mockRestore(); }
  expect(await reader.currentState('seed-run')).toBe('queued');
}, 20000);

it('reads control chunks once without rescanning the directory for every status record', async () => {
  const h = await harness();
  await admit(h.journal);
  await h.journal.cancelRun({ runId: 'seed-run', requestId: 'seed-cancel' });
  const control = vi.spyOn(ConversationReadIndex.prototype, 'control');
  const status = vi.spyOn(ConversationReadIndex.prototype, 'status');
  const commit = vi.spyOn(ConversationReadIndex.prototype, 'commit');
  try {
    const page = await h.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation' }) as ConversationControlPage;
    expect(page.facts.some(fact => fact.kind === 'status' && fact.notice.state === 'cancelled')).toBe(true);
    expect(page.facts.length).toBeLessThanOrEqual(32);
    expect(status).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    expect(control.mock.calls.every(([, runs]) => runs.length <= 64)).toBe(true);
    expect(control.mock.calls.filter(([, runs]) => runs.length > 0)).toHaveLength(1);
  } finally { control.mockRestore(); status.mockRestore(); commit.mockRestore(); }
});
