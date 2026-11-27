import { type AdvancementControlEvent } from "@zhixing-ai/core/advancement";
import type { ProjectionTransactionDecision } from "@zhixing-ai/core/authority";
import { userMessageFromTurnInput, type Message } from "@zhixing-ai/core";
import type {
  ContentAssetRef,
  ControlResult,
  ConversationInvocation,
  ExplicitEnvironmentSelection,
  IngressContext,
  LogicalRecord,
  UserTurnInput,
} from "@zhixing-ai/core/contracts";
import { isProgramOrigin, parseConversationId } from "@zhixing-ai/core/conversation";
import { canonicalize } from "@zhixing-ai/core/protocol";
import { worksceneTaskConflictsWithAdvancement } from "@zhixing-ai/core/workscene/application";
import type { InitialControlEnvelope } from "../../control-admission.js";
import {
  corruptRunJournal,
  type ConversationRunJournalRecord,
  type Stored,
} from "../../conversation-run-contracts.js";
import { DurableConversationAdmissionRejectedError } from "../../run-turn.js";
import {
  AdvancementWriteRejectedError,
  type ConversationCommitLogRecord,
  type ConversationLifecycleProjectionInput,
  type PendingLifecycleProjection,
} from "../contracts.js";
import { runRecord } from "../state/common.js";
import {
  admittedInputMatches,
  requireRetainedRunInput,
} from "../state/run-queue-input.js";
import {
  isAdvancementCleanupEvent,
  worksceneSessionMetaEntries,
} from "../state/session-domain.js";
import type { ConversationDecisionFacts } from "../state/views.js";

function rejectedInputControl(
  code: import("@zhixing-ai/core/contracts").AuthorityError["code"],
  message: string,
): Extract<ControlResult, { status: "rejected" }> {
  return {
    v: 1,
    status: "rejected",
    error: { code, message, retryable: false },
  };
}

export function decideTouchWorksceneSession(input: {
  readonly conversationId: string;
  readonly requestId: string;
  readonly sceneId: string;
  readonly at: string;
  readonly facts: Pick<ConversationDecisionFacts, "session">;
}): ProjectionTransactionDecision<
  unknown,
  { readonly revision: number; readonly at: string }
> {
  const { session } = input.facts;
  const replay = session.getSessionMetaByRequest(input.requestId);
  if (replay) {
    if (replay.sceneId !== input.sceneId || replay.operation === "delete") {
      throw corruptRunJournal(
        "Session activity request is already bound to another mutation",
      );
    }
    return {
      kind: "return",
      value: {
        revision: replay.domainRevision,
        at: replay.lastActiveAt,
      },
    };
  }
  if (session.deleted) {
    throw corruptRunJournal("Deleted workscene conversation cannot be touched");
  }
  const domainRevision = session.domainRevision + 1;
  const operation = session.sessionMeta ? "touch" : "create";
  const meta: Extract<ConversationRunJournalRecord, { t: "session-meta" }> = {
    t: "session-meta",
    operation,
    domainRevision,
    requestId: input.requestId,
    sceneId: input.sceneId,
    lastActiveAt: input.at,
  };
  return {
    kind: "append",
    entries: worksceneSessionMetaEntries(input.conversationId, meta),
    value: { revision: domainRevision, at: input.at },
  };
}

export function decideDeleteWorksceneSession(input: {
  readonly conversationId: string;
  readonly requestId: string;
  readonly sceneId: string;
  readonly at: string;
  readonly facts: Pick<ConversationDecisionFacts, "session">;
}): ProjectionTransactionDecision<
  unknown,
  { readonly revision: number; readonly at: string } | undefined
> {
  const { session } = input.facts;
  const replay = session.getSessionMetaByRequest(input.requestId);
  if (replay) {
    if (replay.operation !== "delete" || replay.sceneId !== input.sceneId) {
      throw corruptRunJournal(
        "Session deletion request is already bound to another mutation",
      );
    }
    return {
      kind: "return",
      value: {
        revision: replay.domainRevision,
        at: replay.lastActiveAt,
      },
    };
  }
  if (!session.sessionMeta) {
    return { kind: "return", value: undefined };
  }
  if (session.deleted) {
    return {
      kind: "return",
      value: {
        revision: session.sessionMeta.domainRevision,
        at: session.sessionMeta.lastActiveAt,
      },
    };
  }
  const domainRevision = session.domainRevision + 1;
  const meta: Extract<ConversationRunJournalRecord, { t: "session-meta" }> = {
    t: "session-meta",
    operation: "delete",
    domainRevision,
    requestId: input.requestId,
    sceneId: input.sceneId,
    lastActiveAt: input.at,
  };
  return {
    kind: "append",
    entries: worksceneSessionMetaEntries(input.conversationId, meta),
    value: { revision: domainRevision, at: input.at },
  };
}

export function decideCompleteLifecycleProjection(input: {
  readonly conversationId: string;
  readonly request: Omit<ConversationLifecycleProjectionInput, "conversationId">;
  readonly facts: Pick<ConversationDecisionFacts, "session">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, boolean> {
  const { session } = input.facts;
  const pending = session.getPendingLifecycleProjection(
    input.request.domainRevision,
  );
  if (!pending) {
    const lifecycle = session.getLifecycleByRequest(input.request.requestId);
    const sessionMeta = session.getSessionMetaByRequest(input.request.requestId);
    const durable: PendingLifecycleProjection | undefined =
      lifecycle ??
      (sessionMeta?.operation === "delete"
        ? {
            mutation: "delete",
            domainRevision: sessionMeta.domainRevision,
            requestId: sessionMeta.requestId,
          }
        : undefined);
    if (
      durable?.domainRevision === input.request.domainRevision &&
      durable.mutation === input.request.mutation &&
      session.hasProjectedLifecycleRevision(input.request.domainRevision)
    ) {
      return { kind: "return", value: false };
    }
    throw corruptRunJournal("Lifecycle projection acknowledgement is not pending");
  }
  if (
    pending.requestId !== input.request.requestId ||
    pending.mutation !== input.request.mutation
  ) {
    throw corruptRunJournal(
      "Lifecycle projection acknowledgement does not bind its fact",
    );
  }
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        kind: "conversation-lifecycle-projection",
        mutation: input.request.mutation,
        domainRevision: input.request.domainRevision,
        requestId: input.request.requestId,
      }),
    ],
    value: true,
  };
}

export function decideAdmitRun(input: {
  readonly conversationId: string;
  readonly ingressKey: string;
  readonly runId: string;
  readonly userInput: UserTurnInput;
  readonly ingress: IngressContext;
  readonly invocation: ConversationInvocation;
  readonly environment: ExplicitEnvironmentSelection | undefined;
  readonly attachments: readonly ContentAssetRef[];
  readonly queuedPosition: number;
  readonly admitted: Extract<ConversationRunJournalRecord, { t: "admitted" }>;
  readonly facts: Pick<ConversationDecisionFacts, "queueInput">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const { queueInput } = input.facts;
  const byRun = queueInput.getAdmitted(input.runId);
  const ingressRun = queueInput.getRunIdByIngress(input.ingressKey);
  if (byRun || ingressRun) {
    if (
      !byRun ||
      ingressRun !== input.runId ||
      canonicalize(byRun.record.ingress) !== canonicalize(input.ingress) ||
      !admittedInputMatches(byRun, input.userInput) ||
      canonicalize(byRun.record.attachments ?? []) !==
        canonicalize(input.attachments) ||
      canonicalize(byRun.record.invocation) !== canonicalize(input.invocation) ||
      canonicalize(byRun.record.environment ?? null) !==
        canonicalize(input.environment ?? null) ||
      byRun.record.queuedPosition !== input.queuedPosition
    ) {
      throw new DurableConversationAdmissionRejectedError(
        "idempotency-conflict",
        "Run admission identity has conflicting durable payloads",
      );
    }
    return { kind: "return", value: undefined };
  }
  if (queueInput.hasQueuedPosition(input.queuedPosition)) {
    throw new Error("Queued position already belongs to an active run");
  }
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, input.admitted),
      runRecord(input.conversationId, {
        t: "state",
        runId: input.runId,
        state: "queued",
        statusRevision: 1,
      }),
    ],
    value: undefined,
  };
}

export function decideInputControl(input: {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly runId: string;
  readonly userInput: UserTurnInput;
  readonly invocation: ConversationInvocation;
  readonly environment: ExplicitEnvironmentSelection | undefined;
  readonly attachments: readonly ContentAssetRef[];
  readonly storedInput: Stored<UserTurnInput>;
  readonly request: InitialControlEnvelope["body"];
  readonly ingress: IngressContext | undefined;
  readonly nextLsn: number;
  readonly worksceneDeleted: boolean;
  readonly facts: Pick<
    ConversationDecisionFacts,
    "session" | "queueInput" | "assignment"
  >;
}): {
  readonly result: ControlResult;
  readonly authorityEntries?: readonly LogicalRecord<ConversationCommitLogRecord>[];
  readonly consumeReceipt?: boolean;
} {
  const { session, queueInput, assignment } = input.facts;
  const request = input.request;
  const programOrigin = isProgramOrigin(input.ingress);
  if (request.t !== "input") {
    return {
      result: rejectedInputControl(
        "invalid",
        "Conversation input admission requires an input request",
      ),
      ...(programOrigin ? { consumeReceipt: false } : {}),
    };
  }
  if (session.deleted) {
    return {
      result: rejectedInputControl(
        "fence-rejected",
        "Conversation has been durably deleted",
      ),
      ...(programOrigin ? { consumeReceipt: false } : {}),
    };
  }
  if (input.worksceneDeleted) {
    return {
      result: rejectedInputControl(
        "fence-rejected",
        "Conversation workscene has been durably deleted",
      ),
      ...(programOrigin ? { consumeReceipt: false } : {}),
    };
  }
  const ingress = input.ingress;
  if (
    request.conversationId !== input.conversationId ||
    request.ownerEpoch !== input.ownerEpoch ||
    !ingress ||
    request.ingress.ingressId !== ingress.ingressId ||
    request.ingress.source !== ingress.kind
  ) {
    return {
      result: rejectedInputControl(
        "epoch-stale",
        "Input request does not bind the current conversation owner and ingress",
      ),
      ...(programOrigin ? { consumeReceipt: false } : {}),
    };
  }
  const ingressKey = `${ingress.surfacePrincipal}/${ingress.ingressId}`;
  const existingRunId = queueInput.getRunIdByIngress(ingressKey);
  if (existingRunId) {
    const existing = queueInput.getAdmitted(existingRunId);
    if (
      existingRunId !== input.runId ||
      !existing ||
      !admittedInputMatches(existing, input.userInput) ||
      canonicalize(existing.record.attachments ?? []) !==
        canonicalize(input.attachments) ||
      canonicalize(existing.record.ingress) !== canonicalize(ingress) ||
      canonicalize(existing.record.invocation) !==
        canonicalize(input.invocation) ||
      canonicalize(existing.record.environment ?? null) !==
        canonicalize(input.environment ?? null)
    ) {
      return {
        result: rejectedInputControl(
          "idempotency-conflict",
          "Ingress already belongs to a different run payload",
        ),
      };
    }
    return {
      result: {
        v: 1,
        status: "ok",
        body: {
          t: "input",
          runId: existingRunId,
          queuedPosition: existing.record.queuedPosition,
        },
      },
    };
  }
  if (session.pendingLifecycleProjectionSize > 0) {
    return {
      result: rejectedInputControl(
        "fence-rejected",
        "Conversation lifecycle projection must finish before new input",
      ),
      ...(programOrigin ? { consumeReceipt: false } : {}),
    };
  }
  const queuedPosition = input.nextLsn;
  const activeRunId = assignment.activeRunId;
  if (
    ingress.turnOrigin?.messageIdentity?.source.kind === "conversation" &&
    activeRunId &&
    !isProgramOrigin(queueInput.getAdmitted(activeRunId)?.record.ingress) &&
    queueInput.getOpenInputAssignment(activeRunId) !== undefined &&
    assignment.getRunState(activeRunId)?.state === "running" &&
    input.invocation.kind === "agent" &&
    !input.environment &&
    input.attachments.length === 0
  ) {
    return {
      result: {
        v: 1,
        status: "ok",
        body: { t: "input", runId: activeRunId, queuedPosition },
      },
      authorityEntries: [
        runRecord(input.conversationId, {
          t: "run-input-appended",
          runId: activeRunId,
          ingressKey,
          ingress,
          input: input.storedInput,
          position: queuedPosition,
        }),
      ],
    };
  }
  if (programOrigin && session.hasOpenAdvancementSession()) {
    return {
      result: rejectedInputControl(
        "fence-rejected",
        "目标对话当前存在未终结的契约推进会话，请先在终端处理",
      ),
      consumeReceipt: false,
    };
  }
  const activeAdvancementId = session.findActiveAdvancementSessionId();
  if (
    worksceneTaskConflictsWithAdvancement(
      ingress.turnOrigin,
      activeAdvancementId,
      input.invocation.kind === "agent"
        ? input.invocation.advancement?.sessionId
        : undefined,
    )
  ) {
    return {
      result: rejectedInputControl(
        "fence-rejected",
        "目标场景已有独立验收中的任务，未接纳另一项委托",
      ),
      ...(programOrigin ? { consumeReceipt: false } : {}),
    };
  }
  if (queueInput.hasAdmitted(input.runId)) {
    return {
      result: rejectedInputControl(
        "idempotency-conflict",
        "Run id already belongs to a different ingress",
      ),
    };
  }
  const admitted: Extract<ConversationRunJournalRecord, { t: "admitted" }> = {
    t: "admitted",
    ingressKey,
    runId: input.runId,
    input: input.storedInput,
    ...(input.attachments.length > 0 ? { attachments: [...input.attachments] } : {}),
    ingress,
    invocation: input.invocation,
    ...(input.environment ? { environment: input.environment } : {}),
    queuedPosition,
  };
  return {
    result: {
      v: 1,
      status: "ok",
      body: { t: "input", runId: input.runId, queuedPosition },
    },
    authorityEntries: [
      runRecord(input.conversationId, admitted),
      runRecord(input.conversationId, {
        t: "state",
        runId: input.runId,
        state: "queued",
        statusRevision: 1,
      }),
    ],
  };
}

export function decideAssertInputExecutor(input: {
  readonly runId: string;
  readonly assignmentId: string;
  readonly executorId: string;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): void {
  const assigned = input.facts.assignment.getAssigned(input.assignmentId);
  if (
    !assigned ||
    assigned.record.runId !== input.runId ||
    assigned.record.executorId !== input.executorId ||
    input.facts.assignment.getAssignmentIdForRun(input.runId) !==
      input.assignmentId
  ) {
    throw new Error(
      "Input does not belong to the authenticated executor assignment",
    );
  }
}

export function decideOpenRunInput(input: {
  readonly conversationId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly facts: Pick<ConversationDecisionFacts, "queueInput" | "assignment">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const { queueInput, assignment } = input.facts;
  if (
    assignment.getAssignmentIdForRun(input.runId) !== input.assignmentId ||
    assignment.getRunState(input.runId)?.state !== "running"
  ) {
    throw new Error("Only the running assignment can receive input");
  }
  if (queueInput.isInputAssignmentClosed(input.assignmentId)) {
    throw new Error("Run input is already closed");
  }
  if (queueInput.getOpenInputAssignment(input.runId) === input.assignmentId) {
    return { kind: "return", value: undefined };
  }
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "run-input-opened",
        runId: input.runId,
        assignmentId: input.assignmentId,
      }),
    ],
    value: undefined,
  };
}

export function decideReceiveRunInput(input: {
  readonly conversationId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly boundary: number;
  readonly closing: boolean;
  readonly facts: Pick<ConversationDecisionFacts, "queueInput" | "assignment">;
}): ProjectionTransactionDecision<
  ConversationCommitLogRecord,
  readonly Message[]
> {
  const { queueInput, assignment } = input.facts;
  const previous = queueInput.getInputConsumption(
    `${input.assignmentId}/${input.boundary}`,
  );
  const materialize = (keys: readonly string[]) =>
    keys.map((key) => {
      const entry = queueInput.getAppendedInput(key)!;
      return {
        ...userMessageFromTurnInput(requireRetainedRunInput(entry)),
        inputIdentity: structuredClone(
          entry.record.ingress.turnOrigin!.messageIdentity!,
        ),
      };
    });
  if (assignment.getAssignmentIdForRun(input.runId) !== input.assignmentId) {
    throw new Error("Stale input assignment");
  }
  if (previous) {
    return { kind: "return", value: materialize(previous.ingressKeys) };
  }
  if (
    queueInput.getOpenInputAssignment(input.runId) !== input.assignmentId ||
    assignment.getRunState(input.runId)?.state !== "running"
  ) {
    return { kind: "return", value: [] };
  }
  const keys = queueInput.collectUnconsumedInputKeys(
    input.runId,
    input.assignmentId,
  );
  if (keys.length === 0) {
    if (input.closing) {
      return {
        kind: "append",
        entries: [
          runRecord(input.conversationId, {
            t: "run-input-closed",
            runId: input.runId,
            assignmentId: input.assignmentId,
          }),
        ],
        value: [],
      };
    }
  }
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "run-input-consumed",
        runId: input.runId,
        assignmentId: input.assignmentId,
        boundary: input.boundary,
        ingressKeys: keys,
      }),
    ],
    value: materialize(keys),
  };
}

export function decideCloseRunInput(input: {
  readonly conversationId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly facts: Pick<ConversationDecisionFacts, "queueInput">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  if (
    input.facts.queueInput.getOpenInputAssignment(input.runId) !==
    input.assignmentId
  ) {
    return { kind: "return", value: undefined };
  }
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "run-input-closed",
        runId: input.runId,
        assignmentId: input.assignmentId,
      }),
    ],
    value: undefined,
  };
}

export function decideAdvancementEvents(input: {
  readonly conversationId: string;
  readonly requestId: string;
  readonly events: readonly AdvancementControlEvent[];
  readonly eventsDigest: string;
  readonly preparedEvents: readonly Stored<AdvancementControlEvent>[];
  readonly facts: Pick<ConversationDecisionFacts, "session">;
}): ProjectionTransactionDecision<
  ConversationCommitLogRecord,
  { readonly domainRevision: number }
> {
  const { session } = input.facts;
  const existing = session.getAdvancementWrite(input.requestId);
  if (existing) {
    if (existing.eventsDigest !== input.eventsDigest) {
      throw new AdvancementWriteRejectedError(
        "Advancement write identity has conflicting durable payloads",
      );
    }
    return {
      kind: "return",
      value: { domainRevision: existing.domainRevision },
    };
  }
  if (session.deleted && !input.events.every(isAdvancementCleanupEvent)) {
    throw new AdvancementWriteRejectedError(
      "AdvancementStore: conversation has been durably deleted",
    );
  }
  try {
    session.assertLegalAdvancementBatch(input.events);
  } catch (error) {
    throw new AdvancementWriteRejectedError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  const domainRevision = session.domainRevision + 1;
  const entries = input.preparedEvents.map((stored) =>
    runRecord(input.conversationId, {
      t: "advancement-event",
      requestId: input.requestId,
      domainRevision,
      eventsDigest: input.eventsDigest,
      event: stored,
    }),
  );
  return { kind: "append", entries, value: { domainRevision } };
}

export function decideSessionWriteControl(input: {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly body: Extract<
    import("../../control-admission.js").ConversationControlEnvelope["body"],
    { t: "session-write" }
  >;
  readonly canonicalRequestId: string;
  readonly authorityAt: string;
  readonly facts: Pick<ConversationDecisionFacts, "session" | "assignment">;
}): {
  readonly result: ControlResult;
  readonly authorityEntries?: readonly LogicalRecord<unknown>[];
} {
  const { session, assignment } = input.facts;
  const body = input.body;
  if (
    body.conversationId !== input.conversationId ||
    body.ownerEpoch !== input.ownerEpoch
  ) {
    return {
      result: rejectedInputControl(
        "epoch-stale",
        "Session write does not bind the current conversation owner",
      ),
    };
  }
  if (body.domainRevision !== session.domainRevision) {
    return {
      result: rejectedInputControl(
        "revision-conflict",
        "Session write domain revision is stale",
      ),
    };
  }
  if (session.deleted) {
    return {
      result: rejectedInputControl(
        "not-found",
        "Conversation has been durably deleted",
      ),
    };
  }
  if (session.pendingLifecycleProjectionSize > 0) {
    return {
      result: rejectedInputControl(
        "busy",
        "A prior session lifecycle projection is still pending",
      ),
    };
  }
  if (body.mutation.kind === "advancement-event") {
    return {
      result: rejectedInputControl(
        "invalid",
        "Advancement events use the signed advancement owner path",
      ),
    };
  }
  const lifecycleMutation =
    body.mutation.kind === "window-op" && body.mutation.op === "clear"
      ? "clear"
      : body.mutation.kind === "conversation-delete"
        ? "delete"
        : undefined;
  const hasOpenRun =
    lifecycleMutation !== undefined &&
    assignment.hasRunStateMatching(
      (runState) =>
        runState === "queued" ||
        runState === "dispatched" ||
        runState === "running" ||
        runState === "cancel-requested" ||
        runState === "uncertain",
    );
  if (lifecycleMutation !== undefined && hasOpenRun) {
    return {
      result: rejectedInputControl(
        "busy",
        "Session write requires a quiescent conversation",
      ),
    };
  }
  const revision = session.domainRevision + 1;
  const scope = parseConversationId(input.conversationId).scope;
  const authorityEntries =
    lifecycleMutation === undefined
      ? [
          runRecord(input.conversationId, {
            t: "session-control",
            domainRevision: revision,
            requestId: input.canonicalRequestId,
            mutation: body.mutation,
          }),
        ]
      : lifecycleMutation === "delete" && scope.kind === "workscene"
        ? worksceneSessionMetaEntries(input.conversationId, {
            t: "session-meta",
            operation: "delete",
            domainRevision: revision,
            requestId: input.canonicalRequestId,
            sceneId: scope.sceneId,
            lastActiveAt: input.authorityAt,
          })
        : [
            runRecord(input.conversationId, {
              t: "session-lifecycle",
              mutation: lifecycleMutation,
              domainRevision: revision,
              requestId: input.canonicalRequestId,
            }),
          ];
  return {
    result: {
      v: 1,
      status: "ok",
      body: { t: "session-write", revision },
    },
    authorityEntries,
  };
}
