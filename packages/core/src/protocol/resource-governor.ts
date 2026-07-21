import type {
  AdmissionClass,
  AssignmentResourceLease,
  AuthorityCapability,
  AuthorityPortMethodId,
  ChildResourceLease,
  ResourceLease,
  ReservableResourceLease,
  RootResourceWorkload,
  UsageReport,
} from "../contracts/authorization.js";
import { ADMISSION_CLASSES } from "../contracts/authorization.js";
import type { LogicalRecord } from "../contracts/commit-log.js";
import type {
  AuthorityCallContext,
  ReservationOrigin,
  SystemJobReservationOrigin,
} from "../contracts/ports.js";
import type { GovernorRecord } from "../contracts/records.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import {
  acceptedRemoteIntervalRemainingMs,
  validateAuthorityCapability,
} from "./authority.js";
import {
  assertResourceLeaseBaseContract,
  assertResourceLeaseActiveAt,
  assertResourceLeaseBudget,
  assertResourceScopeBinding,
  type ResourceLeaseSignatureVerifier,
} from "./resource-lease.js";
import { assertProtocolIdentifier as assertIdentifier } from "./validation.js";

export interface ResourceBudgetUsage {
  readonly tokens: number;
  readonly calls: number;
  readonly costMinor: number;
}

export type ResourceReservationState =
  | "active"
  | "settled"
  | "released"
  | "reclaimed";

export interface ResourceReservationProjection {
  readonly lease: ReservableResourceLease;
  readonly rootReservationId: string;
  readonly depth: number;
  used: ResourceBudgetUsage;
  descendantUsed: ResourceBudgetUsage;
  reservedUsage: ResourceBudgetUsage;
  descendantReservedUsage: ResourceBudgetUsage;
  reservedForChildren: ResourceBudgetUsage;
  settled: boolean;
  state: ResourceReservationState;
  terminalAt?: string;
}

export interface GovernorProjection {
  readonly reservations: Map<string, ResourceReservationProjection>;
  readonly leaseAcceptances: Map<
    string,
    {
      readonly leaseDigest: string;
      readonly acceptedAt: string;
      readonly validForMs: number;
    }
  >;
  readonly usages: Map<
    string,
    {
      readonly rootReservationId: string;
      readonly reservationId: string;
      readonly usageSeq: number;
      readonly usage: ResourceBudgetUsage;
    }
  >;
  readonly nextUsageSeqByRoot: Map<string, number>;
  readonly usageReservations: Map<
    string,
    {
      readonly rootReservationId: string;
      readonly reservationId: string;
      readonly usage: ResourceBudgetUsage;
      state: "reserved" | "consumed";
    }
  >;
  readonly queued: Map<string, AdmissionClass>;
  readonly queuedWorkloads: Map<string, RootResourceWorkload>;
  readonly queuedByWorkload: Map<string, string>;
  readonly dequeued: Map<string, "cancelled" | "failed" | "expired">;
  readonly dequeuedAt: Map<string, string>;
  readonly admissionQueues: Record<AdmissionClass, string[]>;
  readonly admissionDeficits: Record<AdmissionClass, number>;
  admissionCursor: number;
}

export const DEFAULT_ADMISSION_WEIGHTS: Readonly<Record<AdmissionClass, number>> = {
  interactive: 8,
  advancement: 4,
  scheduler: 2,
  orchestration: 1,
};

export { ADMISSION_CLASSES };

const ADMISSION_CLASS_SET: ReadonlySet<string> = new Set(ADMISSION_CLASSES);

export const GOVERNOR_TERMINAL_RETENTION_MS = 27 * 24 * 60 * 60_000;

export function emptyGovernorProjection(): GovernorProjection {
  return {
    reservations: new Map(),
    leaseAcceptances: new Map(),
    usages: new Map(),
    nextUsageSeqByRoot: new Map(),
    usageReservations: new Map(),
    queued: new Map(),
    queuedWorkloads: new Map(),
    queuedByWorkload: new Map(),
    dequeued: new Map(),
    dequeuedAt: new Map(),
    admissionQueues: emptyAdmissionQueues(),
    admissionDeficits: emptyAdmissionCounters(),
    admissionCursor: 0,
  };
}

export function cloneGovernorProjection(
  state: GovernorProjection,
): GovernorProjection {
  return {
    reservations: new Map(
      [...state.reservations].map(([id, value]) => [
        id,
        {
          lease: structuredClone(value.lease),
          rootReservationId: value.rootReservationId,
          depth: value.depth,
          used: { ...value.used },
          descendantUsed: { ...value.descendantUsed },
          reservedUsage: { ...value.reservedUsage },
          descendantReservedUsage: { ...value.descendantReservedUsage },
          reservedForChildren: { ...value.reservedForChildren },
          settled: value.settled,
          state: value.state,
          ...(value.terminalAt === undefined ? {} : { terminalAt: value.terminalAt }),
        },
      ]),
    ),
    leaseAcceptances: new Map(
      [...state.leaseAcceptances].map(([id, value]) => [id, { ...value }]),
    ),
    usages: new Map(
      [...state.usages].map(([id, value]) => [
        id,
        { ...value, usage: { ...value.usage } },
      ]),
    ),
    nextUsageSeqByRoot: new Map(state.nextUsageSeqByRoot),
    usageReservations: new Map(
      [...state.usageReservations].map(([id, value]) => [
        id,
        { ...value, usage: { ...value.usage } },
      ]),
    ),
    queued: new Map(state.queued),
    queuedWorkloads: new Map(
      [...state.queuedWorkloads].map(([id, workload]) => [id, { ...workload }]),
    ),
    queuedByWorkload: new Map(state.queuedByWorkload),
    dequeued: new Map(state.dequeued),
    dequeuedAt: new Map(state.dequeuedAt),
    admissionQueues: {
      interactive: [...state.admissionQueues.interactive],
      advancement: [...state.admissionQueues.advancement],
      scheduler: [...state.admissionQueues.scheduler],
      orchestration: [...state.admissionQueues.orchestration],
    },
    admissionDeficits: { ...state.admissionDeficits },
    admissionCursor: state.admissionCursor,
  };
}

export function applyGovernorRecordAt(
  state: GovernorProjection,
  input: unknown,
  envelopeAt: string,
  maxLeaseTtlMs: number,
  verifier: ResourceLeaseSignatureVerifier,
): GovernorProjection {
  const record = validateGovernorRecord(input, verifier);
  const dequeuedWorkloadKey = record.t === "dequeue"
    ? rootResourceWorkloadKey(record.workload)
    : undefined;
  const wasDequeued = dequeuedWorkloadKey === undefined
    ? false
    : state.dequeued.has(dequeuedWorkloadKey);
  const existing = record.t === "reserve"
    ? state.leaseAcceptances.get(record.lease.reservationId)
    : undefined;
  const next = applyValidatedGovernorRecord(state, record, verifier);
  if (record.t === "dequeue" && !wasDequeued) {
    next.dequeuedAt.set(dequeuedWorkloadKey!, envelopeAt);
  }
  if (record.t === "release" || record.t === "reclaim") {
    const reservation = next.reservations.get(record.reservationId);
    if (reservation && reservation.terminalAt === undefined) {
      reservation.terminalAt = envelopeAt;
    }
  }
  if (record.t !== "reserve") return next;
  if (existing) {
    if (existing.leaseDigest !== record.lease.digest) {
      throw new TypeError("Resource lease acceptance digest conflicts with its reservation");
    }
    return next;
  }
  const lease = next.reservations.get(record.lease.reservationId)?.lease;
  if (!lease) throw new TypeError("Reserved lease lost its acceptance projection");
  next.leaseAcceptances.set(lease.reservationId, {
    leaseDigest: lease.digest,
    acceptedAt: envelopeAt,
    validForMs: acceptedRemoteIntervalRemainingMs({
      issuedAt: lease.issuedAt,
      expiry: lease.expiry,
      acceptedAt: envelopeAt,
      maxTtlMs: maxLeaseTtlMs,
    }),
  });
  return next;
}

export function validateReservableResourceLease(
  input: unknown,
  verifier: ResourceLeaseSignatureVerifier,
): ReservableResourceLease {
  assertPlainObject(input, "Resource lease");
  const lease = structuredClone(input) as ReservableResourceLease;
  const root = lease.parentId === undefined;
  const expected = [
    "admissionClass",
    "audience",
    "budget",
    "digest",
    "domain",
    "expiry",
    "issuedAt",
    "reservationId",
    "scopeBinding",
    "signature",
    "v",
    "workload",
    ...(root ? [] : ["parentDigest", "parentId"]),
    ...(lease.delegation === undefined ? [] : ["delegation"]),
    ...("activation" in lease ? ["activation"] : []),
  ].sort();
  if (canonicalize(Object.keys(lease).sort()) !== canonicalize(expected)) {
    throw new TypeError("Resource lease fields are incomplete or unknown");
  }
  if (lease.v !== 1) throw new TypeError("Resource lease version is invalid");
  assertResourceLeaseBaseContract(lease, verifier, "Resource lease");
  if (root) {
    if (lease.parentDigest !== undefined) {
      throw new TypeError("Root resource lease cannot bind a parent digest");
    }
  } else {
    assertIdentifier(lease.parentId, "Resource lease parentId");
    assertDigest(lease.parentDigest, "Resource lease parentDigest");
    if (lease.delegation !== undefined) {
      throw new TypeError("Child resource lease cannot delegate again");
    }
    if (lease.workload.kind !== "orchestration-node" && lease.workload.kind !== "evidence") {
      throw new TypeError("Child resource lease workload is invalid");
    }
    if (lease.audience.executorId === undefined) {
      throw new TypeError("Child resource lease must bind an executor audience");
    }
  }
  if ("activation" in lease) validateActivation(lease);
  if (lease.delegation !== undefined && !root) {
    throw new TypeError("Only root resource leases can delegate");
  }
  if (lease.delegation !== undefined) {
    assertBudgetWithinBudget(
      lease.delegation.maxBudget,
      lease.budget,
      "Resource delegation budget",
    );
  }
  assertReservableLeaseVariant(lease, root);
  return lease;
}

export { assertResourceLeaseActiveAt };

export function assertResourceCapabilityBinding(input: {
  readonly context: AuthorityCallContext;
  readonly method: AuthorityPortMethodId;
  readonly rootLease: AssignmentResourceLease;
  readonly verifier: ResourceLeaseSignatureVerifier;
}): AuthorityCapability {
  if (input.context.principal.kind !== "assignment") {
    throw new TypeError("Assignment resource use requires an assignment capability");
  }
  const capability = validateAuthorityCapability(
    input.context.principal.capability,
    input.verifier,
  );
  const activation = input.rootLease.activation;
  if (
    capability.assignmentId !== activation.assignmentId ||
    capability.executorId !== input.rootLease.audience.executorId ||
    !capability.methods.includes(input.method as never)
  ) {
    throw new TypeError("Assignment capability does not bind this resource lease method");
  }
  const scope = input.rootLease.scopeBinding;
  if (scope.kind === "conversation") {
    if (
      capability.scope.execution !== "conversation" ||
      !("ownerEpoch" in capability) ||
      capability.scope.conversationId !== scope.conversationId ||
      capability.ownerEpoch !== scope.ownerEpoch ||
      !capability.resources.includes(`conversation:${scope.conversationId}`)
    ) {
      throw new TypeError("Assignment capability does not bind the conversation resource scope");
    }
    return capability;
  }
  if (
    scope.kind !== "job" ||
    capability.scope.execution !== "job" ||
    !("anchorEpoch" in capability) ||
    capability.scope.taskId !== scope.taskId ||
    capability.anchorEpoch !== scope.anchorEpoch ||
    !capability.resources.includes(`task:${scope.taskId}`)
  ) {
    throw new TypeError("Assignment capability does not bind the job resource scope");
  }
  return capability;
}

export function assertAcceptedResourceCapabilityBinding(input: {
  readonly context: AuthorityCallContext;
  readonly method: AuthorityPortMethodId;
  readonly rootLease: AssignmentResourceLease;
  readonly acceptedCapIds: ReadonlySet<string>;
  readonly verifier: ResourceLeaseSignatureVerifier;
}): AuthorityCapability {
  const capability = assertResourceCapabilityBinding(input);
  if (!input.acceptedCapIds.has(capability.capId)) {
    throw new TypeError(
      "Assignment capability was not durably accepted for this resource lease",
    );
  }
  return capability;
}

export function assertActivatedResourceCapability(input: {
  readonly context: AuthorityCallContext;
  readonly method: AuthorityPortMethodId;
  readonly rootLease: AssignmentResourceLease;
  readonly activeCapIds: ReadonlySet<string>;
  readonly verifier: ResourceLeaseSignatureVerifier;
  readonly now: string;
}): void {
  const capability = assertResourceCapabilityBinding(input);
  const activation = input.rootLease.activation;
  if (
    capability.assignmentId !== activation.assignmentId ||
    capability.executorId !== input.rootLease.audience.executorId ||
    !capability.methods.includes(input.method as never) ||
    !input.activeCapIds.has(capability.capId)
  ) {
    throw new TypeError("Assignment capability is not activated for this resource lease");
  }
  const now = Date.parse(input.now);
  if (
    !Number.isFinite(now) ||
    now < Date.parse(capability.issuedAt) ||
    now > Date.parse(capability.expiry) ||
    Date.parse(input.context.deadlineAt) > Date.parse(capability.expiry)
  ) {
    throw new TypeError("Assignment resource capability is outside its validity interval");
  }
}

export function compactGovernorProjection(
  state: GovernorProjection,
  retainAfter: string,
): GovernorProjection {
  const cutoff = Date.parse(retainAfter);
  if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString() !== retainAfter) {
    throw new TypeError("Resource governor retention cutoff must be canonical");
  }
  const expiredRoots = new Set(
    [...state.reservations.values()]
      .filter((reservation) =>
        reservation.depth === 0 &&
        (reservation.state === "released" || reservation.state === "reclaimed") &&
        reservation.terminalAt !== undefined &&
        Date.parse(reservation.terminalAt) < cutoff)
      .map((reservation) => reservation.rootReservationId),
  );
  for (const [reservationId, reservation] of state.reservations) {
    if (!expiredRoots.has(reservation.rootReservationId)) continue;
    state.reservations.delete(reservationId);
    state.leaseAcceptances.delete(reservationId);
  }
  for (const [usageId, usage] of state.usages) {
    if (expiredRoots.has(usage.rootReservationId)) state.usages.delete(usageId);
  }
  for (const [usageId, reservation] of state.usageReservations) {
    if (expiredRoots.has(reservation.rootReservationId)) {
      state.usageReservations.delete(usageId);
    }
  }
  for (const rootReservationId of expiredRoots) {
    state.nextUsageSeqByRoot.delete(rootReservationId);
  }
  for (const [workloadKey, dequeuedAt] of state.dequeuedAt) {
    if (Date.parse(dequeuedAt) >= cutoff) continue;
    state.dequeuedAt.delete(workloadKey);
    state.dequeued.delete(workloadKey);
  }
  return state;
}

export function conservativeUsageConsumptionRecords(
  state: GovernorProjection,
  scope: {
    readonly rootReservationIds?: ReadonlySet<string>;
    readonly reservationIds?: ReadonlySet<string>;
  },
): GovernorRecord[] {
  const nextByRoot = new Map(state.nextUsageSeqByRoot);
  const records: GovernorRecord[] = [];
  for (const [usageId, reservation] of state.usageReservations) {
    if (
      reservation.state !== "reserved" ||
      (!scope.rootReservationIds?.has(reservation.rootReservationId) &&
        !scope.reservationIds?.has(reservation.reservationId))
    ) {
      continue;
    }
    const usageSeq = nextByRoot.get(reservation.rootReservationId) ?? 1;
    nextByRoot.set(reservation.rootReservationId, usageSeq + 1);
    records.push({
      t: "consume",
      usageSeq,
      rootReservationId: reservation.rootReservationId,
      reservationId: reservation.reservationId,
      usageId,
      ...(reservation.usage.tokens === 0 ? {} : { tokens: reservation.usage.tokens }),
      ...(reservation.usage.calls === 0 ? {} : { calls: reservation.usage.calls }),
      ...(reservation.usage.costMinor === 0 ? {} : { costMinor: reservation.usage.costMinor }),
    });
  }
  return records;
}

export function resourceBudgetUsage(input: {
  readonly tokens?: number;
  readonly calls?: number;
  readonly costMinor?: number;
}): ResourceBudgetUsage {
  const usage = {
    tokens: requireNonNegative(input.tokens ?? 0, "Resource token usage"),
    calls: requireNonNegative(input.calls ?? 0, "Resource call usage"),
    costMinor: requireNonNegative(input.costMinor ?? 0, "Resource cost usage"),
  };
  if (usage.tokens === 0 && usage.calls === 0 && usage.costMinor === 0) {
    throw new TypeError("Resource usage must consume at least one budget dimension");
  }
  return usage;
}

export class ResourceAdmissionDeferredError extends Error {
  constructor(readonly reservationId: string) {
    super(`Resource reservation ${reservationId} remains queued after its admission wait elapsed`);
    this.name = "ResourceAdmissionDeferredError";
  }
}

export async function waitForResourceAdmissionCandidate<Value>(input: {
  readonly attempt: () => Promise<Value>;
  readonly isPending: (error: unknown) => boolean;
  readonly deadline: number;
  readonly monotonicClock: () => number;
  readonly onDeadline: () => Promise<never> | never;
  readonly pollIntervalMs?: number;
}): Promise<Value> {
  if (!Number.isFinite(input.deadline)) {
    throw new TypeError("Resource admission deadline is invalid");
  }
  const pollIntervalMs = input.pollIntervalMs ?? 10;
  requirePositive(pollIntervalMs, "Resource admission poll interval");
  while (true) {
    if (input.deadline - input.monotonicClock() <= 0) {
      return await input.onDeadline();
    }
    try {
      return await input.attempt();
    } catch (error) {
      if (!input.isPending(error)) throw error;
      const remaining = input.deadline - input.monotonicClock();
      if (remaining <= 0) return await input.onDeadline();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(pollIntervalMs, remaining));
      });
    }
  }
}

export function validateGovernorRecord(
  input: unknown,
  verifier: ResourceLeaseSignatureVerifier,
): GovernorRecord {
  assertPlainObject(input, "Governor record");
  const t = input.t;
  if (typeof t !== "string") {
    throw new TypeError("Governor record type is invalid");
  }
  switch (t) {
    case "queued": {
      assertExactKeys(
        input,
        ["admissionClass", "reservationId", "t", "workload"],
        "Queued governor record",
      );
      assertIdentifier(input.reservationId, "Queued reservationId");
      assertRootResourceWorkload(input.workload);
      if (!isAdmissionClass(input.admissionClass)) {
        throw new TypeError("Queued admission class is invalid");
      }
      return structuredClone(input) as Extract<GovernorRecord, { t: "queued" }>;
    }
    case "dequeue": {
      return validateGovernorDequeueRecord(input);
    }
    case "reserve": {
      assertExactKeys(input, ["lease", "t"], "Reserve governor record");
      return {
        t,
        lease: validateReservableResourceLease(input.lease, verifier),
      };
    }
    case "usage-reserved":
    case "consume": {
      const required = t === "consume"
        ? ["reservationId", "rootReservationId", "t", "usageId", "usageSeq"]
        : ["reservationId", "rootReservationId", "t", "usageId"];
      const optional = ["calls", "costMinor", "tokens"].filter((key) =>
        Object.prototype.hasOwnProperty.call(input, key)
      );
      assertExactKeys(input, [...required, ...optional], `${t} governor record`);
      assertIdentifier(input.rootReservationId, "Resource root reservationId");
      assertIdentifier(input.reservationId, "Resource reservationId");
      assertIdentifier(input.usageId, "Resource usageId");
      if (t === "consume") {
        assertPositive(input.usageSeq, "Resource usage sequence");
      }
      resourceBudgetUsage(input);
      return structuredClone(input) as Extract<
        GovernorRecord,
        { t: "usage-reserved" | "consume" }
      >;
    }
    case "settle":
    case "release":
    case "reclaim": {
      assertExactKeys(input, ["reservationId", "t"], "Terminal governor record");
      assertIdentifier(input.reservationId, "Terminal reservationId");
      return structuredClone(input) as Extract<
        GovernorRecord,
        { t: "settle" | "release" | "reclaim" }
      >;
    }
    default:
      throw new TypeError("Governor record type is invalid");
  }
}

export function addResourceUsage(
  left: ResourceBudgetUsage,
  right: ResourceBudgetUsage,
): ResourceBudgetUsage {
  return {
    tokens: safeAdd(left.tokens, right.tokens, "Resource token usage"),
    calls: safeAdd(left.calls, right.calls, "Resource call usage"),
    costMinor: safeAdd(left.costMinor, right.costMinor, "Resource cost usage"),
  };
}

export function assertUsageWithinBudget(
  usage: ResourceBudgetUsage,
  budget: ResourceLease["budget"],
  label = "Resource usage",
): void {
  assertDimension(usage.tokens, budget.maxTokens, `${label} tokens`);
  assertDimension(usage.calls, budget.maxCalls, `${label} calls`);
  assertDimension(usage.costMinor, budget.maxCostMinor, `${label} cost`);
}

export function assertBudgetWithinBudget(
  child: ResourceLease["budget"],
  parent: ResourceLease["budget"],
  label = "Child resource budget",
): void {
  assertDimension(child.maxTokens ?? 0, parent.maxTokens, `${label} tokens`);
  assertDimension(child.maxCalls ?? 0, parent.maxCalls, `${label} calls`);
  assertDimension(child.maxCostMinor ?? 0, parent.maxCostMinor, `${label} cost`);
}

export function applyGovernorRecord(
  state: GovernorProjection,
  input: unknown,
  verifier: ResourceLeaseSignatureVerifier,
): GovernorProjection {
  return applyValidatedGovernorRecord(
    state,
    validateGovernorRecord(input, verifier),
    verifier,
  );
}

function applyValidatedGovernorRecord(
  state: GovernorProjection,
  record: GovernorRecord,
  verifier: ResourceLeaseSignatureVerifier,
): GovernorProjection {
  switch (record.t) {
    case "queued": {
      assertIdentifier(record.reservationId, "Queued reservationId");
      assertRootResourceWorkload(record.workload);
      if (!isAdmissionClass(record.admissionClass)) {
        throw new TypeError("Queued admission class is invalid");
      }
      const existing = state.queued.get(record.reservationId);
      if (existing !== undefined && existing !== record.admissionClass) {
        throw new TypeError("Queued reservation changed admission class");
      }
      if (state.reservations.has(record.reservationId)) {
        throw new TypeError("Active reservation cannot be queued again");
      }
      const workloadKey = rootResourceWorkloadKey(record.workload);
      if (state.dequeued.has(workloadKey)) {
        throw new TypeError("Dequeued reservation cannot be queued again");
      }
      const existingWorkload = state.queuedWorkloads.get(record.reservationId);
      if (
        existingWorkload !== undefined &&
        canonicalize(existingWorkload) !== canonicalize(record.workload)
      ) {
        throw new TypeError("Queued reservation changed workload");
      }
      const existingReservation = state.queuedByWorkload.get(workloadKey);
      if (existingReservation !== undefined && existingReservation !== record.reservationId) {
        throw new TypeError("Resource workload already has another queued reservation");
      }
      if (existing === undefined) {
        state.admissionQueues[record.admissionClass].push(record.reservationId);
      }
      state.queued.set(record.reservationId, record.admissionClass);
      state.queuedWorkloads.set(record.reservationId, { ...record.workload });
      state.queuedByWorkload.set(workloadKey, record.reservationId);
      return state;
    }
    case "dequeue": {
      const workloadKey = rootResourceWorkloadKey(record.workload);
      if (record.reason !== "cancelled" && record.reason !== "failed" && record.reason !== "expired") {
        throw new TypeError("Resource dequeue reason is invalid");
      }
      const previous = state.dequeued.get(workloadKey);
      if (previous !== undefined) {
        if (previous !== record.reason) {
          throw new TypeError("Resource workload was dequeued for another reason");
        }
        return state;
      }
      if (
        [...state.reservations.values()].some(
          (reservation) =>
            reservation.depth === 0 &&
            (reservation.state === "active" || reservation.state === "settled") &&
            rootResourceWorkloadKey(reservation.lease.workload as RootResourceWorkload) ===
              workloadKey,
        )
      ) {
        throw new TypeError("Active resource workload cannot be dequeued");
      }
      const reservationId = state.queuedByWorkload.get(workloadKey);
      if (reservationId !== undefined) {
        const admissionClass = state.queued.get(reservationId);
        if (admissionClass === undefined) {
          throw new TypeError("Resource dequeue lost its queued reservation");
        }
        const queue = state.admissionQueues[admissionClass];
        const index = queue.indexOf(reservationId);
        if (index < 0) {
          throw new TypeError("Resource dequeue lost its admission queue entry");
        }
        queue.splice(index, 1);
        state.queued.delete(reservationId);
        state.queuedWorkloads.delete(reservationId);
        state.queuedByWorkload.delete(workloadKey);
        if (queue.length === 0) {
          state.admissionDeficits[admissionClass] = 0;
          advanceAdmissionCursorPastEmptyQueues(state);
        }
      }
      state.dequeued.set(workloadKey, record.reason);
      return state;
    }
    case "reserve": {
      const lease = validateReservableResourceLease(record.lease, verifier);
      const existing = state.reservations.get(lease.reservationId);
      if (existing !== undefined) {
        if (canonicalize(existing.lease) !== canonicalize(lease)) {
          throw new TypeError("Reservation id was reused for another lease");
        }
        return state;
      }
      const parent = lease.parentId === undefined
        ? undefined
        : state.reservations.get(lease.parentId);
      if (lease.parentId !== undefined && parent === undefined) {
        throw new TypeError("Child resource lease has no active parent");
      }
      if (parent !== undefined) {
        const root = state.reservations.get(parent.rootReservationId);
        if (!root || root.depth !== 0) {
          throw new TypeError("Child resource lease lost its root reservation");
        }
        assertParentChildBinding(parent, lease as ChildResourceLease, root);
        reserveChildBudget(parent, lease.budget);
      } else {
        if (state.dequeued.has(rootResourceWorkloadKey(lease.workload as RootResourceWorkload))) {
          throw new TypeError("Dequeued reservation cannot be activated");
        }
        const queuedClass = state.queued.get(lease.reservationId);
        if (queuedClass !== lease.admissionClass) {
          throw new TypeError("Reserved lease changed its queued admission class");
        }
        const queuedWorkload = state.queuedWorkloads.get(lease.reservationId);
        if (!queuedWorkload || canonicalize(queuedWorkload) !== canonicalize(lease.workload)) {
          throw new TypeError("Reserved lease changed its queued workload");
        }
        advanceFairReservation(
          state,
          lease.reservationId,
          lease.admissionClass,
        );
        state.queuedWorkloads.delete(lease.reservationId);
        state.queuedByWorkload.delete(rootResourceWorkloadKey(queuedWorkload));
        state.queued.delete(lease.reservationId);
      }
      state.reservations.set(lease.reservationId, {
        lease,
        rootReservationId: parent?.rootReservationId ?? lease.reservationId,
        depth: parent === undefined ? 0 : parent.depth + 1,
        used: zeroUsage(),
        descendantUsed: zeroUsage(),
        reservedUsage: zeroUsage(),
        descendantReservedUsage: zeroUsage(),
        reservedForChildren: zeroUsage(),
        settled: false,
        state: "active",
      });
      return state;
    }
    case "usage-reserved": {
      assertIdentifier(record.rootReservationId, "Reserved usage root reservationId");
      assertIdentifier(record.reservationId, "Reserved usage reservationId");
      assertIdentifier(record.usageId, "Reserved usageId");
      const usage = resourceBudgetUsage(record);
      const existing = state.usageReservations.get(record.usageId);
      if (existing !== undefined) {
        if (
          existing.rootReservationId !== record.rootReservationId ||
          existing.reservationId !== record.reservationId ||
          canonicalize(existing.usage) !== canonicalize(usage)
        ) {
          throw new TypeError("Resource usage reservation id was reused with different content");
        }
        return state;
      }
      if (state.usages.has(record.usageId)) {
        throw new TypeError("Consumed resource usage has no matching reservation identity");
      }
      const root = requireActiveReservation(state, record.rootReservationId);
      if (root.depth !== 0) {
        throw new TypeError("Reserved usage root is not a root reservation");
      }
      const reservation = state.reservations.get(record.reservationId);
      if (reservation !== undefined) {
        if (
          reservation.state !== "active" ||
          reservation.rootReservationId !== record.rootReservationId
        ) {
          throw new TypeError("Reserved usage binds a different or inactive reservation");
        }
        reservation.reservedUsage = addResourceUsageAllowZero(
          reservation.reservedUsage,
          usage,
        );
        assertReservationCommitmentsWithinBudget(reservation);
      } else {
        if (root.lease.delegation === undefined) {
          throw new TypeError("Unknown reserved usage is not covered by root delegation");
        }
        root.descendantReservedUsage = addResourceUsageAllowZero(
          root.descendantReservedUsage,
          usage,
        );
        assertReservationCommitmentsWithinBudget(root);
        assertDelegatedCommitmentsWithinBudget(root);
      }
      state.usageReservations.set(record.usageId, {
        rootReservationId: record.rootReservationId,
        reservationId: record.reservationId,
        usage,
        state: "reserved",
      });
      return state;
    }
    case "consume": {
      assertPositive(record.usageSeq, "Resource usage sequence");
      assertIdentifier(record.rootReservationId, "Resource root reservationId");
      assertIdentifier(record.reservationId, "Resource reservationId");
      assertIdentifier(record.usageId, "Resource usageId");
      const usage = resourceBudgetUsage(record);
      const existing = state.usages.get(record.usageId);
      if (existing !== undefined) {
        if (
          existing.rootReservationId !== record.rootReservationId ||
          existing.reservationId !== record.reservationId ||
          existing.usageSeq !== record.usageSeq ||
          canonicalize(existing.usage) !== canonicalize(usage)
        ) {
          throw new TypeError("Resource usage id was reused with different content");
        }
        return state;
      }
      const usageReservation = state.usageReservations.get(record.usageId);
      if (
        !usageReservation ||
        usageReservation.state !== "reserved" ||
        usageReservation.rootReservationId !== record.rootReservationId ||
        usageReservation.reservationId !== record.reservationId
      ) {
        throw new TypeError("Resource usage has no matching durable reservation");
      }
      assertUsageWithinReservation(usage, usageReservation.usage);
      const reservation = state.reservations.get(record.reservationId);
      const root = requireActiveReservation(state, record.rootReservationId);
      if (root.depth !== 0) {
        throw new TypeError("Resource usage root is not a root reservation");
      }
      if (
        reservation !== undefined &&
        (reservation.state !== "active" ||
          reservation.rootReservationId !== record.rootReservationId)
      ) {
        throw new TypeError("Resource usage binds a different or inactive reservation");
      }
      if (reservation === undefined && root.lease.delegation === undefined) {
        throw new TypeError("Unknown resource usage is not covered by root delegation");
      }
      const expectedSeq = state.nextUsageSeqByRoot.get(record.rootReservationId) ?? 1;
      if (record.usageSeq !== expectedSeq) {
        throw new TypeError("Resource usage sequence is not continuous");
      }
      if (reservation === undefined) {
        root.descendantReservedUsage = subtractResourceUsage(
          root.descendantReservedUsage,
          usageReservation.usage,
          "Delegated usage reservation",
        );
        root.descendantUsed = addResourceUsageAllowZero(root.descendantUsed, usage);
        assertReservationCommitmentsWithinBudget(root);
        assertDelegatedCommitmentsWithinBudget(root);
      } else {
        reservation.reservedUsage = subtractResourceUsage(
          reservation.reservedUsage,
          usageReservation.usage,
          "Resource usage reservation",
        );
        const updated = addResourceUsage(reservation.used, usage);
        assertUsageWithinBudget(updated, reservation.lease.budget);
        reservation.used = updated;
        if (reservation.depth === 0) {
          assertReservationCommitmentsWithinBudget(reservation);
        } else {
          let ancestorId = reservation.lease.parentId;
          while (ancestorId !== undefined) {
            const ancestor = requireActiveReservation(state, ancestorId);
            consumeChildBudget(ancestor, usage);
            ancestorId = ancestor.lease.parentId;
          }
        }
      }
      state.usages.set(record.usageId, {
        rootReservationId: record.rootReservationId,
        reservationId: record.reservationId,
        usageSeq: record.usageSeq,
        usage,
      });
      usageReservation.state = "consumed";
      state.nextUsageSeqByRoot.set(record.rootReservationId, expectedSeq + 1);
      return state;
    }
    case "settle":
    case "release":
    case "reclaim": {
      assertIdentifier(record.reservationId, "Terminal reservationId");
      const reservation = state.reservations.get(record.reservationId);
      if (!reservation) throw new TypeError("Terminal resource record has no reservation");
      if (record.t === "settle") {
        if (reservation.settled) return state;
        if (reservation.state !== "active") {
          throw new TypeError("Only an active reservation can settle");
        }
      } else if (record.t === "release") {
        if (reservation.state === "released") return state;
        if (reservation.state !== "active" && reservation.state !== "settled") {
          throw new TypeError("Only an active or settled reservation can release");
        }
      } else {
        if (reservation.state === "reclaimed") return state;
        if (reservation.state !== "active") {
          throw new TypeError("Only an active reservation can be reclaimed");
        }
      }
      if (hasActiveChildren(state, record.reservationId)) {
        throw new TypeError("Resource reservation has active child leases");
      }
      if (hasOpenUsageReservations(state, record.reservationId)) {
        throw new TypeError("Resource reservation has open usage reservations");
      }
      if (
        reservation.depth > 0 &&
        (record.t === "release" || record.t === "reclaim")
      ) {
        const parent = state.reservations.get(reservation.lease.parentId!);
        if (!parent) throw new TypeError("Child resource lease lost its parent");
        releaseChildBudget(parent, reservation);
      }
      if (record.t === "settle") {
        reservation.settled = true;
        reservation.state = "settled";
      } else {
        reservation.state = record.t === "release" ? "released" : "reclaimed";
      }
      return state;
    }
  }
}

export function validateUsageReport(
  input: unknown,
  verifier: ResourceLeaseSignatureVerifier,
): UsageReport {
  assertPlainObject(input, "Usage report");
  const report = structuredClone(input) as unknown as UsageReport;
  assertExactKeys(report, [
    "digest",
    "fromUsageSeq",
    "reporterId",
    "rootReservationId",
    "signature",
    "toUsageSeq",
    "usages",
    "v",
    "workloadRef",
  ], "Usage report");
  if (report.v !== 1) throw new TypeError("Usage report version is invalid");
  assertIdentifier(report.reporterId, "Usage report reporterId");
  assertIdentifier(report.rootReservationId, "Usage report rootReservationId");
  assertPositive(report.fromUsageSeq, "Usage report first sequence");
  assertPositive(report.toUsageSeq, "Usage report final sequence");
  if (!Array.isArray(report.usages) || report.usages.length === 0 || report.usages.length > 256) {
    throw new TypeError("Usage report batch size is invalid");
  }
  if (report.toUsageSeq - report.fromUsageSeq + 1 !== report.usages.length) {
    throw new TypeError("Usage report sequence range is not dense");
  }
  assertPlainObject(report.workloadRef, "Usage report workload ref");
  if (report.workloadRef.kind === "assignment") {
    assertExactKeys(report.workloadRef, ["assignmentId", "kind"], "Usage report workload ref");
    assertIdentifier(report.workloadRef.assignmentId, "Usage report assignmentId");
  } else if (report.workloadRef.kind === "evidence") {
    assertExactKeys(report.workloadRef, ["kind", "requestId"], "Usage report workload ref");
    assertIdentifier(report.workloadRef.requestId, "Usage report requestId");
  } else {
    throw new TypeError("Usage report workload ref kind is invalid");
  }
  for (let index = 0; index < report.usages.length; index += 1) {
    const usage = report.usages[index]!;
    assertPlainObject(usage, "Usage report entry");
    const keys = ["reservationId", "usageId", "usageSeq"];
    if (usage.tokens !== undefined) keys.push("tokens");
    if (usage.calls !== undefined) keys.push("calls");
    if (usage.costMinor !== undefined) keys.push("costMinor");
    assertExactKeys(usage, keys, "Usage report entry");
    assertIdentifier(usage.reservationId, "Usage report reservationId");
    assertIdentifier(usage.usageId, "Usage report usageId");
    if (usage.usageSeq !== report.fromUsageSeq + index) {
      throw new TypeError("Usage report entries are not continuous");
    }
    resourceBudgetUsage(usage);
  }
  assertDigest(report.digest, "Usage report digest");
  const { signature, ...signed } = report;
  const { digest, ...payload } = signed;
  if (digest !== protocolDigest("UsageReport", 1, payload)) {
    throw new TypeError("Usage report digest is invalid");
  }
  verifier.verify("UsageReport", 1, signed, signature);
  return report;
}

export function isAdmissionClass(value: unknown): value is AdmissionClass {
  return typeof value === "string" && ADMISSION_CLASS_SET.has(value);
}

export function validateReservationOrigin(input: unknown): ReservationOrigin {
  assertPlainObject(input, "Reservation origin");
  assertExactKeys(input, ["admissionClass", "entry"], "Reservation origin");
  const expected = input.entry === "conversation-input"
    ? "interactive"
    : input.entry === "advancement-control"
      ? "advancement"
      : input.entry === "schedule-trigger"
        ? "scheduler"
        : input.entry === "orchestration"
          ? "orchestration"
          : undefined;
  if (expected === undefined || input.admissionClass !== expected) {
    throw new TypeError("Reservation origin cannot self-report another admission class");
  }
  return structuredClone(input) as ReservationOrigin;
}

export function validateSystemJobReservationOrigin(
  input: unknown,
): SystemJobReservationOrigin {
  const origin = validateReservationOrigin(input);
  if (origin.entry !== "schedule-trigger") {
    throw new TypeError("System job reservation requires scheduler admission");
  }
  return origin;
}

export function isBusinessOwnedResourceReservation(
  state: GovernorProjection,
  reservation: ResourceReservationProjection,
): boolean {
  const root = state.reservations.get(reservation.rootReservationId);
  return root?.depth === 0 &&
    "activation" in root.lease &&
    (root.lease.activation.kind === "assignment" ||
      root.lease.activation.kind === "system-job");
}

export function rootResourceWorkloadKey(
  workload: RootResourceWorkload,
): string {
  if (
    workload.kind !== "run" &&
    workload.kind !== "job" &&
    workload.kind !== "control"
  ) {
    throw new TypeError("Root resource workload kind is invalid");
  }
  assertIdentifier(workload.id, "Root resource workload id");
  assertPositive(workload.attempt, "Root resource workload attempt");
  return `${workload.kind}:${workload.id}:${workload.attempt}`;
}

export function requiresFormalResourceCoordination(
  binding:
    | { readonly reservationId: string; readonly assignmentId: string }
    | {
        readonly reservationId: string;
        readonly activation: { readonly assignmentId: string };
      },
): boolean {
  const assignmentId = "assignmentId" in binding
    ? binding.assignmentId
    : binding.activation.assignmentId;
  assertIdentifier(binding.reservationId, "Resource reservation id");
  assertIdentifier(assignmentId, "Resource assignment id");
  return binding.reservationId === `reservation:${assignmentId}`;
}

export function queuedTerminalDequeueRecord(
  workload: RootResourceWorkload,
  reason: Extract<GovernorRecord, { t: "dequeue" }>["reason"],
): LogicalRecord<GovernorRecord> {
  rootResourceWorkloadKey(workload);
  return {
    stream: "governor",
    body: {
      t: "dequeue",
      workload: { ...workload },
      reason,
    },
  };
}

export function assertQueuedTerminalDequeue(
  records: readonly LogicalRecord<unknown>[],
  workload: RootResourceWorkload,
  reason: Extract<GovernorRecord, { t: "dequeue" }>["reason"],
): void {
  const workloadKey = rootResourceWorkloadKey(workload);
  const matches = records.filter((record) => {
    if (record.stream !== "governor") return false;
    assertPlainObject(record.body, "Governor record");
    if (record.body.t !== "dequeue") return false;
    const body = validateGovernorDequeueRecord(record.body);
    return rootResourceWorkloadKey(body.workload) === workloadKey;
  });
  if (
    matches.length !== 1 ||
    canonicalize(matches[0]!.body) !==
      canonicalize(queuedTerminalDequeueRecord(workload, reason).body)
  ) {
    throw new TypeError(
      `Queued terminal state lacks its exact resource dequeue (found ${matches.length})`,
    );
  }
}

function validateGovernorDequeueRecord(
  input: Record<string, unknown>,
): Extract<GovernorRecord, { t: "dequeue" }> {
  assertExactKeys(input, ["reason", "t", "workload"], "Dequeue governor record");
  assertRootResourceWorkload(input.workload);
  if (
    input.reason !== "cancelled" &&
    input.reason !== "failed" &&
    input.reason !== "expired"
  ) {
    throw new TypeError("Resource dequeue reason is invalid");
  }
  return structuredClone(input) as Extract<GovernorRecord, { t: "dequeue" }>;
}

function assertRootResourceWorkload(
  workload: unknown,
): asserts workload is RootResourceWorkload {
  assertPlainObject(workload, "Root resource workload");
  assertExactKeys(workload, ["attempt", "id", "kind"], "Root resource workload");
  rootResourceWorkloadKey(workload as RootResourceWorkload);
  assertPositive((workload as RootResourceWorkload).attempt, "Root resource workload attempt");
}

/**
 * 准入请求的单源前置验证——双 governor 的 enqueue、prepare 与 acquire 在产生任何
 * 调度或耐久副作用之前必须先通过本谓词；非法请求零日志、零候选、零队列项。
 */
export function assertResourceAdmissionRequest(
  workload: unknown,
  budget?: unknown,
): void {
  assertRootResourceWorkload(workload);
  if (budget !== undefined) {
    assertResourceLeaseBudget(budget, "Resource admission budget");
  }
}

/** assignment 根准入请求的完整前置验证——字段封闭、身份、scope、budget 一次验齐。 */
export function assertAssignmentReservationRequest(value: unknown): void {
  assertPlainObject(value, "Assignment reservation request");
  assertExactKeys(
    value,
    ["assignmentId", "budget", "executorId", "scopeBinding", "workload"],
    "Assignment reservation request",
  );
  assertIdentifier(value.assignmentId, "Assignment reservation assignmentId");
  assertIdentifier(value.executorId, "Assignment reservation executorId");
  assertRootResourceWorkload(value.workload);
  const workloadKind = (value.workload as RootResourceWorkload).kind;
  if (workloadKind !== "run" && workloadKind !== "job") {
    throw new TypeError("Assignment reservation workload must be a run or job root");
  }
  assertResourceScopeBinding(value.scopeBinding, "Assignment reservation");
  const scopeKind = (value.scopeBinding as { kind: string }).kind;
  if (
    (workloadKind === "run" && scopeKind !== "conversation") ||
    (workloadKind === "job" && scopeKind !== "job")
  ) {
    throw new TypeError("Assignment reservation scope does not match its workload kind");
  }
  assertResourceLeaseBudget(value.budget, "Assignment reservation budget");
}

/** system-job 根准入请求的完整前置验证——job workload 与 job scope 封闭对齐。 */
export function assertSystemJobReservationRequest(value: unknown): void {
  assertPlainObject(value, "System job reservation request");
  assertExactKeys(
    value,
    ["budget", "scopeBinding", "workload"],
    "System job reservation request",
  );
  assertRootResourceWorkload(value.workload);
  if ((value.workload as RootResourceWorkload).kind !== "job") {
    throw new TypeError("System job reservation workload must be a job root");
  }
  assertResourceScopeBinding(value.scopeBinding, "System job reservation");
  if ((value.scopeBinding as { kind: string }).kind !== "job") {
    throw new TypeError("System job reservation requires a job scope binding");
  }
  assertResourceLeaseBudget(value.budget, "System job reservation budget");
}

/** Selects the next schedulable class without changing durable fairness state. */
export function selectFairReservation(
  state: GovernorProjection,
  occupiedClasses: ReadonlySet<AdmissionClass> = new Set(),
): { readonly reservationId: string; readonly admissionClass: AdmissionClass } | undefined {
  if (state.queued.size === 0) return undefined;
  for (let offset = 0; offset < ADMISSION_CLASSES.length; offset += 1) {
    const index = (state.admissionCursor + offset) % ADMISSION_CLASSES.length;
    const admissionClass = ADMISSION_CLASSES[index]!;
    const queue = state.admissionQueues[admissionClass];
    if (queue.length === 0 || occupiedClasses.has(admissionClass)) continue;
    return { reservationId: queue[0]!, admissionClass };
  }
  return undefined;
}

/** Applies one admitted service fact to the replayable WDRR projection. */
export function advanceFairReservation(
  state: GovernorProjection,
  reservationId: string,
  admissionClass: AdmissionClass,
): void {
  const queue = state.admissionQueues[admissionClass];
  if (state.queued.get(reservationId) !== admissionClass || queue[0] !== reservationId) {
    throw new TypeError("Resource reservation is not the head of its admission class");
  }
  if (state.admissionDeficits[admissionClass] === 0) {
    state.admissionDeficits[admissionClass] = DEFAULT_ADMISSION_WEIGHTS[admissionClass];
  }
  queue.shift();
  state.admissionDeficits[admissionClass] -= 1;
  const classIndex = ADMISSION_CLASSES.indexOf(admissionClass);
  if (queue.length > 0 && state.admissionDeficits[admissionClass] > 0) {
    state.admissionCursor = classIndex;
    return;
  }
  if (queue.length === 0) state.admissionDeficits[admissionClass] = 0;
  state.admissionCursor = (classIndex + 1) % ADMISSION_CLASSES.length;
  advanceAdmissionCursorPastEmptyQueues(state);
}

/** Compatibility helper for a scheduler with no occupied class. */
export function dequeueFairReservation(
  state: GovernorProjection,
): { readonly reservationId: string; readonly admissionClass: AdmissionClass } | undefined {
  const selected = selectFairReservation(state);
  if (!selected) return undefined;
  advanceFairReservation(state, selected.reservationId, selected.admissionClass);
  return selected;
}

function advanceAdmissionCursorPastEmptyQueues(state: GovernorProjection): void {
  for (let probes = 0; probes < ADMISSION_CLASSES.length; probes += 1) {
    const admissionClass = ADMISSION_CLASSES[state.admissionCursor]!;
    if (state.admissionQueues[admissionClass].length > 0) return;
    state.admissionDeficits[admissionClass] = 0;
    state.admissionCursor = (state.admissionCursor + 1) % ADMISSION_CLASSES.length;
  }
}

function assertParentChildBinding(
  parent: ResourceReservationProjection,
  child: ChildResourceLease,
  root: ResourceReservationProjection,
): void {
  if (parent.state !== "active") throw new TypeError("Child lease parent is not active");
  if (child.parentDigest !== parent.lease.digest) {
    throw new TypeError("Child lease parent digest is invalid");
  }
  if (child.admissionClass !== parent.lease.admissionClass) {
    throw new TypeError("Child lease changed admission class");
  }
  if (canonicalize(child.scopeBinding) !== canonicalize(parent.lease.scopeBinding)) {
    throw new TypeError("Child lease changed scope binding");
  }
  if (canonicalize(child.domain) !== canonicalize(parent.lease.domain)) {
    throw new TypeError("Child lease changed resource domain");
  }
  if (
    parent.lease.audience.provider !== undefined &&
    child.audience.provider !== parent.lease.audience.provider
  ) {
    throw new TypeError("Child lease changed its provider audience");
  }
  if (
    parent.lease.audience.model !== undefined &&
    child.audience.model !== parent.lease.audience.model
  ) {
    throw new TypeError("Child lease changed its model audience");
  }
  if (Date.parse(child.expiry) > Date.parse(parent.lease.expiry)) {
    throw new TypeError("Child lease outlives its parent");
  }
  assertBudgetWithinBudget(child.budget, parent.lease.budget);
  const delegation = root.lease.delegation;
  if (root.lease.domain.kind === "anchor" && delegation === undefined) {
    throw new TypeError("Anchor resource root does not delegate child issuance");
  }
  if (delegation !== undefined) {
    if (child.audience.executorId !== delegation.executorId) {
      throw new TypeError("Child lease exceeds its delegated executor");
    }
    if (parent.depth + 1 > delegation.maxDepth) {
      throw new TypeError("Child lease exceeds delegation depth");
    }
    assertBudgetWithinBudget(child.budget, delegation.maxBudget, "Delegated child budget");
  } else if (child.audience.executorId !== root.lease.audience.executorId) {
    throw new TypeError("Local child lease changed its executor audience");
  }
}

function reserveChildBudget(
  parent: ResourceReservationProjection,
  budget: ResourceLease["budget"],
): void {
  const allocation = budgetAsUsage(budget);
  const reserved = addResourceUsageAllowZero(
    parent.reservedForChildren,
    allocation,
  );
  assertUsageWithinBudget(
    addResourceUsageAllowZero(
      addResourceUsageAllowZero(
        addResourceUsageAllowZero(
          addResourceUsageAllowZero(parent.used, parent.descendantUsed),
          parent.reservedUsage,
        ),
        parent.descendantReservedUsage,
      ),
      reserved,
    ),
    parent.lease.budget,
    "Parent resource commitments",
  );
  if (parent.lease.delegation) {
    assertDelegatedCommitmentsWithinBudget({
      ...parent,
      reservedForChildren: reserved,
    });
  }
  parent.reservedForChildren = reserved;
}

function consumeChildBudget(
  parent: ResourceReservationProjection,
  usage: ResourceBudgetUsage,
): void {
  parent.reservedForChildren = subtractResourceUsage(
    parent.reservedForChildren,
    usage,
    "Child resource consumption",
  );
  parent.descendantUsed = addResourceUsageAllowZero(parent.descendantUsed, usage);
  assertReservationCommitmentsWithinBudget(parent);
  assertDelegatedCommitmentsWithinBudget(parent);
}

function releaseChildBudget(
  parent: ResourceReservationProjection,
  child: ResourceReservationProjection,
): void {
  const remaining = subtractResourceUsage(
    budgetAsUsage(child.lease.budget),
    addResourceUsageAllowZero(child.used, child.descendantUsed),
    "Child resource remainder",
  );
  parent.reservedForChildren = subtractResourceUsage(
    parent.reservedForChildren,
    remaining,
    "Released child resource budget",
  );
}

function assertReservationCommitmentsWithinBudget(
  reservation: ResourceReservationProjection,
): void {
  assertUsageWithinBudget(
    addResourceUsageAllowZero(
      addResourceUsageAllowZero(
        addResourceUsageAllowZero(
          addResourceUsageAllowZero(
            reservation.used,
            reservation.descendantUsed,
          ),
          reservation.reservedUsage,
        ),
        reservation.descendantReservedUsage,
      ),
      reservation.reservedForChildren,
    ),
    reservation.lease.budget,
    "Resource commitments",
  );
}

function assertDelegatedCommitmentsWithinBudget(
  reservation: ResourceReservationProjection,
): void {
  if (!reservation.lease.delegation) return;
  assertUsageWithinBudget(
    addResourceUsageAllowZero(
      addResourceUsageAllowZero(
        reservation.descendantUsed,
        reservation.descendantReservedUsage,
      ),
      reservation.reservedForChildren,
    ),
    reservation.lease.delegation.maxBudget,
    "Delegated resource commitments",
  );
}

function assertUsageWithinReservation(
  actual: ResourceBudgetUsage,
  reserved: ResourceBudgetUsage,
): void {
  if (
    actual.tokens > reserved.tokens ||
    actual.calls > reserved.calls ||
    actual.costMinor > reserved.costMinor
  ) {
    throw new TypeError("Resource usage exceeds its durable reservation");
  }
}

function hasOpenUsageReservations(
  state: GovernorProjection,
  reservationId: string,
): boolean {
  const reservation = state.reservations.get(reservationId);
  if (!reservation) return false;
  for (const usage of state.usageReservations.values()) {
    if (
      usage.state === "reserved" &&
      (usage.reservationId === reservationId ||
        (reservation.depth === 0 && usage.rootReservationId === reservationId))
    ) {
      return true;
    }
  }
  return false;
}

function hasActiveChildren(
  state: GovernorProjection,
  reservationId: string,
): boolean {
  for (const reservation of state.reservations.values()) {
    if (
      reservation.lease.parentId === reservationId &&
      (reservation.state === "active" || reservation.state === "settled")
    ) {
      return true;
    }
  }
  return false;
}

function requireActiveReservation(
  state: GovernorProjection,
  reservationId: string,
): ResourceReservationProjection {
  const reservation = state.reservations.get(reservationId);
  if (!reservation || reservation.state !== "active") {
    throw new TypeError("Resource reservation is not active");
  }
  return reservation;
}

function validateActivation(lease: ReservableResourceLease): void {
  const activation = (lease as ReservableResourceLease & { activation: unknown }).activation;
  assertPlainObject(activation, "Resource lease activation");
  if (activation.kind === "assignment") {
    assertExactKeys(activation, ["assignmentId", "kind"], "Resource lease activation");
    assertIdentifier(activation.assignmentId, "Resource lease assignmentId");
    if (lease.workload.kind !== "run" && lease.workload.kind !== "job") {
      throw new TypeError("Assignment resource lease workload is invalid");
    }
    return;
  }
  if (activation.kind === "system-job") {
    assertExactKeys(activation, ["jobRunId", "kind"], "Resource lease activation");
    assertIdentifier(activation.jobRunId, "Resource lease jobRunId");
    if (lease.workload.kind !== "job") {
      throw new TypeError("System job resource lease workload is invalid");
    }
    return;
  }
  throw new TypeError("Resource lease activation kind is invalid");
}

function assertReservableLeaseVariant(
  lease: ReservableResourceLease,
  root: boolean,
): void {
  if (!root) return;
  const activation = "activation" in lease ? lease.activation : undefined;
  if (activation === undefined) {
    if (lease.workload.kind !== "control" || lease.scopeBinding.kind !== "control") {
      throw new TypeError("Immediate resource root must use a control workload and scope");
    }
    return;
  }
  if (lease.audience.executorId === undefined) {
    throw new TypeError("Activated resource root must bind an executor audience");
  }
  if (activation.kind === "system-job") {
    if (
      lease.admissionClass !== "scheduler" ||
      lease.workload.kind !== "job" ||
      lease.scopeBinding.kind !== "job" ||
      lease.domain.kind !== "anchor"
    ) {
      throw new TypeError("System job resource root has an invalid contract combination");
    }
    return;
  }
  if (lease.workload.kind === "run") {
    if (lease.scopeBinding.kind !== "conversation") {
      throw new TypeError("Conversation assignment resource root has an invalid scope");
    }
    return;
  }
  if (
    lease.workload.kind !== "job" ||
    lease.scopeBinding.kind !== "job" ||
    lease.domain.kind !== "anchor"
  ) {
    throw new TypeError("Job assignment resource root has an invalid contract combination");
  }
}

function zeroUsage(): ResourceBudgetUsage {
  return { tokens: 0, calls: 0, costMinor: 0 };
}

function budgetAsUsage(budget: ResourceLease["budget"]): ResourceBudgetUsage {
  return {
    tokens: budget.maxTokens ?? 0,
    calls: budget.maxCalls ?? 0,
    costMinor: budget.maxCostMinor ?? 0,
  };
}

function addResourceUsageAllowZero(
  left: ResourceBudgetUsage,
  right: ResourceBudgetUsage,
): ResourceBudgetUsage {
  return {
    tokens: safeAdd(left.tokens, right.tokens, "Resource token usage"),
    calls: safeAdd(left.calls, right.calls, "Resource call usage"),
    costMinor: safeAdd(left.costMinor, right.costMinor, "Resource cost usage"),
  };
}

function subtractResourceUsage(
  left: ResourceBudgetUsage,
  right: ResourceBudgetUsage,
  label: string,
): ResourceBudgetUsage {
  const result = {
    tokens: left.tokens - right.tokens,
    calls: left.calls - right.calls,
    costMinor: left.costMinor - right.costMinor,
  };
  if (Object.values(result).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${label} exceeds its reserved budget`);
  }
  return result;
}

function emptyAdmissionQueues(): Record<AdmissionClass, string[]> {
  return {
    interactive: [],
    advancement: [],
    scheduler: [],
    orchestration: [],
  };
}

function emptyAdmissionCounters(): Record<AdmissionClass, number> {
  return {
    interactive: 0,
    advancement: 0,
    scheduler: 0,
    orchestration: 0,
  };
}

function assertDimension(value: number, limit: number | undefined, label: string): void {
  if (value === 0) return;
  if (limit === undefined || value > limit) throw new TypeError(`${label} exceeds budget`);
}

function requirePositive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function assertPositive(value: unknown, label: string): asserts value is number {
  requirePositive(value, label);
}

function requireNonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} overflowed`);
  return result;
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...expected].sort())) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical digest`);
  }
}
