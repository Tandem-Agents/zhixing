import path from 'node:path';
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog } from '@zhixing/core/authority';
import type { ArtifactRef, SessionControlMutation } from '@zhixing/core/contracts';
import { type ProtocolSigner, type ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { DeviceKey, enrollDeviceIdentity, verifyDeviceSignature } from '../../../mesh/src/device-identity.js';
import { applyTrustEvent, buildHomeTrustRecord, createSignedTrustEvent, createTrustGenesisEvent, initializeTrustChain } from '../../../mesh/src/trust-chain.js';
import { bindConversationAnchorTenure } from '../../../cli/src/serve/conversation-anchor-tenure.js';
import { localConversationId } from '@zhixing/core/conversation';
import { createTempDir } from '@zhixing/test-utils';
import { onTestFinished } from 'vitest';
import { ConversationRunJournal } from '../conversation-assignment.js';
import { ControlAdmissionJournal, createConversationControlEnvelope } from '../control-admission.js';
import { ConversationTransferSource, ConversationTransferTarget, type ConversationTransferStagingArea } from '../conversation-transfer.js';

export const BASE_NOW = '2026-10-18T01:00:00.000Z';
const sourceKey = await DeviceKey.generate(), targetKey = await DeviceKey.generate();
const devices = { source: sourceKey, target: targetKey };
const identities = [sourceKey, targetKey].map(key => enrollDeviceIdentity(key, { displayName: 'base-fixture', platform: 'linux', enrolledAt: BASE_NOW }));
export const BASE_CONVERSATION = localConversationId(sourceKey.deviceId, '01K1ZZZZZZ0000000000000000');
export const BASE_TRANSFER = 'xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const baseSigner = (name: 'source' | 'target'): ProtocolSigner => devices[name];
export const baseVerifier: ProtocolSignatureVerifier = { verify(schema, version, payload, signature) {
  const identity = identities.find(identity => identity.deviceId === signature.keyId);
  if (!identity) throw new TypeError('Unknown fixture signing identity');
  verifyDeviceSignature(identity, schema, version, payload, signature);
} };

function staging(): ConversationTransferStagingArea {
  const stores = new Map<string, ReturnType<ConversationTransferStagingArea['forTransfer']>>();
  return { forTransfer(id) {
    const prior = stores.get(id); if (prior) return prior;
    const complete = new Map<string, Uint8Array>(), partial = new Map<string, Uint8Array>();
    const key = (ref: ArtifactRef) => ref.digest + ':' + ref.bytes;
    const result = {
      artifacts: {
        get: async (ref: ArtifactRef) => { const value = complete.get(key(ref)); if (!value) throw Error('Missing staged artifact'); return value.slice(); },
        readRange: async (ref: ArtifactRef, offset: number, limit: number) => { const value = complete.get(key(ref)); if (!value) throw Error('Missing staged artifact'); return value.slice(offset, offset + limit); },
        has: async (ref: ArtifactRef) => complete.has(key(ref)),
      },
      receiver: {
        progress: async (ref: ArtifactRef) => ({ receivedBytes: complete.has(key(ref)) ? ref.bytes : partial.get(key(ref))?.byteLength ?? 0, complete: complete.has(key(ref)) }),
        append: async (ref: ArtifactRef, offset: number, bytes: Uint8Array) => {
          const name = key(ref); if (complete.has(name)) return { receivedBytes: ref.bytes, complete: true };
          const before = partial.get(name) ?? new Uint8Array(); if (offset !== before.byteLength) throw Error('Wrong staging offset');
          const next = Buffer.concat([before, bytes]); if (next.byteLength > ref.bytes) throw Error('Staging overflow');
          if (next.byteLength === ref.bytes) { complete.set(name, next); partial.delete(name); } else partial.set(name, next);
          return { receivedBytes: next.byteLength, complete: next.byteLength === ref.bytes };
        },
      },
      cleanup: async () => { const count = complete.size; stores.delete(id); return count; },
    };
    stores.set(id, result); return result;
  } };
}

export async function createConversationBaseHarness(options: { root?: string } = {}) {
  const root = options.root ?? await createTempDir('conversation-base-contract');
  const make = (name: 'source' | 'target') => {
    const artifacts = new FileArtifactStore(path.join(root, name, 'artifacts'));
    const log = new FileAuthorityCommitLog(path.join(root, name, 'authority'), artifacts,
      { clock: () => BASE_NOW, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, name === 'source' ? 41 : 42)) });
    if (name === 'target') bindConversationAnchorTenure(log);
    onTestFinished(() => log.stopStorageMaintenance());
    return { artifacts, log };
  };
  const source = make('source'), target = make('target');
  if ((await target.log.checkpoint()).lsn === 0) {
    const genesis = createTrustGenesisEvent({ homeId: 'base-fixture-home', issuer: identities[1]!, signer: targetKey, at: BASE_NOW });
    const initial = initializeTrustChain(genesis);
    const enroll = createSignedTrustEvent({ current: initial, signer: targetKey, at: BASE_NOW,
      body: { t: 'enroll', device: identities[0]!, roles: ['executor'] } });
    const trust = applyTrustEvent(initial, enroll);
    await target.log.append([
      { stream: 'trust', body: { t: 'home-trust-event', event: genesis } },
      { stream: 'trust', body: { t: 'home-trust-event', event: enroll } },
      { stream: 'trust', body: { t: 'home-trust-record', record: buildHomeTrustRecord(trust, targetKey) } },
    ]);
  }
  const journal = (name: 'source' | 'target', data = name === 'source' ? source : target, conversationId = BASE_CONVERSATION) => new ConversationRunJournal({
    conversationId, ownerEpoch: name === 'source' ? 1 : 2,
    ...data, signer: baseSigner(name), verifier: baseVerifier, clock: () => BASE_NOW,
    currentAuthority: { deviceId: devices[name].deviceId, executorId: devices[name].deviceId },
    submission: { authenticate() {}, authorize() {} },
    authority: { decideAtPrefix: () => ({ committed: false, error: { code: 'capability-gap', message: 'Fixture has no executor', retryable: false } }) },
    projection: { async project() {} },
  });
  const sourceJournal = journal('source'), targetJournal = journal('target');
  const admit = async (owner: ConversationRunJournal, id: string, position: number) => {
    await owner.admit({ runId: id, ingressKey: id, queuedPosition: position,
      userInput: { parts: [{ type: 'text', text: id }] }, invocation: { kind: 'agent', source: 'interactive' },
      ingress: { kind: 'first-party', surfacePrincipal: 'rpc:fixture', deviceId: sourceKey.deviceId, ingressId: id, receivedAt: BASE_NOW,
        turnOrigin: { channel: 'rpc', messageIdentity: { id: 'message-' + id, source: { kind: 'conversation', conversationId: 'fixture-parent' } } } } });
  };
  const input = async (owner: ConversationRunJournal, id: string, position: number) => {
    await admit(owner, id, position);
    await owner.cancelRun({ runId: id, requestId: 'cancel-' + id });
  };
  const mutate = async (owner: ConversationRunJournal, data: typeof source, requestId: string, mutation: SessionControlMutation) => {
    const ownerEpoch = owner === sourceJournal ? 1 : 2;
    const actor = { principal: { surfacePrincipal: 'rpc:fixture', deviceId: devices[ownerEpoch === 1 ? 'source' : 'target'].deviceId, connectionId: 'fixture' } };
    const current = await owner.authorityState();
    return owner.applyControl({ admission: new ControlAdmissionJournal(data.log, data.artifacts), source: actor,
      envelope: createConversationControlEnvelope({ requestId, source: actor, at: BASE_NOW,
        body: { t: 'session-write', conversationId: BASE_CONVERSATION, ownerEpoch, domainRevision: current.domainRevision, mutation } }) });
  };
  const exporter = new ConversationTransferSource({ deviceId: sourceKey.deviceId, log: source.log, artifacts: source.artifacts,
    signer: baseSigner('source'), verifier: baseVerifier, clock: () => BASE_NOW,
    acceptsConversationId: id => id === BASE_CONVERSATION, isCurrentAnchor: id => id === targetKey.deviceId,
    conversationState: async () => { const state = await sourceJournal.authorityState(); return { exists: state.hasDurableIdentity, deleted: state.deleted, ownerEpoch: 1 }; },
    settleConversation: async () => {
      await sourceJournal.resumeLifecycleProjections(async () => {});
    },
    snapshotSessionState: async () => ({ reducerVersion: 'conversation-session-state-v1', value: JSON.parse(JSON.stringify({
      meta: await sourceJournal.sessionMeta(), taskList: await sourceJournal.taskList(), transcript: (await sourceJournal.transcriptTail()).records,
      advancement: (await sourceJournal.advancementSessions()).at(-1) ?? null,
    })) }),
  });
  const makeImporter = (data = target, owner = targetJournal, publication = true) => new ConversationTransferTarget({ deviceId: targetKey.deviceId, log: data.log, artifacts: data.artifacts, staging: staging(),
    signer: baseSigner('target'), verifier: baseVerifier, isActiveSource: id => id === sourceKey.deviceId, acceptsSourceConversationId: (device, id) => device === sourceKey.deviceId && id === BASE_CONVERSATION,
    conversationExists: () => false, sourceOwnerEpoch: () => 1, reducerVersion: 'conversation-session-state-v1',
    ...(publication ? { preparePublication: async (publication: import('../conversation-transfer.js').ConversationTransferPublication) => { await owner.installImportedBase(publication.source); return { publish() {} }; } } : {}),
  });
  const importer = makeImporter();
  const restartTarget = async () => {
    await target.log.stopStorageMaintenance();
    const data = make('target'), owner = journal('target', data), transfer = makeImporter(data, owner);
    const publication = await transfer.committedBaseSource(BASE_TRANSFER);
    await owner.installImportedBase(publication.source);
    return { ...data, owner, transfer, publication };
  };
  const prepareTransfer = async (targetImporter = importer) => {
    const request = { requestId: 'transfer-request', transferId: BASE_TRANSFER, sourceDeviceId: sourceKey.deviceId, targetDeviceId: targetKey.deviceId, conversationId: BASE_CONVERSATION, sourceOwnerEpoch: 1, nextOwnerEpoch: 2 };
    await exporter.prepare(request); const frozen = await exporter.freeze(BASE_TRANSFER);
    await targetImporter.prepare({ v: 1, t: 'prepared', ...request });
    return frozen;
  };
  const transfer = async () => {
    const frozen = await prepareTransfer();
    await importer.import({ transferId: BASE_TRANSFER, manifestRef: frozen.manifestRef, proof: frozen.proof, source: exporter.readPort });
    const committed = await importer.commit(BASE_TRANSFER);
    await exporter.acceptCommit({ manifest: frozen.manifest, commit: committed.commit });
    return { frozen, committed, publication: await importer.committedBaseSource(BASE_TRANSFER) };
  };
  /** Cold storage reopen over the same root; the caller may install the
   * existing Authority work observation before any read happens. */
  const reopen = (name: 'source' | 'target', records?: import('@zhixing/core/authority').LogRecordPort) => {
    const artifacts = new FileArtifactStore(path.join(root, name, 'artifacts'));
    const log = new FileAuthorityCommitLog(path.join(root, name, 'authority'), artifacts,
      { clock: () => BASE_NOW, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, name === 'source' ? 41 : 42)), ...(records ? { records } : {}) });
    if (name === 'target') bindConversationAnchorTenure(log);
    onTestFinished(() => log.stopStorageMaintenance());
    return { artifacts, log };
  };
  return { root, reopen, source, target, sourceJournal, targetJournal, journal, admit, input, mutate, exporter, importer, transfer, restartTarget, makeImporter, prepareTransfer };
}
