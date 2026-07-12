import type {
  ArtifactRef,
  CheckpointStreamRecord,
  HomeTrustEventBody,
  PairingAcceptance,
  PairingJoin,
  PairingOffer,
  PakeRound,
  RecoveryActivationPlan,
} from "@zhixing/core/contracts";
import { describe, expect, it } from "vitest";
import {
  type BootstrapAuthorityPort,
  type PairingAttemptAdmission,
  type PairingAttemptDecision,
  PairingCommitCoordinator,
  type PairingAtomicCommit,
  type PairingCommitReceipt,
  type PairingCommitReplay,
  RecoveryActivationCoordinator,
  type RecoveryActivationAtomicCommit,
  type RecoveryActivationReplay,
  type RecoveryCheckpointTarget,
  projectRecoveryReadiness,
  validateRecoveryActivationPlan,
} from "../bootstrap-authority.js";
import {
  createRootActivationCheckpoint,
  checkpointEnvelopeArtifact,
  openRootActivationCheckpoint,
  type CheckpointPackage,
} from "../checkpoint.js";
import { canonicalize } from "../canonical.js";
import { DeviceKey, enrollDeviceIdentity } from "../device-identity.js";
import { createUlid } from "../identifiers.js";
import { CIPHERMAN_PAIRING_PAKE_SUITES } from "../pairing-pake-cipherman.js";
import {
  assemblePairingFinished,
  createPairingAcceptanceProof,
  createQrPairingJoin,
  createShortCodePairingOffer,
  InMemoryPairingOfferRepository,
  pairingTranscriptDigest,
  pairingOfferDigest,
  PakeIssuerSession,
  PakeJoinerSession,
  verifyPairingAcceptance,
  verifyQrPairingJoin,
} from "../pairing.js";
import { RecoveryRoot } from "../recovery-root.js";
import * as publicMesh from "../index.js";
import * as publicPairing from "../pairing-public.js";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createDomainResetEvent,
  createRecoveryRootEvent,
  createSignedTrustEvent,
  createTrustGenesisEvent,
  homeTrustEventDigest,
  initializeTrustChain,
  replayTrustChain,
  type TrustProjection,
  verifyHomeTrustRecord,
} from "../trust-chain.js";

const NOW = Date.parse("2026-07-12T08:00:00.000Z");
const AT = new Date(NOW).toISOString();
const ATTEMPT_TIMES = [NOW, NOW + 250, NOW + 750] as const;

describe("pairing protocol", () => {
  it("durably limits attempts and atomically grants a single QR enrollment", async () => {
    const issuer = await device("anchor");
    const joiner = await device("executor");
    const { projection: genesis } = trustGenesis(issuer);
    const store = new TestAuthority(genesis);
    const offers = new InMemoryPairingOfferRepository();
    const coordinator = new PairingCommitCoordinator(store, offers);
    const { offer, secret } = offers.issueQr({
      homeId: genesis.homeId,
      issuer: issuer.identity,
      protocolVersion: "1",
      now: NOW,
    });

    const offerBoundJoin = createQrPairingJoin(offer, joiner.identity, secret);
    expect(() =>
      verifyQrPairingJoin({ ...offer, protocolVersion: "0" }, offerBoundJoin, secret, NOW),
    ).toThrow(/confirmation is invalid/);
    const invalidJoin = createQrPairingJoin(
      offer,
      joiner.identity,
      Buffer.alloc(32, 0xa5).toString("base64url"),
    );
    const exhausted = prepareQrPairing(genesis, offer, secret, issuer, joiner, AT, invalidJoin);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const attemptNow = ATTEMPT_TIMES[attempt - 1]!;
      const admission = await coordinator.beginQrAttempt({
        current: genesis,
        offer,
        issuerIdentity: issuer.identity,
        now: attemptNow,
      });
      await expect(
        coordinator.commit({ ...exhausted, attempt: admission, join: invalidJoin, now: attemptNow }),
      ).rejects.toThrow(/confirmation is invalid/);
      expect(store.attemptCount(offer.offerId)).toBe(attempt);
      expect(store.lastAttemptStatus(offer.offerId)).toBe("failed");
      if (attempt === 1) {
        await expect(
          coordinator.beginQrAttempt({
            current: genesis,
            offer,
            issuerIdentity: issuer.identity,
            now: NOW + 249,
          }),
        ).rejects.toThrow(/rate limited/);
        expect(store.attemptCount(offer.offerId)).toBe(1);
      }
    }
    await expect(
      coordinator.beginQrAttempt({
        current: genesis,
        offer,
        issuerIdentity: issuer.identity,
        now: NOW + 1_750,
      }),
    ).rejects.toThrow(/attempts are exhausted/);

    const fresh = offers.issueQr({
      homeId: genesis.homeId,
      issuer: issuer.identity,
      protocolVersion: "1",
      now: NOW,
    });
    const competingJoiner = await device("competing-executor");
    const prepared = prepareQrPairing(
      genesis,
      fresh.offer,
      fresh.secret,
      issuer,
      joiner,
      new Date(NOW + 250).toISOString(),
    );
    const competing = prepareQrPairing(
      genesis,
      fresh.offer,
      fresh.secret,
      issuer,
      competingJoiner,
      new Date(NOW + 250).toISOString(),
    );
    const [firstAdmission, secondAdmission] = await Promise.all([
      coordinator.beginQrAttempt({
        current: genesis,
        offer: fresh.offer,
        issuerIdentity: issuer.identity,
        now: NOW,
      }),
      coordinator.beginQrAttempt({
        current: genesis,
        offer: fresh.offer,
        issuerIdentity: issuer.identity,
        now: NOW + 250,
      }),
    ]);
    const attempts = await Promise.allSettled([
      coordinator.commit({ ...prepared, attempt: firstAdmission, now: NOW + 250 }),
      coordinator.commit({ ...competing, attempt: secondAdmission, now: NOW + 250 }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      store.projection.members.filter((member) =>
        [joiner.key.deviceId, competingJoiner.key.deviceId].includes(member.device.deviceId),
      ),
    ).toHaveLength(1);
    expect(store.succeededOffers).toEqual(new Set([fresh.offer.offerId]));
    const firstWon = Boolean(await store.loadPairingCommit(firstAdmission.attemptId));
    const winningAdmission = firstWon ? firstAdmission : secondAdmission;
    const winningRequest = firstWon ? prepared : competing;
    await expect(
      new PairingCommitCoordinator(store, offers).commit({
        ...winningRequest,
        current: store.projection,
        attempt: winningAdmission,
        now: NOW,
      }),
    ).resolves.toEqual(store.projection);
  });

  it("runs mutually confirmed SPAKE2+ and rejects wrong-code, downgrade and round attacks", async () => {
    const issuer = await device("anchor");
    const joiner = await device("executor");
    const material = createShortCodePairingOffer({
      homeId: "home-1",
      issuer: issuer.identity,
      protocolVersion: "1",
      now: NOW,
    });
    const joined = await PakeJoinerSession.start(
      material.offer,
      joiner.identity,
      material.secret,
      CIPHERMAN_PAIRING_PAKE_SUITES,
      NOW,
    );
    const issuing = await PakeIssuerSession.respond(
      material.offer,
      joined.join,
      joined.session.firstRound,
      material.secret,
      CIPHERMAN_PAIRING_PAKE_SUITES,
      NOW,
    );
    const finalRound = joined.session.finish(issuing.responseRound);
    const issuerKey = issuing.finish(finalRound);
    expect(joined.session.sessionKey()).toEqual(issuerKey);
    expect(
      [joined.session.firstRound, issuing.responseRound, finalRound]
        .map((round) => round.payload)
        .join(""),
    ).not.toContain(material.secret);
    expect(() => issuing.finish(finalRound)).toThrow(/already complete/);

    const wrongJoiner = await PakeJoinerSession.start(
      material.offer,
      joiner.identity,
      material.secret,
      CIPHERMAN_PAIRING_PAKE_SUITES,
      NOW,
    );
    const wrongIssuer = await PakeIssuerSession.respond(
      material.offer,
      wrongJoiner.join,
      wrongJoiner.session.firstRound,
      "00000000" === material.secret ? "99999999" : "00000000",
      CIPHERMAN_PAIRING_PAKE_SUITES,
      NOW,
    );
    expect(() => wrongJoiner.session.finish(wrongIssuer.responseRound)).toThrow(/confirmation failed/);
    expect(() => wrongJoiner.session.finish(wrongIssuer.responseRound)).toThrow(/complete or failed/);

    const downgradeJoiner = await PakeJoinerSession.start(
      material.offer,
      joiner.identity,
      material.secret,
      CIPHERMAN_PAIRING_PAKE_SUITES,
      NOW,
    );
    const downgradedOffer: PairingOffer = { ...material.offer, protocolVersion: "0" };
    const downgradeIssuer = await PakeIssuerSession.respond(
      downgradedOffer,
      downgradeJoiner.join,
      downgradeJoiner.session.firstRound,
      material.secret,
      CIPHERMAN_PAIRING_PAKE_SUITES,
      NOW,
    );
    expect(() => downgradeJoiner.session.finish(downgradeIssuer.responseRound)).toThrow(/confirmation failed/);
    await expect(
      PakeIssuerSession.respond(
        material.offer,
        joined.join,
        { ...joined.session.firstRound, round: 2 },
        material.secret,
        CIPHERMAN_PAIRING_PAKE_SUITES,
        NOW,
      ),
    ).rejects.toThrow(/round 1/);
  });

  it("charges every PAKE oracle response before sending it and permits only admitted commits", async () => {
    expect("PakeJoinerSession" in publicMesh).toBe(false);
    expect("SHORT_PAKE_SUITE" in publicMesh).toBe(false);
    expect("PakeIssuerSession" in publicPairing).toBe(false);
    expect(publicPairing.PairingPakeSuiteRegistry).toBeDefined();
    const issuer = await device("anchor");
    const joiner = await device("executor");
    const { projection: genesis } = trustGenesis(issuer);
    const store = new TestAuthority(genesis);
    const offers = new InMemoryPairingOfferRepository();
    const coordinator = new PairingCommitCoordinator(
      store,
      offers,
      CIPHERMAN_PAIRING_PAKE_SUITES,
    );
    const material = offers.issueShortCode({
      homeId: genesis.homeId,
      issuer: issuer.identity,
      protocolVersion: "1",
      now: NOW,
    });

    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      const attemptNow = ATTEMPT_TIMES[ordinal - 1]!;
      const wrong = await PakeJoinerSession.start(
        material.offer,
        joiner.identity,
        material.secret === "00000000" ? "99999999" : "00000000",
        CIPHERMAN_PAIRING_PAKE_SUITES,
        attemptNow,
      );
      const admitted = await coordinator.beginShortCodeAttempt({
        current: genesis,
        offer: material.offer,
        join: wrong.join,
        joinerRound: wrong.session.firstRound,
        issuerIdentity: issuer.identity,
        now: attemptNow,
      });
      expect(admitted.attempt.ordinal).toBe(ordinal);
      expect(store.attemptCount(material.offer.offerId)).toBe(ordinal);
      expect(() => wrong.session.finish(admitted.session.responseRound)).toThrow(/confirmation failed/);
      if (ordinal === 1) {
        await expect(
          admitted.session.finish({
            v: 1,
            offerId: material.offer.offerId,
            round: 3,
            from: "joiner",
            payload: Buffer.alloc(32).toString("base64url"),
          }),
        ).rejects.toThrow(/confirmation failed/);
        await expect(
          admitted.session.finish({
            v: 1,
            offerId: material.offer.offerId,
            round: 3,
            from: "joiner",
            payload: Buffer.alloc(32).toString("base64url"),
          }),
        ).rejects.toThrow(/complete or failed/);
        expect(store.lastAttemptStatus(material.offer.offerId)).toBe("failed");
      }
    }

    const exhausted = await PakeJoinerSession.start(
      material.offer,
      joiner.identity,
      material.secret,
      CIPHERMAN_PAIRING_PAKE_SUITES,
      NOW,
    );
    await expect(
      coordinator.beginShortCodeAttempt({
        current: genesis,
        offer: material.offer,
        join: exhausted.join,
        joinerRound: exhausted.session.firstRound,
        issuerIdentity: issuer.identity,
        now: NOW + 1_750,
      }),
    ).rejects.toThrow(/attempts are exhausted/);

    const valid = offers.issueShortCode({
      homeId: genesis.homeId,
      issuer: issuer.identity,
      protocolVersion: "1",
      now: NOW,
    });
    const joined = await PakeJoinerSession.start(
      valid.offer,
      joiner.identity,
      valid.secret,
      CIPHERMAN_PAIRING_PAKE_SUITES,
      NOW,
    );
    const admitted = await coordinator.beginShortCodeAttempt({
      current: genesis,
      offer: valid.offer,
      join: joined.join,
      joinerRound: joined.session.firstRound,
      issuerIdentity: issuer.identity,
      now: NOW,
    });
    const finalRound = joined.session.finish(admitted.session.responseRound);
    const sessionKey = await admitted.session.finish(finalRound);
    await expect(admitted.session.finish(structuredClone(finalRound))).resolves.toEqual(sessionKey);
    expect(store.lastAttemptStatus(valid.offer.offerId)).toBe("started");
    const prepared = preparePakePairing(
      genesis,
      valid.offer,
      joined.join,
      [joined.session.firstRound, admitted.session.responseRound, finalRound],
      sessionKey,
      issuer,
      joiner,
    );
    await expect(
      coordinator.commit({ ...prepared, attempt: admitted.attempt, sessionKey, now: NOW }),
    ).resolves.toMatchObject({ chainHead: prepared.acceptance.chainHead });
  });

  it("binds pairing to the current issuer and rejects non-canonical acceptance time", async () => {
    const issuer = await device("anchor");
    const rogue = await device("rogue");
    const joiner = await device("executor");
    const { projection: genesis } = trustGenesis(issuer);
    const store = new TestAuthority(genesis);
    const offers = new InMemoryPairingOfferRepository();
    const coordinator = new PairingCommitCoordinator(store, offers);
    const material = offers.issueQr({
      homeId: genesis.homeId,
      issuer: issuer.identity,
      protocolVersion: "1",
      now: NOW,
    });
    const prepared = prepareQrPairing(genesis, material.offer, material.secret, issuer, joiner);
    await expect(
      coordinator.beginQrAttempt({
        current: genesis,
        offer: material.offer,
        issuerIdentity: rogue.identity,
        now: NOW,
      }),
    ).rejects.toThrow(/current trust issuer/);
    await expect(
      coordinator.beginQrAttempt({
        current: genesis,
        offer: material.offer,
        issuerIdentity: { ...rogue.identity, deviceId: issuer.identity.deviceId },
        now: NOW,
      }),
    ).rejects.toThrow(/current trust issuer/);
    expect(store.attemptCount(material.offer.offerId)).toBe(0);

    const invalidBody = { ...prepared.acceptance, acceptedAt: "not-a-time" };
    const { finished: _finished, ...unsigned } = invalidBody;
    const invalidAcceptance: PairingAcceptance = {
      ...unsigned,
      finished: assemblePairingFinished({
        method: "qr-secret",
        issuer: createPairingAcceptanceProof({
          acceptance: unsigned,
          role: "issuer",
          signer: issuer.key,
          method: "qr-secret",
        }),
        joiner: createPairingAcceptanceProof({
          acceptance: unsigned,
          role: "joiner",
          signer: joiner.key,
          method: "qr-secret",
        }),
      }),
    };
    expect(() =>
      verifyPairingAcceptance({
        acceptance: invalidAcceptance,
        offer: material.offer,
        issuer: issuer.identity,
        joiner: joiner.identity,
      }),
    ).toThrow(/canonical ISO/);
  });
});

describe("trust chain", () => {
  it("replays revocation, issuer transition, recovery rotation and reset with their authority guards", async () => {
    const anchor = await device("anchor");
    const second = await device("second");
    const { event: genesisEvent, projection: genesis } = trustGenesis(anchor);
    const enroll = createSignedTrustEvent({
      current: genesis,
      body: {
        t: "enroll",
        device: second.identity,
        roles: ["anchor"],
        pairingTranscriptDigest: "sha256:pairing",
      },
      at: AT,
      signer: anchor.key,
    });
    const enrolled = applyTrustEvent(genesis, enroll);
    const root1 = RecoveryRoot.generate();
    const establish = createRecoveryRootEvent({
      current: enrolled,
      op: "establish",
      candidate: root1,
      outerSigner: anchor.key,
      at: AT,
    });
    const established = applyTrustEvent(enrolled, establish);
    const root2 = RecoveryRoot.generate();
    const issuerForgedRotate = createRecoveryRootEvent({
      current: established,
      op: "rotate",
      candidate: root2,
      outerSigner: anchor.key,
      at: AT,
    });
    expect(() => applyTrustEvent(established, issuerForgedRotate)).toThrow(/signature/);

    const rotate = createRecoveryRootEvent({
      current: established,
      op: "rotate",
      candidate: root2,
      outerSigner: root1,
      at: AT,
    });
    const rotated = applyTrustEvent(established, rotate);
    expect(rotated.recoveryRootPublicKey).toBe(root2.rootPublicKey);
    const staleRootInvalidate = createSignedTrustEvent({
      current: rotated,
      body: { t: "recovery-root", op: "invalidate", signedBy: "recovery-root" },
      at: AT,
      signer: root1,
    });
    expect(() => applyTrustEvent(rotated, staleRootInvalidate)).toThrow(/signature/);

    const unknownEvent = createSignedTrustEvent({
      current: rotated,
      body: { t: "future-trust-event" } as unknown as HomeTrustEventBody,
      at: AT,
      signer: anchor.key,
    });
    expect(() => applyTrustEvent(rotated, unknownEvent)).toThrow(/type is unsupported/);

    const invalidRole = createSignedTrustEvent({
      current: rotated,
      body: {
        t: "role-change",
        deviceId: second.key.deviceId,
        roles: ["administrator"],
      } as unknown as HomeTrustEventBody,
      at: AT,
      signer: anchor.key,
    });
    expect(() => applyTrustEvent(rotated, invalidRole)).toThrow(/roles/);

    const unknownRootOperation = createSignedTrustEvent({
      current: rotated,
      body: {
        t: "recovery-root",
        op: "replace",
        signedBy: "recovery-root",
      } as unknown as HomeTrustEventBody,
      at: AT,
      signer: root2,
    });
    expect(() => applyTrustEvent(rotated, unknownRootOperation)).toThrow(/operation is unsupported/);

    const demoteIssuer = createSignedTrustEvent({
      current: rotated,
      body: { t: "role-change", deviceId: anchor.key.deviceId, roles: ["executor"] },
      at: AT,
      signer: anchor.key,
    });
    expect(() => applyTrustEvent(rotated, demoteIssuer)).toThrow(/retain the anchor role/);

    const mismatchedAuthority = createSignedTrustEvent({
      current: rotated,
      body: {
        t: "issuer-transition",
        nextTrustEpoch: 2,
        fromIssuerKeyId: anchor.key.deviceId,
        toIssuerKeyId: second.key.deviceId,
        toDeviceId: second.key.deviceId,
        reason: "migration",
        signedBy: "recovery-root",
      } as unknown as HomeTrustEventBody,
      at: AT,
      signer: root2,
    });
    expect(() => applyTrustEvent(rotated, mismatchedAuthority)).toThrow(/signing authority/);

    const unknownTransitionReason = createSignedTrustEvent({
      current: rotated,
      body: {
        t: "issuer-transition",
        nextTrustEpoch: 2,
        fromIssuerKeyId: anchor.key.deviceId,
        toIssuerKeyId: second.key.deviceId,
        toDeviceId: second.key.deviceId,
        reason: "emergency",
        signedBy: "issuer",
      } as unknown as HomeTrustEventBody,
      at: AT,
      signer: anchor.key,
    });
    expect(() => applyTrustEvent(rotated, unknownTransitionReason)).toThrow(/signing authority/);

    const demoteTarget = createSignedTrustEvent({
      current: rotated,
      body: { t: "role-change", deviceId: second.key.deviceId, roles: ["executor"] },
      at: AT,
      signer: anchor.key,
    });
    const targetWithoutAnchorRole = applyTrustEvent(rotated, demoteTarget);
    const invalidTarget = createSignedTrustEvent({
      current: targetWithoutAnchorRole,
      body: {
        t: "issuer-transition",
        nextTrustEpoch: 2,
        fromIssuerKeyId: anchor.key.deviceId,
        toIssuerKeyId: second.key.deviceId,
        toDeviceId: second.key.deviceId,
        reason: "migration",
        signedBy: "issuer",
      },
      at: AT,
      signer: anchor.key,
    });
    expect(() => applyTrustEvent(targetWithoutAnchorRole, invalidTarget)).toThrow(/target is invalid/);

    const disasterRecoveryTransition = createSignedTrustEvent({
      current: rotated,
      body: {
        t: "issuer-transition",
        nextTrustEpoch: 2,
        fromIssuerKeyId: anchor.key.deviceId,
        toIssuerKeyId: second.key.deviceId,
        toDeviceId: second.key.deviceId,
        reason: "disaster-recovery",
        signedBy: "recovery-root",
      },
      at: AT,
      signer: root2,
    });
    expect(applyTrustEvent(rotated, disasterRecoveryTransition).issuer.deviceId).toBe(
      second.key.deviceId,
    );

    const transition = createSignedTrustEvent({
      current: rotated,
      body: {
        t: "issuer-transition",
        nextTrustEpoch: 2,
        fromIssuerKeyId: anchor.key.deviceId,
        toIssuerKeyId: second.key.deviceId,
        toDeviceId: second.key.deviceId,
        reason: "migration",
        signedBy: "issuer",
      },
      at: AT,
      signer: anchor.key,
    });
    const transitioned = applyTrustEvent(rotated, transition);
    const reset = createDomainResetEvent({
      current: transitioned,
      issuer: second.key,
      coSigner: anchor.key,
      at: AT,
    });
    const resetProjection = applyTrustEvent(transitioned, reset);
    expect(resetProjection.trustEpoch).toBe(3);
    expect(resetProjection.recoveryRootPublicKey).toBeUndefined();
    expect(
      resetProjection.members.find((member) => member.device.deviceId === anchor.key.deviceId)?.state,
    ).toBe("pending-reenroll");
    const root3 = RecoveryRoot.generate();
    const reestablish = createRecoveryRootEvent({
      current: resetProjection,
      op: "establish",
      candidate: root3,
      outerSigner: second.key,
      at: AT,
    });
    const resetPlan: RecoveryActivationPlan = {
      v: 1,
      kind: "domain-reset-establish",
      resetEvent: reset,
      rootEvent: reestablish,
    };
    const replanned = validateRecoveryActivationPlan(transitioned, resetPlan);
    const reenroll = createSignedTrustEvent({
      current: replanned,
      body: { t: "reenroll", deviceId: anchor.key.deviceId, pairingTranscriptDigest: "sha256:reenroll" },
      at: AT,
      signer: second.key,
    });
    const rejoined = applyTrustEvent(replanned, reenroll);
    const revoke = createSignedTrustEvent({
      current: rejoined,
      body: { t: "revoke", deviceId: anchor.key.deviceId, reason: "removed" },
      at: AT,
      signer: second.key,
    });
    const revoked = applyTrustEvent(rejoined, revoke);
    expect(revoked.members.find((member) => member.device.deviceId === anchor.key.deviceId)?.state).toBe("revoked");
    expect(
      replayTrustChain(
        [genesisEvent, enroll, establish, rotate, transition, reset, reestablish, reenroll, revoke],
      ),
    ).toEqual(revoked);
    const record = buildHomeTrustRecord(revoked, second.key);
    expect(record.recoveryRootPublicKey).toBe(root3.rootPublicKey);
    expect(() => verifyHomeTrustRecord(record, revoked)).not.toThrow();
    expect(() =>
      verifyHomeTrustRecord(
        { ...record, trustEpoch: record.trustEpoch + 1 },
        revoked,
      ),
    ).toThrow(/signature/);
  });

  it("requires a signed genesis event as the replayable root of trust", async () => {
    const anchor = await device("anchor");
    const { event, projection } = trustGenesis(anchor);
    expect(replayTrustChain([event])).toEqual(projection);
    expect(projection.chainHead.eventDigest).toBe(homeTrustEventDigest(event));
    expect(() => initializeTrustChain({ ...event, homeId: "another-home" })).toThrow();
    expect(() => replayTrustChain([])).toThrow(/empty/);
  });
});

describe("root activation checkpoint", () => {
  it("keeps mesh disabled until independent read-back, real decryption and atomic activation complete", async () => {
    const issuer = await device("anchor");
    const { projection: genesis } = trustGenesis(issuer);
    const root = RecoveryRoot.generate();
    const prepared = prepareActivation(genesis, issuer, root);
    const store = new TestAuthority(genesis);
    const target = new MemoryTarget("backup-device", "device:backup");
    const steps: string[] = [];
    const activated = await new RecoveryActivationCoordinator(store).activatePrepared({
      current: genesis,
      plan: prepared.plan,
      checkpoint: prepared.checkpoint,
      candidateRoot: root,
      issuerIdentity: issuer.identity,
      target,
      sourceIndependenceDomain: "device:anchor",
      verifiedAt: AT,
      onStep: (step) => {
        steps.push(step);
      },
    });

    expect(steps).toEqual(["created", "replicated", "read-back", "verified", "committed"]);
    expect(activated.recoveryRootPublicKey).toBe(root.rootPublicKey);
    expect(store.projection).toEqual(activated);
    expect(
      projectRecoveryReadiness({ trust: activated, verifiedRecords: store.verifiedRecords }),
    ).toMatchObject({ ready: true, targetId: target.targetId });
    const validRecord = store.verifiedRecords[0]!;
    const wrongPurpose = {
      kind: "root-activation" as const,
      activationDigest: "sha256:another-activation",
    };
    const wrongActivation = {
      ...validRecord,
      purpose: wrongPurpose,
      verification: { ...validRecord.verification, purpose: wrongPurpose },
    };
    expect(
      projectRecoveryReadiness({ trust: activated, verifiedRecords: [wrongActivation] }).ready,
    ).toBe(false);
    const forgedVerification = {
      ...validRecord,
      verification: {
        ...validRecord.verification,
        signature: {
          ...validRecord.verification.signature,
          sig: Buffer.alloc(64).toString("base64url"),
        },
      },
    };
    expect(
      projectRecoveryReadiness({ trust: activated, verifiedRecords: [forgedVerification] }).ready,
    ).toBe(false);
    const opened = openRootActivationCheckpoint({
      package: await target.read(prepared.checkpoint.envelope.checkpointId),
      recoveryRoot: root,
      issuer: issuer.identity,
    });
    expect(opened.plaintextChunks).toEqual([Buffer.from("bootstrap-state")]);
    const created = store.records.find(
      (record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> =>
        record.t === "checkpoint-created",
    )!;
    await expect(store.appendCheckpoint(structuredClone(created))).resolves.toBeUndefined();
    await expect(
      store.appendCheckpoint({ ...created, envelopeDigest: "sha256:conflict" }),
    ).rejects.toThrow(/identity conflict/);
  });

  it("accepts checkpoint envelopes only from the current issuer", async () => {
    const issuer = await device("anchor");
    const rogue = await device("rogue");
    const { projection: genesis } = trustGenesis(issuer);
    const root = RecoveryRoot.generate();
    const rootEvent = createRecoveryRootEvent({
      current: genesis,
      op: "establish",
      candidate: root,
      outerSigner: issuer.key,
      at: AT,
    });
    const plan: RecoveryActivationPlan = { v: 1, kind: "establish", rootEvent };
    const checkpoint = createRootActivationCheckpoint({
      checkpointId: "01J00000000000000000000009",
      createdAt: AT,
      plan,
      recoveryRoot: root,
      issuer: rogue.key,
      scope: ["trust"],
      domainRevisions: { trust: 0 },
      upToLsn: 0,
      plaintextChunks: [Buffer.from("bootstrap-state")],
    });
    const store = new TestAuthority(genesis);
    await expect(
      new RecoveryActivationCoordinator(store).activatePrepared({
        current: genesis,
        plan,
        checkpoint,
        candidateRoot: root,
        issuerIdentity: rogue.identity,
        target: new MemoryTarget("backup", "device:backup"),
        sourceIndependenceDomain: "device:anchor",
        verifiedAt: AT,
      }),
    ).rejects.toThrow(/current trust issuer/);
    expect(store.records).toHaveLength(0);
  });

  it("atomically rotates and domain-resets roots with their matching checkpoint plans", async () => {
    const issuer = await device("anchor");
    const second = await device("second-anchor");
    const { projection: genesis } = trustGenesis(issuer);
    const enroll = createSignedTrustEvent({
      current: genesis,
      body: {
        t: "enroll",
        device: second.identity,
        roles: ["anchor"],
        pairingTranscriptDigest: "sha256:second-anchor",
      },
      at: AT,
      signer: issuer.key,
    });
    const enrolled = applyTrustEvent(genesis, enroll);
    const root1 = RecoveryRoot.generate();
    const first = prepareActivation(enrolled, issuer, root1);
    const store = new TestAuthority(enrolled);
    const target = new MemoryTarget("backup", "device:backup");
    const established = await new RecoveryActivationCoordinator(store).activatePrepared({
      current: enrolled,
      plan: first.plan,
      checkpoint: first.checkpoint,
      candidateRoot: root1,
      issuerIdentity: issuer.identity,
      target,
      sourceIndependenceDomain: "device:anchor",
      verifiedAt: AT,
    });

    const root2 = RecoveryRoot.generate();
    const rotateEvent = createRecoveryRootEvent({
      current: established,
      op: "rotate",
      candidate: root2,
      outerSigner: root1,
      at: AT,
    });
    const rotatePlan: RecoveryActivationPlan = { v: 1, kind: "rotate", rootEvent: rotateEvent };
    const rotateCheckpoint = createRootActivationCheckpoint({
      checkpointId: "01J00000000000000000000010",
      createdAt: AT,
      plan: rotatePlan,
      recoveryRoot: root2,
      issuer: issuer.key,
      scope: ["trust"],
      domainRevisions: { trust: established.chainHead.seq },
      upToLsn: established.chainHead.seq,
      plaintextChunks: [Buffer.from("rotated-state")],
    });
    const rotated = await new RecoveryActivationCoordinator(store).activatePrepared({
      current: established,
      plan: rotatePlan,
      checkpoint: rotateCheckpoint,
      candidateRoot: root2,
      issuerIdentity: issuer.identity,
      target,
      sourceIndependenceDomain: "device:anchor",
      verifiedAt: AT,
      supersedeCheckpointIds: [first.checkpoint.envelope.checkpointId],
    });
    expect(rotated.recoveryRootPublicKey).toBe(root2.rootPublicKey);

    const resetEvent = createDomainResetEvent({
      current: rotated,
      issuer: issuer.key,
      coSigner: second.key,
      at: AT,
    });
    const resetProjection = applyTrustEvent(rotated, resetEvent);
    const root3 = RecoveryRoot.generate();
    const rootEvent = createRecoveryRootEvent({
      current: resetProjection,
      op: "establish",
      candidate: root3,
      outerSigner: issuer.key,
      at: AT,
    });
    const resetPlan: RecoveryActivationPlan = {
      v: 1,
      kind: "domain-reset-establish",
      resetEvent,
      rootEvent,
    };
    const resetCheckpoint = createRootActivationCheckpoint({
      checkpointId: "01J00000000000000000000011",
      createdAt: AT,
      plan: resetPlan,
      recoveryRoot: root3,
      issuer: issuer.key,
      scope: ["trust"],
      domainRevisions: { trust: rotated.chainHead.seq },
      upToLsn: rotated.chainHead.seq,
      plaintextChunks: [Buffer.from("reset-state")],
    });
    const reset = await new RecoveryActivationCoordinator(store).activatePrepared({
      current: rotated,
      plan: resetPlan,
      checkpoint: resetCheckpoint,
      candidateRoot: root3,
      issuerIdentity: issuer.identity,
      target,
      sourceIndependenceDomain: "device:anchor",
      verifiedAt: AT,
      supersedeCheckpointIds: [rotateCheckpoint.envelope.checkpointId],
    });
    expect(reset.recoveryRootPublicKey).toBe(root3.rootPublicKey);
    expect(
      reset.members.find((member) => member.device.deviceId === second.key.deviceId)?.state,
    ).toBe("pending-reenroll");
    expect(projectRecoveryReadiness({ trust: reset, verifiedRecords: store.verifiedRecords }).ready).toBe(
      true,
    );
  });

  it("leaves trust unchanged at every pre-commit crash point and resumes the same candidate", async () => {
    const issuer = await device("anchor");
    const { projection: genesis } = trustGenesis(issuer);
    const root = RecoveryRoot.generate();
    const prepared = prepareActivation(genesis, issuer, root);
    expect(() =>
      createRootActivationCheckpoint({
        checkpointId: "01J00000000000000000000001",
        createdAt: AT,
        plan: prepared.plan,
        recoveryRoot: RecoveryRoot.generate(),
        issuer: issuer.key,
        scope: ["trust"],
        domainRevisions: { trust: 0 },
        upToLsn: 0,
        plaintextChunks: [Buffer.from("wrong-root")],
      }),
    ).toThrow(/recipient root/);
    const store = new TestAuthority(genesis);
    const target = new MemoryTarget("backup-device", "device:backup");
    const coordinator = new RecoveryActivationCoordinator(store);

    await expect(
      coordinator.activatePrepared({
        current: genesis,
        plan: prepared.plan,
        checkpoint: prepared.checkpoint,
        candidateRoot: root,
        issuerIdentity: issuer.identity,
        target,
        sourceIndependenceDomain: "device:anchor",
        verifiedAt: AT,
        onStep: (step) => {
          if (step === "replicated") throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow(/simulated crash/);
    expect(store.projection).toEqual(genesis);
    expect(projectRecoveryReadiness({ trust: store.projection, verifiedRecords: store.verifiedRecords }).ready).toBe(false);

    const created = store.records.find(
      (record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> =>
        record.t === "checkpoint-created",
    );
    expect(created).toBeDefined();
    const durableCheckpoint = await store.loadCheckpointPackage(created!.envelopeRef);
    expect(durableCheckpoint).toBeDefined();
    const resumed = await new RecoveryActivationCoordinator(store).activatePrepared({
      current: genesis,
      plan: prepared.plan,
      checkpoint: durableCheckpoint!,
      candidateRoot: root,
      issuerIdentity: issuer.identity,
      target,
      sourceIndependenceDomain: "device:anchor",
      verifiedAt: AT,
    });
    expect(resumed.recoveryRootPublicKey).toBe(root.rootPublicKey);
  });

  it.each(["created", "replicated", "read-back", "verified"] as const)(
    "does not activate trust when the process crashes after %s",
    async (crashAt) => {
      const issuer = await device("anchor");
      const { projection: genesis } = trustGenesis(issuer);
      const root = RecoveryRoot.generate();
      const prepared = prepareActivation(genesis, issuer, root);
      const store = new TestAuthority(genesis);
      const target = new MemoryTarget("backup-device", "device:backup");
      await expect(
        new RecoveryActivationCoordinator(store).activatePrepared({
          current: genesis,
          plan: prepared.plan,
          checkpoint: prepared.checkpoint,
          candidateRoot: root,
          issuerIdentity: issuer.identity,
          target,
          sourceIndependenceDomain: "device:anchor",
          verifiedAt: AT,
          onStep: (step) => {
            if (step === crashAt) throw new Error(`crash after ${step}`);
          },
        }),
      ).rejects.toThrow(/crash after/);
      expect(store.projection).toEqual(genesis);
      expect(store.verifiedRecords).toHaveLength(0);
    },
  );

  it("replays the committed result after the final response is lost", async () => {
    const issuer = await device("anchor");
    const { projection: genesis } = trustGenesis(issuer);
    const root = RecoveryRoot.generate();
    const prepared = prepareActivation(genesis, issuer, root);
    const store = new TestAuthority(genesis);
    const target = new MemoryTarget("backup", "device:backup");
    const input = {
      current: genesis,
      plan: prepared.plan,
      checkpoint: prepared.checkpoint,
      candidateRoot: root,
      issuerIdentity: issuer.identity,
      target,
      sourceIndependenceDomain: "device:anchor",
      verifiedAt: AT,
    };
    await expect(
      new RecoveryActivationCoordinator(store).activatePrepared({
        ...input,
        onStep: (step) => {
          if (step === "committed") throw new Error("response lost");
        },
      }),
    ).rejects.toThrow(/response lost/);
    expect(store.projection.recoveryRootPublicKey).toBe(root.rootPublicKey);
    const recordCount = store.records.length;
    await expect(
      new RecoveryActivationCoordinator(store).activatePrepared({
        ...input,
        current: store.projection,
      }),
    ).resolves.toEqual(store.projection);
    expect(store.records).toHaveLength(recordCount);
  });

  it("resumes when the independent target loses its acknowledgement after durable storage", async () => {
    const issuer = await device("anchor");
    const { projection: genesis } = trustGenesis(issuer);
    const root = RecoveryRoot.generate();
    const prepared = prepareActivation(genesis, issuer, root);
    const store = new TestAuthority(genesis);
    const target = new MemoryTarget("backup", "device:backup", false, true);
    const input = {
      current: genesis,
      plan: prepared.plan,
      checkpoint: prepared.checkpoint,
      candidateRoot: root,
      issuerIdentity: issuer.identity,
      target,
      sourceIndependenceDomain: "device:anchor",
      verifiedAt: AT,
    };
    await expect(
      new RecoveryActivationCoordinator(store).activatePrepared(input),
    ).rejects.toThrow(/write acknowledgement lost/);
    expect(store.projection).toEqual(genesis);
    expect(store.records.map((record) => record.t)).toEqual(["checkpoint-created"]);
    await expect(
      new RecoveryActivationCoordinator(store).activatePrepared(input),
    ).resolves.toMatchObject({ recoveryRootPublicKey: root.rootPublicKey });
  });

  it("rejects same-domain copies and tampered replicated chunks without activating trust", async () => {
    const issuer = await device("anchor");
    const { projection: genesis } = trustGenesis(issuer);
    const root = RecoveryRoot.generate();
    const prepared = prepareActivation(genesis, issuer, root);
    const store = new TestAuthority(genesis);
    const sameDomain = new MemoryTarget("local-copy", "device:anchor");
    await expect(
      new RecoveryActivationCoordinator(store).activatePrepared({
        current: genesis,
        plan: prepared.plan,
        checkpoint: prepared.checkpoint,
        candidateRoot: root,
        issuerIdentity: issuer.identity,
        target: sameDomain,
        sourceIndependenceDomain: "device:anchor",
        verifiedAt: AT,
      }),
    ).rejects.toThrow(/not independent/);

    const tampered = new MemoryTarget("backup", "device:backup", true);
    await expect(
      new RecoveryActivationCoordinator(store).activatePrepared({
        current: genesis,
        plan: prepared.plan,
        checkpoint: prepared.checkpoint,
        candidateRoot: root,
        issuerIdentity: issuer.identity,
        target: tampered,
        sourceIndependenceDomain: "device:anchor",
        verifiedAt: AT,
      }),
    ).rejects.toThrow(/chunk content/);
    expect(store.projection).toEqual(genesis);
    expect(store.records.some((record) => record.t === "checkpoint-verify-failed")).toBe(true);
  });
});

function prepareQrPairing(
  current: TrustProjection,
  offer: PairingOffer,
  secret: string,
  issuer: TestDevice,
  joiner: TestDevice,
  acceptedAt = AT,
  joinOverride?: Extract<PairingJoin, { method: "qr-secret" }>,
) {
  const join = joinOverride ?? createQrPairingJoin(offer, joiner.identity, secret);
  if (!joinOverride) verifyQrPairingJoin(offer, join, secret, NOW);
  const transcriptDigest = pairingTranscriptDigest(offer, join, []);
  const trustEvent = createSignedTrustEvent({
    current,
    body: { t: "enroll", device: joiner.identity, roles: ["executor"], pairingTranscriptDigest: transcriptDigest },
    at: acceptedAt,
    signer: issuer.key,
  });
  const next = applyTrustEvent(current, trustEvent);
  const acceptanceBody: Omit<PairingAcceptance, "finished"> = {
    v: 1,
    offerId: offer.offerId,
    transcriptDigest,
    chainHead: { ...next.chainHead },
    acceptedAt,
  };
  const finished = assemblePairingFinished({
    method: "qr-secret",
    issuer: createPairingAcceptanceProof({ acceptance: acceptanceBody, role: "issuer", signer: issuer.key, method: "qr-secret" }),
    joiner: createPairingAcceptanceProof({ acceptance: acceptanceBody, role: "joiner", signer: joiner.key, method: "qr-secret" }),
  });
  const acceptance = { ...acceptanceBody, finished };
  verifyPairingAcceptance({ acceptance, offer, issuer: issuer.identity, joiner: joiner.identity });
  return {
    current,
    offer,
    join,
    pakeRounds: [] as PakeRound[],
    acceptance,
    trustEvent,
    issuerIdentity: issuer.identity,
  };
}

function preparePakePairing(
  current: TrustProjection,
  offer: PairingOffer,
  join: Extract<PairingJoin, { method: "short-pake" }>,
  pakeRounds: PakeRound[],
  sessionKey: Uint8Array,
  issuer: TestDevice,
  joiner: TestDevice,
) {
  const transcriptDigest = pairingTranscriptDigest(offer, join, pakeRounds);
  const trustEvent = createSignedTrustEvent({
    current,
    body: {
      t: "enroll",
      device: joiner.identity,
      roles: ["executor"],
      pairingTranscriptDigest: transcriptDigest,
    },
    at: AT,
    signer: issuer.key,
  });
  const next = applyTrustEvent(current, trustEvent);
  const acceptanceBody: Omit<PairingAcceptance, "finished"> = {
    v: 1,
    offerId: offer.offerId,
    transcriptDigest,
    chainHead: { ...next.chainHead },
    acceptedAt: AT,
  };
  return {
    current,
    offer,
    join,
    pakeRounds,
    acceptance: {
      ...acceptanceBody,
      finished: assemblePairingFinished({
        method: "short-pake",
        issuer: createPairingAcceptanceProof({
          acceptance: acceptanceBody,
          role: "issuer",
          signer: issuer.key,
          method: "short-pake",
          sessionKey,
        }),
        joiner: createPairingAcceptanceProof({
          acceptance: acceptanceBody,
          role: "joiner",
          signer: joiner.key,
          method: "short-pake",
          sessionKey,
        }),
      }),
    },
    trustEvent,
    issuerIdentity: issuer.identity,
  };
}

function prepareActivation(current: TrustProjection, issuer: TestDevice, root: RecoveryRoot) {
  const rootEvent = createRecoveryRootEvent({
    current,
    op: "establish",
    candidate: root,
    outerSigner: issuer.key,
    at: AT,
  });
  const plan: RecoveryActivationPlan = { v: 1, kind: "establish", rootEvent };
  expect(validateRecoveryActivationPlan(current, plan).recoveryRootPublicKey).toBe(root.rootPublicKey);
  const checkpoint = createRootActivationCheckpoint({
    checkpointId: "01J00000000000000000000000",
    createdAt: AT,
    plan,
    recoveryRoot: root,
    issuer: issuer.key,
    scope: ["trust"],
    domainRevisions: { trust: current.chainHead.seq },
    upToLsn: current.chainHead.seq,
    plaintextChunks: [Buffer.from("bootstrap-state")],
  });
  return { plan, checkpoint };
}

interface TestDevice {
  key: DeviceKey;
  identity: ReturnType<typeof enrollDeviceIdentity>;
}

async function device(name: string): Promise<TestDevice> {
  const key = await DeviceKey.generate({ now: () => NOW });
  return {
    key,
    identity: enrollDeviceIdentity(key, {
      displayName: name,
      platform: "headless",
      enrolledAt: AT,
    }),
  };
}

function trustGenesis(issuer: TestDevice) {
  const event = createTrustGenesisEvent({
    homeId: "home-1",
    issuer: issuer.identity,
    signer: issuer.key,
    at: AT,
  });
  return { event, projection: initializeTrustChain(event) };
}

class MemoryTarget implements RecoveryCheckpointTarget {
  private readonly checkpoints = new Map<string, CheckpointPackage>();

  constructor(
    readonly targetId: string,
    readonly independenceDomain: string,
    private readonly tamperOnRead = false,
    private failAfterWriteOnce = false,
  ) {}

  async writeDurable(checkpoint: CheckpointPackage): Promise<void> {
    const id = checkpoint.envelope.checkpointId;
    const existing = this.checkpoints.get(id);
    if (existing && !sameCheckpointPackage(existing, checkpoint)) {
      throw new Error("checkpoint id collision");
    }
    this.checkpoints.set(id, structuredClone(checkpoint));
    if (this.failAfterWriteOnce) {
      this.failAfterWriteOnce = false;
      throw new Error("write acknowledgement lost");
    }
  }

  async read(checkpointId: string): Promise<CheckpointPackage> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error("checkpoint missing");
    }
    const copy = structuredClone(checkpoint);
    if (this.tamperOnRead) {
      const bytes = Buffer.from(copy.chunks[0]!.bytes);
      bytes[0] ^= 1;
      return { envelope: copy.envelope, chunks: [{ seq: 0, bytes }] };
    }
    return copy;
  }
}

class TestAuthority implements BootstrapAuthorityPort {
  readonly succeededOffers = new Set<string>();
  readonly records: CheckpointStreamRecord[] = [];
  readonly verifiedRecords: Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }>[] = [];
  private readonly attemptOrdinals = new Map<string, number>();
  private readonly retryNotBefore = new Map<string, number>();
  private readonly pairingAttempts = new Map<
    string,
    { admission: PairingAttemptAdmission; status: "started" | "failed" | "succeeded" }
  >();
  private readonly pairingCommits = new Map<string, PairingCommitReceipt>();
  private readonly checkpointPackages = new Map<string, CheckpointPackage>();
  private readonly recoveryActivations = new Map<string, RecoveryActivationAtomicCommit>();

  constructor(public projection: TrustProjection) {}

  async beginPairingAttempt(
    offer: PairingOffer,
    now: number,
  ): Promise<PairingAttemptDecision> {
    const offerId = offer.offerId;
    const maxAttempts = offer.attempts.max;
    const current = this.attemptOrdinals.get(offerId) ?? 0;
    if (this.succeededOffers.has(offerId) || current >= maxAttempts) {
      return {
        admitted: false,
        reason: "exhausted",
        attempts: current,
        retryAfterMs: 0,
      };
    }
    const nextAllowedAt = this.retryNotBefore.get(offerId) ?? 0;
    if (now < nextAllowedAt) {
      return {
        admitted: false,
        reason: "backoff",
        attempts: current,
        retryAfterMs: nextAllowedAt - now,
      };
    }
    const ordinal = current + 1;
    const retryDelay = Math.min(8_000, 250 * 2 ** (ordinal - 1));
    const admission: PairingAttemptAdmission = {
      offerId,
      offerDigest: pairingOfferDigest(offer),
      ordinal,
      attemptId: createUlid(NOW + this.pairingAttempts.size),
      at: new Date(now).toISOString(),
      retryNotBefore: new Date(now + retryDelay).toISOString(),
    };
    this.attemptOrdinals.set(offerId, ordinal);
    this.retryNotBefore.set(offerId, now + retryDelay);
    this.pairingAttempts.set(admission.attemptId, { admission, status: "started" });
    return { admitted: true, attempt: admission };
  }

  async failPairingAttempt(attempt: PairingAttemptAdmission): Promise<void> {
    const stored = this.pairingAttempts.get(attempt.attemptId);
    if (!stored || canonicalize(stored.admission) !== canonicalize(attempt)) {
      throw new Error("pairing attempt admission is unknown");
    }
    if (stored.status === "failed") return;
    if (stored.status !== "started") throw new Error("pairing attempt is already finalized");
    stored.status = "failed";
  }

  async loadPairingCommit(attemptId: string): Promise<PairingCommitReplay | undefined> {
    const commit = this.pairingCommits.get(attemptId);
    return commit
      ? { receipt: structuredClone(commit), trust: structuredClone(this.projection) }
      : undefined;
  }

  async commitPairing(input: PairingAtomicCommit): Promise<void> {
    await Promise.resolve();
    const receipt: PairingCommitReceipt = {
      expectedChainHead: input.expectedChainHead,
      attemptId: input.attempt.attemptId,
      offerId: input.offer.offerId,
      offerDigest: pairingOfferDigest(input.offer),
      acceptance: input.acceptance,
      trustEventDigest: homeTrustEventDigest(input.trustEvent),
      resultingChainHead: {
        seq: input.trustEvent.seq,
        eventDigest: homeTrustEventDigest(input.trustEvent),
      },
    };
    const replay = this.pairingCommits.get(input.attempt.attemptId);
    if (replay) {
      if (canonicalize(replay) !== canonicalize(receipt)) {
        throw new Error("pairing attempt commit conflict");
      }
      return;
    }
    this.assertHead(input.expectedChainHead);
    const attempt = this.pairingAttempts.get(input.attempt.attemptId);
    if (
      !attempt ||
      canonicalize(attempt.admission) !== canonicalize(input.attempt) ||
      attempt.admission.offerId !== input.offer.offerId ||
      attempt.status !== "started"
    ) {
      throw new Error("pairing attempt is not durably admitted");
    }
    if (this.succeededOffers.has(input.offer.offerId)) throw new Error("pairing offer already consumed");
    const next = applyTrustEvent(this.projection, input.trustEvent);
    this.projection = next;
    attempt.status = "succeeded";
    this.pairingCommits.set(input.attempt.attemptId, structuredClone(receipt));
    this.succeededOffers.add(input.offer.offerId);
  }

  attemptCount(offerId: string): number {
    return this.attemptOrdinals.get(offerId) ?? 0;
  }

  lastAttemptStatus(offerId: string): "started" | "failed" | "succeeded" | undefined {
    const ordinal = this.attemptOrdinals.get(offerId);
    if (!ordinal) return undefined;
    return [...this.pairingAttempts.values()].find(
      (entry) => entry.admission.offerId === offerId && entry.admission.ordinal === ordinal,
    )?.status;
  }

  async persistCheckpointPackage(checkpoint: CheckpointPackage): Promise<ArtifactRef> {
    const ref = checkpointEnvelopeArtifact(checkpoint.envelope);
    const existing = this.checkpointPackages.get(ref.digest);
    if (existing && !sameCheckpointPackage(existing, checkpoint)) {
      throw new Error("checkpoint artifact digest collision");
    }
    this.checkpointPackages.set(ref.digest, structuredClone(checkpoint));
    return ref;
  }

  async loadCheckpointPackage(envelopeRef: ArtifactRef): Promise<CheckpointPackage | undefined> {
    const checkpoint = this.checkpointPackages.get(envelopeRef.digest);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  async appendCheckpoint(record: CheckpointStreamRecord): Promise<void> {
    const duplicate = this.records.find((candidate) => canonicalize(candidate) === canonicalize(record));
    if (duplicate) return;
    const identity = checkpointRecordIdentity(record);
    const conflict = this.records.find((candidate) => checkpointRecordIdentity(candidate) === identity);
    if (conflict) throw new Error("checkpoint record identity conflict");
    this.records.push(structuredClone(record));
  }

  async loadRecoveryActivation(
    checkpointId: string,
  ): Promise<RecoveryActivationReplay | undefined> {
    const commit = this.recoveryActivations.get(checkpointId);
    return commit
      ? { commit: structuredClone(commit), trust: structuredClone(this.projection) }
      : undefined;
  }

  async commitRecoveryActivation(input: RecoveryActivationAtomicCommit): Promise<void> {
    await Promise.resolve();
    const checkpointId = input.verification.checkpointId;
    const replay = this.recoveryActivations.get(checkpointId);
    if (replay) {
      if (canonicalize(replay) !== canonicalize(input)) {
        throw new Error("recovery activation commit conflict");
      }
      return;
    }
    this.assertHead(input.expectedChainHead);
    const verification = input.verification;
    const created = this.records.find(
      (record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> =>
        record.t === "checkpoint-created" && record.checkpointId === verification.checkpointId,
    );
    const replicated = this.records.find(
      (record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-replicated" }> =>
        record.t === "checkpoint-replicated" &&
        record.checkpointId === verification.checkpointId &&
        record.targetId === verification.targetId,
    );
    if (
      !created ||
      created.recipientKeyId !== verification.recipientKeyId ||
      created.envelopeDigest !== verification.envelopeDigest ||
      !replicated ||
      replicated.recipientKeyId !== verification.recipientKeyId ||
      replicated.envelopeDigest !== verification.envelopeDigest
    ) {
      throw new Error("checkpoint activation evidence is incomplete");
    }
    const next = validateRecoveryActivationPlan(this.projection, input.plan);
    const staged = input.checkpointRecords.map((record) => structuredClone(record));
    this.projection = next;
    this.records.push(...staged);
    this.recoveryActivations.set(checkpointId, structuredClone(input));
    for (const record of staged) {
      if (record.t === "checkpoint-verified") this.verifiedRecords.push(record);
    }
  }

  private assertHead(expected: TrustProjection["chainHead"]): void {
    if (
      this.projection.chainHead.seq !== expected.seq ||
      this.projection.chainHead.eventDigest !== expected.eventDigest
    ) {
      throw new Error("trust chain changed");
    }
  }
}

function sameCheckpointPackage(left: CheckpointPackage, right: CheckpointPackage): boolean {
  return (
    canonicalize(left.envelope) === canonicalize(right.envelope) &&
    left.chunks.length === right.chunks.length &&
    left.chunks.every((chunk, index) => {
      const other = right.chunks[index];
      return other?.seq === chunk.seq && Buffer.from(other.bytes).equals(Buffer.from(chunk.bytes));
    })
  );
}

function checkpointRecordIdentity(record: CheckpointStreamRecord): string {
  switch (record.t) {
    case "checkpoint-created":
      return `${record.t}:${record.checkpointId}`;
    case "checkpoint-replicated":
    case "checkpoint-verified":
      return `${record.t}:${record.checkpointId}:${record.targetId}`;
    case "checkpoint-verify-failed":
      return `${record.t}:${canonicalize(record)}`;
    case "checkpoint-superseded":
      return `${record.t}:${record.checkpointId}`;
  }
}
