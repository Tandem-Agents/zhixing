import path from 'node:path';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog } from '@zhixing/core/authority';
import { canonicalize, createMutationBatch } from '@zhixing/core/protocol';
import type { ArtifactRef } from '@zhixing/core/contracts';
import { createTempDir } from '@zhixing/test-utils';
import { expect, it, vi } from 'vitest';
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
    entry('final-outbox', { t: 'final', conversationId: 'conversation-discovery', commitRevision: 1, state: 'published' }), entry('publish', decision)];
  return { artifacts, entries, decision, domain, progress: (state: string) => entry('publish', { t: 'publish-progress', assignmentId: batch.assignmentId, domain, state, upToSeq: state === 'settled' ? 1 : 0 }) };
}

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
  for (const omitted of [2, 3, 4]) expect(await discoverConversationRecoveryCandidates([{ entries: f.entries.filter((_, i) => i !== omitted) }], f.artifacts)).toEqual(new Set(['conversation-discovery']));
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

it('discovers directly from the authority log and resumes from a checkpoint with the same result', async () => {
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
    // 首次从头折叠并留下检查点；结果与整份快照折叠一致。
    expect(await discoverConversationRecoveryCandidatesFromLog(writer, f.artifacts)).toEqual(new Set(['conversation-discovery']));
    expect(await snapshotFold(writer)).toEqual(new Set(['conversation-discovery']));
    await vi.waitFor(async () => expect(await readdir(path.join(root, 'authority', 'checkpoints'))).toHaveLength(1));
    await writer.append([state('run-b', 'committed')]);
    await writer.stopStorageMaintenance();
    // 另一个日志实例从检查点续算尾部：只访问检查点之后的记录，结论随尾部变化，并与整份快照折叠相同。
    const reader = open();
    const projection = vi.spyOn(reader, 'readProjection');
    expect(await discoverConversationRecoveryCandidatesFromLog(reader, f.artifacts)).toEqual(new Set());
    expect(projection.mock.calls[0]![2]).toEqual({ cursor: expect.objectContaining({ lsn: 2 }) });
    expect(await snapshotFold(reader)).toEqual(new Set());
    await reader.stopStorageMaintenance();
  }
});
