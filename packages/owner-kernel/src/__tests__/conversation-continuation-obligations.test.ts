import { it, expect, vi } from 'vitest';
import { registerConversationReadProjection } from '../conversation-read-index.js';
import { BASE_CONVERSATION, BASE_NOW, baseVerifier, createConversationBaseHarness } from './conversation-base-harness.js';

async function admitContinuation(journal: { admit: (input: never) => Promise<unknown> }, runId: string, position: number, parent: string) {
  await journal.admit({ runId, ingressKey: runId, queuedPosition: position,
    userInput: { parts: [{ type: 'text', text: runId }] }, invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:fixture', deviceId: 'fixture-device', ingressId: runId, receivedAt: BASE_NOW,
      turnOrigin: { channel: 'rpc', worksceneContinuation: { kind: 'task', conversationId: BASE_CONVERSATION, runId: parent } } } } as never);
}

/**
 * Bounded discovery with a real ended delegation: the parent run is admitted
 * and cancelled through the normal journal path, then its child is admitted
 * and cancelled the same way. Ended parent-child pairs must leave the current
 * candidate set at their own ending facts, in either admission order.
 */
it.each([4, 16])('retires ended delegations from the current candidate set: %i', async size => {
  const harness = await createConversationBaseHarness();
  const ended = async (runId: string, position: number, parent?: string) => {
    if (parent) await admitContinuation(harness.sourceJournal as never, runId, position, parent);
    else await harness.admit(harness.sourceJournal, runId, position);
    await harness.sourceJournal.cancelRun({ runId, requestId: `cancel-${runId}` });
  };
  for (let index = 0; index < size; index += 1) {
    // Order A: the child exists before the parent ends.
    await harness.admit(harness.sourceJournal, `before-${index}`, index * 2);
    await admitContinuation(harness.sourceJournal as never, `child-a-${index}`, index * 2 + 1, `before-${index}`);
    await harness.sourceJournal.cancelRun({ runId: `child-a-${index}`, requestId: `cancel-ca-${index}` });
    await harness.sourceJournal.cancelRun({ runId: `before-${index}`, requestId: `cancel-b-${index}` });
    // Order B: the parent ends before the child is admitted (the review probe).
    await ended(`after-${index}`, size * 2 + index * 2);
    await ended(`child-b-${index}`, size * 2 + index * 2 + 1, `after-${index}`);
  }
  const index = registerConversationReadProjection(harness.source.log, harness.source.artifacts, baseVerifier);
  const original = index.scan.bind(index);
  let scanned = 0;
  const spy = vi.spyOn(index, 'scan').mockImplementation(async (...args) => {
    const result = await original(...args);
    scanned += result.entries.length;
    return result;
  });
  try {
    const sources = await harness.journal('source').worksceneContinuationSources();
    console.log('CONTINUATION_ENDED', JSON.stringify({ size, scanned, materialized: sources.length }));
    expect(sources).toHaveLength(0);
    expect(scanned).toBe(0);
  } finally { spy.mockRestore(); }
}, 120000);

/** The same discovery must still return an obligation that is genuinely open. */
it('keeps an unfinished continuation child in the current candidate set', async () => {
  const harness = await createConversationBaseHarness();
  await harness.admit(harness.sourceJournal, 'live-parent', 0);
  await harness.sourceJournal.admit({ runId: 'live-child', ingressKey: 'live-child', queuedPosition: 1,
    userInput: { parts: [{ type: 'text', text: 'live-child' }] }, invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:fixture', deviceId: 'fixture-device', ingressId: 'live-child', receivedAt: BASE_NOW,
      turnOrigin: { channel: 'rpc', worksceneContinuation: { kind: 'task', conversationId: BASE_CONVERSATION, runId: 'live-parent' } } } });
  const sources = await harness.journal('source').worksceneContinuationSources();
  expect(sources.map(source => source.runId)).toEqual(['live-child']);
  expect(sources[0]?.current).toBe(true);
}, 120000);

it.each([4, 16])('retires imported pending children locally while preserving exact source history: %i', async size => {
  const h = await createConversationBaseHarness();
  await h.admit(h.sourceJournal, 'parent', 0);
  for (let n = 0; n < size; n++) await admitContinuation(h.sourceJournal as never, `child:${n}`, n + 1, 'parent');
  await h.transfer();
  expect((await h.targetJournal.worksceneContinuationSources()).map(row => row.runId).sort()).toEqual(Array.from({ length: size }, (_, n) => `child:${n}`).sort());
  for (let n = 0; n < size; n++) await h.targetJournal.cancelRun({ runId: `child:${n}`, requestId: `stop:${n}` });
  const restarted = await h.restartTarget();
  const directory = registerConversationReadProjection(restarted.log, restarted.artifacts, baseVerifier);
  const scan = directory.scan.bind(directory); let rows = 0;
  const spy = vi.spyOn(directory, 'scan').mockImplementation(async (...args) => { const result = await scan(...args); rows += result.entries.length; return result; });
  try {
    expect(await restarted.owner.worksceneContinuationSources()).toEqual([]);
    expect(rows).toBe(0);
    expect((await restarted.owner.worksceneContinuationSources({ runId: 'child:0' }))[0]).toMatchObject({ state: 'cancelled', current: false });
    console.log('IMPORTED_CONTINUATION_RETIRED', JSON.stringify({ size, rows }));
  } finally { spy.mockRestore(); }
}, 120_000);
