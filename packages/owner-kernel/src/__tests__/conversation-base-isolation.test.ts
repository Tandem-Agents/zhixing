import { expect, it, vi } from 'vitest';
import { AuthorityStorageError } from '@zhixing/core/authority';
import { baseVerifier, createConversationBaseHarness } from './conversation-base-harness.js';
import { registerConversationRunProjection } from '../conversation-run-state-index.js';
import { registerConversationRecoveryProjection, conversationRecoveryPage } from '../conversation-recovery-index.js';
import { BASE_CONVERSATION } from './conversation-base-harness.js';

it('isolates missing committed source evidence during index reconstruction and resumes after repair without rolling back epoch', async () => {
  const h = await createConversationBaseHarness();
  await h.input(h.sourceJournal, 'adopted', 0);
  const transfer = await h.transfer();
  const healthy = h.journal('target', h.target, 'local-12345678-01K1ZZZZZZ0000000000000001');
  await h.input(healthy, 'independent', 0);
  const records = transfer.publication.manifest.authorityBase.records;
  await transfer.publication.source.cache.reset();
  const read = h.target.artifacts.readRange.bind(h.target.artifacts);
  const missing = vi.spyOn(h.target.artifacts, 'readRange').mockImplementation((ref, start, bytes) => {
    if (ref.digest === records.digest) throw new AuthorityStorageError('artifact-missing', 'Synthetic committed source is unavailable');
    return read(ref, start, bytes);
  });
  try {
    await registerConversationRunProjection(h.target.log, h.target.artifacts, baseVerifier).rebuild();
    await registerConversationRecoveryProjection(h.target.log, h.target.artifacts).rebuild();
    expect((await conversationRecoveryPage(h.target.log, h.target.artifacts)).conversationIds).toContain(BASE_CONVERSATION);
    expect(await healthy.currentState('independent')).toBe('cancelled');
    await h.input(healthy, 'new-independent', 1);
    await expect(h.targetJournal.currentState('adopted')).rejects.toThrow();
    expect((await h.importer.state('xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV'))?.identity.nextOwnerEpoch).toBe(2);
  } finally { missing.mockRestore(); }
  expect(await h.targetJournal.currentState('adopted')).toBe('cancelled');
  expect(await healthy.currentState('new-independent')).toBe('cancelled');
}, 120_000);
