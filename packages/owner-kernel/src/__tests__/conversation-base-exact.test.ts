import { expect, it, vi } from 'vitest';
import { createConversationBaseHarness } from './conversation-base-harness.js';

it('finds imported message identities beyond the first 512 inputs without loading the history array', async () => {
  const resumeRoot = process.env.ZHIXING_BASE_EXACT_RESUME_ROOT;
  const h = await createConversationBaseHarness({ root: resumeRoot });
  if (!resumeRoot) for (let i = 0; i < 513; i++) await h.input(h.sourceJournal, 'input-' + i, i);
  expect(await h.sourceJournal.currentState('input-512')).toBe('cancelled');
  const transferred = await h.transfer(), ref = transferred.publication.manifest.authorityBase.records;
  const get = h.target.artifacts.get.bind(h.target.artifacts);
  const reads = vi.spyOn(h.target.artifacts, 'get').mockImplementation(async requested => {
    if (requested.digest === ref.digest) throw Error('Exact read loaded the complete imported record array');
    return get(requested);
  });
  try {
    for (const i of [0, 256, 512]) {
      const message = await h.targetJournal.messageStatus('message-input-' + i);
      expect(message?.message.content).toEqual([{ type: 'text', text: 'input-' + i }]);
      expect(message?.state).toBe('cancelled');
    }
    expect(await h.targetJournal.messageStatus('absent-message')).toBeUndefined();
  } finally { reads.mockRestore(); }
}, 600_000);
