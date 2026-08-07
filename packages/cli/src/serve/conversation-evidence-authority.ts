import { isLocalConversationId } from "@zhixing/core";
import type { EvidenceRequest } from "@zhixing/core/contracts";
import { resolveCurrentConversationAuthority } from "@zhixing/owner-kernel";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";

export function createConversationEvidenceAuthorityVerifier(options: {
  readonly authority: AuthorityRuntimeStack;
  readonly currentAnchorDeviceId: () => string;
}): (request: EvidenceRequest) => Promise<void> {
  return async (request) => {
    const fallback = isLocalConversationId(request.conversationId)
      ? {
          deviceId: options.authority.deviceId,
          ownerEpoch: options.authority.localOwnerEpoch,
        }
      : {
          deviceId: options.currentAnchorDeviceId(),
          ownerEpoch: options.authority.anchorEpoch,
        };
    const current = await resolveCurrentConversationAuthority(
      options.authority.executorLog,
      options.authority.verifier,
      request.conversationId,
      fallback,
    );
    if (
      current.state !== "current" ||
      current.deviceId !== request.signature.keyId ||
      current.ownerEpoch !== request.ownerEpoch
    ) {
      throw new TypeError("Evidence request does not belong to the current conversation authority");
    }
  };
}
