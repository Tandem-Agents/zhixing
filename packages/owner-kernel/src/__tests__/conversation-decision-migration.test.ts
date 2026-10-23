import fs from 'node:fs/promises';
import path from 'node:path';
import { AUTHORITY_RECOVERY_BUDGET, AuthorityCacheIntegrity, AuthorityPreparationRequired, FileArtifactStore, FileAuthorityCommitLog, durableProjectionVersionDirectoryName,
  type DurableLogCheckpoint, type DurableProjectionMutation } from '@zhixing/core/authority';
import type { CommitEnvelope, JsonValue, Signature } from '@zhixing/core/contracts';
import { canonicalize, protocolDigest } from '@zhixing/core/protocol';
import { createTempDir } from '@zhixing/test-utils';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { AnchorResourceGovernor } from '../resource-governor.js';
import { ConversationRunJournal, emptySubmissionGuardProjection, reduceConversationRunState, reduceConversationSubmissionGuard,
  startConversationDecisionMigration, stopConversationDecisionMigration, conversationDecisionMigrationStatus, conversationDecisionReady } from '../conversation-assignment.js';
import { emptyConversationRunProjection } from '../conversation-assignment.js';
import { CONVERSATION_RUN_STATE_PROJECTION_ID, conversationReductionContexts } from '../conversation-run-state-index.js';
import { ADVANCEMENT_RECOVERY_PROJECTION_ID, registerAdvancementRecoveryProjection } from '../advancement-recovery-index.js';
import { partitionedDecisionReducer, setDecisionMigrationMaxWaitForTesting, setDecisionMigrationMinSourceLsnForTesting } from '../conversation-decision-partitions.js';
import { DECISION_INDEXED_THROUGH, DECISION_MIGRATION_COMPLETE, DECISION_MIGRATION_START, TRANSFER_PARTITION, decisionConversationKey,
  decisionMigrationActive, decisionPartitionKey } from '../conversation-decision-partition-keys.js';
import { DecisionRows, logDecisionSource, migrateConversationDecisionState, type DecisionSourceReader } from '../conversation-decision-migration.js';
import { trackAuthorityLog } from './durable-io-test-support.js';
import { importAuthenticatedBase, installVerifiedAnchorTenure } from './imported-base-fixture.js';

// 旧资料升级：新版本的决定状态投影从源头部起步，按会话分区迁移；迁移结果必须与从起点完整重建逐行一致。
const NOW = '2026-10-05T00:00:00.000Z';
const CONVERSATION = 'migration-conversation';
const signer = { sign(schema: string, version: number, payload: unknown): Signature { return { alg: 'test-sha256', keyId: 'device:test', sig: protocolDigest(schema, version, payload) }; } };
const verifier = { verify(schema: string, version: number, payload: unknown, signature: Signature) { expect(signature).toEqual(signer.sign(schema, version, payload)); } };
const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 41));

let restoreThreshold: () => void;
beforeEach(() => { restoreThreshold = setDecisionMigrationMinSourceLsnForTesting(0); });
afterEach(() => restoreThreshold());

function open(root: string) {
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, 'log'), artifacts, { clock: () => NOW, integrity }));
  const resources = new AnchorResourceGovernor({ log, signer, verifier, guard: { assert() {} }, anchorEpoch: 1,
    localExecutorId: 'device:test', reporterKeyFor: () => 'device:test', clock: () => NOW });
  const journal = (conversationId = CONVERSATION, ownerEpoch = 1) => new ConversationRunJournal({ conversationId, ownerEpoch, log, artifacts, signer, verifier, resources,
    submission: { authenticate() {}, authorize() {} }, authority: { decideAtPrefix: () => ({ committed: true, commitRevision: 1 }) },
    projection: { async project() {} }, clock: () => NOW });
  registerAdvancementRecoveryProjection(log, artifacts);
  return { root, log, artifacts, journal };
}

async function admit(journal: ConversationRunJournal, n: number, conversationId = CONVERSATION) {
  await journal.admit({ ingressKey: `ingress-${n}`, runId: `run-${n}`, queuedPosition: n,
    userInput: { parts: [{ type: 'text', text: `input ${n}` }] }, invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: `ingress-${n}`, receivedAt: NOW,
      turnOrigin: { channel: 'rpc', messageIdentity: { id: `message-${n}`, source: { kind: 'conversation', conversationId } } } } });
}

async function history(root: string) {
  const h = open(root);
  const journal = h.journal();
  for (let n = 0; n < 6; n++) await admit(journal, n);
  await journal.cancelRun({ runId: 'run-1', requestId: 'cancel-1' });
  await journal.cancelRun({ runId: 'run-4', requestId: 'cancel-4' });
  return h;
}

async function rows(log: FileAuthorityCommitLog, projectionId: string): Promise<Map<string, string>> {
  return (await log.transactDurableProjection<never, Map<string, string>>(projectionId, async view => {
    const result = new Map<string, string>(); let continuation: string | undefined;
    do { const page = await view.scan({}, 256, continuation); for (const entry of page.entries) if (!entry.key.startsWith('~migration/')) result.set(entry.key, canonicalize(entry.value)); continuation = page.continuation; } while (continuation);
    return { kind: 'return', value: result };
  })).value;
}

/** 模拟升级：保留同一份日志与制品，删掉新版本决定状态投影的派生目录。 */
async function upgrade(root: string) {
  for (const [id, version] of [[CONVERSATION_RUN_STATE_PROJECTION_ID, 3], [ADVANCEMENT_RECOVERY_PROJECTION_ID, 2]] as const) {
    await fs.rm(path.join(root, 'log', 'projections', durableProjectionVersionDirectoryName(id, version)), { recursive: true, force: true });
  }
}

it('starts at the source head, migrates a conversation on first use and equals the full rebuild row for row', async () => {
  const root = await createTempDir('decision-migration');
  const built = await history(root);
  const expectedCanonical = await rows(built.log, CONVERSATION_RUN_STATE_PROJECTION_ID);
  const expectedAdvancement = await rows(built.log, ADVANCEMENT_RECOVERY_PROJECTION_ID);
  await built.log.stopStorageMaintenance();
  await upgrade(root);

  const upgraded = open(root);
  const journal = upgraded.journal();
  // 打开时两个投影在源头部直接就绪：处于迁移中，会话尚未迁移。
  expect(await conversationDecisionReady(upgraded.log, CONVERSATION)).toBe(false);
  expect(await upgraded.log.transactDurableProjection(CONVERSATION_RUN_STATE_PROJECTION_ID,
    async view => ({ kind: 'return', value: await decisionMigrationActive(view) })).then(result => result.value)).toBe(true);
  // 第一次读取迁移该会话，结果与完整重建逐行一致。
  expect(await journal.currentState('run-5')).toBe('queued');
  expect(await conversationDecisionReady(upgraded.log, CONVERSATION)).toBe(true);
  expect(await rows(upgraded.log, CONVERSATION_RUN_STATE_PROJECTION_ID)).toEqual(expectedCanonical);
  expect(await rows(upgraded.log, ADVANCEMENT_RECOVERY_PROJECTION_ID)).toEqual(expectedAdvancement);
  // 迁移后照常写入；同一入口的重复提交按幂等回放，入口身份冲突仍按迁移前的历史拒绝。
  await admit(journal, 6);
  await admit(journal, 0);
  await expect(journal.admit({ ingressKey: 'ingress-0', runId: 'run-conflict', queuedPosition: 9, userInput: { parts: [{ type: 'text', text: 'conflict' }] },
    invocation: { kind: 'agent', source: 'interactive' }, ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: 'ingress-0', receivedAt: NOW,
      turnOrigin: { channel: 'rpc', messageIdentity: { id: 'message-0', source: { kind: 'conversation', conversationId: CONVERSATION } } } } })).rejects.toThrow();
  expect(await journal.currentState('run-conflict')).toBeUndefined();
  // 没有历史的新会话不需要迁移即可读写。
  const fresh = upgraded.journal('fresh-conversation');
  await admit(fresh, 0, 'fresh-conversation');
  expect(await fresh.currentState('run-0')).toBe('queued');
  // 后台迁移其余会话后写完成标记；重开后不再处于迁移中。
  await startConversationDecisionMigration(upgraded.log);
  await upgraded.log.stopStorageMaintenance();
  const reopened = open(root);
  reopened.journal();
  for (const id of [CONVERSATION_RUN_STATE_PROJECTION_ID, ADVANCEMENT_RECOVERY_PROJECTION_ID]) {
    expect(await reopened.log.transactDurableProjection(id, async view => ({ kind: 'return', value: await view.get(DECISION_MIGRATION_COMPLETE) }))
      .then(result => result.value)).toBeDefined();
  }
  expect(await reopened.journal().currentState('run-6')).toBe('queued');
  await reopened.log.stopStorageMaintenance();
}, 120_000);

it('continues from an authenticated old checkpoint and reaches the same state as a full replay', async () => {
  const root = await createTempDir('decision-migration-base');
  const built = await history(root);
  // 旧版本按会话写下的认证检查点（运行状态与提交守卫），位于当前头部；此后再写尾部事实。
  const conversation = built.journal();
  const head = await built.log.readProjection<undefined>(undefined, state => state, {});
  const envelopes = await built.log.readStreamEnvelopes<unknown>(['run:' + CONVERSATION], 0, head.cursor.lsn);
  let run = emptyConversationRunProjection(CONVERSATION), guard = emptySubmissionGuardProjection();
  for (const envelope of envelopes.commits) for (const entry of envelope.entries) {
    if (entry.stream !== 'run:' + CONVERSATION) continue;
    const contexts = conversationReductionContexts(built.log, CONVERSATION, envelope, () => undefined);
    run = await reduceConversationRunState(contexts.run, run, entry, envelope);
    guard = await reduceConversationSubmissionGuard(contexts.guard, guard, entry as never, envelope as never);
  }
  await built.log.saveProjectionCheckpoint(`conversation-run-projection:v2:e537cbb8810d6903:${CONVERSATION}:1`, head.cursor, run);
  await built.log.saveProjectionCheckpoint(`conversation-submission-projection:v1:9eac0d4e1b9751ac:${CONVERSATION}:1`, head.cursor, guard);
  await conversation.cancelRun({ runId: 'run-2', requestId: 'cancel-2' });
  await admit(conversation, 7);
  const expected = await rows(built.log, CONVERSATION_RUN_STATE_PROJECTION_ID);
  await built.log.stopStorageMaintenance();
  await upgrade(root);

  const upgraded = open(root);
  upgraded.journal();
  const migration = await migrateConversationDecisionState({ log: upgraded.log, artifacts: upgraded.artifacts, verifier, conversationId: CONVERSATION,
    through: (await upgraded.log.checkpoint()).lsn, origin: await upgraded.log.originCheckpoint() });
  expect(migration.baseLsn).toBe(head.cursor.lsn);
  const actual = new Map<string, string>([...migration.canonical.rows()].filter(([key]) => !key.startsWith('~migration/'))
    .map(([key, value]) => [key, canonicalize(value as JsonValue)]));
  // 旧基点转换得到的接纳记录与完整重放一致；本测试的检查点由现行归约产生，接纳时的领域版本号也保留。
  expect(actual).toEqual(expected);
  await upgraded.log.stopStorageMaintenance();
}, 120_000);

it('lists the trusted old checkpoints once per log however many conversations migrate from them', async () => {
  const root = await createTempDir('decision-migration-base-index');
  const built = await history(root);
  const second = built.journal('second-conversation');
  for (let n = 0; n < 3; n++) await admit(second, n, 'second-conversation');
  const head = await built.log.readProjection<undefined>(undefined, state => state, {});
  for (const id of [CONVERSATION, 'second-conversation']) {
    const envelopes = await built.log.readStreamEnvelopes<unknown>(['run:' + id], 0, head.cursor.lsn);
    let run = emptyConversationRunProjection(id), guard = emptySubmissionGuardProjection();
    for (const envelope of envelopes.commits) for (const entry of envelope.entries) {
      if (entry.stream !== 'run:' + id) continue;
      const contexts = conversationReductionContexts(built.log, id, envelope, () => undefined);
      run = await reduceConversationRunState(contexts.run, run, entry, envelope);
      guard = await reduceConversationSubmissionGuard(contexts.guard, guard, entry as never, envelope as never);
    }
    await built.log.saveProjectionCheckpoint(`conversation-run-projection:v2:e537cbb8810d6903:${id}:1`, head.cursor, run);
    await built.log.saveProjectionCheckpoint(`conversation-submission-projection:v1:9eac0d4e1b9751ac:${id}:1`, head.cursor, guard);
  }
  await built.log.stopStorageMaintenance();
  await upgrade(root);

  const upgraded = open(root);
  upgraded.journal();
  const list = upgraded.log.listProjectionCheckpointKeys.bind(upgraded.log);
  let listings = 0;
  upgraded.log.listProjectionCheckpointKeys = async (prefix: string) => { listings++; return list(prefix); };
  const through = (await upgraded.log.checkpoint()).lsn, origin = await upgraded.log.originCheckpoint();
  for (const id of [CONVERSATION, 'second-conversation', CONVERSATION]) {
    const migration = await migrateConversationDecisionState({ log: upgraded.log, artifacts: upgraded.artifacts, verifier, conversationId: id, through, origin });
    expect(migration.baseLsn).toBe(head.cursor.lsn);
  }
  // 运行状态与提交守卫两种检查点各列一次。
  expect(listings).toBe(2);
  await upgraded.log.stopStorageMaintenance();
}, 120_000);

/** 迁移结果中的行（不含迁移标记），与 rows() 的口径相同。 */
function migratedRows(rows: DecisionRows): Map<string, string> {
  return new Map([...rows.rows()].filter(([key]) => !key.startsWith('~migration/')).map(([key, value]) => [key, canonicalize(value)]));
}

/** 对照：同一份日志删掉派生目录后从起点完整重建。 */
async function fullRebuild(root: string): Promise<{ canonical: Map<string, string>; advancement: Map<string, string> }> {
  await upgrade(root);
  const restore = setDecisionMigrationMinSourceLsnForTesting(Number.MAX_SAFE_INTEGER);
  try {
    const reference = open(root);
    reference.journal();
    const result = { canonical: await rows(reference.log, CONVERSATION_RUN_STATE_PROJECTION_ID), advancement: await rows(reference.log, ADVANCEMENT_RECOVERY_PROJECTION_ID) };
    await reference.log.stopStorageMaintenance();
    return result;
  } finally { restore(); }
}

it('pauses background migration while the foreground is busy and migrates a conversation a caller waits for at once', async () => {
  // 本例观察“前台忙时暂停”：让路下限设得足够长，不在观察窗口内触发。
  const restoreWait = setDecisionMigrationMaxWaitForTesting(60_000);
  onTestFinished(restoreWait);
  const root = await createTempDir('decision-migration-pacing');
  const built = await history(root);
  // 另一个只由后台迁移的会话。
  const other = built.journal('background-conversation');
  for (let n = 0; n < 3; n++) await admit(other, n, 'background-conversation');
  const expectedCanonical = await rows(built.log, CONVERSATION_RUN_STATE_PROJECTION_ID);
  await built.log.stopStorageMaintenance();
  await upgrade(root);

  const upgraded = open(root);
  const journal = upgraded.journal();
  // 前台一直不安静：后台迁移在第一个推进点暂停，不做任何迁移工作。
  let quiet = false;
  const paused = new Set<() => void>();
  let woken = 0;
  const idle = (signal: AbortSignal) => new Promise<void>(resolve => {
    if (quiet) return resolve();
    const done = () => { paused.delete(done); resolve(); };
    paused.add(done);
    signal.addEventListener('abort', () => { woken++; done(); }, { once: true });
  });
  const background = startConversationDecisionMigration(upgraded.log, { idle })!;
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(paused.size).toBe(1);
  expect(await conversationDecisionReady(upgraded.log, CONVERSATION)).toBe(false);
  // 调用方在等这个会话：暂停中的共享扫描被唤醒，该会话随即按前台迁移完成，不等前台安静。
  expect(await journal.currentState('run-5')).toBe('queued');
  expect(woken).toBeGreaterThan(0);
  expect(await conversationDecisionReady(upgraded.log, CONVERSATION)).toBe(true);
  // 其余会话仍在等待前台安静；安静后迁移完成，结果与完整重建一致，并写完成标记。
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(paused.size).toBe(1);
  expect(await conversationDecisionReady(upgraded.log, 'background-conversation')).toBe(false);
  quiet = true;
  for (const resume of [...paused]) resume();
  await background;
  expect(await conversationDecisionReady(upgraded.log, 'background-conversation')).toBe(true);
  expect(await rows(upgraded.log, CONVERSATION_RUN_STATE_PROJECTION_ID)).toEqual(expectedCanonical);
  expect(await upgraded.log.transactDurableProjection(CONVERSATION_RUN_STATE_PROJECTION_ID,
    async view => ({ kind: 'return', value: await view.get(DECISION_MIGRATION_COMPLETE) })).then(result => result.value)).toBeDefined();
  await upgraded.log.stopStorageMaintenance();
}, 120_000);

/** 一直不安静的前台：只有被唤醒（信号中止）才结束等待。 */
function busyForeground() {
  const paused = new Set<() => void>();
  const idle = (signal: AbortSignal) => new Promise<void>(resolve => {
    const done = () => { paused.delete(done); resolve(); };
    paused.add(done);
    signal.addEventListener('abort', done, { once: true });
  });
  return { idle, paused };
}

it('cancels a paused background migration on host stop, drains it without recording failures and resumes after reopening', async () => {
  const restoreWait = setDecisionMigrationMaxWaitForTesting(60_000);
  onTestFinished(restoreWait);
  const root = await createTempDir('decision-migration-stop');
  const built = await history(root);
  const other = built.journal('background-conversation');
  for (let n = 0; n < 3; n++) await admit(other, n, 'background-conversation');
  const expectedCanonical = await rows(built.log, CONVERSATION_RUN_STATE_PROJECTION_ID);
  await built.log.stopStorageMaintenance();
  await upgrade(root);

  const upgraded = open(root);
  upgraded.journal();
  const foreground = busyForeground();
  const background = startConversationDecisionMigration(upgraded.log, { idle: foreground.idle })!;
  // 等迁移真正停在让路点上，不以固定时长猜测（负载下会误报）。
  await vi.waitFor(() => expect(foreground.paused.size).toBe(1), { timeout: 30_000, interval: 10 });
  // 停止取消暂停中的等待并等后台退出：不等前台安静，也不把取消记成迁移失败。
  // 让路上限为60秒，停止远早于此返回即证明是取消生效而非等到期。
  const stopping = performance.now();
  await stopConversationDecisionMigration(upgraded.log);
  expect(performance.now() - stopping).toBeLessThan(10_000);
  await expect(background).resolves.toBeUndefined();
  expect(foreground.paused.size).toBe(0);
  expect(conversationDecisionMigrationStatus(upgraded.log)?.failed.size).toBe(0);
  // 停止之后不再重新开始。
  await startConversationDecisionMigration(upgraded.log);
  expect(await upgraded.log.transactDurableProjection(CONVERSATION_RUN_STATE_PROJECTION_ID,
    async view => ({ kind: 'return', value: await view.get(DECISION_MIGRATION_COMPLETE) })).then(result => result.value)).toBeUndefined();
  await upgraded.log.stopStorageMaintenance();

  // 重开后从停下的地方继续，结果与完整重建一致。
  const reopened = open(root);
  reopened.journal();
  await startConversationDecisionMigration(reopened.log);
  expect(await conversationDecisionReady(reopened.log, 'background-conversation')).toBe(true);
  expect(await rows(reopened.log, CONVERSATION_RUN_STATE_PROJECTION_ID)).toEqual(expectedCanonical);
  await reopened.log.stopStorageMaintenance();
}, 120_000);

it('keeps migrating conversations with advancement facts under a foreground that never goes quiet and leaves the rest for quiet periods', async () => {
  const restoreWait = setDecisionMigrationMaxWaitForTesting(20);
  onTestFinished(restoreWait);
  const root = await createTempDir('decision-migration-floor');
  const built = await history(root);
  // 较早有推进事实的会话，以及之后才写入、按最近使用排在它前面的会话。
  await built.journal('advancing-conversation').applyAdvancementEvents({ requestId: 'advancement-1', events: [{
    type: 'session_created', timestamp: NOW, sessionId: 'session-1', conversationId: 'advancing-conversation',
    originalUserTask: { parts: [{ type: 'text', text: '任务' }] },
    pendingRubricDraft: { draftId: 'draft-1', originalTurnId: 'turn-1', source: 'generated', candidateRubricIds: [], title: '准则', description: '描述',
      content: { passCriteria: ['测试通过'], evidenceRequirements: [], failureHandling: [] }, createdAt: NOW },
  }] });
  const recent = built.journal('recent-conversation');
  for (let n = 0; n < 3; n++) await admit(recent, n, 'recent-conversation');
  const expectedCanonical = await rows(built.log, CONVERSATION_RUN_STATE_PROJECTION_ID);
  const expectedAdvancement = await rows(built.log, ADVANCEMENT_RECOVERY_PROJECTION_ID);
  await built.log.stopStorageMaintenance();
  await upgrade(root);

  const upgraded = open(root);
  upgraded.journal();
  // 每次发布后记下新迁移完成的会话，得到后台迁移顺序。
  const candidates = [CONVERSATION, 'advancing-conversation', 'recent-conversation'];
  const order: string[] = [];
  const publish = upgraded.log.publishProjectionRows!.bind(upgraded.log);
  upgraded.log.publishProjectionRows = async (ids, compute, options) => {
    const result = await publish(ids, compute, options);
    for (const id of candidates) if (!order.includes(id) && await conversationDecisionReady(upgraded.log, id)) order.push(id);
    return result;
  };
  const foreground = busyForeground();
  let quiet = false;
  const background = startConversationDecisionMigration(upgraded.log, { idle: signal => quiet ? Promise.resolve() : foreground.idle(signal) })!;
  // 前台一直不安静：全库扫描与带推进事实的会话按下限推进，其余会话不迁移（不让大规模迁移抢占交互）。
  const deadline = Date.now() + 60_000;
  while (!await conversationDecisionReady(upgraded.log, 'advancing-conversation')) {
    if (Date.now() > deadline) throw Error('advancing conversation was not migrated under foreground load');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(await conversationDecisionReady(upgraded.log, CONVERSATION)).toBe(false);
  expect(await conversationDecisionReady(upgraded.log, 'recent-conversation')).toBe(false);
  // 前台安静后其余会话完成。
  quiet = true;
  for (const resume of [...foreground.paused]) resume();
  await background;
  expect(order[0]).toBe('advancing-conversation');
  expect(order).toHaveLength(3);
  expect(await rows(upgraded.log, CONVERSATION_RUN_STATE_PROJECTION_ID)).toEqual(expectedCanonical);
  expect(await rows(upgraded.log, ADVANCEMENT_RECOVERY_PROJECTION_ID)).toEqual(expectedAdvancement);
  expect(await upgraded.log.transactDurableProjection(CONVERSATION_RUN_STATE_PROJECTION_ID,
    async view => ({ kind: 'return', value: await view.get(DECISION_MIGRATION_COMPLETE) })).then(result => result.value)).toBeDefined();
  await upgraded.log.stopStorageMaintenance();
}, 120_000);

it('keeps the final catch-up under the log lock within its budget while other writes keep extending the tail', async () => {
  const root = await createTempDir('decision-migration-locked-tail');
  const built = await history(root);
  const expectedCanonical = await rows(built.log, CONVERSATION_RUN_STATE_PROJECTION_ID);
  await built.log.stopStorageMaintenance();
  await upgrade(root);

  const upgraded = open(root);
  upgraded.journal();
  // 在锁外续算之后、取得日志锁之前插入超过预算的合法尾部（独立写入照常取得日志锁），并统计每次持锁读取的帧数。
  const publish = upgraded.log.publishProjectionRows!.bind(upgraded.log);
  let injections = 2, attempts = 0, emptyAttempts = 0, maxLockedFrames = 0;
  upgraded.log.publishProjectionRows = async (ids, compute, options) => {
    if (injections > 0) {
      injections--;
      for (let n = 0; n < 100; n++) await upgraded.log.append([{ stream: 'session-activity:filler', body: { filler: n } }]);
    }
    attempts++;
    return publish(ids, async (head, read, source) => {
      let lockedFrames = 0;
      const counted = { ...source, readStreamEnvelopes: async <Body,>(streams: readonly string[], after: number, through: number, limit?: number) => {
        const page = await source.readStreamEnvelopes<Body>(streams, after, through, limit);
        lockedFrames += page.commits.length;
        return page;
      } };
      const changes = await compute(head, read, counted);
      maxLockedFrames = Math.max(maxLockedFrames, lockedFrames);
      if (![...changes.values()].length) emptyAttempts++;
      return changes;
    }, options);
  };
  await startConversationDecisionMigration(upgraded.log);
  expect(maxLockedFrames).toBeLessThanOrEqual(64);
  // 两次超出预算的尝试都放弃了发布，回到锁外追平后才完成。
  expect(emptyAttempts).toBeGreaterThanOrEqual(2);
  expect(await conversationDecisionReady(upgraded.log, CONVERSATION)).toBe(true);
  expect(await rows(upgraded.log, CONVERSATION_RUN_STATE_PROJECTION_ID)).toEqual(expectedCanonical);
  expect(await upgraded.log.transactDurableProjection(CONVERSATION_RUN_STATE_PROJECTION_ID,
    async view => ({ kind: 'return', value: await view.get(DECISION_MIGRATION_COMPLETE) })).then(result => result.value)).toBeDefined();
  void attempts;
  await upgraded.log.stopStorageMaintenance();
}, 120_000);

/** 一帧合法的大信封：400条记录、每条约24KiB正文（低于内联上限），整帧低于日志的单帧上限。 */
function largeFrame(n: number) {
  return Array.from({ length: 400 }, (_, part) => ({ stream: 'session-activity:filler', body: { filler: n, part, padding: 'x'.repeat(24 * 1024) } }));
}

/** 包装发布：每次发布前注入 inject(i) 个大帧，并统计每次锁内读取的帧数与信封字节。 */
function meterLockedTail(log: FileAuthorityCommitLog, inject: (publication: number) => number) {
  const publish = log.publishProjectionRows!.bind(log);
  const attempts: { publication: number; frames: number; bytes: number; empty: boolean }[] = [];
  let publication = 0;
  log.publishProjectionRows = async (ids, compute, options) => {
    const current = publication++;
    for (let n = 0; n < inject(current); n++) await log.append(largeFrame(n));
    return publish(ids, async (head, read, source) => {
      let frames = 0, bytes = 0;
      const counted = { ...source, readStreamEnvelopes: async <Body,>(streams: readonly string[], after: number, through: number, limit?: number) => {
        const page = await source.readStreamEnvelopes<Body>(streams, after, through, limit);
        frames += page.commits.length;
        bytes += page.commits.reduce((total, envelope) => total + Buffer.byteLength(JSON.stringify(envelope)), 0);
        return page;
      } };
      const changes = await compute(head, read, counted);
      attempts.push({ publication: current, frames, bytes, empty: ![...changes.values()].length });
      return changes;
    }, options);
  };
  return attempts;
}

it('keeps the final locked catch-up within the page byte budget when a few large frames extend the tail', async () => {
  const root = await createTempDir('decision-migration-locked-bytes');
  const built = await history(root);
  const expectedCanonical = await rows(built.log, CONVERSATION_RUN_STATE_PROJECTION_ID);
  await built.log.stopStorageMaintenance();
  await upgrade(root);
  const upgraded = open(root);
  upgraded.journal();
  // 转移清单与会话迁移的最终发布之前各插入两帧合法大信封：帧数远低于64，字节远超一页。
  const attempts = meterLockedTail(upgraded.log, publication => publication < 2 ? 2 : 0);
  await startConversationDecisionMigration(upgraded.log);
  // 每次持锁要么不超过一页的帧数与字节，要么只补一帧。
  for (const attempt of attempts) {
    expect(attempt.frames).toBeLessThanOrEqual(AUTHORITY_RECOVERY_BUDGET.pageFrames);
    if (attempt.frames > 1) expect(attempt.bytes).toBeLessThanOrEqual(AUTHORITY_RECOVERY_BUDGET.pageBytes);
  }
  // 两条路径都放弃过超出预算的发布，回到锁外追平后才完成。
  expect(attempts.filter(attempt => attempt.publication === 0 && attempt.empty).length).toBeGreaterThanOrEqual(1);
  expect(attempts.filter(attempt => attempt.publication === 1 && attempt.empty).length).toBeGreaterThanOrEqual(1);
  expect(await conversationDecisionReady(upgraded.log, CONVERSATION)).toBe(true);
  expect(await rows(upgraded.log, CONVERSATION_RUN_STATE_PROJECTION_ID)).toEqual(expectedCanonical);
  expect(await upgraded.log.transactDurableProjection(CONVERSATION_RUN_STATE_PROJECTION_ID,
    async view => ({ kind: 'return', value: await view.get(DECISION_MIGRATION_COMPLETE) })).then(result => result.value)).toBeDefined();
  await upgraded.log.stopStorageMaintenance();
}, 120_000);

it('admits a single legal large frame into the final locked catch-up without abandoning the publication', async () => {
  const root = await createTempDir('decision-migration-single-large-frame');
  const built = await history(root);
  const expectedCanonical = await rows(built.log, CONVERSATION_RUN_STATE_PROJECTION_ID);
  await built.log.stopStorageMaintenance();
  await upgrade(root);
  const upgraded = open(root);
  upgraded.journal();
  // 转移清单的最终发布（锁内读取全部流）之前只插入一帧大信封：超过一页字节，但只有一帧，照常在锁内补齐。
  const attempts = meterLockedTail(upgraded.log, publication => publication === 0 ? 1 : 0);
  await startConversationDecisionMigration(upgraded.log);
  const conversationAttempts = attempts.filter(attempt => attempt.publication === 0);
  expect(conversationAttempts.some(attempt => attempt.empty)).toBe(false);
  expect(Math.max(...conversationAttempts.map(attempt => attempt.bytes))).toBeGreaterThan(AUTHORITY_RECOVERY_BUDGET.pageBytes);
  expect(await rows(upgraded.log, CONVERSATION_RUN_STATE_PROJECTION_ID)).toEqual(expectedCanonical);
  await upgraded.log.stopStorageMaintenance();
}, 120_000);

it('extends a started migration to later facts and rolls a failed extension back so no fact is folded twice', async () => {
  const root = await createTempDir('decision-migration-extend');
  const h = open(root);
  const journal = h.journal();
  for (let n = 0; n < 3; n++) await admit(journal, n);
  const started = (await h.log.checkpoint()).lsn;
  for (let n = 3; n < 6; n++) await admit(journal, n);
  await journal.cancelRun({ runId: 'run-4', requestId: 'cancel-4' });
  const head = (await h.log.checkpoint()).lsn;
  const migration = await migrateConversationDecisionState({ log: h.log, artifacts: h.artifacts, verifier, conversationId: CONVERSATION,
    through: started, origin: await h.log.originCheckpoint(), trustedBase: false });
  // 续算读到第一个信封后中断：迁移回到续算前，重新续算的结果与逐事实折叠一致。
  let reads = 0;
  const interrupted: DecisionSourceReader = {
    async readStreamEnvelopes(streams, after, through) {
      if (++reads === 2) throw new Error('interrupted');
      return h.log.readStreamEnvelopes!(streams, after, through, 1) as never;
    },
    readEnvelopeAt: checkpoint => h.log.readEnvelopeAt(checkpoint),
  };
  await expect(migration.extend(interrupted, head)).rejects.toThrow('interrupted');
  expect(migration.through).toBe(started);
  await migration.extend(logDecisionSource(h.log), head);
  expect(migration.through).toBe(head);
  expect(migratedRows(migration.canonical)).toEqual(await rows(h.log, CONVERSATION_RUN_STATE_PROJECTION_ID));
  expect(migratedRows(migration.advancement)).toEqual(await rows(h.log, ADVANCEMENT_RECOVERY_PROJECTION_ID));
  await h.log.stopStorageMaintenance();
}, 120_000);

it('resumes an interrupted migration after reopening and completes after re-migrating withdrawn partitions', async () => {
  const root = await createTempDir('decision-migration-resume');
  const built = open(root);
  const a = built.journal('conversation-a'), b = built.journal('conversation-b');
  for (let n = 0; n < 3; n++) { await admit(a, n, 'conversation-a'); await admit(b, n, 'conversation-b'); }
  await a.cancelRun({ runId: 'run-1', requestId: 'cancel-a' });
  await b.cancelRun({ runId: 'run-2', requestId: 'cancel-b' });
  await built.log.stopStorageMaintenance();
  await upgrade(root);

  // 第一次打开只迁移了 a，随即退出。
  const first = open(root);
  expect(await first.journal('conversation-a').currentState('run-2')).toBe('queued');
  await first.log.stopStorageMaintenance();
  const second = open(root);
  const fresh = second.journal('fresh-conversation');
  expect(await conversationDecisionReady(second.log, 'conversation-a')).toBe(true);
  expect(await conversationDecisionReady(second.log, 'conversation-b')).toBe(false);
  await admit(fresh, 0, 'fresh-conversation');
  // 不经准入的历史事实撤回了转移分区与 a 的迁移标记，并把新会话记入会话清单（与归约在这种情况下的写入相同）。
  const projections = [CONVERSATION_RUN_STATE_PROJECTION_ID, ADVANCEMENT_RECOVERY_PROJECTION_ID];
  await second.log.publishProjectionRows!(projections, async () => new Map(projections.map(id => [id, [
    { kind: 'tombstone', key: decisionPartitionKey(TRANSFER_PARTITION) },
    { kind: 'tombstone', key: decisionPartitionKey('conversation-a') },
    { kind: 'put', key: decisionConversationKey('fresh-conversation'), value: { conversationId: 'fresh-conversation', lastLsn: 0 } },
  ] satisfies DurableProjectionMutation[]])));
  expect(await conversationDecisionReady(second.log, 'conversation-a')).toBe(false);
  expect(await conversationDecisionReady(second.log, 'fresh-conversation')).toBe(false);
  await startConversationDecisionMigration(second.log);
  for (const id of projections) {
    expect(await second.log.transactDurableProjection(id, async view => ({ kind: 'return', value: await view.get(DECISION_MIGRATION_COMPLETE) }))
      .then(result => result.value)).toBeDefined();
  }
  const migrated = { canonical: await rows(second.log, CONVERSATION_RUN_STATE_PROJECTION_ID), advancement: await rows(second.log, ADVANCEMENT_RECOVERY_PROJECTION_ID) };
  await second.log.stopStorageMaintenance();
  expect(await fullRebuild(root)).toEqual(migrated);
}, 120_000);

it('withdraws every other partition of a fact folded outside admission instead of reducing it partially', async () => {
  const view = new DecisionRows();
  view.apply([[DECISION_MIGRATION_START, { lsn: 1 }], [DECISION_INDEXED_THROUGH, { lsn: 1 }],
    [decisionConversationKey('unmigrated'), { conversationId: 'unmigrated', lastLsn: 1 }],
    [decisionConversationKey('migrated'), { conversationId: 'migrated', lastLsn: 1 }], [decisionPartitionKey('migrated'), { conversationId: 'migrated' }]]);
  const reduce = partitionedDecisionReducer({} as never, async () => { throw new Error('a partial envelope must not be reduced'); });
  const envelope = { lsn: 9, at: NOW, entries: ['unmigrated', 'migrated', 'fresh'].map(id => ({ stream: 'run:' + id, body: { t: 'admitted' } })) } as unknown as CommitEnvelope<JsonValue>;
  const checkpoint = { logId: 'log', lsn: 9, frameEndOffset: 0, prefixDigest: '' } as unknown as DurableLogCheckpoint;
  // 候选写入：先迁移未迁移分区再重做。
  await expect(reduce(envelope, view, { checkpoint, candidate: true })).rejects.toBeInstanceOf(AuthorityPreparationRequired);
  // 不经准入：已迁移会话撤回标记，没有历史的新会话记入清单，二者此后都从日志完整迁移。
  const mutations = await reduce(envelope, view, { checkpoint });
  expect(mutations).toEqual([
    { kind: 'tombstone', key: decisionPartitionKey('migrated') },
    { kind: 'put', key: decisionConversationKey('migrated'), value: { conversationId: 'migrated', lastLsn: 9 } },
    { kind: 'tombstone', key: decisionPartitionKey('fresh') },
    { kind: 'put', key: decisionConversationKey('fresh'), value: { conversationId: 'fresh', lastLsn: 9 } },
  ]);
});

it('migrates a conversation adopted through a transfer and equals the full rebuild', async () => {
  const source = open(await createTempDir('decision-migration-transfer-source'));
  const sourceJournal = source.journal();
  for (let n = 0; n < 3; n++) await admit(sourceJournal, n);
  await sourceJournal.cancelRun({ runId: 'run-1', requestId: 'cancel-1' });
  const root = await createTempDir('decision-migration-transfer-target');
  const target = open(root);
  const tenure = await installVerifiedAnchorTenure(target.log, NOW);
  const adopted = target.journal(CONVERSATION, 2);
  const publication = await importAuthenticatedBase({ sourceLog: source.log, sourceArtifacts: source.artifacts, targetLog: target.log, targetArtifacts: target.artifacts,
    conversationId: CONVERSATION, sourceOwnerEpoch: 1, verifier, signer, sourceJournal, sourceDeviceId: tenure.memberDeviceId, targetDeviceId: tenure.anchorDeviceId });
  await adopted.installImportedBase(publication.source);
  for (let n = 10; n < 13; n++) await admit(adopted, n);
  await adopted.cancelRun({ runId: 'run-11', requestId: 'cancel-11' });
  const expected = { canonical: await rows(target.log, CONVERSATION_RUN_STATE_PROJECTION_ID), advancement: await rows(target.log, ADVANCEMENT_RECOVERY_PROJECTION_ID) };
  await target.log.stopStorageMaintenance();
  await source.log.stopStorageMaintenance();
  await upgrade(root);

  const upgraded = open(root);
  const journal = upgraded.journal(CONVERSATION, 2);
  expect(await conversationDecisionReady(upgraded.log, CONVERSATION)).toBe(false);
  expect(await journal.currentState('run-12')).toBe('queued');
  expect(await journal.currentState('run-11')).toBe('cancelled');
  await startConversationDecisionMigration(upgraded.log);
  expect({ canonical: await rows(upgraded.log, CONVERSATION_RUN_STATE_PROJECTION_ID), advancement: await rows(upgraded.log, ADVANCEMENT_RECOVERY_PROJECTION_ID) }).toEqual(expected);
  await upgraded.log.stopStorageMaintenance();
}, 120_000);
