import { Buffer } from "node:buffer";
import type {
  ArtifactRef,
  AssignmentRecord,
  ConversationCommitBundle,
  ContentAssetRef,
  JobCommitBundle,
  MutationBatch,
  SealedBundle,
  TranscriptRunRecord,
} from "../contracts/index.js";
import { byteDigest, canonicalize, protocolDigest } from "./canonical.js";
import { validateJobCommitFence } from "./job.js";
import { assertProtocolIdentifier as assertIdentifier } from "./validation.js";
import { validateMessages } from "./values.js";

type StagedMutationRecord = Extract<AssignmentRecord, { t: "staged-mutation" }>;
type ConversationSealedBundle = SealedBundle & { body: ConversationCommitBundle };
type JobSealedBundle = SealedBundle & { body: JobCommitBundle };

export interface ArtifactValue<T> {
  readonly value: T;
  readonly bytes: Uint8Array;
  readonly ref: ArtifactRef;
}

export function createMutationBatch(
  assignmentId: string,
  records: readonly StagedMutationRecord[],
): MutationBatch {
  assertIdentifier(assignmentId, "Mutation batch assignmentId");
  const normalized = records.map((record) => snapshot(record, "Staged mutation"));
  validateStagedMutations(assignmentId, normalized);
  const payload = {
    v: 1 as const,
    assignmentId,
    records: normalized,
    count: normalized.length,
  };
  return {
    ...payload,
    digest: protocolDigest("MutationBatch", 1, payload),
  };
}

export function validateMutationBatch(value: MutationBatch): MutationBatch {
  assertPlainObject(value, "Mutation batch");
  assertExactKeys(
    value,
    ["assignmentId", "count", "digest", "records", "v"],
    "Mutation batch",
  );
  if (value.v !== 1) throw new TypeError("Mutation batch version must be 1");
  assertIdentifier(value.assignmentId, "Mutation batch assignmentId");
  if (!Array.isArray(value.records)) {
    throw new TypeError("Mutation batch records must be an array");
  }
  if (!Number.isSafeInteger(value.count) || value.count < 0) {
    throw new TypeError("Mutation batch count must be a non-negative safe integer");
  }
  if (value.count !== value.records.length) {
    throw new TypeError("Mutation batch count does not match its records");
  }
  validateStagedMutations(value.assignmentId, value.records);
  const { digest, ...payload } = value;
  if (digest !== protocolDigest("MutationBatch", 1, payload)) {
    throw new TypeError("Mutation batch digest does not match its payload");
  }
  return snapshot(value, "Mutation batch");
}

/** Validates the closed staged-write surface available to a job assignment. */
export function validateJobMutationBatch(value: MutationBatch): MutationBatch {
  const batch = validateMutationBatch(value);
  for (const record of batch.records) validateJobStagedMutationRecord(record);
  return batch;
}

/**
 * Validates one staged-mutation record without revalidating its assignment
 * prefix. Sequence continuity and request-id uniqueness remain the caller's
 * projection responsibility; the closed mutation union is validated here once.
 */
export function validateStagedMutationRecord(
  value: unknown,
): StagedMutationRecord {
  const record = snapshot(value, "Staged mutation") as StagedMutationRecord;
  validateStagedMutationShape(record);
  return record;
}

/**
 * Jobs have no turn origin. This predicate is shared by producer, replay and
 * owner trust boundaries so the TypeScript-only job union cannot be bypassed
 * by deserialized protocol data.
 */
export function validateJobStagedMutationRecord(
  value: unknown,
): StagedMutationRecord {
  const record = validateStagedMutationRecord(value);
  if (record.domain !== "global") {
    throw new TypeError("Job mutation batch cannot contain session mutations");
  }
  if (
    record.mutation.kind === "delivery-enqueue" &&
    record.mutation.request.target.kind !== "explicit"
  ) {
    throw new TypeError("Job assignments require an explicit staged delivery target");
  }
  return record;
}

export function mutationBatchArtifact(batch: MutationBatch): ArtifactValue<MutationBatch> {
  const value = validateMutationBatch(batch);
  return artifactValue(value);
}

export function createConversationSealedBundle(
  input: Omit<ConversationSealedBundle, "v" | "digest">,
): ConversationSealedBundle {
  assertPlainObject(input, "Sealed bundle input");
  assertExactKeys(
    input,
    [
      "assignmentId",
      "body",
      "dependencyArtifacts",
      "executorId",
      "streamFinal",
      "usage",
      "usageFinal",
    ],
    "Sealed bundle input",
  );
  const payload = snapshot(
    {
      v: 1 as const,
      assignmentId: input.assignmentId,
      executorId: input.executorId,
      streamFinal: input.streamFinal,
      usage: input.usage,
      usageFinal: input.usageFinal,
      dependencyArtifacts: input.dependencyArtifacts,
      body: input.body,
    },
    "Sealed bundle payload",
  );
  const bundle = {
    ...payload,
    digest: protocolDigest("SealedBundle", 1, payload),
  } as ConversationSealedBundle;
  return validateConversationSealedBundle(bundle);
}

export function validateConversationSealedBundle(
  value: SealedBundle,
): ConversationSealedBundle {
  assertSealedBundle(value);
  return validateConversationSealedBundleBody(value);
}

function validateConversationSealedBundleBody(
  value: SealedBundle,
): ConversationSealedBundle {
  assertConversationBody(value.body);
  const rootDigests = new Set(conversationBundleRoots(value.body).map((ref) => ref.digest));
  assertNoRepeatedRoots(value.dependencyArtifacts, rootDigests);
  return snapshot(value, "Sealed bundle") as ConversationSealedBundle;
}

export function createJobSealedBundle(
  input: Omit<JobSealedBundle, "v" | "digest">,
): JobSealedBundle {
  assertPlainObject(input, "Sealed bundle input");
  assertExactKeys(
    input,
    [
      "assignmentId",
      "body",
      "dependencyArtifacts",
      "executorId",
      "streamFinal",
      "usage",
      "usageFinal",
    ],
    "Sealed bundle input",
  );
  const payload = snapshot(
    {
      v: 1 as const,
      assignmentId: input.assignmentId,
      executorId: input.executorId,
      streamFinal: input.streamFinal,
      usage: input.usage,
      usageFinal: input.usageFinal,
      dependencyArtifacts: input.dependencyArtifacts,
      body: input.body,
    },
    "Sealed bundle payload",
  );
  return validateJobSealedBundle({
    ...payload,
    digest: protocolDigest("SealedBundle", 1, payload),
  });
}

export function validateJobSealedBundle(value: SealedBundle): JobSealedBundle {
  assertSealedBundle(value);
  return validateJobSealedBundleBody(value);
}

function validateJobSealedBundleBody(value: SealedBundle): JobSealedBundle {
  assertJobBody(value.body);
  const rootDigests = new Set(jobBundleRoots(value.body).map((ref) => ref.digest));
  assertNoRepeatedRoots(value.dependencyArtifacts, rootDigests);
  return snapshot(value, "Sealed bundle") as JobSealedBundle;
}

/** Validates the complete discriminated SealedBundle union. */
export function validateSealedBundle(
  value: SealedBundle,
): ConversationSealedBundle | JobSealedBundle {
  assertSealedBundle(value);
  assertPlainObject(value.body, "Sealed bundle body");
  if (value.body.t === "conversation") {
    return validateConversationSealedBundleBody(value);
  }
  if (value.body.t === "job") {
    return validateJobSealedBundleBody(value);
  }
  throw new TypeError("Sealed bundle execution kind is invalid");
}

function assertSealedBundle(value: SealedBundle): void {
  assertPlainObject(value, "Sealed bundle");
  assertExactKeys(
    value,
    [
      "assignmentId",
      "body",
      "dependencyArtifacts",
      "digest",
      "executorId",
      "streamFinal",
      "usage",
      "usageFinal",
      "v",
    ],
    "Sealed bundle",
  );
  if (value.v !== 1) throw new TypeError("Sealed bundle version must be 1");
  assertIdentifier(value.assignmentId, "Sealed bundle assignmentId");
  assertIdentifier(value.executorId, "Sealed bundle executorId");
  assertExactKeys(value.streamFinal, ["finalSeq", "streamDigest"], "Stream final");
  assertPositiveInteger(value.streamFinal.finalSeq, "Stream final sequence");
  assertDigest(value.streamFinal.streamDigest, "Stream final digest");
  assertExactKeys(
    value.usage,
    ["inputTokens", "outputTokens", "toolCalls"],
    "Sealed usage",
  );
  assertNonNegativeInteger(value.usage.inputTokens, "Usage input tokens");
  assertNonNegativeInteger(value.usage.outputTokens, "Usage output tokens");
  assertNonNegativeInteger(value.usage.toolCalls, "Usage tool calls");
  assertExactKeys(
    value.usageFinal,
    ["reportDigest", "upToUsageSeq"],
    "Usage final",
  );
  assertDigest(value.usageFinal.reportDigest, "Usage report digest");
  assertNonNegativeInteger(value.usageFinal.upToUsageSeq, "Usage final sequence");
  assertSortedUniqueRefs(value.dependencyArtifacts, "Bundle dependencies");
  const { digest, ...payload } = value;
  if (digest !== protocolDigest("SealedBundle", 1, payload)) {
    throw new TypeError("Sealed bundle digest does not match its payload");
  }
}

export function sealedBundleArtifact(
  bundle: ConversationSealedBundle,
): ArtifactValue<ConversationSealedBundle>;
export function sealedBundleArtifact(
  bundle: JobSealedBundle,
): ArtifactValue<JobSealedBundle>;
export function sealedBundleArtifact(
  bundle: SealedBundle,
): ArtifactValue<SealedBundle>;
export function sealedBundleArtifact(
  bundle: SealedBundle,
): ArtifactValue<SealedBundle> {
  const value = validateSealedBundle(bundle);
  return artifactValue(value);
}

export function conversationBundleRoots(body: ConversationCommitBundle): ArtifactRef[] {
  return deduplicateRefs(collectEmbeddedArtifactRefs(body));
}

export function jobBundleRoots(body: JobCommitBundle): ArtifactRef[] {
  return deduplicateRefs(collectEmbeddedArtifactRefs(body));
}

function assertNoRepeatedRoots(
  dependencies: readonly ArtifactRef[],
  roots: ReadonlySet<string>,
): void {
  for (const dependency of dependencies) {
    if (roots.has(dependency.digest)) {
      throw new TypeError("Bundle dependencies must not repeat direct body roots");
    }
  }
}

export function validateTranscriptRunRecord(
  value: TranscriptRunRecord,
  expectedRunId?: string,
): TranscriptRunRecord {
  assertPlainObject(value, "Transcript run record");
  assertExactKeys(
    value,
    [
      "advancement",
      "messages",
      "perspectives",
      "runId",
      "runIndex",
      "source",
      "timestamp",
      "type",
      "usage",
    ],
    "Transcript run record",
    true,
  );
  if (value.type !== "run") throw new TypeError("Transcript run record type must be run");
  assertIdentifier(value.runId, "Transcript run id");
  if (expectedRunId !== undefined && value.runId !== expectedRunId) {
    throw new TypeError("Transcript run id does not match the commit bundle");
  }
  assertNonNegativeInteger(value.runIndex, "Transcript run index");
  canonicalTime(value.timestamp, "Transcript run timestamp");
  if (!Array.isArray(value.messages)) {
    throw new TypeError("Transcript run messages must be an array");
  }
  if (value.messages.length === 0) {
    throw new TypeError("Transcript run messages must contain the originating user message");
  }
  validateMessages(value.messages, "Transcript run messages");
  if (value.messages[0]?.role !== "user") {
    throw new TypeError("Transcript run must begin with the originating user message");
  }
  if (value.usage !== undefined) validateTranscriptUsage(value.usage);
  if (
    value.source !== undefined &&
    !new Set(["interactive", "scheduler", "channel", "advancement"]).has(value.source)
  ) {
    throw new TypeError("Transcript run source is invalid");
  }
  if (value.advancement !== undefined) {
    assertPlainObject(value.advancement, "Transcript advancement metadata");
    assertExactKeys(
      value.advancement,
      ["proxyMessageId", "reviewId", "rubricFailureHandlingId", "sessionId"],
      "Transcript advancement metadata",
      true,
    );
    assertIdentifier(value.advancement.sessionId, "Advancement session id");
    for (const [key, item] of Object.entries(value.advancement)) {
      if (key !== "sessionId") assertIdentifier(item, `Advancement ${key}`);
    }
  }
  if (value.perspectives !== undefined) {
    assertPlainObject(value.perspectives, "Transcript perspectives metadata");
    assertExactKeys(
      value.perspectives,
      ["definitionId", "perspectiveCount"],
      "Transcript perspectives metadata",
    );
    assertIdentifier(value.perspectives.definitionId, "Perspectives definition id");
    assertPositiveInteger(value.perspectives.perspectiveCount, "Perspective count");
  }
  return snapshot(value, "Transcript run record");
}

function validateTranscriptUsage(value: unknown): void {
  assertPlainObject(value, "Transcript usage");
  assertExactKeys(
    value,
    [
      "cacheReadTokens",
      "cacheWriteTokens",
      "inputTokens",
      "outputTokens",
      "totalInputTokens",
    ],
    "Transcript usage",
    true,
  );
  if (!("inputTokens" in value) || !("outputTokens" in value)) {
    throw new TypeError("Transcript usage is incomplete");
  }
  for (const [key, item] of Object.entries(value)) {
    assertNonNegativeInteger(item, `Transcript usage ${key}`);
  }
  if (
    value.totalInputTokens !== undefined &&
    ((value.totalInputTokens as number) < (value.inputTokens as number) ||
      (value.totalInputTokens as number) <
        Number(value.cacheReadTokens ?? 0) + Number(value.cacheWriteTokens ?? 0))
  ) {
    throw new TypeError("Transcript total input tokens violate the canonical usage bounds");
  }
}

function validateStagedMutations(
  assignmentId: string,
  records: readonly StagedMutationRecord[],
): void {
  let expectedSeq = 1;
  const requestIds = new Set<string>();
  for (const record of records) {
    validateStagedMutationShape(record);
    if (record.seq !== expectedSeq) {
      throw new TypeError("Staged mutation sequence must be contiguous from one");
    }
    expectedSeq += 1;
    if (requestIds.has(record.requestId)) {
      throw new TypeError("Staged mutation requestId must be unique within an assignment");
    }
    requestIds.add(record.requestId);
  }
  void assignmentId;
}

function validateStagedMutationShape(record: StagedMutationRecord): void {
  assertPlainObject(record, "Staged mutation");
  assertExactKeys(
    record,
    ["domain", "expected", "mutation", "requestId", "seq", "t", "v"],
    "Staged mutation",
    true,
  );
  if (record.v !== 1 || record.t !== "staged-mutation") {
    throw new TypeError("Mutation batch contains a non-staged record");
  }
  assertPositiveInteger(record.seq, "Staged mutation sequence");
  assertIdentifier(record.requestId, "Staged mutation requestId");
  assertPlainObject(record.mutation, "Staged mutation payload");
  if (record.domain === "session") {
    if (record.expected !== undefined) {
      throw new TypeError("Session staged mutation cannot declare anchor authority");
    }
    validateSessionStagedMutation(record.mutation);
  } else if (record.domain === "global") {
    assertPlainObject(record.expected, "Global staged mutation authority");
    assertExactKeys(record.expected, ["anchorEpoch"], "Global staged mutation authority");
    assertNonNegativeInteger(record.expected.anchorEpoch, "Global anchor epoch");
    validateGlobalStagedMutation(record.mutation);
  } else {
    throw new TypeError("Staged mutation domain is invalid");
  }
}

function validateSessionStagedMutation(mutation: StagedMutationRecord["mutation"]): void {
  switch (mutation.kind) {
    case "task-list-op": {
      assertExactKeys(mutation, ["kind", "op"], "Task-list staged mutation");
      assertPlainObject(mutation.op, "Task-list operation");
      assertExactKeys(mutation.op, ["op", "state"], "Task-list operation");
      if (mutation.op.op !== "set") throw new TypeError("Task-list operation must be set");
      assertPlainObject(mutation.op.state, "Task-list state");
      assertExactKeys(mutation.op.state, ["items"], "Task-list state");
      if (!Array.isArray(mutation.op.state.items)) {
        throw new TypeError("Task-list items must be an array");
      }
      for (const item of mutation.op.state.items) {
        assertPlainObject(item, "Task-list item");
        assertExactKeys(item, ["content", "id", "status"], "Task-list item");
        assertIdentifier(item.id, "Task-list item id");
        assertString(item.content, "Task-list item content");
        if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") {
          throw new TypeError("Task-list item status is invalid");
        }
      }
      return;
    }
    case "segment-append": {
      assertExactKeys(mutation, ["kind", "segment"], "Segment staged mutation");
      assertPlainObject(mutation.segment, "Segment record");
      assertExactKeys(
        mutation.segment,
        ["segmentId", "timestamp", "tokensAfter", "tokensBefore"],
        "Segment record",
      );
      assertIdentifier(mutation.segment.segmentId, "Segment id");
      canonicalTime(mutation.segment.timestamp, "Segment timestamp");
      assertNonNegativeInteger(mutation.segment.tokensBefore, "Segment tokens before");
      assertNonNegativeInteger(mutation.segment.tokensAfter, "Segment tokens after");
      return;
    }
    default:
      throw new TypeError("Session staged mutation kind is outside its closed union");
  }
}

function validateGlobalStagedMutation(mutation: StagedMutationRecord["mutation"]): void {
  switch (mutation.kind) {
    case "memory-append":
      assertExactKeys(mutation, ["kind", "payload"], "Memory staged mutation");
      validateMemoryAppend(mutation.payload);
      return;
    case "schedule-create":
      assertExactKeys(mutation, ["kind", "spec"], "Schedule create mutation");
      validateScheduleSpec(mutation.spec);
      return;
    case "schedule-update":
      assertExactKeys(
        mutation,
        ["kind", "spec", "taskId", "taskRevision"],
        "Schedule update mutation",
      );
      assertIdentifier(mutation.taskId, "Schedule task id");
      assertNonNegativeInteger(mutation.taskRevision, "Schedule task revision");
      validateScheduleSpec(mutation.spec);
      return;
    case "schedule-set-state":
      assertExactKeys(
        mutation,
        ["kind", "state", "taskId", "taskRevision"],
        "Schedule state mutation",
      );
      assertIdentifier(mutation.taskId, "Schedule task id");
      assertNonNegativeInteger(mutation.taskRevision, "Schedule task revision");
      if (mutation.state !== "enabled" && mutation.state !== "disabled") {
        throw new TypeError("Schedule task state is invalid");
      }
      return;
    case "schedule-delete":
      assertExactKeys(
        mutation,
        ["kind", "taskId", "taskRevision"],
        "Schedule delete mutation",
      );
      assertIdentifier(mutation.taskId, "Schedule task id");
      assertNonNegativeInteger(mutation.taskRevision, "Schedule task revision");
      return;
    case "skill-usage":
      assertExactKeys(mutation, ["kind", "record"], "Skill usage mutation");
      assertPlainObject(mutation.record, "Skill usage record");
      assertExactKeys(mutation.record, ["hitCount", "lastHitAt", "skillId"], "Skill usage record");
      assertIdentifier(mutation.record.skillId, "Skill id");
      canonicalTime(mutation.record.lastHitAt, "Skill last-hit time");
      assertNonNegativeInteger(mutation.record.hitCount, "Skill hit count");
      return;
    case "skill-create":
    case "skill-admit":
      assertExactKeys(mutation, ["kind", "record"], "Skill write mutation");
      validateSkillWrite(mutation.record);
      return;
    case "skill-update":
      assertExactKeys(
        mutation,
        ["expectedRevision", "kind", "record", "skillId"],
        "Skill update mutation",
      );
      assertIdentifier(mutation.skillId, "Skill id");
      assertNonNegativeInteger(mutation.expectedRevision, "Skill expected revision");
      validateSkillWrite(mutation.record);
      return;
    case "workscene-create":
      assertExactKeys(
        mutation,
        ["kind", "name", "workspace"],
        "Workscene create mutation",
        true,
      );
      assertString(mutation.name, "Workscene name");
      if (mutation.workspace !== undefined) validateWorkspace(mutation.workspace);
      return;
    case "workscene-rename":
      assertExactKeys(
        mutation,
        ["expectedRevision", "kind", "name", "sceneId"],
        "Workscene rename mutation",
      );
      assertIdentifier(mutation.sceneId, "Workscene id");
      assertString(mutation.name, "Workscene name");
      assertNonNegativeInteger(mutation.expectedRevision, "Workscene expected revision");
      return;
    case "workscene-set-workdir":
      assertExactKeys(
        mutation,
        ["expectedRevision", "kind", "sceneId", "workspace"],
        "Workscene workdir mutation",
      );
      assertIdentifier(mutation.sceneId, "Workscene id");
      assertNonNegativeInteger(mutation.expectedRevision, "Workscene expected revision");
      if (mutation.workspace !== null) validateWorkspace(mutation.workspace);
      return;
    case "workscene-delete":
      assertExactKeys(
        mutation,
        ["expectedRevision", "kind", "sceneId"],
        "Workscene delete mutation",
      );
      assertIdentifier(mutation.sceneId, "Workscene id");
      assertNonNegativeInteger(mutation.expectedRevision, "Workscene expected revision");
      return;
    case "delivery-enqueue":
      assertExactKeys(mutation, ["kind", "request"], "Delivery staged mutation");
      validateDeliveryRequest(mutation.request);
      return;
    default:
      throw new TypeError("Global staged mutation kind is outside its closed union");
  }
}

function validateMemoryAppend(payload: unknown): void {
  assertPlainObject(payload, "Memory append payload");
  switch (payload.domain) {
    case "memory":
      assertExactKeys(
        payload,
        ["category", "content", "domain", "id", "meta"],
        "Memory append payload",
      );
      if (payload.category !== "profile" && payload.category !== "person" && payload.category !== "journal") {
        throw new TypeError("Memory category is invalid");
      }
      assertIdentifier(payload.id, "Memory entry id");
      assertPlainObject(payload.meta, "Memory entry metadata");
      assertString(payload.content, "Memory entry content");
      return;
    case "journal":
      assertExactKeys(
        payload,
        ["content", "date", "domain"],
        "Journal append payload",
        true,
      );
      assertString(payload.content, "Journal content");
      if (payload.date !== undefined) assertString(payload.date, "Journal date");
      return;
    case "people":
      assertExactKeys(
        payload,
        ["content", "domain", "id", "meta"],
        "People append payload",
      );
      assertIdentifier(payload.id, "Person entry id");
      assertString(payload.content, "Person entry content");
      assertPlainObject(payload.meta, "Person metadata");
      assertExactKeys(
        payload.meta,
        ["birthday", "name", "relation", "tags"],
        "Person metadata",
        true,
      );
      assertString(payload.meta.name, "Person name");
      assertString(payload.meta.relation, "Person relation");
      if (payload.meta.birthday !== undefined) {
        assertString(payload.meta.birthday, "Person birthday");
      }
      if (payload.meta.tags !== undefined) {
        assertStringArray(payload.meta.tags, "Person tags");
      }
      return;
    default:
      throw new TypeError("Memory append domain is invalid");
  }
}

function validateScheduleSpec(spec: unknown): void {
  assertPlainObject(spec, "Schedule task spec");
  assertExactKeys(
    spec,
    ["action", "delivery", "description", "enabled", "name", "priority", "schedule"],
    "Schedule task spec",
    true,
  );
  assertString(spec.name, "Schedule task name");
  if (spec.description !== undefined) assertString(spec.description, "Schedule description");
  if (typeof spec.enabled !== "boolean") throw new TypeError("Schedule enabled must be boolean");
  if (!new Set(["low", "normal", "high", "urgent"]).has(String(spec.priority))) {
    throw new TypeError("Schedule priority is invalid");
  }
  validateSchedule(spec.schedule);
  assertPlainObject(spec.action, "Schedule action");
  assertExactKeys(
    spec.action,
    ["kind", "model", "prompt", "tools"],
    "Schedule action",
    true,
  );
  if (spec.action.kind !== "agent-turn") throw new TypeError("Schedule action is invalid");
  assertString(spec.action.prompt, "Schedule prompt");
  if (spec.action.model !== undefined) assertString(spec.action.model, "Schedule model");
  if (spec.action.tools !== undefined) assertStringArray(spec.action.tools, "Schedule tools");
  if (spec.delivery !== undefined) validateTaskDelivery(spec.delivery);
}

function validateSchedule(schedule: unknown): void {
  assertPlainObject(schedule, "Task schedule");
  switch (schedule.kind) {
    case "once":
      assertExactKeys(schedule, ["at", "kind"], "Once schedule");
      canonicalTime(schedule.at, "Once schedule time");
      return;
    case "interval":
      assertExactKeys(schedule, ["everyMs", "kind"], "Interval schedule");
      assertPositiveInteger(schedule.everyMs, "Schedule interval");
      return;
    case "cron":
      assertExactKeys(schedule, ["expr", "kind", "tz"], "Cron schedule", true);
      assertString(schedule.expr, "Cron expression");
      if (schedule.tz !== undefined) assertString(schedule.tz, "Cron timezone");
      return;
    default:
      throw new TypeError("Task schedule kind is invalid");
  }
}

function validateTaskDelivery(delivery: unknown): void {
  assertPlainObject(delivery, "Task delivery");
  switch (delivery.kind) {
    case "none":
      assertExactKeys(delivery, ["kind"], "Task delivery");
      return;
    case "channel":
      assertExactKeys(
        delivery,
        ["channel", "kind", "threadId", "to"],
        "Channel task delivery",
        true,
      );
      assertIdentifier(delivery.channel, "Delivery channel");
      assertIdentifier(delivery.to, "Delivery recipient");
      if (delivery.threadId !== undefined) assertIdentifier(delivery.threadId, "Delivery thread");
      return;
    case "webhook":
      assertExactKeys(delivery, ["endpoint", "kind"], "Webhook task delivery");
      validateSecretRef(delivery.endpoint);
      return;
    default:
      throw new TypeError("Task delivery kind is invalid");
  }
}

function validateSkillWrite(record: unknown): void {
  assertPlainObject(record, "Skill write record");
  assertExactKeys(record, ["content", "description", "name"], "Skill write record");
  assertString(record.name, "Skill name");
  assertString(record.description, "Skill description");
  assertArtifactRef(record.content);
}

function validateWorkspace(workspace: unknown): void {
  assertPlainObject(workspace, "Workscene workspace");
  assertExactKeys(workspace, ["bindingRef", "deviceId"], "Workscene workspace");
  assertIdentifier(workspace.deviceId, "Workspace device id");
  assertIdentifier(workspace.bindingRef, "Workspace binding ref");
}

function validateDeliveryRequest(request: unknown): void {
  assertPlainObject(request, "Delivery request");
  assertExactKeys(request, ["content", "target"], "Delivery request");
  if (typeof request.content !== "string") {
    assertPlainObject(request.content, "Delivery content reference");
    assertExactKeys(request.content, ["ref"], "Delivery content reference");
    assertArtifactRef(request.content.ref);
  }
  assertPlainObject(request.target, "Delivery request target");
  if (request.target.kind === "turn-origin") {
    assertExactKeys(request.target, ["kind"], "Turn-origin delivery target");
    return;
  }
  if (request.target.kind !== "explicit") {
    throw new TypeError("Delivery request target kind is invalid");
  }
  assertExactKeys(request.target, ["kind", "target"], "Explicit delivery target");
  assertPlainObject(request.target.target, "Delivery target");
  assertExactKeys(
    request.target.target,
    ["channelId", "threadId", "to"],
    "Delivery target",
    true,
  );
  assertIdentifier(request.target.target.channelId, "Delivery channel id");
  assertIdentifier(request.target.target.to, "Delivery recipient");
  if (request.target.target.threadId !== undefined) {
    assertIdentifier(request.target.target.threadId, "Delivery thread id");
  }
}

function validateSecretRef(value: unknown): void {
  assertPlainObject(value, "Secret reference");
  assertExactKeys(value, ["bindingId", "kind"], "Secret reference");
  if (!new Set(["provider", "channel", "mcp", "device-key", "webhook"]).has(String(value.kind))) {
    throw new TypeError("Secret reference kind is invalid");
  }
  assertIdentifier(value.bindingId, "Secret binding id");
}

function assertConversationBody(
  value: SealedBundle["body"],
): asserts value is ConversationCommitBundle {
  assertPlainObject(value, "Conversation commit bundle");
  if (value.t !== "conversation") {
    throw new TypeError("Sealed bundle must contain a conversation commit body");
  }
  assertExactKeys(
    value,
    [
      "baseRevision",
      "contentAssets",
      "conversationId",
      "mutationBatch",
      "ownerEpoch",
      "runId",
      "runRecord",
      "t",
      "windowCompact",
    ],
    "Conversation commit bundle",
    true,
  );
  assertIdentifier(value.runId, "Conversation commit runId");
  assertIdentifier(value.conversationId, "Conversation commit conversationId");
  assertNonNegativeInteger(value.ownerEpoch, "Conversation owner epoch");
  assertNonNegativeInteger(value.baseRevision, "Conversation base revision");
  if (isReferenceContainer(value.runRecord)) {
    assertExactKeys(value.runRecord, ["ref"], "Run record reference");
    assertArtifactRef(value.runRecord.ref);
  } else {
    validateTranscriptRunRecord(value.runRecord, value.runId);
  }
  if (!Array.isArray(value.contentAssets)) {
    throw new TypeError("Conversation content assets must be an array");
  }
  const assets = value.contentAssets as ContentAssetRef[];
  const seenAssets = new Set<string>();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index]!;
    assertPlainObject(asset, "Conversation content asset");
    assertExactKeys(
      asset,
      ["bytes", "digest", "kind"],
      "Conversation content asset",
    );
    assertDigest(asset.digest, "Conversation content asset digest");
    assertNonNegativeInteger(asset.bytes, "Conversation content asset bytes");
    if (!CONTENT_KINDS.has(asset.kind)) {
      throw new TypeError("Conversation content asset kind is invalid");
    }
    if (seenAssets.has(asset.digest)) {
      throw new TypeError("Conversation content assets must not contain duplicates");
    }
    seenAssets.add(asset.digest);
    if (index > 0 && assets[index - 1]!.digest >= asset.digest) {
      throw new TypeError("Conversation content assets must be sorted by digest");
    }
  }
  if (value.mutationBatch !== undefined) {
    assertExactKeys(
      value.mutationBatch,
      ["globalCount", "ref", "sessionCount"],
      "Mutation batch summary",
    );
    assertArtifactRef(value.mutationBatch.ref);
    assertNonNegativeInteger(value.mutationBatch.sessionCount, "Session mutation count");
    assertNonNegativeInteger(value.mutationBatch.globalCount, "Global mutation count");
    if (value.mutationBatch.sessionCount + value.mutationBatch.globalCount === 0) {
      throw new TypeError("Mutation batch summary cannot reference an empty batch");
    }
  }
  if (value.windowCompact !== undefined) {
    validateWindowCompact(value.windowCompact);
  }
}

function assertJobBody(
  value: SealedBundle["body"],
): asserts value is JobCommitBundle {
  assertPlainObject(value, "Job commit bundle");
  if (value.t !== "job") {
    throw new TypeError("Sealed bundle must contain a job commit body");
  }
  assertExactKeys(
    value,
    [
      "contentAssets",
      "fence",
      "jobRunId",
      "mutationBatch",
      "outcome",
      "t",
      "taskId",
    ],
    "Job commit bundle",
    true,
  );
  assertIdentifier(value.jobRunId, "Job commit jobRunId");
  assertIdentifier(value.taskId, "Job commit taskId");
  validateJobCommitFence(value.fence);
  if (
    value.fence.jobRunId !== value.jobRunId ||
    value.fence.taskId !== value.taskId
  ) {
    throw new TypeError("Job commit fence does not bind its bundle");
  }
  assertPlainObject(value.outcome, "Job outcome");
  assertExactKeys(value.outcome, ["status", "summary"], "Job outcome");
  if (value.outcome.status !== "completed" && value.outcome.status !== "failed") {
    throw new TypeError("Job outcome status is invalid");
  }
  assertString(value.outcome.summary, "Job outcome summary");
  if (!Array.isArray(value.contentAssets)) {
    throw new TypeError("Job content assets must be an array");
  }
  const assets = value.contentAssets as ContentAssetRef[];
  const seenAssets = new Set<string>();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index]!;
    assertPlainObject(asset, "Job content asset");
    assertExactKeys(asset, ["bytes", "digest", "kind"], "Job content asset");
    assertDigest(asset.digest, "Job content asset digest");
    assertNonNegativeInteger(asset.bytes, "Job content asset bytes");
    if (!CONTENT_KINDS.has(asset.kind)) {
      throw new TypeError("Job content asset kind is invalid");
    }
    if (seenAssets.has(asset.digest)) {
      throw new TypeError("Job content assets must not contain duplicates");
    }
    seenAssets.add(asset.digest);
    if (index > 0 && assets[index - 1]!.digest >= asset.digest) {
      throw new TypeError("Job content assets must be sorted by digest");
    }
  }
  if (value.mutationBatch !== undefined) {
    assertExactKeys(
      value.mutationBatch,
      ["globalCount", "ref", "sessionCount"],
      "Mutation batch summary",
    );
    assertArtifactRef(value.mutationBatch.ref);
    if (value.mutationBatch.sessionCount !== 0) {
      throw new TypeError("Job mutation batch cannot contain session mutations");
    }
    assertPositiveInteger(value.mutationBatch.globalCount, "Global mutation count");
  }
}

function validateWindowCompact(value: unknown): void {
  assertPlainObject(value, "Window compact instruction");
  assertExactKeys(
    value,
    [
      "pairsCompacted",
      "segmentId",
      "structuredSummary",
      "summary",
      "tokensAfter",
      "tokensBefore",
    ],
    "Window compact instruction",
    true,
  );
  for (const key of ["summary", "pairsCompacted", "tokensBefore", "tokensAfter"]) {
    if (!(key in value)) throw new TypeError("Window compact instruction is incomplete");
  }
  assertString(value.summary, "Window compact summary");
  assertNonNegativeInteger(value.pairsCompacted, "Window compact pair count");
  assertNonNegativeInteger(value.tokensBefore, "Window compact input tokens");
  assertNonNegativeInteger(value.tokensAfter, "Window compact output tokens");
  if (value.segmentId !== undefined) {
    assertIdentifier(value.segmentId, "Window compact segment id");
  }
  if (value.structuredSummary !== undefined) {
    assertPlainObject(value.structuredSummary, "Window compact structured summary");
    assertExactKeys(
      value.structuredSummary,
      ["active", "facts", "state"],
      "Window compact structured summary",
    );
    assertString(value.structuredSummary.facts, "Window compact facts");
    assertString(value.structuredSummary.state, "Window compact state");
    assertString(value.structuredSummary.active, "Window compact active context");
  }
}

const CONTENT_KINDS = new Set(["image", "file", "tool-output", "window-snapshot"]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function artifactValue<T>(value: T): ArtifactValue<T> {
  const bytes = Buffer.from(canonicalize(value), "utf8");
  return {
    value,
    bytes,
    ref: { digest: byteDigest(bytes), bytes: bytes.byteLength },
  };
}

function isReferenceContainer(value: unknown): value is { readonly ref: ArtifactRef } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "ref")
  );
}

function assertSortedUniqueRefs(values: readonly ArtifactRef[], label: string): void {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    assertArtifactRef(value);
    if (seen.has(value.digest)) throw new TypeError(`${label} must not contain duplicates`);
    seen.add(value.digest);
    const previous = values[index - 1];
    if (previous && previous.digest >= value.digest) {
      throw new TypeError(`${label} must be sorted by digest`);
    }
  }
}

function deduplicateRefs(values: readonly ArtifactRef[]): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  for (const value of values) {
    assertArtifactRef(value);
    const existing = refs.get(value.digest);
    if (existing && existing.bytes !== value.bytes) {
      throw new TypeError("Artifact digest declares conflicting byte counts");
    }
    refs.set(value.digest, value);
  }
  return [...refs.values()].sort((left, right) =>
    left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
  );
}

function collectEmbeddedArtifactRefs(value: unknown): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  const active = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (active.has(candidate)) throw new TypeError("Protocol value cannot contain cycles");
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.keys(candidate).length !== candidate.length) {
          throw new TypeError("Protocol arrays cannot be sparse or contain extra fields");
        }
        for (const item of candidate) visit(item);
        return;
      }
      assertPlainObject(candidate, "Protocol value");
      const record = candidate as Record<string, unknown>;
      if (typeof record.digest === "string" && typeof record.bytes === "number") {
        const ref = { digest: record.digest, bytes: record.bytes };
        assertArtifactRef(ref);
        refs.push(ref);
      }
      for (const nested of Object.values(record)) visit(nested);
    } finally {
      active.delete(candidate);
    }
  };
  visit(value);
  return refs;
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
  optional = false,
): void {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (optional) {
    if (keys.some((key) => !allowed.includes(key))) {
      throw new TypeError(`${label} contains an unknown field`);
    }
    return;
  }
  if (canonicalize(keys) !== canonicalize(allowed)) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} must be a string array`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertArtifactRef(value: unknown): asserts value is ArtifactRef {
  assertPlainObject(value, "Artifact reference");
  assertExactKeys(value, ["bytes", "digest"], "Artifact reference");
  assertDigest(value.digest, "Artifact reference digest");
  assertNonNegativeInteger(value.bytes, "Artifact reference bytes");
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function canonicalTime(value: unknown, label: string): number {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`, { cause: error });
  }
}
