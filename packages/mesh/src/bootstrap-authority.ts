import type {
  ArtifactRef,
  CheckpointStreamRecord,
  DeviceIdentity,
  HomeTrustEvent,
  PairingAcceptance,
  PairingJoin,
  PairingOffer,
  PakeRound,
  RecoveryActivationPlan,
  RecoveryCheckpointVerification,
} from "@zhixing/core/contracts";
import {
  checkpointEnvelopeArtifact,
  checkpointPurpose,
  assertRecoveryRootMatchesPlan,
  createRecoveryCheckpointVerification,
  openRootActivationCheckpoint,
  type CheckpointPackage,
  verifyRecoveryCheckpointVerification,
} from "./checkpoint.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import {
  assertPairingOfferJoin,
  pairingOfferDigest,
  pairingTranscriptDigest,
  PakeIssuerSession,
  verifyPairingAcceptance,
  verifyQrPairingJoin,
  type PairingOfferRepository,
  type PairingPakeSuiteRegistry,
} from "./pairing.js";
import { keyIdForPublicKey, RecoveryRoot, verifyRecoverySignature } from "./recovery-root.js";
import { applyTrustEvent, homeTrustEventDigest, type TrustProjection } from "./trust-chain.js";

export interface PairingAttemptAdmission {
  readonly attemptId: string;
  readonly offerId: string;
  readonly offerDigest: string;
  readonly ordinal: number;
  readonly at: string;
  readonly retryNotBefore: string;
}

export type PairingAttemptDecision =
  | { readonly admitted: true; readonly attempt: PairingAttemptAdmission }
  | {
      readonly admitted: false;
      readonly reason: "backoff" | "exhausted";
      readonly attempts: number;
      readonly retryAfterMs: number;
    };

export interface AdmittedPakeIssuerSession {
  readonly responseRound: PakeRound;
  finish(joinerRound: PakeRound): Promise<Buffer>;
}

export interface PairingAtomicCommit {
  readonly expectedChainHead: TrustProjection["chainHead"];
  readonly attempt: PairingAttemptAdmission;
  readonly offer: PairingOffer;
  readonly acceptance: PairingAcceptance;
  readonly trustEvent: HomeTrustEvent;
}

export interface PairingCommitReceipt {
  readonly expectedChainHead: TrustProjection["chainHead"];
  readonly attemptId: string;
  readonly offerId: string;
  readonly offerDigest: string;
  readonly acceptance: PairingAcceptance;
  readonly trustEventDigest: string;
  readonly resultingChainHead: TrustProjection["chainHead"];
}

export interface PairingCommitReplay {
  readonly receipt: PairingCommitReceipt;
  /** Current projection rebuilt from the same authority log that contains the receipt. */
  readonly trust: TrustProjection;
}

export interface RecoveryActivationAtomicCommit {
  readonly expectedChainHead: TrustProjection["chainHead"];
  readonly plan: RecoveryActivationPlan;
  readonly verification: RecoveryCheckpointVerification;
  readonly checkpointRecords: readonly [
    Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }>,
    ...Extract<CheckpointStreamRecord, { t: "checkpoint-superseded" }>[],
  ];
}

export interface RecoveryActivationReplay {
  readonly commit: RecoveryActivationAtomicCommit;
  /** Current projection rebuilt from the same authority log that contains the commit. */
  readonly trust: TrustProjection;
}

/**
 * Atomic durability boundary supplied by the authority log. Every method resolves only
 * after its write is durable. Pairing attempt admission is serialized by offerId and is
 * persisted before any secret-dependent response; success consumes the admitted attempt
 * in the same commit as the trust event. Checkpoint package storage and record appends are
 * content-idempotent: an exact replay is a no-op and a conflicting identity is rejected.
 */
export interface BootstrapAuthorityPort {
  /** Appends pairing-attempt-started and enforces offer-scoped ordinal/backoff atomically. */
  beginPairingAttempt(
    offer: PairingOffer,
    now: number,
  ): Promise<PairingAttemptDecision>;
  failPairingAttempt(attempt: PairingAttemptAdmission): Promise<void>;
  /** Rebuilds the original atomic input from durable records for response-loss replay. */
  loadPairingCommit(attemptId: string): Promise<PairingCommitReplay | undefined>;
  /** Atomically consumes a started attempt with succeeded + enroll/reenroll under trust-head CAS. */
  commitPairing(input: PairingAtomicCommit): Promise<void>;
  /** Persists the signed envelope and every referenced ciphertext chunk before returning its ref. */
  persistCheckpointPackage(checkpoint: CheckpointPackage): Promise<ArtifactRef>;
  loadCheckpointPackage(envelopeRef: ArtifactRef): Promise<CheckpointPackage | undefined>;
  appendCheckpoint(record: CheckpointStreamRecord): Promise<void>;
  /** Rebuilds the original atomic activation from trust/checkpoint records for replay. */
  loadRecoveryActivation(checkpointId: string): Promise<RecoveryActivationReplay | undefined>;
  /** Verifies matching created/replicated facts, then atomically commits plan + verified + superseded. */
  commitRecoveryActivation(input: RecoveryActivationAtomicCommit): Promise<void>;
}

export class PairingCommitCoordinator {
  constructor(
    private readonly authority: BootstrapAuthorityPort,
    private readonly offers: PairingOfferRepository,
    private readonly pakeSuites?: PairingPakeSuiteRegistry,
  ) {}

  async beginQrAttempt(input: {
    current: TrustProjection;
    offer: PairingOffer;
    issuerIdentity: Parameters<typeof assertPairingOfferJoin>[2];
    now?: number;
  }): Promise<PairingAttemptAdmission> {
    const now = input.now ?? Date.now();
    const material = this.requireOffer(input.offer.offerId, now);
    assertCurrentIssuer(input.current, input.issuerIdentity);
    if (
      input.offer.method.kind !== "qr-secret" ||
      canonicalize(input.offer) !== canonicalize(material.offer)
    ) {
      throw new TypeError("QR attempt does not match the issuer's active offer");
    }
    return this.beginAttempt(material.offer, now);
  }

  async beginShortCodeAttempt(input: {
    current: TrustProjection;
    offer: PairingOffer;
    join: PairingJoin;
    joinerRound: PakeRound;
    issuerIdentity: Parameters<typeof assertPairingOfferJoin>[2];
    now?: number;
  }): Promise<{ attempt: PairingAttemptAdmission; session: AdmittedPakeIssuerSession }> {
    const now = input.now ?? Date.now();
    const material = this.requireOffer(input.offer.offerId, now);
    assertCurrentIssuer(input.current, input.issuerIdentity);
    if (canonicalize(input.offer) !== canonicalize(material.offer)) {
      throw new TypeError("Pairing offer differs from the issuer's active offer");
    }
    assertPairingOfferJoin(input.offer, input.join, input.issuerIdentity, now);
    if (input.offer.method.kind !== "short-pake" || input.join.method !== "short-pake") {
      throw new TypeError("Short-code attempt requires a PAKE offer and join");
    }
    if (!this.pakeSuites) {
      throw new TypeError("Short-code pairing requires an explicitly approved PAKE suite");
    }
    const attempt = await this.beginAttempt(material.offer, now);
    try {
      const session = await PakeIssuerSession.respond(
        input.offer,
        input.join,
        input.joinerRound,
        material.secret,
        this.pakeSuites,
        now,
      );
      let completedRound: PakeRound | undefined;
      let completedSessionKey: Buffer | undefined;
      return {
        attempt,
        session: {
          responseRound: session.responseRound,
          finish: async (joinerRound) => {
            if (completedRound && completedSessionKey) {
              if (canonicalize(completedRound) !== canonicalize(joinerRound)) {
                throw new TypeError("PAKE attempt already completed with another final round");
              }
              return Buffer.from(completedSessionKey);
            }
            try {
              const sessionKey = session.finish(joinerRound);
              completedRound = structuredClone(joinerRound);
              completedSessionKey = Buffer.from(sessionKey);
              return sessionKey;
            } catch (error) {
              return await this.failAttempt(attempt, error);
            }
          },
        },
      };
    } catch (error) {
      return await this.failAttempt(attempt, error);
    }
  }

  async commit(input: {
    current: TrustProjection;
    offer: PairingOffer;
    join: PairingJoin;
    pakeRounds: readonly PakeRound[];
    acceptance: PairingAcceptance;
    trustEvent: HomeTrustEvent;
    issuerIdentity: Parameters<typeof verifyPairingAcceptance>[0]["issuer"];
    sessionKey?: Uint8Array;
    attempt: PairingAttemptAdmission;
    now?: number;
  }): Promise<TrustProjection> {
    const attempt = this.requireAttempt(input.attempt, input.offer);
    const resultingChainHead = {
      seq: input.trustEvent.seq,
      eventDigest: homeTrustEventDigest(input.trustEvent),
    };
    const requestedCommit: PairingAtomicCommit = {
      expectedChainHead: input.current.chainHead,
      attempt,
      offer: input.offer,
      acceptance: input.acceptance,
      trustEvent: input.trustEvent,
    };
    const expectedReceipt: PairingCommitReceipt = {
      expectedChainHead: {
        seq: input.trustEvent.seq - 1,
        eventDigest: input.trustEvent.prevEventDigest,
      },
      attemptId: attempt.attemptId,
      offerId: input.offer.offerId,
      offerDigest: pairingOfferDigest(input.offer),
      acceptance: input.acceptance,
      trustEventDigest: homeTrustEventDigest(input.trustEvent),
      resultingChainHead,
    };
    const replay = await this.authority.loadPairingCommit(attempt.attemptId);
    if (replay) {
      assertPairingCommitBindings(input);
      if (canonicalize(replay.receipt) !== canonicalize(expectedReceipt)) {
        throw new TypeError("Pairing attempt was already committed with different content");
      }
      assertCommittedProjection(replay.trust, input.trustEvent.homeId, resultingChainHead);
      this.offers.remove(input.offer.offerId);
      return replay.trust;
    }
    const now = input.now ?? Date.now();
    let next!: TrustProjection;
    try {
      assertCurrentIssuer(input.current, input.issuerIdentity);
      const material = this.requireOffer(input.offer.offerId, now);
      assertPairingCommitBindings(input);
      if (canonicalize(input.offer) !== canonicalize(material.offer)) {
        throw new TypeError("Pairing offer differs from the issuer's active offer");
      }
      assertPairingOfferJoin(
        input.offer,
        input.join,
        input.issuerIdentity,
        now,
      );
      if (input.offer.method.kind === "qr-secret") {
        verifyQrPairingJoin(
          input.offer,
          input.join,
          material.secret,
          now,
        );
      } else if (!input.sessionKey) {
        throw new TypeError("PAKE pairing commit requires its established session key");
      }
      assertAcceptanceAttemptTime(attempt, input.acceptance, now);
      next = applyTrustEvent(input.current, input.trustEvent);
      if (canonicalize(next.chainHead) !== canonicalize(resultingChainHead)) {
        throw new TypeError("Pairing acceptance is not bound to the resulting trust chain head");
      }
      verifyPairingAcceptance({
        acceptance: input.acceptance,
        offer: input.offer,
        issuer: input.issuerIdentity,
        joiner: input.join.device,
        sessionKey: input.sessionKey,
      });
    } catch (error) {
      await this.failAttempt(attempt, error);
    }
    await this.authority.commitPairing(requestedCommit);
    this.offers.remove(input.offer.offerId);
    return next;
  }

  private async beginAttempt(offer: PairingOffer, now: number): Promise<PairingAttemptAdmission> {
    const decision = await this.authority.beginPairingAttempt(
      offer,
      now,
    );
    if (decision.admitted) {
      const attempt = this.requireAttempt(decision.attempt, offer);
      if (attempt.ordinal > offer.attempts.max || Date.parse(attempt.at) > now) {
        throw new TypeError("Pairing authority returned an invalid attempt admission");
      }
      return attempt;
    }
    if (
      (decision.reason !== "backoff" && decision.reason !== "exhausted") ||
      !Number.isSafeInteger(decision.attempts) ||
      decision.attempts < 0 ||
      !Number.isSafeInteger(decision.retryAfterMs) ||
      decision.retryAfterMs < 0
    ) {
      throw new TypeError("Pairing authority returned an invalid attempt rejection");
    }
    if (decision.reason === "exhausted") {
      this.offers.remove(offer.offerId);
      throw new TypeError("Pairing offer attempts are exhausted");
    }
    throw new TypeError(`Pairing attempt is rate limited; retry after ${decision.retryAfterMs}ms`);
  }

  private requireAttempt(
    attempt: PairingAttemptAdmission,
    offer: PairingOffer,
  ): PairingAttemptAdmission {
    if (
      attempt.offerId !== offer.offerId ||
      attempt.offerDigest !== pairingOfferDigest(offer) ||
      attempt.attemptId.length === 0 ||
      !Number.isSafeInteger(attempt.ordinal) ||
      attempt.ordinal <= 0 ||
      !isCanonicalTime(attempt.at) ||
      !isCanonicalTime(attempt.retryNotBefore) ||
      Date.parse(attempt.retryNotBefore) <= Date.parse(attempt.at)
    ) {
      throw new TypeError("Pairing commit requires a durably admitted attempt");
    }
    return attempt;
  }

  private async failAttempt(attempt: PairingAttemptAdmission, cause: unknown): Promise<never> {
    try {
      await this.authority.failPairingAttempt(attempt);
    } catch (durabilityError) {
      throw new Error("Pairing rejection could not be durably recorded", {
        cause: new AggregateError([cause, durabilityError]),
      });
    }
    throw cause;
  }

  private requireOffer(offerId: string, now: number) {
    const material = this.offers.get(offerId);
    if (!material) throw new TypeError("Pairing offer is unknown, expired, or consumed");
    if (now >= Date.parse(material.offer.expiresAt)) {
      this.offers.remove(offerId);
      throw new TypeError("Pairing offer is unknown, expired, or consumed");
    }
    return material;
  }
}

function isCanonicalTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertAcceptanceAttemptTime(
  attempt: PairingAttemptAdmission,
  acceptance: PairingAcceptance,
  now: number,
): void {
  const admittedAt = Date.parse(attempt.at);
  const acceptedAt = Date.parse(acceptance.acceptedAt);
  if (
    !Number.isFinite(acceptedAt) ||
    acceptedAt < admittedAt ||
    acceptedAt > now
  ) {
    throw new TypeError("Pairing acceptance time is outside its admitted attempt");
  }
}

function assertPairingCommitBindings(input: {
  offer: PairingOffer;
  join: PairingJoin;
  pakeRounds: readonly PakeRound[];
  acceptance: PairingAcceptance;
  trustEvent: HomeTrustEvent;
}): TrustProjection["chainHead"] {
  const transcriptDigest = pairingTranscriptDigest(input.offer, input.join, input.pakeRounds);
  const eventDigest = homeTrustEventDigest(input.trustEvent);
  const resultingChainHead = { seq: input.trustEvent.seq, eventDigest };
  if (
    !Number.isSafeInteger(input.trustEvent.seq) ||
    input.trustEvent.seq <= 0 ||
    input.trustEvent.homeId !== input.offer.homeId ||
    input.acceptance.offerId !== input.offer.offerId ||
    input.acceptance.transcriptDigest !== transcriptDigest ||
    canonicalize(input.acceptance.chainHead) !== canonicalize(resultingChainHead)
  ) {
    throw new TypeError("Pairing acceptance is not bound to the proposed trust event");
  }
  if (input.trustEvent.body.t !== "enroll" && input.trustEvent.body.t !== "reenroll") {
    throw new TypeError("Pairing may only commit enrollment trust events");
  }
  if (input.trustEvent.body.pairingTranscriptDigest !== transcriptDigest) {
    throw new TypeError("Trust enrollment is not bound to the pairing transcript");
  }
  const targetDeviceId =
    input.trustEvent.body.t === "enroll"
      ? input.trustEvent.body.device.deviceId
      : input.trustEvent.body.deviceId;
  if (targetDeviceId !== input.join.device.deviceId) {
    throw new TypeError("Pairing enrollment targets another device");
  }
  return resultingChainHead;
}

function assertCommittedProjection(
  trust: TrustProjection,
  homeId: string,
  resultingChainHead: TrustProjection["chainHead"],
): void {
  if (
    trust.homeId !== homeId ||
    trust.chainHead.seq < resultingChainHead.seq ||
    (trust.chainHead.seq === resultingChainHead.seq &&
      trust.chainHead.eventDigest !== resultingChainHead.eventDigest)
  ) {
    throw new TypeError("Authority replay projection does not contain the committed trust event");
  }
}

export interface RecoveryCheckpointTarget {
  readonly targetId: string;
  readonly independenceDomain: string;
  /** Resolves only after an idempotent checkpointId write is durable. */
  writeDurable(checkpoint: CheckpointPackage): Promise<void>;
  read(checkpointId: string): Promise<CheckpointPackage>;
}

export type RecoveryActivationStep =
  | "created"
  | "replicated"
  | "read-back"
  | "verified"
  | "committed";

export class RecoveryActivationCoordinator {
  constructor(private readonly authority: BootstrapAuthorityPort) {}

  async activatePrepared(input: {
    current: TrustProjection;
    plan: RecoveryActivationPlan;
    checkpoint: CheckpointPackage;
    candidateRoot: RecoveryRoot;
    issuerIdentity: Parameters<typeof openRootActivationCheckpoint>[0]["issuer"];
    target: RecoveryCheckpointTarget;
    sourceIndependenceDomain: string;
    verifiedAt: string;
    replicatedAt?: string;
    supersedeCheckpointIds?: readonly string[];
    onStep?: (step: RecoveryActivationStep) => void | Promise<void>;
  }): Promise<TrustProjection> {
    if (
      input.target.targetId.length === 0 ||
      input.target.independenceDomain.length === 0 ||
      input.sourceIndependenceDomain.length === 0 ||
      input.target.independenceDomain === input.sourceIndependenceDomain
    ) {
      throw new TypeError("Recovery checkpoint target is not independent from its source");
    }
    const envelope = input.checkpoint.envelope;
    const replicatedAt = input.replicatedAt ?? input.verifiedAt;
    const createdTime = Date.parse(envelope.createdAt);
    const replicatedTime = Date.parse(replicatedAt);
    const verifiedTime = Date.parse(input.verifiedAt);
    if (
      !isCanonicalTime(envelope.createdAt) ||
      !isCanonicalTime(replicatedAt) ||
      !isCanonicalTime(input.verifiedAt) ||
      replicatedTime < createdTime ||
      verifiedTime < replicatedTime
    ) {
      throw new TypeError("Recovery checkpoint lifecycle times are invalid");
    }
    const supersedeIds = input.supersedeCheckpointIds ?? [];
    if (
      new Set(supersedeIds).size !== supersedeIds.length ||
      supersedeIds.includes(envelope.checkpointId)
    ) {
      throw new TypeError("Superseded checkpoint ids must be unique old checkpoints");
    }
    assertRecoveryRootMatchesPlan(input.plan, input.candidateRoot);
    if (
      envelope.manifest.purpose.kind !== "root-activation" ||
      protocolDigest("RecoveryActivationPlan", 1, envelope.manifest.purpose.plan) !==
        protocolDigest("RecoveryActivationPlan", 1, input.plan)
    ) {
      throw new TypeError("Prepared checkpoint carries another activation plan");
    }
    const purpose = checkpointPurpose(envelope);
    const replay = await this.authority.loadRecoveryActivation(envelope.checkpointId);
    if (replay) {
      const opened = openRootActivationCheckpoint({
        package: input.checkpoint,
        recoveryRoot: input.candidateRoot,
        issuer: input.issuerIdentity,
      });
      try {
        verifyRecoveryCheckpointVerification({
          verification: replay.commit.verification,
          envelope,
          targetId: input.target.targetId,
          verificationNonce: opened.verificationNonce,
          recoveryRootPublicKey: input.candidateRoot.rootPublicKey,
        });
      } finally {
        clearOpenedCheckpoint(opened);
      }
      assertRecoveryActivationReplay({
        replay: replay.commit,
        plan: input.plan,
        envelope,
        targetId: input.target.targetId,
        verifiedAt: input.verifiedAt,
        supersedeCheckpointIds: input.supersedeCheckpointIds ?? [],
      });
      const bounds = recoveryPlanBounds(input.plan);
      assertCommittedProjection(replay.trust, bounds.last.homeId, bounds.resultingChainHead);
      return replay.trust;
    }
    assertCurrentIssuer(input.current, input.issuerIdentity);
    const next = validateRecoveryActivationPlan(input.current, input.plan);
    const expectedEnvelopeRef = checkpointEnvelopeArtifact(envelope);
    const persistedEnvelopeRef = await this.authority.persistCheckpointPackage(input.checkpoint);
    if (canonicalize(persistedEnvelopeRef) !== canonicalize(expectedEnvelopeRef)) {
      throw new TypeError("Persisted checkpoint package returned another envelope reference");
    }
    const created: CheckpointStreamRecord = {
      t: "checkpoint-created",
      checkpointId: envelope.checkpointId,
      recipientKeyId: envelope.recipientKeyId,
      purpose,
      envelopeRef: persistedEnvelopeRef,
      upToLsn: envelope.manifest.upToLsn,
      envelopeDigest: envelope.digest,
    };
    await this.authority.appendCheckpoint(created);
    await input.onStep?.("created");

    await input.target.writeDurable(input.checkpoint);
    const replicated: CheckpointStreamRecord = {
      t: "checkpoint-replicated",
      checkpointId: envelope.checkpointId,
      recipientKeyId: envelope.recipientKeyId,
      purpose,
      targetId: input.target.targetId,
      envelopeDigest: envelope.digest,
      at: replicatedAt,
    };
    await this.authority.appendCheckpoint(replicated);
    await input.onStep?.("replicated");

    const readBack = await input.target.read(envelope.checkpointId);
    await input.onStep?.("read-back");
    let opened: ReturnType<typeof openRootActivationCheckpoint>;
    try {
      opened = openRootActivationCheckpoint({
        package: readBack,
        recoveryRoot: input.candidateRoot,
        issuer: input.issuerIdentity,
      });
    } catch (error) {
      await this.authority.appendCheckpoint({
        t: "checkpoint-verify-failed",
        checkpointId: envelope.checkpointId,
        recipientKeyId: envelope.recipientKeyId,
        purpose,
        targetId: input.target.targetId,
        envelopeDigest: envelope.digest,
        reason: error instanceof Error ? error.message : "checkpoint verification failed",
        at: input.verifiedAt,
      });
      throw error;
    }
    let verification: RecoveryCheckpointVerification;
    try {
      verification = createRecoveryCheckpointVerification({
        envelope: readBack.envelope,
        targetId: input.target.targetId,
        verificationNonce: opened.verificationNonce,
        verifiedAt: input.verifiedAt,
        recoveryRoot: input.candidateRoot,
      });
      verifyRecoveryCheckpointVerification({
        verification,
        envelope,
        targetId: input.target.targetId,
        verificationNonce: opened.verificationNonce,
        recoveryRootPublicKey: input.candidateRoot.rootPublicKey,
      });
    } finally {
      clearOpenedCheckpoint(opened);
    }
    await input.onStep?.("verified");
    const verified: CheckpointStreamRecord = {
      t: "checkpoint-verified",
      checkpointId: envelope.checkpointId,
      recipientKeyId: envelope.recipientKeyId,
      purpose,
      targetId: input.target.targetId,
      envelopeDigest: envelope.digest,
      verification,
    };
    const superseded = supersedeIds.map<
      Extract<CheckpointStreamRecord, { t: "checkpoint-superseded" }>
    >(
      (checkpointId) => ({
        t: "checkpoint-superseded",
        checkpointId,
        supersededBy: envelope.checkpointId,
        at: input.verifiedAt,
      }),
    );
    await this.authority.commitRecoveryActivation({
      expectedChainHead: input.current.chainHead,
      plan: input.plan,
      verification,
      checkpointRecords: [verified, ...superseded],
    });
    await input.onStep?.("committed");
    return next;
  }
}

function assertCurrentIssuer(
  current: TrustProjection,
  identity: DeviceIdentity,
): void {
  const trusted = current.members.find(
    (member) => member.device.deviceId === current.issuer.deviceId && member.state === "active",
  );
  if (
    !trusted ||
    identity.deviceId !== current.issuer.deviceId ||
    identity.deviceId !== current.issuer.issuerKeyId ||
    canonicalize(identity) !== canonicalize(trusted.device)
  ) {
    throw new TypeError("Operation signer is not the current trust issuer");
  }
}

function assertRecoveryActivationReplay(input: {
  replay: RecoveryActivationAtomicCommit;
  plan: RecoveryActivationPlan;
  envelope: CheckpointPackage["envelope"];
  targetId: string;
  verifiedAt: string;
  supersedeCheckpointIds: readonly string[];
}): void {
  const bounds = recoveryPlanBounds(input.plan);
  const verification = input.replay.verification;
  const [verifiedRecord, ...supersededRecords] = input.replay.checkpointRecords;
  const expectedVerifiedRecord: Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }> = {
    t: "checkpoint-verified",
    checkpointId: input.envelope.checkpointId,
    recipientKeyId: input.envelope.recipientKeyId,
    purpose: checkpointPurpose(input.envelope),
    targetId: input.targetId,
    envelopeDigest: input.envelope.digest,
    verification,
  };
  const supersededIds = supersededRecords.map((record) => record.checkpointId).sort();
  if (
    canonicalize(input.replay.expectedChainHead) !== canonicalize(bounds.expectedChainHead) ||
    canonicalize(input.replay.plan) !== canonicalize(input.plan) ||
    verification.checkpointId !== input.envelope.checkpointId ||
    verification.recipientKeyId !== input.envelope.recipientKeyId ||
    verification.envelopeDigest !== input.envelope.digest ||
    verification.targetId !== input.targetId ||
    verification.verifiedAt !== input.verifiedAt ||
    canonicalize(verification.purpose) !== canonicalize(checkpointPurpose(input.envelope)) ||
    canonicalize(verifiedRecord) !== canonicalize(expectedVerifiedRecord) ||
    supersededRecords.some(
      (record) =>
        record.supersededBy !== input.envelope.checkpointId || record.at !== input.verifiedAt,
    ) ||
    canonicalize(supersededIds) !== canonicalize([...input.supersedeCheckpointIds].sort())
  ) {
    throw new TypeError("Recovery activation was already committed with different content");
  }
}

function recoveryPlanBounds(plan: RecoveryActivationPlan): {
  first: HomeTrustEvent;
  last: HomeTrustEvent;
  expectedChainHead: TrustProjection["chainHead"];
  resultingChainHead: TrustProjection["chainHead"];
} {
  const first = plan.kind === "domain-reset-establish" ? plan.resetEvent : plan.rootEvent;
  const last = plan.rootEvent;
  if (!Number.isSafeInteger(first.seq) || first.seq <= 0 || !Number.isSafeInteger(last.seq)) {
    throw new TypeError("Recovery activation plan has invalid trust positions");
  }
  return {
    first,
    last,
    expectedChainHead: { seq: first.seq - 1, eventDigest: first.prevEventDigest },
    resultingChainHead: { seq: last.seq, eventDigest: homeTrustEventDigest(last) },
  };
}

function clearOpenedCheckpoint(opened: ReturnType<typeof openRootActivationCheckpoint>): void {
  opened.verificationNonce.fill(0);
  for (const chunk of opened.plaintextChunks) chunk.fill(0);
}

export function validateRecoveryActivationPlan(
  current: TrustProjection,
  plan: RecoveryActivationPlan,
): TrustProjection {
  if (plan.v !== 1) throw new TypeError("Recovery activation plan version is unsupported");
  if (plan.kind !== "domain-reset-establish") {
    if (
      plan.rootEvent.body.t !== "recovery-root" ||
      plan.rootEvent.body.op !== plan.kind
    ) {
      throw new TypeError("Recovery activation plan contains the wrong root event");
    }
    return applyTrustEvent(current, plan.rootEvent);
  }
  if (plan.resetEvent.body.t !== "domain-reset") {
    throw new TypeError("Domain reset activation plan must begin with a reset event");
  }
  const reset = applyTrustEvent(current, plan.resetEvent);
  if (
    plan.rootEvent.body.t !== "recovery-root" ||
    plan.rootEvent.body.op !== "establish" ||
    plan.rootEvent.seq !== plan.resetEvent.seq + 1 ||
    plan.rootEvent.prevEventDigest !== reset.chainHead.eventDigest ||
    plan.rootEvent.trustEpoch !== reset.trustEpoch
  ) {
    throw new TypeError("Domain reset activation plan is not a continuous reset and establish pair");
  }
  return applyTrustEvent(reset, plan.rootEvent);
}

export interface RecoveryReadinessProjection {
  readonly rootKeyId?: string;
  readonly checkpointId?: string;
  readonly targetId?: string;
  readonly ready: boolean;
}

export function projectRecoveryReadiness(input: {
  trust: TrustProjection;
  verifiedRecords: readonly Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }>[];
}): RecoveryReadinessProjection {
  if (!input.trust.recoveryRootPublicKey || !input.trust.recoveryBackupPublicKey) {
    return Object.freeze({ ready: false });
  }
  const rootKeyId = keyIdForPublicKey(input.trust.recoveryRootPublicKey);
  const expectedKeyId = keyIdForPublicKey(input.trust.recoveryBackupPublicKey);
  const record = [...input.verifiedRecords]
    .reverse()
    .find(
      (candidate) =>
        candidate.recipientKeyId === expectedKeyId &&
        candidate.purpose.kind === "root-activation" &&
        candidate.purpose.activationDigest === input.trust.recoveryActivationDigest &&
        isValidCurrentRootVerification(candidate, input.trust.recoveryRootPublicKey!),
    );
  if (!record) return Object.freeze({ rootKeyId, ready: false });
  return Object.freeze({
    rootKeyId,
    checkpointId: record.checkpointId,
    targetId: record.targetId,
    ready: true,
  });
}

function isValidCurrentRootVerification(
  record: Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }>,
  recoveryRootPublicKey: string,
): boolean {
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
    verifyRecoverySignature(
      recoveryRootPublicKey,
      "RecoveryCheckpointVerification",
      1,
      unsigned,
      signature,
    );
    return true;
  } catch {
    return false;
  }
}
