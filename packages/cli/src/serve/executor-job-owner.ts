import type {
  ChannelInteractionGrant,
  DispatchEnvelope,
  ExecutionAbortRequest,
} from "@zhixing/core/contracts";
import {
  JobInteractionRuntimeUnavailableError,
  type JobInteractionAnswerPort,
} from "./durable-job-interactions.js";
import {
  JobAssignmentWorker,
  type JobAcceptedWorkItem,
  type JobAssignmentWorkerOptions,
} from "./job-assignment-worker.js";

type JobEnvelope = Extract<DispatchEnvelope, { readonly execution: "job" }>;

/**
 * The single executor-owned job convergence lifecycle.
 *
 * Composition roots own this object; transports only register adapters that
 * delegate to it. Readiness is published only after durable recovery has been
 * scheduled, so no transport can durably accept job work into an ownerless gap.
 */
export class ExecutorJobOwner implements JobInteractionAnswerPort {
  readonly #worker: JobAssignmentWorker;
  #state: "created" | "recovering" | "ready" | "paused" | "closed" = "created";
  #starting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;

  constructor(options: JobAssignmentWorkerOptions | JobAssignmentWorker) {
    this.#worker =
      options instanceof JobAssignmentWorker
        ? options
        : new JobAssignmentWorker(options);
  }

  get ready(): boolean {
    return this.#state === "ready";
  }

  async start(): Promise<void> {
    if (this.#state === "ready") return;
    if (this.#state === "closed") {
      throw new JobInteractionRuntimeUnavailableError(
        "Executor job owner is closed",
      );
    }
    if (this.#starting) return this.#starting;
    this.#state = "recovering";
    this.#starting = (async () => {
      try {
        await this.#worker.recover();
        if (this.#state !== "closed") this.#state = "ready";
      } catch (error) {
        if (this.#state !== "closed") this.#state = "created";
        throw error;
      } finally {
        this.#starting = undefined;
      }
    })();
    return this.#starting;
  }

  accept(envelope: JobEnvelope): void {
    this.#requireReady();
    this.#worker.accept(envelope);
  }

  async cancelAccepted(assignmentId: string): Promise<void> {
    this.#requireReady();
    await this.#worker.cancelAccepted(assignmentId);
  }

  async deliverGrant(grant: ChannelInteractionGrant): Promise<void> {
    this.#requireReady();
    await this.#worker.deliverGrant(grant);
  }

  async resolveNoInteractiveSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void> {
    this.#requireReady();
    await this.#worker.resolveNoInteractiveSurface(input);
  }

  async answerInteractionWithTicket(
    input: Parameters<JobInteractionAnswerPort["answerInteractionWithTicket"]>[0],
  ): Promise<void> {
    this.#requireReady();
    await this.#worker.answerInteractionWithTicket(input);
  }

  async abortWithTicket(request: ExecutionAbortRequest): Promise<void> {
    this.#requireReady();
    await this.#worker.abortWithTicket(request);
  }

  stopAccepting(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#worker.stopAccepting();
  }

  drain(): Promise<void> {
    return this.#worker.drain();
  }

  pauseAccepting(): void {
    if (this.#state === "closed" || this.#state === "paused") return;
    if (this.#state !== "ready") {
      throw new JobInteractionRuntimeUnavailableError(
        "Executor job owner cannot pause before durable recovery",
      );
    }
    this.#state = "paused";
    this.#worker.stopAccepting();
  }

  resumeAccepting(): void {
    if (this.#state === "ready") return;
    if (this.#state !== "paused") {
      throw new JobInteractionRuntimeUnavailableError(
        "Executor job owner cannot resume after close",
      );
    }
    this.#worker.resumeAccepting();
    this.#state = "ready";
  }

  acceptedWorkItems(): Promise<readonly JobAcceptedWorkItem[]> {
    return this.#worker.acceptedWorkItems();
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.stopAccepting();
    this.#closing = (async () => {
      await this.#starting?.catch(() => undefined);
      await this.#worker.close();
    })();
    return this.#closing;
  }

  #requireReady(): void {
    if (!this.ready) {
      throw new JobInteractionRuntimeUnavailableError(
        "Executor job owner has not completed durable recovery",
      );
    }
  }
}

/**
 * Stable composition boundary for the executor-owned job capability.
 *
 * Every production topology constructs this unit; optional transports receive
 * only its owner adapter and never own lifecycle or recovery.
 */
export class ExecutorJobOwnerAssembly {
  readonly owner: ExecutorJobOwner;

  constructor(options: JobAssignmentWorkerOptions) {
    this.owner = new ExecutorJobOwner(options);
  }

  get ready(): boolean {
    return this.owner.ready;
  }

  start(): Promise<void> {
    return this.owner.start();
  }

  stopAccepting(): void {
    this.owner.stopAccepting();
  }

  pauseAccepting(): void {
    this.owner.pauseAccepting();
  }

  resumeAccepting(): void {
    this.owner.resumeAccepting();
  }

  drain(): Promise<void> {
    return this.owner.drain();
  }

  acceptedWorkItems(): Promise<readonly JobAcceptedWorkItem[]> {
    return this.owner.acceptedWorkItems();
  }

  close(): Promise<void> {
    return this.owner.close();
  }
}

/**
 * Orders the transport and the job owner without transferring ownership of
 * either side to an optional mesh component.
 */
export class ExecutorJobOwnerLifecycle {
  #transportAttempted = false;
  #started = false;
  #closed = false;

  constructor(
    private readonly owner: Pick<
      ExecutorJobOwnerAssembly,
      "start" | "stopAccepting" | "close"
    >,
    private readonly transport: {
      start(): Promise<void>;
      stop(): Promise<void>;
    },
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  async start(): Promise<void> {
    if (this.#started || this.#transportAttempted) {
      throw new Error("Executor job owner lifecycle may start only once");
    }
    this.#transportAttempted = true;
    try {
      await this.transport.start();
      await this.owner.start();
      this.#started = true;
    } catch (error) {
      try {
        await this.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Executor job owner startup and rollback both failed",
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    try {
      this.owner.stopAccepting();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.owner.close();
    } catch (error) {
      failures.push(error);
    }
    if (this.#transportAttempted) {
      try {
        await this.transport.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Executor job owner shutdown failed",
      );
    }
  }
}
