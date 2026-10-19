import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog } from '@zhixing/core/authority';
import { canonicalize, createMutationBatch } from '@zhixing/core/protocol';
import type { ArtifactRef } from '@zhixing/core/contracts';
import { createTempDir } from '@zhixing/test-utils';
import { expect, it, vi } from 'vitest';
import { registerConversationRecoveryProjection, conversationRecoveryPage } from '../conversation-recovery-index.js';
import type { AuthorityCommitLog, DurableProjectionDefinition } from '@zhixing/core/authority';
import type { JsonValue } from '@zhixing/core/contracts';
import { discoverConversationRecoveryCandidates, discoverConversationRecoveryCandidatesFromLog } from '../conversation-assignment.js';

async function fixture(domain: 'session' | 'global') {
  const artifacts = new FileArtifactStore(path.join(await createTempDir('recovery-discovery'), 'artifacts'));
  const batch = createMutationBatch('assignment-discovery', [domain === 'session'
    ? { v: 1, t: 'staged-mutation', seq: 1, domain, requestId: 'mutation', mutation: { kind: 'task-list-op', op: { op: 'set', state: { items: [] } } } }
    : { v: 1, t: 'staged-mutation', seq: 1, domain, requestId: 'mutation', expected: { anchorEpoch: 1 }, mutation: { kind: 'schedule-delete', taskId: 'schedule-discovery', taskRevision: 1 } }]);
  const ref = await artifacts.put(Buffer.from(canonicalize(batch)));
  const entry = (stream: string, body: unknown) => ({ stream, body });
  const decision = { t: 'publish-decision', assignmentId: batch.assignmentId, batch: { ref }, sessionCount: domain === 'session' ? 1 : 0, globalCount: domain === 'global' ? 1 : 0,
    outcomes: [{ seq: 1, outcome: { t: 'granted', targetRevision: 1 } }] };
  const entries = [entry('run:conversation-discovery', { t: 'committed', runId: 'run-discovery', assignmentId: batch.assignmentId, commitRevision: 1, readSummary: { controlRecovery: false } }),
    entry('run:conversation-discovery', { t: 'state', runId: 'run-discovery', state: 'committed' }),
    entry('run:conversation-discovery', { kind: 'conversation-commit-projection', assignmentId: batch.assignmentId }),
    entry('run:conversation-discovery', { t: 'bundle-ack-observed', assignmentId: batch.assignmentId }),
    entry('final-outbox', { t: 'final', conversationId: 'conversation-discovery', runId: 'run-discovery', digest: 'sha256:' + '1'.repeat(64), commitRevision: 1, state: 'pending' }), entry('final-outbox', { t: 'final', conversationId: 'conversation-discovery', runId: 'run-discovery', digest: 'sha256:' + '1'.repeat(64), commitRevision: 1, state: 'published' }), entry('publish', decision)];
  return { artifacts, entries, decision, domain, progress: (state: string) => entry('publish', { t: 'publish-progress', assignmentId: batch.assignmentId, domain, state, upToSeq: state === 'settled' ? 1 : 0 }) };
}

/** Reducer conformance uses the same fact cases as the old complete fold.
 * Physical source authentication and cross-instance persistence are exercised
 * separately below with the real FileAuthorityCommitLog. */
function indexedFacts(artifacts: FileArtifactStore) {
  let definition!: DurableProjectionDefinition<unknown>, lsn = 0;
  const rows = new Map<string, JsonValue>();
  const log = { durableProjection(value: DurableProjectionDefinition<unknown>) {
    definition = value;
    return { async scan(range: { gte?: string; gt?: string; lt?: string }, limit: number) {
      const entries = [...rows].filter(([key]) => (!range.gte || key >= range.gte) && (!range.gt || key > range.gt) && (!range.lt || key < range.lt))
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }));
      return { entries: entries.slice(0, limit), ...(entries.length > limit ? { continuation: 'more' } : {}) };
    } };
  } } as unknown as AuthorityCommitLog;
  registerConversationRecoveryProjection(log, artifacts);
  return { log, async append(entries: readonly { stream: string; body: unknown }[]) {
    const changes = await definition.reduce({ lsn: ++lsn, at: '2026-10-17T00:00:00.000Z', entries } as never,
      { get: async key => rows.get(key), scan: async () => { throw Error('Reducer must use exact keys'); } }, {} as never);
    for (const change of changes) if (change.kind === 'put') rows.set(change.key, change.value); else rows.delete(change.key);
  }, pending: () => discoverConversationRecoveryCandidatesFromLog(log, artifacts) };
}

it.each(['session', 'global'] as const)('indexed obligations preserve %s publication, terminal and lifecycle recovery', async domain => {
  const f = await fixture(domain);
  for (const omit of [-1, 2, 3, 5]) {
    const indexed = indexedFacts(f.artifacts), entries = f.entries.filter((_, i) => i !== omit);
    await indexed.append(entries);
    expect(await indexed.pending()).toEqual(await discoverConversationRecoveryCandidates([{ entries }], f.artifacts));
    await indexed.append([f.progress('settled')]);
    expect(await indexed.pending()).toEqual(await discoverConversationRecoveryCandidates([{ entries: [...entries, f.progress('settled')] }], f.artifacts));
  }
  const indexed = indexedFacts(f.artifacts);
  await indexed.append([{ stream: 'run:c', body: { t: 'session-lifecycle', domainRevision: 1, mutation: 'delete' } }]);
  expect(await indexed.pending()).toEqual(new Set(['c']));
  await indexed.append([{ stream: 'run:c', body: { kind: 'conversation-lifecycle-projection', domainRevision: 1 } }]);
  expect(await indexed.pending()).toEqual(new Set());
});

it('retains an unknown missing-batch obligation until durable settlement and pages only pending identities', async () => {
  const f = await fixture('global'), indexed = indexedFacts(f.artifacts);
  f.decision.batch.ref = { digest: 'sha256:' + '0'.repeat(64), bytes: 1 };
  await indexed.append(f.entries);
  expect(await indexed.pending()).toEqual(new Set(['conversation-discovery']));
  await indexed.append([f.progress('settled')]);
  expect(await indexed.pending()).toEqual(new Set());
  for (let n = 0; n < 35; n++) await indexed.append([{ stream: 'run:c-' + n, body: { t: 'state', runId: 'r', state: 'running' } }]);
  const first = await conversationRecoveryPage(indexed.log, f.artifacts), second = await conversationRecoveryPage(indexed.log, f.artifacts, first.after);
  expect(first.conversationIds).toHaveLength(32); expect(second.conversationIds).toHaveLength(3);
  expect(new Set([...first.conversationIds, ...second.conversationIds]).size).toBe(35);
  expect(second.after).toBeUndefined();
});

it('does not manufacture an external publish obligation from an internal session mutation count', async () => {
  const f = await fixture('session');
  expect(await discoverConversationRecoveryCandidates([{ entries: f.entries }], f.artifacts)).toEqual(new Set());
  // Historical unnecessary pending records cannot change the owner semantics.
  expect(await discoverConversationRecoveryCandidates([{ entries: [...f.entries, f.progress('pending')] }], f.artifacts)).toEqual(new Set());
});

it.each([false, true])('recovers real external publishing even with a legacy missing progress record (pending=%s)', async pending => {
  const f = await fixture('global');
  const entries = pending ? [...f.entries, f.progress('pending')] : f.entries;
  expect(await discoverConversationRecoveryCandidates([{ entries }], f.artifacts)).toEqual(new Set(['conversation-discovery']));
  expect(await discoverConversationRecoveryCandidates([{ entries: [...entries, f.progress('settled')] }], f.artifacts)).toEqual(new Set());
});

it('keeps unfinished final, run, projection, acknowledgement and lifecycle work recoverable', async () => {
  const f = await fixture('session');
  for (const omitted of [2, 3, 5]) expect(await discoverConversationRecoveryCandidates([{ entries: f.entries.filter((_, i) => i !== omitted) }], f.artifacts)).toEqual(new Set(['conversation-discovery']));
  for (const body of [{ t: 'state', runId: 'run-next', state: 'running' }, { t: 'session-lifecycle', domainRevision: 2, mutation: 'clear' }]) {
    expect(await discoverConversationRecoveryCandidates([{ entries: [...f.entries, { stream: 'run:conversation-discovery', body }] }], f.artifacts)).toEqual(new Set(['conversation-discovery']));
  }
});

it('does not treat an unavailable legacy batch as proof that publishing finished', async () => {
  const f = await fixture('global');
  (f.decision.batch as { ref: ArtifactRef }).ref = { digest: 'sha256:' + '0'.repeat(64), bytes: 1 };
  await expect(discoverConversationRecoveryCandidates([{ entries: f.entries }], f.artifacts)).rejects.toThrow();
});

it('recovers a rejected external mutation until its actual settlement', async () => {
  const f = await fixture('global');
  const decision = { ...f.decision, outcomes: [{ seq: 1, outcome: { t: 'conflicted', error: { code: 'revision-conflict', message: 'changed', retryable: false } } }] };
  const entries = [...f.entries.slice(0, -1), { stream: 'publish', body: decision }, f.progress('pending')];
  expect(await discoverConversationRecoveryCandidates([{ entries }], f.artifacts)).toEqual(new Set(['conversation-discovery']));
  expect(await discoverConversationRecoveryCandidates([{ entries: [...entries, f.progress('settled')] }], f.artifacts)).toEqual(new Set());
});

it('discovers indexed obligations across instances without restoring a scalar historical checkpoint', async () => {
  const f = await fixture('session');
  const root = await createTempDir('recovery-discovery-log');
  const code = path.join(root, 'code');
  await mkdir(code, { recursive: true });
  await writeFile(path.join(code, 'module.js'), 'export const version = 1;');
  const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 7));
  {
    const open = () => new FileAuthorityCommitLog(path.join(root, 'authority'), f.artifacts, { integrity });
    const state = (runId: string, value: string) => ({ stream: 'run:conversation-discovery', body: { t: 'state', runId, state: value } });
    const snapshotFold = async (log: FileAuthorityCommitLog) => discoverConversationRecoveryCandidates((await log.readSnapshot()).commits, f.artifacts);
    const writer = open();
    await writer.append([state('run-a', 'committed')]);
    await writer.append([state('run-b', 'running')]);
    // 首次建立义务目录；结果与完整事实折叠一致。
    expect(await discoverConversationRecoveryCandidatesFromLog(writer, f.artifacts)).toEqual(new Set(['conversation-discovery']));
    expect(await snapshotFold(writer)).toEqual(new Set(['conversation-discovery']));
    await writer.append([state('run-b', 'committed')]);
    await writer.stopStorageMaintenance();
    // 另一个日志实例从检查点续算尾部：只访问检查点之后的记录，结论随尾部变化，并与整份快照折叠相同。
    const reader = open();
    const projection = vi.spyOn(reader, 'readProjection');
    const checkpoint = vi.spyOn(reader, 'loadProjectionCheckpoint');
    expect(await discoverConversationRecoveryCandidatesFromLog(reader, f.artifacts)).toEqual(new Set());
    expect(projection).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(await snapshotFold(reader)).toEqual(new Set());
    await reader.stopStorageMaintenance();
  }
});
