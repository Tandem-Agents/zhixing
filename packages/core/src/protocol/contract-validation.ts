import type { ArtifactRef, AuthorityError } from "../contracts/foundation.js";
import type {
  ControlResultBody,
  MutationBatch,
  PublishRecord,
} from "../contracts/records.js";
import type {
  WorksceneAppliedResult,
  WorksceneDto,
  WorksceneWriteMutation,
} from "../contracts/state.js";
import { validateMutationBatch } from "./commit.js";
import { assertProtocolIdentifier } from "./validation.js";

export const MAX_AUTHORITY_ERROR_MESSAGE_BYTES = 4 * 1024;

const AUTHORITY_ERROR_CODES: ReadonlySet<AuthorityError["code"]> = new Set([
  "unauthorized",
  "capability-expired",
  "epoch-stale",
  "revision-conflict",
  "fence-rejected",
  "busy",
  "not-found",
  "invalid",
  "lease-exhausted",
  "missing-base",
  "typed-stale",
  "capability-gap",
  "unavailable-offline",
  "idempotency-conflict",
]);

export function validateAuthorityError(
  value: unknown,
  label = "Authority error",
): AuthorityError {
  assertPlainRecord(value, label);
  assertExactKeys(value, ["code", "message", "retryable"], label);
  if (
    typeof value.code !== "string" ||
    !AUTHORITY_ERROR_CODES.has(value.code as AuthorityError["code"])
  ) {
    throw new TypeError(`${label} code is invalid`);
  }
  if (
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    new TextEncoder().encode(value.message).byteLength > MAX_AUTHORITY_ERROR_MESSAGE_BYTES
  ) {
    throw new TypeError(`${label} message must be a non-empty bounded string`);
  }
  if (typeof value.retryable !== "boolean") {
    throw new TypeError(`${label} retryable must be boolean`);
  }
  return value as unknown as AuthorityError;
}

export function validatePublishDecisionRecord(
  value: unknown,
): Extract<PublishRecord, { t: "publish-decision" }> {
  assertPlainRecord(value, "Publish decision");
  assertExactKeys(
    value,
    ["assignmentId", "batch", "globalCount", "outcomes", "sessionCount", "t"],
    "Publish decision",
  );
  if (value.t !== "publish-decision") {
    throw new TypeError("Publish decision type is invalid");
  }
  assertProtocolIdentifier(value.assignmentId, "Publish assignment id");
  validateArtifactReference(value.batch, "Publish mutation batch");
  assertNonNegativeInteger(value.sessionCount, "Publish session count");
  assertNonNegativeInteger(value.globalCount, "Publish global count");
  if (!Array.isArray(value.outcomes)) {
    throw new TypeError("Publish decision outcomes must be an array");
  }
  const expectedCount = (value.sessionCount as number) + (value.globalCount as number);
  if (value.outcomes.length !== expectedCount) {
    throw new TypeError("Publish decision outcomes do not match its declared counts");
  }
  for (const [index, item] of value.outcomes.entries()) {
    assertPlainRecord(item, "Publish outcome");
    assertExactKeys(item, ["outcome", "seq"], "Publish outcome");
    assertPositiveInteger(item.seq, "Publish outcome sequence");
    if (item.seq !== index + 1) {
      throw new TypeError("Publish decision outcomes must be contiguous and ordered");
    }
    assertPlainRecord(item.outcome, "Publish outcome value");
    if (item.outcome.t === "granted") {
      assertExactKeys(
        item.outcome,
        item.outcome.appliedResult === undefined
          ? ["t", "targetRevision"]
          : ["appliedResult", "t", "targetRevision"],
        "Granted publish outcome",
      );
      assertPositiveInteger(item.outcome.targetRevision, "Granted target revision");
      if (item.outcome.appliedResult !== undefined) {
        validateWorksceneAppliedResult(item.outcome.appliedResult);
      }
    } else if (item.outcome.t === "conflicted") {
      assertExactKeys(item.outcome, ["error", "t"], "Conflicted publish outcome");
      validateAuthorityError(item.outcome.error, "Publish conflict error");
    } else {
      throw new TypeError("Publish outcome type is invalid");
    }
  }
  return value as unknown as Extract<PublishRecord, { t: "publish-decision" }>;
}

/**
 * Validates the publish decision together with the immutable batch it decides.
 * Producers and both replay paths share this predicate; callers only add facts
 * that are unavailable from the batch itself, such as a conversation revision.
 */
export function validatePublishDecisionForBatch(
  value: unknown,
  batchValue: MutationBatch,
): Extract<PublishRecord, { t: "publish-decision" }> {
  const decision = validatePublishDecisionRecord(value);
  const batch = validateMutationBatch(batchValue);
  if (decision.assignmentId !== batch.assignmentId) {
    throw new TypeError("Publish decision assignment does not match its mutation batch");
  }
  const sessionCount = batch.records.filter((record) => record.domain === "session").length;
  const globalCount = batch.records.length - sessionCount;
  if (
    decision.sessionCount !== sessionCount ||
    decision.globalCount !== globalCount ||
    decision.outcomes.length !== batch.records.length
  ) {
    throw new TypeError("Publish decision domain counts do not match its mutation batch");
  }
  for (const [index, record] of batch.records.entries()) {
    const item = decision.outcomes[index];
    if (!item || item.seq !== record.seq) {
      throw new TypeError("Publish decision sequence does not match its mutation batch");
    }
    if (record.domain === "session" && item.outcome.t !== "granted") {
      throw new TypeError("Session mutations must be granted by an accepted conversation commit");
    }
    validateOutcomeForMutation(item.outcome, record.mutation);
  }
  return decision;
}

function validateOutcomeForMutation(
  outcome: Extract<PublishRecord, { t: "publish-decision" }>["outcomes"][number]["outcome"],
  mutation: MutationBatch["records"][number]["mutation"],
): void {
  if (outcome.t === "conflicted") return;
  const workscene = isWorksceneMutation(mutation) ? mutation : undefined;
  if (!workscene) {
    if (outcome.appliedResult !== undefined) {
      throw new TypeError("Only a granted workscene mutation may carry an applied result");
    }
    return;
  }
  const result = outcome.appliedResult;
  if (!result) {
    throw new TypeError("A granted workscene mutation requires its applied result");
  }
  if (result.revision !== outcome.targetRevision) {
    throw new TypeError("Workscene result revision does not match its publish target revision");
  }
  switch (workscene.kind) {
    case "workscene-create":
      if (
        result.kind !== "workscene-applied" ||
        result.operation !== "create" ||
        result.scene.revision !== 1 ||
        result.scene.name !== workscene.name ||
        !sameWorkspace(result.scene.workspace, workscene.workspace) ||
        result.scene.createdAt !== result.scene.lastActiveAt
      ) {
        throw new TypeError("Created workscene result does not match its mutation");
      }
      return;
    case "workscene-rename":
      if (
        result.kind !== "workscene-applied" ||
        result.operation !== "rename" ||
        result.scene.id !== workscene.sceneId ||
        result.scene.revision !== workscene.expectedRevision + 1 ||
        result.scene.name !== workscene.name
      ) {
        throw new TypeError("Renamed workscene result does not match its mutation");
      }
      return;
    case "workscene-set-workdir":
      if (
        result.kind !== "workscene-applied" ||
        result.operation !== "set-workdir" ||
        result.scene.id !== workscene.sceneId ||
        result.scene.revision !== workscene.expectedRevision + 1 ||
        !sameWorkspace(result.scene.workspace, workscene.workspace)
      ) {
        throw new TypeError("Workscene workspace result does not match its mutation");
      }
      return;
    case "workscene-delete":
      if (
        result.kind !== "workscene-deleted" ||
        result.operation !== "delete" ||
        result.sceneId !== workscene.sceneId ||
        result.previousObjectRevision !== workscene.expectedRevision
      ) {
        throw new TypeError("Deleted workscene result does not match its mutation");
      }
  }
}

function isWorksceneMutation(
  value: MutationBatch["records"][number]["mutation"],
): value is WorksceneWriteMutation {
  return value.kind === "workscene-create" ||
    value.kind === "workscene-rename" ||
    value.kind === "workscene-set-workdir" ||
    value.kind === "workscene-delete";
}

function validateWorksceneAppliedResult(value: unknown): WorksceneAppliedResult {
  assertPlainRecord(value, "Workscene applied result");
  if (value.kind === "workscene-deleted") {
    assertExactKeys(
      value,
      ["kind", "operation", "previousObjectRevision", "revision", "sceneId"],
      "Workscene deleted result",
    );
    if (value.operation !== "delete") {
      throw new TypeError("Workscene deleted result operation is invalid");
    }
    assertPositiveInteger(value.revision, "Workscene domain revision");
    assertPositiveInteger(value.previousObjectRevision, "Previous workscene revision");
    assertProtocolIdentifier(value.sceneId, "Deleted workscene id");
    return value as unknown as WorksceneAppliedResult;
  }
  assertExactKeys(value, ["kind", "operation", "revision", "scene"], "Workscene result");
  if (
    value.kind !== "workscene-applied" ||
    (value.operation !== "create" &&
      value.operation !== "rename" &&
      value.operation !== "set-workdir")
  ) {
    throw new TypeError("Workscene applied result is invalid");
  }
  assertPositiveInteger(value.revision, "Workscene domain revision");
  validateWorksceneDto(value.scene);
  return value as unknown as WorksceneAppliedResult;
}

export function validateWorksceneDto(value: unknown): WorksceneDto {
  assertPlainRecord(value, "Workscene result scene");
  assertExactKeys(
    value,
    value.workspace === undefined
      ? ["createdAt", "id", "lastActiveAt", "name", "revision"]
      : ["createdAt", "id", "lastActiveAt", "name", "revision", "workspace"],
    "Workscene result scene",
  );
  assertProtocolIdentifier(value.id, "Workscene result scene id");
  assertPositiveInteger(value.revision, "Workscene object revision");
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new TypeError("Workscene result name must be non-empty");
  }
  canonicalTime(value.createdAt, "Workscene creation time");
  canonicalTime(value.lastActiveAt, "Workscene activity time");
  if (Date.parse(value.lastActiveAt as string) < Date.parse(value.createdAt as string)) {
    throw new TypeError("Workscene activity cannot predate its creation");
  }
  if (value.workspace !== undefined) validateWorkspace(value.workspace);
  return value as unknown as WorksceneDto;
}

function validateWorkspace(value: unknown): void {
  assertPlainRecord(value, "Workscene workspace");
  assertExactKeys(value, ["bindingRef", "deviceId"], "Workscene workspace");
  assertProtocolIdentifier(value.deviceId, "Workspace device id");
  assertProtocolIdentifier(value.bindingRef, "Workspace binding ref");
}

function sameWorkspace(
  left: WorksceneDto["workspace"],
  right: WorksceneDto["workspace"] | null,
): boolean {
  return left?.deviceId === right?.deviceId && left?.bindingRef === right?.bindingRef;
}

function canonicalTime(value: unknown, label: string): void {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

export function validateCancelBatchControlResultBody(
  value: unknown,
): Extract<ControlResultBody, { t: "cancel-batch" }> {
  assertPlainRecord(value, "Cancel-batch result");
  assertExactKeys(value, ["conversationId", "runs", "t"], "Cancel-batch result");
  if (value.t !== "cancel-batch") {
    throw new TypeError("Cancel-batch result type is invalid");
  }
  assertProtocolIdentifier(value.conversationId, "Cancel-batch conversation id");
  if (!Array.isArray(value.runs)) {
    throw new TypeError("Cancel-batch runs must be an array");
  }
  for (const run of value.runs) {
    assertPlainRecord(run, "Cancel-batch run disposition");
    assertExactKeys(
      run,
      ["ingressId", "runId", "runState", "source"],
      "Cancel-batch run disposition",
    );
    assertProtocolIdentifier(run.runId, "Cancel-batch run id");
    assertProtocolIdentifier(run.ingressId, "Cancel-batch ingress id");
    if (
      run.runState !== "queued" &&
      run.runState !== "dispatched" &&
      run.runState !== "running" &&
      run.runState !== "cancel-requested" &&
      run.runState !== "cancelled" &&
      run.runState !== "committed" &&
      run.runState !== "failed" &&
      run.runState !== "expired" &&
      run.runState !== "uncertain"
    ) {
      throw new TypeError("Cancel-batch run state is invalid");
    }
    if (
      run.source !== "interactive" &&
      run.source !== "scheduler" &&
      run.source !== "channel" &&
      run.source !== "advancement"
    ) {
      throw new TypeError("Cancel-batch run source is invalid");
    }
  }
  return value as unknown as Extract<ControlResultBody, { t: "cancel-batch" }>;
}

function validateArtifactReference(value: unknown, label: string): ArtifactRef {
  assertPlainRecord(value, label);
  assertExactKeys(value, ["ref"], label);
  assertPlainRecord(value.ref, `${label} reference`);
  assertExactKeys(value.ref, ["bytes", "digest"], `${label} reference`);
  if (
    typeof value.ref.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.ref.digest)
  ) {
    throw new TypeError(`${label} digest is invalid`);
  }
  if (!Number.isSafeInteger(value.ref.bytes) || (value.ref.bytes as number) < 0) {
    throw new TypeError(`${label} byte length is invalid`);
  }
  return value.ref as unknown as ArtifactRef;
}

function assertPlainRecord(
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

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
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
