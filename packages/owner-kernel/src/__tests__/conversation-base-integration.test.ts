import { expect, it, vi } from 'vitest';
import { BASE_CONVERSATION, BASE_TRANSFER, baseVerifier, createConversationBaseHarness } from './conversation-base-harness.js';
import { ReferenceMessageInputReader } from './reference-message-input-reader.js';
import { ConversationReadIndex } from '../conversation-read-index.js';
import type { ConversationRunJournal } from '../conversation-assignment.js';
import type { DurableLogCheckpoint, FileArtifactStore, FileAuthorityCommitLog } from '@zhixing/core/authority';
import type { ConversationBodyPage, ConversationControlCursor, ConversationControlFact, ConversationControlPage } from '@zhixing/core/contracts';
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

/** 生产路径（运行状态合并视图）与早期全量折叠实现读同一份持久基底与本地日志 */
async function compareOutsideHistory(owner: ConversationRunJournal, data: { log: FileAuthorityCommitLog; artifacts: FileArtifactStore },
  source: Parameters<ConversationReadIndex['installBaseView']>[0]) {
  const directory = new ConversationReadIndex(data.log, data.artifacts, baseVerifier); directory.installBaseView(source);
  const reference = new ReferenceMessageInputReader(data.log, directory, data.artifacts, BASE_CONVERSATION); reference.installBaseView(source);
  const normalize = (page: Awaited<ReturnType<ConversationRunJournal['messageInputsOutsideHistory']>>) => ({
    inputs: page.inputs.map(input => [input.message.inputIdentity?.id, input.runId, input.state, input.consumed, input.disposition]),
    truncated: page.truncated, interruptibleRuns: page.interruptibleRuns,
  });
  const [actual, expected] = [await owner.messageInputsOutsideHistory(), await reference.messageInputsOutsideHistory()];
  expect(normalize(actual)).toEqual(normalize(expected));
  return normalize(actual);
}

it('reads outside-history inputs and control targets over a persistent base like the full fold across pages and a restart', async () => {
  const h = await createConversationBaseHarness();
  // 66 条取消的基底输入跨过 64 条一页的边界，另有两个排队的会话来源运行作为控制目标
  for (let n = 0; n < 66; n++) await h.input(h.sourceJournal, 'base-' + n, n);
  await h.admit(h.sourceJournal, 'base-queued-0', 66); await h.admit(h.sourceJournal, 'base-queued-1', 67);
  await h.transfer();
  const first = await compareOutsideHistory(h.targetJournal, h.target, (await h.importer.committedBaseSource(BASE_TRANSFER)).source);
  expect(first.inputs).toHaveLength(68);
  expect(first.interruptibleRuns).toEqual([{ runId: 'base-queued-0', state: 'queued' }, { runId: 'base-queued-1', state: 'queued' }]);
  const restarted = await h.restartTarget();
  expect(await compareOutsideHistory(restarted.owner, restarted, restarted.publication.source)).toEqual(first);
}, 240_000);

it('merges persistent base and local outside-history inputs like the full fold and hides them behind a local clear', async () => {
  const h = await createConversationBaseHarness();
  for (let n = 0; n < 66; n++) await h.input(h.sourceJournal, 'base-' + n, n);
  await h.transfer();
  await h.admit(h.targetJournal, 'local-queued', 66);
  for (let n = 0; n < 3; n++) await h.input(h.targetJournal, 'local-' + n, 67 + n);
  const merged = await compareOutsideHistory(h.targetJournal, h.target, (await h.importer.committedBaseSource(BASE_TRANSFER)).source);
  expect(merged.inputs).toHaveLength(70);
  expect(merged.interruptibleRuns).toEqual([{ runId: 'local-queued', state: 'queued' }]);
  const restarted = await h.restartTarget();
  expect(await compareOutsideHistory(restarted.owner, restarted, restarted.publication.source)).toEqual(merged);
  await restarted.owner.cancelRun({ runId: 'local-queued', requestId: 'cancel-local-queued' });
  expect((await h.mutate(restarted.owner, restarted, 'clear-target', { kind: 'window-op', op: 'clear' })).kind).toBe('applied');
  await h.input(restarted.owner, 'after-clear', 70);
  const cleared = await compareOutsideHistory(restarted.owner, restarted, restarted.publication.source);
  expect(cleared.inputs.map(input => input[0])).toEqual(['message-after-clear']);
}, 240_000);

it('starts control recovery at the history boundary over a persistent base and resets a boundary older than the adoption', async () => {
  const h = await createConversationBaseHarness();
  for (let n = 0; n < 66; n++) await h.input(h.sourceJournal, 'base-' + n, n);
  await h.admit(h.sourceJournal, 'base-queued-0', 66); await h.admit(h.sourceJournal, 'base-queued-1', 67);
  // 收编之前取得的边界：这份历史不含后来装入的基底
  const early = await h.targetJournal.recoveryPage({ mode: 'body-page', conversationId: BASE_CONVERSATION, includeInputs: true }) as ConversationBodyPage;
  await h.transfer();
  expect(await h.targetJournal.recoveryPage({ mode: 'control-page', conversationId: BASE_CONVERSATION, historyThrough: early.historyThrough! })).toMatchObject({ reset: true, facts: [] });
  const scan = async (first: { historyThrough?: DurableLogCheckpoint }) => {
    const facts: ConversationControlFact[] = []; let cursor: ConversationControlCursor | undefined;
    for (;;) {
      const page = await h.targetJournal.recoveryPage({ mode: 'control-page', conversationId: BASE_CONVERSATION, ...(cursor ? { cursor } : first) }) as ConversationControlPage;
      expect(page.reset).toBe(false); facts.push(...page.facts); cursor = page.cursor;
      if (!page.hasMore) return facts;
    }
  };
  const first = await h.targetJournal.recoveryPage({ mode: 'body-page', conversationId: BASE_CONVERSATION, includeInputs: true }) as ConversationBodyPage;
  const full = await scan({}), bounded = await scan({ historyThrough: first.historyThrough! });
  // 旧扫描读完整个基底（68 条输入与 68 个状态）；从边界起步只补发基底里仍未结束的两个运行
  expect(full.filter(fact => fact.kind === 'input')).toHaveLength(68);
  expect(bounded.filter(fact => fact.kind === 'input')).toEqual([]);
  const openStatus = (facts: ConversationControlFact[]) => facts.flatMap(fact => fact.kind === 'status' && fact.notice.state === 'queued'
    ? [[fact.notice.ref.runId, fact.notice.statusRevision, fact.communication]] : []);
  expect(openStatus(bounded)).toEqual(openStatus(full));
  expect(bounded.map(fact => fact.kind === 'status' && fact.historyCovered)).toEqual([true, true]);
}, 240_000);

it('moves a base run out of the current set when the target changes its state', async () => {
  // 小基底：较大基底下目标端对基底运行的决定会撞上已登记的 backpressure 缺陷（剩余工作台账，包4）
  const h = await createConversationBaseHarness();
  await h.admit(h.sourceJournal, 'base-queued-0', 0); await h.admit(h.sourceJournal, 'base-queued-1', 1);
  await h.transfer();
  const boundary = async () => ((await h.targetJournal.recoveryPage({ mode: 'body-page', conversationId: BASE_CONVERSATION, includeInputs: true })) as ConversationBodyPage).historyThrough!;
  const scan = async (historyThrough: DurableLogCheckpoint) => {
    const facts: ConversationControlFact[] = []; let cursor: ConversationControlCursor | undefined;
    for (;;) {
      const page = await h.targetJournal.recoveryPage({ mode: 'control-page', conversationId: BASE_CONVERSATION, ...(cursor ? { cursor } : { historyThrough }) }) as ConversationControlPage;
      facts.push(...page.facts); cursor = page.cursor;
      if (!page.hasMore) return facts.flatMap(fact => fact.kind === 'status' ? [[fact.notice.ref.runId, fact.notice.state, !!fact.historyCovered]] : [[fact.kind]]);
    }
  };
  const before = await boundary();
  await h.targetJournal.cancelRun({ runId: 'base-queued-0', requestId: 'target-cancel' });
  // 边界在取消之前：已取消的基底运行不在当前集合，它的新状态由尾部给出
  expect(await scan(before)).toEqual([['base-queued-1', 'queued', true], ['base-queued-0', 'cancelled', false]]);
  // 边界在取消之后：只剩仍在排队的基底运行
  expect(await scan(await boundary())).toEqual([['base-queued-1', 'queued', true]]);
}, 240_000);
