import path from 'node:path';
import { FileArtifactStore, FileAuthorityCommitLog } from '@zhixing/core/authority';
import type { ConversationControlCursor, ConversationControlPage, ConversationInputCursor, ConversationInputPage, Signature } from '@zhixing/core/contracts';
import { protocolDigest } from '@zhixing/core/protocol';
import { createTempDir } from '@zhixing/test-utils';
import { describe, expect, it } from 'vitest';
import { ConversationRunJournal } from '../conversation-assignment.js';
import { trackAuthorityLog } from './durable-io-test-support.js';

const NOW = '2026-10-05T00:00:00.000Z';
const signer = { sign(schema: string, version: number, payload: unknown): Signature { return { alg: 'test-sha256', keyId: 'device:test', sig: protocolDigest(schema, version, payload) }; } };
const verifier = { verify(schema: string, version: number, payload: unknown, signature: Signature) { expect(signature).toEqual(signer.sign(schema, version, payload)); } };
async function harness() {
  const root = await createTempDir('conversation-recovery');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, 'log'), artifacts, { clock: () => NOW }));
  const journalAt = (epoch = 1) => new ConversationRunJournal({ conversationId: 'recovery-conversation', ownerEpoch: epoch, log, artifacts, signer, verifier,
    submission: { authenticate() {}, authorize() {} }, authority: { decideAtPrefix: () => ({ committed: true, commitRevision: 1 }) }, projection: { async project() {} }, clock: () => NOW });
  return { log, journal: journalAt(), journalAt };
}
async function admit(journal: ConversationRunJournal, text = 'original input') {
  await journal.admit({ ingressKey: 'seed-ingress', runId: 'seed-run', queuedPosition: 0,
    userInput: { parts: [{ type: 'text', text }] }, invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: 'seed-ingress', receivedAt: NOW,
      turnOrigin: { channel: 'rpc', messageIdentity: { id: 'seed-message', source: { kind: 'conversation', conversationId: 'source-conversation' } } } } });
}

describe('finite owner recovery pages', () => {
  it('recovers more than 200 old cancelled inputs and advances inside one authority envelope', async () => {
    const source = await harness(); await admit(source.journal);
    await source.journal.cancelRun({ runId: 'seed-run', requestId: 'seed-cancel' });
    const template = (await source.log.readAll()).flatMap(envelope => envelope.entries);
    const target = await harness();
    const entries = Array.from({ length: 205 }, (_, index) => template.map(entry => {
      const record = JSON.parse(JSON.stringify(entry).replaceAll('seed-', `case-${index}-`));
      if (record.body.t === 'admitted') record.body.queuedPosition = index;
      return record;
    })).flat();
    await target.log.append(entries);
    let cursor: ConversationControlCursor | undefined;
    const seen = new Set<string>(), statuses = new Set<string>(); let withinEnvelope = false;
    do {
      const page = await target.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', cursor }) as ConversationControlPage;
      expect(page.reset).toBe(false); expect(page.facts.length).toBeLessThanOrEqual(32);
      withinEnvelope ||= page.cursor.item > 0;
      for (const fact of page.facts) {
        if (fact.kind === 'status') { expect(fact.notice.state).toBe('cancelled'); statuses.add(fact.notice.ref.runId); }
        if (fact.kind !== 'input') continue;
        const input = await target.journal.recoveryPage({ mode: 'input-page', conversationId: 'recovery-conversation', runId: fact.cursor.runId, cursor: fact.cursor }) as ConversationInputPage;
        expect(input.input?.text).toBe('original input'); expect(input.input?.final).toBe(true);
        expect(seen.has(input.input!.identity.id)).toBe(false); seen.add(input.input!.identity.id);
      }
      cursor = page.cursor; if (!page.hasMore) break;
    } while (seen.size <= 205);
    expect(withinEnvelope).toBe(true); expect(seen.size).toBe(205); expect(statuses.size).toBe(205);
    const rebound = await target.journalAt(2).recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', cursor }) as ConversationControlPage;
    expect(rebound.reset).toBe(false); expect(rebound.facts).toEqual([]); expect(rebound.cursor.ownerEpoch).toBe(2);
  }, 60_000);

  it('keeps Unicode source offsets across finite pages and proves empty only after the final fragment', async () => {
    const { journal } = await harness(); const original = '汉🦞\n'.repeat(12000); await admit(journal, original);
    let cursor: ConversationInputCursor | undefined, text = '', fragments = 0;
    for (;;) {
      const page = await journal.recoveryPage({ mode: 'input-page', conversationId: 'recovery-conversation', runId: 'seed-run', cursor }) as ConversationInputPage;
      expect(page.reset).toBe(false);
      if (page.input) {
        expect(page.input.contentOffset).toBe(text.length); expect(Buffer.byteLength(page.input.text)).toBeLessThanOrEqual(32 * 1024);
        expect(page.input.text).not.toMatch(/[\uD800-\uDBFF]$/u); text += page.input.text; fragments++;
      }
      cursor = page.cursor; if (!page.hasMore) break;
    }
    expect(fragments).toBeGreaterThan(4); expect(text).toBe(original);
  });

  it('reads the verified imported prefix even when its source LSN exceeds the target WAL', async () => {
    const source = await harness(); await admit(source.journal);
    const snapshot = await source.log.readSnapshot();
    const target = await harness(); const targetSnapshot = await target.log.readSnapshot();
    await target.journal.primeRecoverySnapshot({ commits: snapshot.commits, cursor: targetSnapshot.cursor });
    const base = { id: 'transfer-synthetic', clearedThroughLsn: 0, records: snapshot.commits.flatMap(envelope => envelope.entries.map(record => ({ ...record, lsn: envelope.lsn, at: envelope.at }))) };
    const page = await target.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation' }, base) as ConversationControlPage;
    const inputFact = page.facts.find(fact => fact.kind === 'input'); expect(inputFact?.kind).toBe('input');
    if (inputFact?.kind !== 'input') throw Error('missing imported input');
    expect(inputFact.cursor.imported).toBe(true); expect(inputFact.cursor.upper.lsn).toBe(0);
    const input = await target.journal.recoveryPage({ mode: 'input-page', conversationId: 'recovery-conversation', runId: 'seed-run', cursor: inputFact.cursor }, base) as ConversationInputPage;
    expect(input.input?.text).toBe('original input');
    const next = await target.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', cursor: page.cursor }, base) as ConversationControlPage;
    expect(next.facts).toEqual([]); expect(next.hasMore).toBe(false);
    const replaced = await target.journal.recoveryPage({ mode: 'control-page', conversationId: 'recovery-conversation', cursor: page.cursor }, { ...base, id: 'transfer-replaced' }) as ConversationControlPage;
    expect(replaced.reset).toBe(true);
  });
});
