import { randomBytes } from "node:crypto";
import type { CheckpointEnvelope, CheckpointStreamRecord, RecoveryActivationPlan } from "@zhixing/core/contracts";
import { describe, expect, it } from "vitest";
import { checkpointEnvelopeArtifact, checkpointPurpose, createRecoveryCheckpointVerification } from "../checkpoint.js";
import { currentRecoveryEligibility } from "../recovery-eligibility.js";
import { keyIdForPublicKey, RecoveryRoot } from "../recovery-root.js";
import { homeTrustEventDigest } from "../trust-chain.js";

type Created = Extract<CheckpointStreamRecord, { t: "checkpoint-created" }>;
type Verified = Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }>;

const FULL = ["global-authority", "conversation-authority", "conversation-content", "execution-assets"];
const TARGET = "backup-dir:target";
const AT = "2026-11-02T00:00:00.000Z";

/** 一次首次建根：激活计划只有根事件，当前链头就是它；激活检查点已复制并由新根签署验证。 */
function activation(options: { scope?: string[]; kind?: RecoveryActivationPlan["kind"] } = {}) {
  const root = RecoveryRoot.generate();
  const rootEvent = {
    v: 1, seq: 1, trustEpoch: 1, prevEventDigest: "sha256:genesis", at: AT,
    body: { t: "recovery-root", op: "establish", rootPublicKey: root.rootPublicKey, backupPublicKey: root.backupPublicKey },
    signature: { alg: "ed25519", keyId: "issuer", sig: "x" },
  } as unknown as Extract<RecoveryActivationPlan, { kind: "establish" }>["rootEvent"];
  const resetEvent = { ...rootEvent, seq: 0, body: { t: "domain-reset" } } as unknown as
    Extract<RecoveryActivationPlan, { kind: "domain-reset-establish" }>["resetEvent"];
  const plan = (options.kind === "domain-reset-establish"
    ? { v: 1, kind: "domain-reset-establish", resetEvent, rootEvent: { ...rootEvent, prevEventDigest: homeTrustEventDigest(resetEvent) } }
    : { v: 1, kind: "establish", rootEvent }) as RecoveryActivationPlan;
  const head = plan.rootEvent;
  const envelope = {
    v: 1, checkpointId: "01CHECKPOINTACTIVATION00000", createdAt: AT,
    alg: { kem: "X25519-HKDF-SHA256", aead: "AES-256-GCM" },
    recipientKeyId: keyIdForPublicKey(root.backupPublicKey), enc: "e", wrappedDek: "w", nonceBase: "n",
    manifest: { scope: options.scope ?? FULL, domainRevisions: {}, upToLsn: 42, purpose: { kind: "root-activation", plan } },
    chunks: [], digest: "sha256:envelope", signature: { alg: "ed25519", keyId: "issuer", sig: "x" },
  } as unknown as CheckpointEnvelope;
  const purpose = checkpointPurpose(envelope);
  const created: Created = {
    t: "checkpoint-created", checkpointId: envelope.checkpointId, recipientKeyId: envelope.recipientKeyId,
    purpose, envelopeRef: checkpointEnvelopeArtifact(envelope), upToLsn: 42, envelopeDigest: envelope.digest, targetId: TARGET,
  } as Created;
  const verification = createRecoveryCheckpointVerification({
    envelope, targetId: TARGET, verificationNonce: randomBytes(32), verifiedAt: AT, recoveryRoot: root,
  });
  const verified: Verified = {
    t: "checkpoint-verified", checkpointId: envelope.checkpointId, recipientKeyId: envelope.recipientKeyId,
    purpose, targetId: TARGET, envelopeDigest: envelope.digest, verification,
  } as Verified;
  const trust = {
    chainHead: { seq: head.seq, eventDigest: homeTrustEventDigest(head) },
    recoveryRootPublicKey: root.rootPublicKey,
    recoveryBackupPublicKey: root.backupPublicKey,
  };
  return { root, trust, envelope, created, verified };
}

describe("当前可恢复资格的同源判定", () => {
  it("首次建根的激活检查点在链头仍是它的根事件时即可恢复；域重置加建根同样成立", () => {
    const established = activation();
    expect(currentRecoveryEligibility({ ...established, targetId: TARGET })).toBe("root-activation");
    const reset = activation({ kind: "domain-reset-establish" });
    expect(currentRecoveryEligibility(reset)).toBe("root-activation");
  });

  it("链头已经前进（含只是祖先、同一根但链头变化）时激活证明不再算当前", () => {
    const a = activation();
    expect(currentRecoveryEligibility({ ...a, trust: { ...a.trust, chainHead: { seq: 2, eventDigest: "sha256:later" } } })).toBeUndefined();
    expect(currentRecoveryEligibility({ ...a, trust: { ...a.trust, chainHead: { seq: 0, eventDigest: "sha256:genesis" } } })).toBeUndefined();
  });

  it("错目标、错根、未原子激活（计划摘要不符）、部分范围、伪造或失配的验证都不通过", () => {
    const a = activation();
    expect(currentRecoveryEligibility({ ...a, targetId: "backup-dir:other" })).toBeUndefined();
    const other = RecoveryRoot.generate();
    expect(currentRecoveryEligibility({ ...a, trust: { ...a.trust, recoveryRootPublicKey: other.rootPublicKey } })).toBeUndefined();
    expect(currentRecoveryEligibility({ ...a, trust: { ...a.trust, recoveryBackupPublicKey: other.backupPublicKey } })).toBeUndefined();
    expect(currentRecoveryEligibility({ ...a, trust: { chainHead: a.trust.chainHead } })).toBeUndefined();
    const notActivated = { kind: "root-activation" as const, activationDigest: "sha256:another-plan" };
    expect(currentRecoveryEligibility({
      ...a,
      created: { ...a.created, purpose: notActivated },
      verified: { ...a.verified, purpose: notActivated, verification: { ...a.verified.verification, purpose: notActivated } },
    })).toBeUndefined();
    const partial = activation({ scope: ["global-authority"] });
    expect(currentRecoveryEligibility(partial)).toBeUndefined();
    const forged = { ...a.verified, verification: { ...a.verified.verification, signature: { ...a.verified.verification.signature, sig: Buffer.alloc(64).toString("base64url") } } };
    expect(currentRecoveryEligibility({ ...a, verified: forged })).toBeUndefined();
    const signedByOther = { ...a.verified, verification: createRecoveryCheckpointVerification({
      envelope: a.envelope, targetId: TARGET, verificationNonce: randomBytes(32), verifiedAt: AT, recoveryRoot: other,
    }) };
    expect(currentRecoveryEligibility({ ...a, verified: signedByOther })).toBeUndefined();
    expect(currentRecoveryEligibility({ ...a, verified: { ...a.verified, targetId: "backup-dir:other" } })).toBeUndefined();
    expect(currentRecoveryEligibility({ ...a, created: { ...a.created, envelopeDigest: "sha256:other" } })).toBeUndefined();
    expect(currentRecoveryEligibility({ ...a, created: { ...a.created, envelopeRef: { digest: "sha256:other", bytes: 1 } } })).toBeUndefined();
  });

  it("普通备份按当前代际判定：代际全等且带来源与请求才算，激活条件不替它放宽", () => {
    const a = activation();
    const periodicEnvelope = { ...a.envelope, manifest: { ...a.envelope.manifest, purpose: { kind: "periodic" } } } as CheckpointEnvelope;
    const generation = {
      rootKeyId: keyIdForPublicKey(a.trust.recoveryRootPublicKey), recipientKeyId: a.created.recipientKeyId,
      trustChainHead: a.trust.chainHead, targetId: TARGET,
    };
    const created = {
      ...a.created, purpose: { kind: "periodic" as const }, envelopeRef: checkpointEnvelopeArtifact(periodicEnvelope),
      generation, source: { kind: "authority-prefix" }, request: { kind: "daily", day: "2026-11-02" },
    } as unknown as Created;
    const verification = createRecoveryCheckpointVerification({
      envelope: periodicEnvelope, targetId: TARGET, verificationNonce: randomBytes(32), verifiedAt: AT, recoveryRoot: a.root,
    });
    const verified = { ...a.verified, purpose: { kind: "periodic" as const }, verification } as Verified;
    expect(currentRecoveryEligibility({ trust: a.trust, verified, created, envelope: periodicEnvelope })).toBe("current-generation");
    expect(currentRecoveryEligibility({
      trust: { ...a.trust, chainHead: { seq: 9, eventDigest: "sha256:moved" } }, verified, created, envelope: periodicEnvelope,
    })).toBeUndefined();
    const { source: _source, ...withoutSource } = created as Created & { source?: unknown };
    expect(currentRecoveryEligibility({ trust: a.trust, verified, created: withoutSource as Created, envelope: periodicEnvelope })).toBeUndefined();
  });
});
