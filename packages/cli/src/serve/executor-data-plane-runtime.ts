import path from "node:path";
import {
  StorageMaintenanceTaskRunner,
  runStorageMaintenanceStep,
  storageMaintenanceObligation,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core";
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
  readonly clock?: () => string;
  readonly onError?: (error: Error) => void;
}

/** Finite assignment authority required by the executor data-plane mechanism. */
export interface ExecutorDataPlaneAssignmentAuthorityPort {
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
  #assignmentAuthority: ExecutorDataPlaneAssignmentAuthorityPort | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #maintenance: Promise<number> | undefined;
  #closed = false;

  constructor(options: ExecutorDataPlaneRuntimeOptions) {
    const clock = options.clock ?? (() => new Date().toISOString());
    this.#AssignmentStreamWriter = options.module.AssignmentStreamWriter;
    this.#onError = options.onError;
    this.#storageGovernor = options.storageMaintenance;
    this.#maintenanceRunner = new StorageMaintenanceTaskRunner(
      options.storageMaintenance,
    );
    this.#executorId = options.authority.executorId;
    this.#verifier = options.authority.verifier;
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
      },
    );
    this.#tickets = new options.module.DataPlaneTicketRegistry({
      log: options.authority.executorLog,
      executorId: options.authority.executorId,
      verifier: options.authority.verifier,
      assignments: {
        dataPlaneBinding: async (assignmentId, use) =>
          this.#assignmentAuthority?.dataPlaneBinding(assignmentId, use),
      },
      spool: this.#spool,
      clock,
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

  bindAssignmentAuthority(authority: ExecutorDataPlaneAssignmentAuthorityPort): void {
    if (this.#assignmentAuthority && this.#assignmentAuthority !== authority) {
      throw new Error("Executor data plane is already bound to another assignment authority");
    }
    this.#assignmentAuthority = authority;
  }

  async createStream(input: {
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
  }): Promise<AssignmentStreamWriter> {
    this.#requireAssignmentAuthority();
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
    const authority = this.#requireAssignmentAuthority();
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
    this.#requireAssignmentAuthority();
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
    this.#requireAssignmentAuthority();
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
    this.#requireAssignmentAuthority();
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

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Executor data plane is closed");
    this.#requireAssignmentAuthority();
    await this.#tickets.recover();
    await this.maintain();
    this.#scheduleMaintenance();
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
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#maintenanceRunner.stop();
    await this.#maintenance?.catch(() => undefined);
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
    const expired = await this.#maintenanceRunner.run(
      storageMaintenanceObligation("ticket-retirement", this.#executorId, "periodic", {
        owner: "executor-data-plane",
        obligation: "committed",
      }),
      abort.signal,
      () =>
        this.#tickets.maintain((operation) =>
          runStorageMaintenanceStep(
            this.#storageGovernor,
            storageMaintenanceRequest(
              "ticket-retirement",
              this.#executorId,
              "periodic",
              { obligation: "committed" },
            ),
            operation,
          ),
        ),
    );
    let reclaimed = 0;
    const assignmentIds = await this.#maintenanceRunner.run(
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
    );
    for (const assignmentId of assignmentIds) {
      if (this.#closed) break;
      const done = await this.#maintenanceRunner.run(
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
      );
      if (done) reclaimed += 1;
    }
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

  #requireAssignmentAuthority(): ExecutorDataPlaneAssignmentAuthorityPort {
    if (!this.#assignmentAuthority) {
      throw new Error("Executor data plane has no assignment authority");
    }
    return this.#assignmentAuthority;
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
