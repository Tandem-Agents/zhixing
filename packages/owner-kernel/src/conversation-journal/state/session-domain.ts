import { Buffer } from "node:buffer";
import {
  advancementSubmissionRequestId,
  applyAdvancementEvent,
  assertAdvancementEventBatchLegal,
  isAdvancementControlEvent,
  type AdvancementControlEvent,
  type AdvancementFoldMap,
  type AdvancementSubmissionReceipt,
} from "@zhixing-ai/core/advancement";
import type { ArtifactStore } from "@zhixing-ai/core/authority";
import { parseConversationId } from "@zhixing-ai/core/conversation";
import type {
  LogicalRecord,
  MutationBatch,
  SegmentRecord,
  SessionControlMutation,
  SessionInternalRecord,
  SessionStagedMutation,
  TaskListState,
  TranscriptRunRecord,
} from "@zhixing-ai/core/contracts";
import {
  canonicalize,
  protocolDigest,
  verifyProtocolStep,
} from "@zhixing-ai/core/protocol";
import {
  corruptRunJournal,
  type ConversationRunJournalRecord,
  type Stored,
} from "../../conversation-run-contracts.js";
import type {
  ConversationFactGroup,
  ConversationLifecycleProjectionRecord,
  ConversationRunReductionContext,
  PendingLifecycleProjection,
} from "../contracts.js";
import { runRecord, snapshot } from "./common.js";

export interface SessionDomainMutableSlice {
  domainRevision: number;
  deleted: boolean;
  activeAdvancementSessionId?: string;
  readonly advancementSessions: AdvancementFoldMap;
  readonly advancementWrites: Map<
    string,
    {
      readonly domainRevision: number;
      readonly eventsDigest: string;
      readonly receipt?: AdvancementSubmissionReceipt;
    }
  >;
  readonly sessionMutationDigests: Map<
    string,
    { readonly digest: string; readonly domainRevision: number }
  >;
  readonly taskListRequestIds: Set<string>;
  taskList: TaskListState;
  readonly segments: Pick<SegmentRecord, "segmentId" | "timestamp">[];
  readonly worksceneControls: Map<
    string,
    { readonly record: TranscriptRunRecord; readonly advancementSessionId?: string }
  >;
  clearedThroughLsn: number;
  clearedThroughRevision?: number;
  sessionName?: string;
  lastActiveAt?: string;
  sessionMeta?: Extract<ConversationRunJournalRecord, { t: "session-meta" }>;
  readonly sessionMetaByRequest: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "session-meta" }>
  >;
  readonly lifecycleByRequest: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "session-lifecycle" }>
  >;
  readonly pendingLifecycleProjections: Map<number, PendingLifecycleProjection>;
  readonly projectedLifecycleRevisions: Set<number>;
}

export function isAdvancementCleanupEvent(event: AdvancementControlEvent): boolean {
  return (
    event.type === "review_root_settled" ||
    (event.type === "review_attempt_transitioned" &&
      ["consumed", "expired", "deferred"].includes(event.attempt.phase))
  );
}

export function findActiveAdvancementSessionId(
  state: Pick<
    SessionDomainMutableSlice,
    "activeAdvancementSessionId" | "advancementSessions"
  >,
): string | undefined {
  return (
    state.activeAdvancementSessionId ??
    [...state.advancementSessions.values()].find(
      (session) => session.status === "active",
    )?.id
  );
}

export function assertLegalAdvancementEvents(
  state: Pick<SessionDomainMutableSlice, "advancementSessions">,
  events: readonly AdvancementControlEvent[],
): void {
  assertAdvancementEventBatchLegal(state.advancementSessions, events);
}

export function applyProjectedSessionMutation(
  state: Pick<SessionDomainMutableSlice, "taskList" | "segments" | "sessionName">,
  mutation:
    | Exclude<SessionControlMutation, { readonly kind: "advancement-event" }>
    | SessionStagedMutation,
): void {
  switch (mutation.kind) {
    case "task-list-op":
      state.taskList = snapshot(mutation.op.state, "Task-list state");
      return;
    case "segment-append": {
      const previous = state.segments.at(-1);
      if (
        previous &&
        (previous.segmentId === mutation.segment.segmentId ||
          Date.parse(previous.timestamp) > Date.parse(mutation.segment.timestamp))
      ) {
        throw corruptRunJournal("Segment history is duplicated or non-monotonic");
      }
      const snap = snapshot(mutation.segment, "Segment record");
      state.segments.push({
        segmentId: snap.segmentId,
        timestamp: snap.timestamp,
      });
      return;
    }
    case "session-meta":
      if (mutation.patch.name !== undefined) state.sessionName = mutation.patch.name;
      return;
    case "window-op":
      if (mutation.op !== "compact") {
        throw corruptRunJournal(
          "Lifecycle window clear was written as a session mutation",
        );
      }
      return;
    case "conversation-delete":
      throw corruptRunJournal("Conversation delete was written as a session mutation");
  }
}

export function applyCommittedSessionMutations(
  state: Pick<
    SessionDomainMutableSlice,
    | "domainRevision"
    | "sessionMutationDigests"
    | "taskListRequestIds"
    | "taskList"
    | "segments"
    | "sessionName"
  >,
  records: readonly MutationBatch["records"][number][],
  throughRevision = Infinity,
): void {
  for (const record of records) {
    if (record.domain !== "session") continue;
    const digest = protocolDigest("SessionStagedMutation", 1, record.mutation);
    const existing = state.sessionMutationDigests.get(record.requestId);
    if (existing !== undefined && existing.digest !== digest) {
      throw corruptRunJournal(
        "Staged session request is already bound to another payload",
      );
    }
    if (existing === undefined) {
      if (state.domainRevision >= throughRevision) return;
      state.domainRevision += 1;
      state.sessionMutationDigests.set(record.requestId, {
        digest,
        domainRevision: state.domainRevision,
      });
      if (record.mutation.kind === "task-list-op") {
        state.taskListRequestIds.add(record.requestId);
      }
      applyProjectedSessionMutation(state, record.mutation as SessionStagedMutation);
    }
  }
}

export function applyCommittedSessionEffects(input: {
  readonly state: SessionDomainMutableSlice;
  readonly runRecord?: TranscriptRunRecord;
  readonly isWorksceneContinuation: boolean;
  readonly batchRecords: readonly MutationBatch["records"][number][];
  readonly envelopeAt: string;
}): void {
  const { state, runRecord } = input;
  if (
    runRecord &&
    (runRecord.postTurnControl || input.isWorksceneContinuation)
  ) {
    const advancementSessionId = findActiveAdvancementSessionId(state);
    state.worksceneControls.set(runRecord.runId, {
      record: snapshot(runRecord, "Committed workscene control"),
      ...(advancementSessionId ? { advancementSessionId } : {}),
    });
  }
  applyCommittedSessionMutations(state, input.batchRecords);
  state.lastActiveAt = input.envelopeAt;
}

export function worksceneTurnActivityEntries(
  conversationId: string,
  sessionRevision: number,
  assignmentId: string,
  at: string,
  operation: "create" | "touch",
): LogicalRecord<unknown>[] {
  const scope = parseConversationId(conversationId).scope;
  if (scope.kind !== "workscene") return [];
  return worksceneSessionMetaEntries(conversationId, {
    t: "session-meta",
    operation,
    domainRevision: sessionRevision,
    requestId: `session-activity:${assignmentId}`,
    sceneId: scope.sceneId,
    lastActiveAt: at,
  });
}

export function worksceneSessionMetaEntries(
  conversationId: string,
  meta: Extract<ConversationRunJournalRecord, { t: "session-meta" }>,
): LogicalRecord<unknown>[] {
  const operation = meta.operation === "delete" ? "delete" : "upsert";
  return [
    runRecord(conversationId, meta),
    {
      stream: `session-activity:${conversationId}`,
      body: {
        kind: "session-activity",
        operation,
        conversationId,
        sceneId: meta.sceneId,
        sessionRevision: meta.domainRevision,
        lastActiveAt: meta.lastActiveAt,
      } satisfies Extract<SessionInternalRecord, { kind: "session-activity" }>,
    },
  ];
}

export function envelopeContainsSessionActivity(
  envelope: ConversationFactGroup,
  conversationId: string,
  meta: Extract<ConversationRunJournalRecord, { t: "session-meta" }>,
): boolean {
  const expected = {
    kind: "session-activity",
    operation: meta.operation === "delete" ? "delete" : "upsert",
    conversationId,
    sceneId: meta.sceneId,
    sessionRevision: meta.domainRevision,
    lastActiveAt: meta.lastActiveAt,
  };
  return envelope.entries.some(
    (entry) =>
      entry.stream === `session-activity:${conversationId}` &&
      canonicalize(entry.body) === canonicalize(expected),
  );
}

export function assertWorksceneIdentity(
  conversationId: string,
  sceneId: string,
): void {
  const scope = parseConversationId(conversationId).scope;
  if (scope.kind !== "workscene" || scope.sceneId !== sceneId) {
    throw new TypeError(
      "Workscene session metadata does not match its conversation identity",
    );
  }
}

export function assertCanonicalActivityTime(value: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError("Session activity time is invalid");
  }
}

export function applyLifecycleProjectionInternalRecord(
  state: Pick<
    SessionDomainMutableSlice,
    "pendingLifecycleProjections" | "projectedLifecycleRevisions"
  >,
  body: ConversationLifecycleProjectionRecord,
): void {
  const pending = state.pendingLifecycleProjections.get(body.domainRevision);
  if (
    !pending ||
    pending.mutation !== body.mutation ||
    pending.requestId !== body.requestId ||
    state.projectedLifecycleRevisions.has(body.domainRevision)
  ) {
    throw corruptRunJournal(
      "Lifecycle projection progress does not name one pending lifecycle fact",
    );
  }
  state.projectedLifecycleRevisions.add(body.domainRevision);
  state.pendingLifecycleProjections.delete(body.domainRevision);
}

async function loadInlineOrArtifact<T>(
  stored: Stored<T>,
  artifacts: ArtifactStore,
): Promise<T> {
  if (
    typeof stored === "object" &&
    stored !== null &&
    Object.keys(stored).length === 1 &&
    "ref" in stored
  ) {
    return JSON.parse(
      Buffer.from(await artifacts.get(stored.ref)).toString("utf8"),
    ) as T;
  }
  return snapshot(stored as T, "Inline run journal value");
}

export async function reduceConversationSessionFact<
  State extends SessionDomainMutableSlice = SessionDomainMutableSlice,
>(
  context: Pick<
    ConversationRunReductionContext,
    "conversationId" | "artifacts" | "verifier"
  >,
  state: State,
  body: Extract<
    ConversationRunJournalRecord,
    {
      t:
        | "session-meta"
        | "session-control"
        | "session-lifecycle"
        | "advancement-event";
    }
  >,
  envelope: ConversationFactGroup,
  sourceLsn: number,
): Promise<State> {
  switch (body.t) {
    case "session-meta": {
      assertWorksceneIdentity(context.conversationId, body.sceneId);
      const current = state.sessionMeta;
      if (
        body.domainRevision !== state.domainRevision + 1 ||
        state.sessionMetaByRequest.has(body.requestId) ||
        (body.operation === "create" && current !== undefined) ||
        (body.operation !== "create" &&
          (!current || current.sceneId !== body.sceneId)) ||
        (body.operation !== "delete" && state.deleted) ||
        (current !== undefined &&
          Date.parse(body.lastActiveAt) < Date.parse(current.lastActiveAt))
      ) {
        throw corruptRunJournal(
          "Session metadata transition is not the unique next owner mutation",
        );
      }
      if (
        !envelopeContainsSessionActivity(
          envelope,
          context.conversationId,
          body,
        )
      ) {
        throw corruptRunJournal(
          "Session metadata transition lacks its atomic activity fact",
        );
      }
      state.domainRevision = body.domainRevision;
      state.sessionMeta = body;
      state.sessionMetaByRequest.set(body.requestId, body);
      if (body.operation === "delete") {
        state.deleted = true;
        state.pendingLifecycleProjections.set(body.domainRevision, {
          mutation: "delete",
          domainRevision: body.domainRevision,
          requestId: body.requestId,
        });
      }
      return state;
    }
    case "session-control": {
      const digest = protocolDigest("SessionControlMutation", 1, body.mutation);
      const existing = state.sessionMutationDigests.get(body.requestId);
      if (existing !== undefined) {
        if (
          existing.digest !== digest ||
          existing.domainRevision !== body.domainRevision
        ) {
          throw corruptRunJournal(
            "Session mutation request is already bound to another payload",
          );
        }
        return state;
      }
      if (body.domainRevision !== state.domainRevision + 1 || state.deleted) {
        throw corruptRunJournal("Session mutation revision or terminal state is invalid");
      }
      state.domainRevision = body.domainRevision;
      state.sessionMutationDigests.set(body.requestId, {
        digest,
        domainRevision: body.domainRevision,
      });
      if (body.mutation.kind === "task-list-op") {
        state.taskListRequestIds.add(body.requestId);
      }
      applyProjectedSessionMutation(state, body.mutation);
      state.lastActiveAt = envelope.at;
      return state;
    }
    case "session-lifecycle": {
      if (
        body.domainRevision !== state.domainRevision + 1 ||
        state.deleted ||
        state.lifecycleByRequest.has(body.requestId)
      ) {
        throw corruptRunJournal(
          "Session lifecycle revision or terminal state is invalid",
        );
      }
      state.domainRevision = body.domainRevision;
      state.lifecycleByRequest.set(body.requestId, body);
      state.pendingLifecycleProjections.set(body.domainRevision, body);
      if (body.mutation === "clear") {
        state.clearedThroughLsn = sourceLsn;
        state.clearedThroughRevision = body.domainRevision;
        state.taskList = { items: [] };
        state.segments.length = 0;
      } else {
        state.deleted = true;
      }
      state.lastActiveAt = envelope.at;
      return state;
    }
    case "advancement-event": {
      const rawEvent = await loadInlineOrArtifact(body.event, context.artifacts);
      const event = await verifyProtocolStep(() => {
        if (!isAdvancementControlEvent(rawEvent, context.verifier)) {
          throw corruptRunJournal("Run journal contains an invalid advancement event");
        }
        return rawEvent;
      });
      if (state.deleted && !isAdvancementCleanupEvent(event)) {
        throw corruptRunJournal(
          "Deleted conversation contains a non-maintenance advancement event",
        );
      }
      try {
        assertAdvancementEventBatchLegal(state.advancementSessions, [event]);
      } catch (error) {
        throw corruptRunJournal(
          error instanceof Error ? error.message : String(error),
        );
      }
      const existingWrite = state.advancementWrites.get(body.requestId);
      if (existingWrite) {
        if (
          existingWrite.domainRevision !== body.domainRevision ||
          existingWrite.eventsDigest !== body.eventsDigest
        ) {
          throw corruptRunJournal(
            "Advancement write identity has conflicting durable payloads",
          );
        }
      } else {
        if (body.domainRevision <= state.domainRevision) {
          throw corruptRunJournal(
            "Advancement event domain revision is not monotonic",
          );
        }
        state.advancementWrites.set(body.requestId, {
          domainRevision: body.domainRevision,
          eventsDigest: body.eventsDigest,
        });
        state.domainRevision = body.domainRevision;
      }
      if (event.type === "submission_settled") {
        if (
          event.conversationId !== context.conversationId ||
          body.requestId !==
            advancementSubmissionRequestId(
              context.conversationId,
              event.receipt.identity.surfacePrincipal,
              event.receipt.identity.submissionId,
            )
        ) {
          throw corruptRunJournal("Advancement submission identity mismatch");
        }
        const write = state.advancementWrites.get(body.requestId)!;
        if (
          write.receipt &&
          canonicalize(write.receipt) !== canonicalize(event.receipt)
        ) {
          throw corruptRunJournal("Conflicting advancement receipt");
        }
        state.advancementWrites.set(body.requestId, {
          ...write,
          receipt: structuredClone(event.receipt),
        });
      }
      applyAdvancementEvent(state.advancementSessions, event);
      state.activeAdvancementSessionId = [
        ...state.advancementSessions.values(),
      ].find((session) => session.status === "active")?.id;
      return state;
    }
  }
}
