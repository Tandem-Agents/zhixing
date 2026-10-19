import type { EvidenceRequest } from "@zhixing/core/contracts";
import { validateEvidenceRequest, verifyProtocolStep } from "@zhixing/core/protocol";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";

export function createConversationEvidenceAuthorityVerifier(options: {
  readonly authority: AuthorityRuntimeStack;
}): (request: EvidenceRequest) => Promise<void> {
  return async request => {
    const verified = await verifyProtocolStep(() => validateEvidenceRequest(request, options.authority.verifier));
    await options.authority.conversationAuthority.verify({ conversationId: verified.conversationId, ownerEpoch: verified.ownerEpoch,
      anchorEpoch: verified.anchorEpoch, signerDeviceId: verified.signature.keyId });
  };
}
