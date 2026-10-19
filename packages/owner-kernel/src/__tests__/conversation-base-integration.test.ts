import { expect, it, vi } from 'vitest';
import { BASE_CONVERSATION, BASE_TRANSFER, createConversationBaseHarness } from './conversation-base-harness.js';
import { conversationRecoveryPage, conversationRecoveryPending } from '../conversation-recovery-index.js';
import { ConversationBaseSource } from '../conversation-base-source.js';
import { conversationBaseKey, openConversationBase, type ConversationBaseBinding } from '../conversation-base-registry.js';
import { runWithMaintenanceUrgency, StorageMaintenanceCancelledError } from '@zhixing/core/resources';

it('adopts authenticated domain facts and keeps the local write decision on base plus tail', async () => {
  const h = await createConversationBaseHarness();
  await h.input(h.sourceJournal, 'old', 0);
  const transferred = await h.transfer();
  expect(transferred.publication.source.ready).toBe(true);
  expect(await h.targetJournal.currentState('old')).toBe('cancelled');
  expect((await h.targetJournal.statusHistory('old', 0)).some(notice => notice.state === 'cancelled')).toBe(true);
  await h.input(h.targetJournal, 'new', 1);
  expect(await h.targetJournal.currentState('old')).toBe('cancelled');
  expect(await h.targetJournal.currentState('new')).toBe('cancelled');
  expect((await h.targetJournal.statusHistory('old', 0)).some(notice => notice.state === 'cancelled')).toBe(true);
  expect((await h.targetJournal.messageStatus('message-old'))?.message.content).toEqual([{ type: 'text', text: 'old' }]);
}, 120_000);

it('resumes an interrupted derived seed from durable progress before publishing ownership', async () => {
  const h = await createConversationBaseHarness();
  await h.input(h.sourceJournal, 'seed', 0);
  const frozen = await h.prepareTransfer();
  const prepare = ConversationBaseSource.prototype.prepare;
  const abort = new AbortController();
  let interrupted: ConversationBaseSource | undefined, pages = 0;
  const probe = vi.spyOn(ConversationBaseSource.prototype, 'prepare').mockImplementationOnce(async function () {
    interrupted = this;
    const update = this.cache.update.bind(this.cache);
    const writes = vi.spyOn(this.cache, 'update').mockImplementation(async operation => {
      const result = await update(operation);
      if (++pages === 3) abort.abort();
      return result;
    });
    try { await runWithMaintenanceUrgency(() => 'foreground', abort.signal, () => prepare.call(this)); }
    finally { writes.mockRestore(); }
  });
  try {
    await expect(h.importer.import({ transferId: BASE_TRANSFER, manifestRef: frozen.manifestRef, proof: frozen.proof, source: h.exporter.readPort }))
      .rejects.toBeInstanceOf(StorageMaintenanceCancelledError);
    expect(pages).toBe(3);
    expect((await h.importer.state(BASE_TRANSFER))?.phase).toBe('prepared');
    expect(await interrupted!.cache.read(view => view.get('source/header'))).toBeDefined();
  } finally { probe.mockRestore(); }
  await h.importer.import({ transferId: BASE_TRANSFER, manifestRef: frozen.manifestRef, proof: frozen.proof, source: h.exporter.readPort });
  await h.importer.commit(BASE_TRANSFER);
  expect(await h.targetJournal.currentState('seed')).toBe('cancelled');
}, 120_000);

it('does not downgrade source authentication when no publication callback is installed, and permits an authenticated abort', async () => {
  const h = await createConversationBaseHarness();
  await h.input(h.sourceJournal, 'source', 0);
  const target = h.makeImporter(h.target, h.targetJournal, false), frozen = await h.prepareTransfer(target);
  const before = await h.target.log.checkpoint();
  const fail = vi.spyOn(ConversationBaseSource, 'open').mockRejectedValueOnce(Error('source authentication rejected'));
  try {
    await expect(target.import({ transferId: BASE_TRANSFER, manifestRef: frozen.manifestRef, proof: frozen.proof, source: h.exporter.readPort }))
      .rejects.toThrow('source authentication rejected');
    expect(fail).toHaveBeenCalledTimes(1);
    expect(await h.target.log.checkpoint()).toEqual(before);
    expect((await target.state(BASE_TRANSFER))?.phase).toBe('prepared');
  } finally { fail.mockRestore(); }
  const abort = await h.exporter.prepareAbort(BASE_TRANSFER, 'operator-cancelled');
  await target.recordAbort(abort);
  await h.exporter.abort(BASE_TRANSFER, 'operator-cancelled');
  await h.input(h.sourceJournal, 'after-abort', 1);
  expect(await h.sourceJournal.currentState('after-abort')).toBe('cancelled');
}, 120_000);

it('checks durable base identity and content refs even after a prepared source cache hit', async () => {
  const h = await createConversationBaseHarness();
  await h.input(h.sourceJournal, 'source', 0); await h.transfer();
  const binding = (await h.target.log.transactDurableProjection<never, ConversationBaseBinding>('conversation-run-state-v1', async view =>
    ({ kind: 'return', value: await view.get(conversationBaseKey(BASE_CONVERSATION)) as unknown as ConversationBaseBinding }))).value;
  await expect(openConversationBase(h.target.log, binding)).resolves.toBeDefined();
  await expect(openConversationBase(h.target.log, { ...binding, records: { ...binding.records, digest: 'sha256:' + 'f'.repeat(64) } }))
    .rejects.toThrow('pointer differs');
  await expect(openConversationBase(h.target.log, { ...binding, state: { ...binding.state,
    identity: { ...binding.state.identity, sourceOwnerEpoch: 3, nextOwnerEpoch: 4 } } })).rejects.toThrow();
}, 120_000);

it('preserves source clear boundaries and historical mutation inputs after adoption and local writes', async () => {
  const h = await createConversationBaseHarness();
  const first = { items: [{ id: 'first', content: 'original task', status: 'pending' as const }] };
  const set = (state: typeof first) => ({ kind: 'task-list-op' as const, op: { op: 'set' as const, state } });
  await h.input(h.sourceJournal, 'before-clear', 0);
  expect((await h.mutate(h.sourceJournal, h.source, 'first-list', set(first))).kind).toBe('applied');
  expect((await h.mutate(h.sourceJournal, h.source, 'second-list', set({ items: [] }))).kind).toBe('applied');
  expect((await h.mutate(h.sourceJournal, h.source, 'clear-source', { kind: 'window-op', op: 'clear' })).kind).toBe('applied');
  await h.input(h.sourceJournal, 'after-clear', 1);
  await h.transfer();
  expect(await h.targetJournal.taskListBeforeMutation('first-list')).toEqual({ items: [] });
  expect(await h.targetJournal.taskListBeforeMutation('second-list')).toEqual(first);
  const outside = await h.targetJournal.messageInputsOutsideHistory();
  expect(outside.inputs.map(item => item.message.inputIdentity?.id)).toEqual(['message-after-clear']);
  expect((await h.mutate(h.targetJournal, h.target, 'target-list', set(first))).kind).toBe('applied');
  expect(await h.targetJournal.taskList()).toEqual(first);
  expect(await h.targetJournal.taskListBeforeMutation('target-list')).toEqual({ items: [] });
  expect(await h.targetJournal.taskListBeforeMutation('second-list')).toEqual(first);
  const restarted = await h.restartTarget();
  expect(await restarted.owner.taskListBeforeMutation('second-list')).toEqual(first);
  expect(await restarted.owner.taskList()).toEqual(first);
}, 120_000);

it('discovers adopted queued work, pages its source input and retires it durably at the new owner', async () => {
  const h = await createConversationBaseHarness();
  await h.input(h.sourceJournal, 'finished', 0);
  await h.admit(h.sourceJournal, 'queued', 1);
  await h.transfer();
  expect((await conversationRecoveryPage(h.target.log, h.target.artifacts)).conversationIds).toContain(BASE_CONVERSATION);
  expect(await conversationRecoveryPending(h.target.log, h.target.artifacts, BASE_CONVERSATION)).toBe(true);
  const page = await h.targetJournal.recoveryPage({ mode: 'control-page', conversationId: BASE_CONVERSATION });
  if (!('facts' in page)) throw Error('Wrong recovery page');
  const fact = page.facts.find(item => item.kind === 'input' && item.cursor.runId === 'queued');
  if (fact?.kind !== 'input') throw Error('Imported queued input was omitted');
  const input = await h.targetJournal.recoveryPage({ mode: 'input-page', conversationId: BASE_CONVERSATION, runId: 'queued', cursor: fact.cursor });
  expect(JSON.stringify(input)).toContain('queued');
  await h.targetJournal.cancelRun({ runId: 'queued', requestId: 'cancel-adopted' });
  expect(await conversationRecoveryPending(h.target.log, h.target.artifacts, BASE_CONVERSATION)).toBe(false);
  const restarted = await h.restartTarget();
  expect(await restarted.owner.currentState('queued')).toBe('cancelled');
  expect(await conversationRecoveryPending(restarted.log, restarted.artifacts, BASE_CONVERSATION)).toBe(false);
}, 120_000);
