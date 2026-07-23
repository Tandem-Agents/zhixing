import type { OwnerControlAuthorizer } from "@zhixing/executor";
import {
  assertAuthorizedOwnerControlGrant,
  ownerControlRequestDigest,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";

/** Single authorization predicate shared by every local executor composition. */
export function createOwnerControlAuthorizer(
  verifier: ProtocolSignatureVerifier,
  clock: () => string,
): OwnerControlAuthorizer {
  return {
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
