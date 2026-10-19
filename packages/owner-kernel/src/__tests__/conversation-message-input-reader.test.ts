import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTempDir } from '@zhixing/test-utils';
import { FileArtifactStore, FileAuthorityCommitLog, type DurableLogCheckpoint } from '@zhixing/core/authority';
import { ConversationMessageInputReader } from '../conversation-message-input-reader.js';
import type { ConversationReadIndex, InputPointer } from '../conversation-read-index.js';
import { canonicalize, createConversationSealedBundle } from '@zhixing/core/protocol';
import { trackAuthorityLog, DURABLE_IO_TEST_TIMEOUT_MS } from './durable-io-test-support.js';

const admission = (id: string, position = 0, source = 'user') => ({ t: 'admitted', runId: id, ingressKey: id, queuedPosition: position,
  ingress: { ingressId: id, turnOrigin: { messageIdentity: { id, source: source === 'conversation' ? { kind: source, conversationId: 'sender' } : { kind: source } } } },
  input: { parts: [{ type: 'text', text: id }] } });
const state = (runId: string, value: string, assignmentId?: string) => ({ t: 'state', runId, state: value,
  ...(assignmentId === undefined ? {} : { assignmentId }) });

async function fixture() {
  const root = await createTempDir('message-input-reader');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, 'log'), artifacts));
  const positions: DurableLogCheckpoint[] = [];
  let base: { lsn: number; at: string; stream: string; body: unknown }[] = [];
  const messages = new Map<string, { pointer: InputPointer; initial: boolean; inputKey: string; base?: boolean }>();
  const statuses = new Map<string, { state: string; statusRevision: number }>();
  const runByAssignment = new Map<string, string>();
  const initialConsumed = new Set<string>(), consumed = new Set<string>(), closed = new Set<string>();
  const messagePage = vi.fn(async (_: string, after: number) => positions.filter(p => p.lsn > after).slice(0, 64));
  const inputAt = vi.fn(async (_: string, pointer: InputPointer) => {
    const record = pointer.checkpoint ? (await log.readEnvelopeAt(pointer.checkpoint)).entries[pointer.item]! : base[pointer.item]!;
    return { pointer, input: (record.body as ReturnType<typeof admission>).input };
  });
  const inputsAt = vi.fn(async (id: string, pointers: readonly InputPointer[]) => Promise.all(pointers.map(pointer => inputAt(id, pointer))));
  const messageMetadata = vi.fn(async (_: string, messageId: string) => {
    const message = messages.get(messageId);
    if (!message) return { value: undefined };
    const status = statuses.get(message.pointer.runId);
    if (!status) return { value: undefined };
    return { value: { pointer: message.pointer, status: status as never,
      consumed: message.initial ? initialConsumed.has(message.pointer.runId) : consumed.has(message.inputKey),
      closed: closed.has(message.pointer.runId) } };
  });
  const reader = new ConversationMessageInputReader(log, { messagePage, inputAt, inputsAt, messageMetadata } as unknown as ConversationReadIndex, artifacts, 'c');
  const foldMeta = (raw: unknown, item: number, checkpoint?: DurableLogCheckpoint, fromBase = false) => {
    const body = raw as { t?: string; runId?: string; state?: string; statusRevision?: number; ingressKey?: string;
      queuedPosition?: number; position?: number; assignmentId?: string;
      ingress?: { ingressId?: string; turnOrigin?: { messageIdentity?: { id: string; source: unknown } } };
      ingressKeys?: readonly string[] };
    if (body.t === 'admitted' || body.t === 'run-input-appended') {
      const identity = body.ingress?.turnOrigin?.messageIdentity ?? { id: body.ingress?.ingressId ?? body.ingressKey ?? 'missing', source: { kind: 'user' } };
      const initial = body.t === 'admitted';
      const pointer: InputPointer = { runId: body.runId!, inputKey: body.ingressKey!, position: initial ? body.queuedPosition ?? 0 : body.position ?? 0,
        identity: identity as InputPointer['identity'], initial, item, lsn: checkpoint?.lsn ?? 0, ...(checkpoint ? { checkpoint } : {}) };
      messages.set(identity.id, { pointer, initial, inputKey: body.ingressKey!, ...(fromBase ? { base: true } : {}) });
      if (initial) statuses.set(body.runId!, statuses.get(body.runId!) ?? { state: 'queued', statusRevision: 0 });
      return;
    }
    if (body.t === 'assigned') {
      if (body.assignmentId && body.runId) runByAssignment.set(body.assignmentId, body.runId);
      return;
    }
    if (body.t === 'supersede-started-observed') {
      const run = body.assignmentId ? runByAssignment.get(body.assignmentId) : undefined;
      if (run) initialConsumed.add(run);
      return;
    }
    if (body.t === 'state') {
      statuses.set(body.runId!, { state: body.state!, statusRevision: body.statusRevision ?? 0 });
      if (['running', 'committed', 'failed', 'cancelled'].includes(body.state!)) initialConsumed.add(body.runId!);
      return;
    }
    if (body.t === 'run-input-opened' || body.t === 'run-input-closed') {
      initialConsumed.add(body.runId!);
      if (body.t === 'run-input-closed') closed.add(body.runId!);
      return;
    }
    if (body.t === 'run-input-consumed') for (const key of body.ingressKeys ?? []) consumed.add(key);
  };
  const append = async (...bodies: unknown[]) => {
    const entries = [];
    for (const raw of bodies) {
      const body = raw as { t?: string; assignmentId?: string; runId?: string };
      let stored = raw;
      if (body.t === 'assigned') stored = { ...body, dispatchRef: await artifacts.put(Buffer.from(canonicalize({
        v: 1, assignmentId: body.assignmentId, execution: 'conversation', dependencyArtifacts: [], work: {},
      }))) };
      if (body.t === 'committed') stored = { ...body, bundle: { ref: await artifacts.put(Buffer.from(canonicalize(createConversationSealedBundle({
        assignmentId: body.assignmentId!, executorId: 'executor-test', dependencyArtifacts: [],
        streamFinal: { finalSeq: 1, streamDigest: 'sha256:' + '0'.repeat(64) },
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        usageFinal: { reportDigest: 'sha256:' + '0'.repeat(64), upToUsageSeq: 0 },
        body: { t: 'conversation', conversationId: 'c', runId: body.runId!, ownerEpoch: 1, baseRevision: 0,
          runRecord: { type: 'run', timestamp: '2026-10-01T00:00:00.000Z', runId: body.runId!, runIndex: 0,
            messages: [{ role: 'user', content: [{ type: 'text', text: body.runId! }] }] }, contentAssets: [] },
      })))) } };
      entries.push({ stream: 'run:c', body: stored });
    }
    await log.append(entries);
    const checkpoint = await log.checkpoint();
    positions.push(checkpoint);
    for (const [item, raw] of bodies.entries()) foldMeta(raw, item, checkpoint);
  };
  const installBase = (bodies: unknown[]) => {
    for (const [id, message] of messages) if (message.base) messages.delete(id);
    base = bodies.map((body, item) => ({ lsn: item + 30, at: '2026-10-01T00:00:00.000Z', stream: 'run:c', body }));
    for (const [item, raw] of bodies.entries()) foldMeta(raw, item, undefined, true);
    reader.installBase(base);
  };
  return { log, reader, append, installBase, inputAt, inputsAt, messagePage, artifacts };
}

it('queries initial and appended delivery without opening historical execution artifacts', async () => {
  const f = await fixture();
  await f.append(admission('r'), state('r', 'queued'), { t: 'assigned', runId: 'r', assignmentId: 'a', dispatchRef: 'must-not-read' },
    state('r', 'running', 'a'), { t: 'run-input-opened', runId: 'r', assignmentId: 'a' });
  const extra = (id: string, position: number) => ({ ...admission(id, position), t: 'run-input-appended', runId: 'r', position });
  await f.append(extra('used', 1), extra('unused', 2), { t: 'run-input-consumed', runId: 'r', assignmentId: 'a', ingressKeys: ['used'] },
    { t: 'run-input-closed', runId: 'r', assignmentId: 'a' }, { t: 'cancel-fence', assignmentId: 'a' }, state('r', 'cancelled', 'a'));
  const get = vi.spyOn(f.artifacts, 'get').mockRejectedValue(Error('Execution artifacts must not be opened'));
  const page = await f.reader.messageInputsOutsideHistory();
  expect(page.inputs.map(({ consumed, disposition, message }) => [message.inputIdentity?.id, consumed, disposition]))
    .toEqual([['r', true, 'consumed'], ['used', true, 'consumed'], ['unused', false, 'stopped']]);
  expect(get).not.toHaveBeenCalled();
  get.mockRestore();
  await f.append({ t: 'committed', runId: 'r', assignmentId: 'a' }, state('r', 'committed', 'a'));
  expect((await f.reader.messageInputsOutsideHistory()).inputs.map(x => x.message.inputIdentity?.id)).toEqual(['unused']);
  expect(await f.reader.messageStatus('r')).toMatchObject({ consumed: true, state: 'committed' });
}, DURABLE_IO_TEST_TIMEOUT_MS);

it('retains old assignment started evidence through uncertainty and replacement', async () => {
  const f = await fixture();
  await f.append(admission('r'), state('r', 'queued'), { t: 'assigned', runId: 'r', assignmentId: 'old' }, state('r', 'dispatched', 'old'),
    state('r', 'uncertain', 'old'));
  expect(await f.reader.messageStatus('r')).toMatchObject({ consumed: false, state: 'uncertain' });
  await f.append({ t: 'supersede-started-observed', assignmentId: 'old' }, { t: 'assignment-superseded', assignmentId: 'old' },
    state('r', 'queued'), { t: 'assigned', runId: 'r', assignmentId: 'new' }, state('r', 'dispatched', 'new'));
  expect(await f.reader.messageStatus('r')).toMatchObject({ consumed: true, state: 'dispatched' });
}, DURABLE_IO_TEST_TIMEOUT_MS);

it('discovers remote control targets beyond the uncertain-first display limit without reading their bodies', async () => {
  const f = await fixture();
  await f.append(admission('remote', 0, 'conversation'), state('remote', 'queued'));
  for (let i = 1; i <= 205; i++) await f.append(admission('uncertain-' + i, i), state('uncertain-' + i, 'uncertain'));
  const result = await f.reader.messageInputsOutsideHistory();
  expect(result.truncated).toBe(true); expect(result.inputs).toHaveLength(200);
  expect(result.interruptibleRuns).toEqual([{ runId: 'remote', state: 'queued' }]);
  expect(f.inputAt).toHaveBeenCalledTimes(200);
  expect(f.inputAt.mock.calls.some(([, p]) => p.runId === 'remote')).toBe(false);
  expect(f.messagePage.mock.calls.length).toBe(4);
}, DURABLE_IO_TEST_TIMEOUT_MS);

it('uses imported input locators with local control facts and resets on clear, deletion and base replacement', async () => {
  const f = await fixture();
  f.installBase([admission('base'), state('base', 'queued')]);
  await f.append({ t: 'assigned', runId: 'base', assignmentId: 'a' }, state('base', 'running', 'a'));
  expect(await f.reader.messageStatus('base')).toMatchObject({ state: 'running', consumed: true });
  await f.append({ t: 'session-lifecycle', mutation: 'clear' });
  await f.append(admission('new', 100), state('new', 'queued'));
  expect((await f.reader.messageInputsOutsideHistory()).inputs.map(x => x.message.inputIdentity?.id)).toEqual(['new']);
  await f.append({ t: 'session-meta', operation: 'delete' });
  expect((await f.reader.messageInputsOutsideHistory()).inputs).toEqual([]);
  f.installBase([admission('replacement'), state('replacement', 'queued')]);
  expect(await f.reader.messageStatus('base')).toBeUndefined();
}, DURABLE_IO_TEST_TIMEOUT_MS);

it('does not return an old body after the read base changes during materialization', async () => {
  const f = await fixture();
  f.installBase([admission('old'), state('old', 'queued')]);
  const original = f.inputAt.getMockImplementation()!;
  f.inputAt.mockImplementationOnce(async (id, pointer) => {
    const result = await original(id, pointer);
    f.installBase([admission('new'), state('new', 'queued')]);
    return result;
  });
  expect((await f.reader.messageInputsOutsideHistory()).inputs.map(x => x.message.inputIdentity?.id)).toEqual(['new']);
}, DURABLE_IO_TEST_TIMEOUT_MS);
