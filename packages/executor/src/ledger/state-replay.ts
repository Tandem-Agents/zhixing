import { Buffer } from "node:buffer";
import {
  resolveDispatchArtifactClosure,
  type ArtifactStore,
  type AuthorityCommitLog,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AssignmentActivationProof,
  AssignmentEntry,
  CommitEnvelope,
  JsonValue,
  LedgerSnapshot,
  LogicalRecord,
} from "@zhixing-ai/core/contracts";
import {
  acceptedRemoteIntervalRemainingMs,
  applyValidatedAssignmentEntry,
  assignmentLedgerSeed,
  canonicalize,
  controlLeaseBindsDispatchEnvelope,
  createAssignmentLedgerValidationState,
  dispatchEnvelopeArtifact,
  interactionMirrorSeed,
  materializeInteractionDisplay,
  MAX_CONTROL_LEASE_TTL_MS,
  MAX_PERMISSION_LEASE_TTL_MS,
  validateAssignmentEntry,
  validateCancelProof,
  validateConversationActivation,
  validateConversationEnvelope,
  validateJobActivation,
  validateJobEnvelope,
  validateJobStagedMutationRecord,
  verifyProtocolStep,
  type DataPlaneTicketUse,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import {
  leaseClockStream,
  leaseTime,
  readLeaseClockRecord,
  type LeaseClockSummary,
} from "../assignment-lease-clock.js";
import { assignmentIdFromStream } from "../assignment-ledger-index.js";
import type { DataPlaneAssignmentBinding } from "../data-plane-ticket-registry.js";
import type { ExecutorAssignmentResourceCoordinator } from "../resource-governor.js";
import {
  assignmentStream,
  corruptLedger,
  HistoryLookupRequired,
  JobRecoveryProjectionValueError,
  requiresExecutorResourceReceipt,
  snapshot,
  type AssignmentEnvelope,
  type FinishedInteraction,
  type JobRecoveryIndexValue,
  type JobRecoveryObligation,
  type LedgerProjection,
  type MirrorChainItem,
  type RecordedTrustRuleHit,
  type RecordedTrustSediment,
  type RequestedInteraction,
} from "./contracts.js";

export interface LedgerReductionEnvironment {
  readonly executorId: string;
  readonly artifacts: ArtifactStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly resources?: ExecutorAssignmentResourceCoordinator;
}

export async function assertEnvelopeArtifactsPresent(
  envelope: AssignmentEnvelope,
  artifacts: ArtifactStore,
): Promise<ArtifactRef[]> {
  return [...(await resolveDispatchArtifactClosure(envelope, artifacts)).transfer];
}

export function omitsHistory(state: LedgerProjection): boolean {
  return state.keyed === true && (state.historyBase ?? 0) > 0;
}

export function finishedCount(state: LedgerProjection): number {
  return (state.finishedBase ?? 0) + state.finishedOrder.length;
}

export function finishedAt(
  state: LedgerProjection,
  index: number,
): MirrorChainItem | undefined {
  const local = index - (state.finishedBase ?? 0);
  return local >= 0 ? state.finishedOrder[local] : undefined;
}

export function emptyProjection(assignmentId: string): LedgerProjection {
  return {
    assignmentId,
    leaseTimeFrontier: 0,
    leaseAcceptanceFloor: 0,
    leaseClockActivated: false,
    validation: createAssignmentLedgerValidationState(assignmentId),
    lastSeq: 0,
    chainDigest: assignmentLedgerSeed(assignmentId),
    phase: "unknown",
    entries: [],
    ledgerBySeq: [],
    requested: new Map(),
    pendingRequests: new Map(),
    finished: new Map(),
    finishedOrder: [],
    finishedIndexBySeq: new Map(),
    aborts: [],
    sideEffects: new Map(),
    stagedMutations: [],
    mutationRequestIds: new Set(),
    stagedMutationByRequestId: new Map(),
    mirroredUpTo: 0,
    mirroredFinishedCount: 0,
    mirroredInteractionOrdinal: 0,
    mirroredInteractionDigest: interactionMirrorSeed(assignmentId),
    streamProjectedUpTo: 0,
    lastInteractionStreamSeq: 0,
  };
}

export function hasPendingInteractionObligations(state: LedgerProjection): boolean {
  return (
    state.pendingRequests.size > 0 ||
    state.mirroredFinishedCount !== finishedCount(state) ||
    (state.received?.body.activation.ref.execution === "job" &&
      state.streamProjectionEnabledAfter !== undefined &&
      state.streamProjectedUpTo < state.validation.lastFinishedInteractionRecordSeq)
  );
}

export function withLeaseClock(
  state: LedgerProjection,
  summary: LeaseClockSummary,
): void {
  state.leaseTimeFrontier = Math.max(state.leaseTimeFrontier, summary.frontier);
  if (summary.activated) state.leaseClockActivated = true;
}

/**
 * Local executor projection update driven strictly after `applyValidatedAssignmentEntry(state.validation, entry)`:
 * `state.phase` is sourced from `state.validation.phase` (the single protocol stage authority) rather than
 * maintaining a second parallel stage state machine.
 */
export function applyEntry(
  state: LedgerProjection,
  entry: AssignmentEntry,
  ledgerDigest: string,
  at: string,
): void {
  state.phase = state.validation.phase;
  const body = entry.body;
  switch (body.t) {
    case "received":
      state.received = { body, recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "dispatch-rejected":
      state.rejection = { body, recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "control-lease-renewed":
      state.control = {
        authority: snapshot(body.lease.authority, "Control lease authority"),
        ownerDeviceId: body.lease.signature.keyId,
        lease: snapshot(body.lease, "Control lease"),
        validForMs: acceptedRemoteIntervalRemainingMs({
          issuedAt: body.lease.issuedAt,
          expiry: body.lease.expiry,
          acceptedAt: at,
          maxTtlMs: MAX_CONTROL_LEASE_TTL_MS,
        }),
        acceptedAt: at,
      };
      return;
    case "supersede-fenced":
      state.supersedeFence = { body, recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "started":
      state.started = { recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "interaction-stream-projection-enabled":
      state.streamProjectionEnabledAfter = body.legacyUpToRecordSeq;
      state.streamProjectedUpTo = body.legacyUpToRecordSeq;
      return;
    case "interaction-requested": {
      const requested = { body, recordSeq: entry.recordSeq };
      state.requested.set(body.requestId, requested);
      state.pendingRequests.set(body.requestId, requested);
      return;
    }
    case "interaction-finished": {
      const checkpoint = state.validation.unmirroredFinished.get(entry.recordSeq);
      if (!checkpoint) {
        throw corruptLedger("Validated interaction projection lost its mirror checkpoint");
      }
      const finished = {
        body,
        recordSeq: entry.recordSeq,
        at,
        ordinal: checkpoint.ordinal,
        mirrorDigest: checkpoint.mirrorDigest,
      };
      if (!state.pendingRequests.delete(body.requestId)) {
        throw corruptLedger("Validated interaction projection lost its pending request");
      }
      state.finished.set(body.requestId, finished);
      state.finishedIndexBySeq.set(entry.recordSeq, finishedCount(state));
      state.finishedOrder.push(finished);
      return;
    }
    case "trust-sediment":
    case "trust-rule-hit": {
      const sedimentCheckpoint = state.validation.unmirroredFinished.get(entry.recordSeq);
      if (!sedimentCheckpoint) {
        throw corruptLedger(`Validated ${body.t} lost its mirror checkpoint`);
      }
      state.finishedIndexBySeq.set(entry.recordSeq, finishedCount(state));
      state.finishedOrder.push({
        body,
        recordSeq: entry.recordSeq,
        at,
        ordinal: sedimentCheckpoint.ordinal,
        mirrorDigest: sedimentCheckpoint.mirrorDigest,
      } as RecordedTrustSediment | RecordedTrustRuleHit);
      return;
    }
    case "staged-mutation":
      state.stagedMutations.push(body);
      state.mutationRequestIds.add(body.requestId);
      state.stagedMutationByRequestId.set(body.requestId, body);
      return;
    case "side-effect-started":
      state.sideEffects.set(body.effectSeq, { started: body });
      return;
    case "side-effect-completed": {
      const effect = state.sideEffects.get(body.effectSeq);
      if (!effect) throw corruptLedger("Validated side effect projection is missing its start");
      effect.completed = body;
      return;
    }
    case "abort-requested":
      state.aborts.push(body);
      return;
    case "halted":
      state.halted = body.proof;
      return;
    case "execution-failed":
      state.failure = body;
      return;
    case "bundle_sealed":
      state.sealed = body;
      return;
    case "acked":
      state.acknowledgedCommitRevision = body.commitRevision;
      return;
    case "mirrored": {
      const finishedIndex = state.finishedIndexBySeq.get(body.upTo);
      if (finishedIndex === undefined) {
        throw corruptLedger("Validated mirror projection has no finished interaction");
      }
      state.mirroredUpTo = body.upTo;
      state.mirroredFinishedCount = finishedIndex + 1;
      state.mirroredInteractionOrdinal = body.ordinal;
      state.mirroredInteractionDigest = body.mirrorDigest;
      return;
    }
    case "interaction-stream-projected":
      state.streamProjectedUpTo = body.upToRecordSeq;
      state.lastInteractionStreamSeq = body.lastStreamSeq;
      state.interactionStreamDigest = body.streamDigest;
      state.lastStreamProjectionRecordSeq = entry.recordSeq;
      return;
    case "cancel-proof-owner-accepted":
    case "interaction-settlement-owner-accepted":
      return;
    default:
      throw corruptLedger("Unsupported assignment record in this protocol stage");
  }
}

export async function reduceAssignmentRecord(
  env: LedgerReductionEnvironment,
  state: LedgerProjection,
  record: LogicalRecord<unknown>,
  commit: CommitEnvelope<unknown>,
  receiptRetirement = false,
): Promise<LedgerProjection> {
  if (record.stream !== assignmentStream(state.assignmentId)) {
    throw corruptLedger("Assignment projection received a different stream");
  }
  if (omitsHistory(state)) {
    const raw = (record.body as { readonly body?: { readonly t?: unknown; readonly requestId?: unknown } } | null)?.body;
    if (
      raw?.t === "interaction-requested" &&
      typeof raw.requestId === "string" &&
      !state.validation.requestedInteractions.has(raw.requestId) &&
      !state.historyChecked?.has(raw.requestId)
    ) {
      throw new HistoryLookupRequired();
    }
  }
  const entry = await verifyProtocolStep(() =>
    validateAssignmentEntry(record.body, env.verifier),
  );
  if (entry.recordSeq !== state.lastSeq + 1) {
    throw corruptLedger("Assignment record sequence is not contiguous");
  }
  let receivedEnvelope: AssignmentEnvelope | undefined;
  if (entry.body.t === "received") {
    const bytes = await env.artifacts.get(entry.body.envelope.ref);
    const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as AssignmentEnvelope;
    const envelope =
      raw.execution === "conversation"
        ? await verifyProtocolStep(() => validateConversationEnvelope(raw, env.verifier))
        : await verifyProtocolStep(() => validateJobEnvelope(raw, env.verifier));
    receivedEnvelope = envelope;
    if (requiresExecutorResourceReceipt(envelope.resourceLease)) {
      if (!env.resources) {
        throw corruptLedger("Governed assignment has no executor resource coordinator");
      }
      try {
        env.resources.assertReceiptRecords({
          lease: envelope.resourceLease,
          records: commit.entries,
          acceptedAt: commit.at,
        });
      } catch (error) {
        throw corruptLedger(
          error instanceof Error
            ? `Executor resource receipt is invalid: ${error.message}`
            : "Executor resource receipt is invalid",
        );
      }
    }
    const artifact = dispatchEnvelopeArtifact(envelope);
    if (canonicalize(artifact.ref) !== canonicalize(entry.body.envelope.ref)) {
      throw corruptLedger("received dispatch artifact reference is inconsistent");
    }
    if (
      envelope.assignmentId !== state.assignmentId ||
      envelope.executorId !== env.executorId
    ) {
      throw corruptLedger("received dispatch targets a different assignment or executor");
    }
    if (!receiptRetirement) {
      await assertEnvelopeArtifactsPresent(envelope, env.artifacts);
    }
    const control = state.control;
    if (
      !control ||
      !controlLeaseBindsDispatchEnvelope(control.lease, envelope) ||
      envelope.permissionLease.controlLeaseId !== envelope.controlLease.controlLeaseId
    ) {
      throw corruptLedger("received assignment does not bind durable owner control");
    }
    const receivedActivation = entry.body.activation;
    if (envelope.execution === "conversation") {
      await verifyProtocolStep(() =>
        validateConversationActivation({
          envelope,
          activation: receivedActivation as AssignmentActivationProof<"conversation">,
          dispatchRef: artifact.ref,
          verifier: env.verifier,
        }),
      );
    } else {
      await verifyProtocolStep(() =>
        validateJobActivation({
          envelope,
          activation: receivedActivation as AssignmentActivationProof<"job">,
          dispatchRef: artifact.ref,
          verifier: env.verifier,
        }),
      );
    }
  }
  if (entry.body.t === "control-lease-renewed") {
    const lease = entry.body.lease;
    acceptedRemoteIntervalRemainingMs({
      issuedAt: lease.issuedAt,
      expiry: lease.expiry,
      acceptedAt: entry.body.v === 3 ? entry.body.effectiveAcceptedAt : commit.at,
      maxTtlMs: MAX_CONTROL_LEASE_TTL_MS,
    });
  }
  if (entry.body.t === "halted") {
    const rawProof = entry.body.proof;
    const proof = await verifyProtocolStep(() => validateCancelProof(rawProof, env.verifier));
    if (proof.executorId !== env.executorId) {
      throw corruptLedger("Cancel proof names a different executor");
    }
    if (state.received) {
      const ref = state.received.body.activation.ref;
      const authorityMatches =
        ref.execution === "conversation"
          ? proof.authority.execution === "conversation" &&
            proof.authority.conversationId === ref.conversationId &&
            proof.authority.ownerEpoch === ref.ownerEpoch
          : proof.authority.execution === "job" &&
            proof.authority.taskId === ref.taskId &&
            proof.authority.anchorEpoch === ref.anchorEpoch;
      if (!authorityMatches) {
        throw corruptLedger("Cancel proof authority does not bind the received assignment");
      }
    }
  }
  if (
    entry.body.t === "halted" ||
    entry.body.t === "bundle_sealed" ||
    entry.body.t === "execution-failed" ||
    (entry.body.t === "supersede-fenced" &&
      commit.entries.some((item) => item.stream === "governor"))
  ) {
    const lease = state.received?.resourceLease;
    if (lease && requiresExecutorResourceReceipt(lease)) {
      if (!env.resources) {
        throw corruptLedger("Governed assignment has no executor resource coordinator");
      }
      const mode =
        entry.body.t === "supersede-fenced" ||
        (entry.body.t === "halted" && entry.body.proof.decision === "not-started")
          ? "release"
          : "settle-release";
      try {
        env.resources.assertTerminalRecords({
          reservationId: lease.reservationId,
          mode,
          records: commit.entries,
        });
      } catch (error) {
        throw corruptLedger(
          error instanceof Error
            ? `Executor resource terminal is invalid: ${error.message}`
            : "Executor resource terminal is invalid",
        );
      }
    }
  }
  if (
    entry.body.t === "staged-mutation" &&
    state.received?.body.activation.ref.execution === "job"
  ) {
    validateJobStagedMutationRecord(entry.body);
  }
  if (!receiptRetirement && entry.body.t === "interaction-requested") {
    await materializeInteractionDisplay(entry.body.display, env.artifacts);
  }
  if (entry.body.t === "received" || entry.body.t === "control-lease-renewed") {
    if (entry.body.v === 3) {
      const clocks = commit.entries.filter(
        (item) => item.stream === leaseClockStream(env.executorId),
      );
      if (
        clocks.length !== 1 ||
        readLeaseClockRecord(clocks[0]!.body, env.executorId) !==
          leaseTime(entry.body.effectiveAcceptedAt)
      ) {
        throw corruptLedger("Lease acceptance is missing its exact durable time companion");
      }
    } else if (state.leaseClockActivated) {
      throw corruptLedger("Legacy lease writer cannot append after effective-time activation");
    }
  }
  const acceptedAt = entry.body.v === 3 ? entry.body.effectiveAcceptedAt : commit.at;
  const digest = applyValidatedAssignmentEntry(state.validation, entry);
  applyEntry(state, entry, digest, acceptedAt);
  if (entry.body.t === "received" || entry.body.t === "control-lease-renewed") {
    state.leaseAcceptanceFloor = Math.max(state.leaseAcceptanceFloor, leaseTime(acceptedAt));
  }
  if (entry.body.t === "received" && receivedEnvelope) {
    if (!state.received) {
      throw corruptLedger("received projection was not materialized");
    }
    state.received.permission = {
      controlLeaseId: receivedEnvelope.permissionLease.controlLeaseId,
      validForMs: acceptedRemoteIntervalRemainingMs({
        issuedAt: receivedEnvelope.permissionLease.issuedAt,
        expiry: receivedEnvelope.permissionLease.expiry,
        acceptedAt,
        maxTtlMs: MAX_PERMISSION_LEASE_TTL_MS,
      }),
      acceptedAt,
    };
    state.received.resourceLease = snapshot(
      receivedEnvelope.resourceLease,
      "Received resource lease",
    );
  }
  state.lastSeq = entry.recordSeq;
  state.chainDigest = digest;
  if (
    state.validation.lastSeq !== state.lastSeq ||
    state.validation.chainDigest !== state.chainDigest ||
    state.validation.phase !== state.phase
  ) {
    throw corruptLedger("Assignment validation and executor projection diverged");
  }
  const projectedControl = state.control
    ? {
        authority: state.control.authority,
        ownerDeviceId: state.control.ownerDeviceId,
        controlLeaseId: state.control.lease.controlLeaseId,
        renewalSeq: state.control.lease.renewalSeq,
      }
    : undefined;
  if (
    canonicalize(state.validation.control ?? null) !==
    canonicalize(projectedControl ?? null)
  ) {
    throw corruptLedger("Owner-control validation and executor projection diverged");
  }
  state.entries.push(entry);
  state.ledgerBySeq.push(digest);
  if (entry.body.t === "interaction-stream-projected") {
    state.lastStreamProjectionDigest = digest;
  }
  return state;
}

export function extractDataPlaneBinding(
  state: LedgerProjection,
  executorId: string,
  use?: DataPlaneTicketUse,
): DataPlaneAssignmentBinding | undefined {
  if (!state.received) return undefined;
  const acceptsActiveUse =
    (state.phase === "received" || state.phase === "started") &&
    state.aborts.length === 0 &&
    !state.supersedeFence;
  if (!acceptsActiveUse && use !== "observe") return undefined;
  return {
    ref: snapshot(state.received.body.activation.ref, "Data-plane execution reference"),
    executorId,
    ownerKeyId: state.received.body.activation.signature.keyId,
  };
}

export function decisionSnapshot(state: LedgerProjection): LedgerProjection {
  const {
    entries: _entries,
    ledgerBySeq: _ledgerBySeq,
    historyChecked: _checked,
    historicMirror: _historic,
    requested,
    finished,
    finishedOrder,
    finishedIndexBySeq,
    sideEffects,
    validation,
    ...rest
  } = state;
  if (!state.keyed) {
    return structuredClone({
      ...rest,
      validation,
      requested,
      finished,
      finishedOrder,
      finishedIndexBySeq,
      sideEffects,
      entries: [],
      ledgerBySeq: [],
      historyBase: state.lastSeq,
    });
  }
  const streamFloor =
    state.received?.body.activation.ref.execution === "job" &&
    state.streamProjectionEnabledAfter !== undefined
      ? state.streamProjectedUpTo
      : Number.POSITIVE_INFINITY;
  let omittedUpTo = state.historyInteractionUpTo ?? 0;
  const keptRequested = new Map<string, RequestedInteraction>();
  for (const [requestId, item] of requested) {
    if (state.pendingRequests.has(requestId) || item.recordSeq > streamFloor) {
      keptRequested.set(requestId, item);
    } else {
      omittedUpTo = Math.max(omittedUpTo, item.recordSeq);
    }
  }
  const keptFinished = new Map<string, FinishedInteraction>();
  for (const [requestId, item] of finished) {
    if (item.recordSeq > streamFloor) {
      keptFinished.set(requestId, item);
    } else {
      omittedUpTo = Math.max(omittedUpTo, item.recordSeq);
    }
  }
  const base = state.finishedBase ?? 0;
  const keepFrom = Math.max(base, state.mirroredFinishedCount);
  const keptIndex = new Map(
    [...finishedIndexBySeq].filter(([, index]) => index >= keepFrom),
  );
  const keptEffects = new Map(
    [...sideEffects].filter(([, effect]) => !effect.completed),
  );
  return structuredClone({
    ...rest,
    validation: { ...validation, requestedInteractions: new Set(keptRequested.keys()) },
    requested: keptRequested,
    finished: keptFinished,
    finishedOrder: finishedOrder.slice(keepFrom - base),
    finishedIndexBySeq: keptIndex,
    finishedBase: keepFrom,
    sideEffects: keptEffects,
    entries: [],
    ledgerBySeq: [],
    historyBase: state.lastSeq,
    historyInteractionUpTo: omittedUpTo,
  });
}

export function restoreDecisionState(state: LedgerProjection): LedgerProjection {
  return structuredClone(state);
}

export function ledgerSnapshot(state: LedgerProjection): LedgerSnapshot {
  return {
    v: 1,
    assignmentId: state.assignmentId,
    lastSeq: state.lastSeq,
    phase: state.phase,
    ...(state.sealed
      ? {
          sealedBundleRef: snapshot(
            state.sealed.bundle.ref,
            "Sealed bundle reference",
          ),
        }
      : {}),
    ...(state.phase === "acked"
      ? { acknowledgedCommitRevision: state.acknowledgedCommitRevision }
      : {}),
    ...(state.halted ? { cancelProof: snapshot(state.halted, "Cancel proof") } : {}),
    ...(state.failure
      ? {
          failure: {
            reason: state.failure.reason,
            usageFinal: snapshot(
              state.failure.usageFinal,
              "Execution failure final usage",
            ),
          },
        }
      : {}),
  };
}

export const LEDGER_DECISION_FINGERPRINT_FNS = [
  reduceAssignmentRecord,
  validateAssignmentEntry,
  applyValidatedAssignmentEntry,
  applyEntry,
  emptyProjection,
  decisionSnapshot,
  restoreDecisionState,
] as const;

export const LEDGER_BINDING_FINGERPRINT_FNS = [
  reduceAssignmentRecord,
  extractDataPlaneBinding,
  applyValidatedAssignmentEntry,
  applyEntry,
  emptyProjection,
] as const;

export const JOB_RECOVERY_KEY_PREFIX = "job-recovery-obligation:";

export function jobRecoveryKey(assignmentId: string): string {
  return `${JOB_RECOVERY_KEY_PREFIX}${assignmentId}`;
}

function isReceivedAssignmentEntry(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const inner = (body as { readonly body?: unknown }).body;
  if (!inner || typeof inner !== "object") return false;
  return (inner as { readonly t?: unknown }).t === "received";
}

export async function reduceJobRecoveryIndex(
  envelope: CommitEnvelope<unknown>,
  current: DurableProjectionReadContext,
  verifier: ProtocolSignatureVerifier,
): Promise<readonly DurableProjectionMutation[]> {
  const byAssignment = new Map<
    string,
    {
      value: JobRecoveryIndexValue | undefined;
      touched: boolean;
    }
  >();
  for (const record of envelope.entries) {
    const assignmentId = assignmentIdFromStream(record.stream);
    if (!assignmentId) continue;
    let pending = byAssignment.get(assignmentId);
    if (!pending) {
      const stored = await current.get(jobRecoveryKey(assignmentId));
      pending = {
        value:
          stored === undefined
            ? undefined
            : validateJobRecoveryIndexValue(stored),
        touched: false,
      };
      byAssignment.set(assignmentId, pending);
    }
    if (!pending.value && !isReceivedAssignmentEntry(record.body)) continue;
    const entry = validateAssignmentEntry(record.body, verifier);
    const body = entry.body;
    if (body.t === "received") {
      if (body.activation.ref.execution !== "job") {
        pending.value = undefined;
        pending.touched = true;
        continue;
      }
      pending.value = {
        v: 5,
        assignmentId,
        envelopeRef: body.envelope.ref,
        phase: "received",
        pendingInteractions: 0,
        hasInteractionFacts: false,
        maxFinishedSeq: 0,
        maxFinishedInteractionSeq: 0,
        mirroredUpTo: 0,
        streamProjectedUpTo: 0,
        hasAbort: false,
        hasAbortTicket: false,
        cancelProofOwnerAccepted: false,
        interactionSettlementOwnerAccepted: false,
      };
      pending.touched = true;
      continue;
    }
    if (!pending.value) continue;
    let next = pending.value;
    switch (body.t) {
      case "dispatch-rejected":
        next = { ...next, phase: "dispatch-rejected" };
        break;
      case "supersede-fenced":
        next = { ...next, phase: "supersede-fenced" };
        break;
      case "started":
        next = { ...next, phase: "started" };
        break;
      case "interaction-requested":
        next = {
          ...next,
          pendingInteractions: next.pendingInteractions + 1,
          hasInteractionFacts: true,
        };
        break;
      case "interaction-finished":
        next = {
          ...next,
          pendingInteractions: Math.max(0, next.pendingInteractions - 1),
          hasInteractionFacts: true,
          maxFinishedSeq: Math.max(next.maxFinishedSeq, entry.recordSeq),
          maxFinishedInteractionSeq: Math.max(next.maxFinishedInteractionSeq, entry.recordSeq),
        };
        break;
      case "trust-sediment":
      case "trust-rule-hit":
        next = {
          ...next,
          hasInteractionFacts: true,
          maxFinishedSeq: Math.max(next.maxFinishedSeq, entry.recordSeq),
        };
        break;
      case "abort-requested":
        next = {
          ...next,
          hasAbort: true,
          hasAbortTicket: next.hasAbortTicket || body.via === "abort-ticket",
        };
        break;
      case "halted":
        next = { ...next, phase: "halted" };
        break;
      case "execution-failed":
        next = { ...next, phase: "failed" };
        break;
      case "bundle_sealed":
        next = { ...next, phase: "sealed" };
        break;
      case "acked":
        next = { ...next, phase: "acked" };
        break;
      case "mirrored":
        next = { ...next, mirroredUpTo: body.upTo };
        break;
      case "interaction-stream-projection-enabled":
        next = {
          ...next,
          streamProjectionEnabledAfter: body.legacyUpToRecordSeq,
          streamProjectedUpTo: body.legacyUpToRecordSeq,
        };
        break;
      case "interaction-stream-projected":
        next = {
          ...next,
          streamProjectedUpTo: body.upToRecordSeq,
        };
        break;
      case "cancel-proof-owner-accepted":
        next = {
          ...next,
          cancelProofOwnerAccepted: true,
        };
        break;
      case "interaction-settlement-owner-accepted":
        next = {
          ...next,
          interactionSettlementOwnerAccepted: true,
        };
        break;
      default:
        break;
    }
    pending.value = next;
    pending.touched = true;
  }
  const mutations: DurableProjectionMutation[] = [];
  for (const [assignmentId, pending] of byAssignment) {
    if (!pending.touched) continue;
    const value = pending.value;
    const retained =
      value !== undefined &&
      (canProduceJobRecoveryObligation(value) ||
        hasRecoverableJobObligation(value));
    mutations.push(
      value && retained
        ? {
            kind: "put",
            key: jobRecoveryKey(assignmentId),
            value: value as unknown as JsonValue,
          }
        : {
            kind: "tombstone",
            key: jobRecoveryKey(assignmentId),
          },
    );
  }
  return mutations;
}

export function validateJobRecoveryIndexValue(
  input: JsonValue,
): JobRecoveryIndexValue {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw corruptJobRecoveryProjection("Job recovery index value is invalid");
  }
  const value = input as Record<string, JsonValue>;
  const keys = Object.keys(value).sort();
  const expected = [
    "assignmentId",
    "cancelProofOwnerAccepted",
    "envelopeRef",
    "hasAbort",
    "hasAbortTicket",
    "hasInteractionFacts",
    "interactionSettlementOwnerAccepted",
    "maxFinishedInteractionSeq",
    "maxFinishedSeq",
    "mirroredUpTo",
    "pendingInteractions",
    "phase",
    ...(Object.hasOwn(value, "streamProjectionEnabledAfter")
      ? ["streamProjectionEnabledAfter"]
      : []),
    "streamProjectedUpTo",
    "v",
  ].sort();
  if (canonicalize(keys) !== canonicalize(expected)) {
    throw corruptJobRecoveryProjection(
      "Job recovery index value has unknown fields",
    );
  }
  const ref = value.envelopeRef;
  if (
    value.v !== 5 ||
    typeof value.assignmentId !== "string" ||
    !ref ||
    typeof ref !== "object" ||
    Array.isArray(ref) ||
    Object.keys(ref).sort().join(",") !== "bytes,digest" ||
    typeof ref.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(ref.digest) ||
    !Number.isSafeInteger(ref.bytes) ||
    (ref.bytes as number) < 0 ||
    typeof value.hasAbort !== "boolean" ||
    typeof value.hasAbortTicket !== "boolean" ||
    typeof value.cancelProofOwnerAccepted !== "boolean" ||
    typeof value.interactionSettlementOwnerAccepted !== "boolean" ||
    typeof value.hasInteractionFacts !== "boolean" ||
    !Number.isSafeInteger(value.maxFinishedSeq) ||
    (value.maxFinishedSeq as number) < 0 ||
    !Number.isSafeInteger(value.maxFinishedInteractionSeq) ||
    (value.maxFinishedInteractionSeq as number) < 0 ||
    (value.maxFinishedInteractionSeq as number) > (value.maxFinishedSeq as number) ||
    !Number.isSafeInteger(value.mirroredUpTo) ||
    (value.mirroredUpTo as number) < 0 ||
    (value.streamProjectionEnabledAfter !== undefined &&
      (!Number.isSafeInteger(value.streamProjectionEnabledAfter) ||
        (value.streamProjectionEnabledAfter as number) < 0)) ||
    !Number.isSafeInteger(value.streamProjectedUpTo) ||
    (value.streamProjectedUpTo as number) < 0 ||
    !Number.isSafeInteger(value.pendingInteractions) ||
    (value.pendingInteractions as number) < 0 ||
    typeof value.phase !== "string" ||
    ![
      "unknown",
      "received",
      "dispatch-rejected",
      "supersede-fenced",
      "started",
      "halted",
      "failed",
      "sealed",
      "acked",
    ].includes(value.phase)
  ) {
    throw corruptJobRecoveryProjection("Job recovery index value is malformed");
  }
  return value as unknown as JobRecoveryIndexValue;
}

function canProduceJobRecoveryObligation(value: JobRecoveryIndexValue): boolean {
  return value.phase === "received" || value.phase === "started";
}

export function classifyJobRecoveryObligation(
  value: JobRecoveryIndexValue,
): Omit<JobRecoveryObligation, "envelope"> {
  return {
    execution:
      !value.hasAbort &&
      (value.phase === "received" || value.phase === "sealed"),
    cancellation:
      value.hasAbortTicket &&
      !value.cancelProofOwnerAccepted &&
      !value.interactionSettlementOwnerAccepted,
    interaction:
      value.hasInteractionFacts &&
      (value.pendingInteractions > 0 ||
        value.maxFinishedSeq > value.mirroredUpTo ||
        (value.streamProjectionEnabledAfter !== undefined &&
          value.maxFinishedInteractionSeq > value.streamProjectedUpTo)),
  };
}

function hasRecoverableJobObligation(value: JobRecoveryIndexValue): boolean {
  const obligation = classifyJobRecoveryObligation(value);
  return (
    obligation.execution ||
    obligation.cancellation ||
    obligation.interaction
  );
}

export function corruptJobRecoveryProjection(
  message: string,
): JobRecoveryProjectionValueError {
  return new JobRecoveryProjectionValueError(message);
}

export function registerExecutorJobRecoveryProjection(
  log: AuthorityCommitLog,
  verifier: ProtocolSignatureVerifier,
) {
  return log.durableProjection({
    projectionId: "executor-job-interaction-obligations",
    inputs: { families: ["assignment:"] },
    reducerVersion: 6,
    reduce: (envelope, current) =>
      reduceJobRecoveryIndex(envelope, current, verifier),
  });
}
