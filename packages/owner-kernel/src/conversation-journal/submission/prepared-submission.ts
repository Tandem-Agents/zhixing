import type {
  ArtifactStore,
  ProjectionTransactionContext,
  ProjectionTransactionDecision,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  EnvironmentRequirement,
  GlobalStagedMutation,
  IngressContext,
  LogicalRecord,
  MutationBatch,
  PublishRecord,
  SessionStagedMutation,
  TranscriptRunRecord,
  TrustRuleHitMirrorEntry,
  TrustSedimentMirrorEntry,
} from "@zhixing-ai/core/contracts";
import { admittedConversationRunLifecycleSource } from "@zhixing-ai/core/delivery";
import {
  canonicalize,
  validateAuthorityError as validateAuthorityErrorContract,
  type ConversationInteractionMirrorBatch,
  type validateConversationSealedBundle,
} from "@zhixing-ai/core/protocol";
import { validateWorksceneContinuationCommit } from "@zhixing-ai/core/workscene/application";
import {
  corruptRunJournal,
  historicalBundleFenceMatches,
} from "../../conversation-run-contracts.js";
import type {
  ConversationDeliveryCommitInput,
  ConversationDeliveryParticipant,
} from "../../delivery-participant.js";
import type { AssignmentBundleSubmissionResult } from "../../shared-protocol/contracts.js";
import type {
  TrustRuleHitBatchInput,
  TrustRuleHitBatchState,
  TrustRuleHitPort,
} from "../../trust-rule-hits.js";
import type {
  ConversationCommitAuthority,
  ConversationMutationPublisher,
  ConversationTrustSedimentPort,
} from "../contracts.js";
import { decideSubmitBundleCompanionEntries } from "../operations/terminal-commit.js";
import {
  BundleClosureError,
  compileConversationDeliveryContents,
  validateConversationBundleClosure,
  type CompiledConversationDeliveryContents,
  type ValidatedConversationBundleClosure,
} from "../replay/bundle-binding.js";
import { requireAssignedEnvelope } from "../state/assignment-control.js";
import { runStream, snapshot } from "../state/common.js";
import {
  assertGlobalMutationRecords,
  indexGlobalPublishBatchOutcomes,
  rejected,
} from "../state/commit-publish.js";
import type {
  ConversationDecisionFacts,
  ReadonlyAssignedFact,
} from "../state/views.js";

export interface PreparedConversationGlobalRecord {
  readonly seq: number;
  readonly requestId: string;
  readonly mutation: GlobalStagedMutation;
}

export interface PreparedConversationSubmission {
  readonly bundle: ReturnType<typeof validateConversationSealedBundle>;
  readonly artifactRef: ArtifactRef;
  readonly batch?: MutationBatch;
  readonly committedRunRecord: TranscriptRunRecord;
  readonly compiledDelivery: CompiledConversationDeliveryContents;
  readonly globalStagedRecords: readonly PreparedConversationGlobalRecord[];
  readonly candidateReferences: readonly ArtifactRef[];
}

export async function prepareConversationBundleSubmission(input: {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly bundle: ReturnType<typeof validateConversationSealedBundle>;
  readonly artifactRef: ArtifactRef;
  readonly preflightAssigned: ReadonlyAssignedFact;
  readonly guardIngress: IngressContext;
  readonly artifacts: ArtifactStore;
  readonly publisher: ConversationMutationPublisher | undefined;
}): Promise<
  | {
      readonly kind: "rejected";
      readonly result: AssignmentBundleSubmissionResult;
    }
  | {
      readonly kind: "prepared";
      readonly prepared: PreparedConversationSubmission;
    }
> {
  const { bundle, artifactRef, preflightAssigned } = input;
  const preflightBody = bundle.body;
  if (
    preflightBody.conversationId !== input.conversationId ||
    preflightBody.runId !== preflightAssigned.record.runId ||
    preflightBody.ownerEpoch !== input.ownerEpoch ||
    !historicalBundleFenceMatches({
      assignedExecutorId: preflightAssigned.record.executorId,
      assignedOwnerEpoch: preflightAssigned.record.ownerEpoch,
      assignedBaseRevision: preflightAssigned.record.baseRevision,
      bundleExecutorId: bundle.executorId,
      bundleOwnerEpoch: preflightBody.ownerEpoch,
      bundleBaseRevision: preflightBody.baseRevision,
      conflictOpen: false,
    })
  ) {
    return {
      kind: "rejected",
      result: rejected(
        "fence-rejected",
        "Bundle fence does not match the durable assignment",
        false,
      ),
    };
  }
  let closure: ValidatedConversationBundleClosure;
  try {
    closure = await validateConversationBundleClosure(bundle, input.artifacts);
  } catch (error) {
    if (error instanceof BundleClosureError) {
      return {
        kind: "rejected",
        result: rejected(
          error.code,
          error.message,
          error.code === "missing-base",
        ),
      };
    }
    throw error;
  }
  const {
    artifact: closedArtifact,
    batch,
    references,
    runRecord: committedRunRecord,
  } = closure;
  try {
    validateWorksceneContinuationCommit(
      committedRunRecord,
      requireAssignedEnvelope(preflightAssigned).work,
    );
  } catch (error) {
    return {
      kind: "rejected",
      result: rejected(
        "fence-rejected",
        error instanceof Error ? error.message : "Invalid workscene commit",
        false,
      ),
    };
  }
  if (canonicalize(closedArtifact.ref) !== canonicalize(artifactRef)) {
    throw new Error("Bundle closure changed its artifact identity");
  }
  if (
    batch?.records.some(
      (record) =>
        record.domain === "global" &&
        record.mutation.kind !== "delivery-enqueue",
    ) &&
    !input.publisher
  ) {
    return {
      kind: "rejected",
      result: rejected(
        "capability-gap",
        "Global staged mutation publisher is not configured",
        false,
      ),
    };
  }
  const compiledDelivery = await compileConversationDeliveryContents(
    committedRunRecord,
    batch,
    input.artifacts,
    input.guardIngress,
  );
  const globalStagedRecords = Object.freeze(
    (batch?.records ?? []).flatMap((record) =>
      record.domain === "global" &&
      record.mutation.kind !== "delivery-enqueue"
        ? [
            Object.freeze({
              seq: record.seq,
              requestId: record.requestId,
              mutation: record.mutation as GlobalStagedMutation,
            }),
          ]
        : [],
    ),
  );
  const stagedReferences = globalStagedRecords.length
    ? ((await input.publisher?.collectStagedReferences?.(globalStagedRecords)) ??
        [])
    : [];
  const candidateReferences = Object.freeze([
    ...references,
    ...compiledDelivery.references,
    ...stagedReferences,
  ]);
  return {
    kind: "prepared",
    prepared: Object.freeze<PreparedConversationSubmission>({
      bundle,
      artifactRef,
      ...(batch ? { batch } : {}),
      committedRunRecord,
      compiledDelivery,
      globalStagedRecords,
      candidateReferences,
    }),
  };
}

export async function prepareBundleCompanionRecordsAtPrefix(input: {
  readonly conversationId: string;
  readonly assigned: ReadonlyAssignedFact;
  readonly currentRunState:
    | "dispatched"
    | "running"
    | "cancel-requested"
    | "uncertain";
  readonly prepared: PreparedConversationSubmission;
  readonly authorityPrefix: ProjectionTransactionContext;
  readonly authority: ConversationCommitAuthority;
  readonly delivery: ConversationDeliveryParticipant | undefined;
  readonly publisher: ConversationMutationPublisher | undefined;
  readonly currentAuthority:
    | {
        readonly deviceId: string;
        readonly executorId?: string;
      }
    | undefined;
  readonly clockAt: () => string;
  readonly onAppendedGlobalRecords: (
    records: readonly PreparedConversationGlobalRecord[],
  ) => void;
  readonly facts: Pick<
    ConversationDecisionFacts,
    "session" | "queueInput" | "assignment" | "commitPublish"
  >;
}): Promise<ProjectionTransactionDecision<unknown, AssignmentBundleSubmissionResult>> {
  const { prepared, assigned, authorityPrefix, facts } = input;
  const { bundle, batch, committedRunRecord, compiledDelivery, artifactRef } =
    prepared;
  const body = bundle.body;
  const sessionRecords = (batch?.records ?? [])
    .filter((record) => record.domain === "session")
    .map((record) => ({
      seq: record.seq,
      mutation: record.mutation as SessionStagedMutation,
      requestId: record.requestId,
    }));
  const authorityDecision = snapshot(
    input.authority.decideAtPrefix({
      assignmentId: bundle.assignmentId,
      authorityPrefixLsn: authorityPrefix.lastLsn,
      conversationId: input.conversationId,
      ownerEpoch: body.ownerEpoch,
      baseRevision: body.baseRevision,
      runRecord: committedRunRecord,
      sessionMutations: sessionRecords,
    }),
    "Conversation commit authority decision",
  );
  if (!authorityDecision.committed) {
    validateAuthorityErrorContract(authorityDecision.error);
    return { kind: "return", value: authorityDecision };
  }
  const commitRevision = authorityDecision.commitRevision;
  if (
    !Number.isSafeInteger(commitRevision) ||
    commitRevision <= 0 ||
    commitRevision !== body.baseRevision + 1 ||
    commitRevision <= (facts.commitPublish.latestCommit?.commitRevision ?? 0)
  ) {
    return {
      kind: "return",
      value: rejected(
        "revision-conflict",
        "Conversation authority returned an invalid commit revision",
        false,
      ),
    };
  }
  const outcomes: Extract<PublishRecord, { t: "publish-decision" }>["outcomes"] =
    [];
  let globalMutationRecords: readonly LogicalRecord<unknown>[] = [];
  const admitted = facts.queueInput.getAdmitted(body.runId);
  if (!admitted) {
    throw corruptRunJournal("Committed run has no durable ingress");
  }
  const runLifecycleSource = admittedConversationRunLifecycleSource({
    conversationId: input.conversationId,
    runId: body.runId,
    queuedPosition: admitted.record.queuedPosition,
  });
  const deliveryInput: ConversationDeliveryCommitInput = {
    at: authorityPrefix.at,
    conversationId: input.conversationId,
    runId: body.runId,
    assignmentId: bundle.assignmentId,
    commitRevision,
    conversationLifecycleSource: runLifecycleSource,
    assignmentLifecycleSource: {
      owner: "assignment",
      id: `${assigned.record.executorId === input.currentAuthority?.executorId ? "local" : "relay"}:${bundle.assignmentId}`,
      revision: assigned.record.dispatchDigest,
    },
    stagedDeliveryLifecycleSource: runLifecycleSource,
    ingress: admitted.record.ingress as IngressContext,
    runRecord: committedRunRecord,
    ...(batch ? { mutationBatch: batch } : {}),
    ...(compiledDelivery.final
      ? { finalContent: compiledDelivery.final.content }
      : {}),
    stagedContents: compiledDelivery.stagedContents,
    stagedContentErrors: compiledDelivery.stagedContentErrors,
  };
  if (
    !input.delivery &&
    (deliveryInput.ingress.kind === "channel" ||
      batch?.records.some(
        (record) => record.mutation.kind === "delivery-enqueue",
      ))
  ) {
    return {
      kind: "return",
      value: rejected(
        "capability-gap",
        "This conversation owner has no durable external delivery capability",
        false,
      ),
    };
  }
  const deliveryDecision =
    (await input.delivery?.prepareConversationCommit(
      deliveryInput,
      authorityPrefix,
    )) ?? {
      accepted: true as const,
      records: [],
      stagedRevisions: new Map(),
      stagedConflicts: new Map(),
    };
  if (!deliveryDecision.accepted) {
    return {
      kind: "return",
      value: { committed: false as const, error: deliveryDecision.error },
    };
  }
  if (batch) {
    const globalRecords = batch.records
      .filter(
        (record) =>
          record.domain === "global" &&
          record.mutation.kind !== "delivery-enqueue",
      )
      .map((record) => ({
        seq: record.seq,
        mutation: record.mutation as GlobalStagedMutation,
        requestId: record.requestId,
        expected: record.expected!,
      }));
    const globalInput = {
      assignmentId: bundle.assignmentId,
      authorityPrefixLsn: authorityPrefix.lastLsn,
      authorityContext: authorityPrefix,
      records: globalRecords,
    };
    const preparedGlobal =
      globalRecords.length === 0
        ? { outcomes: [] as const, records: [] as const }
        : await (input.publisher!.prepareGlobalBatchAtPrefix?.(globalInput) ??
            Promise.resolve(
              input.publisher!.decideGlobalBatchAtPrefix(globalInput),
            ).then((decidedOutcomes) => ({
              outcomes: decidedOutcomes,
              records: [] as const,
            })));
    assertGlobalMutationRecords(
      preparedGlobal.records,
      runStream(input.conversationId),
    );
    globalMutationRecords = preparedGlobal.records;
    const globalOutcomes = indexGlobalPublishBatchOutcomes(
      globalRecords,
      preparedGlobal.outcomes,
    );
    const appendedGlobalRecords = globalRecords
      .filter((record) => globalOutcomes.get(record.seq)?.t === "granted")
      .map(({ seq, requestId, mutation }) =>
        Object.freeze({ seq, requestId, mutation }),
      );
    input.onAppendedGlobalRecords(appendedGlobalRecords);
    for (const record of batch.records) {
      if (record.domain === "session") {
        outcomes.push({
          seq: record.seq,
          outcome: { t: "granted", targetRevision: commitRevision },
        });
      } else {
        const outcome =
          record.mutation.kind === "delivery-enqueue"
            ? deliveryDecision.stagedRevisions.has(record.seq)
              ? {
                  t: "granted" as const,
                  targetRevision: deliveryDecision.stagedRevisions.get(
                    record.seq,
                  )!,
                }
              : deliveryDecision.stagedConflicts.has(record.seq)
                ? {
                    t: "conflicted" as const,
                    error: deliveryDecision.stagedConflicts.get(record.seq)!,
                  }
                : undefined
            : globalOutcomes.get(record.seq);
        if (!outcome) {
          throw new TypeError("Global publish batch omitted a mutation");
        }
        outcomes.push({ seq: record.seq, outcome });
      }
    }
  }
  return decideSubmitBundleCompanionEntries({
    conversationId: input.conversationId,
    assigned,
    currentRunState: input.currentRunState,
    bundle,
    artifactRef,
    commitRevision,
    committedRunRecord,
    batch,
    outcomes,
    deliveryRecords: deliveryDecision.records,
    globalMutationRecords,
    clockAt: input.clockAt,
    facts: {
      session: facts.session,
      assignment: facts.assignment,
    },
  });
}

export function decideTrustRuleHitPrecheck(input: {
  readonly assignmentId: string;
  readonly batch: ConversationInteractionMirrorBatch;
  readonly batchDigest: string;
  readonly facts: Pick<ConversationDecisionFacts, "assignment" | "commitPublish">;
}): {
  readonly prepare: boolean;
  readonly environment: EnvironmentRequirement;
} | undefined {
  const { assignment, commitPublish } = input.facts;
  const current = assignment.getAssigned(input.assignmentId);
  if (!current?.envelope) return undefined;
  const mirrorState = commitPublish.getMirrorState(input.assignmentId);
  const first = input.batch.entries[0];
  const runState = assignment.getRunState(current.record.runId)?.state;
  const requestIds = new Set<string>();
  const freshIdentities = input.batch.entries.every((entry) => {
    if (
      requestIds.has(entry.requestId) ||
      mirrorState?.requestIds.has(entry.requestId)
    ) {
      return false;
    }
    requestIds.add(entry.requestId);
    return true;
  });
  const prepare =
    !commitPublish.hasMirrorBatch(input.batchDigest) &&
    !assignment.isAssignmentClosed(input.assignmentId) &&
    assignment.getAssignmentIdForRun(current.record.runId) ===
      input.assignmentId &&
    (runState === "dispatched" ||
      runState === "running" ||
      ((runState === "cancel-requested" || runState === "uncertain") &&
        assignment.getCancelFence(input.assignmentId) !== undefined)) &&
    current.record.executorId === input.batch.executorId &&
    mirrorState !== undefined &&
    first !== undefined &&
    input.batch.previousDigest === mirrorState.mirrorDigest &&
    first.ordinal === mirrorState.ordinal + 1 &&
    first.seq > mirrorState.mirroredUpTo &&
    freshIdentities;
  return {
    prepare,
    environment: structuredClone(
      current.envelope.manifest.environment,
    ) as EnvironmentRequirement,
  };
}

export interface TrustRuleHitMirrorSession {
  readonly target?: TrustRuleHitBatchInput;
  readonly prepared: boolean;
  settleAfterError(): Promise<void>;
  acceptCommitted(): Promise<void>;
}

/**
 * 单次镜像投递的规则命中准备会话：在进入可重试事务前最多准备一次，
 * 事务因工作集变化重跑时绝不重复 prepare；最终最多结算一次。
 */
export async function prepareTrustRuleHitMirrorSession(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly batch: ConversationInteractionMirrorBatch;
  readonly batchDigest: string;
  readonly hits: readonly TrustRuleHitMirrorEntry[];
  readonly trustRuleHits: TrustRuleHitPort | undefined;
  readonly selectPrecheck: () => Promise<
    | {
        readonly prepare: boolean;
        readonly environment: EnvironmentRequirement;
      }
    | undefined
  >;
  readonly selectBatchCommitted: () => Promise<boolean>;
}): Promise<TrustRuleHitMirrorSession> {
  if (!input.trustRuleHits || input.hits.length === 0) {
    return Object.freeze({
      prepared: false,
      settleAfterError: async () => undefined,
      acceptCommitted: async () => undefined,
    });
  }
  const checked = await input.selectPrecheck();
  if (!checked) {
    return Object.freeze({
      prepared: false,
      settleAfterError: async () => undefined,
      acceptCommitted: async () => undefined,
    });
  }
  const target: TrustRuleHitBatchInput = {
    origin: { conversationId: input.conversationId },
    assignmentId: input.assignmentId,
    environment: checked.environment,
    batchDigest: input.batchDigest,
    entries: input.hits,
  };
  if (checked.prepare) {
    await input.trustRuleHits.prepare(target);
  }
  let settled = false;
  return Object.freeze({
    target,
    prepared: checked.prepare,
    settleAfterError: async () => {
      if (settled || !checked.prepare) return;
      settled = true;
      const committed = await input.selectBatchCommitted().catch(() => undefined);
      if (committed === true) {
        await input.trustRuleHits!.accept(target).catch(() => undefined);
      } else if (committed === false) {
        await input.trustRuleHits!.discard(target).catch(() => undefined);
      }
    },
    acceptCommitted: async () => {
      if (settled) return;
      settled = true;
      await input.trustRuleHits!.accept(target).catch(() => undefined);
    },
  });
}

export function decideTrustRuleHitBatchState(input: {
  readonly assignmentId: string;
  readonly batchDigest: string;
  readonly facts: Pick<ConversationDecisionFacts, "assignment" | "commitPublish">;
}): TrustRuleHitBatchState {
  if (input.facts.commitPublish.hasMirrorBatch(input.batchDigest)) {
    return "committed";
  }
  if (
    !input.facts.assignment.hasAssigned(input.assignmentId) ||
    input.facts.assignment.isAssignmentClosed(input.assignmentId)
  ) {
    return "rejected";
  }
  return "unknown";
}

export async function prepareTrustSedimentsForMirrorBatch(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly batch: ConversationInteractionMirrorBatch;
  readonly batchDigest: string;
  readonly sediments: readonly TrustSedimentMirrorEntry[];
  readonly trustSediments: ConversationTrustSedimentPort | undefined;
  readonly selectAssigned: () => Promise<
    | {
        readonly executorId: string;
        readonly environment: EnvironmentRequirement;
      }
    | undefined
  >;
  readonly interactionOutcome: (
    requestId: string,
  ) => Promise<{ t: "answered"; decisionDigest: string } | { t: "closed" } | undefined>;
}): Promise<void> {
  if (!input.trustSediments || input.sediments.length === 0) return;
  const assigned = await input.selectAssigned();
  if (!assigned) return;
  const answeredInBatch = new Set(
    input.batch.entries.flatMap((entry) =>
      entry.kind === "allow-once" && entry.outcome.t === "answered"
        ? [entry.requestId]
        : [],
    ),
  );
  const answered = async (requestId: string) =>
    answeredInBatch.has(requestId) ||
    (await input.interactionOutcome(requestId))?.t === "answered";
  for (const entry of input.sediments) {
    await input.trustSediments.prepare({
      conversationId: input.conversationId,
      assignmentId: input.assignmentId,
      executorId: assigned.executorId,
      environment: assigned.environment,
      entry,
      answered,
    });
  }
}
