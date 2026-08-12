import {
  DeliveryAuthority,
  assertDeliveryEnvelopeCompanions,
  deliveryRecord,
  projectDeliveryDisplayText,
  validateDeliveryStreamRecord,
  type DeliveryEnqueueInput,
} from "@zhixing/core";
import {
  type AuthorityError,
  type CommitEnvelope,
  type ConversationRunState,
  type DeliveryTargetDto,
  type IngressContext,
  type JobOccurrence,
  type JobRunState,
  type LogicalRecord,
  type MutationBatch,
  type PublishRecord,
  type SealedBundle,
  type TaskDefinition,
  type TranscriptRunRecord,
  type DeliveryIntentDto,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  validatePublishDecisionForBatch,
} from "@zhixing/core/protocol";

type JobBundle = SealedBundle & {
  readonly body: Extract<SealedBundle["body"], { t: "job" }>;
};

export type DeliveryParticipantResult =
  | {
      readonly accepted: true;
      readonly records: readonly LogicalRecord<unknown>[];
      readonly stagedRevisions: ReadonlyMap<number, number>;
      readonly stagedConflicts: ReadonlyMap<number, AuthorityError>;
    }
  | { readonly accepted: false; readonly error: AuthorityError };

export interface ConversationDeliveryCommitInput {
  readonly at: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly commitRevision: number;
  readonly ingress: IngressContext;
  readonly runRecord: TranscriptRunRecord;
  readonly mutationBatch?: MutationBatch;
  readonly finalContent?: DeliveryIntentDto["content"];
  readonly stagedContents?: ReadonlyMap<number, DeliveryIntentDto["content"]>;
  readonly stagedContentErrors?: ReadonlyMap<number, AuthorityError>;
}

export interface JobDeliveryCommitInput {
  readonly at: string;
  readonly occurrence: JobOccurrence;
  readonly definition: TaskDefinition;
  readonly bundle: JobBundle;
  readonly mutationBatch?: MutationBatch;
  readonly resultContent?: DeliveryIntentDto["content"];
  readonly stagedContents?: ReadonlyMap<number, DeliveryIntentDto["content"]>;
  readonly stagedContentErrors?: ReadonlyMap<number, AuthorityError>;
}

export interface ConversationStatusDeliveryInput {
  readonly at: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly state: ConversationRunState;
  readonly statusRevision: number;
  readonly reason?: string;
  readonly ingress: IngressContext;
}

/**
 * 控制回执投递:一个控制决定恰产生一个回执 item,以 canonical requestId
 * 幂等。当前唯一语义是渠道 cancel-batch 的空批次反馈——非空批次的用户
 * 反馈由逐 run 权威 cancelled 投递单源承担,不产生批级回执。
 */
export interface ConversationControlResponseInput {
  readonly at: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly replyTarget: DeliveryTargetDto;
  readonly response: "empty-cancel-batch";
}

export interface JobStatusDeliveryInput {
  readonly at: string;
  readonly occurrence: JobOccurrence;
  readonly definition: TaskDefinition;
  readonly state: JobRunState;
  readonly statusRevision: number;
}

export interface SchedulerNoticeDeliveryInput {
  readonly at: string;
  readonly noticeId: string;
  readonly target: DeliveryTargetDto;
  readonly text: string;
  readonly lifecycleSources?: readonly {
    readonly owner: "assignment" | "scheduler";
    readonly id: string;
  }[];
}

export interface ConversationDeliveryParticipant {
  coordinate<Result>(operation: () => Promise<Result>): Promise<Result>;
  prepareConversationCommit(input: ConversationDeliveryCommitInput): DeliveryParticipantResult;
  prepareConversationStatuses(
    inputs: readonly ConversationStatusDeliveryInput[],
  ): DeliveryParticipantResult;
  prepareConversationControlResponses(
    inputs: readonly ConversationControlResponseInput[],
  ): DeliveryParticipantResult;
  assertConversationCommit(
    input: ConversationDeliveryCommitInput,
    envelope: CommitEnvelope<unknown>,
  ): void;
  assertConversationStatuses(
    inputs: readonly ConversationStatusDeliveryInput[],
    envelope: CommitEnvelope<unknown>,
  ): void;
}

export interface JobDeliveryParticipant {
  coordinate<Result>(operation: () => Promise<Result>): Promise<Result>;
  prepareJobCommit(input: JobDeliveryCommitInput): DeliveryParticipantResult;
  prepareJobStatuses(inputs: readonly JobStatusDeliveryInput[]): DeliveryParticipantResult;
  prepareSchedulerNotices?(
    inputs: readonly SchedulerNoticeDeliveryInput[],
  ): DeliveryParticipantResult;
  assertJobCommit(input: JobDeliveryCommitInput, envelope: CommitEnvelope<unknown>): void;
  assertJobStatuses(
    inputs: readonly JobStatusDeliveryInput[],
    envelope: CommitEnvelope<unknown>,
  ): void;
}

const CONVERSATION_CHANNEL_STATUS_TEXT = {
  cancelled: "本次运行已取消。",
  failed: "本次运行失败。",
  expired: "本次请求未能开始执行，已过期。你可以重新发送。",
  uncertain: "本次运行结果不确定，需要你裁决处理方式。",
} as const satisfies Readonly<Partial<Record<ConversationRunState, string>>>;

const CONVERSATION_CONTROL_RESPONSE_TEXT = {
  "empty-cancel-batch": "当前没有正在处理的任务。",
} as const satisfies Readonly<
  Record<ConversationControlResponseInput["response"], string>
>;

function jobChannelStatusText(
  state: JobRunState,
  taskName: string,
): string | undefined {
  switch (state) {
    case "cancelled":
      return `定时任务「${taskName}」已取消。`;
    case "failed":
      return `定时任务「${taskName}」运行失败。`;
    case "expired":
      return `定时任务「${taskName}」本次未能开始执行，已过期；后续计划不受影响。`;
    case "uncertain":
      return `定时任务「${taskName}」结果不确定，需要你裁决处理方式。`;
    default:
      return undefined;
  }
}

function statusText<State extends string>(
  messages: Readonly<Partial<Record<State, string>>>,
  state: State,
): string | undefined {
  return messages[state];
}

function conversationStatusText(input: ConversationStatusDeliveryInput): string | undefined {
  if (input.state !== "failed") {
    return statusText(CONVERSATION_CHANNEL_STATUS_TEXT, input.state);
  }
  return input.reason
    ? `本次运行失败：${input.reason}。`
    : CONVERSATION_CHANNEL_STATUS_TEXT.failed;
}

/**
 * Maps owner facts to delivery intents while delegating uniqueness and
 * lifecycle authority to the one anchor-owned DeliveryAuthority instance.
 */
export class OwnerDeliveryParticipant
  implements ConversationDeliveryParticipant, JobDeliveryParticipant
{
  readonly #authority: DeliveryAuthority;
  readonly #maxAttempts: number;

  constructor(options: {
    readonly authority: DeliveryAuthority;
    readonly maxAttempts?: number;
  }) {
    this.#authority = options.authority;
    this.#maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts <= 0) {
      throw new TypeError("Delivery max attempts must be a positive safe integer");
    }
  }

  coordinate<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#authority.coordinate(operation);
  }

  prepareConversationCommit(
    input: ConversationDeliveryCommitInput,
  ): DeliveryParticipantResult {
    const conflicts = new Map(input.stagedContentErrors ?? []);
    for (const record of input.mutationBatch?.records ?? []) {
      if (record.mutation.kind !== "delivery-enqueue") continue;
      const request = record.mutation.request;
      if (
        request.target.kind === "turn-origin" &&
        input.ingress.kind !== "channel"
      ) {
        conflicts.set(record.seq, noDurableRoute());
      }
    }
    return this.#prepare(
      conversationCommitInputs(input, this.#maxAttempts),
      input.at,
      conflicts,
    );
  }

  prepareJobCommit(input: JobDeliveryCommitInput): DeliveryParticipantResult {
    return this.#prepare(
      jobCommitInputs(input, this.#maxAttempts),
      input.at,
      input.stagedContentErrors,
    );
  }

  prepareConversationStatuses(
    inputs: readonly ConversationStatusDeliveryInput[],
  ): DeliveryParticipantResult {
    if (inputs.length === 0) return emptyParticipantResult();
    return this.#prepare(
      inputs.flatMap((input) => conversationStatusInputs(input, this.#maxAttempts)),
      requireSingleCommitTime(inputs),
    );
  }

  prepareConversationControlResponses(
    inputs: readonly ConversationControlResponseInput[],
  ): DeliveryParticipantResult {
    if (inputs.length === 0) return emptyParticipantResult();
    return this.#prepare(
      inputs.map((input) => conversationControlResponseInput(input, this.#maxAttempts)),
      requireSingleCommitTime(inputs),
    );
  }

  prepareJobStatuses(
    inputs: readonly JobStatusDeliveryInput[],
  ): DeliveryParticipantResult {
    if (inputs.length === 0) return emptyParticipantResult();
    return this.#prepare(
      inputs.flatMap((input) => jobStatusInputs(input, this.#maxAttempts)),
      requireSingleCommitTime(inputs),
    );
  }

  prepareSchedulerNotices(
    inputs: readonly SchedulerNoticeDeliveryInput[],
  ): DeliveryParticipantResult {
    if (inputs.length === 0) return emptyParticipantResult();
    return this.#prepare(
      inputs.map((input) => ({
        keyBody: {
          kind: "scheduler-user-notice-delivery" as const,
          noticeId: input.noticeId,
        },
        intent: {
          endpoint: { kind: "channel" as const, target: input.target },
          content: { text: input.text, markdown: input.text },
          priority: "normal" as const,
          source: { kind: "system" as const, reason: "scheduler-user-notice" },
          createdAt: input.at,
          maxAttempts: this.#maxAttempts,
        },
        ...(input.lifecycleSources ? { lifecycleSources: input.lifecycleSources } : {}),
      })),
      requireSingleCommitTime(inputs),
    );
  }

  assertConversationCommit(input: ConversationDeliveryCommitInput, envelope: CommitEnvelope<unknown>): void {
    const conflictedSeqs = deliveryConflictSeqs(envelope, input.assignmentId);
    const inputs = conversationCommitInputs(
      input,
      this.#maxAttempts,
      conflictedSeqs,
    );
    assertDeliveryCompanions(
      envelope,
      inputs,
      new Set(["conversation-final-delivery", "staged-delivery"]),
    );
    const enqueuedSeqs = new Set(
      inputs.flatMap((candidate) =>
        candidate.keyBody.kind === "staged-delivery"
          ? [candidate.keyBody.mutationSeq]
          : [],
      ),
    );
    for (const record of input.mutationBatch?.records ?? []) {
      if (
        record.mutation.kind === "delivery-enqueue" &&
        !enqueuedSeqs.has(record.seq) &&
        !conflictedSeqs.has(record.seq)
      ) {
        throw new Error("Staged delivery has neither an enqueue nor a conflict outcome");
      }
    }
  }

  assertJobCommit(input: JobDeliveryCommitInput, envelope: CommitEnvelope<unknown>): void {
    const deliveryOutcomes = assertJobPublishDecision(input, envelope);
    const conflictedSeqs = new Set(
      [...deliveryOutcomes]
        .filter(([, outcome]) => outcome.t === "conflicted")
        .map(([seq]) => seq),
    );
    const inputs = jobCommitInputs(
      input,
      this.#maxAttempts,
      conflictedSeqs,
    );
    assertDeliveryCompanions(
      envelope,
      inputs,
      new Set(["job-result-delivery", "staged-delivery"]),
    );
    const enqueuedSeqs = new Set(
      inputs.flatMap((candidate) =>
        candidate.keyBody.kind === "staged-delivery"
          ? [candidate.keyBody.mutationSeq]
          : [],
      ),
    );
    for (const record of input.mutationBatch?.records ?? []) {
      if (
        record.mutation.kind === "delivery-enqueue" &&
        !enqueuedSeqs.has(record.seq) &&
        deliveryOutcomes.get(record.seq)?.t !== "conflicted"
      ) {
        throw new Error("Job staged delivery has neither an enqueue nor a conflict outcome");
      }
    }
  }

  assertConversationStatuses(
    inputs: readonly ConversationStatusDeliveryInput[],
    envelope: CommitEnvelope<unknown>,
  ): void {
    assertDeliveryCompanions(
      envelope,
      inputs.flatMap((input) => conversationStatusInputs(input, this.#maxAttempts)),
      new Set(["conversation-status-delivery"]),
    );
  }

  assertJobStatuses(
    inputs: readonly JobStatusDeliveryInput[],
    envelope: CommitEnvelope<unknown>,
  ): void {
    assertDeliveryCompanions(
      envelope,
      inputs.flatMap((input) => jobStatusInputs(input, this.#maxAttempts)),
      new Set(["job-status-delivery"]),
    );
  }

  #prepare(
    inputs: readonly DeliveryEnqueueInput[],
    commitAt: string,
    stagedConflicts: ReadonlyMap<number, AuthorityError> = new Map(),
  ): DeliveryParticipantResult {
    const decision = this.#authority.prepareEnqueues(inputs, commitAt);
    if (!decision.accepted) return decision;
    const stagedRevisions = new Map<number, number>();
    for (let index = 0; index < inputs.length; index += 1) {
      const key = inputs[index]!.keyBody;
      if (key.kind === "staged-delivery") {
        stagedRevisions.set(key.mutationSeq, decision.items[index]!.statusRevision);
      }
    }
    return {
      accepted: true,
      records: decision.records.map(deliveryRecord),
      stagedRevisions,
      stagedConflicts,
    };
  }
}

function emptyParticipantResult(): Extract<
  DeliveryParticipantResult,
  { accepted: true }
> {
  return {
    accepted: true,
    records: [],
    stagedRevisions: new Map(),
    stagedConflicts: new Map(),
  };
}

function requireSingleCommitTime(
  inputs: readonly { readonly at: string }[],
): string {
  const at = inputs[0]?.at;
  if (!at || inputs.some((input) => input.at !== at)) {
    throw new TypeError("Delivery status batch must share one authority commit time");
  }
  return at;
}

function deliveryConflictSeqs(
  envelope: CommitEnvelope<unknown>,
  assignmentId: string,
): ReadonlySet<number> {
  const conflicts = new Set<number>();
  for (const entry of envelope.entries) {
    if (entry.stream !== "publish" || !isPlainRecord(entry.body)) continue;
    if (entry.body.t !== "publish-decision" || entry.body.assignmentId !== assignmentId) {
      continue;
    }
    const outcomes = entry.body.outcomes;
    if (!Array.isArray(outcomes)) continue;
    for (const raw of outcomes) {
      if (
        isPlainRecord(raw) &&
        Number.isSafeInteger(raw.seq) &&
        isPlainRecord(raw.outcome) &&
        raw.outcome.t === "conflicted"
      ) {
        conflicts.add(raw.seq as number);
      }
    }
  }
  return conflicts;
}

function assertJobPublishDecision(
  input: JobDeliveryCommitInput,
  envelope: CommitEnvelope<unknown>,
): ReadonlyMap<
  number,
  Extract<PublishRecord, { t: "publish-decision" }>["outcomes"][number]["outcome"]
> {
  const matches = envelope.entries.filter(
    (entry) =>
      entry.stream === "publish" &&
      isPlainRecord(entry.body) &&
      entry.body.t === "publish-decision" &&
      entry.body.assignmentId === input.bundle.assignmentId,
  );
  const batch = input.mutationBatch;
  if (!batch) {
    if (matches.length > 0) throw new Error("Job commit has an unexpected publish decision");
    return new Map();
  }
  if (matches.length !== 1) {
    throw new Error("Job mutation batch must have exactly one publish decision");
  }
  let body: Extract<PublishRecord, { t: "publish-decision" }>;
  try {
    body = validatePublishDecisionForBatch(matches[0]!.body, batch);
  } catch (error) {
    throw new Error("Job publish decision structure is invalid", { cause: error });
  }
  const bundleBatch = input.bundle.body.mutationBatch;
  if (
    !bundleBatch ||
    canonicalize(body.batch) !== canonicalize({ ref: bundleBatch.ref }) ||
    body.sessionCount !== 0 ||
    body.globalCount !== bundleBatch.globalCount ||
    body.outcomes.length !== batch.records.length
  ) {
    throw new Error("Job publish decision does not bind its mutation batch");
  }

  const enqueuedRevisions = new Map<number, number>();
  for (const entry of envelope.entries) {
    if (entry.stream !== "delivery") continue;
    const record = validateDeliveryStreamRecord(entry.body);
    if (
      record.t === "enqueued" &&
      record.keyBody.kind === "staged-delivery" &&
      record.keyBody.assignmentId === input.bundle.assignmentId
    ) {
      enqueuedRevisions.set(record.keyBody.mutationSeq, record.statusRevision);
    }
  }

  const outcomes = new Map<
    number,
    Extract<PublishRecord, { t: "publish-decision" }>["outcomes"][number]["outcome"]
  >();
  for (const [index, mutation] of batch.records.entries()) {
    const raw = body.outcomes[index];
    if (!raw || raw.seq !== mutation.seq) {
      throw new Error("Job publish decision outcomes do not cover the mutation batch");
    }
    const outcome = raw.outcome;

    if (mutation.mutation.kind === "delivery-enqueue") {
      const expectedError = input.stagedContentErrors?.get(mutation.seq);
      const targetRevision = enqueuedRevisions.get(mutation.seq);
      if (expectedError) {
        if (
          canonicalize(outcome) !==
          canonicalize({ t: "conflicted", error: expectedError })
        ) {
          throw new Error("Job staged delivery outcome does not bind its durable result");
        }
      } else if (targetRevision !== undefined) {
        if (
          canonicalize(outcome) !==
          canonicalize({ t: "granted", targetRevision })
        ) {
          throw new Error("Job staged delivery outcome does not bind its durable result");
        }
      } else if (outcome.t !== "conflicted") {
        throw new Error("Job staged delivery outcome does not bind its durable result");
      }
    }
    outcomes.set(
      mutation.seq,
      outcome as Extract<
        PublishRecord,
        { t: "publish-decision" }
      >["outcomes"][number]["outcome"],
    );
  }
  return outcomes;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function conversationCommitInputs(
  input: ConversationDeliveryCommitInput,
  maxAttempts = 3,
  durableConflicts: ReadonlySet<number> = new Set(),
): DeliveryEnqueueInput[] {
  const result: DeliveryEnqueueInput[] = [];
  if (input.ingress.kind === "channel") {
    const text = finalAssistantText(input.runRecord);
    if (text.trim().length > 0) result.push({
      keyBody: {
        kind: "conversation-final-delivery",
        conversationId: input.conversationId,
        runId: input.runId,
        commitRevision: input.commitRevision,
      },
      intent: {
        endpoint: { kind: "channel", target: input.ingress.replyTarget },
        content: input.finalContent ?? { text, markdown: text },
        priority: "normal",
        source: {
          kind: "agent",
          conversationId: input.conversationId,
          turnSlotId: input.ingress.ingressId,
        },
        createdAt: input.at,
        maxAttempts,
      },
      lifecycleSources: [{ owner: "conversation", id: input.conversationId }],
    });
  }
  for (const record of input.mutationBatch?.records ?? []) {
    if (record.mutation.kind !== "delivery-enqueue") continue;
    const request = record.mutation.request;
    const target =
      request.target.kind === "explicit"
        ? request.target.target
        : input.ingress.kind === "channel"
          ? input.ingress.replyTarget
          : undefined;
    if (
      !target ||
      input.stagedContentErrors?.has(record.seq) ||
      durableConflicts.has(record.seq)
    ) {
      continue;
    }
    result.push({
      keyBody: {
        kind: "staged-delivery",
        assignmentId: input.assignmentId,
        mutationSeq: record.seq,
      },
      intent: {
        endpoint: { kind: "channel", target },
        content: input.stagedContents?.get(record.seq) ?? contentOf(request.content),
        priority: "normal",
        source: { kind: "agent", conversationId: input.conversationId },
        createdAt: input.at,
        maxAttempts,
      },
      lifecycleSources: [{ owner: "assignment", id: input.assignmentId }],
    });
  }
  return result;
}

function jobCommitInputs(
  input: JobDeliveryCommitInput,
  maxAttempts: number,
  durableConflicts: ReadonlySet<number> = new Set(),
): DeliveryEnqueueInput[] {
  const result: DeliveryEnqueueInput[] = [];
  const definition = requireUserDefinition(input.definition, input.occurrence);
  const taskName = projectDeliveryDisplayText(definition.definition.spec.name);
  const delivery = input.occurrence.deliveryPlan.delivery;
  if (delivery.kind !== "none") {
    result.push({
      keyBody: {
        kind: "job-result-delivery",
        taskId: input.occurrence.taskId,
        jobRunId: input.occurrence.jobRunId,
        planDigest: input.occurrence.deliveryPlan.planDigest,
      },
      intent: {
        endpoint:
          delivery.kind === "channel"
            ? {
                kind: "channel",
                target: {
                  channelId: delivery.channel,
                  to: delivery.to,
                  ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
                },
              }
            : { kind: "webhook", endpoint: delivery.endpoint },
        content: input.resultContent ?? {
          text: input.bundle.body.outcome.summary,
          markdown: input.bundle.body.outcome.summary,
        },
        priority: deliveryPriority(definition.definition.spec.priority),
        source: {
          kind: "scheduler",
          taskId: input.occurrence.taskId,
          taskName,
          ...(definition.definition.createdInTurn
            ? { createdInTurn: definition.definition.createdInTurn }
            : {}),
        },
        createdAt: input.at,
        maxAttempts,
      },
      lifecycleSources: [{ owner: "scheduler", id: input.occurrence.jobRunId }],
    });
  }
  for (const record of input.mutationBatch?.records ?? []) {
    if (record.mutation.kind !== "delivery-enqueue") continue;
    if (
      input.stagedContentErrors?.has(record.seq) ||
      durableConflicts.has(record.seq)
    ) {
      continue;
    }
    const request = record.mutation.request;
    if (request.target.kind !== "explicit") {
      throw new TypeError("Job delivery requires an explicit durable target");
    }
    result.push({
      keyBody: {
        kind: "staged-delivery",
        assignmentId: input.bundle.assignmentId,
        mutationSeq: record.seq,
      },
      intent: {
        endpoint: { kind: "channel", target: request.target.target },
        content: input.stagedContents?.get(record.seq) ?? contentOf(request.content),
        priority: deliveryPriority(definition.definition.spec.priority),
        source: {
          kind: "scheduler",
          taskId: input.occurrence.taskId,
          taskName,
          ...(definition.definition.createdInTurn
            ? { createdInTurn: definition.definition.createdInTurn }
            : {}),
        },
        createdAt: input.at,
        maxAttempts,
      },
      lifecycleSources: [{ owner: "assignment", id: input.bundle.assignmentId }],
    });
  }
  return result;
}

function conversationStatusInputs(
  input: ConversationStatusDeliveryInput,
  maxAttempts: number,
): DeliveryEnqueueInput[] {
  if (input.ingress.kind !== "channel") return [];
  const text = conversationStatusText(input);
  if (!text) return [];
  return [
    {
      keyBody: {
        kind: "conversation-status-delivery",
        conversationId: input.conversationId,
        runId: input.runId,
        statusRevision: input.statusRevision,
      },
      intent: {
        endpoint: { kind: "channel", target: input.ingress.replyTarget },
        content: { text, markdown: text },
        priority: "normal",
        source: {
          kind: "agent",
          conversationId: input.conversationId,
          turnSlotId: input.ingress.ingressId,
        },
        createdAt: input.at,
        maxAttempts,
      },
      lifecycleSources: [{ owner: "conversation", id: input.conversationId }],
    },
  ];
}

function conversationControlResponseInput(
  input: ConversationControlResponseInput,
  maxAttempts: number,
): DeliveryEnqueueInput {
  const text = CONVERSATION_CONTROL_RESPONSE_TEXT[input.response];
  return {
    keyBody: {
      kind: "conversation-control-response-delivery",
      conversationId: input.conversationId,
      requestId: input.requestId,
    },
    intent: {
      endpoint: { kind: "channel", target: input.replyTarget },
      content: { text, markdown: text },
      priority: "normal",
      source: { kind: "agent", conversationId: input.conversationId },
      createdAt: input.at,
      maxAttempts,
    },
    lifecycleSources: [{ owner: "conversation", id: input.conversationId }],
  };
}

function noDurableRoute(): AuthorityError {
  return {
    code: "unavailable-offline",
    message: "Delivery request has no durable route",
    retryable: false,
  };
}

function jobStatusInputs(
  input: JobStatusDeliveryInput,
  maxAttempts: number,
): DeliveryEnqueueInput[] {
  if (input.definition.definition.kind !== "user") return [];
  const definition = requireUserDefinition(input.definition, input.occurrence);
  const taskName = projectDeliveryDisplayText(definition.definition.spec.name);
  const origin = definition.definition.origin;
  if (!origin) return [];
  const text = jobChannelStatusText(input.state, taskName);
  if (!text) return [];
  return [
    {
      keyBody: {
        kind: "job-status-delivery",
        taskId: input.occurrence.taskId,
        jobRunId: input.occurrence.jobRunId,
        statusRevision: input.statusRevision,
      },
      intent: {
        endpoint: { kind: "channel", target: origin },
        content: { text, markdown: text },
        priority: deliveryPriority(definition.definition.spec.priority),
        source: {
          kind: "scheduler",
          taskId: input.occurrence.taskId,
          taskName,
          ...(definition.definition.createdInTurn
            ? { createdInTurn: definition.definition.createdInTurn }
            : {}),
        },
        createdAt: input.at,
        maxAttempts,
      },
      lifecycleSources: [{ owner: "scheduler", id: input.occurrence.jobRunId }],
    },
  ];
}

function assertDeliveryCompanions(
  envelope: CommitEnvelope<unknown>,
  inputs: readonly DeliveryEnqueueInput[],
  kinds: ReadonlySet<DeliveryEnqueueInput["keyBody"]["kind"]>,
): void {
  assertDeliveryEnvelopeCompanions(envelope);
  const expectedKeys = inputs.map((input) => input.keyBody);
  const actual = envelope.entries.filter((record) => {
    if (record.stream !== "delivery") return false;
    const body = record.body as { readonly t?: string; readonly keyBody?: { readonly kind?: string } };
    return body.t === "enqueued" && kinds.has(body.keyBody?.kind as DeliveryEnqueueInput["keyBody"]["kind"]);
  });
  const actualKeys = actual.map((entry) => {
    const record = validateDeliveryStreamRecord(entry.body);
    if (record.t !== "enqueued") throw new Error("Delivery companion is not enqueued");
    return record.keyBody;
  });
  if (canonicalize(actualKeys) !== canonicalize(expectedKeys)) {
    throw new Error("Delivery records do not match their source authority facts");
  }
}

function requireUserDefinition(
  definition: TaskDefinition,
  occurrence: JobOccurrence,
): TaskDefinition & { definition: Extract<TaskDefinition["definition"], { kind: "user" }> } {
  if (
    definition.taskId !== occurrence.taskId ||
    definition.taskRevision !== occurrence.taskRevision ||
    definition.definition.kind !== "user"
  ) {
    throw new TypeError("Job delivery requires its frozen user task definition");
  }
  return definition as TaskDefinition & {
    definition: Extract<TaskDefinition["definition"], { kind: "user" }>;
  };
}

function finalAssistantText(record: TranscriptRunRecord): string {
  for (let index = record.messages.length - 1; index >= 0; index -= 1) {
    const message = record.messages[index]!;
    if (message.role !== "assistant") continue;
    return message.content
      .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

function contentOf(
  content: string | { readonly ref: import("@zhixing/core/contracts").ArtifactRef },
): { readonly text: string; readonly markdown: string } | { readonly ref: import("@zhixing/core/contracts").ArtifactRef } {
  return typeof content === "string"
    ? { text: content, markdown: content }
    : { ref: content.ref };
}

function deliveryPriority(priority: "low" | "normal" | "high" | "urgent"):
  "low" | "normal" | "high" {
  return priority === "urgent" ? "high" : priority;
}
