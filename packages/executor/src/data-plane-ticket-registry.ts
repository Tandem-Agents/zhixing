import type {
  AuthorityCommitLog,
  ProjectionCursor,
  ProjectionTransactionContext,
  ProjectionTransactionDecision,
} from "@zhixing/core/authority";
import type {
  CommitEnvelope,
  DataPlaneTicket,
  ExecutionRef,
  LogicalRecord,
  StreamConsumerAuth,
} from "@zhixing/core/contracts";
import {
  MAX_DATA_PLANE_TICKET_TTL_MS,
  MAX_CLOCK_SKEW_MS,
  acceptedRemoteIntervalRemainingMs,
  acceptedRemoteIntervalStatus,
  assertDataPlaneTicketBinding,
  assertDataPlaneTicketUse,
  assertProtocolIdentifier,
  canonicalize,
  dataPlaneTicketDigest,
  validateDataPlaneTicket,
  type DataPlaneTicketBinding,
  type DataPlaneTicketUse,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import { SerialTaskQueue } from "@zhixing/core/persistence";
import type { AssignmentStreamSpool } from "./assignment-stream-spool.js";

type TicketRegistryRecord =
  | {
      readonly t: "data-plane-ticket-accepted";
      readonly ticket: DataPlaneTicket;
      readonly activation: DataPlaneAssignmentBinding;
      readonly acceptedAt: string;
      readonly validForMs: number;
    }
  | {
      readonly t: "data-plane-ticket-retired";
      readonly assignmentId: string;
      readonly ticketId: string;
      readonly ticketDigest?: string;
      readonly reason: "expired" | "invalidated" | "revoked";
      readonly retainUntil: string;
    }
  | {
      readonly t: "data-plane-ticket-retirement-frontier";
      readonly executorId: string;
      readonly retiredThrough: string;
    };

interface AcceptedTicket {
  readonly ticket: DataPlaneTicket;
  readonly activation: DataPlaneAssignmentBinding;
  readonly acceptedAt: string;
  readonly validForMs: number;
}

interface RetiredTicket {
  readonly assignmentId: string;
  readonly ticketDigest?: string;
  readonly reason: "expired" | "invalidated" | "revoked";
  readonly retainUntil: string;
}

interface TicketRegistryProjection {
  readonly accepted: Map<string, AcceptedTicket>;
  readonly retired: Map<string, RetiredTicket>;
  retiredThrough: string | undefined;
}

export interface DataPlaneAssignmentBinding {
  readonly ref: ExecutionRef;
  readonly executorId: string;
  readonly ownerKeyId: string;
}

export interface DataPlaneAssignmentBindingResolver {
  dataPlaneBinding(
    assignmentId: string,
  ): Promise<DataPlaneAssignmentBinding | undefined>;
}

export interface DataPlaneTicketRegistryOptions {
  readonly log: AuthorityCommitLog;
  readonly executorId: string;
  readonly verifier: ProtocolSignatureVerifier;
  readonly assignments: DataPlaneAssignmentBindingResolver;
  readonly spool: AssignmentStreamSpool;
  readonly clock?: () => string;
  readonly monotonicClock?: () => number;
}

export interface AuthorizedDataPlaneTicket {
  readonly ticket: DataPlaneTicket;
  readonly digest: string;
  readonly expiresAt: string;
}

type TicketRetirementReason = RetiredTicket["reason"];
type TicketAuthorizationDisposition =
  | { readonly kind: "authorized"; readonly value: AuthorizedDataPlaneTicket }
  | { readonly kind: "retired"; readonly ticket?: DataPlaneTicket }
  | { readonly kind: "unknown" };

const DATA_PLANE_TICKET_RETENTION_MS =
  MAX_DATA_PLANE_TICKET_TTL_MS + MAX_CLOCK_SKEW_MS;

export class DataPlaneTicketRegistry {
  readonly #log: AuthorityCommitLog;
  readonly #executorId: string;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #assignments: DataPlaneAssignmentBindingResolver;
  readonly #spool: AssignmentStreamSpool;
  readonly #clock: () => string;
  readonly #monotonicClock: () => number;
  readonly #operations = new SerialTaskQueue();
  readonly #deadlines = new Map<string, number>();
  #projection:
    | { readonly state: TicketRegistryProjection; readonly cursor: ProjectionCursor }
    | undefined;

  constructor(options: DataPlaneTicketRegistryOptions) {
    assertProtocolIdentifier(options.executorId, "Data-plane registry executor id");
    this.#log = options.log;
    this.#executorId = options.executorId;
    this.#verifier = options.verifier;
    this.#assignments = options.assignments;
    this.#spool = options.spool;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#monotonicClock = options.monotonicClock ?? (() => performance.now());
  }

  async accept(input: unknown): Promise<DataPlaneTicket> {
    await this.maintain();
    const ticket = validateDataPlaneTicket(input, this.#verifier);
    if (ticket.executorId !== this.#executorId) {
      throw new TypeError("Data-plane ticket targets a different executor");
    }
    await this.#operations.run(async () => {
      const projected = await this.#load();
      const existing = projected.state.accepted.get(ticket.ticketId);
      if (existing) {
        if (canonicalize(existing.ticket) !== canonicalize(ticket)) {
          throw new Error("Data-plane ticket id has conflicting signed payloads");
        }
        await this.#restoreAcceptedConsumer(existing, true);
        return;
      }
      const retired = projected.state.retired.get(ticket.ticketId);
      if (retired) {
        assertRetiredTicketIdentity(retired, ticket);
        if (ticket.kind !== "abort") await this.#revokeConsumer(ticket);
        return;
      }
      const observedAt = projectionTime(projected.state, this.#clock());
      const interval = acceptedRemoteIntervalStatus({
        issuedAt: ticket.issuedAt,
        expiry: ticket.expiry,
        acceptedAt: observedAt,
        maxTtlMs: MAX_DATA_PLANE_TICKET_TTL_MS,
      });
      if (
        interval.kind === "expired" ||
        ticketPrecedesRetirementFrontier(ticket, projected.state)
      ) {
        if (!ticketPrecedesRetirementFrontier(ticket, projected.state)) {
          await this.#appendRetirement(
            ticket.assignmentId,
            ticket.ticketId,
            "expired",
            dataPlaneTicketDigest(ticket),
          );
        }
        if (ticket.kind !== "abort") await this.#revokeConsumer(ticket);
        return;
      }

      const binding = await this.#assignments.dataPlaneBinding(
        ticket.assignmentId,
      );
      if (!binding) {
        throw new Error("Data-plane ticket has no durable assignment activation");
      }
      assertTicketActivation(ticket, binding);
      const transaction = await this.#transact<{
        readonly ticket: DataPlaneTicket;
        readonly existing: boolean;
        readonly retired: boolean;
      }>((state, context) => {
        const accepted = state.accepted.get(ticket.ticketId);
        if (accepted) {
          if (
            canonicalize(accepted.ticket) !== canonicalize(ticket) ||
            canonicalize(accepted.activation) !== canonicalize(binding)
          ) {
            throw new Error("Data-plane ticket id has conflicting signed payloads");
          }
          return {
            kind: "return",
            value: { ticket: accepted.ticket, existing: true, retired: false },
          };
        }
        const alreadyRetired = state.retired.get(ticket.ticketId);
        if (alreadyRetired) {
          assertRetiredTicketIdentity(alreadyRetired, ticket);
          return {
            kind: "return",
            value: { ticket, existing: true, retired: true },
          };
        }
        const acceptedAt = projectionTime(state, context.at);
        const currentInterval = acceptedRemoteIntervalStatus({
          issuedAt: ticket.issuedAt,
          expiry: ticket.expiry,
          acceptedAt,
          maxTtlMs: MAX_DATA_PLANE_TICKET_TTL_MS,
        });
        if (
          currentInterval.kind === "expired" ||
          ticketPrecedesRetirementFrontier(ticket, state)
        ) {
          if (ticketPrecedesRetirementFrontier(ticket, state)) {
            return {
              kind: "return",
              value: { ticket, existing: false, retired: true },
            };
          }
          return {
            kind: "append",
            entries: [
              ticketRecord(ticket.assignmentId, {
                t: "data-plane-ticket-retired",
                assignmentId: ticket.assignmentId,
                ticketId: ticket.ticketId,
                ticketDigest: dataPlaneTicketDigest(ticket),
                reason: "expired",
                retainUntil: retentionDeadline(acceptedAt),
              }),
            ],
            value: { ticket, existing: false, retired: true },
          };
        }
        return {
          kind: "append",
          entries: [
            ticketRecord(ticket.assignmentId, {
              t: "data-plane-ticket-accepted",
              ticket,
              activation: binding,
              acceptedAt,
              validForMs: currentInterval.remainingMs,
            }),
          ],
          value: { ticket, existing: false, retired: false },
        };
      });
      if (transaction.value.retired) {
        if (ticket.kind !== "abort") await this.#revokeConsumer(ticket);
        return;
      }
      const accepted = transaction.state.accepted.get(ticket.ticketId)!;
      this.#deadlineFor(ticket.ticketId, accepted);
      await this.#restoreAcceptedConsumer(
        accepted,
        transaction.value.existing,
      );
    });
    return ticket;
  }

  async revoke(input: {
    readonly assignmentId: string;
    readonly ticketId: string;
  }): Promise<boolean> {
    await this.maintain();
    assertProtocolIdentifier(input.assignmentId, "Ticket revocation assignment id");
    assertProtocolIdentifier(input.ticketId, "Ticket revocation ticket id");
    return this.#operations.run(async () => {
      let ticket: DataPlaneTicket | undefined;
      const transaction = await this.#transact<boolean>((state, context) => {
        ticket = state.accepted.get(input.ticketId)?.ticket;
        if (ticket && ticket.assignmentId !== input.assignmentId) {
          throw new Error("Ticket revocation binds a different assignment");
        }
        const retired = state.retired.get(input.ticketId);
        if (retired) {
          if (retired.assignmentId !== input.assignmentId) {
            throw new Error("Ticket revocation binds a different assignment");
          }
          return { kind: "return", value: false };
        }
        return {
          kind: "append",
          entries: [
            ticketRecord(input.assignmentId, {
              t: "data-plane-ticket-retired",
              assignmentId: input.assignmentId,
              ticketId: input.ticketId,
              ...(ticket === undefined
                ? {}
                : { ticketDigest: dataPlaneTicketDigest(ticket) }),
              reason: "revoked",
              retainUntil: retentionDeadline(projectionTime(state, context.at)),
            }),
          ],
          value: true,
        };
      });
      this.#deadlines.delete(input.ticketId);
      if (ticket?.kind !== "abort") {
        await this.#revokeConsumerIdentity(
          input.assignmentId,
          input.ticketId,
        );
      }
      return transaction.value;
    });
  }

  async authorize(
    ticketId: string,
    use: DataPlaneTicketUse,
    binding: DataPlaneTicketBinding,
  ): Promise<AuthorizedDataPlaneTicket> {
    assertProtocolIdentifier(ticketId, "Authorized data-plane ticket id");
    return this.#operations.run(async () => {
      const result = await this.#authorizeUnlocked(ticketId, use, binding);
      if (result.kind === "authorized") return result.value;
      if (result.kind === "retired") {
        if (result.ticket?.kind !== "abort") {
          await this.#revokeConsumerIdentity(binding.assignmentId, ticketId);
        }
        throw new Error("Data-plane ticket is retired");
      }
      throw new Error("Data-plane ticket is unknown");
    });
  }

  async authorizeSurface(
    ticketId: string,
    use: DataPlaneTicketUse,
    assignmentId: string,
    surfacePrincipal: string,
  ): Promise<AuthorizedDataPlaneTicket> {
    const ticket = await this.#operations.run(async () => {
      const projection = await this.#load();
      if (projection.state.retired.has(ticketId)) {
        throw new Error("Data-plane ticket is retired");
      }
      return projection.state.accepted.get(ticketId)?.ticket;
    });
    if (!ticket) throw new Error("Data-plane ticket is unknown");
    return this.authorize(ticketId, use, {
      assignmentId,
      ref: ticket.ref,
      executorId: ticket.executorId,
      surfacePrincipal,
    });
  }

  async recover(): Promise<void> {
    await this.maintain();
    await this.#operations.run(async () => {
      const projection = await this.#load();
      for (const entry of [...projection.state.accepted.values()]) {
        const authorization = await this.#authorizeUnlocked(
          entry.ticket.ticketId,
          entry.ticket.kind === "abort" ? "abort" : "observe",
          {
            assignmentId: entry.ticket.assignmentId,
            ref: entry.ticket.ref,
            executorId: entry.ticket.executorId,
            surfacePrincipal: entry.ticket.surfacePrincipal,
          },
        );
        if (entry.ticket.kind === "abort") continue;
        if (authorization.kind !== "authorized") {
          await this.#revokeConsumer(entry.ticket);
          continue;
        }
        await this.#qualify(
          entry.ticket,
          authorization.value.expiresAt,
        );
      }
    });
  }

  async maintain(): Promise<number> {
    return this.#operations.run(async () => {
      const monotonicNow = this.#monotonicClock();
      const transaction = await this.#transact<readonly DataPlaneTicket[]>(
        (state, context) => {
        const tickets = [...state.accepted.values()]
          .filter(
            (accepted) =>
              this.#deadlineFor(accepted.ticket.ticketId, accepted) <=
              monotonicNow,
          )
          .map((accepted) => accepted.ticket);
        if (tickets.length === 0) {
          return { kind: "return", value: [] };
        }
        return {
          kind: "append",
          entries: tickets.map((ticket) =>
            ticketRecord(ticket.assignmentId, {
              t: "data-plane-ticket-retired",
              assignmentId: ticket.assignmentId,
              ticketId: ticket.ticketId,
              ticketDigest: dataPlaneTicketDigest(ticket),
              reason: "expired",
              retainUntil: retentionDeadline(
                projectionTime(state, context.at),
              ),
            }),
          ),
          value: tickets,
        };
        },
      );
      for (const ticket of transaction.value) {
        this.#deadlines.delete(ticket.ticketId);
      }
      for (const [ticketId, retired] of transaction.state.retired) {
        await this.#revokeConsumerIdentity(retired.assignmentId, ticketId);
      }
      await this.#transact<void>((state, context) => {
        const retiredThrough = nextRetirementFrontier(state, context.at);
        if (retiredThrough === undefined) {
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [
            retirementFrontierRecord(this.#executorId, retiredThrough),
          ],
          value: undefined,
        };
      });
      return transaction.value.length;
    });
  }

  async #restoreAcceptedConsumer(
    accepted: AcceptedTicket,
    exactReplay: boolean,
  ): Promise<void> {
    if (accepted.ticket.kind === "abort") return;
    const authorization = await this.#authorizeUnlocked(
      accepted.ticket.ticketId,
      "observe",
      {
        assignmentId: accepted.ticket.assignmentId,
        ref: accepted.ticket.ref,
        executorId: accepted.ticket.executorId,
        surfacePrincipal: accepted.ticket.surfacePrincipal,
      },
    );
    if (authorization.kind !== "authorized") {
      await this.#revokeConsumer(accepted.ticket);
      if (!exactReplay) throw new Error("Data-plane ticket is retired");
      return;
    }
    await this.#qualify(accepted.ticket, authorization.value.expiresAt);
  }

  async #authorizeUnlocked(
    ticketId: string,
    use: DataPlaneTicketUse,
    binding: DataPlaneTicketBinding,
  ): Promise<TicketAuthorizationDisposition> {
    const projection = await this.#load();
    if (projection.state.retired.has(ticketId)) {
      return { kind: "retired" };
    }
    const accepted = projection.state.accepted.get(ticketId);
    if (!accepted) return { kind: "unknown" };
    assertDataPlaneTicketUse(accepted.ticket, use);
    assertDataPlaneTicketBinding(accepted.ticket, binding);
    const currentActivation = await this.#assignments.dataPlaneBinding(
      accepted.ticket.assignmentId,
    );
    if (
      !currentActivation ||
      !ticketActivationMatches(accepted.ticket, accepted.activation) ||
      canonicalize(currentActivation) !== canonicalize(accepted.activation)
    ) {
      await this.#appendRetirement(
        accepted.ticket.assignmentId,
        ticketId,
        "invalidated",
      );
      return { kind: "retired", ticket: accepted.ticket };
    }
    const deadline = this.#deadlineFor(ticketId, accepted);
    if (this.#monotonicClock() >= deadline) {
      await this.#appendRetirement(
        accepted.ticket.assignmentId,
        ticketId,
        "expired",
      );
      return { kind: "retired", ticket: accepted.ticket };
    }
    return {
      kind: "authorized",
      value: {
        ticket: accepted.ticket,
        digest: dataPlaneTicketDigest(accepted.ticket),
        expiresAt: acceptedTicketExpiresAt(accepted),
      },
    };
  }

  async #qualify(ticket: DataPlaneTicket, expiresAt: string): Promise<void> {
    await this.#spool.qualifyConsumer({
      assignmentId: ticket.assignmentId,
      ref: ticket.ref,
      consumer: surfaceConsumer(ticket.ticketId),
      expiresAt,
    });
  }

  #deadlineFor(ticketId: string, accepted: AcceptedTicket): number {
    const cached = this.#deadlines.get(ticketId);
    if (cached !== undefined) return cached;
    const acceptedAt = Date.parse(accepted.acceptedAt);
    const now = Date.parse(this.#clock());
    const remainingMs =
      now < acceptedAt
        ? 0
        : Math.max(0, accepted.validForMs - (now - acceptedAt));
    const deadline = this.#monotonicClock() + remainingMs;
    this.#deadlines.set(ticketId, deadline);
    return deadline;
  }

  async #appendRetirement(
    assignmentId: string,
    ticketId: string,
    reason: TicketRetirementReason,
    ticketDigest?: string,
  ): Promise<void> {
    await this.#transact<void>((state, context) => {
      const accepted = state.accepted.get(ticketId);
      if (accepted && accepted.ticket.assignmentId !== assignmentId) {
        throw new Error("Ticket retirement binds a different assignment");
      }
      const retired = state.retired.get(ticketId);
      if (retired) {
        if (retired.assignmentId !== assignmentId) {
          throw new Error("Ticket retirement binds a different assignment");
        }
        return { kind: "return", value: undefined };
      }
      const digest =
        ticketDigest ??
        (accepted === undefined
          ? undefined
          : dataPlaneTicketDigest(accepted.ticket));
      return {
        kind: "append",
        entries: [
          ticketRecord(assignmentId, {
            t: "data-plane-ticket-retired",
            assignmentId,
            ticketId,
            ...(digest === undefined ? {} : { ticketDigest: digest }),
            reason,
            retainUntil: retentionDeadline(projectionTime(state, context.at)),
          }),
        ],
        value: undefined,
      };
    });
    this.#deadlines.delete(ticketId);
  }

  async #revokeConsumer(ticket: DataPlaneTicket): Promise<void> {
    await this.#revokeConsumerIdentity(ticket.assignmentId, ticket.ticketId);
  }

  async #revokeConsumerIdentity(
    assignmentId: string,
    ticketId: string,
  ): Promise<void> {
    await this.#spool.revokeConsumer({
      assignmentId,
      consumer: surfaceConsumer(ticketId),
    });
  }

  async #load(): Promise<{
    readonly state: TicketRegistryProjection;
    readonly cursor: ProjectionCursor;
  }> {
    const current = this.#projection;
    const transaction = await this.#log.transactProjection<
      TicketRegistryProjection,
      TicketRegistryRecord,
      void
    >(
      current?.state ?? emptyProjection(),
      (state, logical, envelope) =>
        reduceTicketRegistry(
          state,
          logical,
          envelope,
          this.#executorId,
          this.#verifier,
        ),
      () => ({ kind: "return", value: undefined }),
      current ? { cursor: current.cursor } : {},
    );
    this.#projection = { state: transaction.state, cursor: transaction.cursor };
    return this.#projection;
  }

  async #transact<Value>(
    decide: (
      state: TicketRegistryProjection,
      context: ProjectionTransactionContext,
    ) => ProjectionTransactionDecision<TicketRegistryRecord, Value>,
  ) {
    const current = this.#projection;
    const transaction = await this.#log.transactProjection<
      TicketRegistryProjection,
      TicketRegistryRecord,
      Value
    >(
      current?.state ?? emptyProjection(),
      (state, logical, envelope) =>
        reduceTicketRegistry(
          state,
          logical,
          envelope,
          this.#executorId,
          this.#verifier,
        ),
      decide,
      current ? { cursor: current.cursor } : {},
    );
    this.#projection = { state: transaction.state, cursor: transaction.cursor };
    return transaction;
  }
}

function emptyProjection(): TicketRegistryProjection {
  return {
    accepted: new Map(),
    retired: new Map(),
    retiredThrough: undefined,
  };
}

function reduceTicketRegistry(
  state: TicketRegistryProjection,
  logical: LogicalRecord<TicketRegistryRecord>,
  envelope: CommitEnvelope<TicketRegistryRecord>,
  executorId: string,
  verifier: ProtocolSignatureVerifier,
): TicketRegistryProjection {
  const frontierStream =
    `executor:${executorId}:data-plane-ticket-retirement-frontier`;
  if (
    !logical.stream.endsWith(":data-plane-tickets") &&
    logical.stream !== frontierStream
  ) {
    return state;
  }
  const record = validateTicketRegistryRecord(logical.body, verifier);
  if (record.t === "data-plane-ticket-retirement-frontier") {
    if (record.executorId !== executorId || logical.stream !== frontierStream) {
      throw new TypeError(
        "Ticket retirement frontier is stored in the wrong logical stream",
      );
    }
    const expected = nextRetirementFrontier(state, envelope.at);
    if (expected !== record.retiredThrough) {
      throw new TypeError("Ticket retirement frontier is not the next durable boundary");
    }
    state.retiredThrough = record.retiredThrough;
    compactTicketProjection(state);
    return state;
  }
  const recordAssignmentId =
    record.t === "data-plane-ticket-accepted"
      ? record.ticket.assignmentId
      : record.assignmentId;
  if (
    logical.stream !==
    `assignment:${recordAssignmentId}:data-plane-tickets`
  ) {
    throw new TypeError("Ticket registry record is stored in the wrong logical stream");
  }
  if (record.t === "data-plane-ticket-accepted") {
    if (
      !Number.isSafeInteger(record.validForMs) ||
      record.validForMs <= 0 ||
      record.validForMs > MAX_DATA_PLANE_TICKET_TTL_MS
    ) {
      throw new TypeError("Accepted ticket lifetime is invalid");
    }
    assertTicketActivation(record.ticket, record.activation);
    if (ticketPrecedesRetirementFrontier(record.ticket, state)) {
      throw new Error("Accepted ticket history precedes the retirement frontier");
    }
    const existing = state.accepted.get(record.ticket.ticketId);
    const retired = state.retired.get(record.ticket.ticketId);
    if (
      existing ||
      (retired &&
        Date.parse(record.acceptedAt) < Date.parse(retired.retainUntil))
    ) {
      throw new Error("Accepted ticket history is duplicated or still retired");
    }
    state.retired.delete(record.ticket.ticketId);
    state.accepted.set(record.ticket.ticketId, {
      ticket: record.ticket,
      activation: record.activation,
      acceptedAt: record.acceptedAt,
      validForMs: record.validForMs,
    });
    return state;
  }
  const accepted = state.accepted.get(record.ticketId);
  if (accepted && accepted.ticket.assignmentId !== record.assignmentId) {
    throw new Error("Ticket revocation history binds a different assignment");
  }
  const existing = state.retired.get(record.ticketId);
  if (existing) {
    if (existing.assignmentId !== record.assignmentId) {
      throw new Error("Ticket retirement history binds a different assignment");
    }
    if (
      existing.ticketDigest !== undefined &&
      record.ticketDigest !== undefined &&
      existing.ticketDigest !== record.ticketDigest
    ) {
      throw new Error("Ticket retirement history has conflicting identities");
    }
    state.retired.set(record.ticketId, {
      assignmentId: record.assignmentId,
      ...(existing.ticketDigest === undefined &&
      record.ticketDigest === undefined
        ? {}
        : { ticketDigest: existing.ticketDigest ?? record.ticketDigest }),
      reason: record.reason,
      retainUntil:
        Date.parse(record.retainUntil) > Date.parse(existing.retainUntil)
          ? record.retainUntil
          : existing.retainUntil,
    });
    return state;
  }
  state.accepted.delete(record.ticketId);
  state.retired.set(record.ticketId, {
    assignmentId: record.assignmentId,
    ...(record.ticketDigest === undefined
      ? {}
      : { ticketDigest: record.ticketDigest }),
    reason: record.reason,
    retainUntil: record.retainUntil,
  });
  return state;
}

function ticketRecord(
  assignmentId: string,
  body: TicketRegistryRecord,
): LogicalRecord<TicketRegistryRecord> {
  return {
    stream: `assignment:${assignmentId}:data-plane-tickets`,
    body,
  };
}

function retirementFrontierRecord(
  executorId: string,
  retiredThrough: string,
): LogicalRecord<TicketRegistryRecord> {
  return {
    stream: `executor:${executorId}:data-plane-ticket-retirement-frontier`,
    body: {
      t: "data-plane-ticket-retirement-frontier",
      executorId,
      retiredThrough,
    },
  };
}

function surfaceConsumer(ticketId: string): StreamConsumerAuth {
  return { kind: "surface-ticket", ticketId };
}

function validateTicketRegistryRecord(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): TicketRegistryRecord {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError("Ticket registry record must be a plain object");
  }
  const record = input as Record<string, unknown>;
  if (record.t === "data-plane-ticket-accepted") {
    assertKeys(record, [
      "acceptedAt",
      "activation",
      "t",
      "ticket",
      "validForMs",
    ]);
    const ticket = validateDataPlaneTicket(record.ticket, verifier);
    const activation = validateDataPlaneAssignmentBinding(record.activation);
    if (typeof record.acceptedAt !== "string") {
      throw new TypeError("Accepted ticket time is invalid");
    }
    const expected = acceptedRemoteIntervalRemainingMs({
      issuedAt: ticket.issuedAt,
      expiry: ticket.expiry,
      acceptedAt: record.acceptedAt,
      maxTtlMs: MAX_DATA_PLANE_TICKET_TTL_MS,
    });
    if (record.validForMs !== expected) {
      throw new TypeError("Accepted ticket lifetime does not match its signed interval");
    }
    return {
      t: "data-plane-ticket-accepted",
      ticket,
      activation,
      acceptedAt: record.acceptedAt,
      validForMs: expected,
    };
  }
  if (record.t === "data-plane-ticket-retired") {
    assertKeys(record, [
      "assignmentId",
      "reason",
      "retainUntil",
      "t",
      "ticketId",
      ...(record.ticketDigest === undefined ? [] : ["ticketDigest"]),
    ]);
    assertProtocolIdentifier(
      record.assignmentId,
      "Ticket retirement assignment id",
    );
    assertProtocolIdentifier(record.ticketId, "Ticket retirement ticket id");
    if (record.ticketDigest !== undefined) {
      assertDigest(record.ticketDigest, "Ticket retirement digest");
    }
    if (
      record.reason !== "expired" &&
      record.reason !== "invalidated" &&
      record.reason !== "revoked"
    ) {
      throw new TypeError("Ticket retirement reason is invalid");
    }
    if (typeof record.retainUntil !== "string") {
      throw new TypeError("Ticket retirement retention deadline must be a string");
    }
    assertCanonicalTime(record.retainUntil, "Ticket retirement retention deadline");
    return {
      t: "data-plane-ticket-retired",
      assignmentId: record.assignmentId,
      ticketId: record.ticketId,
      ...(record.ticketDigest === undefined
        ? {}
        : { ticketDigest: record.ticketDigest }),
      reason: record.reason,
      retainUntil: record.retainUntil,
    };
  }
  if (record.t === "data-plane-ticket-retirement-frontier") {
    assertKeys(record, ["executorId", "retiredThrough", "t"]);
    assertProtocolIdentifier(
      record.executorId,
      "Ticket retirement frontier executor id",
    );
    if (typeof record.retiredThrough !== "string") {
      throw new TypeError("Ticket retirement frontier time is invalid");
    }
    assertCanonicalTime(record.retiredThrough, "Ticket retirement frontier time");
    return {
      t: "data-plane-ticket-retirement-frontier",
      executorId: record.executorId,
      retiredThrough: record.retiredThrough,
    };
  }
  throw new TypeError("Ticket registry record type is invalid");
}

function validateDataPlaneAssignmentBinding(
  input: unknown,
): DataPlaneAssignmentBinding {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError("Data-plane assignment activation must be a plain object");
  }
  const binding = input as Record<string, unknown>;
  assertKeys(binding, ["executorId", "ownerKeyId", "ref"]);
  assertProtocolIdentifier(
    binding.executorId,
    "Data-plane assignment activation executor id",
  );
  assertProtocolIdentifier(
    binding.ownerKeyId,
    "Data-plane assignment activation owner key id",
  );
  return {
    ref: binding.ref as ExecutionRef,
    executorId: binding.executorId,
    ownerKeyId: binding.ownerKeyId,
  };
}

function assertTicketActivation(
  ticket: DataPlaneTicket,
  activation: DataPlaneAssignmentBinding,
): void {
  assertDataPlaneTicketBinding(ticket, {
    assignmentId: ticket.assignmentId,
    ref: activation.ref,
    executorId: activation.executorId,
    surfacePrincipal: ticket.surfacePrincipal,
  });
  assertProtocolIdentifier(
    activation.ownerKeyId,
    "Data-plane assignment activation owner key id",
  );
  if (ticket.signature.keyId !== activation.ownerKeyId) {
    throw new TypeError("Data-plane ticket was not signed by the active assignment owner");
  }
}

function ticketActivationMatches(
  ticket: DataPlaneTicket,
  activation: DataPlaneAssignmentBinding,
): boolean {
  try {
    assertTicketActivation(ticket, activation);
    return true;
  } catch {
    return false;
  }
}

function compactTicketProjection(state: TicketRegistryProjection): void {
  const retiredThrough = state.retiredThrough;
  if (retiredThrough === undefined) return;
  const frontier = assertCanonicalTime(
    retiredThrough,
    "Ticket registry retirement frontier",
  );
  for (const [ticketId, retired] of state.retired) {
    if (Date.parse(retired.retainUntil) <= frontier) {
      state.retired.delete(ticketId);
    }
  }
}

function nextRetirementFrontier(
  state: TicketRegistryProjection,
  at: string,
): string | undefined {
  const observedAt = assertCanonicalTime(at, "Ticket registry observation time");
  let next = state.retiredThrough;
  for (const retired of state.retired.values()) {
    const retainUntil = Date.parse(retired.retainUntil);
    if (
      retainUntil <= observedAt &&
      (next === undefined || retainUntil > Date.parse(next))
    ) {
      next = retired.retainUntil;
    }
  }
  return next === state.retiredThrough ? undefined : next;
}

function projectionTime(
  state: TicketRegistryProjection,
  at: string,
): string {
  const observedAt = assertCanonicalTime(at, "Ticket registry observation time");
  const frontier =
    state.retiredThrough === undefined
      ? Number.NEGATIVE_INFINITY
      : assertCanonicalTime(
          state.retiredThrough,
          "Ticket registry retirement frontier",
        );
  return new Date(Math.max(observedAt, frontier)).toISOString();
}

function ticketPrecedesRetirementFrontier(
  ticket: DataPlaneTicket,
  state: TicketRegistryProjection,
): boolean {
  return (
    state.retiredThrough !== undefined &&
    Date.parse(ticket.expiry) <= Date.parse(state.retiredThrough)
  );
}

function assertRetiredTicketIdentity(
  retired: RetiredTicket,
  ticket: DataPlaneTicket,
): void {
  if (
    retired.assignmentId !== ticket.assignmentId ||
    (retired.ticketDigest !== undefined &&
      retired.ticketDigest !== dataPlaneTicketDigest(ticket))
  ) {
    throw new Error("Data-plane ticket id has conflicting signed payloads");
  }
}

function retentionDeadline(at: string): string {
  const timestamp = assertCanonicalTime(at, "Ticket retirement time");
  return new Date(timestamp + DATA_PLANE_TICKET_RETENTION_MS).toISOString();
}

function acceptedTicketExpiresAt(accepted: AcceptedTicket): string {
  return new Date(
    Date.parse(accepted.acceptedAt) + accepted.validForMs,
  ).toISOString();
}

function assertCanonicalTime(value: unknown, label: string): number {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    canonicalize(Object.keys(record).sort()) !==
    canonicalize([...keys].sort())
  ) {
    throw new TypeError("Ticket registry record fields are incomplete or unknown");
  }
}
