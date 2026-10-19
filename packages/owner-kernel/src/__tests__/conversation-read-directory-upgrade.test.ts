import { it, expect } from 'vitest';
import { FileAuthorityCommitLog, AuthorityCacheIntegrity } from '@zhixing/core/authority';
import { createTempDir } from '@zhixing/test-utils';
import { ConversationDirectoryReducer, registerConversationReadProjection } from '../conversation-read-index.js';
import { createConversationBaseHarness, BASE_NOW, baseVerifier } from './conversation-base-harness.js';

/**
 * The previous shipped candidate persisted its derived directory at version 14,
 * which never wrote the input-closed rows. A home carrying those rows must
 * report a closed input after the reducer version change: the new version
 * directory is rebuilt from the durable log, without rewriting any WAL record,
 * and the rebuild is a one-time cost (the second open reuses it).
 */
it('rebuilds the derived directory so a legacy-version home reports a closed input', async () => {
  const harness = await createConversationBaseHarness();
  const root = await createTempDir('read-directory-upgrade');
  const settings = { clock: () => BASE_NOW, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 45)) };
  const key = JSON.stringify('upgrade') + ':input-closed:' + JSON.stringify('r');
  const fact = { stream: 'run:upgrade', body: { t: 'run-input-closed' as const, runId: 'r', assignmentId: 'a' } };

  // The pre-fix candidate: version 14 rows, produced by the same reducer minus
  // the newly added input-closed mutations.
  const legacyLog = new FileAuthorityCommitLog(root, harness.source.artifacts, settings);
  const legacyReducer = new ConversationDirectoryReducer(harness.source.artifacts, baseVerifier);
  const legacyIndex = legacyLog.durableProjection({
    projectionId: 'conversation-read-directory', reducerVersion: 14,
    inputs: { families: ['run:'], streams: ['final-outbox'] },
    reduce: async (envelope, current, source) =>
      (await legacyReducer.reduce(envelope.entries, envelope.at, envelope.lsn, currentKey => current.get(currentKey), source.checkpoint))
        .filter(change => !change.key.includes('input-closed:')),
  });
  await legacyLog.append([fact]);
  expect(await legacyIndex.get(key)).toBeUndefined();
  await legacyLog.stopStorageMaintenance();

  const first = new FileAuthorityCommitLog(root, harness.source.artifacts, settings);
  try {
    const index = registerConversationReadProjection(first, harness.source.artifacts, baseVerifier);
    // Production prepares the directory projection at startup; the absent
    // version directory is rebuilt from the log there.
    await first.prepareProjections(['conversation-read-directory']);
    expect(await index.get(key)).toBe(true);
  } finally { await first.stopStorageMaintenance(); }

  const second = new FileAuthorityCommitLog(root, harness.source.artifacts, settings);
  try {
    const index = registerConversationReadProjection(second, harness.source.artifacts, baseVerifier);
    await second.prepareProjections(['conversation-read-directory']);
    expect(await index.get(key)).toBe(true);
  } finally { await second.stopStorageMaintenance(); }
}, 120000);
