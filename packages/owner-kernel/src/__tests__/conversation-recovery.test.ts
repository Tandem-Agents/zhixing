import path from 'node:path';
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog } from '@zhixing/core/authority';
import type { ConversationControlCursor, ConversationControlPage, ConversationInputCursor, ConversationInputPage, Signature } from '@zhixing/core/contracts';
import { protocolDigest, canonicalize, createConversationSealedBundle } from '@zhixing/core/protocol';
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
async function harness(startupProofs = false) {
  const root = await createTempDir('conversation-recovery');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, 'log'), artifacts, { clock: () => NOW,
    ...(startupProofs ? { integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 29)) } : {}) }));
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

it('prepares overlapping cancellations in owner order without discarding a completed working set', async () => {
  const h = await harness(true);
  await admit(h.journal);
  await h.journal.admit({ ingressKey: 'next-ingress', runId: 'next-run', queuedPosition: 1,
    userInput: { parts: [{ type: 'text', text: 'next input' }] }, invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: 'next-ingress', receivedAt: NOW,
      turnOrigin: { channel: 'rpc', messageIdentity: { id: 'next-message', source: { kind: 'conversation', conversationId: 'source-conversation' } } } } });
  const original = h.log.transactDurableProjection.bind(h.log);
  let selections = 0;
  let second: Promise<unknown> | undefined;
  const observe = vi.spyOn(h.log, 'transactDurableProjection').mockImplementation((async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (args[0] === 'conversation-run-state-v1' && result.value && typeof result.value === 'object' && 'metadata' in result.value) {
      selections++;
      // A second command arrives after the first has read its prefix, before
      // it has returned to the journal to decide. It must wait its owner turn.
      second ??= h.journal.cancelRun({ runId: 'next-run', requestId: 'cancel-next' });
    }
    return result;
  }) as typeof original);
  try {
    await h.journal.cancelRun({ runId: 'seed-run', requestId: 'cancel-first' });
    expect(second).toBeDefined();
    await second;
    expect(selections).toBe(2);
  } finally { observe.mockRestore(); }
  expect(await h.journal.runState('seed-run')).toBe('cancelled');
  expect(await h.journal.runState('next-run')).toBe('cancelled');
}, 30_000);

it('reads current interruptible identities without historical inputs or run replay, and observes cancellation', async () => {
  const h = await harness(true);
  for (let n = 0; n < 40; n++) {
    await h.journal.admit({ ingressKey: 'old-' + n, runId: 'old-' + n, queuedPosition: n,
      userInput: { parts: [{ type: 'text', text: 'historical body '.repeat(100) }] }, invocation: { kind: 'agent', source: 'interactive' },
      ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: 'old-' + n, receivedAt: NOW,
        turnOrigin: { channel: 'rpc', messageIdentity: { id: 'old-' + n, source: { kind: 'conversation', conversationId: 'source-conversation' } } } } });
    await h.journal.cancelRun({ runId: 'old-' + n, requestId: 'cancel-' + n });
  }
  await admit(h.journal);
  const replay = vi.spyOn(h.log, 'readProjection').mockRejectedValue(Error('Current controls must not replay a run'));
  const bodies = vi.spyOn(h.artifacts, 'get').mockRejectedValue(Error('Current controls must not read input bodies'));
  try {
    expect(await h.journal.recoveryPage({ mode: 'control-targets', conversationId: 'recovery-conversation' }))
      .toEqual({ targets: [{ runId: 'seed-run', state: 'queued' }] });
    expect(replay).not.toHaveBeenCalled(); expect(bodies).not.toHaveBeenCalled();
  } finally { replay.mockRestore(); bodies.mockRestore(); }
  await h.journalAt().cancelRun({ runId: 'seed-run', requestId: 'current-cancel' });
  expect(await h.journal.recoveryPage({ mode: 'control-targets', conversationId: 'recovery-conversation' })).toEqual({ targets: [] });
}, 30_000);

it('restores keyed closed state without scalar checkpoints or closed input bodies, including stop', async () => {
  const h = await harness(true), text = 'large closed input '.repeat(10000);
  const saves = vi.spyOn(h.log, 'saveProjectionCheckpoint');
  await admit(h.journal, text);
  await h.journal.cancelRun({ runId: 'seed-run', requestId: 'close-large-input' });
  await h.log.stopStorageMaintenance();
  expect(saves.mock.calls.filter(([key]) => key.startsWith('conversation-'))).toEqual([]);
  const coldLog = trackAuthorityLog(new FileAuthorityCommitLog(h.log.rootDir, h.artifacts,
    { clock: () => NOW, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 29)) }));
  const restored = new ConversationRunJournal({ conversationId: 'recovery-conversation', ownerEpoch: 1, log: coldLog, artifacts: h.artifacts,
    signer, verifier, submission: { authenticate() {}, authorize() {} }, authority: { decideAtPrefix: () => ({ committed: true, commitRevision: 1 }) },
    projection: { async project() {} }, clock: () => NOW });
  const bodies = vi.spyOn(h.artifacts, 'get').mockRejectedValue(Error('closed input body forbidden'));
  const scalar = vi.spyOn(coldLog, 'loadProjectionCheckpoint').mockRejectedValue(Error('scalar history forbidden'));
  const snapshot = vi.spyOn(coldLog, 'readSnapshot').mockRejectedValue(Error('whole replay forbidden'));
  try {
    expect(await restored.restoreRecoveryCheckpoint()).toBe(true);
    expect(await restored.runState('seed-run')).toBe('cancelled');
    await admit(restored, text);
    await coldLog.stopStorageMaintenance();
    expect(bodies).not.toHaveBeenCalled(); expect(scalar).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled();
  } finally { bodies.mockRestore(); scalar.mockRestore(); snapshot.mockRestore(); saves.mockRestore(); }
}, 30000);

it('discards a private indexed working set after a failed read', async () => {
  const target = await harness(); await admit(target.journal);
  const original = target.log.transactDurableProjection.bind(target.log);
  let injected = false;
  const read = vi.spyOn(target.log, 'transactDurableProjection').mockImplementation((id, decide, options) =>
    original(id, async (current, context) => {
      const decision = await decide(current, context);
      // The indexed read prepares a private working set and only publishes it
      // after the transaction. Fail after the read, before publication; the
      // next query must rebuild from the authoritative 'queued' state.
      if (!injected && id === 'conversation-run-state-v1') {
        injected = true;
        throw Error('private replay interrupted before publication');
      }
      return decision;
    }, options));
  try { await expect(target.journal.runState('seed-run')).rejects.toThrow('private replay interrupted'); }
  finally { read.mockRestore(); }
  expect(injected).toBe(true);
  expect(await target.journal.runState('seed-run')).toBe('queued');
  // A newer authoritative transition proves the failed private working set was
  // discarded rather than reused: a stale cursor or cached view would still
  // answer 'queued' for a run that has since been cancelled.
  await target.journal.cancelRun({ runId: 'seed-run', requestId: 'cancel-after-private-failure' });
  expect(await target.journal.runState('seed-run')).toBe('cancelled');
});

it('only admits the earliest unfinished input to assignment scheduling', async () => {
  const h = await harness(); await admit(h.journal);
  await h.journal.admit({ ingressKey: 'second-ingress', runId: 'second-run', queuedPosition: 1,
    userInput: { parts: [{ type: 'text', text: 'second' }] }, invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: 'second-ingress', receivedAt: NOW } });
  for (const [id, position] of [['third', 2], ['fourth', 3]] as const) {
    await h.journal.admit({ ingressKey: id, runId: id, queuedPosition: position,
      userInput: { parts: [{ type: 'text', text: id }] }, invocation: { kind: 'agent', source: 'interactive' },
      ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: id, receivedAt: NOW } });
  }
  expect(await h.journal.isReadyForAssignment('seed-run')).toBe(true);
  expect(await h.journal.isReadyForAssignment('second-run')).toBe(false);
  await h.journal.cancelRun({ runId: 'seed-run', requestId: 'release-first-input' });
  expect((await h.journal.pendingInputs()).map(input => input.runId)).toEqual(['second-run', 'third', 'fourth']);
  expect(await h.journal.isReadyForAssignment('second-run')).toBe(true);
  expect(await h.journal.isReadyForAssignment('missing')).toBe(false);
});

it('cold message queries use the actual owner directory and imported base without full execution replay', async () => {
  const h = await harness(); await admit(h.journal);
  await h.journal.cancelRun({ runId: 'seed-run', requestId: 'cancel-message-query' });
  const expected = { runId: 'seed-run', state: 'cancelled', consumed: false, disposition: 'stopped' };
  const records = (await h.log.readSnapshot()).commits.flatMap(envelope =>
    envelope.entries.map(record => ({ ...record, lsn: envelope.lsn, at: envelope.at })));
  const snapshot = vi.spyOn(h.log, 'readSnapshot').mockRejectedValue(Error('full execution replay forbidden'));
  const get = vi.spyOn(h.artifacts, 'get').mockRejectedValue(Error('execution artifact read forbidden'));
  try {
    const cold = h.journalAt();
    expect(await cold.messageStatus('seed-message')).toMatchObject(expected);
    expect(await cold.messageInputsOutsideHistory()).toMatchObject({ inputs: [expected], truncated: false });
    expect(cold.hasRecoveredInputProjection).toBe(false);
    const target = await harness(); await target.journal.primeImportedReadBase(records as any);
    expect(await target.journal.messageStatus('seed-message')).toMatchObject(expected);
    expect(await target.journal.messageInputsOutsideHistory()).toMatchObject({ inputs: [expected] });
    expect(get).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled();
  } finally { get.mockRestore(); snapshot.mockRestore(); }
});

describe('finite owner recovery pages', () => {
  it('installs empty and sparse recovery views without syncing unrelated resource slices', async () => {
    const h = await harness();
    const coordinate = vi.spyOn(h.resources, 'coordinate');
    const empty = h.journalAt(); await empty.primeRecoverySnapshot(await h.log.readSnapshot());
    expect(empty.hasRecoveredInputProjection).toBe(true);
    // Storage-level sparse envelopes, not malformed run protocol records.
    await readerFixtureWriter(h).append(Array.from({length: 4096}, (_, i) => ({stream: 'job:unrelated', body: {v: 1, index: i}})));
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

  it.each(['conversation', 'legacy-local'] as const)('recovers more than 200 old cancelled %s inputs and advances inside one authority envelope', async origin => {
    const source = await harness(); await admit(source.journal);
    await source.journal.cancelRun({ runId: 'seed-run', requestId: 'seed-cancel' });
    const template = (await source.log.readAll()).flatMap(envelope => envelope.entries);
    const target = await harness();
    const entries = Array.from({ length: 205 }, (_, index) => template.map(entry => {
      const record = JSON.parse(JSON.stringify(entry).replaceAll('seed-', `case-${index}-`));
      if (record.body.t === 'admitted') {
        record.body.queuedPosition = index;
        if (origin === 'legacy-local') delete record.body.ingress.turnOrigin.messageIdentity;
      }
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
        expect(input.input?.identity.source.kind).toBe(origin === 'legacy-local' ? 'user' : 'conversation');
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
      ? runHoldingMaintenanceExclusion(() => reader.pendingInputs())
      : reader.pendingInputs()).rejects.toBe(failure);
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
    await expect(runWithMaintenanceUrgency(() => 'foreground', abort.signal, () => reader.pendingInputs())).rejects.toThrow();
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
    expect(control.mock.calls.every(([, runs]) => runs.length <= 63)).toBe(true);
    expect(control.mock.calls.filter(([, runs]) => runs.length > 0)).toHaveLength(1);
  } finally { control.mockRestore(); status.mockRestore(); commit.mockRestore(); }
});

 it.each([false, true])('keeps the authoritative continuation origin of a cancelled run: %s', async continuation => {
  const h = await harness();
  await h.journal.admit({ ingressKey: 'origin-ingress', runId: 'origin-run', queuedPosition: 0,
    userInput: { parts: [{ type: 'text', text: 'cancelled input' }] }, invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: 'origin-ingress', receivedAt: NOW,
      turnOrigin: { channel: 'rpc', messageIdentity: { id: 'origin-message', source: { kind: 'user' } },
        ...(continuation ? { worksceneContinuation: { kind: 'result', conversationId: 'ws:test:primary', runId: 'child' } } : {}) } } });
  await h.journal.cancelRun({ runId: 'origin-run', requestId: 'cancel-origin' });
  const page = await h.journalAt().recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation' }) as ConversationControlPage;
  expect(page.facts.filter(fact => fact.kind === 'status')).toEqual([expect.objectContaining({
    continuation, communication: false, notice: expect.objectContaining({ state: 'cancelled', ref: expect.objectContaining({ runId: 'origin-run' }) }),
  })]);
});

it('skips unrelated authority envelopes while keeping a complete bounded control cursor', async () => {
  const h = await harness(); await admit(h.journal);
  for (let i = 0; i < 70; i++) await readerFixtureWriter(h).append([{ stream: 'job:unrelated', body: { n: i } }]);
  await h.journal.cancelRun({ runId: 'seed-run', requestId: 'sparse-cancel' });
  for (let i = 0; i < 70; i++) await readerFixtureWriter(h).append([{ stream: 'job:unrelated', body: { n: i + 70 } }]);
  const wholeTail = vi.spyOn(h.log, 'readTail'), selected = vi.spyOn(h.log, 'readEnvelopesAt');
  try {
    const page = await h.journalAt().recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation' }) as ConversationControlPage;
    expect(page.hasMore).toBe(false); expect(page.cursor.after).toEqual(page.cursor.upper);
    expect(page.facts.some(fact => fact.kind === 'input')).toBe(true);
    expect(page.facts.some(fact => fact.kind === 'status' && fact.notice.state === 'cancelled')).toBe(true);
    expect(wholeTail).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledOnce(); expect(selected.mock.calls[0]![0].length).toBeLessThanOrEqual(4);
  } finally { wholeTail.mockRestore(); selected.mockRestore(); }
}, 20000);

it('verifies the incoming recovery checkpoint even when using indexed envelopes', async () => {
  const h = await harness(); await admit(h.journal);
  const first = await h.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation' }) as ConversationControlPage;
  await h.journal.cancelRun({ runId: 'seed-run', requestId: 'checkpoint-cancel' });
  for (const changed of [{ frameEndOffset: first.cursor.after.frameEndOffset + 1 }, { prefixDigest: 'sha256:' + '0'.repeat(64) }]) {
    const cursor = { ...first.cursor, after: { ...first.cursor.after, ...changed } };
    await expect(h.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', cursor })).rejects.toThrow();
  }
});


it('indexes final-outbox locators using their own contract after reopening completed history', async () => {
  const root = await createTempDir('final-control-locator');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, 'log'), artifacts, { clock: () => NOW }));
  const final = { t: 'final', conversationId: 'recovery-conversation', runId: 'finished-run', commitRevision: 1,
    digest: 'sha256:' + '1'.repeat(64), state: 'pending' };
  await log.append([{ stream: 'final-outbox', body: final }]);
  const boundary = await log.checkpoint();
  const directory = new ConversationReadIndex(log, artifacts, verifier);
  expect(await directory.controlPage('recovery-conversation', 0)).toEqual([boundary]);
  expect(await directory.controlPage('unrelated-conversation', 0)).toEqual([]);
  // Locators never bypass the final record shape contract.
  await expect(log.append([{ stream: 'final-outbox', body: { ...final, state: 'unknown' } }])).rejects.toThrow('Final outbox state is invalid');
});


it('fits the maximum control chunk into one 256-key authority read', async () => {
  const h = await harness();
  const directory = new ConversationReadIndex(h.log, h.artifacts, verifier);
  const read = vi.spyOn(directory.index, 'getMany');
  const runs = Array.from({ length: 63 }, (_, index) => 'run-' + index);
  expect((await directory.control('recovery-conversation', runs)).size).toBe(63);
  expect(read).toHaveBeenCalledOnce(); expect(read.mock.calls[0]![0]).toHaveLength(253);
  await expect(directory.control('recovery-conversation', [...runs, 'overflow'])).rejects.toThrow('exceeds 63 runs');
});


async function timelineFixture() {
  const h = await harness(); await admit(h.journal, 'cancel-early');
  await h.journal.cancelRun({ runId: 'seed-run', requestId: 'early-cancel' });
  const seed = (await h.log.readAll()).flatMap(envelope => envelope.entries).find(entry => (entry.body as any).t === 'admitted')!;
  const add = async (id: string, text: string, position: number) => {
    const body = structuredClone(seed.body) as any;
    body.runId = id; body.ingressKey = id; body.ingress.ingressId = id;
    body.ingress.turnOrigin.messageIdentity.id = id; body.queuedPosition = position;
    body.input = { parts: [{ type: 'text', text }] };
    await readerFixtureWriter(h).append([{ stream: seed.stream, body }]);
  };
  const commit = async (id: string, text: string, revision: number) => {
    const bundle = await h.artifacts.put(Buffer.from(canonicalize(createConversationSealedBundle({ assignmentId: 'assignment-' + id, executorId: 'executor-test',
      streamFinal: { finalSeq: 1, streamDigest: 'sha256:' + '0'.repeat(64) }, usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      usageFinal: { reportDigest: 'sha256:' + '0'.repeat(64), upToUsageSeq: 0 }, dependencyArtifacts: [], body: {
      t: 'conversation', ownerEpoch: 1, runId: id, conversationId: 'recovery-conversation', baseRevision: revision - 1,
      runRecord: { type: 'run', timestamp: NOW, runId: id, runIndex: revision - 1, messages: [
        { role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: 'reply-' + id }] },
      ] }, contentAssets: [],
    } }))));
    await readerFixtureWriter(h).append([{ stream: seed.stream, body: { t: 'committed', runId: id, assignmentId: 'assignment-' + id, bundle: { ref: bundle }, commitRevision: revision } }]);
  };
  await add('success-2', 'success-2', 1); await commit('success-2', 'success-2', 1);
  await add('cancel-3', 'cancel-3', 2);
  await add('success-4', 'success-4', 3); await commit('success-4', 'success-4', 2);
  return { ...h, add, commit };
}
type BodyPage = import('@zhixing/core/contracts').ConversationBodyPage;
type BodyCursor = import('@zhixing/core/contracts').ConversationBodyCursor;
async function timelinePages(journal: ConversationRunJournal, terminalCursor = false) {
  let cursor: BodyCursor | undefined;
  const fragments: import('@zhixing/core/contracts').ConversationBodyFragment[] = [];
  for (let i = 0; i < 150; i++) {
    const page = await journal.recoveryPage({ mode: 'body-page', conversationId: 'recovery-conversation', includeInputs: true, cursor }) as BodyPage;
    expect(page.reset).toBe(false); expect(page.fragments.length).toBeLessThanOrEqual(4);
    fragments.push(...page.fragments);
    if (!page.hasMore) return fragments;
    cursor = terminalCursor && page.fragments.length ? page.fragments.at(-1)!.cursor : page.cursor;
  }
  throw Error('history did not terminate');
}
it.each([false, true])('orders cancelled inputs and successful bodies once after restart, including terminal source cursors (%s)', async terminalCursor => {
  const h = await timelineFixture(), cold = h.journalAt();
  const first = await cold.recoveryPage({ mode: 'body-page', conversationId: 'recovery-conversation', includeInputs: true }) as BodyPage;
  expect(first.fragments.map(f => f.text)).toEqual(['reply-success-4', 'success-4', 'cancel-3', 'reply-success-2']);
  const fragments = await timelinePages(cold, terminalCursor);
  expect(fragments.map(f => f.text).reverse()).toEqual(['cancel-early', 'success-2', 'reply-success-2', 'cancel-3', 'success-4', 'reply-success-4']);
  expect(first.historyThrough?.lsn).toBe(first.historyThroughInputLsn);
  const page = await cold.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', historyThrough: first.historyThrough }) as ConversationControlPage;
  expect(page.facts.filter(f => f.kind === 'input')).toEqual([]);
  expect(page.cursor.historyThroughCommitRevision).toBe(2);
  // 边界之前的运行都已结束，由历史覆盖，不再下发状态事实
  expect(page.facts.filter(f => f.kind === 'status')).toEqual([]);
  await h.add('live-remote', 'arrived after history opened', 4);
  const live = await cold.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', cursor: page.cursor }) as ConversationControlPage;
  expect(live.facts.filter(f => f.kind === 'input').map(f => f.cursor.runId)).toEqual(['live-remote']);
  expect(fragments.every(f => f.cursor.history?.throughLsn === first.historyThroughInputLsn)).toBe(true);
}, 20000);

it('range-reads an uncovered large input, replays its source, and resets it after clear/delete', async () => {
  const h = await harness(), text = '汉😀\n'.repeat(12000); await admit(h.journal, text);
  await h.journal.cancelRun({ runId: 'seed-run', requestId: 'cancel-large' });
  const cold = h.journalAt(), get = vi.spyOn(h.artifacts, 'get').mockRejectedValue(Error('whole body read forbidden'));
  const all = vi.spyOn(h.log, 'readSnapshot').mockRejectedValue(Error('whole replay forbidden'));
  try {
    const fragments = await timelinePages(cold, true);
    expect(fragments.map(f => f.text).reverse().join('')).toBe(text);
    const source = fragments.at(-1)!;
    const replay = await cold.recoveryPage({ mode: 'body-page', conversationId: 'recovery-conversation', cursor: source.cursor, runId: source.runId, direction: 'forward' }) as BodyPage;
    expect(replay.fragments[0]?.offset).toBe(0); expect(text.startsWith(replay.fragments[0]!.text)).toBe(true);
    expect(get).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled();
    await h.log.append([{ stream: 'run:recovery-conversation', body: { t: 'session-lifecycle', mutation: 'clear', domainRevision: 1, requestId: 'clear-history' } }]);
    expect(await cold.recoveryPage({ mode: 'body-page', conversationId: 'recovery-conversation', cursor: source.cursor, includeInputs: true })).toMatchObject({ reset: true, fragments: [] });
    expect(await timelinePages(cold)).toEqual([]);
    await h.log.append([{ stream: 'run:recovery-conversation', body: { t: 'session-lifecycle', mutation: 'delete', domainRevision: 2, requestId: 'delete-history' } }]);
    expect(await cold.recoveryPage({ mode: 'body-page', conversationId: 'recovery-conversation', includeInputs: true })).toMatchObject({ reset: true, hasMore: false, fragments: [] });
  } finally { get.mockRestore(); all.mockRestore(); }
}, 20000);

it('merges imported history before local records and keeps source replay stable across a late commit', async () => {
  const source = await timelineFixture(), target = await harness();
  const snapshot = await source.log.readSnapshot();
  for (const ref of await source.log.retainedArtifactReferences()) {
    await target.artifacts.put(await source.artifacts.get(ref));
  }
  const base = snapshot.commits.flatMap(envelope => envelope.entries.map(record => ({ ...record, lsn: envelope.lsn, at: envelope.at })));
  await target.journal.primeImportedReadBase(base as any);
  expect((await timelinePages(target.journal)).map(f => f.text).reverse()).toEqual(['cancel-early', 'success-2', 'reply-success-2', 'cancel-3', 'success-4', 'reply-success-4']);
  const first = await target.journal.recoveryPage({ mode: 'body-page', conversationId: 'recovery-conversation', includeInputs: true }) as BodyPage;
  expect(first.historyThroughInputLsn).toBe(0);
  const original = (await timelinePages(source.journalAt())).find(f => f.runId === 'cancel-3')!;
  await source.commit('cancel-3', 'cancel-3', 3);
  const replay = await source.journalAt().recoveryPage({ mode: 'body-page', conversationId: 'recovery-conversation', cursor: original.cursor, runId: original.runId, direction: 'forward' }) as BodyPage;
  expect(replay.fragments[0]?.text).toBe('cancel-3');
}, 20000);

/** Partial directory/timeline schemas are seeded independently of the complete
 * execution protocol (covered by assignment-ledger.test.ts). Never use these
 * synthetic entries as product-write or history-growth evidence. */
const readerFixtureWriters = new WeakMap<FileAuthorityCommitLog, FileAuthorityCommitLog>();
function readerFixtureWriter(h: { log: FileAuthorityCommitLog; artifacts: FileArtifactStore }) {
  let writer = readerFixtureWriters.get(h.log);
  if (!writer) { writer = trackAuthorityLog(new FileAuthorityCommitLog(h.log.rootDir, h.artifacts, { clock: () => NOW })); readerFixtureWriters.set(h.log, writer); }
  return writer;
}
