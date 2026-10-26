import { verifyProtocolStep } from "@zhixing/core/protocol";
import {
  createDurableProjectionOverlay,
  readDurableProjectionKeys,
  type AuthorityCommitLog,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
  type PhysicalStorageStepRunner,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
} from "@zhixing/core/authority";
import type {
  CommitEnvelope,
  DataPlaneTicket,
  ExecutionRef,
  JsonValue,
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

const MAINTENANCE_REVOCATION_BATCH = 8;
/** 一次退休追加至多这么多张过期票据；更多的分批，每批一笔事务。 */
const EXPIRY_RETIREMENT_BATCH = 32;
/** 退休前沿一步剪除的票据数；周期维护一轮至多推进这么多步，余量下一轮按耐久前沿续做。 */
const RETIREMENT_FRONTIER_BATCH = 32;
const MAINTENANCE_FRONTIER_STEPS = 8;
// 周期维护每轮至多退休这么多批过期票据（每批 EXPIRY_RETIREMENT_BATCH 张），余量下一轮续做
const MAINTENANCE_EXPIRY_BATCHES = 8;
/** 归约接受的单步上限（不小于写入方的批量），一条前沿记录的校验与剪除都不超过它。 */
const MAX_RETIREMENT_FRONTIER_BATCH = 128;

type TicketRegistryRecord =
  | {
      readonly t: "data-plane-ticket-revocation-completed";
      readonly assignmentId: string;
      readonly ticketId: string;
      /** null means the permanently reclaimed spool has no live generation. */
      readonly streamEpoch: number | null;
    }
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
      /** 恢复据以把已过期票据排除在外的时刻：耐久的时间下界，冷重开后“现在”不早于它。 */
      readonly t: "data-plane-ticket-observed-time";
      readonly executorId: string;
      readonly observedAt: string;
    }
  | {
      readonly t: "data-plane-ticket-retirement-frontier";
      readonly executorId: string;
      readonly retiredThrough: string;
      /**
       * 前沿停在 retiredThrough 这一保留期里的这张票据之后：同一保留期的大批票据分多步剪除。
       * 缺省表示这一保留期的票据全部剪除（只有时间的前沿）。
       */
      readonly throughTicketId?: string;
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
  readonly revocation?: { readonly streamEpoch: number | null };
}

/** 投影中一张票据的当前状态：在用（a）或已退休（r）。 */
type StoredTicket =
  | ({ readonly s: "a" } & AcceptedTicket)
  | ({ readonly s: "r" } & RetiredTicket);

/** 某一已验证位置上的票据视图：按 id 精确读取，退休前沿单独一键。 */
interface TicketView {
  ticket(ticketId: string): Promise<StoredTicket | undefined>;
  tickets(ticketIds: readonly string[]): Promise<readonly (StoredTicket | undefined)[]>;
  frontier(): Promise<string | undefined>;
  /** 全部在用票据（经到期索引定位）。 */
  accepted(): Promise<readonly AcceptedTicket[]>;
  /** 到期晚于 at 的在用票据（恢复只需要它们）。 */
  acceptedAfter(at: string): Promise<readonly AcceptedTicket[]>;
  /** 到期不晚于 at 的在用票据中，按到期时刻的前 limit 张。 */
  expiredThrough(at: string, limit: number): Promise<readonly AcceptedTicket[]>;
  /** 本日志重放出的时间前沿：已接纳票据的接纳时刻、恢复记下的观测时刻与退休前沿中最晚者。 */
  timeFrontier(): Promise<string | undefined>;
  /** 第一条满足条件、尚未完成资格撤销的退休票据。 */
  unrevoked(select: (entry: TicketIndexEntry) => boolean): Promise<TicketIndexEntry | undefined>;
  /** 截至 at 的下一个退休前沿（至多推进一批）；没有保留期已满的退休票据时为 undefined。 */
  nextFrontier(at: string): Promise<RetirementPosition | undefined>;
  retainedThrough(at: string): Promise<readonly RetainedTicketEntry[]>;
}

/** Signed ticket matches durable activation, but the assignment no longer permits active use. */
export class DataPlaneAssignmentInactiveError extends Error {
  constructor(readonly assignmentId: string, readonly ref: ExecutionRef) {
    super("Data-plane assignment no longer accepts active tickets");
    this.name = "DataPlaneAssignmentInactiveError";
  }
}

/** 票据恢复单次绑定查询的票据数上限（与账本的批量上限一致）。 */
const RECOVERY_BINDING_QUERY_LIMIT = 4096;

export interface DataPlaneAssignmentBinding {
  readonly ref: ExecutionRef;
  readonly executorId: string;
  readonly ownerKeyId: string;
}

export interface DataPlaneAssignmentBindingResolver {
  dataPlaneBindings?(requests: readonly { readonly assignmentId: string; readonly use?: DataPlaneTicketUse }[]): Promise<readonly (DataPlaneAssignmentBinding | undefined)[]>;
  dataPlaneBinding(
    assignmentId: string,
    use?: DataPlaneTicketUse,
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
  readonly #pendingRevocations = new Map<string, { assignmentId: string; streamEpoch: number | null }>();
  // 物理撤销已成功、完成回执尚未耐久的票据（票据 → 派发）。回执耐久后即淘汰，之后的幂等由退休行的
  // revocation 与未撤销目录承担；授权始终读耐久退休，新的登记表会补做全部未完成的撤销
  readonly #revokedConsumers = new Map<string, string>();
  readonly #projectionId: string;
  // 不可回退有效时钟的锚定：本进程任一次有效时钟观测值与当时的单调钟读数。“现在”取
  // max(墙钟, 锚定 + 单调流逝, 日志时间前沿)，日志时间前沿在每次读写时于锁内同一位置读取；
  // 墙钟回拨（包括先前跳再回拨）不让时间倒退，也不冻结在线时间
  #floor: { readonly wall: number; readonly monotonic: number };

  constructor(options: DataPlaneTicketRegistryOptions) {
    assertProtocolIdentifier(options.executorId, "Data-plane registry executor id");
    this.#log = options.log;
    this.#executorId = options.executorId;
    this.#verifier = options.verifier;
    this.#assignments = options.assignments;
    this.#spool = options.spool;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.#floor = { wall: Date.parse(this.#clock()), monotonic: this.#monotonicClock() };
    // 生产装配在首次写入前已登记同一定义；直接构造（测试、新 home）在此登记，重复登记幂等
    registerDataPlaneTicketProjection(this.#log, this.#verifier, this.#executorId);
    this.#projectionId = dataPlaneTicketProjectionId(this.#executorId);
  }

  async accept(input: unknown): Promise<DataPlaneTicket> {
    await this.maintain(undefined, 0, 0, 0);
    const ticket = (await verifyProtocolStep(() => validateDataPlaneTicket(input, this.#verifier)));
    if (ticket.executorId !== this.#executorId) {
      throw new TypeError("Data-plane ticket targets a different executor");
    }
    await this.#operations.run(async () => {
      const projected = await this.#read(async view => ({ existing: await view.ticket(ticket.ticketId), frontier: await view.frontier(), at: this.#nowIso() }));
      const existing = projected.existing;
      if (existing?.s === "a") {
        if (canonicalize(existing.ticket) !== canonicalize(ticket)) {
          throw new Error("Data-plane ticket id has conflicting signed payloads");
        }
        await this.#restoreAcceptedConsumer(existing, true);
        return;
      }
      if (existing?.s === "r") {
        assertRetiredTicketIdentity(existing, ticket);
        if (ticket.kind !== "abort") await this.#revokeConsumer(ticket);
        return;
      }
      // 有效时钟（不早于退休前沿与时间前沿），跨端的签发时间与 TTL 照偏差窗换算
      const observedAt = projected.at;
      const interval = acceptedRemoteIntervalStatus({
        issuedAt: ticket.issuedAt,
        expiry: ticket.expiry,
        acceptedAt: observedAt,
        maxTtlMs: MAX_DATA_PLANE_TICKET_TTL_MS,
      });
      if (
        interval.kind === "expired" ||
        ticketPrecedesRetirementFrontier(ticket, projected.frontier)
      ) {
        if (!ticketPrecedesRetirementFrontier(ticket, projected.frontier)) {
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
        const inactive = await this.#assignments.dataPlaneBinding(ticket.assignmentId, "observe");
        if (inactive) {
          assertTicketActivation(ticket, inactive);
          throw new DataPlaneAssignmentInactiveError(ticket.assignmentId, ticket.ref);
        }
        throw new Error("Data-plane ticket has no durable assignment activation");
      }
      assertTicketActivation(ticket, binding);
      const transaction = await this.#transact<{
        readonly accepted?: AcceptedTicket;
        readonly existing: boolean;
        readonly retired: boolean;
      }>(async (view) => {
        const current = await view.ticket(ticket.ticketId), frontier = await view.frontier();
        if (current?.s === "a") {
          if (
            canonicalize(current.ticket) !== canonicalize(ticket) ||
            canonicalize(current.activation) !== canonicalize(binding)
          ) {
            throw new Error("Data-plane ticket id has conflicting signed payloads");
          }
          return {
            kind: "return",
            value: { accepted: acceptedOf(current), existing: true, retired: false },
          };
        }
        if (current?.s === "r") {
          assertRetiredTicketIdentity(current, ticket);
          return {
            kind: "return",
            value: { existing: true, retired: true },
          };
        }
        // 锁内同一位置的有效时钟：落盘的接纳时刻就是这次决定所用的时间，归约把它并入时间前沿
        const acceptedAt = this.#nowIso();
        const currentInterval = acceptedRemoteIntervalStatus({
          issuedAt: ticket.issuedAt,
          expiry: ticket.expiry,
          acceptedAt,
          maxTtlMs: MAX_DATA_PLANE_TICKET_TTL_MS,
        });
        if (
          currentInterval.kind === "expired" ||
          ticketPrecedesRetirementFrontier(ticket, frontier)
        ) {
          if (ticketPrecedesRetirementFrontier(ticket, frontier)) {
            return {
              kind: "return",
              value: { existing: false, retired: true },
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
            value: { existing: false, retired: true },
          };
        }
        const accepted: AcceptedTicket = {
          ticket,
          activation: binding,
          acceptedAt,
          validForMs: currentInterval.remainingMs,
        };
        return {
          kind: "append",
          entries: [
            ticketRecord(ticket.assignmentId, {
              t: "data-plane-ticket-accepted",
              ...accepted,
            }),
          ],
          value: { accepted, existing: false, retired: false },
        };
      });
      if (transaction.value.retired) {
        if (ticket.kind !== "abort") await this.#revokeConsumer(ticket);
        return;
      }
      const accepted = transaction.value.accepted!;
      if (!transaction.value.existing) {
        this.#revokedConsumers.delete(ticket.ticketId);
        this.#pendingRevocations.delete(ticket.ticketId);
      }
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
    await this.maintain(undefined, 0, 0, 0);
    assertProtocolIdentifier(input.assignmentId, "Ticket revocation assignment id");
    assertProtocolIdentifier(input.ticketId, "Ticket revocation ticket id");
    return this.#operations.run(async () => {
      let ticket: DataPlaneTicket | undefined;
      const transaction = await this.#transact<boolean>(async (view) => {
        const current = await view.ticket(input.ticketId);
        ticket = current?.s === "a" ? current.ticket : undefined;
        if (ticket && ticket.assignmentId !== input.assignmentId) {
          throw new Error("Ticket revocation binds a different assignment");
        }
        if (current?.s === "r") {
          if (current.assignmentId !== input.assignmentId) {
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
              retainUntil: retentionDeadline(this.#nowIso()),
            }),
          ],
          value: true,
        };
      });
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
    const ticket = await this.#operations.run(() => this.#currentTicket(ticketId));
    if (!ticket) throw new Error("Data-plane ticket is unknown");
    return this.authorize(ticketId, use, {
      assignmentId,
      ref: ticket.ref,
      executorId: ticket.executorId,
      surfacePrincipal,
    });
  }

  /**
   * Authorizes a channel surface represented by the assignment owner.
   *
   * The authenticated owner connection is only a transport representative. The
   * signed ticket remains the source of the surface identity, so callers cannot
   * replace a channel principal with the owner device principal.
   */
  async authorizeOwnerPresentedSurface(
    ticketId: string,
    use: DataPlaneTicketUse,
    assignmentId: string,
  ): Promise<AuthorizedDataPlaneTicket> {
    const ticket = await this.#operations.run(() => this.#currentTicket(ticketId));
    if (!ticket) throw new Error("Data-plane ticket is unknown");
    return this.authorize(ticketId, use, {
      assignmentId,
      ref: ticket.ref,
      executorId: ticket.executorId,
      surfacePrincipal: ticket.surfacePrincipal,
    });
  }

  /** 精确读取一张票据：已退休即拒绝，未知返回 undefined。 */
  async #currentTicket(ticketId: string): Promise<DataPlaneTicket | undefined> {
    const current = await this.#read(view => view.ticket(ticketId));
    if (current?.s === "r") throw new Error("Data-plane ticket is retired");
    return current?.ticket;
  }

  async recover(): Promise<void> {
    await this.maintain(undefined, 0, 0, 0);
    await this.#operations.run(async () => {
      // 只读尚未到期的在用票据（经到期索引定位），不回放历史；已过期未退休的积压不进恢复，
      // 对它的访问由授权按有效时钟判过期拒绝，退休由周期维护按批续做。排除所依据的时刻先耐久记下
      const at = await this.#read(async () => this.#nowIso());
      await this.#recordObservedTime(at);
      const entries = await this.#read(view => view.acceptedAfter(at));
      const recovered = new Map<string, StoredTicket>(entries.map(entry => [entry.ticket.ticketId, { s: "a", ...entry }]));
      const pending = new Set<Promise<void>>();
      let failed = false;
      let failure: unknown;
      const fail = (error: unknown) => { if (!failed) { failed = true; failure = error; } };
      // 一次查询全部有效票据的分派绑定：账本只为新出现或有新记录的分派回放日志，不按批反复整遍回放。
      let allBindings: (DataPlaneAssignmentBinding | undefined)[] | undefined;
      if (this.#assignments.dataPlaneBindings) {
        allBindings = [];
        for (let offset = 0; offset < entries.length; offset += RECOVERY_BINDING_QUERY_LIMIT) {
          const chunk = entries.slice(offset, offset + RECOVERY_BINDING_QUERY_LIMIT);
          const result = await this.#assignments.dataPlaneBindings(chunk.map(entry => ({ assignmentId: entry.ticket.assignmentId,
            use: entry.ticket.kind === "abort" ? "abort" as const : "observe" as const })));
          if (result.length !== chunk.length) throw new Error("Assignment binding batch length mismatch");
          allBindings.push(...result);
        }
      }
      try {
        for (let offset = 0; offset < entries.length && !failed; offset += 32) {
          const batch = entries.slice(offset, offset + 32);
          const bindings = allBindings?.slice(offset, offset + batch.length);
          if (bindings) {
            const retirements = batch.flatMap((entry, index) => {
              const reason = this.#retirementReason(entry, bindings[index]);
              return reason ? [{ assignmentId: entry.ticket.assignmentId, ticketId: entry.ticket.ticketId, reason }] : [];
            });
            if (retirements.length) {
              await Promise.all(pending);
              if (failed) break;
              // The registry queue owns this immutable binding batch. Publish
              // its retirements in one authority transaction before effects.
              await this.#appendRetirements(retirements);
              for (const { assignmentId, ticketId, reason } of retirements) recovered.set(ticketId, recoveryRetired(assignmentId, reason));
            }
          }
          const groups = new Map<string, { ticket: DataPlaneTicket; expiresAt: string }[]>();
          const qualifyGroups = async () => {
            for (const group of groups.values()) {
              if (failed) break;
              const first = group[0]!;
              const work = this.#spool.deferRecoveredConsumers({ assignmentId: first.ticket.assignmentId, ref: first.ticket.ref,
                consumers: group.map(({ ticket, expiresAt }) => ({ consumer: surfaceConsumer(ticket.ticketId), expiresAt })) }).then(() => {}, fail);
              pending.add(work); void work.then(() => pending.delete(work));
              if (pending.size >= 4) await Promise.race(pending);
            }
            groups.clear();
          };
          for (const [index, entry] of batch.entries()) {
            if (failed) break;
            const authorization = await this.#authorizeUnlocked(entry.ticket.ticketId,
              entry.ticket.kind === "abort" ? "abort" : "observe",
              { assignmentId: entry.ticket.assignmentId, ref: entry.ticket.ref, executorId: entry.ticket.executorId,
                surfacePrincipal: entry.ticket.surfacePrincipal }, recovered,
              bindings ? { value: bindings[index] } : undefined);
            if (entry.ticket.kind === "abort") continue;
            // 授权已失效的票据不在启动路径上做物理撤销：访问一律以耐久退休为准拒绝，
            // spool 上的资格撤销只影响保留回收，由有界的周期维护补齐，不随过期票据数拖慢就绪。
            if (authorization.kind !== "authorized") continue;
            if (failed) break;
            const key = canonicalize({ assignmentId: entry.ticket.assignmentId, ref: entry.ticket.ref });
            const group = groups.get(key) ?? [];
            group.push({ ticket: entry.ticket, expiresAt: authorization.value.expiresAt }); groups.set(key, group);
          }
          await qualifyGroups();
        }
      } catch (error) { fail(error); }
      // No background writes may outlive recovery or a failed startup.
      await Promise.all(pending);
      if (failed) throw failure;
    });
  }

  /**
   * 退休已过期票据并推进退休前沿：`expiryBatches` 限定本轮过期退休的批数（每批至多 EXPIRY_RETIREMENT_BATCH 张），
   * `physicalRevocations` 限定本轮补做的 spool 资格撤销数，`frontierSteps` 限定本轮推进前沿的步数（每步至多剪除
   * RETIREMENT_FRONTIER_BATCH 张）。签发、撤销与恢复路径内联调用时都传 0：访问由授权按有效时钟与耐久退休判定，
   * 过期票据即时拒绝；过期退休、资格撤销与已退休历史的剪除只影响回收，交给有界的周期维护按耐久状态续做，
   * 不随过期或已退休票据数拖慢就绪或首次签发。
   */
  async maintain(
    runPhysicalStep?: PhysicalStorageStepRunner,
    physicalRevocations = MAINTENANCE_REVOCATION_BATCH,
    frontierSteps = MAINTENANCE_FRONTIER_STEPS,
    expiryBatches = MAINTENANCE_EXPIRY_BATCHES,
  ): Promise<number> {
    // 容量准入由调用方经 runPhysicalStep 提供,在 registry 串行段内、退休
    // 事务批(耐久追加 + 前沿推进)前取得;permit 绝不横跨串行队列等待。
    const step = runPhysicalStep ?? ((operation) => operation());
    let expired = 0;
    for (let batches = 0; batches < expiryBatches; batches += 1) {
      // 过期票据分批退休：一笔事务至多 EXPIRY_RETIREMENT_BATCH 张，批与批之间让出登记表队列
      const retired = await this.#operations.run(() => step(() => this.#retireExpiredBatch()));
      if (retired === undefined) break;
      expired += retired;
    }
    // 物理撤销逐个排入登记表队列：前台签发与授权最多等一次撤销，不等整批；余量留给下一轮。
    for (let revocations = 0; revocations < physicalRevocations; revocations += 1) {
      const revoked = await this.#operations.run(() => step(async () => {
        const next = await this.#read(view => view.unrevoked(entry => this.#revokedConsumers.get(entry.ticketId) !== entry.assignmentId));
        if (!next) return false;
        await this.#revokeConsumerIdentity(next.assignmentId, next.ticketId, true);
        return true;
      }));
      if (!revoked) break;
    }
    await this.#operations.run(() => step(() => this.#flushRevocations()));
    // 前沿每步一笔事务、至多剪除一批，按耐久前沿续做；本轮步数用完的余量留给下一轮
    for (let steps = 0; steps < frontierSteps; steps += 1) {
      const advanced = await this.#operations.run(() => step(async () => (await this.#transact<boolean>(async (view, context) => {
        // 只用落盘证据：本交易时间与这一位置的时间前沿（与归约校验同口径，可重放）
        const next = await view.nextFrontier(laterIso(context.at, await view.timeFrontier()));
        return next === undefined
          ? { kind: "return", value: false }
          : { kind: "append", entries: [retirementFrontierRecord(this.#executorId, next)], value: true };
      })).value));
      if (!advanced) break;
    }
    return expired;
  }

  /**
   * 退休一批已过期的票据；没有到期的返回 undefined。候选是到期索引里截至有效时钟“现在”的一页
   * （按到期时刻升序，不整读在用票据）；有效时钟不回退，墙钟回拨后照样选得到。
   */
  async #retireExpiredBatch(): Promise<number | undefined> {
    const due = (await this.#read(view => view.expiredThrough(this.#nowIso(), EXPIRY_RETIREMENT_BATCH)))
      .map(accepted => accepted.ticket.ticketId);
    if (due.length === 0) return undefined;
    const transaction = await this.#transact<readonly DataPlaneTicket[]>(
      async (view) => {
      const tickets = (await view.tickets(due)).flatMap(entry => entry?.s === "a" ? [entry.ticket] : []);
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
              this.#nowIso(),
            ),
          }),
        ),
        value: tickets,
      };
      },
    );
    return transaction.value.length;
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
    recovered?: Map<string, StoredTicket>,
    recoveredBinding?: { readonly value: DataPlaneAssignmentBinding | undefined },
  ): Promise<TicketAuthorizationDisposition> {
    // Recovery alone holds the registry queue across the entire batch and keeps
    // its snapshot current; public authorization reads the verified projection.
    const accepted = recovered ? recovered.get(ticketId) : await this.#read(view => view.ticket(ticketId));
    if (accepted?.s === "r") {
      return { kind: "retired" };
    }
    if (!accepted) return { kind: "unknown" };
    assertDataPlaneTicketUse(accepted.ticket, use);
    assertDataPlaneTicketBinding(accepted.ticket, binding);
    const currentActivation = recoveredBinding ? recoveredBinding.value : await this.#assignments.dataPlaneBinding(
      accepted.ticket.assignmentId,
      use,
    );
    const reason = this.#retirementReason(accepted, currentActivation);
    if (reason) {
      await this.#appendRetirement(accepted.ticket.assignmentId, ticketId, reason);
      recovered?.set(ticketId, recoveryRetired(accepted.ticket.assignmentId, reason));
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

  #retirementReason(accepted: AcceptedTicket, current: DataPlaneAssignmentBinding | undefined): TicketRetirementReason | undefined {
    if (!current || !ticketActivationMatches(accepted.ticket, accepted.activation) || canonicalize(current) !== canonicalize(accepted.activation)) return "invalidated";
    // 有效时钟早于接纳时刻（日志证据不足以确认）按过期处理，失败关闭
    const now = this.#now();
    if (now < Date.parse(accepted.acceptedAt) || now >= Date.parse(acceptedTicketExpiresAt(accepted))) return "expired";
    return undefined;
  }

  async #qualify(ticket: DataPlaneTicket, expiresAt: string): Promise<void> {
    await this.#spool.qualifyConsumer({
      assignmentId: ticket.assignmentId,
      ref: ticket.ref,
      consumer: surfaceConsumer(ticket.ticketId),
      expiresAt,
    });
  }

  /** 截止与到期选择用的“现在”：不早于已观察到的时间下界加单调钟流逝；求值后下界推进到这个值。 */
  #now(): number {
    const monotonic = this.#monotonicClock();
    const now = Math.max(Date.parse(this.#clock()), this.#floor.wall + (monotonic - this.#floor.monotonic));
    this.#floor = { wall: now, monotonic };
    return now;
  }

  /** 在当前读写的已验位置读日志时间前沿，把有效时钟的锚定抬到它。 */
  async #absorb(view: TicketView): Promise<void> {
    const frontier = await view.timeFrontier();
    if (frontier === undefined) return;
    const at = Date.parse(assertCanonicalIso(frontier));
    if (at > this.#now()) this.#floor = { wall: at, monotonic: this.#monotonicClock() };
  }

  /**
   * 恢复按时刻 at 把已过期票据排除在外时，在票据域记下这一时间下界（固定一行），冷重开后时间不早于它。
   * 只在确有被排除的过期票据、且 at 晚于已存下界时追加一条，不逐张写退休。
   */
  async #recordObservedTime(at: string): Promise<void> {
    await this.#transact<void>(async view => {
      const frontier = await view.timeFrontier();
      if (frontier !== undefined && Date.parse(frontier) >= Date.parse(at)) return { kind: "return", value: undefined };
      if ((await view.expiredThrough(at, 1)).length === 0) return { kind: "return", value: undefined };
      return { kind: "append", entries: [observedTimeRecord(this.#executorId, at)], value: undefined };
    });
  }

  #nowIso(): string {
    return new Date(this.#now()).toISOString();
  }

  async #appendRetirement(
    assignmentId: string,
    ticketId: string,
    reason: TicketRetirementReason,
    ticketDigest?: string,
  ): Promise<void> {
    return this.#appendRetirements([{ assignmentId, ticketId, reason, ticketDigest }]);
  }

  async #appendRetirements(retirements: readonly { assignmentId: string; ticketId: string; reason: TicketRetirementReason; ticketDigest?: string }[]): Promise<void> {
    if (retirements.length > 32) throw new TypeError("Ticket retirement batch exceeds 32");
    await this.#transact<void>(async (view) => {
      const current = await view.tickets(retirements.map(({ ticketId }) => ticketId));
      const entries: { stream: string; body: TicketRegistryRecord }[] = [];
      for (const [index, { assignmentId, ticketId, reason, ticketDigest }] of retirements.entries()) {
        const stored = current[index];
        const accepted = stored?.s === "a" ? stored : undefined, retired = stored?.s === "r" ? stored : undefined;
        if (accepted && accepted.ticket.assignmentId !== assignmentId || retired && retired.assignmentId !== assignmentId) {
          throw new Error("Ticket retirement binds a different assignment");
        }
        if (retired) continue;
        const digest = ticketDigest ?? (accepted === undefined ? undefined : dataPlaneTicketDigest(accepted.ticket));
        entries.push(ticketRecord(assignmentId, {
          t: "data-plane-ticket-retired", assignmentId, ticketId,
          ...(digest === undefined ? {} : { ticketDigest: digest }), reason,
          retainUntil: retentionDeadline(this.#nowIso()),
        }));
      }
      return entries.length ? { kind: "append", entries, value: undefined } : { kind: "return", value: undefined };
    });
  }

  async #revokeConsumer(ticket: DataPlaneTicket): Promise<void> {
    await this.#revokeConsumerIdentity(ticket.assignmentId, ticket.ticketId);
  }

  async #revokeConsumerIdentity(
    assignmentId: string,
    ticketId: string,
    deferCompletion = false,
  ): Promise<void> {
    if (this.#revokedConsumers.get(ticketId) === assignmentId) return;
    const retired = await this.#read(view => view.ticket(ticketId));
    if (retired?.s === "r" && retired.assignmentId === assignmentId && retired.revocation) return;
    const result = await this.#spool.revokeConsumer({
      assignmentId,
      consumer: surfaceConsumer(ticketId),
    });
    const consumer = result?.consumers.find(value => value.key === `surface:${ticketId}`);
    if (result && result.assignmentId !== assignmentId || consumer?.qualified) {
      throw new Error('Consumer revocation did not settle the matching stream consumer');
    }
    // Failed effects retain their obligation; success cannot requalify this
    // ticket because its immutable retirement is already authoritative.
    const settled = await this.#read(view => view.ticket(ticketId));
    if (settled?.s === "r" && settled.assignmentId === assignmentId) {
      this.#revokedConsumers.set(ticketId, assignmentId);
      this.#pendingRevocations.set(ticketId, { assignmentId, streamEpoch: consumer?.streamEpoch ?? null });
      if (!deferCompletion) await this.#flushRevocations();
    }
  }

  async #flushRevocations(): Promise<void> {
    while (this.#pendingRevocations.size) {
      const batch = [...this.#pendingRevocations].slice(0, 32);
      await this.#transact<void>(async view => {
        const current = await view.tickets(batch.map(([ticketId]) => ticketId));
        const entries = batch.flatMap(([ticketId, receipt], index) => {
          const retired = current[index];
          if (retired?.s !== "r" || retired.revocation) return [];
          if (retired.assignmentId !== receipt.assignmentId) throw Error('Revocation completion changed assignment');
          return [ticketRecord(receipt.assignmentId, { t: 'data-plane-ticket-revocation-completed', ticketId, ...receipt })];
        });
        return entries.length ? { kind: 'append', entries, value: undefined } : { kind: 'return', value: undefined };
      });
      // 交易已提交：这一批的回执要么本次写入，要么此前已耐久，要么票据已不在退休状态，进程标记都不再需要；
      // 交易抛错（结果未知）时走不到这里，标记与待写回执都保留待重试
      for (const [ticketId, receipt] of batch) {
        if (this.#pendingRevocations.get(ticketId) === receipt) this.#pendingRevocations.delete(ticketId);
        if (this.#revokedConsumers.get(ticketId) === receipt.assignmentId) this.#revokedConsumers.delete(ticketId);
      }
    }
  }

  /** 在当前已验证位置读取票据视图，不做追加决定；先按这一位置的时间前沿校准有效时钟。 */
  async #read<Value>(read: (view: TicketView) => Promise<Value>): Promise<Value> {
    const result = await this.#log.transactDurableProjection<TicketRegistryRecord, Value>(
      this.#projectionId,
      async current => {
        const view = ticketView(current);
        await this.#absorb(view);
        return { kind: "return", value: await read(view) };
      },
    );
    return result.value;
  }

  /** 在同一已验证位置读取票据视图并决定是否追加；记录由投影在提交时一并归约。 */
  async #transact<Value>(
    decide: (
      view: TicketView,
      context: ProjectionTransactionContext,
    ) => Promise<ProjectionTransactionDecision<TicketRegistryRecord, Value>>,
  ) {
    return this.#log.transactDurableProjection<TicketRegistryRecord, Value>(
      this.#projectionId,
      async (current, context) => {
        const view = ticketView(current);
        await this.#absorb(view);
        return decide(view, context);
      },
    );
  }
}

const TICKET_PREFIX = "t:";
const EXPIRY_PREFIX = "x:";
const RETAIN_PREFIX = "k:";
const UNREVOKED_PREFIX = "u:";
const FRONTIER_KEY = "f";
const TIME_FRONTIER_KEY = "o";
// 2：归约另维护时间前沿行（接纳时刻、观测时刻、退休前沿取最晚）
const TICKET_INDEX_REDUCER_VERSION = 2;

/**
 * 票据登记表投影。按执行端身份各一份（退休前沿只认本执行端的流），与原先每个登记表实例的
 * 状态口径一致：票据按 id 精确定位；在用票据带到期索引，已退休票据带保留期索引与未完成的
 * 资格撤销义务。前沿推进时剪除保留期已满的退休票据，投影只含有效期窗口内的票据，不随历史增长。
 */
export function dataPlaneTicketProjectionId(executorId: string): string {
  assertProtocolIdentifier(executorId, "Data-plane registry executor id");
  return `data-plane-ticket-registry-v1:${executorId}`;
}

export function registerDataPlaneTicketProjection(
  log: AuthorityCommitLog,
  verifier: ProtocolSignatureVerifier,
  executorId: string,
) {
  return log.durableProjection<TicketRegistryRecord>({
    projectionId: dataPlaneTicketProjectionId(executorId),
    reducerVersion: TICKET_INDEX_REDUCER_VERSION,
    authenticated: true,
    inputs: { families: ["assignment:"], streams: [retirementFrontierStream(executorId)] },
    reduce: (envelope, current) => reduceTicketIndex(envelope, current, executorId, verifier),
  });
}

interface TicketIndexEntry {
  readonly ticketId: string;
  readonly assignmentId: string;
}

interface RetainedTicketEntry {
  readonly ticketId: string;
  readonly retainUntil: string;
}

/** 退休前沿的位置：保留期，以及（分步剪除时）这一保留期里最后剪除的票据。 */
interface RetirementPosition {
  readonly retiredThrough: string;
  readonly throughTicketId?: string;
}

function ticketView(current: DurableProjectionReadContext): TicketView & {
  accepted(): Promise<readonly AcceptedTicket[]>;
  unrevoked(select: (entry: TicketIndexEntry) => boolean): Promise<TicketIndexEntry | undefined>;
  nextFrontier(at: string): Promise<RetirementPosition | undefined>;
  retainedThrough(at: string): Promise<readonly RetainedTicketEntry[]>;
  retainedUpTo(through: RetirementPosition, limit: number): Promise<readonly RetainedTicketEntry[]>;
} {
  const tickets = async (ticketIds: readonly string[]) => {
    const values: (StoredTicket | undefined)[] = [];
    for (let offset = 0; offset < ticketIds.length; offset += 256) {
      const page = await readDurableProjectionKeys(current, ticketIds.slice(offset, offset + 256).map(id => TICKET_PREFIX + id));
      values.push(...page as unknown as (StoredTicket | undefined)[]);
    }
    return values;
  };
  type Lower = { readonly gte: string } | { readonly gt: string };
  const below = (lower: Lower, lt: string) => ("gte" in lower ? lower.gte : lower.gt) < lt;
  const scanAll = async <T>(lower: Lower, lt: string): Promise<T[]> => {
    const values: T[] = [];
    let continuation: string | undefined;
    do {
      const page = await current.scan({ ...lower, lt }, 256, continuation);
      values.push(...page.entries.map(entry => entry.value as unknown as T));
      continuation = page.continuation;
    } while (continuation);
    return values;
  };
  const position = async () => (await current.get(FRONTIER_KEY)) as RetirementPosition | undefined;
  const frontier = async () => (await position())?.retiredThrough;
  // 在用票据的到期时刻与退休票据的保留期都晚于退休前沿；时间序的键从前沿之后起扫，
  // 被剪除历史留下的墓碑不进入扫描范围，读取只与保留窗口内的票据有关。前沿停在某一保留期
  // 中间时，按保留期排序的键（保留、未撤销）从那张票据之后起扫
  const after = async (prefix: string): Promise<Lower> => {
    const at = await position();
    if (at === undefined) return { gte: prefix };
    return at.throughTicketId !== undefined && prefix !== EXPIRY_PREFIX
      ? { gt: `${prefix}${at.retiredThrough}:${at.throughTicketId}` }
      : { gte: `${prefix}${at.retiredThrough};` };
  };
  /** 前沿之后、保留期不晚于 at 的退休票据，按保留期与票据 id 升序，至多 limit 条（读够即交还续读）。 */
  const retainedPage = async (at: string, limit: number) => {
    const lower = await after(RETAIN_PREFIX), lt = `${RETAIN_PREFIX}${at};`;
    // 墙钟回拨到前沿之前：没有保留期已满的退休票据
    if (!below(lower, lt)) return [];
    const page = await current.scan({ ...lower, lt }, limit);
    if (page.continuation) current.releaseContinuation?.(page.continuation);
    return page.entries.map(entry => entry.value as unknown as RetainedTicketEntry);
  };
  const retainedThrough = async (at: string) => {
    const lower = await after(RETAIN_PREFIX), lt = `${RETAIN_PREFIX}${at};`;
    return below(lower, lt) ? scanAll<RetainedTicketEntry>(lower, lt) : [];
  };
  /** 前沿之后直到 through（含）的保留项，按页读、见到 through 即停，至多读 limit 条；through 不在其中时返回读到的全部。 */
  const retainedUpTo = async (through: RetirementPosition, limit: number) => {
    const lower = await after(RETAIN_PREFIX), lt = `${RETAIN_PREFIX}${through.retiredThrough};`;
    if (!below(lower, lt)) return [];
    const entries: RetainedTicketEntry[] = [];
    let continuation: string | undefined;
    do {
      const page = await current.scan({ ...lower, lt }, Math.min(RETIREMENT_FRONTIER_BATCH, limit - entries.length), continuation);
      continuation = page.continuation;
      for (const entry of page.entries) {
        const value = entry.value as unknown as RetainedTicketEntry;
        entries.push(value);
        if (value.retainUntil === through.retiredThrough && value.ticketId === through.throughTicketId) {
          if (continuation) current.releaseContinuation?.(continuation);
          return entries;
        }
      }
    } while (continuation && entries.length < limit);
    if (continuation) current.releaseContinuation?.(continuation);
    return entries;
  };
  return {
    ticket: async ticketId => (await current.get(TICKET_PREFIX + ticketId)) as unknown as StoredTicket | undefined,
    tickets,
    frontier,
    timeFrontier: async () => (await current.get(TIME_FRONTIER_KEY)) as string | undefined,
    async accepted() {
      const ids = (await scanAll<TicketIndexEntry>(await after(EXPIRY_PREFIX), `${EXPIRY_PREFIX}\uffff`)).map(entry => entry.ticketId);
      return (await tickets(ids)).flatMap(entry => entry?.s === "a" ? [acceptedOf(entry)] : []);
    },
    // 到期晚于 at 的在用票据：到期索引按时刻升序，从 at 之后起扫（键 x:<到期>:<id> 在 x:<at>; 之后即晚于 at）
    async acceptedAfter(at) {
      assertCanonicalTime(at, "Ticket registry observation time");
      const lower = await after(EXPIRY_PREFIX);
      const from = `${EXPIRY_PREFIX}${at};`;
      const start: Lower = "gte" in lower && lower.gte > from ? lower : { gte: from };
      const ids = (await scanAll<TicketIndexEntry>(start, `${EXPIRY_PREFIX}\uffff`)).map(entry => entry.ticketId);
      return (await tickets(ids)).flatMap(entry => entry?.s === "a" ? [acceptedOf(entry)] : []);
    },
    // 到期不晚于 at 的在用票据中按到期时刻的前 limit 张（读够即交还续读）
    async expiredThrough(at, limit) {
      assertCanonicalTime(at, "Ticket registry observation time");
      const lower = await after(EXPIRY_PREFIX), lt = `${EXPIRY_PREFIX}${at};`;
      if (!below(lower, lt)) return [];
      const page = await current.scan({ ...lower, lt }, limit);
      if (page.continuation) current.releaseContinuation?.(page.continuation);
      const ids = page.entries.map(entry => (entry.value as unknown as TicketIndexEntry).ticketId);
      return (await tickets(ids)).flatMap(entry => entry?.s === "a" ? [acceptedOf(entry)] : []);
    },
    async unrevoked(select) {
      const lower = await after(UNREVOKED_PREFIX);
      let continuation: string | undefined;
      do {
        const page = await current.scan({ ...lower, lt: `${UNREVOKED_PREFIX}\uffff` }, 64, continuation);
        const found = page.entries.map(entry => entry.value as unknown as TicketIndexEntry).find(select);
        if (found) {
          if (page.continuation) current.releaseContinuation?.(page.continuation);
          return found;
        }
        continuation = page.continuation;
      } while (continuation);
      return undefined;
    },
    // 前沿的下一步：前沿之后、保留期已满（不晚于 at）的退休票据里按次序的前一批，停在这一批的最后一张
    async nextFrontier(at) {
      assertCanonicalTime(at, "Ticket registry observation time");
      const last = (await retainedPage(at, RETIREMENT_FRONTIER_BATCH)).at(-1);
      return last ? { retiredThrough: last.retainUntil, throughTicketId: last.ticketId } : undefined;
    },
    retainedThrough,
    retainedUpTo,
  };
}

function acceptedOf(entry: AcceptedTicket): AcceptedTicket {
  return { ticket: entry.ticket, activation: entry.activation, acceptedAt: entry.acceptedAt, validForMs: entry.validForMs };
}

/** 恢复快照里的退休标记：恢复路径只区分在用与已退休。 */
function recoveryRetired(assignmentId: string, reason: TicketRetirementReason): StoredTicket {
  return { s: "r", assignmentId, reason, retainUntil: new Date(0).toISOString() };
}

async function reduceTicketIndex(
  envelope: CommitEnvelope<TicketRegistryRecord>,
  current: DurableProjectionReadContext,
  executorId: string,
  verifier: ProtocolSignatureVerifier,
): Promise<readonly DurableProjectionMutation[]> {
  const frontierStream = retirementFrontierStream(executorId);
  // 同一信封内的多条记录依次归约，后一条读到前一条的结果
  const changes = new Map<string, JsonValue | undefined>();
  const view = ticketView(createDurableProjectionOverlay(current, changes));
  const put = (key: string, value: unknown) => changes.set(key, value as JsonValue);
  const drop = (key: string) => changes.set(key, undefined);
  // 时间前沿只增不减：接纳时刻、观测时刻与退休前沿都是这一权威日志的时间证据
  const advanceTimeFrontier = async (at: string) => {
    const stored = await view.timeFrontier();
    if (stored === undefined || Date.parse(at) > Date.parse(stored)) put(TIME_FRONTIER_KEY, at);
  };
  for (const logical of envelope.entries) {
    if (
      !logical.stream.endsWith(":data-plane-tickets") &&
      logical.stream !== frontierStream
    ) {
      continue;
    }
    const record = validateTicketRegistryRecord(logical.body, verifier);
    if (record.t === "data-plane-ticket-observed-time") {
      if (record.executorId !== executorId || logical.stream !== frontierStream) {
        throw new TypeError("Ticket observed time is stored in the wrong logical stream");
      }
      // 只增不减：较早的时刻不降低时间前沿
      await advanceTimeFrontier(record.observedAt);
      continue;
    }
    if (record.t === "data-plane-ticket-retirement-frontier") {
      if (record.executorId !== executorId || logical.stream !== frontierStream) {
        throw new TypeError(
          "Ticket retirement frontier is stored in the wrong logical stream",
        );
      }
      // 与决定同口径：交易时间与这一位置的时间前沿取晚者
      const at = laterIso(assertCanonicalIso(envelope.at), await view.timeFrontier());
      let retained: readonly RetainedTicketEntry[];
      if (record.throughTicketId === undefined) {
        // 只有时间的前沿：这一保留期之前的全部剪除
        retained = await view.retainedThrough(at);
        if (laterFrontier(retained.at(-1)?.retainUntil, await view.frontier()) !== record.retiredThrough) {
          throw new TypeError("Ticket retirement frontier is not the next durable boundary");
        }
      } else {
        // 分步前沿：从当前前沿之后到它（含）是一段连续的、保留期已满的退休票据，条数有上限
        retained = await view.retainedUpTo(record, MAX_RETIREMENT_FRONTIER_BATCH + 1);
        const last = retained.at(-1);
        if (!last || retained.length > MAX_RETIREMENT_FRONTIER_BATCH || last.ticketId !== record.throughTicketId ||
            last.retainUntil !== record.retiredThrough || Date.parse(record.retiredThrough) > Date.parse(at)) {
          throw new TypeError("Ticket retirement frontier is not the next durable boundary");
        }
      }
      await advanceTimeFrontier(record.retiredThrough);
      put(FRONTIER_KEY, {
        retiredThrough: record.retiredThrough,
        ...(record.throughTicketId === undefined ? {} : { throughTicketId: record.throughTicketId }),
      });
      for (const { ticketId, retainUntil } of retained) {
        drop(TICKET_PREFIX + ticketId);
        drop(`${RETAIN_PREFIX}${retainUntil}:${ticketId}`);
        drop(`${UNREVOKED_PREFIX}${retainUntil}:${ticketId}`);
      }
      continue;
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
    if (record.t === "data-plane-ticket-revocation-completed") {
      const retired = await view.ticket(record.ticketId);
      if (retired?.s !== "r" || retired.assignmentId !== record.assignmentId) {
        throw new TypeError("Consumer revocation completion has no matching retirement");
      }
      if (retired.revocation && retired.revocation.streamEpoch !== record.streamEpoch) {
        throw new TypeError("Consumer revocation completion changed its stream generation");
      }
      put(TICKET_PREFIX + record.ticketId, { ...retired, revocation: { streamEpoch: record.streamEpoch } });
      drop(`${UNREVOKED_PREFIX}${retired.retainUntil}:${record.ticketId}`);
      continue;
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
      if (ticketPrecedesRetirementFrontier(record.ticket, await view.frontier())) {
        throw new Error("Accepted ticket history precedes the retirement frontier");
      }
      const existing = await view.ticket(record.ticket.ticketId);
      if (
        existing?.s === "a" ||
        (existing?.s === "r" &&
          Date.parse(record.acceptedAt) < Date.parse(existing.retainUntil))
      ) {
        throw new Error("Accepted ticket history is duplicated or still retired");
      }
      if (existing?.s === "r") {
        drop(`${RETAIN_PREFIX}${existing.retainUntil}:${record.ticket.ticketId}`);
        drop(`${UNREVOKED_PREFIX}${existing.retainUntil}:${record.ticket.ticketId}`);
      }
      const accepted: AcceptedTicket = {
        ticket: record.ticket,
        activation: record.activation,
        acceptedAt: record.acceptedAt,
        validForMs: record.validForMs,
      };
      put(TICKET_PREFIX + record.ticket.ticketId, { s: "a", ...accepted });
      await advanceTimeFrontier(record.acceptedAt);
      put(`${EXPIRY_PREFIX}${acceptedTicketExpiresAt(accepted)}:${record.ticket.ticketId}`,
        { ticketId: record.ticket.ticketId, assignmentId: record.ticket.assignmentId } satisfies TicketIndexEntry);
      continue;
    }
    const stored = await view.ticket(record.ticketId);
    if (stored?.s === "a" && stored.ticket.assignmentId !== record.assignmentId) {
      throw new Error("Ticket revocation history binds a different assignment");
    }
    if (stored?.s === "r") {
      if (stored.assignmentId !== record.assignmentId) {
        throw new Error("Ticket retirement history binds a different assignment");
      }
      if (
        stored.ticketDigest !== undefined &&
        record.ticketDigest !== undefined &&
        stored.ticketDigest !== record.ticketDigest
      ) {
        throw new Error("Ticket retirement history has conflicting identities");
      }
      const retainUntil = Date.parse(record.retainUntil) > Date.parse(stored.retainUntil)
        ? record.retainUntil
        : stored.retainUntil;
      if (retainUntil !== stored.retainUntil) {
        drop(`${RETAIN_PREFIX}${stored.retainUntil}:${record.ticketId}`);
        put(`${RETAIN_PREFIX}${retainUntil}:${record.ticketId}`, { ticketId: record.ticketId, retainUntil } satisfies RetainedTicketEntry);
        if (!stored.revocation) {
          drop(`${UNREVOKED_PREFIX}${stored.retainUntil}:${record.ticketId}`);
          put(`${UNREVOKED_PREFIX}${retainUntil}:${record.ticketId}`, { ticketId: record.ticketId, assignmentId: record.assignmentId } satisfies TicketIndexEntry);
        }
      }
      put(TICKET_PREFIX + record.ticketId, {
        s: "r",
        assignmentId: record.assignmentId,
        ...(stored.ticketDigest === undefined &&
        record.ticketDigest === undefined
          ? {}
          : { ticketDigest: stored.ticketDigest ?? record.ticketDigest }),
        reason: record.reason,
        retainUntil,
        ...(stored.revocation ? { revocation: stored.revocation } : {}),
      });
      continue;
    }
    if (stored?.s === "a") {
      drop(`${EXPIRY_PREFIX}${acceptedTicketExpiresAt(stored)}:${record.ticketId}`);
    }
    put(TICKET_PREFIX + record.ticketId, {
      s: "r",
      assignmentId: record.assignmentId,
      ...(record.ticketDigest === undefined
        ? {}
        : { ticketDigest: record.ticketDigest }),
      reason: record.reason,
      retainUntil: record.retainUntil,
    });
    put(`${RETAIN_PREFIX}${record.retainUntil}:${record.ticketId}`, { ticketId: record.ticketId, retainUntil: record.retainUntil } satisfies RetainedTicketEntry);
    put(`${UNREVOKED_PREFIX}${record.retainUntil}:${record.ticketId}`, { ticketId: record.ticketId, assignmentId: record.assignmentId } satisfies TicketIndexEntry);
  }
  return [...changes].map(([key, value]): DurableProjectionMutation =>
    value === undefined ? { kind: "tombstone", key } : { kind: "put", key, value });
}

/** 候选保留期晚于当前前沿时成为下一个前沿，否则前沿不动（undefined）。 */
function laterFrontier(candidate: string | undefined, retiredThrough: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  return retiredThrough === undefined || Date.parse(candidate) > Date.parse(retiredThrough) ? candidate : undefined;
}

function retirementFrontierStream(executorId: string): string {
  return `executor:${executorId}:data-plane-ticket-retirement-frontier`;
}

function assertCanonicalIso(value: string): string {
  assertCanonicalTime(value, "Ticket registry observation time");
  return value;
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
  position: RetirementPosition,
): LogicalRecord<TicketRegistryRecord> {
  return {
    stream: retirementFrontierStream(executorId),
    body: {
      t: "data-plane-ticket-retirement-frontier",
      executorId,
      retiredThrough: position.retiredThrough,
      ...(position.throughTicketId === undefined ? {} : { throughTicketId: position.throughTicketId }),
    },
  };
}

function observedTimeRecord(executorId: string, observedAt: string): LogicalRecord<TicketRegistryRecord> {
  return {
    stream: retirementFrontierStream(executorId),
    body: { t: "data-plane-ticket-observed-time", executorId, observedAt },
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
  if (record.t === 'data-plane-ticket-revocation-completed') {
    assertKeys(record, ['assignmentId', 'streamEpoch', 't', 'ticketId']);
    assertProtocolIdentifier(record.assignmentId, 'Revoked consumer assignment id');
    assertProtocolIdentifier(record.ticketId, 'Revoked consumer ticket id');
    if (record.streamEpoch !== null && (!Number.isSafeInteger(record.streamEpoch) || (record.streamEpoch as number) < 0)) {
      throw new TypeError('Revoked consumer stream generation is invalid');
    }
    return { t: 'data-plane-ticket-revocation-completed', assignmentId: record.assignmentId,
      ticketId: record.ticketId, streamEpoch: record.streamEpoch as number | null };
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
  if (record.t === "data-plane-ticket-observed-time") {
    assertKeys(record, ["executorId", "observedAt", "t"]);
    assertProtocolIdentifier(record.executorId, "Ticket observed time executor id");
    if (typeof record.observedAt !== "string") throw new TypeError("Ticket observed time is invalid");
    assertCanonicalTime(record.observedAt, "Ticket observed time");
    return { t: "data-plane-ticket-observed-time", executorId: record.executorId, observedAt: record.observedAt };
  }
  if (record.t === "data-plane-ticket-retirement-frontier") {
    assertKeys(record, record.throughTicketId === undefined
      ? ["executorId", "retiredThrough", "t"]
      : ["executorId", "retiredThrough", "t", "throughTicketId"]);
    assertProtocolIdentifier(
      record.executorId,
      "Ticket retirement frontier executor id",
    );
    if (typeof record.retiredThrough !== "string") {
      throw new TypeError("Ticket retirement frontier time is invalid");
    }
    assertCanonicalTime(record.retiredThrough, "Ticket retirement frontier time");
    if (record.throughTicketId !== undefined) {
      assertProtocolIdentifier(record.throughTicketId, "Ticket retirement frontier ticket id");
    }
    return {
      t: "data-plane-ticket-retirement-frontier",
      executorId: record.executorId,
      retiredThrough: record.retiredThrough,
      ...(record.throughTicketId === undefined ? {} : { throughTicketId: record.throughTicketId }),
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

function laterIso(at: string, other: string | undefined): string {
  return other !== undefined && Date.parse(other) > Date.parse(at) ? other : at;
}

function ticketPrecedesRetirementFrontier(
  ticket: DataPlaneTicket,
  retiredThrough: string | undefined,
): boolean {
  return (
    retiredThrough !== undefined &&
    Date.parse(ticket.expiry) <= Date.parse(retiredThrough)
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
