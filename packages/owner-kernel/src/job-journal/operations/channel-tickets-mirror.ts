import type { ProjectionTransactionDecision } from "@zhixing-ai/core/authority";
import type {
  ChannelInteractionGrant,
  ChannelResponderRef,
  DataPlaneTicket,
  EnvironmentRequirement,
  InteractionAnswerMirrorEntry,
  InteractionMirrorBatch,
  InteractionSettlementStreamProof,
  JobChannelChallengeToken,
  StreamFrame,
  TaskDefinition,
} from "@zhixing-ai/core/contracts";
import {
  assertChannelChallengeActiveAt,
  canonicalize,
  createSignedChannelChallengeToken,
  createSignedChannelInteractionGrant,
  interactionDisplayDigest,
  interactionMirrorBatchDigest,
  interactionMirrorSeed,
  protocolDigest,
  validateChannelInteractionGrant,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type StreamVerifierCheckpoint,
} from "@zhixing-ai/core/protocol";
import type { PendingChannelChallenge } from "../../channel-challenge-outbox.js";
import {
  validateChannelInteractionRelayRecord,
  type ChannelInteractionRelayRecord,
  type JobChannelChallengePreparedRecord,
} from "../../channel-interaction-records.js";
import {
  assertJobMirrorReplayContract,
  corruptJobJournal,
  type JobJournalRecord,
} from "../../job-run-contracts.js";
import type {
  DataPlaneTicketFacts,
  DataPlaneTicketIssueRequest,
} from "../../shared-protocol/contracts.js";
import {
  computeDataPlaneTicketSyncFacts,
  createSignedDomainDataPlaneTicket,
  decideDataPlaneTicketReplayOrConflict,
  decideDataPlaneTicketRevocationState,
  validateDataPlaneTicketSurfaceAndRenewal,
} from "../../shared-protocol/data-plane-ticket-authority.js";
import {
  batchRepeatsDurableRequestId,
  extendsDurableMirrorCursor,
} from "../../shared-protocol/interaction-mirror-preparation.js";
import type { TrustRuleHitBatchState } from "../../trust-rule-hits.js";
import type {
  JobChannelChallengePreparation,
  JobChannelRelayAdoption,
  JobInteractionRoute,
} from "../contracts.js";
import {
  channelRelayFinishedOutcome,
  relayAdoptionAtCursor,
} from "../state/channel-tickets-mirror.js";
import { jobRecord, snapshot } from "../state/common.js";
import type { JobDecisionFacts } from "../state/views.js";

export function decideIssueDataPlaneTicket(input: {
  readonly taskId: string;
  readonly request: DataPlaneTicketIssueRequest;
  readonly issuedAt: string;
  readonly signer: ProtocolSigner;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment" | "channel">;
}): ProjectionTransactionDecision<unknown, DataPlaneTicket> {
  const { task, assignment, channel } = input.facts;
  const { request } = input;
  const existing = channel.getTicket(request.ticketId);
  const replay = decideDataPlaneTicketReplayOrConflict({
    existing,
    existingReplacementId: channel.getTicketReplacement(request.ticketId),
    request,
  });
  if (replay) {
    return { kind: "return", value: replay };
  }
  const assigned = assignment.getAssigned(request.assignmentId);
  const runState = assigned
    ? assignment.getRunState(assigned.record.jobRunId)?.state
    : undefined;
  if (
    !assigned ||
    !assigned.acked ||
    assignment.getAssignmentIdForJob(assigned.record.jobRunId) !==
      request.assignmentId ||
    (runState !== "dispatched" && runState !== "running") ||
    assignment.getCancelFence(request.assignmentId) !== undefined
  ) {
    throw new Error("Ticket requires a current acknowledged assignment");
  }
  const ingress = task.getIngress(assigned.record.jobRunId);
  if (!ingress) {
    throw new Error("Scheduled jobs cannot receive data-plane tickets");
  }
  const replaced = request.replacesTicketId
    ? channel.getTicket(request.replacesTicketId)
    : undefined;
  validateDataPlaneTicketSurfaceAndRenewal({
    request,
    expectedSurfacePrincipal: ingress.surfacePrincipal,
    replacedTicket: replaced,
    isReplacedTicketRevoked:
      request.replacesTicketId !== undefined &&
      channel.isTicketRevoked(request.replacesTicketId),
  });
  const ticket = createSignedDomainDataPlaneTicket({
    request,
    ref: {
      execution: "job",
      jobRunId: assigned.record.jobRunId,
      taskId: input.taskId,
      anchorEpoch: assigned.record.anchorEpoch,
    },
    executorId: assigned.record.executorId,
    issuedAt: input.issuedAt,
    signer: input.signer,
  });
  return {
    kind: "append",
    entries: [
      jobRecord(input.taskId, {
        t: "ticket-issued",
        ticket,
        ...(request.replacesTicketId === undefined
          ? {}
          : { replacesTicketId: request.replacesTicketId }),
      }),
      ...(request.replacesTicketId === undefined
        ? []
        : [
            jobRecord(input.taskId, {
              t: "ticket-revoked" as const,
              ticketId: request.replacesTicketId,
            }),
          ]),
    ],
    value: ticket,
  };
}

export function decideRevokeDataPlaneTicket(
  facts: Pick<JobDecisionFacts, "channel">,
  taskId: string,
  ticketId: string,
): ProjectionTransactionDecision<unknown, boolean> {
  const shouldAppend = decideDataPlaneTicketRevocationState({
    hasTicket: facts.channel.hasTicket(ticketId),
    isRevoked: facts.channel.isTicketRevoked(ticketId),
  });
  if (!shouldAppend) {
    return { kind: "return", value: false };
  }
  return {
    kind: "append",
    entries: [jobRecord(taskId, { t: "ticket-revoked", ticketId })],
    value: true,
  };
}

export function decideDataPlaneTicketFacts(
  facts: Pick<JobDecisionFacts, "channel">,
  taskId: string,
  at: string,
): ProjectionTransactionDecision<unknown, DataPlaneTicketFacts> {
  const { channel } = facts;
  const currentFrontier = channel.ticketSyncFrontier;
  const candidateForAdvance = channel
    .ticketsBetween(currentFrontier, at)
    .map((row) => row.ticket);
  // Look up retained tickets only after advancing or reusing frontier:
  // computeDataPlaneTicketSyncFacts computes nextFrontier first; we query both bounded ranges cleanly.
  const computedAdvance = computeDataPlaneTicketSyncFacts({
    candidateForAdvance,
    candidateForRetained: [],
    currentFrontier,
    at,
    isTicketRevoked: () => false,
  });
  const effectiveFrontier = computedAdvance.nextFrontier ?? currentFrontier;
  const retainedCandidates = channel
    .ticketsBetween(effectiveFrontier, undefined)
    .map((row) => row.ticket);
  const computed = computeDataPlaneTicketSyncFacts({
    candidateForAdvance,
    candidateForRetained: retainedCandidates,
    currentFrontier,
    at,
    isTicketRevoked: (ticketId) => channel.isTicketRevoked(ticketId),
  });
  return computed.nextFrontier === undefined
    ? { kind: "return", value: computed.facts }
    : {
        kind: "append",
        entries: [
          jobRecord(taskId, {
            t: "ticket-sync-frontier",
            expiresThrough: computed.nextFrontier,
          }),
        ],
        value: computed.facts,
      };
}

export function precheckJobMirrorRuleHits(input: {
  readonly assignmentId: string;
  readonly batch: InteractionMirrorBatch;
  readonly batchDigest: string;
  readonly facts: Pick<JobDecisionFacts, "assignment" | "channel">;
}):
  | { readonly prepare: boolean; readonly environment: EnvironmentRequirement }
  | undefined {
  const { assignment, channel } = input.facts;
  const current = assignment.getAssigned(input.assignmentId);
  if (!current) return undefined;
  const environment = structuredClone(
    current.envelope.manifest.environment as EnvironmentRequirement,
  );
  if (
    channel.hasInteractionMirrorBatch(
      `${input.assignmentId}:${input.batchDigest}`,
    )
  ) {
    return { prepare: false, environment };
  }
  const mirrored = channel.getInteractionMirror(input.assignmentId);
  const last = input.batch.entries.at(-1)!;
  const auditSettlement =
    channel.getCompletedSettlement(input.assignmentId) !== undefined
      ? undefined
      : channel.getSettlementFence(input.assignmentId);
  const cursor = mirrored ?? {
    upTo: 0,
    ordinal: 0,
    digest: interactionMirrorSeed(input.assignmentId),
    requestIds: new Set<string>(),
    outcomes: new Map(),
  };
  try {
    assertJobMirrorReplayContract({
      assignmentExists: true,
      assignmentIsCurrent:
        assignment.getAssignmentIdForJob(current.record.jobRunId) ===
        input.assignmentId,
      executorMatches: current.record.executorId === input.batch.executorId,
      batchBindsRecord: input.batch.assignmentId === input.assignmentId,
      currentState: assignment.getRunState(current.record.jobRunId)?.state,
      hasDurableCancelFence:
        assignment.getCancelFence(input.assignmentId) !== undefined,
      ...(auditSettlement
        ? {
            auditSettlementTarget: {
              upTo: auditSettlement.targetUpTo,
              ordinal: auditSettlement.targetOrdinal,
              mirrorDigest: auditSettlement.targetMirrorDigest,
            },
          }
        : {}),
      batchTarget: {
        upTo: last.seq,
        ordinal: last.ordinal,
        mirrorDigest: input.batch.mirrorDigest,
      },
      batchAlreadyMirrored: false,
      extendsCursor: extendsDurableMirrorCursor(input.batch, cursor),
      repeatsRequestId: batchRepeatsDurableRequestId(
        input.batch,
        cursor.requestIds,
      ),
    });
  } catch {
    return { prepare: false, environment };
  }
  return { prepare: true, environment };
}

export function selectTrustSedimentPreparationTarget(
  facts: Pick<JobDecisionFacts, "assignment" | "channel">,
  assignmentId: string,
  batchKey: string,
):
  | {
      readonly executorId: string;
      readonly environment: EnvironmentRequirement;
      readonly outcomes: ReadonlyMap<
        string,
        InteractionAnswerMirrorEntry["outcome"]
      >;
    }
  | undefined {
  const current = facts.assignment.getAssigned(assignmentId);
  if (!current || facts.channel.hasInteractionMirrorBatch(batchKey)) {
    return undefined;
  }
  return {
    executorId: current.record.executorId,
    environment: structuredClone(
      current.envelope.manifest.environment as EnvironmentRequirement,
    ),
    outcomes: new Map(
      facts.channel.getInteractionMirror(assignmentId)?.outcomes ?? [],
    ),
  };
}

export function decideCommitInteractionMirror(input: {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly batch: InteractionMirrorBatch;
  readonly authorizeReplay: () => void;
  readonly authorizeActiveOrSettlement: (mode: "active" | "settlement") => void;
  readonly facts: Pick<JobDecisionFacts, "assignment" | "channel">;
}): ProjectionTransactionDecision<
  unknown,
  {
    readonly mirroredUpTo: number;
    readonly ordinal: number;
    readonly mirrorDigest: string;
  }
> {
  const { assignment, channel } = input.facts;
  const { assignmentId, batch } = input;
  const last = batch.entries.at(-1)!;
  const batchKey = `${assignmentId}:${interactionMirrorBatchDigest(batch)}`;
  if (channel.hasInteractionMirrorBatch(batchKey)) {
    input.authorizeReplay();
    return {
      kind: "return",
      value: {
        mirroredUpTo: last.seq,
        ordinal: last.ordinal,
        mirrorDigest: batch.mirrorDigest,
      },
    };
  }
  const assigned = assignment.getAssigned(assignmentId);
  const currentState = assigned
    ? assignment.getRunState(assigned.record.jobRunId)?.state
    : undefined;
  const mirrored = channel.getInteractionMirror(assignmentId) ?? {
    upTo: 0,
    ordinal: 0,
    digest: interactionMirrorSeed(assignmentId),
    requestIds: new Set<string>(),
    outcomes: new Map(),
  };
  const auditSettlement =
    channel.getCompletedSettlement(assignmentId) !== undefined
      ? undefined
      : channel.getSettlementFence(assignmentId);
  assertJobMirrorReplayContract({
    assignmentExists: assigned !== undefined,
    assignmentIsCurrent:
      assigned !== undefined &&
      assignment.getAssignmentIdForJob(assigned.record.jobRunId) ===
        assignmentId,
    executorMatches: assigned?.record.executorId === batch.executorId,
    batchBindsRecord: batch.assignmentId === assignmentId,
    currentState,
    hasDurableCancelFence: assignment.getCancelFence(assignmentId) !== undefined,
    ...(auditSettlement
      ? {
          auditSettlementTarget: {
            upTo: auditSettlement.targetUpTo,
            ordinal: auditSettlement.targetOrdinal,
            mirrorDigest: auditSettlement.targetMirrorDigest,
          },
        }
      : {}),
    batchTarget: {
      upTo: last.seq,
      ordinal: last.ordinal,
      mirrorDigest: batch.mirrorDigest,
    },
    batchAlreadyMirrored: false,
    extendsCursor: extendsDurableMirrorCursor(batch, mirrored),
    repeatsRequestId: batchRepeatsDurableRequestId(batch, mirrored.requestIds),
  });
  input.authorizeActiveOrSettlement(
    auditSettlement ||
      currentState === "uncertain" ||
      currentState === "cancel-requested"
      ? "settlement"
      : "active",
  );
  return {
    kind: "append",
    entries: [
      jobRecord(input.taskId, {
        t: "interaction-mirror",
        assignmentId,
        batch,
      }),
    ],
    value: {
      mirroredUpTo: last.seq,
      ordinal: last.ordinal,
      mirrorDigest: batch.mirrorDigest,
    },
  };
}

export function selectTrustRuleHitBatchState(
  facts: Pick<JobDecisionFacts, "channel">,
  assignmentId: string,
  batchDigest: string,
): TrustRuleHitBatchState {
  if (facts.channel.hasInteractionMirrorBatch(`${assignmentId}:${batchDigest}`)) {
    return "committed";
  }
  return facts.channel.isMirrorClosed(assignmentId) ? "rejected" : "unknown";
}

export function decideCompleteInteractionSettlement(input: {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly proof: InteractionSettlementStreamProof | undefined;
  readonly authorizeReplay: () => void;
  readonly authorizeSettlement: () => void;
  readonly facts: Pick<JobDecisionFacts, "channel">;
}): ProjectionTransactionDecision<unknown, void> {
  const { channel } = input.facts;
  const { assignmentId, proof } = input;
  const completed = channel.getCompletedSettlement(assignmentId) as
    | Extract<JobJournalRecord, { t: "interaction-settlement-completed" }>
    | undefined;
  if (completed) {
    const completedProof =
      "v" in completed && completed.v === 2 ? completed.streamProof : undefined;
    if (
      completedProof === undefined
        ? proof !== undefined
        : !proof || canonicalize(completedProof) !== canonicalize(proof)
    ) {
      throw new Error(
        "Job interaction settlement replay has a conflicting stream proof",
      );
    }
    input.authorizeReplay();
    return { kind: "return", value: undefined };
  }
  const fence = channel.getSettlementFence(assignmentId) as
    | Extract<JobJournalRecord, { t: "interaction-settlement-fence" }>
    | undefined;
  if (!fence) {
    throw new Error(
      "Job interaction settlement has no durable audit obligation",
    );
  }
  const mirrored = channel.getInteractionMirror(assignmentId);
  if (
    mirrored?.upTo !== fence.targetUpTo ||
    mirrored.ordinal !== fence.targetOrdinal ||
    mirrored.digest !== fence.targetMirrorDigest
  ) {
    throw new Error(
      "Job interaction settlement has not reached its durable mirror target",
    );
  }
  if (
    "v" in fence &&
    fence.v === 2 &&
    fence.targetInteractionRecordSeq !== undefined
  ) {
    if (
      !proof ||
      proof.assignmentId !== assignmentId ||
      proof.executorId !== fence.executorId ||
      proof.ticketDigest !== fence.ticketDigest ||
      proof.sourceLastSeq !== fence.sourceLastSeq ||
      proof.sourceChainDigest !== fence.sourceChainDigest ||
      proof.targetInteractionRecordSeq !== fence.targetInteractionRecordSeq ||
      proof.upToRecordSeq < fence.targetInteractionRecordSeq
    ) {
      throw new Error(
        "Versioned interaction settlement lacks its executor stream proof",
      );
    }
  } else if (proof !== undefined) {
    throw new Error(
      "Interaction settlement without a stream target cannot consume a stream proof",
    );
  }
  input.authorizeSettlement();
  return {
    kind: "append",
    entries: [
      jobRecord(input.taskId, {
        ...fence,
        t: "interaction-settlement-completed",
        ...(proof ? { streamProof: proof } : {}),
      }),
    ],
    value: undefined,
  };
}

export function selectPendingInteractionSettlements(
  facts: Pick<JobDecisionFacts, "channel">,
): readonly Extract<
  JobJournalRecord,
  { readonly t: "interaction-settlement-fence" }
>[] {
  const { channel } = facts;
  return channel
    .listPendingSettlementIdsSorted()
    .map(
      (assignmentId) =>
        channel.getSettlementFence(assignmentId)! as Extract<
          JobJournalRecord,
          { readonly t: "interaction-settlement-fence" }
        >,
    )
    .filter((fence) => channel.getCompletedSettlement(fence.assignmentId) === undefined)
    .map((fence) => snapshot(fence));
}

export function selectChannelRelayPreparation(input: {
  readonly frame: StreamFrame;
  readonly ref: Extract<StreamFrame["ref"], { execution: "job" }>;
  readonly event: Extract<
    Extract<StreamFrame["payload"], { kind: "interaction" }>["event"],
    { t: "requested" }
  >;
  readonly issuedAt: string;
  readonly expiry: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): JobChannelChallengePreparation {
  const { task, assignment } = input.facts;
  const assigned = assignment.getAssigned(input.frame.assignmentId);
  const occurrence = assigned
    ? task.getOccurrence(assigned.record.jobRunId)
    : undefined;
  const definition = occurrence
    ? (task.requireDefinitionRevision(occurrence.taskRevision) as TaskDefinition)
    : undefined;
  if (
    !assigned ||
    assigned.record.jobRunId !== input.ref.jobRunId ||
    assigned.record.anchorEpoch !== input.ref.anchorEpoch
  ) {
    throw new TypeError(
      "Job channel request does not bind the current assignment",
    );
  }
  if (task.getIngress(assigned.record.jobRunId) !== undefined) {
    throw new Error("Manual jobs cannot use the scheduled channel-grant route");
  }
  if (
    !definition ||
    definition.definition.kind !== "user" ||
    !definition.definition.origin ||
    !definition.definition.interactionResponder
  ) {
    return { kind: "no-interactive-surface" as const };
  }
  const challengeId = protocolDigest("ChannelChallengeIdentity", 1, {
    ref: input.ref,
    assignmentId: input.frame.assignmentId,
    interactionRequestId: input.event.requestId,
  });
  const token = createSignedChannelChallengeToken(
    {
      v: 1,
      challengeId,
      ref: input.ref,
      assignmentId: input.frame.assignmentId,
      interactionRequestId: input.event.requestId,
      route: definition.definition.origin,
      displayDigest: interactionDisplayDigest(
        input.event.toolName,
        input.event.display,
      ),
      issuedAt: input.issuedAt,
      expiry: input.expiry,
    },
    input.signer,
  );
  const prepared = validateChannelInteractionRelayRecord(
    {
      t: "channel-challenge-prepared",
      ref: input.ref,
      assignmentId: input.frame.assignmentId,
      frameSeq: input.frame.seq,
      token,
      responder: definition.definition.interactionResponder,
      toolName: input.event.toolName,
      display: input.event.display,
    },
    input.verifier,
  ) as JobChannelChallengePreparedRecord;
  return { kind: "prepared" as const, prepared };
}

export function decideAdoptChannelRelayFrame(input: {
  readonly taskId: string;
  readonly frame: StreamFrame;
  readonly ref: Extract<StreamFrame["ref"], { execution: "job" }>;
  readonly checkpoint: StreamVerifierCheckpoint;
  readonly prepared: JobChannelChallengePreparedRecord | undefined;
  readonly cursor: Extract<
    ChannelInteractionRelayRecord,
    { readonly t: "channel-relay-cursor" }
  >;
  readonly at: string;
  readonly facts: Pick<JobDecisionFacts, "assignment" | "channel">;
}): ProjectionTransactionDecision<unknown, JobChannelRelayAdoption> {
  const { assignment, channel } = input.facts;
  const { frame, ref, checkpoint, prepared, cursor } = input;
  const assigned = assignment.getAssigned(frame.assignmentId);
  if (
    !assigned ||
    assigned.record.jobRunId !== ref.jobRunId ||
    assigned.record.anchorEpoch !== ref.anchorEpoch
  ) {
    throw new TypeError(
      "Channel relay frame does not bind the current assignment",
    );
  }
  const current = channel.channelInteractions.cursorByAssignment.get(
    frame.assignmentId,
  );
  if (current) {
    if (frame.seq < current.upToSeq) {
      throw new TypeError("Channel relay frame precedes the durable cursor");
    }
    if (frame.seq === current.upToSeq) {
      if (canonicalize(current) !== canonicalize(cursor)) {
        throw new TypeError(
          "Channel relay frame conflicts with the durable cursor",
        );
      }
      return {
        kind: "return",
        value: relayAdoptionAtCursor(
          channel.channelInteractions,
          frame.assignmentId,
          frame,
          current.checkpoint,
        ),
      };
    }
  }
  if (frame.seq !== (current?.upToSeq ?? 0) + 1) {
    throw new TypeError("Channel relay frame skips the durable cursor");
  }

  const records: ChannelInteractionRelayRecord[] = [];
  let adoptedPrepared: JobChannelChallengePreparedRecord | undefined;
  let closed:
    | Extract<
        ChannelInteractionRelayRecord,
        { readonly t: "channel-challenge-closed" }
      >
    | undefined;
  if (
    frame.payload.kind === "interaction" &&
    frame.payload.event.t === "requested"
  ) {
    if (!prepared) {
      const mirroredOutcome = channel
        .getInteractionMirror(frame.assignmentId)
        ?.outcomes.get(frame.payload.event.requestId);
      if (!mirroredOutcome || mirroredOutcome.t === "answered") {
        throw new TypeError(
          "Channel interaction request without a prepared challenge requires a matching non-answered durable terminal result",
        );
      }
    } else {
      if (
        canonicalize(prepared.ref) !== canonicalize(frame.ref) ||
        prepared.assignmentId !== frame.assignmentId ||
        prepared.frameSeq !== frame.seq ||
        prepared.token.interactionRequestId !== frame.payload.event.requestId ||
        prepared.toolName !== frame.payload.event.toolName ||
        canonicalize(prepared.display) !==
          canonicalize(frame.payload.event.display) ||
        prepared.token.issuedAt < frame.payload.event.issuedAt ||
        prepared.token.expiry > frame.payload.event.expiresAt
      ) {
        throw new TypeError(
          "Prepared channel challenge does not bind its stream frame",
        );
      }
      adoptedPrepared = prepared;
      records.push(prepared);
    }
  } else if (prepared) {
    throw new TypeError(
      "Only an interaction request can carry a prepared record",
    );
  }

  if (
    frame.payload.kind === "interaction" &&
    frame.payload.event.t === "finished"
  ) {
    const interactionKey = `${frame.assignmentId}\u0000${frame.payload.event.requestId}`;
    const challengeId =
      channel.channelInteractions.challengeByInteraction.get(interactionKey);
    if (!challengeId) {
      const mirroredOutcome = channel
        .getInteractionMirror(frame.assignmentId)
        ?.outcomes.get(frame.payload.event.requestId);
      if (
        !mirroredOutcome ||
        mirroredOutcome.t === "answered" ||
        channelRelayFinishedOutcome(mirroredOutcome) !==
          frame.payload.event.outcome
      ) {
        throw new TypeError(
          "Channel interaction completion without a prepared challenge does not match a non-answered durable terminal result",
        );
      }
    } else {
      closed = {
        t: "channel-challenge-closed",
        challengeId,
        outcome: frame.payload.event.outcome,
        at: input.at,
      };
      records.push(closed);
    }
  }
  records.push(cursor);

  return {
    kind: "append",
    entries: records.map((record) => jobRecord(input.taskId, record)),
    value: {
      checkpoint,
      ...(adoptedPrepared ? { prepared: adoptedPrepared } : {}),
      ...(closed ? { closed } : {}),
    },
  };
}

export function decideGrantChannelChallenge(input: {
  readonly taskId: string;
  readonly jobToken: JobChannelChallengeToken;
  readonly responder: ChannelResponderRef;
  readonly decision: { readonly allowed: boolean; readonly reason?: string };
  readonly at: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly facts: Pick<JobDecisionFacts, "channel">;
}): ProjectionTransactionDecision<unknown, ChannelInteractionGrant> {
  const { channelInteractions } = input.facts.channel;
  const { jobToken, responder } = input;
  const prepared = channelInteractions.preparedByChallenge.get(
    jobToken.challengeId,
  );
  if (
    !prepared ||
    prepared.ref.execution !== "job" ||
    canonicalize(prepared.token) !== canonicalize(jobToken) ||
    canonicalize(prepared.responder) !== canonicalize(responder) ||
    channelInteractions.closedByChallenge.has(jobToken.challengeId)
  ) {
    throw new TypeError(
      "Job channel callback does not bind a pending challenge",
    );
  }
  const existing = channelInteractions.grantByChallenge.get(
    jobToken.challengeId,
  );
  if (existing) {
    if (
      canonicalize(existing.grant.responder) !== canonicalize(responder) ||
      canonicalize(existing.grant.decision) !== canonicalize(input.decision)
    ) {
      throw new TypeError(
        "Job channel challenge already has a different grant",
      );
    }
    return {
      kind: "return",
      value: structuredClone(existing.grant),
    };
  }
  assertChannelChallengeActiveAt(jobToken, input.at);
  const grant = createSignedChannelInteractionGrant(
    {
      v: 1,
      grantId: protocolDigest("ChannelInteractionGrantIdentity", 1, {
        challengeId: jobToken.challengeId,
      }),
      ref: jobToken.ref,
      assignmentId: jobToken.assignmentId,
      interactionRequestId: jobToken.interactionRequestId,
      challengeToken: jobToken,
      route: jobToken.route,
      responder,
      decision: input.decision,
      issuedAt: input.at,
      expiry: jobToken.expiry,
    },
    input.signer,
    input.verifier,
  );
  const record = validateChannelInteractionRelayRecord(
    {
      t: "channel-challenge-granted",
      jobRunId: jobToken.ref.jobRunId,
      challengeId: jobToken.challengeId,
      grant,
    },
    input.verifier,
  );
  return {
    kind: "append",
    entries: [jobRecord(input.taskId, record)],
    value: validateChannelInteractionGrant(grant, input.verifier),
  };
}

export function decideRecordChannelChallengeDelivered(
  facts: Pick<JobDecisionFacts, "channel">,
  taskId: string,
  challengeId: string,
  record: Extract<
    ChannelInteractionRelayRecord,
    { readonly t: "channel-challenge-delivered" }
  >,
): ProjectionTransactionDecision<unknown, void> {
  const current =
    facts.channel.channelInteractions.deliveredByChallenge.get(challengeId);
  if (current && canonicalize(current) === canonicalize(record)) {
    return { kind: "return", value: undefined };
  }
  return {
    kind: "append",
    entries: [jobRecord(taskId, record)],
    value: undefined,
  };
}

export function decideCloseChannelChallenge(
  facts: Pick<JobDecisionFacts, "channel">,
  taskId: string,
  challengeId: string,
  record: Extract<
    ChannelInteractionRelayRecord,
    { readonly t: "channel-challenge-closed" }
  >,
): ProjectionTransactionDecision<unknown, void> {
  const current =
    facts.channel.channelInteractions.closedByChallenge.get(challengeId);
  if (current && canonicalize(current) === canonicalize(record)) {
    return { kind: "return", value: undefined };
  }
  return {
    kind: "append",
    entries: [jobRecord(taskId, record)],
    value: undefined,
  };
}

export function selectPendingChannelGrantDeliveries(
  facts: Pick<JobDecisionFacts, "channel">,
): readonly ChannelInteractionGrant[] {
  const { channel } = facts;
  return channel
    .listPendingGrantChallengeIds()
    .map((challengeId) => {
      const granted =
        channel.channelInteractions.grantByChallenge.get(challengeId);
      if (!granted) {
        throw corruptJobJournal("Pending channel grant has no durable grant");
      }
      return granted.grant;
    })
    .sort(
      (left, right) =>
        left.assignmentId.localeCompare(right.assignmentId) ||
        left.challengeToken.challengeId.localeCompare(
          right.challengeToken.challengeId,
        ),
    )
    .map((grant) => structuredClone(grant));
}

export function selectPendingChannelChallenges(
  facts: Pick<JobDecisionFacts, "channel">,
): readonly PendingChannelChallenge[] {
  const { channel } = facts;
  return channel
    .listOpenChallengeIds()
    .map((challengeId) => {
      const prepared =
        channel.channelInteractions.preparedByChallenge.get(challengeId);
      if (prepared?.ref.execution !== "job") {
        throw corruptJobJournal(
          "Open channel challenge has no durable job preparation",
        );
      }
      return prepared as JobChannelChallengePreparedRecord;
    })
    .sort(
      (left, right) =>
        left.assignmentId.localeCompare(right.assignmentId) ||
        left.frameSeq - right.frameSeq,
    )
    .map((prepared) => {
      const delivered = channel.channelInteractions.deliveredByChallenge.get(
        prepared.token.challengeId,
      );
      return {
        prepared: structuredClone(prepared),
        ...(delivered ? { delivered: structuredClone(delivered) } : {}),
      };
    });
}

export function selectInteractionRoute(
  facts: Pick<JobDecisionFacts, "task" | "assignment">,
  assignmentId: string,
): JobInteractionRoute {
  const { task, assignment } = facts;
  const assigned = assignment.getAssigned(assignmentId);
  if (!assigned) throw new Error("Interaction route assignment is unknown");
  if (
    assignment.getAssignmentIdForJob(assigned.record.jobRunId) !== assignmentId
  ) {
    throw new Error("Interaction route requires the current assignment");
  }
  const ingress = task.getIngress(assigned.record.jobRunId);
  if (ingress) {
    return {
      kind: "surface-ticket" as const,
      ingress: snapshot(ingress as import("@zhixing-ai/core/contracts").IngressContext),
    };
  }
  const occurrence = task.getOccurrence(assigned.record.jobRunId);
  const definition = occurrence
    ? (task.requireDefinitionRevision(occurrence.taskRevision) as TaskDefinition)
    : undefined;
  return definition?.definition.kind === "user" &&
    definition.definition.origin &&
    definition.definition.interactionResponder
    ? { kind: "channel-grant" as const }
    : { kind: "no-interactive-surface" as const };
}
