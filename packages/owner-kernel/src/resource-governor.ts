import type {
  AdmissionClass,
  AssignmentReservationRequest,
  AssignmentResourceLease,
  AuthorityCapability,
  AuthorityCallContext,
  AuthorityPortMethodId,
  ChildResourceLease,
  GovernorRecord,
  ImmediateRootResourceLease,
  ImmediateRootWorkload,
  LogicalRecord,
  ReservationOrigin,
  ResourceLease,
  RootResourceWorkload,
  ResourceReservationPort,
  ResourceUsageIntake,
  SystemJobReservationRequest,
  SystemJobReservationOrigin,
  SystemJobResourceLease,
  UsageReport,
} from "@zhixing/core/contracts";
import type {
  AuthorityCommitLog,
  ProjectionCursor,
} from "@zhixing/core/authority";
import { SerialTaskQueue } from "@zhixing/core/persistence";
import {
  applyGovernorRecord,
  applyGovernorRecordAt,
  acceptedRemoteIntervalRemainingMs,
  assertAcceptedResourceCapabilityBinding,
  assertActivatedResourceCapability,
  assertBudgetWithinBudget,
  assertResourceAdmissionRequest,
  assertAssignmentReservationRequest,
  assertSystemJobReservationRequest,
  canonicalize,
  cloneGovernorProjection,
  compactGovernorProjection,
  conservativeUsageConsumptionRecords,
  GOVERNOR_TERMINAL_RETENTION_MS,
  emptyGovernorProjection,
  isBusinessOwnedResourceReservation,
  protocolDigest,
  queuedTerminalDequeueRecord,
  ResourceAdmissionDeferredError,
  resourceBudgetUsage,
  rootResourceWorkloadKey,
  selectFairReservation,
  validateReservationOrigin,
  validateReservableResourceLease,
  validateGovernorRecord,
  validateSystemJobReservationOrigin,
  validateUsageReport,
  waitForResourceAdmissionCandidate,
  type GovernorProjection,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type { SystemJobResourceCoordinator } from "./job-assignment.js";

const GOVERNOR_STREAM = "governor";
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;
const MAX_LEASE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_CANDIDATE_TTL_MS = 5_000;
const MAX_CANDIDATE_TTL_MS = 60_000;

const sharedGovernorOperations = new WeakMap<AuthorityCommitLog, SerialTaskQueue>();

export interface ResourceAuthorityGuard {
  assert(
    principal: AuthorityCallContext["principal"],
    method: AuthorityPortMethodId,
  ): void;
}

export interface AnchorResourceGovernorOptions {
  readonly log: AuthorityCommitLog;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly guard: ResourceAuthorityGuard;
  readonly anchorEpoch: number;
  readonly localExecutorId: string;
  readonly reporterKeyFor: (executorId: string) => string | undefined;
  readonly leaseTtlMs?: number;
  readonly candidateTtlMs?: number;
  readonly clock?: () => string;
  readonly monotonicClock?: () => number;
}

type RootResourceCandidate =
  | AssignmentResourceLease
  | SystemJobResourceLease
  | ImmediateRootResourceLease;

interface CandidateOccupancy {
  readonly lease: RootResourceCandidate;
  readonly expiresAt: number;
}

export interface AssignmentResourceCoordinator {
  coordinate<T>(operation: () => Promise<T>): Promise<T>;
  prepareQueuedTerminal(input: {
    readonly workload: RootResourceWorkload;
    readonly reason: Extract<GovernorRecord, { t: "dequeue" }>["reason"];
  }): readonly LogicalRecord<GovernorRecord>[];
  prepareActivation(
    lease: AssignmentResourceLease,
  ): readonly LogicalRecord<GovernorRecord>[];
  prepareTerminal(input: {
    readonly lease: AssignmentResourceLease;
    readonly mode: "settle-release" | "release" | "reclaim";
  }): readonly LogicalRecord<GovernorRecord>[];
  assertUsageFinal(input: {
    readonly reservationId: string;
    readonly assignmentId: string;
    readonly executorId: string;
    readonly usageFinal: {
      readonly reportDigest: string;
      readonly upToUsageSeq: number;
    };
  }): void;
  assertActivationRecords(input: {
    readonly lease: AssignmentResourceLease;
    readonly records: readonly LogicalRecord<unknown>[];
    readonly acceptedAt?: string;
  }): void;
  assertTerminalRecords(input: {
    readonly reservationId: string;
    readonly mode: "settle-release" | "release" | "reclaim";
    readonly records: readonly LogicalRecord<unknown>[];
  }): void;
}

/** Durable anchor-domain governor shared by every in-process workload entry. */
export class AnchorResourceGovernor
  implements
    ResourceReservationPort,
    ResourceUsageIntake,
    AssignmentResourceCoordinator,
    SystemJobResourceCoordinator
{
  readonly #log: AuthorityCommitLog;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #guard: ResourceAuthorityGuard;
  readonly #anchorEpoch: number;
  readonly #localExecutorId: string;
  readonly #reporterKeyFor: AnchorResourceGovernorOptions["reporterKeyFor"];
  readonly #leaseTtlMs: number;
  readonly #candidateTtlMs: number;
  readonly #clock: () => string;
  readonly #monotonicClock: () => number;
  readonly #operations: SerialTaskQueue;
  readonly #candidates = new Map<AdmissionClass, CandidateOccupancy>();
  readonly #leaseDeadlines = new Map<string, {
    readonly digest: string;
    readonly deadline: number;
  }>();
  readonly #capabilityDeadlines = new Map<string, {
    readonly identity: string;
    readonly deadline: number;
    readonly rootReservationId: string;
  }>();
  #projection: { readonly state: GovernorProjection; readonly cursor: ProjectionCursor } | undefined;

  constructor(options: AnchorResourceGovernorOptions) {
    this.#log = options.log;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#guard = options.guard;
    this.#anchorEpoch = requirePositive(options.anchorEpoch, "Resource governor anchor epoch");
    this.#localExecutorId = requireIdentifier(options.localExecutorId, "Resource governor executorId");
    this.#reporterKeyFor = options.reporterKeyFor;
    this.#leaseTtlMs = requirePositive(
      options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      "Resource lease TTL",
    );
    if (this.#leaseTtlMs > MAX_LEASE_TTL_MS) {
      throw new TypeError("Resource lease TTL exceeds its protocol maximum");
    }
    this.#candidateTtlMs = requirePositive(
      options.candidateTtlMs ?? DEFAULT_CANDIDATE_TTL_MS,
      "Resource candidate TTL",
    );
    if (this.#candidateTtlMs > MAX_CANDIDATE_TTL_MS) {
      throw new TypeError("Resource candidate TTL exceeds its protocol maximum");
    }
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#monotonicClock = options.monotonicClock ?? (() => performance.now());
    const shared = sharedGovernorOperations.get(options.log) ?? new SerialTaskQueue();
    sharedGovernorOperations.set(options.log, shared);
    this.#operations = shared;
  }

  async coordinate<T>(operation: () => Promise<T>): Promise<T> {
    return this.#operations.run(async () => {
      await this.#synchronizeUnlocked();
      try {
        return await operation();
      } finally {
        await this.#synchronizeUnlocked();
        this.#pruneCandidates();
      }
    });
  }

  async enqueueRoot(
    reservationId: string,
    workload: RootResourceWorkload,
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<void> {
    requireIdentifier(reservationId, "Queued reservationId");
    validateReservationOrigin(origin);
    this.#guard.assert(ctx.principal, "reservation.enqueueRoot");
    assertResourceAdmissionRequest(workload);
    requireIdentifier(ctx.requestId, "Reservation requestId");
    deadlineFromContext(ctx, this.#clock(), this.#monotonicClock());
    await this.#enqueue(reservationId, workload, origin.admissionClass);
  }

  async #enqueue(
    reservationId: string,
    workload: RootResourceWorkload,
    admissionClass: AdmissionClass,
  ): Promise<void> {
    await this.#transact<void>((state) => {
      const existing = state.queued.get(reservationId);
      if (existing !== undefined) {
        if (
          existing !== admissionClass ||
          canonicalize(state.queuedWorkloads.get(reservationId)) !== canonicalize(workload)
        ) {
          throw new TypeError("Queued reservation changed admission contract");
        }
        return { kind: "return", value: undefined };
      }
      if (state.reservations.has(reservationId)) {
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [governorRecord({
          t: "queued",
          reservationId,
          admissionClass,
          workload,
        })],
        value: undefined,
      };
    });
  }

  async prepareAssignmentRoot<E extends "conversation" | "job">(
    request: AssignmentReservationRequest<E>,
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<AssignmentResourceLease<E>> {
    validateReservationOrigin(origin);
    this.#guard.assert(ctx.principal, "reservation.prepareAssignmentRoot");
    assertAssignmentReservationRequest(request);
    requireIdentifier(ctx.requestId, "Reservation requestId");
    deadlineFromContext(ctx, this.#clock(), this.#monotonicClock());
    const reservationId = assignmentReservationId(request.assignmentId);
    return this.#waitForCandidate(reservationId, ctx, () =>
      this.#prepareCandidate(
        reservationId,
        origin.admissionClass,
        (lease) =>
          canonicalize({
            workload: lease.workload,
            scopeBinding: lease.scopeBinding,
            audience: lease.audience,
            budget: lease.budget,
            activation: "activation" in lease ? lease.activation : undefined,
          }) === canonicalize({
            workload: request.workload,
            scopeBinding: request.scopeBinding,
            audience: { executorId: request.executorId },
            budget: request.budget,
            activation: { kind: "assignment", assignmentId: request.assignmentId },
          }),
        () => this.#signLease({
          reservationId,
          admissionClass: origin.admissionClass,
          workload: request.workload,
          scopeBinding: request.scopeBinding,
          audience: { executorId: request.executorId },
          budget: request.budget,
          domain: { kind: "anchor", anchorEpoch: this.#anchorEpoch },
          delegation: {
            executorId: request.executorId,
            maxDepth: 1,
            maxBudget: request.budget,
          },
          activation: { kind: "assignment", assignmentId: request.assignmentId },
        }) as AssignmentResourceLease<E>,
      )
    );
  }

  async prepareSystemJobRoot(
    request: SystemJobReservationRequest,
    origin: SystemJobReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<SystemJobResourceLease> {
    const validatedOrigin = validateSystemJobReservationOrigin(origin);
    this.#guard.assert(ctx.principal, "reservation.prepareSystemJobRoot");
    assertSystemJobReservationRequest(request);
    requireIdentifier(ctx.requestId, "Reservation requestId");
    deadlineFromContext(ctx, this.#clock(), this.#monotonicClock());
    const reservationId = systemReservationId(request.workload.id, request.workload.attempt);
    return this.#waitForCandidate(reservationId, ctx, () =>
      this.#prepareCandidate(
        reservationId,
        validatedOrigin.admissionClass,
        (lease) =>
          lease.workload.kind === "job" &&
          canonicalize({
            workload: lease.workload,
            scopeBinding: lease.scopeBinding,
            audience: lease.audience,
            budget: lease.budget,
            activation: "activation" in lease ? lease.activation : undefined,
          }) === canonicalize({
            workload: request.workload,
            scopeBinding: request.scopeBinding,
            audience: { executorId: this.#localExecutorId },
            budget: request.budget,
            activation: { kind: "system-job", jobRunId: request.workload.id },
          }),
        () => this.#signLease({
          reservationId,
          admissionClass: validatedOrigin.admissionClass,
          workload: request.workload,
          scopeBinding: request.scopeBinding,
          audience: { executorId: this.#localExecutorId },
          budget: request.budget,
          domain: { kind: "anchor", anchorEpoch: this.#anchorEpoch },
          activation: { kind: "system-job", jobRunId: request.workload.id },
        }) as SystemJobResourceLease,
      )
    );
  }

  async acquireRoot(
    workload: ImmediateRootWorkload,
    budget: ResourceLease["budget"],
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<ImmediateRootResourceLease> {
    const validatedOrigin = validateReservationOrigin(origin);
    this.#guard.assert(ctx.principal, "reservation.acquireRoot");
    assertResourceAdmissionRequest(workload, budget);
    requireIdentifier(ctx.requestId, "Reservation requestId");
    deadlineFromContext(ctx, this.#clock(), this.#monotonicClock());
    const reservationId = immediateReservationId(workload);
    await this.#enqueue(reservationId, workload, validatedOrigin.admissionClass);
    try {
      return await this.#waitForCandidate(
        reservationId,
        ctx,
        () => this.#acquireImmediateRoot(
            reservationId,
            validatedOrigin.admissionClass,
            (candidate) =>
              canonicalize({
                workload: candidate.workload,
                scopeBinding: candidate.scopeBinding,
                audience: candidate.audience,
                budget: candidate.budget,
              }) === canonicalize({
                workload,
                scopeBinding: { kind: "control", subject: workload.id },
                audience: { executorId: this.#localExecutorId },
                budget,
              }),
            () => this.#signLease({
              reservationId,
              admissionClass: validatedOrigin.admissionClass,
              workload,
              scopeBinding: { kind: "control", subject: workload.id },
              audience: { executorId: this.#localExecutorId },
              budget,
              domain: { kind: "anchor", anchorEpoch: this.#anchorEpoch },
            }) as ImmediateRootResourceLease,
          ),
      );
    } catch (error) {
      if (error instanceof ResourceAdmissionDeferredError) {
        await this.#dequeue(workload, "expired");
        throw new ResourceAdmissionExpiredError(reservationId);
      }
      // control 根无业务终态记录承接队列项——签发/事务失败也必须精确出队，防止队首污染
      await this.#dequeue(workload, "failed");
      throw error;
    }
  }

  async acquireChild(
    parent: ResourceLease,
    workload: ChildResourceLease["workload"],
    budget: ResourceLease["budget"],
    ctx: AuthorityCallContext,
  ): Promise<ChildResourceLease> {
    const validatedParent = validateReservableResourceLease(parent, this.#verifier);
    assertBudgetWithinBudget(budget, validatedParent.budget);
    const reservationId = childReservationId(parent.reservationId, workload);
    return this.#withAuthorizedResourceCall(
      validatedParent,
      ctx,
      "reservation.acquireChild",
      (state) => {
        const current = state.reservations.get(validatedParent.reservationId);
        if (
          !current ||
          canonicalize(current.lease) !== canonicalize(validatedParent)
        ) {
          throw new TypeError("Parent resource lease differs from its durable activation");
        }
        const existing = state.reservations.get(reservationId);
        if (existing) {
          if (
            existing.lease.parentId !== validatedParent.reservationId ||
            canonicalize(existing.lease.workload) !== canonicalize(workload) ||
            canonicalize(existing.lease.budget) !== canonicalize(budget)
          ) {
            throw new TypeError("Child resource reservation conflicts with its durable lease");
          }
          return { kind: "return", value: existing.lease as ChildResourceLease };
        }
        if (current.state !== "active") {
          throw new TypeError("Parent resource lease is not durably active");
        }
        const root = state.reservations.get(current.rootReservationId);
        if (!root || root.depth !== 0) {
          throw new TypeError("Parent resource lease has no durable root");
        }
        const executorId = root.lease.domain.kind === "anchor"
          ? root.lease.delegation?.executorId
          : root.lease.audience.executorId;
        if (!executorId) {
          throw new TypeError("Resource root does not authorize child issuance");
        }
        if (root.lease.delegation) {
          assertBudgetWithinBudget(
            budget,
            root.lease.delegation.maxBudget,
            "Delegated child budget",
          );
        }
        const lease = this.#signLease({
          reservationId,
          parentId: validatedParent.reservationId,
          parentDigest: validatedParent.digest,
          admissionClass: validatedParent.admissionClass,
          workload,
          scopeBinding: validatedParent.scopeBinding,
          audience: { executorId },
          budget,
          domain: validatedParent.domain,
          expiry: validatedParent.expiry,
        }) as ChildResourceLease;
        return {
          kind: "append",
          entries: [governorRecord({ t: "reserve", lease })],
          value: lease,
        };
      },
    );
  }

  async consume(
    lease: ResourceLease,
    usage: {
      usageId: string;
      tokens?: number;
      calls?: number;
      costMinor?: number;
    },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    const validated = validateReservableResourceLease(lease, this.#verifier);
    requireIdentifier(usage.usageId, "Resource usageId");
    resourceBudgetUsage(usage);
    await this.#withAuthorizedResourceCall<void>(
      validated,
      ctx,
      "reservation.consume",
      (state) => {
      const reservation = state.reservations.get(validated.reservationId);
      if (!reservation || canonicalize(reservation.lease) !== canonicalize(validated)) {
        throw new TypeError("Resource lease differs from its durable activation");
      }
      const existing = state.usages.get(usage.usageId);
      if (existing) {
        const normalized = resourceBudgetUsage(usage);
        if (
          existing.reservationId !== validated.reservationId ||
          canonicalize(existing.usage) !== canonicalize(normalized)
        ) {
          throw new TypeError("Resource usage id was reused with different content");
        }
        return { kind: "return", value: undefined };
      }
      if (reservation.state !== "active") {
        throw new TypeError("Resource lease is not durably active");
      }
      const usageSeq = state.nextUsageSeqByRoot.get(reservation.rootReservationId) ?? 1;
      return {
        kind: "append",
        entries: [governorRecord({
          t: "consume",
          usageSeq,
          rootReservationId: reservation.rootReservationId,
          reservationId: validated.reservationId,
          usageId: usage.usageId,
          ...(usage.tokens === undefined ? {} : { tokens: usage.tokens }),
          ...(usage.calls === undefined ? {} : { calls: usage.calls }),
          ...(usage.costMinor === undefined ? {} : { costMinor: usage.costMinor }),
        })],
        value: undefined,
      };
      },
    );
  }

  async reserveUsage(
    lease: ResourceLease,
    usage: {
      usageId: string;
      tokens?: number;
      calls?: number;
      costMinor?: number;
    },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    const validated = validateReservableResourceLease(lease, this.#verifier);
    const normalized = resourceBudgetUsage(usage);
    requireIdentifier(usage.usageId, "Reserved resource usageId");
    await this.#withAuthorizedResourceCall<void>(
      validated,
      ctx,
      "reservation.reserveUsage",
      (state) => {
        const reservation = state.reservations.get(validated.reservationId);
        if (!reservation || canonicalize(reservation.lease) !== canonicalize(validated)) {
          throw new TypeError("Resource lease differs from its durable activation");
        }
        const existing = state.usageReservations.get(usage.usageId);
        if (existing) {
          if (
            existing.rootReservationId !== reservation.rootReservationId ||
            existing.reservationId !== validated.reservationId ||
            canonicalize(existing.usage) !== canonicalize(normalized)
          ) {
            throw new TypeError("Resource usage reservation id was reused with different content");
          }
          return { kind: "return", value: undefined };
        }
        if (reservation.state !== "active") {
          throw new TypeError("Resource lease is not durably active");
        }
        return {
          kind: "append",
          entries: [governorRecord({
            t: "usage-reserved",
            rootReservationId: reservation.rootReservationId,
            reservationId: validated.reservationId,
            usageId: usage.usageId,
            ...(usage.tokens === undefined ? {} : { tokens: usage.tokens }),
            ...(usage.calls === undefined ? {} : { calls: usage.calls }),
            ...(usage.costMinor === undefined ? {} : { costMinor: usage.costMinor }),
          })],
          value: undefined,
        };
      },
    );
  }

  async settle(lease: ResourceLease, ctx: AuthorityCallContext): Promise<void> {
    const validated = validateReservableResourceLease(lease, this.#verifier);
    await this.#withAuthorizedResourceCall(
      validated,
      ctx,
      "reservation.settle",
      (state) => terminalDecision(state, validated, "settle"),
    );
  }

  async release(lease: ResourceLease, ctx: AuthorityCallContext): Promise<void> {
    const validated = validateReservableResourceLease(lease, this.#verifier);
    await this.#withAuthorizedResourceCall(
      validated,
      ctx,
      "reservation.release",
      (state) => terminalDecision(state, validated, "release"),
    );
  }

  async reclaim(lease: ResourceLease): Promise<void> {
    await this.#terminal(lease, "reclaim");
  }

  async reclaimExpired(): Promise<number> {
    canonicalTime(this.#clock(), "Anchor resource reclaim time");
    return this.#transact<number>((state) => {
      const expiring = [...state.reservations.values()]
        .filter((reservation) =>
          (reservation.state === "active" || reservation.state === "settled") &&
          !isBusinessOwnedResourceReservation(state, reservation) &&
          this.#leaseIsExpired(state, reservation.lease));
      const expiringIds = new Set(
        expiring.map((reservation) => reservation.lease.reservationId),
      );
      const expiringRoots = new Set(
        expiring
          .filter((reservation) => reservation.depth === 0)
          .map((reservation) => reservation.rootReservationId),
      );
      const entries = conservativeUsageConsumptionRecords(state, {
        rootReservationIds: expiringRoots,
        reservationIds: expiringIds,
      })
        .map(governorRecord);
      for (const reservation of expiring.sort((left, right) => right.depth - left.depth)) {
        entries.push(governorRecord({
          t: reservation.state === "settled" ? "release" : "reclaim",
          reservationId: reservation.lease.reservationId,
        }));
      }
      return entries.length === 0
        ? { kind: "return", value: 0 }
        : { kind: "append", entries, value: expiring.length };
    });
  }

  async submitUsageReport(
    report: UsageReport,
    ctx: AuthorityCallContext,
  ): Promise<{ ackedThroughSeq: number }> {
    this.#guard.assert(ctx.principal, "governor.submitUsageReport");
    if (ctx.principal.kind !== "usage-reporter") {
      throw new TypeError("Usage report requires a usage-reporter principal");
    }
    const validated = validateUsageReport(report, this.#verifier);
    if (
      validated.reporterId !== ctx.principal.executorId ||
      validated.signature.keyId !== this.#reporterKeyFor(validated.reporterId)
    ) {
      throw new TypeError("Usage report does not bind the authenticated reporter");
    }
    return this.#transact((state) => {
      const root = state.reservations.get(validated.rootReservationId);
      if (!root || root.rootReservationId !== validated.rootReservationId) {
        throw new TypeError("Usage report root is not active in this governor");
      }
      if (
        root.lease.audience.executorId !== validated.reporterId ||
        (root.lease.delegation !== undefined &&
          root.lease.delegation.executorId !== validated.reporterId)
      ) {
        throw new TypeError("Usage report root belongs to another executor");
      }
      assertUsageReportWorkload(root.lease, validated);
      const expected = state.nextUsageSeqByRoot.get(validated.rootReservationId) ?? 1;
      if (validated.fromUsageSeq > expected) {
        throw new TypeError("Usage report contains a sequence gap");
      }
      const entries: LogicalRecord<GovernorRecord>[] = [];
      for (const usage of validated.usages) {
        if (usage.usageSeq < expected) {
          const existing = state.usages.get(usage.usageId);
          const normalized = resourceBudgetUsage(usage);
          if (
            !existing ||
            existing.rootReservationId !== validated.rootReservationId ||
            existing.reservationId !== usage.reservationId ||
            existing.usageSeq !== usage.usageSeq ||
            canonicalize(existing.usage) !== canonicalize(normalized)
          ) {
            throw new TypeError("Usage report overlaps a different durable usage");
          }
          continue;
        }
        const reservation = state.reservations.get(usage.reservationId);
        if (reservation !== undefined && (
          reservation.rootReservationId !== validated.rootReservationId ||
          reservation.lease.audience.executorId !== validated.reporterId
        )) {
          throw new TypeError("Usage report entry belongs to another reservation domain");
        }
        if (
          reservation === undefined &&
          root.lease.delegation?.executorId !== validated.reporterId
        ) {
          throw new TypeError("Usage report entry is outside the delegated resource domain");
        }
        entries.push(governorRecord({
          t: "usage-reserved",
          rootReservationId: validated.rootReservationId,
          reservationId: usage.reservationId,
          usageId: usage.usageId,
          ...(usage.tokens === undefined ? {} : { tokens: usage.tokens }),
          ...(usage.calls === undefined ? {} : { calls: usage.calls }),
          ...(usage.costMinor === undefined ? {} : { costMinor: usage.costMinor }),
        }), governorRecord({
          t: "consume",
          usageSeq: usage.usageSeq,
          rootReservationId: validated.rootReservationId,
          reservationId: usage.reservationId,
          usageId: usage.usageId,
          ...(usage.tokens === undefined ? {} : { tokens: usage.tokens }),
          ...(usage.calls === undefined ? {} : { calls: usage.calls }),
          ...(usage.costMinor === undefined ? {} : { costMinor: usage.costMinor }),
        }));
      }
      if (
        entries.length > 0 &&
        (root.state !== "active" || this.#leaseIsExpired(state, root.lease))
      ) {
        throw new TypeError("Usage report cannot extend an inactive or expired resource root");
      }
      return entries.length === 0
        ? { kind: "return", value: { ackedThroughSeq: expected - 1 } }
        : {
            kind: "append",
            entries,
            value: { ackedThroughSeq: validated.toUsageSeq },
          };
    });
  }

  prepareActivation(
    lease: AssignmentResourceLease,
  ): readonly LogicalRecord<GovernorRecord>[] {
    const validated = validateReservableResourceLease(lease, this.#verifier);
    this.#validateLeaseAcceptance(validated, this.#clock());
    this.#assertCurrentCandidate(validated);
    const records = [governorRecord({ t: "reserve", lease: validated })];
    this.#preflight(records);
    return records;
  }

  prepareQueuedTerminal(input: {
    readonly workload: RootResourceWorkload;
    readonly reason: Extract<GovernorRecord, { t: "dequeue" }>["reason"];
  }): readonly LogicalRecord<GovernorRecord>[] {
    const records = [queuedTerminalDequeueRecord(input.workload, input.reason)];
    this.#preflight(records);
    return records;
  }

  prepareTerminal(input: {
    readonly lease: AssignmentResourceLease;
    readonly mode: "settle-release" | "release" | "reclaim";
  }): readonly LogicalRecord<GovernorRecord>[] {
    const records = terminalRecords(input.lease.reservationId, input.mode);
    this.#preflight(records);
    return records;
  }

  assertUsageFinal(input: {
    readonly reservationId: string;
    readonly assignmentId: string;
    readonly executorId: string;
    readonly usageFinal: {
      readonly reportDigest: string;
      readonly upToUsageSeq: number;
    };
  }): void {
    const state = this.#projection?.state;
    if (!state) throw new Error("Resource governor projection is unavailable");
    const root = state.reservations.get(input.reservationId);
    if (!root || root.depth !== 0) {
      throw new TypeError("Final usage has no matching resource root");
    }
    const lease = validateReservableResourceLease(root.lease, this.#verifier);
    const activation = "activation" in lease ? lease.activation : undefined;
    if (
      activation?.kind !== "assignment" ||
      activation.assignmentId !== input.assignmentId ||
      lease.audience.executorId !== input.executorId
    ) {
      throw new TypeError("Final usage does not bind the assignment resource root");
    }
    const durableWatermark =
      (state.nextUsageSeqByRoot.get(input.reservationId) ?? 1) - 1;
    if (input.usageFinal.upToUsageSeq !== durableWatermark) {
      throw new TypeError("Final usage watermark does not match durable usage");
    }
    const expectedDigest = durableWatermark === 0
      ? protocolDigest("AssignmentUsageFinal", 1, {
          assignmentId: input.assignmentId,
          upToUsageSeq: 0,
        })
      : usageReportDigestAtWatermark(
          state,
          lease,
          input.assignmentId,
          durableWatermark,
        );
    if (input.usageFinal.reportDigest !== expectedDigest) {
      throw new TypeError("Final usage report digest does not match durable usage");
    }
  }

  async prepare(input: {
    readonly taskId: string;
    readonly jobRunId: string;
    readonly anchorEpoch: number;
    readonly attempt: number;
  }): Promise<{
    readonly lease: SystemJobResourceLease;
    readonly records: readonly LogicalRecord<unknown>[];
  }> {
    if (input.anchorEpoch !== this.#anchorEpoch) {
      throw new TypeError("System job belongs to another anchor epoch");
    }
    const origin: SystemJobReservationOrigin = {
      admissionClass: "scheduler",
      entry: "schedule-trigger",
    };
    const ctx = internalHostContext("reservation.prepareSystemJobRoot", this.#clock());
    const reservationId = systemReservationId(input.jobRunId, input.attempt);
    const workload = { kind: "job", id: input.jobRunId, attempt: input.attempt } as const;
    await this.enqueueRoot(reservationId, workload, origin, ctx);
    const lease = await this.prepareSystemJobRoot({
      workload,
      scopeBinding: {
        kind: "job",
        taskId: input.taskId,
        anchorEpoch: input.anchorEpoch,
      },
      budget: { maxCalls: 1 },
    }, origin, ctx);
    const records = [governorRecord({ t: "reserve", lease })];
    this.#preflight(records);
    return { lease, records };
  }

  async recover(input: {
    readonly fence: import("@zhixing/core/contracts").SystemJobFence;
  }): Promise<
    | { readonly kind: "reuse"; readonly lease: SystemJobResourceLease }
    | {
        readonly kind: "replace";
        readonly lease: SystemJobResourceLease;
        readonly records: readonly LogicalRecord<unknown>[];
      }
  > {
    const state = await this.#state();
    const current = state.reservations.get(input.fence.reservationId);
    if (!current) throw new TypeError("System job fence has no resource reservation");
    const lease = current.lease as SystemJobResourceLease;
    if (current.state === "active" && !this.#leaseIsExpired(state, lease)) {
      return { kind: "reuse", lease };
    }
    if (current.state !== "active") {
      throw new TypeError("Running system job has a terminal resource reservation");
    }
    const nextAttempt = input.fence.attempt + 1;
    const prepared = await this.prepare({
      taskId: input.fence.taskId,
      jobRunId: input.fence.jobRunId,
      anchorEpoch: input.fence.anchorEpoch,
      attempt: nextAttempt,
    });
    const preparedRecords = governorRecords(prepared.records, this.#verifier);
    if (preparedRecords.length !== prepared.records.length) {
      throw new TypeError("Prepared system job resources contain a foreign record");
    }
    const records: readonly LogicalRecord<GovernorRecord>[] = [
      governorRecord({ t: "reclaim", reservationId: lease.reservationId }),
      ...preparedRecords,
    ];
    this.#preflight(records);
    return {
      kind: "replace",
      lease: prepared.lease,
      records,
    };
  }

  terminal(input: {
    readonly lease: SystemJobResourceLease;
    readonly outcome: "committed" | "failed";
  }): readonly LogicalRecord<unknown>[] {
    void input.outcome;
    const records = terminalRecords(input.lease.reservationId, "settle-release");
    this.#preflight(records);
    return records;
  }

  assertActivationRecords(input: {
    readonly previousFence?: import("@zhixing/core/contracts").SystemJobFence;
    readonly fence: import("@zhixing/core/contracts").SystemJobFence;
    readonly records: readonly LogicalRecord<unknown>[];
  } | {
    readonly lease: AssignmentResourceLease;
    readonly records: readonly LogicalRecord<unknown>[];
    readonly acceptedAt?: string;
  }): void {
    if ("lease" in input) {
      const lease = validateReservableResourceLease(input.lease, this.#verifier);
      this.#validateLeaseAcceptance(lease, input.acceptedAt ?? this.#clock());
      assertExactGovernorRecords(
        input.records,
        [governorRecord({ t: "reserve", lease })],
        "Assignment resource activation",
        this.#verifier,
      );
      return;
    }
    const expected = governorRecords(input.records, this.#verifier);
    const reserve = expected.find(
      (record): record is LogicalRecord<Extract<GovernorRecord, { t: "reserve" }>> =>
        record.body.t === "reserve",
    );
    if (!reserve || reserve.body.lease.reservationId !== input.fence.reservationId) {
      throw new TypeError("System job activation lacks its exact reserve record");
    }
    const lease = validateReservableResourceLease(reserve.body.lease, this.#verifier);
    const required: LogicalRecord<GovernorRecord>[] = [];
    if (input.previousFence) {
      required.push(governorRecord({
        t: "reclaim",
        reservationId: input.previousFence.reservationId,
      }));
    }
    required.push(governorRecord({ t: "reserve", lease }));
    assertExactGovernorRecords(
      input.records,
      required,
      "System job resource activation",
      this.#verifier,
    );
  }

  preflightActivationRecords(input: {
    readonly previousFence?: import("@zhixing/core/contracts").SystemJobFence;
    readonly fence: import("@zhixing/core/contracts").SystemJobFence;
    readonly records: readonly LogicalRecord<unknown>[];
  }): void {
    this.assertActivationRecords(input);
    const records = governorRecords(input.records, this.#verifier);
    const reserve = records.find(
      (record): record is LogicalRecord<Extract<GovernorRecord, { t: "reserve" }>> =>
        record.body.t === "reserve",
    );
    if (!reserve) throw new TypeError("System job activation has no reserve record");
    this.#assertCurrentCandidate(
      validateReservableResourceLease(reserve.body.lease, this.#verifier),
    );
    this.#preflight(records);
  }

  preflightTerminalRecords(input: {
    readonly fence: import("@zhixing/core/contracts").SystemJobFence;
    readonly outcome: "committed" | "failed";
    readonly records: readonly LogicalRecord<unknown>[];
  }): void {
    this.assertTerminalRecords(input);
    this.#preflight(governorRecords(input.records, this.#verifier));
  }

  assertTerminalRecords(input: {
    readonly fence: import("@zhixing/core/contracts").SystemJobFence;
    readonly outcome: "committed" | "failed";
    readonly records: readonly LogicalRecord<unknown>[];
  } | {
    readonly reservationId: string;
    readonly mode: "settle-release" | "release" | "reclaim";
    readonly records: readonly LogicalRecord<unknown>[];
  }): void {
    if ("reservationId" in input) {
      assertExactGovernorRecords(
        input.records,
        terminalRecords(input.reservationId, input.mode),
        "Assignment resource terminal",
        this.#verifier,
      );
      return;
    }
    void input.outcome;
    assertExactGovernorRecords(
      input.records,
      terminalRecords(input.fence.reservationId, "settle-release"),
      "System job resource terminal",
      this.#verifier,
    );
  }

  async snapshot(): Promise<GovernorProjection> {
    return cloneGovernorProjection(await this.#state());
  }

  #preflight(entries: readonly LogicalRecord<GovernorRecord>[]): void {
    const current = this.#projection?.state;
    if (!current) throw new Error("Resource governor projection is unavailable");
    let candidate = cloneGovernorProjection(current);
    for (const entry of entries) {
      if (entry.stream !== GOVERNOR_STREAM) {
        throw new TypeError("Anchor governor transaction contains a foreign stream");
      }
      candidate = applyGovernorRecord(candidate, entry.body, this.#verifier);
    }
  }

  async #acquireImmediateRoot(
    reservationId: string,
    admissionClass: AdmissionClass,
    matches: (lease: ImmediateRootResourceLease) => boolean,
    create: () => ImmediateRootResourceLease,
  ): Promise<ImmediateRootResourceLease> {
    return this.#transact<ImmediateRootResourceLease>((state) => {
      const existing = state.reservations.get(reservationId);
      if (existing) {
        if (
          existing.depth !== 0 ||
          existing.lease.admissionClass !== admissionClass ||
          existing.lease.workload.kind !== "control" ||
          !matches(existing.lease as ImmediateRootResourceLease)
        ) {
          throw new TypeError("Immediate resource retry changed its frozen request");
        }
        return {
          kind: "return",
          value: existing.lease as ImmediateRootResourceLease,
        };
      }
      if (state.queued.get(reservationId) !== admissionClass) {
        throw new TypeError("Immediate resource root is not durably queued");
      }
      const selected = selectFairReservation(
        cloneGovernorProjection(state),
        new Set(this.#candidates.keys()),
      );
      if (
        selected?.reservationId !== reservationId ||
        selected.admissionClass !== admissionClass
      ) {
        throw new ResourceAdmissionPendingError(reservationId);
      }
      const lease = create();
      this.#validateLeaseAcceptance(lease, this.#clock());
      return {
        kind: "append",
        entries: [governorRecord({ t: "reserve", lease })],
        value: lease,
      };
    });
  }

  async #terminal(lease: ResourceLease, kind: "settle" | "release" | "reclaim"): Promise<void> {
    const validated = validateReservableResourceLease(lease, this.#verifier);
    await this.#transact<void>((state) => {
      const current = state.reservations.get(validated.reservationId);
      if (!current || canonicalize(current.lease) !== canonicalize(validated)) {
        throw new TypeError("Resource terminal action has no matching durable lease");
      }
      const target = kind === "settle" ? "settled" : kind === "release" ? "released" : "reclaimed";
      if (current.state === target) return { kind: "return", value: undefined };
      return {
        kind: "append",
        entries: [governorRecord({ t: kind, reservationId: validated.reservationId })],
        value: undefined,
      };
    });
  }

  async #prepareCandidate<Lease extends RootResourceCandidate>(
    reservationId: string,
    admissionClass: AdmissionClass,
    matches: (lease: RootResourceCandidate) => boolean,
    create: () => Lease,
  ): Promise<Lease> {
    return this.#operations.run(async () => {
      await this.#synchronizeUnlocked();
      this.#pruneCandidates();
      const state = this.#projection!.state;
      const active = state.reservations.get(reservationId);
      if (active) {
        if (
          active.depth !== 0 ||
          active.state !== "active" ||
          active.lease.admissionClass !== admissionClass ||
          !matches(active.lease as RootResourceCandidate)
        ) {
          throw new TypeError("Resource candidate retry changed its frozen request");
        }
        return active.lease as Lease;
      }
      if (state.queued.get(reservationId) !== admissionClass) {
        throw new TypeError("Resource candidate is not durably queued");
      }
      const occupied = this.#candidates.get(admissionClass);
      if (occupied) {
        if (occupied.lease.reservationId !== reservationId) {
          throw new ResourceAdmissionPendingError(reservationId);
        }
        if (!matches(occupied.lease)) {
          throw new TypeError("Resource candidate retry changed its frozen request");
        }
        return occupied.lease as Lease;
      }
      const selected = selectFairReservation(
        cloneGovernorProjection(state),
        new Set(this.#candidates.keys()),
      );
      if (
        selected?.reservationId !== reservationId ||
        selected.admissionClass !== admissionClass
      ) {
        throw new ResourceAdmissionPendingError(reservationId);
      }
      const lease = create();
      this.#candidates.set(admissionClass, {
        lease,
        expiresAt: this.#monotonicClock() + this.#candidateTtlMs,
      });
      return lease;
    });
  }

  async #waitForCandidate<Lease>(
    reservationId: string,
    ctx: AuthorityCallContext,
    attempt: () => Promise<Lease>,
  ): Promise<Lease> {
    return waitForResourceAdmissionCandidate({
      attempt,
      isPending: (error) => error instanceof ResourceAdmissionPendingError,
      deadline: deadlineFromContext(
        ctx,
        this.#clock(),
        this.#monotonicClock(),
      ),
      monotonicClock: this.#monotonicClock,
      onDeadline: () => {
        throw new ResourceAdmissionDeferredError(reservationId);
      },
    });
  }

  #assertCurrentCandidate(
    lease: ResourceLease,
    state = this.#projection?.state,
  ): void {
    if (!state) throw new Error("Resource governor projection is unavailable");
    this.#pruneCandidates();
    if (state.queued.get(lease.reservationId) !== lease.admissionClass) {
      throw new TypeError("Resource reservation is not queued in its admission class");
    }
    const candidate = this.#candidates.get(lease.admissionClass);
    if (
      !candidate ||
      candidate.lease.reservationId !== lease.reservationId ||
      candidate.lease.digest !== lease.digest
    ) {
      throw new TypeError("Resource activation does not match the live candidate");
    }
  }

  #pruneCandidates(): void {
    const state = this.#projection?.state;
    const now = this.#monotonicClock();
    for (const [admissionClass, candidate] of this.#candidates) {
      if (
        candidate.expiresAt <= now ||
        state?.queued.get(candidate.lease.reservationId) !== admissionClass
      ) {
        this.#candidates.delete(admissionClass);
      }
    }
    for (const reservationId of this.#leaseDeadlines.keys()) {
      const reservation = state?.reservations.get(reservationId);
      if (
        !reservation ||
        (reservation.state !== "active" && reservation.state !== "settled")
      ) {
        this.#leaseDeadlines.delete(reservationId);
      }
    }
    for (const [capId, deadline] of this.#capabilityDeadlines) {
      const root = state?.reservations.get(deadline.rootReservationId);
      if (!root || (root.state !== "active" && root.state !== "settled")) {
        this.#capabilityDeadlines.delete(capId);
      }
    }
  }

  async #dequeue(
    workload: RootResourceWorkload,
    reason: Extract<GovernorRecord, { t: "dequeue" }>["reason"],
  ): Promise<void> {
    await this.#transact<void>((state) => {
      const workloadKey = rootResourceWorkloadKey(workload);
      if (
        [...state.reservations.values()].some(
          (reservation) =>
            reservation.depth === 0 &&
            (reservation.state === "active" || reservation.state === "settled") &&
            rootResourceWorkloadKey(reservation.lease.workload as RootResourceWorkload) ===
              workloadKey,
        )
      ) {
        return { kind: "return", value: undefined };
      }
      const existing = state.dequeued.get(workloadKey);
      if (existing !== undefined) {
        if (existing !== reason) {
          throw new TypeError("Resource workload was dequeued for another reason");
        }
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [governorRecord({
          t: "dequeue",
          workload: structuredClone(workload),
          reason,
        })],
        value: undefined,
      };
    });
  }

  #signLease(input: Omit<ResourceLease, "digest" | "issuedAt" | "expiry" | "signature" | "v"> & {
    readonly expiry?: string;
    readonly activation?: unknown;
  }): ResourceLease {
    const issuedAt = canonicalTime(this.#clock(), "Resource lease issue time");
    const expiry = input.expiry ?? new Date(Date.parse(issuedAt) + this.#leaseTtlMs).toISOString();
    const payload = {
      v: 1 as const,
      ...input,
      issuedAt,
      expiry,
    };
    const withDigest = {
      ...payload,
      digest: protocolDigest("ResourceLease", 1, payload),
    };
    return {
      ...withDigest,
      signature: this.#signer.sign("ResourceLease", 1, withDigest),
    } as ResourceLease;
  }

  async #state(): Promise<GovernorProjection> {
    await this.#synchronizeUnlocked();
    return this.#projection!.state;
  }

  async #withAuthorizedResourceCall<Value>(
    lease: ResourceLease,
    ctx: AuthorityCallContext,
    method:
      | "reservation.acquireChild"
      | "reservation.reserveUsage"
      | "reservation.consume"
      | "reservation.settle"
      | "reservation.release",
    decide: (
      state: GovernorProjection,
    ) =>
      | { readonly kind: "return"; readonly value: Value }
      | {
          readonly kind: "append";
          readonly entries: readonly LogicalRecord<GovernorRecord>[];
          readonly value: Value;
        },
  ): Promise<Value> {
    return this.#operations.run(async () => {
      await this.#synchronizeUnlocked();
      const state = this.#projection?.state;
      if (!state) throw new Error("Anchor resource projection is unavailable");
      this.#guard.assert(ctx.principal, method);
      const reservation = state.reservations.get(lease.reservationId);
      const root = reservation && state.reservations.get(reservation.rootReservationId);
      const assignmentRoot = root &&
        "activation" in root.lease &&
        root.lease.activation.kind === "assignment";
      let activation:
        | {
            readonly acceptedCapIds: ReadonlySet<string>;
            readonly activeCapIds: ReadonlySet<string>;
            readonly acceptedAt: string;
          }
        | undefined;
      if (assignmentRoot && ctx.principal.kind !== "assignment") {
        throw new TypeError("Assignment resource calls require the activated assignment principal");
      }
      if (ctx.principal.kind === "assignment") {
        if (!reservation || !assignmentRoot) {
          throw new TypeError("Assignment resource call has no durable root activation");
        }
        activation = await this.#assignedCapabilityActivation(
          root.lease as AssignmentResourceLease,
        );
        assertAcceptedResourceCapabilityBinding({
          context: ctx,
          method,
          rootLease: root.lease as AssignmentResourceLease,
          acceptedCapIds: activation.acceptedCapIds,
          verifier: this.#verifier,
        });
      }
      const preview = decide(state);
      if (preview.kind === "return") return preview.value;
      this.#assertLeaseDeadline(state, lease, ctx.deadlineAt);
      if (ctx.principal.kind === "assignment") {
        if (!root || !activation) {
          throw new Error("Assignment resource root disappeared during authorization");
        }
        const rootLease = root.lease as AssignmentResourceLease;
        assertActivatedResourceCapability({
          context: ctx,
          method,
          rootLease,
          activeCapIds: activation.activeCapIds,
          verifier: this.#verifier,
          now: activation.acceptedAt,
        });
        this.#assertCapabilityDeadline(
          ctx.principal.capability,
          activation.acceptedAt,
          rootLease.reservationId,
        );
      }
      return this.#transactUnlocked(decide);
    });
  }

  async #assignedCapabilityActivation(
    lease: AssignmentResourceLease,
  ): Promise<{
    readonly acceptedCapIds: ReadonlySet<string>;
    readonly activeCapIds: ReadonlySet<string>;
    readonly acceptedAt: string;
  }> {
    const assignmentId = lease.activation.assignmentId;
    const scope = lease.scopeBinding;
    const stream = scope.kind === "conversation"
      ? `run:${scope.conversationId}`
      : scope.kind === "job"
        ? `job:${scope.taskId}`
        : undefined;
    if (!stream) {
      throw new TypeError("Assignment resource root has an invalid authority scope");
    }
    const records = await this.#log.readStream<unknown>(stream);
    let assignedCapIds: readonly string[] | undefined;
    let acceptedAt: string | undefined;
    const revoked = new Set<string>();
    for (const record of records) {
      const body = asRecord(record.body);
      if (
        body?.t === "assigned" &&
        body.assignmentId === assignmentId &&
        body.executorId === lease.audience.executorId &&
        asRecord(body.reservation)?.reservationId === lease.reservationId &&
        Array.isArray(body.capIds) &&
        body.capIds.every((capId) => typeof capId === "string")
      ) {
        assignedCapIds = body.capIds as string[];
        acceptedAt = record.at;
      }
      if (
        body?.t === "capability-revoked" &&
        body.assignmentId === assignmentId &&
        typeof body.capId === "string"
      ) {
        revoked.add(body.capId);
      }
    }
    if (!assignedCapIds || !acceptedAt) {
      throw new TypeError("Assignment resource capability has no durable assigned activation");
    }
    return {
      acceptedCapIds: new Set(assignedCapIds),
      activeCapIds: new Set(assignedCapIds.filter((capId) => !revoked.has(capId))),
      acceptedAt,
    };
  }

  #assertCapabilityDeadline(
    capability: AuthorityCapability,
    acceptedAt: string,
    rootReservationId: string,
  ): void {
    const identity = canonicalize(capability);
    const existing = this.#capabilityDeadlines.get(capability.capId);
    if (existing?.identity === identity) {
      if (this.#monotonicClock() >= existing.deadline) {
        throw new TypeError("Assignment resource capability is expired");
      }
      return;
    }
    const now = Date.parse(canonicalTime(this.#clock(), "Resource capability local clock"));
    const accepted = Date.parse(
      canonicalTime(acceptedAt, "Resource capability acceptance time"),
    );
    if (now < accepted) {
      throw new TypeError("Resource capability clock precedes durable activation");
    }
    const validForMs = acceptedRemoteIntervalRemainingMs({
      issuedAt: capability.issuedAt,
      expiry: capability.expiry,
      acceptedAt,
      maxTtlMs: MAX_LEASE_TTL_MS,
    });
    const remaining = validForMs - (now - accepted);
    if (remaining <= 0) {
      throw new TypeError("Assignment resource capability is expired");
    }
    this.#capabilityDeadlines.set(capability.capId, {
      identity,
      deadline: this.#monotonicClock() + remaining,
      rootReservationId,
    });
  }

  #validateLeaseAcceptance(lease: ResourceLease, acceptedAt: string): number {
    return acceptedRemoteIntervalRemainingMs({
      issuedAt: lease.issuedAt,
      expiry: lease.expiry,
      acceptedAt,
      maxTtlMs: MAX_LEASE_TTL_MS,
    });
  }

  #rememberLeaseDeadline(state: GovernorProjection, lease: ResourceLease): void {
    const existing = this.#leaseDeadlines.get(lease.reservationId);
    if (existing?.digest === lease.digest) return;
    const acceptance = state.leaseAcceptances.get(lease.reservationId);
    if (!acceptance || acceptance.leaseDigest !== lease.digest) {
      throw new TypeError("Resource lease has no durable acceptance time");
    }
    const now = Date.parse(canonicalTime(this.#clock(), "Resource governor local clock"));
    const acceptedAt = Date.parse(
      canonicalTime(acceptance.acceptedAt, "Resource lease acceptance time"),
    );
    if (now < acceptedAt) {
      throw new TypeError("Resource governor clock precedes durable lease acceptance");
    }
    const remaining = acceptance.validForMs - (now - acceptedAt);
    if (remaining <= 0) {
      throw new TypeError("Resource lease expired after durable acceptance");
    }
    this.#leaseDeadlines.set(lease.reservationId, {
      digest: lease.digest,
      deadline: this.#monotonicClock() + remaining,
    });
  }

  #assertLeaseDeadline(
    state: GovernorProjection,
    lease: ResourceLease,
    callDeadlineAt: string,
  ): void {
    this.#rememberLeaseDeadline(state, lease);
    const accepted = this.#leaseDeadlines.get(lease.reservationId)!;
    if (accepted.digest !== lease.digest || this.#monotonicClock() >= accepted.deadline) {
      throw new TypeError("Resource lease is expired or replaced");
    }
    if (
      Date.parse(canonicalTime(callDeadlineAt, "Resource call deadline")) >
      Date.parse(canonicalTime(lease.expiry, "Resource lease expiry"))
    ) {
      throw new TypeError("Resource call deadline exceeds lease expiry");
    }
  }

  #leaseIsExpired(state: GovernorProjection, lease: ResourceLease): boolean {
    try {
      this.#rememberLeaseDeadline(state, lease);
    } catch {
      return true;
    }
    return this.#monotonicClock() >= this.#leaseDeadlines.get(lease.reservationId)!.deadline;
  }

  async #synchronizeUnlocked(): Promise<void> {
    const cached = this.#projection;
    const retentionCutoff = this.#retentionCutoff();
    const initial = cached
      ? cloneGovernorProjection(cached.state)
      : emptyGovernorProjection();
    const transaction = await this.#log.transactProjection<GovernorProjection, unknown, void>(
      initial,
      (state, record, envelope) => {
        if (record.stream !== GOVERNOR_STREAM) return state;
        return this.#applyRetainedRecord(
          state,
          record.body,
          envelope.at,
          retentionCutoff,
        );
      },
      () => ({ kind: "return", value: undefined }),
      {
        stream: GOVERNOR_STREAM,
        ...(cached ? { cursor: cached.cursor } : {}),
      },
    );
    this.#projection = {
      state: this.#compactProjection(transaction.state),
      cursor: transaction.cursor,
    };
  }

  async #transact<Value>(
    decide: (
      state: GovernorProjection,
    ) =>
      | { readonly kind: "return"; readonly value: Value }
      | {
          readonly kind: "append";
          readonly entries: readonly LogicalRecord<GovernorRecord>[];
          readonly value: Value;
        },
  ): Promise<Value> {
    return this.#operations.run(() => this.#transactUnlocked(decide));
  }

  async #transactUnlocked<Value>(
    decide: (
      state: GovernorProjection,
    ) =>
      | { readonly kind: "return"; readonly value: Value }
      | {
          readonly kind: "append";
          readonly entries: readonly LogicalRecord<GovernorRecord>[];
          readonly value: Value;
        },
  ): Promise<Value> {
      const cached = this.#projection;
      const retentionCutoff = this.#retentionCutoff();
      const initial = cached
        ? cloneGovernorProjection(cached.state)
        : emptyGovernorProjection();
      const transaction = await this.#log.transactProjection<GovernorProjection, unknown, Value>(
        initial,
        (state, record, envelope) => {
          if (record.stream !== GOVERNOR_STREAM) return state;
          return this.#applyRetainedRecord(
            state,
            record.body,
            envelope.at,
            retentionCutoff,
          );
        },
        (state) => {
          const decision = decide(state);
          if (decision.kind === "return") return decision;
          let candidate = cloneGovernorProjection(state);
          for (const entry of decision.entries) {
            if (entry.stream !== GOVERNOR_STREAM) {
              throw new TypeError("Anchor governor transaction contains a foreign stream");
            }
            candidate = applyGovernorRecord(candidate, entry.body, this.#verifier);
          }
          return decision;
        },
        {
          stream: GOVERNOR_STREAM,
          ...(cached ? { cursor: cached.cursor } : {}),
        },
      );
      this.#projection = {
        state: this.#compactProjection(transaction.state),
        cursor: transaction.cursor,
      };
      this.#pruneCandidates();
      return transaction.value;
  }

  #compactProjection(state: GovernorProjection): GovernorProjection {
    return compactGovernorProjection(state, this.#retentionCutoff());
  }

  #applyRetainedRecord(
    state: GovernorProjection,
    record: unknown,
    envelopeAt: string,
    retentionCutoff: string,
  ): GovernorProjection {
    return compactGovernorProjection(
      applyGovernorRecordAt(
        state,
        record,
        envelopeAt,
        MAX_LEASE_TTL_MS,
        this.#verifier,
      ),
      retentionCutoff,
    );
  }

  #retentionCutoff(): string {
    const now = Date.parse(canonicalTime(this.#clock(), "Resource retention clock"));
    return new Date(now - GOVERNOR_TERMINAL_RETENTION_MS).toISOString();
  }
}

export class ResourceAdmissionPendingError extends Error {
  constructor(readonly reservationId: string) {
    super(`Resource reservation ${reservationId} is waiting for fair admission`);
    this.name = "ResourceAdmissionPendingError";
  }
}

export class ResourceAdmissionExpiredError extends Error {
  constructor(readonly reservationId: string) {
    super(`Resource reservation ${reservationId} expired while waiting for admission`);
    this.name = "ResourceAdmissionExpiredError";
  }
}

export function assignmentReservationId(assignmentId: string): string {
  return `reservation:${requireIdentifier(assignmentId, "Assignment id")}`;
}

export function governorRecord(body: GovernorRecord): LogicalRecord<GovernorRecord> {
  return { stream: GOVERNOR_STREAM, body: structuredClone(body) };
}

function terminalDecision(
  state: GovernorProjection,
  lease: ResourceLease,
  kind: "settle" | "release",
):
  | { readonly kind: "return"; readonly value: undefined }
  | {
      readonly kind: "append";
      readonly entries: readonly LogicalRecord<GovernorRecord>[];
      readonly value: undefined;
    } {
  const current = state.reservations.get(lease.reservationId);
  if (!current || canonicalize(current.lease) !== canonicalize(lease)) {
    throw new TypeError("Resource terminal has no matching durable lease");
  }
  if (kind === "settle" && current.settled) {
    return { kind: "return", value: undefined };
  }
  if (kind === "release" && current.state === "released") {
    return { kind: "return", value: undefined };
  }
  if (
    (kind === "settle" && current.state !== "active") ||
    (kind === "release" && current.state !== "active" && current.state !== "settled")
  ) {
    throw new TypeError("Resource terminal conflicts with its durable state");
  }
  return {
    kind: "append",
    entries: [governorRecord({ t: kind, reservationId: lease.reservationId })],
    value: undefined,
  };
}

function terminalRecords(
  reservationId: string,
  mode: "settle-release" | "release" | "reclaim",
): readonly LogicalRecord<GovernorRecord>[] {
  requireIdentifier(reservationId, "Terminal reservationId");
  if (mode === "settle-release") {
    return [
      governorRecord({ t: "settle", reservationId }),
      governorRecord({ t: "release", reservationId }),
    ];
  }
  return [governorRecord({ t: mode, reservationId })];
}

function assertExactGovernorRecords(
  records: readonly LogicalRecord<unknown>[],
  expected: readonly LogicalRecord<GovernorRecord>[],
  label: string,
  verifier: ProtocolSignatureVerifier,
): void {
  const actual = governorRecords(records, verifier);
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new TypeError(`${label} records are incomplete or conflicting`);
  }
}

function governorRecords(
  records: readonly LogicalRecord<unknown>[],
  verifier: ProtocolSignatureVerifier,
): LogicalRecord<GovernorRecord>[] {
  return records
    .filter((record) => record.stream === GOVERNOR_STREAM)
    .map((record) => ({
      ...record,
      body: validateGovernorRecord(record.body, verifier),
    }));
}

function assertUsageReportWorkload(
  lease: ResourceLease,
  report: UsageReport,
): void {
  if (report.workloadRef.kind === "assignment") {
    const activation = (lease as ResourceLease & {
      readonly activation?: { readonly kind: string; readonly assignmentId?: string };
    }).activation;
    if (
      activation?.kind !== "assignment" ||
      activation.assignmentId !== report.workloadRef.assignmentId
    ) {
      throw new TypeError("Usage report does not bind the activated assignment");
    }
    return;
  }
  if (
    lease.workload.kind !== "evidence" ||
    lease.workload.id !== report.workloadRef.requestId
  ) {
    throw new TypeError("Usage report does not bind the evidence workload");
  }
}

function usageReportDigestAtWatermark(
  state: GovernorProjection,
  lease: ResourceLease,
  assignmentId: string,
  watermark: number,
): string {
  const fromUsageSeq = Math.floor((watermark - 1) / 256) * 256 + 1;
  const usages = [...state.usages.entries()]
    .filter(
      ([, usage]) =>
        usage.rootReservationId === lease.reservationId &&
        usage.usageSeq >= fromUsageSeq &&
        usage.usageSeq <= watermark,
    )
    .sort((left, right) => left[1].usageSeq - right[1].usageSeq)
    .map(([usageId, entry]) => ({
      usageSeq: entry.usageSeq,
      reservationId: entry.reservationId,
      usageId,
      ...(entry.usage.tokens === 0 ? {} : { tokens: entry.usage.tokens }),
      ...(entry.usage.calls === 0 ? {} : { calls: entry.usage.calls }),
      ...(entry.usage.costMinor === 0 ? {} : { costMinor: entry.usage.costMinor }),
    }));
  if (
    usages.length !== watermark - fromUsageSeq + 1 ||
    usages.some((usage, index) => usage.usageSeq !== fromUsageSeq + index)
  ) {
    throw new TypeError("Final usage report range is not durably continuous");
  }
  return protocolDigest("UsageReport", 1, {
    v: 1,
    reporterId: lease.audience.executorId,
    rootReservationId: lease.reservationId,
    workloadRef: { kind: "assignment", assignmentId },
    fromUsageSeq,
    toUsageSeq: watermark,
    usages,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function childReservationId(
  parentId: string,
  workload: ChildResourceLease["workload"],
): string {
  return `reservation:${protocolDigest("ChildResourceReservation", 1, {
    parentId,
    workload,
  }).slice("sha256:".length)}`;
}

function immediateReservationId(workload: ImmediateRootWorkload): string {
  return `reservation:${protocolDigest("ImmediateResourceReservation", 1, workload).slice("sha256:".length)}`;
}

function systemReservationId(jobRunId: string, attempt: number): string {
  return `reservation:${protocolDigest("SystemJobResourceReservation", 1, {
    jobRunId,
    attempt,
  }).slice("sha256:".length)}`;
}

function internalHostContext(method: AuthorityPortMethodId, now: string): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "resource-governor" },
    requestId: `resource:${protocolDigest("ResourceHostRequest", 1, { method, now }).slice(7)}`,
    deadlineAt: new Date(Date.parse(now) + 60_000).toISOString(),
  };
}

function canonicalTime(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function deadlineFromContext(
  ctx: AuthorityCallContext,
  now: string,
  monotonicNow: number,
): number {
  const nowAt = Date.parse(canonicalTime(now, "Resource admission time"));
  const deadlineAt = Date.parse(canonicalTime(ctx.deadlineAt, "Resource admission deadline"));
  return monotonicNow + Math.max(0, deadlineAt - nowAt);
}

function requirePositive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
