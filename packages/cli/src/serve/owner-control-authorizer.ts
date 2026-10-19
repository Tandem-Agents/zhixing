import type { OwnerControlAuthorizer } from "@zhixing/executor";
import {
  assertAuthorizedOwnerControlGrant,
  ownerControlRequestDigest,
  type ProtocolSignatureVerifier,
  validateOwnerControlGrant, validateControlLease, verifyProtocolStep, canonicalize,
} from "@zhixing/core/protocol";
import type { ConversationAuthorityVerifier } from './conversation-authority-verifier.js';
import { MeshProtocolError } from '@zhixing/mesh/errors';

/** Single authorization predicate shared by every local executor composition. */
export function createOwnerControlAuthorizer(
  verifier: ProtocolSignatureVerifier,
  clock: () => string,
  currentAuthority: Pick<ConversationAuthorityVerifier, 'readProjectionIds' | 'prepare'>,
): OwnerControlAuthorizer {
  return {
    readProjectionIds: currentAuthority.readProjectionIds,
    async prepareExecution(control) {
      if (control.authority.execution !== 'conversation') return undefined;
      const lease = await verifyProtocolStep(() => validateControlLease(control.lease, verifier));
      if (lease.signature.keyId !== control.ownerDeviceId || canonicalize(lease.authority) !== canonicalize(control.authority)) throw new TypeError('Execution control lease does not bind its accepted authority');
      try {
        return await currentAuthority.prepare({ conversationId: control.authority.conversationId, ownerEpoch: control.authority.ownerEpoch,
          signerDeviceId: control.ownerDeviceId, anchorEpoch: lease.anchorEpoch });
      } catch (error) {
        if (lease.v === 1 && error instanceof TypeError && error.message === 'Fresh anchor authorization requires a signed tenure') {
          throw new MeshProtocolError('service-unavailable', 'Accepted legacy assignment requires a current owner control renewal');
        }
        throw error;
      }
    },
    async prepare(context, request, caller) {
      if (context.principal.kind !== 'owner-control') throw new TypeError('Executor control requires an owner grant');
      const grant = await verifyProtocolStep(() => validateOwnerControlGrant(context.principal.kind === 'owner-control' ? context.principal.grant : undefined, verifier));
      if (grant.callerDeviceId !== caller) throw new TypeError('Owner control signer does not match the authenticated caller');
      if (grant.scope.execution !== 'conversation') return undefined;
      const identity = canonicalize(grant);
      const check = await currentAuthority.prepare({ conversationId: grant.scope.conversationId, ownerEpoch: grant.scope.ownerEpoch,
        anchorEpoch: grant.anchorEpoch, signerDeviceId: grant.signature.keyId });
      return async prefix => {
        if (context.principal.kind !== 'owner-control' || canonicalize(context.principal.grant) !== identity) throw new TypeError('Owner grant changed during authority preparation');
        if (request.method === 'executor.dispatch' && request.anchorEpoch !== grant.anchorEpoch) throw new TypeError('Owner control tenure does not bind the dispatch');
        await check(prefix);
      };
    },
    authorize(context, request, authenticatedCallerDeviceId) {
      if (context.principal.kind !== "owner-control") {
        throw new Error("Executor control requires an owner grant");
      }
      const authority = request.authority ?? context.principal.grant.scope;
      const requestDigest = ownerControlRequestDigest({
        method: request.method,
        assignmentId: request.assignmentId,
        authority,
        requestId: request.requestId,
        body: request.body,
      });
      const grant = assertAuthorizedOwnerControlGrant({
        grant: context.principal.grant,
        verifier,
        method: request.method,
        assignmentId: request.assignmentId,
        callerDeviceId: authenticatedCallerDeviceId,
        authenticatedCallerDeviceId,
        ...(request.expectedOwnerDeviceId === undefined
          ? {}
          : { expectedOwnerDeviceId: request.expectedOwnerDeviceId }),
        requestId: request.requestId,
        requestDigest,
        now: clock(),
        deadlineAt: context.deadlineAt,
        authority,
      });
      return {
        authority: structuredClone(grant.scope),
        ownerDeviceId: grant.callerDeviceId,
        controlLease: structuredClone(grant.controlLease),
      };
    },
  };
}
