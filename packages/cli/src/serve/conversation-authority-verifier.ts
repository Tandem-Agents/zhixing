import type { AuthorityCommitLog, ProjectionTransactionContext } from '@zhixing/core/authority';
import { assertLocalConversationIdForDevice } from '@zhixing/core/conversation';
import { assertCurrentAnchorTenure } from '@zhixing/core/protocol';
import { CONVERSATION_TRANSFER_PROJECTION_ID, localConversationAuthorityAt } from '@zhixing/owner-kernel/conversation-transfer';
import { CONVERSATION_IDENTITY_PROJECTION_ID, conversationIdentityExistsAt } from '@zhixing/owner-kernel/control-admission';
import { MeshProtocolError } from '@zhixing/mesh/errors';
import type { HomeAuthoritySources } from './home-authority-sources.js';

export interface ConversationAuthorityClaim {
  readonly conversationId: string; readonly ownerEpoch: number; readonly signerDeviceId: string;
  readonly anchorEpoch?: number;
}
export interface ConversationAuthorityVerifier {
  readonly readProjectionIds: readonly string[];
  prepare(claim: ConversationAuthorityClaim): Promise<(prefix?: ProjectionTransactionContext) => Promise<void>>;
  verify(claim: ConversationAuthorityClaim): Promise<void>;
  installTrustCatchUp(catchUp: (peerDeviceId: string) => Promise<void>): () => void;
}

/** One currentness predicate for evidence and executor control. Network and
 * trust preparation precede the executor transaction; local ownership is
 * rechecked against the transaction's exact native prefix. */
export function createConversationAuthorityVerifier(options: {
  readonly sources: HomeAuthoritySources;
  readonly deviceId: string;
  readonly localOwnerEpoch: number;
  readonly executorLog?: AuthorityCommitLog;
  readonly standaloneAnchorEpoch: () => number | undefined;
}): ConversationAuthorityVerifier {
  let catchUp: ((peerDeviceId: string) => Promise<void>) | undefined;
  const readProjectionIds = [CONVERSATION_TRANSFER_PROJECTION_ID, CONVERSATION_IDENTITY_PROJECTION_ID];
  const localStatus = async (claim: ConversationAuthorityClaim, prefix?: ProjectionTransactionContext) => {
    if (!options.executorLog) return { current: false, exists: false };
    const read = async (context: ProjectionTransactionContext) => ({
      current: await localConversationAuthorityAt(context.readProjection(CONVERSATION_TRANSFER_PROJECTION_ID), claim.conversationId, options.deviceId, options.localOwnerEpoch),
      exists: await conversationIdentityExistsAt(context.readProjection(CONVERSATION_IDENTITY_PROJECTION_ID), claim.conversationId),
    });
    return prefix ? read(prefix) : (await options.executorLog.transactDurableProjection<never, { current: boolean; exists: boolean }>(CONVERSATION_TRANSFER_PROJECTION_ID,
      async (_view, context) => ({ kind: 'return', value: await read(context) }), { readProjectionIds })).value;
  };
  const prepare: ConversationAuthorityVerifier['prepare'] = async claim => {
    let ownNamespace = false;
    try { assertLocalConversationIdForDevice(claim.conversationId, options.deviceId); ownNamespace = true; } catch { /* Other namespaces require anchor authority. */ }
    const local = ownNamespace ? await localStatus(claim) : undefined;
    if (local?.current) {
      if (!local.exists || claim.signerDeviceId !== options.deviceId || claim.ownerEpoch !== options.localOwnerEpoch || claim.anchorEpoch !== undefined) throw new TypeError('Request does not belong to this local conversation authority');
      return async prefix => { const current = await localStatus(claim, prefix); if (!current.current || !current.exists) throw new TypeError('Local conversation authority changed before execution'); };
    }
    if (claim.anchorEpoch === undefined) throw new TypeError('Fresh anchor authorization requires a signed tenure');
    let current = await options.sources.currentAnchorAuthorization(options.deviceId);
    if (!current.tenure) {
      const epoch = options.standaloneAnchorEpoch();
      if (epoch === undefined || claim.signerDeviceId !== options.deviceId || claim.anchorEpoch !== epoch || claim.ownerEpoch !== epoch) throw new TypeError('Request has no proven current anchor authority');
      return async () => {
        if (options.sources.knownAnchorTenure() || options.standaloneAnchorEpoch() !== epoch) throw new MeshProtocolError('service-unavailable', 'Authority changed before executor admission');
      };
    }
    if (claim.anchorEpoch > current.tenure.anchorEpoch) {
      if (!catchUp) throw new MeshProtocolError('service-unavailable', 'Current anchor tenure requires authenticated trust catch-up');
      await catchUp(claim.signerDeviceId);
      current = await options.sources.currentAnchorAuthorization(options.deviceId);
      if (!current.tenure || claim.anchorEpoch > current.tenure.anchorEpoch) throw new MeshProtocolError('service-unavailable', 'Requested anchor tenure is not yet proven');
    }
    if (!current.tenure || current.member?.state !== 'active' || !current.member.roles.some(role => role === 'executor' || role === 'anchor')) throw new MeshProtocolError('unauthorized-peer', 'This device is not active in the verified trust domain');
    assertCurrentAnchorTenure(claim, current.tenure);
    const verified = current.tenure;
    return async () => {
      const known = options.sources.knownAnchorTenure();
      if (!known || known.homeId !== verified.homeId || known.chainHead.eventDigest !== verified.chainHead.eventDigest) throw new MeshProtocolError('service-unavailable', 'Trust changed before executor admission');
      assertCurrentAnchorTenure(claim, known);
    };
  };
  return { readProjectionIds, prepare, verify: async claim => (await prepare(claim))(),
    installTrustCatchUp: value => { catchUp = value; return () => { if (catchUp === value) catchUp = undefined; }; } };
}
