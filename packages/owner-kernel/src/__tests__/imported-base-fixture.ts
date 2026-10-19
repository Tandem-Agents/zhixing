import {
  type ArtifactStore,
  type AuthorityCommitLog,
} from "@zhixing/core/authority";
import type { ArtifactRef, TransferRecord } from "@zhixing/core/contracts";
import { type ProtocolSignatureVerifier, type ProtocolSigner } from "@zhixing/core/protocol";
import { DeviceKey, enrollDeviceIdentity } from "../../../mesh/src/device-identity.js";
import { applyTrustEvent, buildHomeTrustRecord, createSignedTrustEvent, createTrustGenesisEvent, initializeTrustChain } from "../../../mesh/src/trust-chain.js";
import { bindConversationAnchorTenure } from "../../../cli/src/serve/conversation-anchor-tenure.js";
import type { ConversationRunJournal } from '../conversation-assignment.js';
import {
  ConversationTransferSource,
  ConversationTransferTarget,
  type ConversationTransferPublication,
  type ConversationTransferStaging,
  type ConversationTransferStagingArea,
} from "../conversation-transfer.js";
import { ConversationBaseSource } from "../conversation-base-source.js";
import { registerConversationBaseSource } from "../conversation-base-registry.js";
import { vi } from "vitest";

const TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = "2026-08-02T00:00:00.000Z";


export function stagingArea(): ConversationTransferStagingArea {
  const sessions = new Map<string, ConversationTransferStaging>();
  return {
    forTransfer: (transferId) => {
      const existing = sessions.get(transferId);
      if (existing) return existing;
      const artifacts = new Map<string, Uint8Array>();
      const partials = new Map<string, Uint8Array>();
      const key = (ref: ArtifactRef) => `${ref.digest}:${ref.bytes}`;
      const projection = Object.freeze({
        artifacts: Object.freeze({
          get: async (ref: ArtifactRef) => {
            const value = artifacts.get(key(ref));
            if (!value) throw new Error("Artifact does not exist");
            return value.slice();
          },
          readRange: async (ref: ArtifactRef, offset: number, limit: number) => {
            const value = artifacts.get(key(ref));
            if (!value) throw new Error("Artifact does not exist");
            return value.slice(offset, offset + limit);
          },
          has: async (ref: ArtifactRef) => artifacts.has(key(ref)),
        }),
        receiver: Object.freeze({
          progress: async (ref: ArtifactRef) => ({
            receivedBytes: artifacts.has(key(ref)) ? ref.bytes : partials.get(key(ref))?.byteLength ?? 0,
            complete: artifacts.has(key(ref)),
          }),
          append: async (ref: ArtifactRef, offset: number, bytes: Uint8Array) => {
            const k = key(ref);
            if (artifacts.has(k)) return { receivedBytes: ref.bytes, complete: true };
            const prefix = partials.get(k) ?? new Uint8Array();
            if (offset !== prefix.byteLength) throw new RangeError("Artifact chunk does not continue the durable prefix");
            const next = Buffer.concat([prefix, bytes]);
            if (next.byteLength > ref.bytes) throw new RangeError("Artifact chunk exceeds declared length");
            if (next.byteLength === ref.bytes) {
              artifacts.set(k, next);
              partials.delete(k);
              return { receivedBytes: ref.bytes, complete: true };
            }
            partials.set(k, next);
            return { receivedBytes: next.byteLength, complete: false };
          },
        }),
        cleanup: async () => {
          const count = artifacts.size;
          sessions.delete(transferId);
          return count;
        },
      }) satisfies ConversationTransferStaging;
      sessions.set(transferId, projection);
      return projection;
    },
  };
}

/** Install a genuine verified anchor tenure on a fresh owner log. The
 * conversation records in this fixture use the lightweight test signer; the
 * home trust chain is a real DeviceKey chain, matching the production tenure
 * projection. Returns the device identities the transfer manifest must use. */
export async function installVerifiedAnchorTenure(log: AuthorityCommitLog, now: string) {
  const anchorKey = await DeviceKey.generate();
  const memberKey = await DeviceKey.generate();
  const anchor = enrollDeviceIdentity(anchorKey, { displayName: 'tenure-anchor', platform: 'linux', enrolledAt: now });
  const member = enrollDeviceIdentity(memberKey, { displayName: 'tenure-member', platform: 'linux', enrolledAt: now });
  bindConversationAnchorTenure(log);
  if ((await log.checkpoint()).lsn === 0) {
    const genesis = createTrustGenesisEvent({ homeId: 'session-adapter-home', issuer: anchor, signer: anchorKey, at: now });
    const initial = initializeTrustChain(genesis);
    const enroll = createSignedTrustEvent({ current: initial, signer: anchorKey, at: now,
      body: { t: 'enroll', device: member, roles: ['executor'] } });
    const trust = applyTrustEvent(initial, enroll);
    await log.append([
      { stream: 'trust', body: { t: 'home-trust-event', event: genesis } },
      { stream: 'trust', body: { t: 'home-trust-event', event: enroll } },
      { stream: 'trust', body: { t: 'home-trust-record', record: buildHomeTrustRecord(trust, anchorKey) } },
    ]);
  }
  return { anchorDeviceId: anchorKey.deviceId, memberDeviceId: memberKey.deviceId };
}

/** Freeze the source authority and run it through the production target
 * import/commit path, returning the authenticated base publication. */
export async function importAuthenticatedBase(input: {
  readonly sourceLog: AuthorityCommitLog;
  readonly sourceArtifacts: ArtifactStore;
  readonly targetLog: AuthorityCommitLog;
  readonly targetArtifacts: ArtifactStore;
  readonly conversationId: string;
  readonly sourceOwnerEpoch: number;
  readonly verifier: ProtocolSignatureVerifier;
  readonly signer: ProtocolSigner;
  readonly targetSigner?: ProtocolSigner;
  readonly sourceDeviceId?: string;
  readonly targetDeviceId?: string;
  readonly clock?: () => string;
  readonly sourceJournal: ConversationRunJournal;
  /** Serialize the original commit using the historical v1 format, before it is written. */
  readonly legacyOwnerBasis?: boolean;
}): Promise<ConversationTransferPublication> {
  const journal = input.sourceJournal;
  const sourceDeviceId = input.sourceDeviceId ?? 'device-source', targetDeviceId = input.targetDeviceId ?? 'device-target';
  const source = new ConversationTransferSource({
    deviceId: sourceDeviceId,
    log: input.sourceLog,
    artifacts: input.sourceArtifacts,
    signer: input.signer,
    verifier: input.verifier,
    acceptsConversationId: (conversationId) => conversationId === input.conversationId,
    isCurrentAnchor: (deviceId) => deviceId === targetDeviceId,
    conversationState: async () => {
      const state = await journal.authorityState();
      return { exists: state.hasDurableIdentity, deleted: state.deleted, ownerEpoch: input.sourceOwnerEpoch };
    },
    settleConversation: async () => {
      await journal.resumeLifecycleProjections(async () => {});
      await journal.resumeCommittedProjections();
      await journal.publishPendingFinals(async () => {});
    },
    snapshotSessionState: async () => ({
      reducerVersion: "session-state-v1",
      value: JSON.parse(JSON.stringify({ meta: await journal.sessionMeta(), taskList: await journal.taskList(),
        transcript: (await journal.transcriptTail()).records, advancement: (await journal.advancementSessions()).at(-1) ?? null })),
    }),
    clock: input.clock ?? (() => NOW),
  });
  const prepared = {
    requestId: "request-1",
    transferId: TRANSFER_ID,
    targetDeviceId,
    conversationId: input.conversationId,
    sourceOwnerEpoch: input.sourceOwnerEpoch,
  };
  await source.prepare(prepared);
  const frozen = await source.freeze(TRANSFER_ID);
  const target = new ConversationTransferTarget({
    deviceId: targetDeviceId,
    log: input.targetLog,
    artifacts: input.targetArtifacts,
    staging: stagingArea(),
    signer: input.targetSigner ?? input.signer,
    verifier: input.verifier,
    isActiveSource: (deviceId) => deviceId === sourceDeviceId,
    acceptsSourceConversationId: (deviceId, conversationId) =>
      deviceId === sourceDeviceId && conversationId === input.conversationId,
    conversationExists: () => false,
    sourceOwnerEpoch: () => input.sourceOwnerEpoch,
    reducerVersion: "session-state-v1",
  });
  const preparedRecord: Extract<TransferRecord, { t: "prepared" }> = {
    v: 1,
    t: "prepared",
    requestId: "request-1",
    transferId: TRANSFER_ID,
    sourceDeviceId,
    targetDeviceId,
    conversationId: input.conversationId,
    sourceOwnerEpoch: input.sourceOwnerEpoch,
    nextOwnerEpoch: input.sourceOwnerEpoch + 1,
  };
  await target.prepare(preparedRecord);
  const imported = await target.import({
    transferId: TRANSFER_ID,
    manifestRef: frozen.manifestRef,
    proof: frozen.proof,
    source: source.readPort,
  });
  const base = await ConversationBaseSource.open({
    log: input.targetLog,
    artifacts: input.targetArtifacts,
    verifier: input.verifier,
    state: imported.state,
    ownerCheckpoint: await input.targetLog.checkpoint(),
  });
  if (!base.ready) await base.prepare();
  registerConversationBaseSource(input.targetArtifacts, base);
  const originalTransaction = input.targetLog.transactProjection.bind(input.targetLog);
  const legacyWriter = input.legacyOwnerBasis ? vi.spyOn(input.targetLog, 'transactProjection').mockImplementation(async (...args: any[]) => {
    const decide = args[2];
    args[2] = async (...values: any[]) => {
      const decision = await decide(...values);
      if (decision.kind !== 'append') return decision;
      return { ...decision, entries: decision.entries.map((entry: any) => {
        if (entry.body.t !== 'conversation-transfer-committed-base') return entry;
        const { ownerBasis: _basis, ...body } = entry.body;
        return { ...entry, body: { ...body, v: 1 } };
      }) };
    };
    return (originalTransaction as any)(...args);
  }) : undefined;
  let committed;
  try { committed = await target.commit(TRANSFER_ID); } finally { legacyWriter?.mockRestore(); }
  await source.acceptCommit({ manifest: frozen.manifest, commit: committed.commit });
  return target.committedBaseSource(TRANSFER_ID);
}
