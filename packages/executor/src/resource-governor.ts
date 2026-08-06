import type {
  AdmissionClass,
  AssignmentReservationRequest,
  AssignmentResourceLease,
  AuthorityCapability,
  AuthorityCallContext,
  ChildResourceLease,
  GovernorRecord,
  ImmediateRootResourceLease,
  ImmediateRootReservationInspection,
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
import { ImmediateRootReplayTerminalError } from "@zhixing/core/contracts";
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
  validateSystemJobReservationOrigin,
  waitForResourceAdmissionCandidate,
  type GovernorProjection,
  type ResourceReservationProjection,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";

const DEFAULT_LEASE_TTL_MS = 15 * 60_000;
const MAX_LEASE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_CANDIDATE_TTL_MS = 5_000;
const MAX_CANDIDATE_TTL_MS = 60_000;
const MAX_USAGE_REPORT_ENTRIES = 256;

export interface ExecutorResourceGuard {
  assert(
    principal: AuthorityCallContext["principal"],
    method: import("@zhixing/core/contracts").AuthorityPortMethodId,
  ): void;
}

export interface ExecutorResourceGovernorOptions {
  readonly log: AuthorityCommitLog;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly guard: ExecutorResourceGuard;
  readonly executorId: string;
  readonly localDomainId: string;
  readonly localGovernorEpoch: number;
  readonly maxActiveRoots?: number;
  readonly leaseTtlMs?: number;
  readonly candidateTtlMs?: number;
  readonly clock?: () => string;
  readonly monotonicClock?: () => number;
}

type LocalRootResourceCandidate = AssignmentResourceLease | ImmediateRootResourceLease;

interface LocalCandidateOccupancy {
  readonly lease: LocalRootResourceCandidate;
  readonly expiresAt: number;
}

export interface ExecutorAssignmentResourceCoordinator {
  coordinate<T>(operation: () => Promise<T>): Promise<T>;
  prepareReceipt(lease: AssignmentResourceLease): readonly LogicalRecord<GovernorRecord>[];
  prepareActivation(lease: AssignmentResourceLease): readonly LogicalRecord<GovernorRecord>[];
  prepareQueuedTerminal(input: {
    readonly workload: RootResourceWorkload;
    readonly reason: Extract<GovernorRecord, { t: "dequeue" }>["reason"];
  }): readonly LogicalRecord<GovernorRecord>[];
  prepareTerminal(input: {
    readonly lease: AssignmentResourceLease;
    readonly mode: "settle-release" | "release" | "reclaim";
  }): readonly LogicalRecord<GovernorRecord>[];
  assertReceiptRecords(input: {
    readonly lease: AssignmentResourceLease;
    readonly records: readonly LogicalRecord<unknown>[];
    readonly acceptedAt?: string;
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
  assertUsageFinal(input: {
    readonly reservationId: string;
    readonly assignmentId: string;
    readonly executorId: string;
    readonly usageFinal: {
      readonly reportDigest: string;
      readonly upToUsageSeq: number;
    };
  }): void;
  usageFinal(assignmentId: string): {
    readonly reportDigest: string;
    readonly upToUsageSeq: number;
  };
}

/** Durable device-side governor for hard capacity, delegated children and usage watermarks. */
export class ExecutorResourceGovernor
  implements ResourceReservationPort, ExecutorAssignmentResourceCoordinator
{
  readonly #log: AuthorityCommitLog;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #guard: ExecutorResourceGuard;
  readonly #executorId: string;
  readonly #localDomainId: string;
  readonly #localGovernorEpoch: number;
  readonly #maxActiveRoots: number;
  readonly #leaseTtlMs: number;
  readonly #candidateTtlMs: number;
  readonly #clock: () => string;
  readonly #monotonicClock: () => number;
  readonly #stream: string;
  readonly #operations = new SerialTaskQueue();
  readonly #candidates = new Map<AdmissionClass, LocalCandidateOccupancy>();
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

  constructor(options: ExecutorResourceGovernorOptions) {
    this.#log = options.log;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#guard = options.guard;
    this.#executorId = requireIdentifier(options.executorId, "Executor resource id");
    this.#localDomainId = requireIdentifier(options.localDomainId, "Local resource domain id");
    this.#localGovernorEpoch = requirePositive(
      options.localGovernorEpoch,
      "Local resource governor epoch",
    );
    this.#maxActiveRoots = requirePositive(
      options.maxActiveRoots ?? 4,
      "Maximum active root reservations",
    );
    this.#leaseTtlMs = requirePositive(
      options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      "Executor resource lease TTL",
    );
    if (this.#leaseTtlMs > MAX_LEASE_TTL_MS) {
      throw new TypeError("Executor resource lease TTL exceeds its protocol maximum");
    }
    this.#candidateTtlMs = requirePositive(
      options.candidateTtlMs ?? DEFAULT_CANDIDATE_TTL_MS,
      "Executor resource candidate TTL",
    );
    if (this.#candidateTtlMs > MAX_CANDIDATE_TTL_MS) {
      throw new TypeError("Executor resource candidate TTL exceeds its protocol maximum");
    }
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.#stream = "governor";
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
    if (workload.kind === "job") {
      throw new TypeError("Job resource roots must be issued by the anchor governor");
    }
    await this.#enqueue(reservationId, workload, origin.admissionClass);
  }

  prepareReceipt(
    lease: AssignmentResourceLease,
  ): readonly LogicalRecord<GovernorRecord>[] {
    const validated = this.#validateAcceptedRoot(lease);
    this.#validateLeaseAcceptance(validated, this.#clock());
    const existing = this.#projection?.state.reservations.get(
      validated.reservationId,
    );
    if (existing) {
      if (
        validated.domain.kind !== "local" ||
        existing.state !== "active" ||
        canonicalize(existing.lease) !== canonicalize(validated)
      ) {
        throw new TypeError(
          "Executor resource receipt conflicts with its durable activation",
        );
      }
      return [this.#record({ t: "reserve", lease: validated })];
    }
    this.#assertCapacity(validated.reservationId);
    if (validated.domain.kind === "local") {
      this.#assertCurrentCandidate(validated);
    }
    const records = [
      this.#record({
        t: "queued",
        reservationId: validated.reservationId,
        admissionClass: validated.admissionClass,
        workload: validated.workload,
      }),
      this.#record({ t: "reserve", lease: validated }),
    ];
    this.#preflight(records);
    return records;
  }

  /** In a local owner domain the owner activation and executor receipt are one fact. */
  prepareActivation(
    lease: AssignmentResourceLease,
  ): readonly LogicalRecord<GovernorRecord>[] {
    return this.prepareReceipt(lease);
  }

  prepareQueuedTerminal(input: {
    readonly workload: RootResourceWorkload;
    readonly reason: Extract<GovernorRecord, { t: "dequeue" }>["reason"];
  }): readonly LogicalRecord<GovernorRecord>[] {
    const records = [queuedTerminalDequeueRecord(input.workload, input.reason)];
    this.#preflight(records);
    return records;
  }

  assertReceiptRecords(input: {
    readonly lease: AssignmentResourceLease;
    readonly records: readonly LogicalRecord<unknown>[];
    readonly acceptedAt?: string;
  }): void {
    const lease = this.#validateAcceptedRoot(input.lease);
    this.#validateLeaseAcceptance(lease, input.acceptedAt ?? this.#clock());
    const expected = [
      this.#record({
        t: "queued",
        reservationId: lease.reservationId,
        admissionClass: lease.admissionClass,
        workload: lease.workload,
      }),
      this.#record({ t: "reserve", lease }),
    ];
    const actual = input.records.filter((record) => record.stream === this.#stream);
    const localActivationReceipt =
      lease.domain.kind === "local"
        ? [this.#record({ t: "reserve", lease })]
        : undefined;
    if (
      canonicalize(actual) !== canonicalize(expected) &&
      (localActivationReceipt === undefined ||
        canonicalize(actual) !== canonicalize(localActivationReceipt))
    ) {
      throw new TypeError("Executor resource receipt records are incomplete or conflicting");
    }
  }

  assertActivationRecords(input: {
    readonly lease: AssignmentResourceLease;
    readonly records: readonly LogicalRecord<unknown>[];
    readonly acceptedAt?: string;
  }): void {
    this.assertReceiptRecords(input);
  }

  prepareTerminal(input: {
    readonly lease: AssignmentResourceLease;
    readonly mode: "settle-release" | "release";
  }): readonly LogicalRecord<GovernorRecord>[] {
    const lease = this.#validateAcceptedRoot(input.lease);
    const records = this.#terminalRecords(lease.reservationId, input.mode);
    this.#preflight(records);
    return records;
  }

  assertTerminalRecords(input: {
    readonly reservationId: string;
    readonly mode: "settle-release" | "release";
    readonly records: readonly LogicalRecord<unknown>[];
  }): void {
    const expected = this.#terminalRecords(input.reservationId, input.mode);
    const actual = input.records.filter((record) => record.stream === this.#stream);
    if (canonicalize(actual) !== canonicalize(expected)) {
      throw new TypeError("Executor resource terminal records are incomplete or conflicting");
    }
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
    if (
      input.reservationId !== `reservation:${input.assignmentId}` ||
      input.executorId !== this.#executorId
    ) {
      throw new TypeError("Final usage does not bind the local assignment root");
    }
    if (canonicalize(this.usageFinal(input.assignmentId)) !== canonicalize(input.usageFinal)) {
      throw new TypeError("Final usage does not match the local durable watermark");
    }
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
    if (request.workload.kind !== "run") {
      throw new TypeError("Local assignment roots only support conversation work");
    }
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
          domain: {
            kind: "local",
            localDomainId: this.#localDomainId,
            localGovernorEpoch: this.#localGovernorEpoch,
          },
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
    _request: SystemJobReservationRequest,
    origin: SystemJobReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<SystemJobResourceLease> {
    validateSystemJobReservationOrigin(origin);
    this.#guard.assert(ctx.principal, "reservation.prepareSystemJobRoot");
    throw new TypeError("System job resource roots must be issued by the anchor governor");
  }

  async acquireRoot(
    workload: ImmediateRootWorkload,
    budget: ResourceLease["budget"],
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
    audience: { readonly executorId: string } = {
      executorId: this.#executorId,
    },
  ): Promise<ImmediateRootResourceLease> {
    const validatedOrigin = validateReservationOrigin(origin);
    this.#guard.assert(ctx.principal, "reservation.acquireRoot");
    assertResourceAdmissionRequest(workload, budget);
    requireIdentifier(ctx.requestId, "Reservation requestId");
    if (audience.executorId !== this.#executorId) {
      throw new TypeError(
        "Executor-local resource governor cannot issue a lease for another executor",
      );
    }
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
                audience: { executorId: this.#executorId },
                budget,
              }),
            () => this.#signLease({
              reservationId,
              admissionClass: validatedOrigin.admissionClass,
              workload,
              scopeBinding: { kind: "control", subject: workload.id },
              audience: { executorId: this.#executorId },
              budget,
              domain: {
                kind: "local",
                localDomainId: this.#localDomainId,
                localGovernorEpoch: this.#localGovernorEpoch,
              },
            }) as ImmediateRootResourceLease,
          ),
      );
    } catch (error) {
      if (error instanceof ImmediateRootReplayTerminalError) throw error;
      if (error instanceof ResourceAdmissionDeferredError) {
        await this.#dequeue(workload, "expired");
        throw new ExecutorResourceAdmissionExpiredError(reservationId);
      }
      // 硬容量背压是可重试瞬时状态——保留 queued 供调用方重试（幂等 enqueue 续接）
      if (error instanceof ExecutorResourceBackpressureError) throw error;
      // control 根无业务终态记录承接队列项——签发/事务失败必须精确出队，防止队首污染
      await this.#dequeue(workload, "failed");
      throw error;
    }
  }

  async inspectImmediateRoot(
    workload: ImmediateRootWorkload,
  ): Promise<ImmediateRootReservationInspection> {
    assertResourceAdmissionRequest(workload);
    const state = await this.snapshot();
    const reservationId = immediateReservationId(workload);
    const reservation = state.reservations.get(reservationId);
    if (reservation) {
      if (
        reservation.depth !== 0 ||
        reservation.lease.workload.kind !== "control" ||
        canonicalize(reservation.lease.workload) !== canonicalize(workload)
      ) {
        throw new TypeError("Immediate local resource inspection found a conflicting root");
      }
      return {
        kind: "reservation",
        state: reservation.state,
        lease: structuredClone(reservation.lease as ImmediateRootResourceLease),
      };
    }
    if (state.queued.has(reservationId)) return { kind: "queued", reservationId };
    const dequeued = state.dequeued.get(rootResourceWorkloadKey(workload));
    return dequeued === undefined
      ? { kind: "absent" }
      : { kind: "dequeued", reason: dequeued };
  }

  async acquireChild(
    parent: ResourceLease,
    workload: ChildResourceLease["workload"],
    budget: ResourceLease["budget"],
    ctx: AuthorityCallContext,
  ): Promise<ChildResourceLease> {
    const validated = validateReservableResourceLease(parent, this.#verifier);
    if (validated.audience.executorId !== this.#executorId) {
      throw new TypeError("Parent resource lease belongs to another executor");
    }
    assertBudgetWithinBudget(budget, validated.budget);
    const reservationId = childReservationId(validated.reservationId, workload);
    return this.#withAuthorizedResourceCall(
      validated,
      ctx,
      "reservation.acquireChild",
      (state) => {
        const current = state.reservations.get(validated.reservationId);
        if (
          !current ||
          canonicalize(current.lease) !== canonicalize(validated)
        ) {
          throw new TypeError("Parent resource lease differs from its durable receipt");
        }
        const existing = state.reservations.get(reservationId);
        if (existing) {
          if (
            existing.lease.parentId !== validated.reservationId ||
            canonicalize(existing.lease.workload) !== canonicalize(workload) ||
            canonicalize(existing.lease.budget) !== canonicalize(budget)
          ) {
            throw new TypeError("Child resource reservation conflicts with its durable lease");
          }
          return { kind: "return", value: existing.lease as ChildResourceLease };
        }
        if (current.state !== "active") {
          throw new TypeError("Parent resource lease is not active");
        }
        const root = state.reservations.get(current.rootReservationId);
        if (!root || root.depth !== 0) {
          throw new TypeError("Parent resource lease has no durable root");
        }
        if (
          root.lease.domain.kind === "anchor" &&
          root.lease.delegation?.executorId !== this.#executorId
        ) {
          throw new TypeError("Parent resource lease does not delegate to this executor");
        }
        if (
          root.lease.domain.kind === "local" &&
          root.lease.audience.executorId !== this.#executorId
        ) {
          throw new TypeError("Local resource root belongs to another executor");
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
          parentId: validated.reservationId,
          parentDigest: validated.digest,
          admissionClass: validated.admissionClass,
          workload,
          scopeBinding: validated.scopeBinding,
          audience: { executorId: this.#executorId },
          budget,
          domain: validated.domain,
          expiry: validated.expiry,
        }) as ChildResourceLease;
        return {
          kind: "append",
          entries: [this.#record({ t: "reserve", lease })],
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
    const normalized = resourceBudgetUsage(usage);
    requireIdentifier(usage.usageId, "Executor resource usageId");
    await this.#withAuthorizedResourceCall<void>(
      validated,
      ctx,
      "reservation.consume",
      (state) => {
      const reservation = state.reservations.get(validated.reservationId);
      if (!reservation || canonicalize(reservation.lease) !== canonicalize(validated)) {
        throw new TypeError("Executor resource lease differs from its durable activation");
      }
      const duplicate = state.usages.get(usage.usageId);
      if (duplicate) {
        if (
          duplicate.reservationId !== validated.reservationId ||
          canonicalize(duplicate.usage) !== canonicalize(normalized)
        ) {
          throw new TypeError("Executor usage id was reused with different content");
        }
        return { kind: "return", value: undefined };
      }
      if (reservation.state !== "active") {
        throw new TypeError("Executor resource lease is not active");
      }
      const usageSeq = state.nextUsageSeqByRoot.get(reservation.rootReservationId) ?? 1;
      return {
        kind: "append",
        entries: [this.#record({
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
    requireIdentifier(usage.usageId, "Executor reserved usageId");
    await this.#withAuthorizedResourceCall<void>(
      validated,
      ctx,
      "reservation.reserveUsage",
      (state) => {
        const reservation = state.reservations.get(validated.reservationId);
        if (!reservation || canonicalize(reservation.lease) !== canonicalize(validated)) {
          throw new TypeError("Executor resource lease differs from its durable activation");
        }
        const existing = state.usageReservations.get(usage.usageId);
        if (existing) {
          if (
            existing.rootReservationId !== reservation.rootReservationId ||
            existing.reservationId !== validated.reservationId ||
            canonicalize(existing.usage) !== canonicalize(normalized)
          ) {
            throw new TypeError("Executor usage reservation id was reused with different content");
          }
          return { kind: "return", value: undefined };
        }
        if (reservation.state !== "active") {
          throw new TypeError("Executor resource lease is not active");
        }
        return {
          kind: "append",
          entries: [this.#record({
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
      (state) => validated.parentId === undefined
        ? this.#terminalDecision(state, validated, "settle")
        : this.#settleChildSubtreeDecision(state, validated),
    );
  }

  async release(lease: ResourceLease, ctx: AuthorityCallContext): Promise<void> {
    const validated = validateReservableResourceLease(lease, this.#verifier);
    await this.#withAuthorizedResourceCall(
      validated,
      ctx,
      "reservation.release",
      (state) => this.#terminalDecision(state, validated, "release"),
    );
  }

  async reclaimExpired(): Promise<number> {
    canonicalTime(this.#clock(), "Resource reclaim time");
    return this.#transact<number>((state) => {
      const expiring = [...state.reservations.values()]
        .filter((reservation) =>
          (reservation.state === "active" || reservation.state === "settled") &&
          !isBusinessOwnedResourceReservation(state, reservation) &&
          this.#leaseIsExpired(state, reservation.lease)
        );
      const expiringIds = new Set(expiring.map((reservation) => reservation.lease.reservationId));
      const expiringRoots = new Set(
        expiring
          .filter((reservation) => reservation.depth === 0)
          .map((reservation) => reservation.rootReservationId),
      );
      const entries = conservativeUsageConsumptionRecords(state, {
        rootReservationIds: expiringRoots,
        reservationIds: expiringIds,
      })
        .map((record) => this.#record(record));
      for (const reservation of expiring.sort((left, right) => right.depth - left.depth)) {
        entries.push(this.#record({
          t: reservation.state === "settled" ? "release" : "reclaim",
          reservationId: reservation.lease.reservationId,
        }));
      }
      return entries.length === 0
        ? { kind: "return", value: 0 }
        : { kind: "append", entries, value: expiring.length };
    });
  }

  async flushAssignment(
    assignmentId: string,
    intake: ResourceUsageIntake,
    contextFor: (report: UsageReport) => AuthorityCallContext,
  ): Promise<{ readonly reportDigest: string; readonly upToUsageSeq: number }> {
    const reports = await this.#operations.run(async () => {
      await this.#synchronizeUnlocked();
      await this.#reconcileAssignmentUsageUnlocked(assignmentId);
      await this.#finalizeAssignmentDescendantsUnlocked(assignmentId);
      return this.#reportsForAssignment(assignmentId);
    });
    for (const report of reports) {
      const ack = await intake.submitUsageReport(report, contextFor(report));
      if (ack.ackedThroughSeq < report.toUsageSeq) {
        throw new Error("Resource usage intake did not acknowledge the complete report");
      }
    }
    return this.usageFinal(assignmentId);
  }

  /** Finalizes the complete local reservation subtree without creating anchor usage debt. */
  async finalizeLocalAssignment(
    assignmentId: string,
  ): Promise<{ readonly reportDigest: string; readonly upToUsageSeq: number }> {
    await this.#operations.run(async () => {
      await this.#synchronizeUnlocked();
      await this.#reconcileAssignmentUsageUnlocked(assignmentId);
      await this.#finalizeAssignmentDescendantsUnlocked(assignmentId);
    });
    return this.usageFinal(assignmentId);
  }

  async assignmentDomain(
    assignmentId: string,
  ): Promise<AssignmentResourceLease["domain"] | undefined> {
    return this.#operations.run(async () => {
      await this.#synchronizeUnlocked();
      const root = findAssignmentRoot(this.#projection!.state, assignmentId);
      return root ? structuredClone(root.lease.domain) : undefined;
    });
  }

  usageFinal(assignmentId: string): {
    readonly reportDigest: string;
    readonly upToUsageSeq: number;
  } {
    const state = this.#projection?.state;
    const root = state && findAssignmentRoot(state, assignmentId);
    if (
      root &&
      [...state!.usageReservations.values()].some(
        (reservation) =>
          reservation.rootReservationId === root.rootReservationId &&
          reservation.state === "reserved",
      )
    ) {
      throw new Error("Assignment usage final has unresolved durable reservations");
    }
    const upToUsageSeq = root
      ? (state!.nextUsageSeqByRoot.get(root.lease.reservationId) ?? 1) - 1
      : 0;
    if (upToUsageSeq === 0) {
      return {
        reportDigest: protocolDigest("AssignmentUsageFinal", 1, {
          assignmentId,
          upToUsageSeq,
        }),
        upToUsageSeq,
      };
    }
    const report = this.#reportsForAssignment(assignmentId).at(-1);
    if (!report || report.toUsageSeq !== upToUsageSeq) {
      throw new Error("Assignment usage final cannot be reconstructed from durable usage");
    }
    return { reportDigest: report.digest, upToUsageSeq };
  }

  async snapshot(): Promise<GovernorProjection> {
    await this.#synchronizeUnlocked();
    return cloneGovernorProjection(this.#projection!.state);
  }

  #reportsForAssignment(assignmentId: string): UsageReport[] {
    const state = this.#projection?.state;
    if (!state) throw new Error("Executor resource projection is unavailable");
    const root = findAssignmentRoot(state, assignmentId);
    if (!root) throw new Error("Assignment has no executor resource root");
    const usages = [...state.usages.entries()]
      .filter(([, usage]) => usage.rootReservationId === root.lease.reservationId)
      .sort((left, right) => left[1].usageSeq - right[1].usageSeq);
    const reports: UsageReport[] = [];
    for (let offset = 0; offset < usages.length; offset += MAX_USAGE_REPORT_ENTRIES) {
      const batch = usages.slice(offset, offset + MAX_USAGE_REPORT_ENTRIES);
      const payload = {
        v: 1 as const,
        reporterId: this.#executorId,
        rootReservationId: root.lease.reservationId,
        workloadRef: { kind: "assignment" as const, assignmentId },
        fromUsageSeq: batch[0]![1].usageSeq,
        toUsageSeq: batch.at(-1)![1].usageSeq,
        usages: batch.map(([usageId, entry]) => ({
          usageSeq: entry.usageSeq,
          reservationId: entry.reservationId,
          usageId,
          ...(entry.usage.tokens === 0 ? {} : { tokens: entry.usage.tokens }),
          ...(entry.usage.calls === 0 ? {} : { calls: entry.usage.calls }),
          ...(entry.usage.costMinor === 0 ? {} : { costMinor: entry.usage.costMinor }),
        })),
      };
      const withDigest = {
        ...payload,
        digest: protocolDigest("UsageReport", 1, payload),
      };
      reports.push({
        ...withDigest,
        signature: this.#signer.sign("UsageReport", 1, withDigest),
      });
    }
    return reports;
  }

  async #reconcileAssignmentUsageUnlocked(assignmentId: string): Promise<void> {
    await this.#transactUnlocked<void>((state) => {
      const root = findAssignmentRoot(state, assignmentId);
      if (!root) throw new Error("Assignment has no executor resource root");
      const entries = conservativeUsageConsumptionRecords(
        state,
        { rootReservationIds: new Set([root.rootReservationId]) },
      ).map((record) => this.#record(record));
      return entries.length === 0
        ? { kind: "return", value: undefined }
        : { kind: "append", entries, value: undefined };
    });
  }

  async #finalizeAssignmentDescendantsUnlocked(assignmentId: string): Promise<void> {
    await this.#transactUnlocked<void>((state) => {
      const root = findAssignmentRoot(state, assignmentId);
      if (!root) throw new Error("Assignment has no executor resource root");
      const descendants = [...state.reservations.values()]
        .filter((reservation) =>
          reservation.rootReservationId === root.rootReservationId &&
          reservation.depth > 0 &&
          (reservation.state === "active" || reservation.state === "settled")
        )
        .sort((left, right) => right.depth - left.depth);
      const entries = this.#terminalizeReservations(descendants);
      return entries.length === 0
        ? { kind: "return", value: undefined }
        : { kind: "append", entries, value: undefined };
    });
  }

  #validateAcceptedRoot(lease: AssignmentResourceLease): AssignmentResourceLease {
    const validated = validateReservableResourceLease(lease, this.#verifier);
    if (
      validated.parentId !== undefined ||
      !("activation" in validated) ||
      validated.activation.kind !== "assignment" ||
      validated.audience.executorId !== this.#executorId
    ) {
      throw new TypeError("Executor received an invalid assignment resource root");
    }
    if (
      validated.domain.kind === "anchor" &&
      (validated.delegation?.executorId !== this.#executorId ||
        validated.delegation.maxDepth < 1)
    ) {
      throw new TypeError("Anchor resource root does not delegate to this executor");
    }
    if (
      validated.domain.kind === "local" &&
      (validated.domain.localDomainId !== this.#localDomainId ||
        validated.domain.localGovernorEpoch !== this.#localGovernorEpoch)
    ) {
      throw new TypeError("Local resource root belongs to another governor domain");
    }
    return validated as AssignmentResourceLease;
  }

  #assertCapacity(
    reservationId: string,
    state = this.#projection?.state,
  ): void {
    if (!state) throw new Error("Executor resource projection is unavailable");
    if (state.reservations.has(reservationId)) return;
    const active = [...state.reservations.values()].filter(
      (reservation) => reservation.depth === 0 && reservation.state === "active",
    ).length;
    if (active >= this.#maxActiveRoots) {
      throw new ExecutorResourceBackpressureError(this.#maxActiveRoots);
    }
  }

  async #prepareCandidate<Lease extends LocalRootResourceCandidate>(
    reservationId: string,
    admissionClass: AdmissionClass,
    matches: (lease: LocalRootResourceCandidate) => boolean,
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
          !matches(active.lease as LocalRootResourceCandidate)
        ) {
          throw new TypeError("Local resource candidate retry changed its frozen request");
        }
        return active.lease as Lease;
      }
      if (state.queued.get(reservationId) !== admissionClass) {
        throw new TypeError("Local resource candidate is not durably queued");
      }
      const occupied = this.#candidates.get(admissionClass);
      if (occupied) {
        if (occupied.lease.reservationId !== reservationId) {
          throw new ExecutorResourceAdmissionPendingError(reservationId);
        }
        if (!matches(occupied.lease)) {
          throw new TypeError("Local resource candidate retry changed its frozen request");
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
        throw new ExecutorResourceAdmissionPendingError(reservationId);
      }
      this.#assertCapacity(reservationId);
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
      isPending: (error) => error instanceof ExecutorResourceAdmissionPendingError,
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
    if (!state) throw new Error("Executor resource projection is unavailable");
    this.#pruneCandidates();
    if (state.queued.get(lease.reservationId) !== lease.admissionClass) {
      throw new TypeError("Local resource reservation is not durably queued");
    }
    const candidate = this.#candidates.get(lease.admissionClass);
    if (
      !candidate ||
      candidate.lease.reservationId !== lease.reservationId ||
      candidate.lease.digest !== lease.digest
    ) {
      throw new TypeError("Local resource activation does not match the live candidate");
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
          throw new TypeError("Immediate local resource retry changed its frozen request");
        }
        if (existing.state !== "active") {
          throw new ImmediateRootReplayTerminalError({
            kind: "reservation",
            state: existing.state,
            lease: structuredClone(existing.lease as ImmediateRootResourceLease),
          });
        }
        return { kind: "return", value: existing.lease as ImmediateRootResourceLease };
      }
      if (state.queued.get(reservationId) !== admissionClass) {
        throw new TypeError("Immediate local resource root is not durably queued");
      }
      const selected = selectFairReservation(
        cloneGovernorProjection(state),
        new Set(this.#candidates.keys()),
      );
      if (
        selected?.reservationId !== reservationId ||
        selected.admissionClass !== admissionClass
      ) {
        throw new ExecutorResourceAdmissionPendingError(reservationId);
      }
      this.#assertCapacity(reservationId, state);
      const lease = create();
      this.#validateLeaseAcceptance(lease, this.#clock());
      return {
        kind: "append",
        entries: [this.#record({ t: "reserve", lease })],
        value: lease,
      };
    });
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
          throw new TypeError("Local resource workload was dequeued for another reason");
        }
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [this.#record({
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
    const issuedAt = canonicalTime(this.#clock(), "Executor resource issue time");
    const expiry = input.expiry ?? new Date(Date.parse(issuedAt) + this.#leaseTtlMs).toISOString();
    const payload = { v: 1 as const, ...input, issuedAt, expiry };
    const withDigest = {
      ...payload,
      digest: protocolDigest("ResourceLease", 1, payload),
    };
    return {
      ...withDigest,
      signature: this.#signer.sign("ResourceLease", 1, withDigest),
    } as ResourceLease;
  }

  async #enqueue(
    reservationId: string,
    workload: RootResourceWorkload,
    admissionClass: AdmissionClass,
  ): Promise<void> {
    await this.#transact<void>((state) => {
      const dequeued = state.dequeued.get(rootResourceWorkloadKey(workload));
      if (dequeued !== undefined) {
        throw new ImmediateRootReplayTerminalError({
          kind: "dequeued",
          reason: dequeued,
        });
      }
      const existing = state.queued.get(reservationId);
      if (existing !== undefined) {
        if (
          existing !== admissionClass ||
          canonicalize(state.queuedWorkloads.get(reservationId)) !== canonicalize(workload)
        ) {
          throw new TypeError("Local reservation changed admission contract");
        }
        return { kind: "return", value: undefined };
      }
      if (state.reservations.has(reservationId)) {
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [this.#record({ t: "queued", reservationId, admissionClass, workload })],
        value: undefined,
      };
    });
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
      if (!state) throw new Error("Executor resource projection is unavailable");
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
        activation = await this.#receivedAssignmentCapabilityActivation(
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
        assertActivatedResourceCapability({
          context: ctx,
          method,
          rootLease: root.lease as AssignmentResourceLease,
          activeCapIds: activation.activeCapIds,
          verifier: this.#verifier,
          now: activation.acceptedAt,
        });
        this.#assertCapabilityDeadline(
          ctx.principal.capability,
          activation.acceptedAt,
          root.lease.reservationId,
        );
      }
      return this.#transactUnlocked(decide);
    });
  }

  async #receivedAssignmentCapabilityActivation(
    lease: AssignmentResourceLease,
  ): Promise<{
    readonly acceptedCapIds: ReadonlySet<string>;
    readonly activeCapIds: ReadonlySet<string>;
    readonly acceptedAt: string;
  }> {
    const assignmentId = lease.activation.assignmentId;
    const records = await this.#log.readStream<unknown>(`assignment:${assignmentId}`);
    let receivedCapIds: readonly string[] | undefined;
    let acceptedAt: string | undefined;
    let started = false;
    let terminal = false;
    for (const record of records) {
      const body = asRecord(record.body);
      const entry = asRecord(body?.body);
      const activation = asRecord(entry?.activation);
      if (
        entry?.t === "received" &&
        activation?.assignmentId === assignmentId &&
        activation.executorId === this.#executorId &&
        asRecord(activation.reservation)?.reservationId === lease.reservationId &&
        Array.isArray(activation.capIds) &&
        activation.capIds.every((capId) => typeof capId === "string")
      ) {
        receivedCapIds = activation.capIds as string[];
        acceptedAt = record.at;
      }
      if (entry?.t === "started") started = true;
      if (
        entry?.t === "halted" ||
        entry?.t === "execution-failed" ||
        entry?.t === "bundle_sealed" ||
        entry?.t === "acked"
      ) {
        terminal = true;
      }
    }
    if (!receivedCapIds || !acceptedAt) {
      throw new TypeError("Assignment resource capability has no durable received activation");
    }
    return {
      acceptedCapIds: new Set(receivedCapIds),
      activeCapIds: started && !terminal ? new Set(receivedCapIds) : new Set(),
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
    const now = Date.parse(
      canonicalTime(this.#clock(), "Executor resource capability local clock"),
    );
    const accepted = Date.parse(
      canonicalTime(acceptedAt, "Executor resource capability acceptance time"),
    );
    if (now < accepted) {
      throw new TypeError("Executor resource capability clock precedes durable activation");
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

  #preflight(entries: readonly LogicalRecord<GovernorRecord>[]): void {
    const current = this.#projection?.state;
    if (!current) throw new Error("Executor resource projection is unavailable");
    let candidate = cloneGovernorProjection(current);
    for (const entry of entries) {
      if (entry.stream !== this.#stream) {
        throw new TypeError("Executor governor transaction contains a foreign stream");
      }
      candidate = applyGovernorRecord(candidate, entry.body, this.#verifier);
    }
  }

  #record(body: GovernorRecord): LogicalRecord<GovernorRecord> {
    return { stream: this.#stream, body: structuredClone(body) };
  }

  #terminalRecords(
    reservationId: string,
    mode: "settle-release" | "release" | "reclaim",
  ): readonly LogicalRecord<GovernorRecord>[] {
    requireIdentifier(reservationId, "Terminal reservationId");
    return mode === "settle-release"
      ? [
          this.#record({ t: "settle", reservationId }),
          this.#record({ t: "release", reservationId }),
        ]
      : [
          this.#record({
            t: mode === "reclaim" ? "reclaim" : "release",
            reservationId,
          }),
        ];
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
      throw new TypeError("Executor resource lease has no durable acceptance time");
    }
    const now = Date.parse(canonicalTime(this.#clock(), "Executor resource local clock"));
    const acceptedAt = Date.parse(
      canonicalTime(acceptance.acceptedAt, "Executor resource acceptance time"),
    );
    if (now < acceptedAt) {
      throw new TypeError("Executor resource local clock precedes durable acceptance");
    }
    const remaining = acceptance.validForMs - (now - acceptedAt);
    if (remaining <= 0) {
      throw new TypeError("Executor resource lease expired after durable acceptance");
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
      throw new TypeError("Executor resource lease is expired or replaced");
    }
    if (
      Date.parse(canonicalTime(callDeadlineAt, "Executor resource call deadline")) >
      Date.parse(canonicalTime(lease.expiry, "Executor resource lease expiry"))
    ) {
      throw new TypeError("Executor resource call deadline exceeds lease expiry");
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
    const result = await this.#log.transactProjection<GovernorProjection, unknown, void>(
      initial,
      (state, record, envelope) => {
        if (record.stream !== this.#stream) return state;
        return this.#applyRetainedRecord(
          state,
          record.body,
          envelope.at,
          retentionCutoff,
        );
      },
      () => ({ kind: "return", value: undefined }),
      {
        stream: this.#stream,
        ...(cached ? { cursor: cached.cursor } : {}),
      },
    );
    this.#projection = {
      state: this.#compactProjection(result.state),
      cursor: result.cursor,
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
      const result = await this.#log.transactProjection<GovernorProjection, unknown, Value>(
        initial,
        (state, record, envelope) => {
          if (record.stream !== this.#stream) return state;
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
            if (entry.stream !== this.#stream) {
              throw new TypeError("Executor governor transaction contains a foreign stream");
            }
            candidate = applyGovernorRecord(candidate, entry.body, this.#verifier);
          }
          return decision;
        },
        {
          stream: this.#stream,
          ...(cached ? { cursor: cached.cursor } : {}),
        },
      );
      this.#projection = {
        state: this.#compactProjection(result.state),
        cursor: result.cursor,
      };
      this.#pruneCandidates();
      return result.value;
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
    const now = Date.parse(
      canonicalTime(this.#clock(), "Executor resource retention clock"),
    );
    return new Date(now - GOVERNOR_TERMINAL_RETENTION_MS).toISOString();
  }

  #terminalDecision(
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
      throw new TypeError("Executor resource terminal has no matching lease");
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
      throw new TypeError("Executor resource terminal conflicts with its durable state");
    }
    return {
      kind: "append",
      entries: [this.#record({ t: kind, reservationId: lease.reservationId })],
      value: undefined,
    };
  }

  #settleChildSubtreeDecision(
    state: GovernorProjection,
    lease: ResourceLease,
  ):
    | { readonly kind: "return"; readonly value: undefined }
    | {
        readonly kind: "append";
        readonly entries: readonly LogicalRecord<GovernorRecord>[];
        readonly value: undefined;
      } {
    const current = state.reservations.get(lease.reservationId);
    if (!current || canonicalize(current.lease) !== canonicalize(lease)) {
      throw new TypeError("Executor resource terminal has no matching lease");
    }
    if (current.state === "released" || current.state === "reclaimed") {
      return { kind: "return", value: undefined };
    }
    const subtree = [...state.reservations.values()]
      .filter((reservation) =>
        reservation.rootReservationId === current.rootReservationId &&
        isReservationInSubtree(state, reservation.lease.reservationId, lease.reservationId) &&
        (reservation.state === "active" || reservation.state === "settled")
      )
      .sort((left, right) => right.depth - left.depth);
    const reservationIds = new Set(
      subtree.map((reservation) => reservation.lease.reservationId),
    );
    const entries = conservativeUsageConsumptionRecords(state, { reservationIds })
      .map((record) => this.#record(record));
    entries.push(...this.#terminalizeReservations(subtree, lease.reservationId));
    return entries.length === 0
      ? { kind: "return", value: undefined }
      : { kind: "append", entries, value: undefined };
  }

  #terminalizeReservations(
    reservations: readonly ResourceReservationProjection[],
    settleOnlyReservationId?: string,
  ): LogicalRecord<GovernorRecord>[] {
    const entries: LogicalRecord<GovernorRecord>[] = [];
    for (const reservation of reservations) {
      const reservationId = reservation.lease.reservationId;
      if (reservation.state === "active") {
        entries.push(this.#record({ t: "settle", reservationId }));
      }
      if (
        reservationId !== settleOnlyReservationId &&
        (reservation.state === "active" || reservation.state === "settled")
      ) {
        entries.push(this.#record({ t: "release", reservationId }));
      }
    }
    return entries;
  }
}

export class ExecutorResourceBackpressureError extends Error {
  constructor(readonly maximumActiveRoots: number) {
    super(`Executor resource capacity is limited to ${maximumActiveRoots} active roots`);
    this.name = "ExecutorResourceBackpressureError";
  }
}

export class ExecutorResourceAdmissionPendingError extends Error {
  constructor(readonly reservationId: string) {
    super(`Local resource reservation ${reservationId} is waiting for fair admission`);
    this.name = "ExecutorResourceAdmissionPendingError";
  }
}

export class ExecutorResourceAdmissionExpiredError extends Error {
  constructor(readonly reservationId: string) {
    super(`Local resource reservation ${reservationId} expired while waiting for admission`);
    this.name = "ExecutorResourceAdmissionExpiredError";
  }
}

function findAssignmentRoot(state: GovernorProjection, assignmentId: string) {
  return [...state.reservations.values()].find((reservation) => {
    const activation = (reservation.lease as ResourceLease & {
      readonly activation?: { readonly kind: string; readonly assignmentId?: string };
    }).activation;
    return reservation.depth === 0 &&
      activation?.kind === "assignment" &&
      activation.assignmentId === assignmentId;
  });
}

function isReservationInSubtree(
  state: GovernorProjection,
  reservationId: string,
  subtreeRootId: string,
): boolean {
  let currentId: string | undefined = reservationId;
  const visited = new Set<string>();
  while (currentId !== undefined) {
    if (currentId === subtreeRootId) return true;
    if (visited.has(currentId)) {
      throw new TypeError("Resource reservation ancestry contains a cycle");
    }
    visited.add(currentId);
    currentId = state.reservations.get(currentId)?.lease.parentId;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assignmentReservationId(assignmentId: string): string {
  return `reservation:${requireIdentifier(assignmentId, "Assignment id")}`;
}

function childReservationId(
  parentId: string,
  workload: ChildResourceLease["workload"],
): string {
  return `reservation:${protocolDigest("ChildResourceReservation", 1, {
    parentId,
    workload,
  }).slice(7)}`;
}

function immediateReservationId(workload: ImmediateRootWorkload): string {
  return `reservation:${protocolDigest("ImmediateResourceReservation", 1, workload).slice(7)}`;
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
  const nowAt = Date.parse(canonicalTime(now, "Executor resource admission time"));
  const deadlineAt = Date.parse(canonicalTime(ctx.deadlineAt, "Executor resource admission deadline"));
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
