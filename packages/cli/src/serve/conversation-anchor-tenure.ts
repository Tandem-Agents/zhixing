import type { AuthorityCommitLog } from '@zhixing/core/authority';
import { registerConversationAnchorTenure, type ConversationAnchorTenurePort } from '@zhixing/owner-kernel/conversation-owner-authority';
import { currentTrustIndex, CURRENT_TRUST_PROJECTION_ID, readCurrentAnchorTenure, readAnchorTenureAt } from '@zhixing/mesh/trust-chain';

const port: ConversationAnchorTenurePort = Object.freeze({
  projectionId: CURRENT_TRUST_PROJECTION_ID,
  current: readCurrentAnchorTenure,
  at: readAnchorTenureAt,
});

export function bindConversationAnchorTenure(log: AuthorityCommitLog): void {
  currentTrustIndex(log);
  registerConversationAnchorTenure(log, port);
}
