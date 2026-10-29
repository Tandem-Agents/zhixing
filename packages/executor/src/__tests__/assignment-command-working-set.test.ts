// test-source: isolate
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { AuthorityCacheIntegrity, FileAuthorityCommitLog, type AuthorityCommitLog } from '@zhixing/core/authority';
import { canonicalize, protocolDigest } from '@zhixing/core/protocol';
import { ConversationRunJournal, ConversationAssignmentCancelledError } from '@zhixing/owner-kernel/conversation-assignment';
import { channelSurfacePrincipal } from '@zhixing/owner-kernel/control-admission';
import { captureFileIo } from '@zhixing/test-utils';
import { observeProjectionQueryWork } from '../../../core/src/test-support/projection-query-work.js';
import { InProcessAssignmentSubmission } from '../assignment-ledger.js';
import { createHarness, createUnsignedEnvelope, sealDefaultBundle, submissionContext, ownerContext,
  deliveryParticipant, submission, createRevocationAwareSubmission, ingress, NOW, CONVERSATION_ID, RUN_ID, ASSIGNMENT_ID } from './assignment-ledger-fixture.js';

const scopeMode = vi.hoisted(() => ({ log: undefined as object | undefined, mode: 'native' as 'native' | 'wide' | 'narrow' }));
vi.mock('../../../owner-kernel/src/conversation-run-state-view.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../owner-kernel/src/conversation-run-state-view.js')>();
  return { ...actual, prepareConversationRunView: (options: Parameters<typeof actual.prepareConversationRunView>[0]) =>
    actual.prepareConversationRunView(scopeMode.log === options.log && scopeMode.mode !== 'native'
      ? { ...options, scope: { ...options.scope, current: scopeMode.mode === 'wide' } } : options) };
});

const NEXT_RUN = 'run-next', NEXT_ASSIGNMENT = 'assignment-next';
const integrity = () => new AuthorityCacheIntegrity(Buffer.alloc(32, 83));
type Command = 'reportStarted' | 'openRunInput' | 'assign';

function atCurrentRevision(original: ReturnType<typeof createUnsignedEnvelope>) {
  const { digest: _digest, ...prior } = original.manifest;
  const manifest = { ...prior, baseRef: { ...prior.baseRef, baseRevision: 8 } };
  return { ...original, manifest: { ...manifest, digest: protocolDigest('ExecutionManifest', 1, manifest) }, work: { ...original.work, baseRevision: 8 } };
}

async function fixture(command: Command, options: { earlierQueued?: boolean; channel?: boolean; submission?: typeof submission } = {}) {
  const h = await createHarness({ integrity: integrity(), ...(options.submission ? { submission: options.submission } : {}) });
  const adapter = new InProcessAssignmentSubmission({ ledger: h.ledger, owner: h.journal });
  expect(await h.ledger.dispatch(h.dispatch.envelope, h.dispatch.activation, ownerContext(ASSIGNMENT_ID, 'executor.dispatch')))
    .toMatchObject({ accepted: true });
  await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(h.unsigned));
  await sealDefaultBundle(h.ledger, 'previous complete reply');
  expect(await adapter.submitSealedBundle(ASSIGNMENT_ID, submissionContext(h.unsigned)))
    .toMatchObject({ committed: true, commitRevision: 8 });
  expect(await h.journal.runState(RUN_ID)).toBe('committed');

  const nextIngress = options.channel ? { kind: 'channel' as const, surfacePrincipal: channelSurfacePrincipal({ channelId: 'feishu', platformSubject: 'user-1' }), responder: { channelId: 'feishu', platformSubject: 'user-1' }, replyTarget: { channelId: 'feishu', to: 'chat-1' }, deviceId: 'device-1', ingressId: 'ingress-next', receivedAt: NOW } : { ...ingress(), ingressId: 'ingress-next' };
  if (options.earlierQueued) await h.journal.admit({ ingressKey: 'surface:user-1/earlier', runId: 'earlier-run', userInput: { parts: [{ type: 'text', text: 'earlier' }] }, ingress: { ...ingress(), ingressId: 'earlier' }, invocation: { kind: 'agent', source: 'interactive' }, queuedPosition: 1 });
  await h.journal.admit({ ingressKey: nextIngress.surfacePrincipal + '/ingress-next', runId: NEXT_RUN,
    userInput: { parts: [{ type: 'text', text: 'next input' }] }, ingress: nextIngress,
    invocation: { kind: 'agent', source: 'interactive' }, queuedPosition: options.earlierQueued ? 2 : 1 });
  const original = createUnsignedEnvelope(h.identity, { runId: NEXT_RUN, assignmentId: NEXT_ASSIGNMENT, ingress: nextIngress });
  const unsigned = atCurrentRevision(original);
  if (command !== 'assign') {
    const dispatch = await h.journal.assign(unsigned);
    expect(await h.ledger.dispatch(dispatch.envelope, dispatch.activation, ownerContext(NEXT_ASSIGNMENT, 'executor.dispatch')))
      .toMatchObject({ accepted: true });
    await h.ledger.start(NEXT_ASSIGNMENT);
    if (command === 'openRunInput') await h.journal.reportStarted(NEXT_ASSIGNMENT, submissionContext(unsigned));
  }
  await h.log.stopStorageMaintenance();
  const log = new FileAuthorityCommitLog(h.log.rootDir, h.artifacts, { clock: () => NOW, integrity: integrity(), lockWaitMs: 2000 });
  onTestFinished(() => log.stopStorageMaintenance());
  const deliveryInputs: unknown[] = [];
  const journalAt = (sourceLog = log) => {
    const delivery = deliveryParticipant(sourceLog), prepare = delivery.prepareConversationStatuses.bind(delivery);
    delivery.prepareConversationStatuses = async (...args) => { deliveryInputs.push(...structuredClone(args[0])); return prepare(...args); };
    return new ConversationRunJournal({ conversationId: CONVERSATION_ID, ownerEpoch: 3, log: sourceLog,
      artifacts: h.artifacts, signer: h.identity, verifier: h.identity, authority: h.authority, projection: h.projection,
      delivery, submission: options.submission ?? submission, clock: () => NOW });
  };
  const journal = journalAt();
  // The Host's source readiness is established before commands; this does not
  // restore the journal's full input working set.
  await log.prepareProjections(undefined, 'command-difference-ready');
  expect(journal.hasRecoveredInputProjection).toBe(false);
  return { ...h, log, journal, journalAt, unsigned, deliveryInputs };
}

async function invoke(h: Awaited<ReturnType<typeof fixture>>, command: Command) {
  if (command === 'reportStarted') return h.journal.reportStarted(NEXT_ASSIGNMENT, submissionContext(h.unsigned));
  if (command === 'openRunInput') { const input = await h.journal.openRunInput(NEXT_RUN, NEXT_ASSIGNMENT); return { receive: typeof input.receive, close: typeof input.close }; }
  return h.journal.assign(h.unsigned);
}

async function measured(h: Awaited<ReturnType<typeof fixture>>, command: Command, mode: 'wide' | 'narrow' | 'native') {
  const before = (await h.log.checkpoint()).lsn, notices: unknown[] = [];
  const unsubscribe = h.journal.onStatus(notice => { notices.push(notice); });
  const work = observeProjectionQueryWork(h.log as AuthorityCommitLog);
  const io = await captureFileIo(h.root);
  scopeMode.log = h.log; scopeMode.mode = mode;
  let value: unknown;
  try { value = await invoke(h, command); }
  finally { scopeMode.log = undefined; scopeMode.mode = 'native'; work.restore(); }
  const counts = work.snapshot(), physical = io.snapshot(), recovered = h.journal.hasRecoveredInputProjection, deliveryInputs = structuredClone(h.deliveryInputs);
  await Promise.resolve(); unsubscribe();
  const entries = (await h.log.readAll()).filter(e => e.lsn > before).flatMap(e => e.entries);
  const replayBefore = (await h.log.checkpoint()).lsn;
  scopeMode.log = h.log; scopeMode.mode = mode;
  try { await invoke(h, command); } finally { scopeMode.log = undefined; scopeMode.mode = 'native'; }
  expect((await h.log.checkpoint()).lsn).toBe(replayBefore);
  if (command === 'openRunInput') { const port = await h.journal.openRunInput(NEXT_RUN, NEXT_ASSIGNMENT); expect(await port.receive({ boundary: 1, closing: false })).toEqual([]); await port.close(); }
  await h.log.stopStorageMaintenance();
  const coldLog = new FileAuthorityCommitLog(h.log.rootDir, h.artifacts, { clock: () => NOW, integrity: integrity(), lockWaitMs: 2000 });
  onTestFinished(() => coldLog.stopStorageMaintenance());
  const cold = { ...h, log: coldLog, journal: h.journalAt(coldLog) }, coldBefore = (await coldLog.checkpoint()).lsn;
  if (command === 'openRunInput') await expect(invoke(cold, command)).rejects.toThrow('Run input is already closed');
  else await invoke(cold, command);
  expect((await coldLog.checkpoint()).lsn).toBe(coldBefore);
  const state = await cold.journal.runState(NEXT_RUN);
  await coldLog.stopStorageMaintenance();
  return { value, entries, notices, state, counts, physical, recovered, deliveryInputs };
}

describe('exact command working set', { timeout: 60_000 }, () => {
  it.each(['reportStarted', 'openRunInput', 'assign'] as const)('preserves the full %s result and effects while reducing preparation reads', async command => {
    const wide = await measured(await fixture(command), command, 'wide');
    const narrow = await measured(await fixture(command), command, 'native');
    expect(narrow.value).toEqual(wide.value);
    expect(canonicalize(narrow.entries)).toBe(canonicalize(wide.entries));
    expect(narrow.notices).toEqual(wide.notices);
    expect(narrow.state).toBe(wide.state);
    expect(narrow.counts.keys).toBeLessThan(wide.counts.keys);
    expect(narrow.physical.readBytes).toBeLessThan(wide.physical.readBytes);
    expect(narrow.physical.writeBytes).toBe(wide.physical.writeBytes);
    expect(narrow.recovered).toBe(false);
    expect(narrow.counts.scans).toBeLessThan(wide.counts.scans);
    console.log('command-workset-difference', JSON.stringify({ command, wide: { counts: wide.counts, physical: wide.physical, recovered: wide.recovered },
      narrow: { counts: narrow.counts, physical: narrow.physical, recovered: narrow.recovered } }));
  });
  it('does not treat a partial started-command result as a recovered input projection', async () => {
    const h = await fixture('reportStarted');
    scopeMode.log = h.log; scopeMode.mode = 'native';
    try { await invoke(h, 'reportStarted'); } finally { scopeMode.log = undefined; scopeMode.mode = 'native'; }
    expect(h.journal.hasRecoveredInputProjection).toBe(false);
    expect(await h.journal.restoreRecoveryCheckpoint()).toBe(true);
    expect(h.journal.hasRecoveredInputProjection).toBe(true);
  });
  it('preserves channel status decision inputs and notices for the exact started command', async () => {
    const wide = await measured(await fixture('reportStarted', { channel: true }), 'reportStarted', 'wide');
    const narrow = await measured(await fixture('reportStarted', { channel: true }), 'reportStarted', 'native');
    expect(canonicalize(narrow.entries)).toBe(canonicalize(wide.entries));
    expect(narrow.entries).toHaveLength(1); // Running has a status notice, not a separate channel message.
    expect(narrow.deliveryInputs).toEqual(wide.deliveryInputs);
    expect(narrow.deliveryInputs).toEqual(expect.arrayContaining([expect.objectContaining({ runId: NEXT_RUN, state: 'running', ingress: expect.objectContaining({ kind: 'channel', ingressId: 'ingress-next', replyTarget: { channelId: 'feishu', to: 'chat-1' } }) })]));
    expect(narrow.notices).toEqual(wide.notices);
    expect(narrow.notices.length).toBeGreaterThan(0);
    expect(narrow.counts.keys).toBeLessThan(wide.counts.keys);
  });

  it('retains an already complete input basis without publishing a local replacement', async () => {
    const h = await fixture('reportStarted');
    await h.journal.restoreRecoveryCheckpoint();
    expect(h.journal.hasRecoveredInputProjection).toBe(true);
    await invoke(h, 'reportStarted');
    expect(h.journal.hasRecoveredInputProjection).toBe(true);
    expect(await h.journal.runState(NEXT_RUN)).toBe('running');
    expect(await h.journal.recentExecutorAffinity()).toBe('executor-1');
  });

  it('does not publish a failed preparation or append an unvalidated started fact', async () => {
    const h = await fixture('reportStarted'), before = (await h.log.checkpoint()).lsn;
    const original = h.log.transactDurableProjection.bind(h.log);
    let failed = false;
    const spy = vi.spyOn(h.log, 'transactDurableProjection').mockImplementation((async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (!failed && result.value && typeof result.value === 'object' && 'metadata' in result.value) {
        failed = true; throw Error('working set response unavailable');
      }
      return result;
    }) as typeof original);
    try { await expect(invoke(h, 'reportStarted')).rejects.toThrow('working set response unavailable'); }
    finally { spy.mockRestore(); }
    expect(failed).toBe(true);
    expect((await h.log.checkpoint()).lsn).toBe(before);
    expect(h.journal.hasRecoveredInputProjection).toBe(false);
    await invoke(h, 'reportStarted');
    expect(await h.journal.runState(NEXT_RUN)).toBe('running');
  });

  it('replays a committed started fact after its response is lost without a second append', async () => {
    const h = await fixture('reportStarted');
    const original = h.log.transactProjection.bind(h.log);
    let lost = false;
    const spy = vi.spyOn(h.log, 'transactProjection').mockImplementation((async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (!lost && result.commit) { lost = true; throw Error('committed response lost'); }
      return result;
    }) as typeof original);
    try { await expect(invoke(h, 'reportStarted')).rejects.toThrow('committed response lost'); }
    finally { spy.mockRestore(); }
    expect(lost).toBe(true);
    expect(h.journal.hasRecoveredInputProjection).toBe(false);
    const after = (await h.log.checkpoint()).lsn;
    await invoke(h, 'reportStarted');
    expect((await h.log.checkpoint()).lsn).toBe(after);
    expect((await h.journal.statusHistory(NEXT_RUN, 0)).at(-1)).toMatchObject({ state: 'running' });
  });

  it('rechecks the source version when another journal cancels after preparation', async () => {
    const h = await fixture('reportStarted');
    const otherLog = new FileAuthorityCommitLog(h.log.rootDir, h.artifacts, { clock: () => NOW, integrity: integrity(), lockWaitMs: 2000 });
    onTestFinished(() => otherLog.stopStorageMaintenance());
    const other = h.journalAt(otherLog), original = h.log.transactDurableProjection.bind(h.log);
    let cancelled = false, afterCancel = 0;
    const spy = vi.spyOn(h.log, 'transactDurableProjection').mockImplementation((async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (!cancelled && result.value && typeof result.value === 'object' && 'metadata' in result.value) {
        cancelled = true;
        await other.cancelRun({ runId: NEXT_RUN, requestId: 'cancel-between-prepare-and-write' });
        afterCancel = (await otherLog.checkpoint()).lsn;
      }
      return result;
    }) as typeof original);
    try { await expect(invoke(h, 'reportStarted')).rejects.toBeInstanceOf(ConversationAssignmentCancelledError); }
    finally { spy.mockRestore(); }
    expect(cancelled).toBe(true);
    expect((await h.log.checkpoint()).lsn).toBe(afterCancel);
    expect(await h.journal.runState(NEXT_RUN)).toBe('cancel-requested');
    expect(h.journal.hasRecoveredInputProjection).toBe(false);
  });

  it('keeps active authorization and durable replay distinct after revocation', async () => {
    const revocation = createRevocationAwareSubmission();
    const h = await fixture('reportStarted', { submission: revocation.authorizer });
    const before = (await h.log.checkpoint()).lsn;
    revocation.revoke(NEXT_ASSIGNMENT);
    await expect(invoke(h, 'reportStarted')).rejects.toThrow('revoked capability cannot perform an active submission');
    expect((await h.log.checkpoint()).lsn).toBe(before);
    expect(h.journal.hasRecoveredInputProjection).toBe(false);
    const replayAuthorizer = createRevocationAwareSubmission();
    const normal = await fixture('reportStarted', { submission: replayAuthorizer.authorizer });
    await invoke(normal, 'reportStarted');
    const committed = (await normal.log.checkpoint()).lsn;
    replayAuthorizer.revoke(NEXT_ASSIGNMENT);
    await expect(invoke(normal, 'reportStarted')).resolves.toBeUndefined();
    expect((await normal.log.checkpoint()).lsn).toBe(committed);
  });

  it('rejects assignment identity reuse from the latest ended run', async () => {
    const h = await fixture('assign'), before = (await h.log.checkpoint()).lsn;
    const reused = atCurrentRevision(createUnsignedEnvelope(h.identity, {
      runId: NEXT_RUN, assignmentId: ASSIGNMENT_ID, ingress: h.unsigned.work.ingress }));
    await expect(h.journal.assign(reused)).rejects.toThrow('Assignment id already belongs to a different run');
    expect((await h.log.checkpoint()).lsn).toBe(before);
    expect(h.journal.hasRecoveredInputProjection).toBe(false);
  });

  it('keeps the complete fair queue when the requested run is not first', async () => {
    const h = await fixture('assign', { earlierQueued: true }), before = (await h.log.checkpoint()).lsn;
    await expect(invoke(h, 'assign')).rejects.toThrow('Only the earliest queued run can be assigned');
    expect((await h.log.checkpoint()).lsn).toBe(before);
    expect(h.journal.hasRecoveredInputProjection).toBe(false);
  });

  it('keeps the established full preparation path after a legacy base is installed', async () => {
    const h = await fixture('reportStarted');
    await h.journal.primeImportedReadBase([]);
    await invoke(h, 'reportStarted');
    expect(await h.journal.runState(NEXT_RUN)).toBe('running');
    expect(h.journal.hasRecoveredInputProjection).toBe(true);
  });

});
