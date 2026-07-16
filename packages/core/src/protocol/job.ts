import type {
  JobCommitFence,
  JobOccurrence,
  SystemJobResourceLease,
  SystemJobFence,
  TaskDefinition,
  TaskDeliveryDto,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import { assertResourceLeaseBaseContract } from "./resource-lease.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SYSTEM_HANDLERS = new Set([
  "__transcript-gc",
  "__journal-gc",
  "__advancement-gc",
]);

interface SignatureVerifier {
  verify(
    schemaId: string,
    version: number,
    payload: unknown,
    signature: SystemJobResourceLease["signature"],
  ): void;
}

export function createJobCommitFence(
  input: Omit<JobCommitFence, "v" | "digest">,
): JobCommitFence {
  const payload = snapshot({ v: 1 as const, ...input });
  return validateJobCommitFence({
    ...payload,
    digest: protocolDigest("JobCommitFence", 1, payload),
  });
}

export function validateJobCommitFence(input: JobCommitFence): JobCommitFence {
  const fence = snapshot(input) as JobCommitFence;
  assertExactKeys(
    fence,
    [
      "anchorEpoch",
      "assignmentId",
      "deliveryPlanDigest",
      "digest",
      "executorId",
      "jobRunId",
      "scheduledFor",
      "taskId",
      "taskRevision",
      "v",
    ],
    "Job commit fence",
  );
  assertVersion(fence.v, "Job commit fence");
  assertIdentifier(fence.taskId, "Job fence taskId");
  assertIdentifier(fence.jobRunId, "Job fence jobRunId");
  assertCanonicalTime(fence.scheduledFor, "Job fence scheduledFor");
  assertPositiveInteger(fence.taskRevision, "Job fence taskRevision");
  assertDigest(fence.deliveryPlanDigest, "Job fence delivery plan digest");
  assertPositiveInteger(fence.anchorEpoch, "Job fence anchorEpoch");
  assertIdentifier(fence.assignmentId, "Job fence assignmentId");
  assertIdentifier(fence.executorId, "Job fence executorId");
  assertDigest(fence.digest, "Job fence digest");
  const expected = protocolDigest(
    "JobCommitFence",
    1,
    withoutField(fence, "digest"),
  );
  if (fence.digest !== expected) {
    throw new TypeError("Job commit fence digest is invalid");
  }
  return fence;
}

export function jobDeliveryPlanDigest(delivery: TaskDeliveryDto): string {
  validateTaskDelivery(delivery);
  return protocolDigest("JobDeliveryPlan", 1, { delivery });
}

export function systemJobParamsDigest(params: unknown): string {
  assertCanonicalJson(params ?? null, "System job params");
  return protocolDigest("SystemJobParams", 1, params ?? null);
}

export function validateTaskDefinition(input: TaskDefinition): TaskDefinition {
  const definition = snapshot(input) as TaskDefinition;
  assertExactKeys(
    definition,
    ["definition", "state", "taskId", "taskRevision"],
    "Task definition",
  );
  assertIdentifier(definition.taskId, "Task definition taskId");
  assertPositiveInteger(definition.taskRevision, "Task definition revision");
  if (!new Set(["enabled", "disabled", "deleted"]).has(definition.state)) {
    throw new TypeError("Task definition state is invalid");
  }
  assertPlainObject(definition.definition, "Task definition body");
  if (definition.definition.kind === "user") {
    assertExactKeys(
      definition.definition,
      ["createdInTurn", "interactionResponder", "kind", "origin", "spec"],
      "User task definition",
      true,
    );
    assertScheduleSpec(definition.definition.spec);
    if (
      definition.definition.spec.enabled !==
      (definition.state === "enabled")
    ) {
      throw new TypeError(
        "User task definition enabled flag must match task state",
      );
    }
    if (definition.definition.createdInTurn !== undefined) {
      assertIdentifier(definition.definition.createdInTurn, "Task creator turn");
    }
    if (definition.definition.origin !== undefined) {
      assertDeliveryTarget(definition.definition.origin, "Task origin");
    }
    if (definition.definition.interactionResponder !== undefined) {
      assertPlainObject(definition.definition.interactionResponder, "Interaction responder");
      assertExactKeys(
        definition.definition.interactionResponder,
        ["channelId", "platformSubject", "tenant"],
        "Interaction responder",
        true,
      );
      assertIdentifier(
        definition.definition.interactionResponder.channelId,
        "Interaction responder channelId",
      );
      assertIdentifier(
        definition.definition.interactionResponder.platformSubject,
        "Interaction responder subject",
      );
      if (definition.definition.interactionResponder.tenant !== undefined) {
        assertIdentifier(
          definition.definition.interactionResponder.tenant,
          "Interaction responder tenant",
        );
      }
    }
  } else if (definition.definition.kind === "system") {
    assertExactKeys(
      definition.definition,
      ["handler", "kind", "params"],
      "System task definition",
      true,
    );
    if (!SYSTEM_HANDLERS.has(definition.definition.handler)) {
      throw new TypeError("System task handler is not registered");
    }
    if (definition.definition.params !== undefined) {
      assertCanonicalJson(definition.definition.params, "System task params");
    }
  } else {
    throw new TypeError("Task definition kind is invalid");
  }
  return definition;
}

export function validateJobOccurrence(input: JobOccurrence): JobOccurrence {
  const occurrence = snapshot(input) as JobOccurrence;
  assertExactKeys(
    occurrence,
    ["deliveryPlan", "jobRunId", "scheduledFor", "state", "taskId", "taskRevision"],
    "Job occurrence",
  );
  assertIdentifier(occurrence.taskId, "Job occurrence taskId");
  assertIdentifier(occurrence.jobRunId, "Job occurrence jobRunId");
  assertCanonicalTime(occurrence.scheduledFor, "Job occurrence scheduledFor");
  assertPositiveInteger(occurrence.taskRevision, "Job occurrence taskRevision");
  if (
    !new Set([
      "queued",
      "dispatched",
      "running",
      "cancel-requested",
      "committed",
      "cancelled",
      "failed",
      "expired",
      "missed",
      "uncertain",
    ]).has(occurrence.state)
  ) {
    throw new TypeError("Job occurrence state is invalid");
  }
  assertExactKeys(
    occurrence.deliveryPlan,
    ["delivery", "planDigest"],
    "Job delivery plan",
  );
  validateTaskDelivery(occurrence.deliveryPlan.delivery);
  assertDigest(occurrence.deliveryPlan.planDigest, "Job delivery plan digest");
  if (
    occurrence.deliveryPlan.planDigest !==
    jobDeliveryPlanDigest(occurrence.deliveryPlan.delivery)
  ) {
    throw new TypeError("Job delivery plan digest is invalid");
  }
  return occurrence;
}

export function validateSystemJobFence(input: SystemJobFence): SystemJobFence {
  const fence = snapshot(input) as SystemJobFence;
  assertExactKeys(
    fence,
    [
      "anchorEpoch",
      "attempt",
      "handler",
      "jobRunId",
      "paramsDigest",
      "reservationId",
      "scheduledFor",
      "taskId",
      "taskRevision",
    ],
    "System job fence",
  );
  assertIdentifier(fence.taskId, "System job taskId");
  assertIdentifier(fence.jobRunId, "System job runId");
  assertCanonicalTime(fence.scheduledFor, "System job scheduledFor");
  assertPositiveInteger(fence.taskRevision, "System job taskRevision");
  assertPositiveInteger(fence.anchorEpoch, "System job anchorEpoch");
  if (!SYSTEM_HANDLERS.has(fence.handler)) {
    throw new TypeError("System job handler is not registered");
  }
  assertDigest(fence.paramsDigest, "System job params digest");
  assertIdentifier(fence.reservationId, "System job reservationId");
  assertPositiveInteger(fence.attempt, "System job attempt");
  return fence;
}

export function validateSystemJobResourceLease(
  input: SystemJobResourceLease,
  verifier: SignatureVerifier,
): SystemJobResourceLease {
  const lease = snapshot(input) as SystemJobResourceLease;
  assertExactKeys(
    lease,
    [
      "activation",
      "admissionClass",
      "audience",
      "budget",
      "delegation",
      "digest",
      "domain",
      "expiry",
      "issuedAt",
      "reservationId",
      "scopeBinding",
      "signature",
      "v",
      "workload",
    ],
    "System job resource lease",
    true,
  );
  assertVersion(lease.v, "System job resource lease");
  assertResourceLeaseBaseContract(lease, verifier, "System job resource lease");
  if (lease.admissionClass !== "scheduler") {
    throw new TypeError("System job resource lease must use scheduler admission");
  }
  if (lease.workload.kind !== "job") {
    throw new TypeError("System job resource lease has an invalid workload kind");
  }
  if (lease.scopeBinding.kind !== "job") {
    throw new TypeError("System job resource lease has an invalid scope kind");
  }
  if (lease.domain.kind !== "anchor") {
    throw new TypeError("System job resource lease must belong to the anchor domain");
  }
  assertExactKeys(lease.activation, ["jobRunId", "kind"], "System job activation");
  if (lease.activation.kind !== "system-job") {
    throw new TypeError("System job resource lease has an invalid activation kind");
  }
  assertIdentifier(lease.activation.jobRunId, "System job activation jobRunId");
  return lease;
}

function assertScheduleSpec(value: unknown): void {
  assertPlainObject(value, "Schedule task spec");
  assertExactKeys(
    value,
    ["action", "delivery", "description", "enabled", "name", "priority", "schedule"],
    "Schedule task spec",
    true,
  );
  assertString(value.name, "Schedule task name", true);
  if (value.description !== undefined) assertString(value.description, "Schedule description");
  if (typeof value.enabled !== "boolean") throw new TypeError("Schedule enabled must be boolean");
  if (!new Set(["urgent", "high", "normal", "low"]).has(String(value.priority))) {
    throw new TypeError("Schedule priority is invalid");
  }
  assertPlainObject(value.schedule, "Task schedule");
  if (value.schedule.kind === "once") {
    assertExactKeys(value.schedule, ["at", "kind"], "Once schedule");
    assertCanonicalTime(value.schedule.at, "Once schedule time");
  } else if (value.schedule.kind === "interval") {
    assertExactKeys(value.schedule, ["everyMs", "kind"], "Interval schedule");
    assertPositiveInteger(value.schedule.everyMs, "Schedule interval");
  } else if (value.schedule.kind === "cron") {
    assertExactKeys(value.schedule, ["expr", "kind", "tz"], "Cron schedule", true);
    assertString(value.schedule.expr, "Cron expression", true);
    if (value.schedule.tz !== undefined) assertString(value.schedule.tz, "Cron timezone", true);
  } else {
    throw new TypeError("Task schedule kind is invalid");
  }
  assertPlainObject(value.action, "Schedule action");
  assertExactKeys(value.action, ["kind", "model", "prompt", "tools"], "Schedule action", true);
  if (value.action.kind !== "agent-turn") throw new TypeError("Schedule action kind is invalid");
  assertString(value.action.prompt, "Schedule prompt", true);
  if (value.action.model !== undefined) assertIdentifier(value.action.model, "Schedule model");
  if (value.action.tools !== undefined) assertUniqueIdentifiers(value.action.tools, "Schedule tools");
  if (value.delivery !== undefined) validateTaskDelivery(value.delivery);
}

function validateTaskDelivery(value: unknown): asserts value is TaskDeliveryDto {
  assertPlainObject(value, "Task delivery");
  if (value.kind === "none") {
    assertExactKeys(value, ["kind"], "No delivery");
  } else if (value.kind === "channel") {
    assertExactKeys(value, ["channel", "kind", "threadId", "to"], "Channel delivery", true);
    assertIdentifier(value.channel, "Delivery channel");
    assertIdentifier(value.to, "Delivery recipient");
    if (value.threadId !== undefined) assertIdentifier(value.threadId, "Delivery threadId");
  } else if (value.kind === "webhook") {
    assertExactKeys(value, ["endpoint", "kind"], "Webhook delivery");
    assertPlainObject(value.endpoint, "Webhook endpoint");
    assertExactKeys(value.endpoint, ["bindingId", "kind"], "Webhook secret reference");
    if (value.endpoint.kind !== "webhook") {
      throw new TypeError("Webhook endpoint must be a webhook SecretRef");
    }
    assertIdentifier(value.endpoint.bindingId, "Webhook bindingId");
  } else {
    throw new TypeError("Task delivery kind is invalid");
  }
}

function assertDeliveryTarget(value: unknown, label: string): void {
  assertPlainObject(value, label);
  assertExactKeys(value, ["channelId", "threadId", "to"], label, true);
  assertIdentifier(value.channelId, `${label} channelId`);
  assertIdentifier(value.to, `${label} recipient`);
  if (value.threadId !== undefined) assertIdentifier(value.threadId, `${label} threadId`);
}

function assertCanonicalJson(value: unknown, label: string): void {
  try {
    canonicalize(value);
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`, { cause: error });
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
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

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function assertString(value: unknown, label: string, nonEmpty = false): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 65_536 ||
    (nonEmpty && value.length === 0)
  ) {
    throw new TypeError(`${label} must be a bounded string`);
  }
}

function assertUniqueIdentifiers(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const seen = new Set<string>();
  for (const item of value) {
    assertIdentifier(item, label);
    if (seen.has(item)) throw new TypeError(`${label} must not contain duplicates`);
    seen.add(item);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const time = new Date(value);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function assertVersion(value: unknown, label: string): asserts value is 1 {
  if (value !== 1) throw new TypeError(`${label} version must be 1`);
}

function withoutField<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const output = { ...value };
  delete output[key];
  return output;
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}
