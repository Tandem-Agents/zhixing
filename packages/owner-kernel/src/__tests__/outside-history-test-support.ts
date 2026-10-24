/**
 * 历史外输入测试的共用夹具：真实日志与读目录、按记录契约构造的运行路径、
 * 新实现与早期全量折叠实现（参照）读同一份日志并逐例对照。只在测试中使用。
 */

import path from 'node:path';
import { expect } from 'vitest';
import { createTempDir } from '@zhixing/test-utils';
import { FileArtifactStore, FileAuthorityCommitLog, type ArtifactRef } from '@zhixing/core/authority';
import { canonicalize, createConversationSealedBundle, protocolDigest, type ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { resolutionFactDigest } from '../conversation-run-contracts.js';
import { ConversationMessageInputReader, foldDeliveryFacts } from '../conversation-message-input-reader.js';
import { ConversationReadIndex } from '../conversation-read-index.js';
import { ReferenceMessageInputReader } from './reference-message-input-reader.js';
import { trackAuthorityLog } from './durable-io-test-support.js';

export const NOW = '2026-10-24T00:00:00.000Z';
export const ID = 'outside-conversation';
export const verifier: ProtocolSignatureVerifier = { verify() {} };
const digest = (n: number) => 'sha256:' + n.toString(16).padStart(64, '0');

export type Body = Record<string, unknown>;

/**
 * 按读目录记录合同构造一个会话的运行记录（提交与 final 同信封、消费回执、uncertain 开启事实同信封）。
 * startRevision 给已有状态的运行（例如导入基底里的排队运行）接续状态修订。
 */
export function recordBuilders(conversationId: string, artifacts: FileArtifactStore, options: { ownerEpoch?: number; position?: number } = {}) {
  const ownerEpoch = options.ownerEpoch ?? 1;
  const revisions = new Map<string, number>();
  let position = options.position ?? 0, commitRevision = 0, domainRevision = 0, boundary = 0;
  const bundle = async (runId: string, revision: number): Promise<ArtifactRef> => artifacts.put(Buffer.from(canonicalize(createConversationSealedBundle({
    assignmentId: 'a-' + runId, executorId: 'executor-test', dependencyArtifacts: [],
    streamFinal: { finalSeq: 1, streamDigest: digest(0) }, usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    usageFinal: { reportDigest: digest(0), upToUsageSeq: 0 },
    body: { t: 'conversation', conversationId, runId, ownerEpoch, baseRevision: revision - 1,
      runRecord: { type: 'run', timestamp: NOW, runId, runIndex: revision - 1, messages: [{ role: 'user', content: [{ type: 'text', text: runId }] }] }, contentAssets: [] },
  }))));
  const identity = (id: string, conversation: boolean) => ({ id, source: conversation ? { kind: 'conversation', conversationId: 'sender' } : { kind: 'user' } });
  /** legacy：较早的接纳没有消息身份，只有 ingressId */
  const ingress = (id: string, conversation: boolean, legacy = false) => ({ kind: 'first-party', surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: id, receivedAt: NOW,
    ...(legacy ? {} : { turnOrigin: { channel: 'rpc', messageIdentity: identity(id, conversation) } }) });
  const r = {
    admitted: (runId: string, conversation = false, legacy = false): Body => ({ t: 'admitted', runId, ingressKey: runId, queuedPosition: position++,
      input: { parts: [{ type: 'text', text: 'input ' + runId }] }, invocation: { kind: 'agent', source: 'interactive' }, ingress: ingress(runId, conversation, legacy) }),
    appended: (runId: string, key: string, conversation = false): Body => ({ t: 'run-input-appended', runId, ingressKey: key, position: position++,
      input: { parts: [{ type: 'text', text: 'append ' + key }] }, ingress: ingress(key, conversation) }),
    state: (runId: string, state: string, assignment?: string): Body => {
      const revision = (revisions.get(runId) ?? 0) + 1; revisions.set(runId, revision);
      return { t: 'state', runId, state, statusRevision: revision, ...(assignment ? { assignmentId: assignment } : {}) };
    },
    assigned: async (runId: string): Promise<Body> => ({ t: 'assigned', runId, assignmentId: 'a-' + runId, executorId: 'executor-test', ownerEpoch, baseRevision: 0,
      dispatchDigest: digest(1), manifestDigest: digest(2), permissionLeaseDigest: digest(3),
      dispatchRef: await artifacts.put(Buffer.from(canonicalize({ v: 1, assignmentId: 'a-' + runId, execution: 'conversation', dependencyArtifacts: [], work: {} }))),
      reservation: { reservationId: 'res-' + runId, attempt: 0 }, capIds: [] }),
    /** uncertain 的开启事实（与 uncertain 状态同一信封），或带结论的关闭事实 */
    resolution: (runId: string, outcome?: 'late-bundle-committed'): Body => {
      const subject = { execution: 'conversation', conversationId, runId, assignmentId: 'a-' + runId, ownerEpoch };
      const openFactDigest = protocolDigest('UncertainOpenFact', 1, { subject, openedAt: NOW, cause: 'ledger-unknown' });
      return { t: 'resolution', runId, fact: { subject, openedAt: NOW, cause: 'ledger-unknown', openFactDigest,
        ...(outcome ? { resolution: { kind: outcome, by: 'user', at: NOW, factDigest: resolutionFactDigest(openFactDigest, outcome, 'user', NOW) } } : {}) } };
    },
    opened: (runId: string): Body => ({ t: 'run-input-opened', runId, assignmentId: 'a-' + runId }),
    closed: (runId: string): Body => ({ t: 'run-input-closed', runId, assignmentId: 'a-' + runId }),
    consumed: (runId: string, keys: string[]): Body => ({ t: 'run-input-consumed', runId, assignmentId: 'a-' + runId, boundary: ++boundary, ingressKeys: keys }),
    committed: async (runId: string): Promise<Body> => { const revision = ++commitRevision;
      return { t: 'committed', runId, assignmentId: 'a-' + runId, bundle: { ref: await bundle(runId, revision) }, commitRevision: revision }; },
    lifecycle: (mutation: 'clear' | 'delete'): Body => ({ t: 'session-lifecycle', mutation, domainRevision: ++domainRevision, requestId: mutation + '-' + domainRevision }),
    /** 提交信封里的 final-outbox 记录（写入时进 final-outbox 流） */
    final: (committed: Body): Body => ({ t: 'final', conversationId, runId: committed.runId, commitRevision: committed.commitRevision, digest: digest(9), state: 'pending' }),
  };
  const startRevision = (runId: string, revision: number) => { revisions.set(runId, revision); };
  const startCommitRevision = (revision: number) => { commitRevision = revision; };
  return { r, startRevision, startCommitRevision };
}

export async function fixture() {
  const root = await createTempDir('outside-history');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, 'log'), artifacts, { clock: () => NOW }));
  const directory = new ConversationReadIndex(log, artifacts, verifier);
  const local: Body[] = [];
  let base: { lsn: number; at: string; stream: string; body: unknown }[] = [];
  const { r } = recordBuilders(ID, artifacts);
  const streamOf = (body: Body) => body.t === 'final' ? 'final-outbox' : 'run:' + ID;
  const append = async (...bodies: Body[]) => { await log.append(bodies.map(body => ({ stream: streamOf(body), body }))); local.push(...bodies); };
  const records = () => local.filter(body => streamOf(body) === 'run:' + ID).map(body => ({ stream: 'run:' + ID, body }));
  /** 新实现：投递事实由同一批本地记录折叠（内存预载的基底另由读取器自己折叠） */
  const next = new ConversationMessageInputReader(log, directory, artifacts, ID, { deliveryFacts: async () => foldDeliveryFacts(ID, records()) });
  const reference = new ReferenceMessageInputReader(log, directory, artifacts, ID);
  /** 每组是基底里的一个信封（uncertain 状态须与其开启事实同信封） */
  const prime = async (envelopes: Body[][]) => {
    base = envelopes.flatMap((bodies, index) => bodies.map(body => ({ lsn: index + 1, at: NOW, stream: 'run:' + ID, body })));
    await directory.installBase(base); next.installBase(base); reference.installBase(base);
  };
  const normalize = (page: Awaited<ReturnType<ConversationMessageInputReader['messageInputsOutsideHistory']>>) => ({
    inputs: page.inputs.map(input => [input.message.inputIdentity?.id, input.runId, input.state, input.consumed, input.disposition]),
    truncated: page.truncated, interruptibleRuns: page.interruptibleRuns,
  });
  const compare = async () => {
    const [actual, expected] = await Promise.all([next.messageInputsOutsideHistory(), reference.messageInputsOutsideHistory()]);
    expect(normalize(actual)).toEqual(normalize(expected));
    return normalize(actual);
  };
  return { log, artifacts, directory, r, append, prime, next, reference, compare };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type Path = 'queued' | 'cancelled' | 'committed' | 'failed' | 'uncertain' | 'resolved' | 'running';

/** 一个运行按给定路径走完；committed / resolved 可带追加输入，部分被消费。
 * 给了 hold 就只把记录收进去、由调用方合成一个信封写入（只用于快速堆积已结束历史） */
export async function run(f: Fixture, runId: string, path: Path, options: { conversation?: boolean; legacy?: boolean; appended?: number; consumeAll?: boolean; hold?: Body[] } = {}) {
  const { r } = f;
  const append = async (...bodies: Body[]) => { if (options.hold) options.hold.push(...bodies); else await f.append(...bodies); };
  return steps();
  async function steps() {
  await append(r.admitted(runId, options.conversation, options.legacy), r.state(runId, 'queued'));
  if (path === 'queued') return;
  if (path === 'cancelled') { await append(r.state(runId, 'cancelled')); return; }
  const a = 'a-' + runId;
  await append(await r.assigned(runId), r.state(runId, 'dispatched', a));
  if (path === 'uncertain' || path === 'resolved') await append(r.resolution(runId), r.state(runId, 'uncertain', a));
  if (path === 'uncertain') return;
  if (path === 'resolved') { const committed = await r.committed(runId); await append(committed, r.resolution(runId, 'late-bundle-committed'), r.state(runId, 'committed', a), r.final(committed)); return; }
  await append(r.state(runId, 'running', a));
  const keys: string[] = [];
  if (options.appended) {
    await append(r.opened(runId));
    for (let i = 0; i < options.appended; i++) { const key = runId + '-append-' + i; keys.push(key); await append(r.appended(runId, key, options.conversation)); }
    const consumed = options.consumeAll ? keys : keys.filter((_, i) => i % 2 === 0);
    if (consumed.length) await append(r.consumed(runId, consumed));
    await append(r.closed(runId));
  }
  if (path === 'running') return;
  if (path === 'failed') { await append(r.state(runId, 'failed', a)); return; }
  const committed = await r.committed(runId);
  await append(committed, r.state(runId, 'committed', a), r.final(committed));
  }
}

export function lcg(seed: number) {
  let state = seed >>> 0;
  return (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
}
