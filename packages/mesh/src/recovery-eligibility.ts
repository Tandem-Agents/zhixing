import type { CheckpointEnvelope, CheckpointStreamRecord } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "./canonical.js";
import { checkpointEnvelopeArtifact, checkpointPurpose } from "./checkpoint.js";
import { keyIdForPublicKey, verifyRecoverySignature } from "./recovery-root.js";
import { homeTrustEventDigest } from "./trust-chain.js";

type CreatedRecord = Extract<CheckpointStreamRecord, { t: "checkpoint-created" }>;
type VerifiedRecord = Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }>;

const FULL_AUTHORITY_SCOPE = Object.freeze([
  "global-authority",
  "conversation-authority",
  "conversation-content",
  "execution-assets",
] as const);

/** 判定所需的当前信任事实：链头与两把根公钥（信任记录与信任投影都提供）。 */
export interface RecoveryEligibilityTrust {
  readonly chainHead: { readonly seq: number; readonly eventDigest: string };
  readonly recoveryRootPublicKey?: string;
  readonly recoveryBackupPublicKey?: string;
}

/**
 * 一份完整检查点按什么证据算“当前可恢复”：
 * - current-generation：普通备份，created 绑定的代际（根、收件人、链头、目标）与当前全等；
 * - root-activation：建立或轮换恢复根时的激活检查点，链头仍正是它的激活计划产出的那一个。
 */
export type RecoveryEligibilityEvidence = "current-generation" | "root-activation";

/**
 * 当前可恢复资格的唯一判定：status、引导就绪与以“当前可恢复完整检查点”为前提的保护门共用。
 * 共同条件：两根齐全；created / verified / envelope 是同一份检查点的同一绑定（编号、收件人、目标、摘要、用途）；
 * 验证由当前恢复根签署且签名内容与记录一致；envelope 覆盖完整四类范围。然后满足两种证据之一。
 * 读取哪些候选（未被取代的当前已验证记录）由调用方按既有生命周期投影决定，本判定不复活已取代或缺失的候选。
 */
export function currentRecoveryEligibility(input: {
  readonly trust: RecoveryEligibilityTrust;
  readonly verified: VerifiedRecord;
  readonly created: CreatedRecord;
  readonly envelope: CheckpointEnvelope;
  readonly targetId?: string;
}): RecoveryEligibilityEvidence | undefined {
  const { trust, verified, created, envelope } = input;
  if (!trust.recoveryRootPublicKey || !trust.recoveryBackupPublicKey) return undefined;
  const rootKeyId = keyIdForPublicKey(trust.recoveryRootPublicKey);
  const recipientKeyId = keyIdForPublicKey(trust.recoveryBackupPublicKey);
  if (
    !created.targetId ||
    (input.targetId !== undefined && created.targetId !== input.targetId) ||
    verified.targetId !== created.targetId ||
    verified.checkpointId !== created.checkpointId ||
    verified.recipientKeyId !== recipientKeyId ||
    created.recipientKeyId !== recipientKeyId ||
    envelope.recipientKeyId !== recipientKeyId ||
    verified.envelopeDigest !== created.envelopeDigest ||
    envelope.checkpointId !== created.checkpointId ||
    envelope.digest !== created.envelopeDigest ||
    canonicalize(checkpointEnvelopeArtifact(envelope)) !== canonicalize(created.envelopeRef) ||
    canonicalize(verified.purpose) !== canonicalize(created.purpose) ||
    canonicalize(checkpointPurpose(envelope)) !== canonicalize(created.purpose) ||
    canonicalize(envelope.manifest.scope) !== canonicalize(FULL_AUTHORITY_SCOPE) ||
    !isValidCurrentRootVerification(verified, trust.recoveryRootPublicKey)
  ) return undefined;

  if (created.generation !== undefined) {
    return created.source && created.request && canonicalize(created.generation) === canonicalize({
      rootKeyId,
      recipientKeyId,
      trustChainHead: trust.chainHead,
      targetId: created.targetId,
    })
      ? "current-generation"
      : undefined;
  }
  const purpose = envelope.manifest.purpose;
  if (purpose.kind !== "root-activation" || created.purpose.kind !== "root-activation") return undefined;
  const plan = purpose.plan;
  // 激活计划的最后一个事件是根事件：当前链头正是它，且它建立的正是当前两把根公钥
  const root = plan.rootEvent;
  if (
    root.body.t !== "recovery-root" ||
    root.body.rootPublicKey !== trust.recoveryRootPublicKey ||
    root.body.backupPublicKey !== trust.recoveryBackupPublicKey ||
    root.seq !== trust.chainHead.seq ||
    homeTrustEventDigest(root) !== trust.chainHead.eventDigest ||
    protocolDigest("RecoveryActivationPlan", 1, plan) !== created.purpose.activationDigest
  ) return undefined;
  // 域重置加建根：重置事件必须正是根事件的前一个，计划里没有别的事件
  if (plan.kind === "domain-reset-establish" && homeTrustEventDigest(plan.resetEvent) !== root.prevEventDigest) {
    return undefined;
  }
  return "root-activation";
}

/** 验证记录由当前恢复根签署，且签名覆盖的内容与记录本身一致。 */
export function isValidCurrentRootVerification(record: VerifiedRecord, recoveryRootPublicKey: string): boolean {
  const { signature, ...unsigned } = record.verification;
  if (
    unsigned.v !== 1 ||
    record.checkpointId !== unsigned.checkpointId ||
    record.recipientKeyId !== unsigned.recipientKeyId ||
    record.targetId !== unsigned.targetId ||
    record.envelopeDigest !== unsigned.envelopeDigest ||
    canonicalize(record.purpose) !== canonicalize(unsigned.purpose)
  ) {
    return false;
  }
  try {
    verifyRecoverySignature(recoveryRootPublicKey, "RecoveryCheckpointVerification", 1, unsigned, signature);
    return true;
  } catch {
    return false;
  }
}
