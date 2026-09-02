import { Buffer } from "node:buffer";
import type {
  ArtifactRef,
  AuthorityCatalog,
  DisasterRecoveryAbort,
  DisasterRecoveryBaseline,
  DisasterRecoveryCommand,
  HomeTrustEvent,
  LogicalRecord,
  RecoveryCheckpointVerification,
} from "@zhixing/core/contracts";
import {
  assertArtifactRef,
} from "@zhixing/core/authority";
import {
  authorityCatalogDigest,
  canonicalize,
  prepareAuthorityCatalog,
  protocolDigest,
  type ProtocolSignatureVerifier,
  validateDisasterRecoveryCommit,
  validateDisasterRecoveryAbort,
  validateDisasterRecoveryCommand,
} from "@zhixing/core/protocol";
import { replayTrustChain, verifyHomeTrustRecord } from "@zhixing/mesh/trust-chain";
import {
  verifyRecoverySignature,
} from "@zhixing/mesh/recovery-root";
import {
  ANCHOR_CANDIDATE_STREAM,
  assertTargetWideAnchorCandidateAvailable,
  emptyTargetWideAnchorCandidates,
  reduceTargetWideAnchorCandidateRecord,
  reduceTargetWideAnchorCandidates,
  targetWideAnchorCandidateClaim,
  targetWideAnchorCandidateTerminal,
  type TargetWideAnchorCandidateState,
} from "./target-wide-anchor-candidate.js";
import type { DisasterRecoveryPeerEvidence } from
  "./disaster-recovery-trust-evidence.js";
import {
  createDisasterRecoveryInstallation,
  type DisasterRecoveryInstallation,
} from "./disaster-recovery-installation.js";
import type { DisasterRecoveryJournalStorage } from "./disaster-recovery-staging.js";

const DISASTER_CANDIDATE_STREAM = "transfer:anchor-disaster-candidate";

type PrepareCommand = Extract<DisasterRecoveryCommand, { op: "prepare" }>;

export interface DisasterRecoveryVerifiedCandidate {
  readonly baseline: DisasterRecoveryBaseline;
  readonly baselineEvents: readonly HomeTrustEvent[];
  readonly reachabilityCut: readonly string[];
  readonly trustEvidence: readonly DisasterRecoveryPeerEvidence[];
  readonly trustEvidenceDigest: string;
  readonly onsiteVerification: RecoveryCheckpointVerification;
  readonly authorityRecordsRef: ArtifactRef;
  readonly catalog: AuthorityCatalog;
  readonly catalogRef: ArtifactRef;
}

export interface DisasterRecoveryInstallDecision {
  readonly installationEntries: readonly LogicalRecord<unknown>[];
  readonly installation: DisasterRecoveryInstallation;
  readonly candidateReferences: readonly ArtifactRef[];
}

export interface DisasterRecoveryCandidateState {
  readonly prepare: PrepareCommand;
  readonly verified?: DisasterRecoveryVerifiedCandidate;
  readonly installDecision?: DisasterRecoveryInstallDecision;
  readonly terminal?: "committed" | "aborted";
  readonly abort?: DisasterRecoveryAbort;
}

interface StoredDisasterRecoveryCandidateState {
  readonly prepare: PrepareCommand;
  readonly verifiedRef?: ArtifactRef;
  readonly installDecisionRef?: ArtifactRef;
  readonly terminal?: "committed" | "aborted";
  readonly abort?: DisasterRecoveryAbort;
}

type DisasterCandidateRecord =
  | {
      readonly v: 1;
      readonly t: "disaster-recovery-candidate-claimed";
      readonly prepareJson: string;
    }
  | {
      readonly v: 1;
      readonly t: "disaster-recovery-candidate-verified";
      readonly transferId: string;
      readonly verifiedRef: ArtifactRef;
    }
  | {
      readonly v: 1;
      readonly t: "disaster-recovery-candidate-install-decided";
      readonly transferId: string;
      readonly decisionRef: ArtifactRef;
    }
  | {
      readonly v: 1;
      readonly t: "disaster-recovery-candidate-terminal";
      readonly transferId: string;
      readonly terminal: "committed";
    }
  | {
      readonly v: 1;
      readonly t: "disaster-recovery-candidate-terminal";
      readonly transferId: string;
      readonly terminal: "aborted";
      readonly abort: DisasterRecoveryAbort;
    };

interface CandidateProjection {
  readonly candidates: ReadonlyMap<string, StoredDisasterRecoveryCandidateState>;
  readonly targetWide: ReadonlyMap<string, TargetWideAnchorCandidateState>;
}

export class DisasterRecoveryCandidateJournal {
  constructor(
    private readonly log: DisasterRecoveryJournalStorage,
    private readonly recoveryRootPublicKey: string,
  ) {}

  async state(transferId: string): Promise<DisasterRecoveryCandidateState | undefined> {
    const stored = (await this.#projection()).candidates.get(transferId);
    return stored ? this.#hydrateCandidate(stored) : undefined;
  }

  async states(): Promise<ReadonlyMap<string, DisasterRecoveryCandidateState>> {
    const stored = (await this.#projection()).candidates;
    const candidates = new Map<string, DisasterRecoveryCandidateState>();
    for (const [transferId, candidate] of stored) {
      candidates.set(transferId, await this.#hydrateCandidate(candidate));
    }
    return candidates;
  }

  async claim(input: PrepareCommand): Promise<DisasterRecoveryCandidateState> {
    const prepare = validatePrepare(input, this.recoveryRootPublicKey);
    const wideIdentity = disasterTargetWideIdentity(prepare);
    const stored = (await this.#transact((projection) => {
      const wide = assertTargetWideAnchorCandidateAvailable(
        projection.targetWide,
        wideIdentity,
      );
      const existing = projection.candidates.get(prepare.transferId);
      if (existing) {
        assertPrepare(existing.prepare, prepare);
        if (wide) return { kind: "return", value: existing };
        return {
          kind: "append",
          entries: [{
            stream: ANCHOR_CANDIDATE_STREAM,
            body: targetWideAnchorCandidateClaim(wideIdentity),
          }],
          value: existing,
        };
      }
      return {
        kind: "append",
        entries: [
          {
            stream: ANCHOR_CANDIDATE_STREAM,
            body: targetWideAnchorCandidateClaim(wideIdentity),
          },
          {
            stream: DISASTER_CANDIDATE_STREAM,
            body: {
              v: 1,
              t: "disaster-recovery-candidate-claimed",
              prepareJson: canonicalize(prepare),
            } satisfies DisasterCandidateRecord,
          },
        ],
        value: { prepare },
      };
    })).value;
    return this.#hydrateCandidate(stored);
  }

  async recordVerified(
    transferId: string,
    input: DisasterRecoveryVerifiedCandidate,
  ): Promise<DisasterRecoveryCandidateState> {
    const current = await this.state(transferId);
    if (!current) throw new Error("Disaster verification has no durable candidate claim");
    const verified = validateVerifiedCandidate(
      current.prepare,
      input,
      this.recoveryRootPublicKey,
    );
    if (current.verified) {
      if (canonicalize(current.verified) !== canonicalize(verified)) {
        throw new Error("Disaster candidate verification conflicts with replay");
      }
      return current;
    }
    if (current.terminal !== undefined) {
      throw new Error("Terminal disaster candidate cannot gain verification");
    }
    const verifiedRef = await this.log.artifactStore.put(
      Buffer.from(canonicalize(verified), "utf8"),
    );
    const stored = (await this.#transact((projection) => {
      const existing = projection.candidates.get(transferId);
      if (!existing) throw new Error("Disaster verification has no durable candidate claim");
      if (existing.verifiedRef) {
        if (canonicalize(existing.verifiedRef) !== canonicalize(verifiedRef)) {
          throw new Error("Disaster candidate verification conflicts with replay");
        }
        return { kind: "return", value: existing };
      }
      if (existing.terminal !== undefined) {
        throw new Error("Terminal disaster candidate cannot gain verification");
      }
      return {
        kind: "append",
        entries: [{
          stream: DISASTER_CANDIDATE_STREAM,
          body: {
            v: 1,
            t: "disaster-recovery-candidate-verified",
            transferId,
            verifiedRef,
          } satisfies DisasterCandidateRecord,
        }],
        value: { ...existing, verifiedRef },
      };
    }, [verifiedRef])).value;
    return this.#hydrateCandidate(stored);
  }

  async decideInstall(
    transferId: string,
    input: DisasterRecoveryInstallDecision,
  ): Promise<DisasterRecoveryCandidateState> {
    const current = await this.state(transferId);
    if (!current) throw new Error("Disaster install decision has no durable candidate claim");
    if (!current.verified) throw new Error("Disaster install decision has no verified candidate");
    const installDecision = validateInstallDecision(
      current.prepare,
      current.verified,
      input,
      this.recoveryRootPublicKey,
    );
    if (current.installDecision) {
      if (canonicalize(current.installDecision) !== canonicalize(installDecision)) {
        throw new Error("Disaster install decision conflicts with replay");
      }
      return current;
    }
    if (current.terminal !== undefined) {
      throw new Error("Terminal disaster candidate cannot gain an install decision");
    }
    const decisionRef = await this.log.artifactStore.put(
      Buffer.from(canonicalize(installDecision), "utf8"),
    );
    const stored = (await this.#transact((projection) => {
      const existing = projection.candidates.get(transferId);
      if (!existing) throw new Error("Disaster install decision has no durable candidate claim");
      if (!existing.verifiedRef) throw new Error("Disaster install decision has no verified candidate");
      if (existing.installDecisionRef) {
        if (canonicalize(existing.installDecisionRef) !== canonicalize(decisionRef)) {
          throw new Error("Disaster install decision conflicts with replay");
        }
        return { kind: "return", value: existing };
      }
      if (existing.terminal !== undefined) {
        throw new Error("Terminal disaster candidate cannot gain an install decision");
      }
      return {
        kind: "append",
        entries: [{
          stream: DISASTER_CANDIDATE_STREAM,
          body: {
            v: 1,
            t: "disaster-recovery-candidate-install-decided",
            transferId,
            decisionRef,
          } satisfies DisasterCandidateRecord,
        }],
        value: { ...existing, installDecisionRef: decisionRef },
      };
    }, [decisionRef, ...installDecision.candidateReferences])).value;
    return this.#hydrateCandidate(stored);
  }

  async terminal(
    transferId: string,
    terminal: "committed" | "aborted",
    abortInput?: DisasterRecoveryAbort,
  ): Promise<DisasterRecoveryCandidateState> {
    const current = await this.state(transferId);
    if (!current) throw new Error("Disaster terminal has no durable candidate claim");
    if (terminal === "aborted") {
      validateCandidateAbort(current.prepare, abortInput, this.recoveryRootPublicKey);
    }
    const stored = (await this.#transact((projection) => {
      const existing = projection.candidates.get(transferId);
      if (!existing) throw new Error("Disaster terminal has no durable candidate claim");
      const abort = terminal === "aborted"
        ? validateCandidateAbort(
            existing.prepare,
            abortInput,
            this.recoveryRootPublicKey,
          )
        : undefined;
      if (terminal !== "aborted" && abortInput !== undefined) {
        throw new TypeError("Committed disaster candidate cannot store an abort");
      }
      if (terminal === "committed" && !existing.installDecisionRef) {
        throw new Error("Committed disaster candidate has no durable install decision");
      }
      if (terminal === "aborted" && existing.installDecisionRef) {
        throw new Error("Install-decided disaster candidate cannot be aborted");
      }
      if (existing.terminal !== undefined) {
        if (
          existing.terminal !== terminal ||
          (terminal === "aborted" && canonicalize(existing.abort) !== canonicalize(abort))
        ) {
          throw new Error("Disaster candidate terminal conflicts with replay");
        }
        return { kind: "return", value: existing };
      }
      const record: DisasterCandidateRecord = terminal === "aborted"
        ? {
            v: 1,
            t: "disaster-recovery-candidate-terminal",
            transferId,
            terminal,
            abort: abort!,
          }
        : {
            v: 1,
            t: "disaster-recovery-candidate-terminal",
            transferId,
            terminal,
          };
      return {
        kind: "append",
        entries: [
          { stream: DISASTER_CANDIDATE_STREAM, body: record },
          {
            stream: ANCHOR_CANDIDATE_STREAM,
            body: targetWideAnchorCandidateTerminal(
              disasterTargetWideIdentity(existing.prepare),
              terminal,
            ),
          },
        ],
        value: abort
          ? { ...existing, terminal, abort }
          : { ...existing, terminal },
      };
    })).value;
    return this.#hydrateCandidate(stored);
  }

  stopStorageMaintenance(): Promise<void> {
    return this.log.stopStorageMaintenance();
  }

  #projection(): Promise<CandidateProjection> {
    return this.log.rebuildProjection(
      emptyProjection(),
      (projection, entry) => reduceProjection(
        projection,
        entry,
        this.recoveryRootPublicKey,
      ),
      { streams: [ANCHOR_CANDIDATE_STREAM, DISASTER_CANDIDATE_STREAM] },
    );
  }

  async #hydrateCandidate(
    stored: StoredDisasterRecoveryCandidateState,
  ): Promise<DisasterRecoveryCandidateState> {
    const verified = stored.verifiedRef
      ? parseStoredVerified(
          decodeCanonicalArtifact(
            await this.log.artifactStore.get(stored.verifiedRef),
            "Disaster candidate verification",
          ),
          stored.prepare,
          this.recoveryRootPublicKey,
        )
      : undefined;
    if (stored.installDecisionRef && !verified) {
      throw new Error("Disaster install decision precedes candidate verification");
    }
    const installDecision = stored.installDecisionRef
      ? parseStoredInstallDecision(
          decodeCanonicalArtifact(
            await this.log.artifactStore.get(stored.installDecisionRef),
            "Disaster install decision",
          ),
          stored.prepare,
          verified!,
          this.recoveryRootPublicKey,
        )
      : undefined;
    return Object.freeze({
      prepare: stored.prepare,
      ...(verified ? { verified } : {}),
      ...(installDecision ? { installDecision } : {}),
      ...(stored.terminal ? { terminal: stored.terminal } : {}),
      ...(stored.abort ? { abort: stored.abort } : {}),
    });
  }

  #transact<Value>(
    decide: (
      projection: CandidateProjection,
    ) => import("@zhixing/core/authority").ProjectionTransactionDecision<unknown, Value>,
    candidateReferences: readonly ArtifactRef[] = [],
  ) {
    return this.log.transactProjection(
      emptyProjection(),
      (projection, entry) => reduceProjection(
        projection,
        entry,
        this.recoveryRootPublicKey,
      ),
      decide,
      {
        streams: [ANCHOR_CANDIDATE_STREAM, DISASTER_CANDIDATE_STREAM],
        candidateReferences,
      },
    );
  }
}

function emptyProjection(): CandidateProjection {
  return {
    candidates: new Map(),
    targetWide: emptyTargetWideAnchorCandidates(),
  };
}

function reduceProjection(
  projection: CandidateProjection,
  entry: LogicalRecord<unknown>,
  recoveryRootPublicKey: string,
): CandidateProjection {
  const targetWide = reduceTargetWideAnchorCandidates(projection.targetWide, entry);
  const base = targetWide === projection.targetWide
    ? projection
    : { ...projection, targetWide };
  if (entry.stream !== DISASTER_CANDIDATE_STREAM) return base;
  const record = validateRecord(
    entry.body,
    base.candidates,
    recoveryRootPublicKey,
  );
  if (record.t === "disaster-recovery-candidate-claimed") {
    const prepare = parseStoredPrepare(record.prepareJson, recoveryRootPublicKey);
    const existing = base.candidates.get(prepare.transferId);
    const legacyWide = base.targetWide.has(prepare.transferId)
      ? base.targetWide
      : reduceTargetWideAnchorCandidateRecord(
          base.targetWide,
          targetWideAnchorCandidateClaim(disasterTargetWideIdentity(prepare)),
        );
    if (existing) {
      assertPrepare(existing.prepare, prepare);
      return legacyWide === base.targetWide ? base : { ...base, targetWide: legacyWide };
    }
    const candidates = new Map(base.candidates);
    candidates.set(prepare.transferId, { prepare });
    return { ...base, candidates, targetWide: legacyWide };
  }
  const existing = base.candidates.get(record.transferId);
  if (!existing) throw new Error("Disaster candidate progress has no durable claim");
  const candidates = new Map(base.candidates);
  if (record.t === "disaster-recovery-candidate-verified") {
    if (existing.terminal !== undefined) {
      throw new Error("Terminal disaster candidate cannot gain verification");
    }
    if (
      existing.verifiedRef &&
      canonicalize(existing.verifiedRef) !== canonicalize(record.verifiedRef)
    ) throw new Error("Disaster candidate has conflicting verification facts");
    candidates.set(record.transferId, { ...existing, verifiedRef: record.verifiedRef });
    return { ...base, candidates };
  }
  if (record.t === "disaster-recovery-candidate-install-decided") {
    if (!existing.verifiedRef) {
      throw new Error("Disaster install decision precedes candidate verification");
    }
    if (existing.terminal !== undefined) {
      throw new Error("Terminal disaster candidate cannot gain an install decision");
    }
    if (
      existing.installDecisionRef &&
      canonicalize(existing.installDecisionRef) !== canonicalize(record.decisionRef)
    ) throw new Error("Disaster candidate has conflicting install decisions");
    candidates.set(record.transferId, {
      ...existing,
      installDecisionRef: record.decisionRef,
    });
    return { ...base, candidates };
  }
  if (existing.terminal !== undefined && existing.terminal !== record.terminal) {
    throw new Error("Disaster candidate has conflicting terminal decisions");
  }
  if (record.terminal === "committed" && !existing.installDecisionRef) {
    throw new Error("Disaster committed terminal has no install decision");
  }
  if (record.terminal === "aborted" && existing.installDecisionRef) {
    throw new Error("Disaster abort conflicts with an install decision");
  }
  if (
    record.terminal === "aborted" &&
    existing.abort &&
    canonicalize(existing.abort) !== canonicalize(record.abort)
  ) throw new Error("Disaster candidate has conflicting abort decisions");
  candidates.set(
    record.transferId,
    record.terminal === "aborted"
      ? { ...existing, terminal: record.terminal, abort: record.abort }
      : { ...existing, terminal: record.terminal },
  );
  const legacyWide = existing.terminal === undefined
    ? reduceTargetWideAnchorCandidateRecord(
        base.targetWide,
        targetWideAnchorCandidateTerminal(
          disasterTargetWideIdentity(existing.prepare),
          record.terminal,
        ),
      )
    : base.targetWide;
  return { ...base, candidates, targetWide: legacyWide };
}

function validateRecord(
  input: unknown,
  candidates: ReadonlyMap<string, StoredDisasterRecoveryCandidateState>,
  recoveryRootPublicKey: string,
): DisasterCandidateRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Disaster candidate record must be an object");
  }
  const record = input as Partial<DisasterCandidateRecord> & Record<string, unknown>;
  if (record.v !== 1) throw new TypeError("Disaster candidate record version is invalid");
  if (record.t === "disaster-recovery-candidate-claimed") {
    assertExactKeys(record, ["prepareJson", "t", "v"]);
    if (typeof record.prepareJson !== "string") {
      throw new TypeError("Disaster candidate prepare bytes are invalid");
    }
    const raw = JSON.parse(record.prepareJson) as unknown;
    if (canonicalize(raw) !== record.prepareJson) {
      throw new TypeError("Disaster candidate prepare bytes are not canonical");
    }
    return {
      v: 1,
      t: record.t,
      prepareJson: canonicalize(validatePrepare(raw, recoveryRootPublicKey)),
    };
  }
  if (record.t === "disaster-recovery-candidate-verified") {
    assertExactKeys(record, ["t", "transferId", "v", "verifiedRef"]);
    if (typeof record.transferId !== "string") throw new TypeError("Disaster candidate transfer is invalid");
    const candidate = candidates.get(record.transferId);
    if (!candidate) throw new Error("Disaster verification precedes its durable claim");
    return {
      v: 1,
      t: record.t,
      transferId: record.transferId,
      verifiedRef: strictArtifactRef(
        record.verifiedRef,
        "Disaster candidate verification ref",
      ),
    };
  }
  if (record.t === "disaster-recovery-candidate-install-decided") {
    assertExactKeys(record, ["decisionRef", "t", "transferId", "v"]);
    if (typeof record.transferId !== "string") {
      throw new TypeError("Disaster candidate transfer is invalid");
    }
    const candidate = candidates.get(record.transferId);
    if (!candidate?.verifiedRef) {
      throw new Error("Disaster install decision precedes candidate verification");
    }
    return {
      v: 1,
      t: record.t,
      transferId: record.transferId,
      decisionRef: strictArtifactRef(
        record.decisionRef,
        "Disaster install decision ref",
      ),
    };
  }
  if (record.t !== "disaster-recovery-candidate-terminal") {
    throw new TypeError("Disaster candidate record tag is invalid");
  }
  if (typeof record.transferId !== "string") throw new TypeError("Disaster candidate transfer is invalid");
  const candidate = candidates.get(record.transferId);
  if (!candidate) throw new Error("Disaster terminal precedes its durable claim");
  if (record.terminal === "committed") {
    assertExactKeys(record, ["t", "terminal", "transferId", "v"]);
    return { v: 1, t: record.t, transferId: record.transferId, terminal: "committed" };
  }
  if (record.terminal !== "aborted") throw new TypeError("Disaster terminal is invalid");
  assertExactKeys(record, ["abort", "t", "terminal", "transferId", "v"]);
  return {
    v: 1,
    t: record.t,
    transferId: record.transferId,
    terminal: "aborted",
    abort: validateCandidateAbort(
      candidate.prepare,
      record.abort,
      recoveryRootPublicKey,
    ),
  };
}

function validatePrepare(input: unknown, recoveryRootPublicKey: string): PrepareCommand {
  const verifier = recoveryRootVerifier(recoveryRootPublicKey);
  const command = validateDisasterRecoveryCommand(input, {
    recoveryRoot: verifier,
    targetDevice: verifier,
    targetIssuer: verifier,
  });
  if (command.op !== "prepare") throw new TypeError("Disaster candidate requires a prepare command");
  return command;
}

function parseStoredPrepare(input: string, recoveryRootPublicKey: string): PrepareCommand {
  const raw = JSON.parse(input) as unknown;
  if (canonicalize(raw) !== input) {
    throw new TypeError("Disaster candidate prepare bytes are not canonical");
  }
  return validatePrepare(raw, recoveryRootPublicKey);
}

function decodeCanonicalArtifact(bytes: Uint8Array, label: string): string {
  const snapshot = Buffer.from(bytes);
  const text = snapshot.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(snapshot)) {
    throw new TypeError(`${label} bytes are not valid UTF-8`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(`${label} bytes are not JSON`);
  }
  if (canonicalize(raw) !== text) {
    throw new TypeError(`${label} bytes are not canonical`);
  }
  return text;
}

function parseStoredVerified(
  input: string,
  prepare: PrepareCommand,
  recoveryRootPublicKey: string,
): DisasterRecoveryVerifiedCandidate {
  const raw = JSON.parse(input) as unknown;
  if (canonicalize(raw) !== input) {
    throw new TypeError("Disaster candidate verification bytes are not canonical");
  }
  return validateVerifiedCandidate(prepare, raw, recoveryRootPublicKey);
}

function validateVerifiedCandidate(
  prepare: PrepareCommand,
  input: unknown,
  recoveryRootPublicKey: string,
): DisasterRecoveryVerifiedCandidate {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Disaster verified candidate must be an object");
  }
  const value = input as Partial<DisasterRecoveryVerifiedCandidate> & Record<string, unknown>;
  assertExactKeys(value, [
    "authorityRecordsRef",
    "baseline",
    "baselineEvents",
    "reachabilityCut",
    "trustEvidence",
    "trustEvidenceDigest",
    "catalog",
    "catalogRef",
    "onsiteVerification",
  ]);
  if (
    !value.baseline || !value.onsiteVerification || !value.catalog ||
    !value.catalogRef || !value.authorityRecordsRef || !Array.isArray(value.baselineEvents) ||
    !Array.isArray(value.reachabilityCut) || !Array.isArray(value.trustEvidence) ||
    typeof value.trustEvidenceDigest !== "string"
  ) throw new TypeError("Disaster verified candidate is incomplete");
  const baseline = value.baseline as DisasterRecoveryBaseline;
  const verification = value.onsiteVerification as RecoveryCheckpointVerification;
  const catalog = prepareAuthorityCatalog(value.catalog).catalog;
  const preparedCatalog = prepareAuthorityCatalog(catalog);
  if (
    baseline.homeId !== prepare.recoveryRoot.homeId ||
    baseline.recoveryRoot.rootKeyId !== prepare.recoveryRoot.rootKeyId ||
    baseline.recoveryRoot.recipientKeyId !== prepare.recoveryRoot.recipientKeyId ||
    verification.checkpointId !== prepare.checkpointEnvelope.checkpointId ||
    verification.recipientKeyId !== prepare.checkpointEnvelope.recipientKeyId ||
    verification.targetId !== prepare.checkpointTargetId ||
    verification.envelopeDigest !== prepare.checkpointEnvelope.digest ||
    verification.signature.keyId !== prepare.recoveryRoot.rootKeyId ||
    catalog.transferId !== prepare.transferId ||
    catalog.targetDeviceId !== prepare.targetDeviceId ||
    catalog.sourceAnchorEpoch !== baseline.anchorEpoch ||
    catalog.authorityRecords.digest !== (value.authorityRecordsRef as ArtifactRef).digest ||
    canonicalize(preparedCatalog.ref) !== canonicalize(value.catalogRef)
  ) throw new TypeError("Disaster verified candidate changes its durable identity");
  const { signature, ...unsignedVerification } = verification;
  recoveryRootVerifier(recoveryRootPublicKey).verify(
    "RecoveryCheckpointVerification",
    1,
    unsignedVerification,
    signature,
  );
  const events = Object.freeze([...(value.baselineEvents as HomeTrustEvent[])]);
  const projection = replayTrustChain(events);
  if (
    projection.homeId !== baseline.homeId ||
    projection.trustEpoch !== baseline.trustEpoch ||
    canonicalize(projection.chainHead) !== canonicalize(baseline.chainHead) ||
    canonicalize(projection.issuer) !== canonicalize(baseline.issuer)
  ) throw new TypeError("Disaster baseline evidence does not reproduce its snapshot");
  const cut = Object.freeze([...(value.reachabilityCut as string[])]);
  const evidence = Object.freeze((value.trustEvidence as DisasterRecoveryPeerEvidence[])
    .map((item) => {
      const evidenceProjection = replayTrustChain(item.events);
      verifyHomeTrustRecord(item.record, evidenceProjection);
      if (
        evidenceProjection.homeId !== baseline.homeId ||
        !evidenceProjection.members.some((member) =>
          member.device.deviceId === item.deviceId && member.state === "active")
      ) throw new TypeError("Disaster reachability evidence is not an active home member");
      return Object.freeze({
        deviceId: item.deviceId,
        events: Object.freeze(item.events.map((event) => structuredClone(event))),
        record: structuredClone(item.record),
      });
    })
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId, "en-US")));
  if (
    canonicalize(cut) !== canonicalize([...cut].sort((left, right) =>
      left.localeCompare(right, "en-US"))) ||
    canonicalize(cut) !== canonicalize(evidence.map((item) => item.deviceId)) ||
    protocolDigest("DisasterRecoveryReachabilityEvidence", 1, {
      cut,
      evidence: evidence.map((item) => ({
        deviceId: item.deviceId,
        chainHead: item.record.chainHead,
        trustEpoch: item.record.trustEpoch,
        recordDigest: protocolDigest("HomeTrustRecord", 1, item.record),
      })),
    }) !== value.trustEvidenceDigest
  ) throw new TypeError("Disaster reachability evidence digest is invalid");
  return Object.freeze({
    baseline: structuredClone(baseline),
    baselineEvents: events,
    reachabilityCut: cut,
    trustEvidence: evidence,
    trustEvidenceDigest: value.trustEvidenceDigest,
    onsiteVerification: structuredClone(verification),
    authorityRecordsRef: structuredClone(value.authorityRecordsRef as ArtifactRef),
    catalog,
    catalogRef: structuredClone(value.catalogRef as ArtifactRef),
  });
}

function parseStoredInstallDecision(
  input: string,
  prepare: PrepareCommand,
  verified: DisasterRecoveryVerifiedCandidate,
  recoveryRootPublicKey: string,
): DisasterRecoveryInstallDecision {
  const raw = JSON.parse(input) as unknown;
  if (canonicalize(raw) !== input) {
    throw new TypeError("Disaster install decision bytes are not canonical");
  }
  return validateInstallDecision(prepare, verified, raw, recoveryRootPublicKey);
}

function validateInstallDecision(
  prepare: PrepareCommand,
  verified: DisasterRecoveryVerifiedCandidate,
  input: unknown,
  recoveryRootPublicKey: string,
): DisasterRecoveryInstallDecision {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Disaster install decision must be an object");
  }
  const value = input as Partial<DisasterRecoveryInstallDecision> & Record<string, unknown>;
  assertExactKeys(value, ["candidateReferences", "installation", "installationEntries"]);
  if (!Array.isArray(value.installationEntries) || !Array.isArray(value.candidateReferences)) {
    throw new TypeError("Disaster install decision is incomplete");
  }
  const installation = validateDecisionInstallation(
    prepare,
    verified,
    value.installation,
    recoveryRootPublicKey,
  );
  const candidateReferences = canonicalReferences(value.candidateReferences);
  const requiredReferences = [
    verified.authorityRecordsRef,
    verified.catalogRef,
    ...verified.catalog.retainedArtifacts,
  ];
  for (const required of requiredReferences) {
    if (!candidateReferences.some((candidate) => canonicalize(candidate) === canonicalize(required))) {
      throw new TypeError("Disaster install decision omits a verified candidate reference");
    }
  }
  const installationEntries = canonicalInstallationEntries(value.installationEntries);
  validateInstallationEntries(installationEntries, installation, verified);
  return Object.freeze({
    installationEntries,
    installation,
    candidateReferences,
  });
}

function validateDecisionInstallation(
  prepare: PrepareCommand,
  verified: DisasterRecoveryVerifiedCandidate,
  input: unknown,
  recoveryRootPublicKey: string,
): DisasterRecoveryInstallation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Disaster recovery installation must be an object");
  }
  const value = input as Partial<DisasterRecoveryInstallation> & Record<string, unknown>;
  assertExactKeys(value, [
    "authorityRecords",
    "baseDigest",
    "catalog",
    "commit",
    "recoveryRootPublicKey",
    "revoke",
    "sourceHead",
    "t",
    "transferId",
    "transition",
    "trustRecord",
    "v",
  ]);
  const verifier = recoveryRootVerifier(recoveryRootPublicKey);
  const commit = validateDisasterRecoveryCommit(value.commit, verifier);
  const transition = value.transition as HomeTrustEvent;
  const revoke = value.revoke as HomeTrustEvent;
  const trustRecord = value.trustRecord as import("@zhixing/core/contracts").HomeTrustRecord;
  const authorityRecords = value.authorityRecords as ArtifactRef;
  const catalog = value.catalog as ArtifactRef;
  assertArtifactRef(authorityRecords);
  assertArtifactRef(catalog);
  const sourceHead = value.sourceHead as import("@zhixing/core/authority").DurableLogCheckpoint;
  if (
    value.v !== 1 || value.t !== "disaster-anchor-installed" ||
    value.transferId !== prepare.transferId ||
    value.recoveryRootPublicKey !== recoveryRootPublicKey ||
    commit.transferId !== prepare.transferId ||
    commit.targetDeviceId !== prepare.targetDeviceId ||
    commit.checkpointEnvelopeDigest !== prepare.checkpointEnvelope.digest ||
    commit.authorityCatalogDigest !== authorityCatalogDigest(verified.catalog) ||
    commit.nextAnchorEpoch !== verified.baseline.anchorEpoch + 1 ||
    commit.nextTrustEpoch !== verified.baseline.trustEpoch + 1 ||
    canonicalize(authorityRecords) !== canonicalize(verified.authorityRecordsRef) ||
    canonicalize(catalog) !== canonicalize(verified.catalogRef) ||
    canonicalize(sourceHead) !== canonicalize(verified.catalog.source)
  ) throw new TypeError("Disaster installation changes its verified candidate identity");
  const trust = replayTrustChain([...verified.baselineEvents, transition, revoke]);
  verifyHomeTrustRecord(trustRecord, trust);
  if (
    trustRecord.issuer.deviceId !== prepare.targetDeviceId ||
    trustRecord.issuer.issuerPublicKey !== commit.targetIssuerPublicKey
  ) throw new TypeError("Disaster installation changes its target issuer identity");
  const installation = createDisasterRecoveryInstallation({
    commit,
    recoveryRootPublicKey,
    transition,
    revoke,
    trustRecord,
    authorityRecords,
    catalog,
    sourceHead,
  });
  if (canonicalize(installation) !== canonicalize(value)) {
    throw new TypeError("Disaster installation is not canonical or internally complete");
  }
  return installation;
}

function canonicalInstallationEntries(
  input: readonly unknown[],
): readonly LogicalRecord<unknown>[] {
  const normalized = JSON.parse(canonicalize(input)) as unknown;
  if (!Array.isArray(normalized) || normalized.length < 5) {
    throw new TypeError("Disaster install decision has incomplete installation entries");
  }
  for (const item of normalized) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("Disaster installation entry must be an object");
    }
    const entry = item as Record<string, unknown>;
    assertExactKeys(entry, ["body", "stream"]);
    if (typeof entry.stream !== "string" || entry.stream.length === 0) {
      throw new TypeError("Disaster installation entry stream is invalid");
    }
  }
  return Object.freeze(normalized as LogicalRecord<unknown>[]);
}

function validateInstallationEntries(
  entries: readonly LogicalRecord<unknown>[],
  installation: DisasterRecoveryInstallation,
  verified: DisasterRecoveryVerifiedCandidate,
): void {
  const transitionIndex = entries.findIndex((entry) =>
    entry.stream === "trust" && canonicalize(entry.body) === canonicalize({
      t: "home-trust-event",
      event: installation.transition,
    }));
  if (transitionIndex < 0 || transitionIndex + 4 > entries.length) {
    throw new TypeError("Disaster installation entries omit the issuer transition");
  }
  const missingTrust = entries.slice(0, transitionIndex);
  const expectedMissing = verified.baselineEvents.slice(
    verified.baselineEvents.length - missingTrust.length,
  ).map((event) => ({ stream: "trust", body: { t: "home-trust-event", event } }));
  if (
    missingTrust.length > verified.baselineEvents.length ||
    canonicalize(missingTrust) !== canonicalize(expectedMissing) ||
    canonicalize(entries[transitionIndex + 1]) !== canonicalize({
      stream: "trust",
      body: { t: "home-trust-event", event: installation.revoke },
    }) ||
    canonicalize(entries[transitionIndex + 2]) !== canonicalize({
      stream: "trust",
      body: { t: "home-trust-record", record: installation.trustRecord },
    }) ||
    canonicalize(entries.at(-2)) !== canonicalize({
      stream: "transfer:anchor-disaster",
      body: {
        v: 1,
        mode: "disaster-recovery",
        t: "anchor-committed",
        transferId: installation.transferId,
        commit: installation.commit,
      },
    }) ||
    canonicalize(entries.at(-1)) !== canonicalize({
      stream: "transfer:anchor-current",
      body: installation,
    })
  ) throw new TypeError("Disaster installation entries do not match the frozen decision");
  for (const entry of entries.slice(transitionIndex + 3, -2)) {
    const exposure = entry.body as Record<string, unknown>;
    if (
      entry.stream !== "exposure" || exposure.state !== "compromised" ||
      exposure.deviceId !== verified.baseline.issuer.deviceId
    ) throw new TypeError("Disaster installation contains an unrelated exposure decision");
  }
}

function canonicalReferences(input: readonly unknown[]): readonly ArtifactRef[] {
  const unique = new Map<string, ArtifactRef>();
  for (const item of input) {
    assertArtifactRef(item);
    const prior = unique.get(item.digest);
    if (prior && prior.bytes !== item.bytes) {
      throw new TypeError("Disaster candidate reference digest has conflicting sizes");
    }
    unique.set(item.digest, Object.freeze({ ...item }));
  }
  const result = [...unique.values()].sort((left, right) =>
    left.digest.localeCompare(right.digest, "en-US"));
  if (canonicalize(input) !== canonicalize(result)) {
    throw new TypeError("Disaster candidate references are not a canonical exact-set");
  }
  return Object.freeze(result);
}

function strictArtifactRef(input: unknown, label: string): ArtifactRef {
  assertArtifactRef(input);
  if (canonicalize(Object.keys(input).sort()) !== canonicalize(["bytes", "digest"])) {
    throw new TypeError(`${label} has incomplete or unknown fields`);
  }
  return Object.freeze({ digest: input.digest, bytes: input.bytes });
}

function validateCandidateAbort(
  prepare: PrepareCommand,
  input: unknown,
  recoveryRootPublicKey: string,
): DisasterRecoveryAbort {
  const abort = validateDisasterRecoveryAbort(
    input,
    recoveryRootVerifier(recoveryRootPublicKey),
  );
  if (
    abort.requestId !== prepare.requestId ||
    abort.transferId !== prepare.transferId ||
    abort.targetDeviceId !== prepare.targetDeviceId ||
    abort.checkpointTargetId !== prepare.checkpointTargetId ||
    abort.checkpointEnvelopeDigest !== prepare.checkpointEnvelope.digest
  ) throw new TypeError("Disaster abort changes its durable candidate identity");
  return abort;
}

function recoveryRootVerifier(recoveryRootPublicKey: string): ProtocolSignatureVerifier {
  return {
    verify(schemaId, version, payload, signature) {
      verifyRecoverySignature(
        recoveryRootPublicKey,
        schemaId,
        version,
        payload,
        signature,
      );
    },
  };
}

function disasterTargetWideIdentity(prepare: PrepareCommand) {
  const identity = {
    homeId: prepare.recoveryRoot.homeId,
    requestId: prepare.requestId,
    transferId: prepare.transferId,
    targetDeviceId: prepare.targetDeviceId,
    checkpointTargetId: prepare.checkpointTargetId,
    checkpointEnvelopeDigest: prepare.checkpointEnvelope.digest,
    rootKeyId: prepare.recoveryRoot.rootKeyId,
    recipientKeyId: prepare.recoveryRoot.recipientKeyId,
  };
  return Object.freeze({
    mode: "disaster-recovery" as const,
    homeId: identity.homeId,
    transferId: identity.transferId,
    identityDigest: protocolDigest("DisasterRecoveryCandidateIdentity", 1, identity),
  });
}

function assertPrepare(actual: PrepareCommand, expected: PrepareCommand): void {
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new Error("Disaster candidate replay changes its originating prepare command");
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...expected].sort())) {
    throw new TypeError("Disaster candidate record has incomplete or unknown fields");
  }
}
