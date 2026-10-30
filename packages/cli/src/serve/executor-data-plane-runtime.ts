import path from "node:path";
import { artifactReadCapacity, projectionReadCapacity } from './artifact-read-capacity.js';
import type { DeviceCapacityArbiterPort } from '@zhixing/core/resources';
import type { PhysicalStorageStepRunner } from "@zhixing/core/authority";
import { currentMaintenanceAbortSignal, isHoldingMaintenanceExclusion, maintenanceRetryDelayMs, runWithMaintenanceUrgency, StorageMaintenanceCancelledError, StorageMaintenanceTaskRunner, runStorageMaintenanceStep, storageMaintenanceObligation, storageMaintenanceRequest, type StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type {
  DataPlaneTicket,
  ExecutionRef,
  StreamConsumerAuth,
} from "@zhixing/core/contracts";
import type {
  DataPlaneTicketUse,
  ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type {
  AssignmentStreamSpool,
  AssignmentStreamWriter,
  DataPlaneAssignmentBinding,
  DataPlaneAssignmentBindingResolver,
  DataPlaneTicketRegistry,
} from "@zhixing/executor";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import type { ExecutorRoleModule } from "./role-topology.js";
import type { SecureMeshConnection } from "@zhixing/mesh";
import {
  createAssignmentStreamServiceHandler,
  createDataPlaneAssignmentStreamAuthorizer,
  createInProcessAssignmentStreamClient,
  registerAssignmentStreamService,
  type AssignmentStreamClient,
} from "./assignment-stream-mesh.js";
import {
  registerDataPlaneTicketService,
} from "./data-plane-ticket-mesh.js";
import type {
  AssignmentDataPlaneLocalTransportPort,
  AssignmentDataPlaneMeshServiceInput,
} from "./assignment-data-plane-topology.js";

const MAINTENANCE_INTERVAL_MS = 60_000;
// 单轮回收批次上界:一轮维护至多触碰这么多 assignment,余量由游标续扫,
// 保证单轮工作量与 spool 历史规模无关。
const MAINTENANCE_RECLAIM_BATCH_LIMIT = 32;

export interface ExecutorDataPlaneRuntimeOptions {
  readonly zhixingHome: string;
  readonly authority: AuthorityRuntimeStack;
  readonly module: Pick<
    ExecutorRoleModule,
    "AssignmentStreamSpool" | "AssignmentStreamWriter" | "DataPlaneTicketRegistry"
  >;
  /** 设备唯一容量裁决入口;缺省即不装配治理的嵌入场景,维护直通执行。 */
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly deviceCapacity?: DeviceCapacityArbiterPort;
  readonly clock?: () => string;
  readonly onError?: (error: Error) => void;
  /** 宿主前台安静判定：票据资格的定时合批确认先等它，不与前台派发和运行争执行端日志。 */
  readonly whenQuiet?: (signal: AbortSignal) => Promise<void>;
}

/** Finite assignment authority required by the executor data-plane mechanism. */
export interface ExecutorDataPlaneAssignmentAuthorityPort {
  readonly dataPlaneBindings?: DataPlaneAssignmentBindingResolver["dataPlaneBindings"];
  dataPlaneBinding(
    assignmentId: string,
    use?: DataPlaneTicketUse,
  ): Promise<DataPlaneAssignmentBinding | undefined>;
  authorizeOwnerRelay(input: {
    readonly assignmentId: string;
    readonly consumer: Extract<StreamConsumerAuth, { readonly kind: "owner-relay" }>;
    readonly ownerDeviceId: string;
  }): Promise<void>;
}

/** Ticket authority contribution consumed by the assignment ledger at Host assembly. */
export interface ExecutorDataPlaneTicketAuthorityPort {
  authorize: DataPlaneTicketRegistry["authorize"];
}

/** Finite ports exposed only while the Host composes one assignment/data-plane pair. */
export interface ExecutorDataPlaneAssignmentAssemblyPort {
  readonly assignmentTickets: ExecutorDataPlaneTicketAuthorityPort;
  createStream(input: {
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
  }): Promise<AssignmentStreamWriter>;
}

export interface ExecutorDataPlaneAssignmentContribution<Assignment> {
  readonly assignment: Assignment;
  readonly authority: ExecutorDataPlaneAssignmentAuthorityPort;
}

export interface ExecutorDataPlaneAssignmentPair<Assignment> {
  readonly dataPlane: ExecutorDataPlaneRuntime;
  readonly assignment: Assignment;
}

/**
 * Atomically composes the mutually dependent assignment authority and data plane.
 * Neither side escapes this call before the required, immutable pair is complete.
 */
export function createExecutorDataPlaneAssignmentPair<Assignment>(
  options: ExecutorDataPlaneRuntimeOptions,
  createAssignment: (
    dataPlane: ExecutorDataPlaneAssignmentAssemblyPort,
  ) => ExecutorDataPlaneAssignmentContribution<Assignment>,
): ExecutorDataPlaneAssignmentPair<Assignment> {
  const composition = new ExecutorDataPlaneAssignmentComposition(
    options,
    createAssignment,
  );
  return Object.freeze({
    dataPlane: composition.dataPlane,
    assignment: composition.assignment,
  });
}

/**
 * One executor-owned data-plane substrate shared by local and mesh adapters.
 * Assignment authority remains in the ledger; this runtime only owns durable
 * stream bytes, ticket projections and their physical maintenance.
 */
export class ExecutorDataPlaneRuntime {
  readonly assignmentTickets: ExecutorDataPlaneTicketAuthorityPort;
  readonly localTransport: AssignmentDataPlaneLocalTransportPort;
  readonly #AssignmentStreamWriter: typeof AssignmentStreamWriter;
  readonly #spool: AssignmentStreamSpool;
  readonly #tickets: DataPlaneTicketRegistry;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #storageGovernor: StorageMaintenanceGovernorPort | undefined;
  readonly #maintenanceRunner: StorageMaintenanceTaskRunner;
  readonly #executorId: string;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #assignmentAuthority: ExecutorDataPlaneAssignmentAuthorityPort;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #maintenance: Promise<number> | undefined;
  #closed = false;
  readonly #startupAbort = new AbortController();
  #startup: Promise<void> | undefined;

  constructor(
    options: ExecutorDataPlaneRuntimeOptions,
    assignmentAuthority: ExecutorDataPlaneAssignmentAuthorityPort,
  ) {
    const clock = options.clock ?? (() => new Date().toISOString());
    this.#AssignmentStreamWriter = options.module.AssignmentStreamWriter;
    this.#onError = options.onError;
    this.#storageGovernor = options.storageMaintenance;
    this.#maintenanceRunner = new StorageMaintenanceTaskRunner(
      options.storageMaintenance,
    );
    this.#executorId = options.authority.executorId;
    this.#verifier = options.authority.verifier;
    this.#assignmentAuthority = assignmentAuthority;
    this.#spool = new options.module.AssignmentStreamSpool(
      path.join(
        options.zhixingHome,
        "distributed-runtime",
        "assignment-streams",
      ),
      options.authority.artifacts,
      {
        clock,
        storageMaintenance: options.storageMaintenance,
        runReadStep: artifactReadCapacity(options.deviceCapacity),
        runProjectionReadStep: projectionReadCapacity(options.deviceCapacity),
      },
    );
    this.#tickets = new options.module.DataPlaneTicketRegistry({
      log: options.authority.executorLog,
      executorId: options.authority.executorId,
      verifier: options.authority.verifier,
      assignments: {
        ...(this.#assignmentAuthority.dataPlaneBindings ? { dataPlaneBindings: requests => this.#assignmentAuthority.dataPlaneBindings!(requests) } : {}),
        dataPlaneBinding: async (assignmentId, use) =>
          this.#assignmentAuthority.dataPlaneBinding(assignmentId, use),
      },
      spool: this.#spool,
      clock,
      ...(options.whenQuiet ? { whenQuiet: options.whenQuiet } : {}),
    });
    this.assignmentTickets = Object.freeze({
      authorize: (...args: Parameters<DataPlaneTicketRegistry["authorize"]>) =>
        this.#tickets.authorize(...args),
    });
    this.localTransport = Object.freeze({
      acceptTicket: async (ticket: DataPlaneTicket) => {
        await this.#tickets.accept(ticket);
      },
      authorizeOwnerPresentedSurface: async (
        ticketId: string,
        use: DataPlaneTicketUse,
        assignmentId: string,
      ) => {
        await this.#tickets.authorizeOwnerPresentedSurface(
          ticketId,
          use,
          assignmentId,
        );
      },
      ownerStreamClient: (ownerDeviceId: string) =>
        this.#ownerStreamClient(ownerDeviceId),
      surfaceStreamClient: (surfacePrincipal: string) =>
        this.#surfaceStreamClient(surfacePrincipal),
    });
  }

  async createStream(input: {
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
  }): Promise<AssignmentStreamWriter> {
    return this.#AssignmentStreamWriter.open(
      this.#spool,
      input.assignmentId,
      input.ref,
    );
  }

  /**
   * owner-relay 消费者的授权与耐久资格是一体义务:账本裁决 owner 身份与
   * 控制租约后,消费者必须在同一入口完成 spool 资格登记(owner-relay 无
   * 到期),否则订阅会被 spool 以未资格拒绝。local/mesh 装配共用本方法,
   * 不得各自另行拼装。
   */
  async #authorizeOwnerRelayConsumer(input: {
    readonly assignmentId: string;
    readonly consumer: Extract<
      import("@zhixing/core/contracts").StreamConsumerAuth,
      { readonly kind: "owner-relay" }
    >;
    readonly ownerDeviceId: string;
  }): Promise<void> {
    const authority = this.#assignmentAuthority;
    await authority.authorizeOwnerRelay(input);
    const binding = await authority.dataPlaneBinding(input.assignmentId);
    if (!binding) {
      throw new Error("Owner relay authorization has no active assignment binding");
    }
    await this.#spool.qualifyConsumer({
      assignmentId: input.assignmentId,
      ref: binding.ref,
      consumer: input.consumer,
    });
  }

  #ownerStreamClient(ownerDeviceId: string): AssignmentStreamClient {
    const connection = {
      peer: { deviceId: ownerDeviceId },
    } as SecureMeshConnection;
    const handler = createAssignmentStreamServiceHandler({
      spool: this.#spool,
      authorize: createDataPlaneAssignmentStreamAuthorizer({
        tickets: this.#tickets,
        surfacePrincipalFor: () =>
          `surface:device:${ownerDeviceId}`,
        ownerMayPresentSurfaceTicket: () => true,
        authorizeOwnerRelay: async (request) => {
          if (request.consumer.kind !== "owner-relay") {
            throw new TypeError(
              "Owner relay authorization has the wrong consumer kind",
            );
          }
          await this.#authorizeOwnerRelayConsumer({
            assignmentId: request.assignmentId,
            consumer: request.consumer,
            ownerDeviceId,
          });
          return {};
        },
      }),
    });
    return createInProcessAssignmentStreamClient(handler, connection);
  }

  /**
   * 已认证第一方 surface 的进程内直连端点。它与 owner relay 使用相同
   * spool 服务，但以票据绑定的 surface principal 独立验权，不能借用
   * owner-presented-ticket 分支。
   */
  #surfaceStreamClient(surfacePrincipal: string): AssignmentStreamClient {
    const connection = {
      peer: { deviceId: this.#executorId },
    } as SecureMeshConnection;
    const handler = createAssignmentStreamServiceHandler({
      spool: this.#spool,
      authorize: createDataPlaneAssignmentStreamAuthorizer({
        tickets: this.#tickets,
        surfacePrincipalFor: () => surfacePrincipal,
        authorizeOwnerRelay: async (request) => {
          if (request.consumer.kind !== "owner-relay") {
            throw new TypeError(
              "Owner relay authorization has the wrong consumer kind",
            );
          }
          await this.#authorizeOwnerRelayConsumer({
            assignmentId: request.assignmentId,
            consumer: request.consumer,
            ownerDeviceId: this.#executorId,
          });
          return {};
        },
      }),
    });
    return createInProcessAssignmentStreamClient(handler, connection);
  }

  registerMeshServices(input: AssignmentDataPlaneMeshServiceInput): () => void {
    const disposeStream = registerAssignmentStreamService(input.services, {
      spool: this.#spool,
      authorize: createDataPlaneAssignmentStreamAuthorizer({
        tickets: this.#tickets,
        surfacePrincipalFor: input.surfacePrincipalFor,
        ownerMayPresentSurfaceTicket: input.ownerMayPresentSurfaceTicket,
        authorizeOwnerRelay: async (request) => {
          if (request.consumer.kind !== "owner-relay") {
            throw new TypeError("Owner relay authorization has the wrong consumer kind");
          }
          await this.#authorizeOwnerRelayConsumer({
            assignmentId: request.assignmentId,
            consumer: request.consumer,
            ownerDeviceId: request.connection.peer.deviceId,
          });
          return {};
        },
      }),
      authorizePeer: input.authorizePeer,
    });
    const disposeTickets = registerDataPlaneTicketService(input.services, {
      tickets: this.#tickets,
      verifier: this.#verifier,
      operations: input.operations,
      authorizeOwner: input.authorizeOwner,
      surfacePrincipalFor: input.surfacePrincipalFor,
      authorizePeer: input.authorizePeer,
    });
    return once(() => {
      disposeTickets();
      disposeStream();
    });
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Executor data plane is closed"));
    return this.#startup ??= this.#recoverTickets();
  }

  async #recoverTickets(): Promise<void> {
    const abort = AbortSignal.any([currentMaintenanceAbortSignal(), this.#startupAbort.signal]);
    let retryUntil: number | undefined;
    for (;;) {
      if (abort.aborted) throw new StorageMaintenanceCancelledError();
      try {
        await runWithMaintenanceUrgency(() => "recovery", abort, () => this.#tickets.recover());
        if (abort.aborted) throw new StorageMaintenanceCancelledError();
        // Only authority/consumer recovery gates readiness; physical history
        // reclamation stays in the bounded periodic sweep.
        this.#scheduleMaintenance();
        return;
      } catch (error) {
        if (abort.aborted) throw new StorageMaintenanceCancelledError();
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion()) throw error;
        retryUntil ??= Date.now() + 5_000;
        const remaining = retryUntil - Date.now();
        if (remaining <= 0) throw error;
        // recover has drained its queue/locks before rejecting. Never race an
        // in-flight recovery against a timer or sleep while holding its lock.
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); abort.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, Math.min(remaining, Math.max(1, Math.min(delay, 250))));
          abort.addEventListener("abort", finish, { once: true });
          if (abort.aborted) finish();
        });
        if (abort.aborted) throw new StorageMaintenanceCancelledError();
        if (Date.now() >= retryUntil) throw error;
      }
    }
  }

  async maintain(): Promise<number> {
    if (this.#maintenance) return this.#maintenance;
    const running = this.#runMaintenance();
    this.#maintenance = running;
    try {
      return await running;
    } finally {
      if (this.#maintenance === running) this.#maintenance = undefined;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#startupAbort.abort();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#startup?.catch(() => undefined);
    await this.#maintenanceRunner.stop();
    await this.#maintenance?.catch(() => undefined);
    // 资格已耐久的待确认票据在 spool 关闭前合批确认；失败只留下耐久欠账，下次启动照常恢复
    await this.#tickets.flushQualifications().catch(() => undefined);
    await this.#spool.closeAssignmentScan();
    await this.#spool.stopStorageMaintenance();
  }

  /**
   * 维护走第 23 单元的两层治理:义务层按规范 workKey 合流(票据退休一份
   * 义务、spool 回收按 assignment 各一份),叶级物理步骤在各自互斥段内
   * 经设备容量裁决器独立准入。单轮回收批次有上界,余量由游标跨轮续扫。
   */
  async #runMaintenance(): Promise<number> {
    const abort = new AbortController();
    // 各维护义务分别承担错误与续做：一项失败不让本轮其余义务（资格补登、各分派回收）轮不到，本轮末统一报告
    const failures: unknown[] = [];
    const attempt = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await work(); } catch (error) { failures.push(error); return fallback; }
    };
    const ticketStep = (input: string): PhysicalStorageStepRunner => (operation) =>
      runStorageMaintenanceStep(
        this.#storageGovernor,
        storageMaintenanceRequest("ticket-retirement", this.#executorId, input, { obligation: "committed" }),
        operation,
      );
    const expired = await attempt(() => this.#maintenanceRunner.run(
      storageMaintenanceObligation("ticket-retirement", this.#executorId, "periodic", {
        owner: "executor-data-plane",
        obligation: "committed",
      }),
      abort.signal,
      () => this.#tickets.maintain(ticketStep("periodic")),
    ), 0);
    // 资格欠账单列一个义务：为接纳后尚未确认的票据补登资格并核销，排在本轮回收之前；启动恢复因此只承担有界欠账
    await attempt(() => this.#maintenanceRunner.run(
      storageMaintenanceObligation("ticket-retirement", this.#executorId, "qualification", {
        owner: "executor-data-plane",
        obligation: "committed",
      }),
      abort.signal,
      () => this.#tickets.maintainQualifications(ticketStep("qualification")),
    ), 0);
    let reclaimed = 0;
    const assignmentIds = await attempt(() => this.#maintenanceRunner.run(
      storageMaintenanceObligation(
        "stream-spool-reclaim",
        this.#executorId,
        "discovery",
        { owner: "executor-data-plane", obligation: "committed" },
      ),
      abort.signal,
      () =>
        this.#spool.assignmentIdPage(
          MAINTENANCE_RECLAIM_BATCH_LIMIT,
          (operation) =>
            runStorageMaintenanceStep(
              this.#storageGovernor,
              storageMaintenanceRequest(
                "stream-spool-reclaim",
                this.#executorId,
                "discovery",
                { obligation: "committed" },
              ),
              operation,
            ),
        ),
    ), [] as readonly string[]);
    for (const assignmentId of assignmentIds) {
      if (this.#closed) break;
      const done = await attempt(() => this.#maintenanceRunner.run(
        storageMaintenanceObligation(
          "stream-spool-reclaim",
          assignmentId,
          "periodic",
          { owner: "executor-data-plane", obligation: "committed" },
        ),
        abort.signal,
        () =>
          this.#spool.reclaimDue(assignmentId, undefined, (operation) =>
            runStorageMaintenanceStep(
              this.#storageGovernor,
              storageMaintenanceRequest(
                "stream-spool-reclaim",
                assignmentId,
                "periodic",
                { obligation: "committed" },
              ),
              operation,
            ),
          ),
      ), false);
      if (done) reclaimed += 1;
    }
    if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, "Executor data-plane maintenance left obligations");
    return expired + reclaimed;
  }

  #scheduleMaintenance(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.maintain()
        .catch((error) => this.#onError?.(asError(error)))
        .finally(() => this.#scheduleMaintenance());
    }, MAINTENANCE_INTERVAL_MS);
    this.#timer.unref?.();
  }

}

class ExecutorDataPlaneAssignmentComposition<Assignment>
  implements ExecutorDataPlaneAssignmentAuthorityPort
{
  readonly dataPlane: ExecutorDataPlaneRuntime;
  readonly assignment: Assignment;
  readonly #authority: ExecutorDataPlaneAssignmentAuthorityPort;

  constructor(
    options: ExecutorDataPlaneRuntimeOptions,
    createAssignment: (
      dataPlane: ExecutorDataPlaneAssignmentAssemblyPort,
    ) => ExecutorDataPlaneAssignmentContribution<Assignment>,
  ) {
    this.dataPlane = new ExecutorDataPlaneRuntime(options, this);
    const contribution = createAssignment(
      Object.freeze({
        assignmentTickets: this.dataPlane.assignmentTickets,
        createStream: (
          input: Parameters<ExecutorDataPlaneRuntime["createStream"]>[0],
        ) => this.dataPlane.createStream(input),
      }),
    );
    if (
      !contribution?.authority ||
      typeof contribution.authority.dataPlaneBinding !== "function" ||
      typeof contribution.authority.authorizeOwnerRelay !== "function"
    ) {
      throw new TypeError(
        "Executor assignment/data-plane composition requires one complete authority",
      );
    }
    this.assignment = contribution.assignment;
    this.#authority = contribution.authority;
    Object.freeze(this);
  }

  dataPlaneBinding(
    assignmentId: string,
    use?: DataPlaneTicketUse,
  ): Promise<DataPlaneAssignmentBinding | undefined> {
    return this.#authority.dataPlaneBinding(assignmentId, use);
  }

  async dataPlaneBindings(requests: Parameters<NonNullable<DataPlaneAssignmentBindingResolver["dataPlaneBindings"]>>[0]) {
    if (this.#authority.dataPlaneBindings) return this.#authority.dataPlaneBindings(requests);
    const results: (DataPlaneAssignmentBinding | undefined)[] = [];
    for (const request of requests) results.push(await this.#authority.dataPlaneBinding(request.assignmentId, request.use));
    return results;
  }

  authorizeOwnerRelay(
    input: Parameters<
      ExecutorDataPlaneAssignmentAuthorityPort["authorizeOwnerRelay"]
    >[0],
  ): Promise<void> {
    return this.#authority.authorizeOwnerRelay(input);
  }
}

function once(action: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    action();
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
