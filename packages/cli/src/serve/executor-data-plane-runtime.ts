import path from "node:path";
import type { ExecutionRef } from "@zhixing/core/contracts";
import type {
  AssignmentStreamSpool,
  AssignmentStreamWriter,
  ConversationAssignmentLedger,
  DataPlaneTicketRegistry,
} from "@zhixing/executor";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import type { ExecutorRoleModule } from "./role-topology.js";
import type { SecureMeshConnection } from "@zhixing/mesh";
import {
  createAssignmentStreamServiceHandler,
  createDataPlaneAssignmentStreamAuthorizer,
  createInProcessAssignmentStreamClient,
  type AssignmentStreamClient,
} from "./assignment-stream-mesh.js";

const MAINTENANCE_INTERVAL_MS = 60_000;

export interface ExecutorDataPlaneRuntimeOptions {
  readonly zhixingHome: string;
  readonly authority: AuthorityRuntimeStack;
  readonly module: Pick<
    ExecutorRoleModule,
    "AssignmentStreamSpool" | "AssignmentStreamWriter" | "DataPlaneTicketRegistry"
  >;
  readonly clock?: () => string;
  readonly onError?: (error: Error) => void;
}

/**
 * One executor-owned data-plane substrate shared by local and mesh adapters.
 * Assignment authority remains in the ledger; this runtime only owns durable
 * stream bytes, ticket projections and their physical maintenance.
 */
export class ExecutorDataPlaneRuntime {
  readonly spool: AssignmentStreamSpool;
  readonly tickets: DataPlaneTicketRegistry;
  readonly #AssignmentStreamWriter: typeof AssignmentStreamWriter;
  readonly #onError: ((error: Error) => void) | undefined;
  #ledger: ConversationAssignmentLedger | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #maintenance: Promise<number> | undefined;
  #closed = false;

  constructor(options: ExecutorDataPlaneRuntimeOptions) {
    const clock = options.clock ?? (() => new Date().toISOString());
    this.#AssignmentStreamWriter = options.module.AssignmentStreamWriter;
    this.#onError = options.onError;
    this.spool = new options.module.AssignmentStreamSpool(
      path.join(
        options.zhixingHome,
        "distributed-runtime",
        "assignment-streams",
      ),
      options.authority.artifacts,
      { clock },
    );
    this.tickets = new options.module.DataPlaneTicketRegistry({
      log: options.authority.executorLog,
      executorId: options.authority.executorId,
      verifier: options.authority.verifier,
      assignments: {
        dataPlaneBinding: async (assignmentId) =>
          this.#ledger?.dataPlaneBinding(assignmentId),
      },
      spool: this.spool,
      clock,
    });
  }

  bindLedger(ledger: ConversationAssignmentLedger): void {
    if (this.#ledger && this.#ledger !== ledger) {
      throw new Error("Executor data plane is already bound to another ledger");
    }
    this.#ledger = ledger;
  }

  async createStream(input: {
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
  }): Promise<AssignmentStreamWriter> {
    this.#requireLedger();
    return this.#AssignmentStreamWriter.open(
      this.spool,
      input.assignmentId,
      input.ref,
    );
  }

  ownerStreamClient(ownerDeviceId: string): AssignmentStreamClient {
    const ledger = this.#requireLedger();
    const connection = {
      peer: { deviceId: ownerDeviceId },
    } as SecureMeshConnection;
    const handler = createAssignmentStreamServiceHandler({
      spool: this.spool,
      authorize: createDataPlaneAssignmentStreamAuthorizer({
        tickets: this.tickets,
        surfacePrincipalFor: () =>
          `surface:device:${ownerDeviceId}`,
        ownerMayPresentSurfaceTicket: () => true,
        authorizeOwnerRelay: async (request) => {
          if (request.consumer.kind !== "owner-relay") {
            throw new TypeError(
              "Owner relay authorization has the wrong consumer kind",
            );
          }
          await ledger.authorizeOwnerRelay({
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

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Executor data plane is closed");
    this.#requireLedger();
    await this.tickets.recover();
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
    await this.#maintenance;
  }

  async #runMaintenance(): Promise<number> {
    const expired = await this.tickets.maintain();
    let reclaimed = 0;
    for (const assignmentId of await this.spool.assignmentIds()) {
      if (await this.spool.reclaimDue(assignmentId)) reclaimed += 1;
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

  #requireLedger(): ConversationAssignmentLedger {
    if (!this.#ledger) {
      throw new Error("Executor data plane has no assignment authority");
    }
    return this.#ledger;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
