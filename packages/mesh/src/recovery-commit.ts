import type { AnchorTransferCommit, HomeTrustEvent } from "@zhixing/core/contracts";
import { validateDisasterRecoveryCommit } from "@zhixing/core/protocol";
import { verifyRecoverySignature } from "./recovery-root.js";
import { homeTrustEventDigest, type TrustProjection } from "./trust-chain.js";

/** 灾备提交的根签 commit：签名转移在 prepare 时就已生成，只有它证明这次恢复已提交。 */
export type DisasterRecoveryCommitProof = Extract<AnchorTransferCommit, { mode: "disaster-recovery" }>;

/** 根签 commit 必须按转移前投影的恢复根验过，并绑定这条转移、目标设备、issuer 公钥与下一任期。 */
export function assertRecoveryCommit(
  commit: DisasterRecoveryCommitProof,
  transition: HomeTrustEvent,
  before: TrustProjection,
  after: TrustProjection,
): void {
  const root = before.recoveryRootPublicKey;
  if (!root) throw new TypeError("A disaster transition requires a recovery root");
  const verified = validateDisasterRecoveryCommit(commit, {
    verify: (schemaId, version, payload, signature) => verifyRecoverySignature(root, schemaId, version, payload, signature),
  });
  const body = transition.body;
  if (
    body.t !== "issuer-transition" ||
    body.reason !== "disaster-recovery" ||
    verified.trustTransitionDigest !== homeTrustEventDigest(transition) ||
    verified.targetDeviceId !== body.toDeviceId ||
    verified.targetIssuerPublicKey !== after.issuer.issuerPublicKey ||
    verified.nextAnchorEpoch !== after.anchorEpoch ||
    verified.nextTrustEpoch !== body.nextTrustEpoch
  ) {
    throw new TypeError("Recovery commit does not bind this disaster transition");
  }
}
