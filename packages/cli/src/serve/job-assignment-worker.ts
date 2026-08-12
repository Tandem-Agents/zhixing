import {
  ConfirmationBroker,
  type AgentYield,
  type IConfirmationBroker,
  type PermissionRule,
  type ToolSideEffectObserver,
} from "@zhixing/core";
import type {
  AuthorityCallContext,
  ChannelInteractionGrant,
  ContentAssetRef,
  DispatchEnvelope,
  ExecutionAbortRequest,
  JobInteractionSettlementPort,
  JobExecutionInstruction,
  SessionEventProjection,
} from "@zhixing/core/contracts";
import { AuthorityStorageError } from "@zhixing/core/authority";
import { protocolDigest, type StreamFrameProducer } from "@zhixing/core/protocol";
import type {
  ConversationAssignmentLedger,
  ExecutorResourceGovernor,
  InProcessAssignmentSubmission,
  JobRecoveryObligation,
} from "@zhixing/executor";
import {
  asError,
  resumeSealedSubmission,
  retryRemoteObligation,
  submitBundleUntilAcknowledged,
} from "./assignment-worker-obligations.js";
import {
  DurableJobInteractionCoordinator,
  type DurableJobInteractionBinding,
  type JobInteractionAnswerPort,
} from "./durable-job-interactions.js";
import { retryDurableObligation } from "./durable-obligation-retry.js";
import { shouldRetryRemoteObligation } from "./remote-obligation-failure.js";
import {
  assignmentGlobalCapability,
  createAssignmentMutationPort,
  createAssignmentScheduleStager,
} from "./assignment-schedule-stager.js";

const COMMIT_REJECTION_PREFIX = "Job commit rejected";
const JOB_RECOVERY_PAGE_SIZE = 32;
const JOB_RECOVERY_CONCURRENCY = 4;

type JobEnvelope = Extract<DispatchEnvelope, { execution: "job" }>;

export interface JobRunOutcome {
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly contentAssets: readonly ContentAssetRef[];
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface JobAcceptedWorkItem {
  readonly id: string;
  readonly revision: string;
}

export interface JobRuntimeRunOptions {
  readonly abortSignal: AbortSignal;
  readonly onProtocolEvent: (
    event: SessionEventProjection,
  ) => Promise<void>;
  readonly authorizeToolExecution: () => Promise<readonly PermissionRule[]>;
  readonly toolSideEffectObserver: ToolSideEffectObserver;
  readonly stageScheduleMutation: import("@zhixing/core").ScheduleMutationStager;
  readonly assignmentMutations: import("@zhixing/core/contracts").AssignmentMutationPort;
  readonly globalQuery?: import("@zhixing/core/contracts").AssignmentGlobalQueryPort;
  readonly assignmentIssuedAt: string;
}

export interface JobRuntimeHandle {
  run(
    instruction: JobExecutionInstruction,
    options: JobRuntimeRunOptions,
  ): AsyncGenerator<AgentYield, JobRunOutcome>;
  dispose(): Promise<void>;
}

/**
 * 注入的 job 运行时端口:worker 不持有 agent 运行时的构造知识,生产
 * 实现由后续单元从组合根接缝接入,conformance 只在此边界替换。
 */
export interface JobRuntimePort {
  create(input: {
    readonly taskId: string;
    readonly jobRunId: string;
    readonly confirmationBroker: IConfirmationBroker;
  }): Promise<JobRuntimeHandle>;
}

/** owner 提交口的 job 消费面:进程内为 JobJournal,跨机为 MeshRunSubmissionPort。 */
export type JobSubmissionOwner = ConstructorParameters<
  typeof InProcessAssignmentSubmission
>[0]["owner"] &
  JobInteractionSettlementPort;

export interface JobAssignmentWorkerOptions {
  readonly ledger: ConversationAssignmentLedger;
  readonly runtime: JobRuntimePort;
  readonly submissionFor: (
    envelope: JobEnvelope,
    signal: AbortSignal,
  ) => JobSubmissionOwner | Promise<JobSubmissionOwner>;
  readonly finalizeUsage: (input: {
    readonly assignmentId: string;
    readonly envelope: JobEnvelope;
  }) => Promise<{ reportDigest: string; upToUsageSeq: number }>;
  readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
  readonly resourceGovernor?: ExecutorResourceGovernor;
  readonly globalQueryFor?: (
    capability: import("@zhixing/core/contracts").AuthorityCapability,
    anchorEpoch: number,
  ) => import("@zhixing/core/contracts").AssignmentGlobalQueryPort;
  readonly createStream: (input: {
    readonly assignmentId: string;
    readonly ref: {
      readonly execution: "job";
      readonly jobRunId: string;
      readonly taskId: string;
      readonly anchorEpoch: number;
    };
  }) => JobRunStream | Promise<JobRunStream>;
  readonly onError?: (assignmentId: string, error: Error) => void;
}

export interface JobRunStream extends StreamFrameProducer {
  markTerminal?(): Promise<unknown>;
}

type ActiveJobInteractionBinding = DurableJobInteractionBinding & {
  readonly stream: JobRunStream;
};

/** Executor-owned job lifecycle from durable receipt through owner acknowledgement. */
export class JobAssignmentWorker implements JobInteractionAnswerPort {
  readonly #running = new Map<string, Promise<void>>();
  readonly #interactionRecoveries = new Map<string, Promise<void>>();
  readonly #interactionRecoveryRequested = new Set<string>();
  readonly #interactionRecoveryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  readonly #interactionRecoveryRetryMs = new Map<string, number>();
  readonly #recoveryQueue = new BoundedTaskQueue(JOB_RECOVERY_CONCURRENCY);
  readonly #activeInteractionBindings = new Map<
    string,
    ActiveJobInteractionBinding
  >();
  readonly #executionAborts = new Map<string, AbortController>();
  readonly #executionStages = new Map<
    string,
    "waiting-owner" | "starting" | "started"
  >();
  readonly #recoveryAbort = new AbortController();
  readonly #interactions: DurableJobInteractionCoordinator;
  #recoveryPump: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #accepting = true;
  #recoveryStopped = false;
  #closed = false;

  constructor(private readonly options: JobAssignmentWorkerOptions) {
    this.#interactions = new DurableJobInteractionCoordinator(
      options.ledger,
      (assignmentId) => {
        void this.#wakeInteractionRecovery(assignmentId);
      },
    );
  }

  accept(envelope: DispatchEnvelope): void {
    if (!this.#accepting || envelope.execution !== "job") return;
    this.#startExecution(envelope);
  }

  #startExecution(envelope: JobEnvelope): Promise<void> | undefined {
    if (this.#closed) return;
    if (this.#running.has(envelope.assignmentId)) return;
    const executionAbort = new AbortController();
    this.#executionAborts.set(envelope.assignmentId, executionAbort);
    this.#executionStages.set(envelope.assignmentId, "waiting-owner");
    const task = this.#execute(envelope, executionAbort.signal)
      .catch((error) => {
        if (!this.#recoveryStopped || !executionAbort.signal.aborted) {
          this.options.onError?.(envelope.assignmentId, asError(error));
        }
      })
      .finally(() => {
        this.#running.delete(envelope.assignmentId);
        if (this.#executionAborts.get(envelope.assignmentId) === executionAbort) {
          this.#executionAborts.delete(envelope.assignmentId);
        }
        this.#executionStages.delete(envelope.assignmentId);
        this.#activeInteractionBindings.delete(envelope.assignmentId);
        this.#interactions.releaseAssignment(envelope.assignmentId);
      });
    this.#running.set(envelope.assignmentId, task);
    return task;
  }

  abort(assignmentId: string, reason: Error): boolean {
    const controller = this.#executionAborts.get(assignmentId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(reason);
    return true;
  }

  async deliverGrant(grant: ChannelInteractionGrant): Promise<void> {
    await this.#interactions.deliverGrant(grant);
    await this.#wakeInteractionRecovery(grant.assignmentId);
  }

  async resolveNoInteractiveSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void> {
    await this.#interactions.resolveNoInteractiveSurface(input);
    await this.#wakeInteractionRecovery(input.assignmentId);
  }

  async answerInteractionWithTicket(
    input: Parameters<
      JobInteractionAnswerPort["answerInteractionWithTicket"]
    >[0],
  ): Promise<void> {
    await this.#interactions.answerInteractionWithTicket(input);
    await this.#wakeInteractionRecovery(input.assignmentId);
  }

  async abortWithTicket(request: ExecutionAbortRequest): Promise<void> {
    const disposition = await this.options.ledger.abortWithTicket(request);
    if (disposition.kind === "terminal") return;
    this.abort(request.assignmentId, new Error(request.reason));
    const envelope = await this.options.ledger.jobAssignmentForRecovery(
      request.assignmentId,
    );
    if (!envelope) {
      throw new Error("Ticket cancellation has no job assignment");
    }
    void this.#scheduleCancellation(envelope);
  }

  /**
   * owner fence 取消被接受后的执行侧落实:中止运行并调度耐久收束。
   * 取消的产品入口与 scheduler 装配归后续单元,这里只消费已冻结信号。
   * 非本域 assignment 静默让位;漏通知由取消收束恢复枚举兜底。
   */
  async cancelAccepted(assignmentId: string): Promise<void> {
    this.abort(assignmentId, new Error("Job assignment was cancelled"));
    const envelope = await this.options.ledger.jobAssignmentForRecovery(
      assignmentId,
    );
    if (!envelope) return;
    const phase =
      await this.options.ledger.jobAssignmentPhaseForRecovery(assignmentId);
    if (
      phase === "halted" ||
      phase === "failed" ||
      phase === "sealed" ||
      phase === "acked"
    ) {
      return;
    }
    await this.#scheduleCancellation(envelope);
  }

  async recover(): Promise<number> {
    if (this.#recoveryPump) return 0;
    if (this.#recoveryStopped || this.#closed) {
      throw new Error("Job assignment recovery is stopped");
    }
    const firstPage = await this.options.ledger.recoverableJobObligations({
      limit: JOB_RECOVERY_PAGE_SIZE,
    });
    this.#recoveryPump = this.#pumpRecovery(firstPage)
      .catch((error) => {
        if (!this.#recoveryAbort.signal.aborted) {
          this.options.onError?.("job-recovery", asError(error));
          throw error;
        }
      })
      .finally(() => {
        this.#recoveryPump = undefined;
      });
    void this.#recoveryPump.catch(() => undefined);
    return firstPage.entries.length;
  }

  async drain(): Promise<void> {
    await Promise.all([
      ...(this.#recoveryPump ? [this.#recoveryPump] : []),
      ...this.#running.values(),
      ...this.#interactionRecoveries.values(),
    ]);
  }

  async acceptedWorkItems(): Promise<readonly JobAcceptedWorkItem[]> {
    const items: JobAcceptedWorkItem[] = [];
    let page = await this.options.ledger.recoverableJobObligations({
      limit: JOB_RECOVERY_PAGE_SIZE,
    });
    for (;;) {
      for (const obligation of page.entries) {
        items.push(Object.freeze({
          id: obligation.envelope.assignmentId,
          revision: protocolDigest("ExecutorJobAcceptedWork", 1, obligation),
        }));
      }
      if (items.length > 50_000) {
        throw new Error("Executor accepted-work snapshot exceeds its bounded protocol");
      }
      if (!page.continuation) break;
      page = await this.options.ledger.recoverableJobObligations({
        limit: JOB_RECOVERY_PAGE_SIZE,
        continuation: page.continuation,
      });
    }
    return Object.freeze(items.sort((left, right) =>
      left.id.localeCompare(right.id, "en-US")));
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.stopAccepting();
    this.#closing = (async () => {
      this.#recoveryStopped = true;
      for (const [assignmentId, controller] of this.#executionAborts) {
        if (this.#executionStages.get(assignmentId) === "waiting-owner") {
          controller.abort(
            new Error(
              "Job assignment stopped before execution ownership was acquired",
            ),
          );
        }
      }
      this.#recoveryAbort.abort(
        new Error("Job assignment recovery was stopped"),
      );
      for (const timer of this.#interactionRecoveryTimers.values()) {
        clearTimeout(timer);
      }
      this.#interactionRecoveryTimers.clear();
      this.#interactionRecoveryRetryMs.clear();
      this.#recoveryQueue.close(
        new Error("Job assignment recovery was stopped"),
      );
      await Promise.all(
        [
          ...(this.#recoveryPump ? [this.#recoveryPump] : []),
          ...this.#running.values(),
          ...this.#interactionRecoveries.values(),
        ].map((task) => task.catch(() => undefined)),
      );
      this.#closed = true;
    })();
    return this.#closing;
  }

  async #execute(envelope: JobEnvelope, abortSignal: AbortSignal): Promise<void> {
    const assignmentId = envelope.assignmentId;
    const context = jobAssignmentContext(envelope);
    const owner = await this.options.submissionFor(envelope, abortSignal);
    const durableSubmission = new this.options.InProcessAssignmentSubmission({
      ledger: this.options.ledger,
      owner,
    });
    this.#executionStages.set(assignmentId, "starting");
    const started = await this.options.ledger.start(assignmentId);
    if (!started.started) {
      const phase =
        await this.options.ledger.jobAssignmentPhaseForRecovery(assignmentId);
      if (phase === "sealed") {
        const stream = await this.options.createStream({
          assignmentId,
          ref: jobStreamRef(envelope),
        });
        await this.#markStreamTerminal(stream);
      }
      await resumeSealedSubmission({
        assignmentId,
        ledger: this.options.ledger,
        owner,
        context,
        signal: this.#recoveryAbort.signal,
        rejectionPrefix: COMMIT_REJECTION_PREFIX,
      });
      return;
    }
    this.#executionStages.set(assignmentId, "started");
    try {
      await owner.reportStarted(assignmentId, context);
    } catch (error) {
      if (!shouldRetryRemoteObligation(error)) throw error;
    }

    const streamRef = jobStreamRef(envelope);
    const streamMeta = {};
    let toolCalls = 0;
    let outcome: JobRunOutcome | undefined;
    let runtime: JobRuntimeHandle | undefined;
    let stream: JobRunStream | undefined;
    let protocolEventOrdinal = 0;
    let yieldOrdinal = 0;
    let interactionBinding: ActiveJobInteractionBinding | undefined;
    let executionError: Error | undefined;
    try {
      const activeStream = await this.options.createStream({
        assignmentId,
        ref: streamRef,
      });
      stream = activeStream;
      const activeInteractionBinding: ActiveJobInteractionBinding = {
        assignmentId,
        ledger: this.options.ledger,
        submission: durableSubmission,
        context,
        stream: activeStream,
        streamMeta,
        signal: abortSignal,
        broker: undefined,
      };
      interactionBinding = activeInteractionBinding;
      this.#activeInteractionBindings.set(
        assignmentId,
        activeInteractionBinding,
      );
      await retryDurableObligation(
        () =>
          this.#interactions.drainAssignment(activeInteractionBinding),
        abortSignal,
      );
      const confirmationBroker = new ConfirmationBroker({
        lifecycleObserver:
          this.#interactions.lifecycleObserverFor(activeInteractionBinding),
      });
      activeInteractionBinding.broker = confirmationBroker;
      runtime = await this.options.runtime.create({
        taskId: envelope.work.taskId,
        jobRunId: envelope.work.jobRunId,
        confirmationBroker,
      });
      const generator = runtime.run(envelope.work.instruction, {
        abortSignal,
        onProtocolEvent: async (event) => {
          protocolEventOrdinal += 1;
          await activeStream.append(
            { kind: "agent-event", event },
            streamMeta,
            abortSignal,
            `event:${protocolEventOrdinal}`,
          );
        },
        authorizeToolExecution: () =>
          this.options.ledger.authorizeToolExecution(
            assignmentId,
            envelope.permissionLease,
          ),
        toolSideEffectObserver: this.#interactions,
        stageScheduleMutation: createAssignmentScheduleStager(
          this.options.ledger,
          assignmentId,
          envelope.work.fence.anchorEpoch,
          "job",
          assignmentGlobalCapability({
            assignmentId,
            execution: "job",
            capabilities: envelope.capabilities,
          }),
        ),
        assignmentMutations: createAssignmentMutationPort({
          ledger: this.options.ledger,
          assignmentId,
          execution: "job",
          anchorEpoch: envelope.work.fence.anchorEpoch,
          capability: assignmentGlobalCapability({
            assignmentId,
            execution: "job",
            capabilities: envelope.capabilities,
          }),
        }),
        assignmentIssuedAt: envelope.issuedAt,
        ...(this.options.globalQueryFor
          ? {
              globalQuery: this.options.globalQueryFor(
                assignmentGlobalCapability({
                  assignmentId,
                  execution: "job",
                  capabilities: envelope.capabilities,
                }),
                envelope.work.fence.anchorEpoch,
              ),
            }
          : {}),
        ...(this.options.resourceGovernor
          ? {
              resourceReservation: {
                port: this.options.resourceGovernor,
                parentLease: envelope.resourceLease,
                contextFor: (requestId: string) =>
                  jobResourceContext(envelope, requestId),
              },
              modelCallResourceMeter: {
                reserve: async ({ callIndex, tokenUpperBound }: {
                  callIndex: number;
                  tokenUpperBound: number;
                }) => {
                  const usageId = `usage:${assignmentId}:model:${callIndex}`;
                  await this.options.resourceGovernor!.reserveUsage(
                    envelope.resourceLease,
                    { usageId, tokens: tokenUpperBound, calls: 1 },
                    jobResourceContext(envelope, usageId),
                  );
                  return { usageId };
                },
                consume: async ({ usageId, tokens }: { usageId: string; tokens: number }) => {
                  await this.options.resourceGovernor!.consume(
                    envelope.resourceLease,
                    { usageId, ...(tokens === 0 ? {} : { tokens }), calls: 1 },
                    jobResourceContext(envelope, usageId),
                  );
                },
              },
            }
          : {}),
      });
      while (true) {
        const item = await this.#interactions.withBinding(
          activeInteractionBinding,
          () => generator.next(),
        );
        if (item.done) {
          outcome = item.value;
          break;
        }
        if (item.value.type === "tool_start") toolCalls += 1;
        yieldOrdinal += 1;
        await activeStream.append(
          { kind: "agent-yield", yield: item.value },
          streamMeta,
          abortSignal,
          `yield:${yieldOrdinal}`,
        );
      }
    } catch (error) {
      executionError = asError(error);
    }
    if (runtime) {
      try {
        await runtime.dispose();
      } catch (error) {
        executionError ??= asError(error);
      }
    }
    if (executionError || !outcome) {
      executionError ??= new Error("Job runtime ended without an outcome");
      if (await this.#hasPendingCancellation(assignmentId)) {
        await this.#settleCancelledStream(interactionBinding, stream);
        return;
      }
      const usageFinal = await this.#finalizeUsageUntilAvailable(
        assignmentId,
        envelope,
        abortSignal,
      );
      if (await this.#hasPendingCancellation(assignmentId)) {
        await this.#settleCancelledStream(interactionBinding, stream);
        return;
      }
      try {
        await this.#prepareRunEndUntilAvailable(
          assignmentId,
          durableSubmission,
          context,
          interactionBinding,
          abortSignal,
        );
        await stream?.final(streamMeta);
      } catch (error) {
        executionError = asError(error);
      }
      if (stream) await this.#markStreamTerminal(stream, abortSignal);
      await this.options.ledger.failExecution(assignmentId, {
        reason: executionError.message,
        usageFinal,
      });
      throw executionError;
    }
    if (!stream) {
      throw new TypeError("Job runtime completed without a stream");
    }
    if (!interactionBinding) {
      throw new TypeError("Job runtime completed without interaction binding");
    }
    if (await this.#hasPendingCancellation(assignmentId)) {
      await this.#settleCancelledStream(interactionBinding, stream);
      return;
    }
    const usageFinal = await this.#finalizeUsageUntilAvailable(
      assignmentId,
      envelope,
      abortSignal,
    );
    if (await this.#hasPendingCancellation(assignmentId)) {
      await this.#settleCancelledStream(interactionBinding, stream);
      return;
    }
    let streamFinal: Awaited<ReturnType<JobRunStream["final"]>>;
    try {
      await this.#prepareRunEndUntilAvailable(
        assignmentId,
        durableSubmission,
        context,
        interactionBinding,
        abortSignal,
      );
      streamFinal = await stream.final(streamMeta, abortSignal);
    } catch (error) {
      const failure = asError(error);
      await this.#markStreamTerminal(stream, abortSignal);
      await this.options.ledger.failExecution(assignmentId, {
        reason: failure.message,
        usageFinal,
      });
      throw failure;
    }
    // 业务失败(status: "failed")也是合法终态,同样封包提交给 owner 裁决;
    // 只有执行器自身异常才走上面的 failExecution 路径。
    const bundle = await this.options.ledger.sealJobBundle(assignmentId, {
      fence: envelope.work.fence,
      outcome: { status: outcome.status, summary: outcome.summary },
      contentAssets: [...outcome.contentAssets],
      streamFinal,
      usage: {
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        toolCalls,
      },
      usageFinal,
    });
    await this.#markStreamTerminal(stream);
    await submitBundleUntilAcknowledged({
      bundle,
      owner,
      ledger: this.options.ledger,
      context,
      signal: this.#recoveryAbort.signal,
      rejectionPrefix: COMMIT_REJECTION_PREFIX,
    });
  }

  async #pumpRecovery(
    firstPage: Awaited<
      ReturnType<ConversationAssignmentLedger["recoverableJobObligations"]>
    >,
  ): Promise<void> {
    let page = firstPage;
    while (!this.#recoveryAbort.signal.aborted) {
      const tasks = page.entries.map((obligation) =>
        this.#recoverObligation(obligation).catch((error) => {
          if (!this.#recoveryAbort.signal.aborted) {
            this.options.onError?.(
              obligation.envelope.assignmentId,
              asError(error),
            );
          }
        }),
      );
      await Promise.all(tasks);
      if (!page.continuation || this.#recoveryAbort.signal.aborted) return;
      page = await this.options.ledger.recoverableJobObligations({
        limit: JOB_RECOVERY_PAGE_SIZE,
        continuation: page.continuation,
      });
    }
  }

  async #recoverObligation(
    obligation: JobRecoveryObligation,
  ): Promise<void> {
    const { envelope } = obligation;
    if (obligation.cancellation) {
      await this.#scheduleCancellation(envelope);
      return;
    }
    if (obligation.interaction) {
      this.#scheduleInteractionRecovery(envelope);
      await this.#interactionRecoveries.get(envelope.assignmentId);
    }
    if (obligation.execution && !this.#recoveryAbort.signal.aborted) {
      await this.#recoveryQueue.run(async () => {
        await this.#startExecution(envelope);
      });
    }
  }

  #scheduleInteractionRecovery(envelope: JobEnvelope): void {
    if (this.#recoveryStopped || this.#closed) return;
    const deferred = this.#interactionRecoveryTimers.get(envelope.assignmentId);
    if (deferred) {
      clearTimeout(deferred);
      this.#interactionRecoveryTimers.delete(envelope.assignmentId);
    }
    this.#interactionRecoveryRequested.add(envelope.assignmentId);
    if (this.#interactionRecoveries.has(envelope.assignmentId)) return;
    const task = this.#recoveryQueue.run(async () => {
      do {
        this.#interactionRecoveryRequested.delete(envelope.assignmentId);
        await this.#recoverInteractionObligation(envelope);
      } while (
        !this.#recoveryStopped &&
        this.#interactionRecoveryRequested.has(envelope.assignmentId)
      );
    })
      .catch((error) => {
        if (!this.#recoveryAbort.signal.aborted) {
          this.options.onError?.(envelope.assignmentId, asError(error));
        }
        throw error;
      })
      .finally(() => {
        this.#interactionRecoveries.delete(envelope.assignmentId);
        this.#interactionRecoveryRequested.delete(envelope.assignmentId);
        if (!this.#activeInteractionBindings.has(envelope.assignmentId)) {
          this.#interactions.releaseAssignment(envelope.assignmentId);
        }
      });
    this.#interactionRecoveries.set(envelope.assignmentId, task);
    void task.catch(() => undefined);
  }

  async #wakeInteractionRecovery(assignmentId: string): Promise<void> {
    const envelope =
      await this.options.ledger.jobAssignmentForRecovery(assignmentId);
    if (!envelope) return;
    this.#scheduleInteractionRecovery(envelope);
    await this.#interactionRecoveries.get(assignmentId);
  }

  async #recoverInteractionObligation(
    envelope: JobEnvelope,
  ): Promise<void> {
    const assignmentId = envelope.assignmentId;
    const context = jobAssignmentContext(envelope);
    const owner = await this.options.submissionFor(
      envelope,
      this.#recoveryAbort.signal,
    );
    const submission = new this.options.InProcessAssignmentSubmission({
      ledger: this.options.ledger,
      owner,
    });
    const activeBinding = this.#activeInteractionBindings.get(assignmentId);
    const stream =
      activeBinding?.stream ??
      await this.options.createStream({
        assignmentId,
        ref: jobStreamRef(envelope),
      });
    const binding: ActiveJobInteractionBinding =
      activeBinding ?? {
        assignmentId,
        ledger: this.options.ledger,
        submission,
        context,
        stream,
        streamMeta: {},
        signal: this.#recoveryAbort.signal,
        broker: undefined,
      };
    while (!this.#recoveryAbort.signal.aborted) {
      let recovery: Awaited<
        ReturnType<ConversationAssignmentLedger["recoverInteractions"]>
      >;
      try {
        recovery = await this.#reconcileInteractionObligations({
          assignmentId,
          submission,
          context,
          binding,
        });
      } catch (error) {
        if (!isRetryableInteractionRecoveryFailure(error)) throw error;
        this.#deferInteractionRecovery(
          envelope,
          this.#nextInteractionRecoveryDelay(assignmentId),
        );
        return;
      }
      this.#interactionRecoveryRetryMs.delete(assignmentId);
      const ticketCancellation =
        await this.options.ledger.hasPendingTicketCancellation(assignmentId);
      if (ticketCancellation) {
        const proof =
          await this.options.ledger.continueTicketCancellation(assignmentId);
        if (proof) {
          try {
            await owner.submitCancelProof(assignmentId, proof, context);
            if (stream.markTerminal) {
              await stream.markTerminal();
            }
            await this.options.ledger
              .markTicketCancellationProofOwnerAccepted(assignmentId);
          } catch (error) {
            if (!isRetryableInteractionRecoveryFailure(error)) throw error;
            this.#deferInteractionRecovery(
              envelope,
              this.#nextInteractionRecoveryDelay(assignmentId),
            );
            return;
          }
          this.#interactionRecoveryRetryMs.delete(assignmentId);
          return;
        }
        if (await this.options.ledger.hasOpenSideEffects(assignmentId)) {
          const streamProof =
            await this.options.ledger.interactionStreamProjectionEnabled(
              assignmentId,
            )
              ? await this.options.ledger.interactionSettlementStreamProof(
                  assignmentId,
                )
              : undefined;
          try {
            await owner.completeInteractionSettlement(
              assignmentId,
              streamProof,
              context,
            );
            if (stream.markTerminal) {
              await stream.markTerminal();
            }
            await this.options.ledger
              .markInteractionSettlementOwnerAccepted(
                assignmentId,
                streamProof,
              );
          } catch (error) {
            if (!isRetryableInteractionRecoveryFailure(error)) throw error;
            this.#deferInteractionRecovery(
              envelope,
              this.#nextInteractionRecoveryDelay(assignmentId),
            );
            return;
          }
          this.#interactionRecoveryRetryMs.delete(assignmentId);
          return;
        }
      }
      if (recovery.pending.length === 0) return;
      if (activeBinding) return;
      const nextExpiry = Math.min(
        ...recovery.pending.map((request) => Date.parse(request.expiresAt)),
      );
      const remaining = Math.max(0, nextExpiry - Date.now());
      this.#deferInteractionRecovery(
        envelope,
        Math.min(Math.max(remaining, 25), 5_000),
      );
      return;
    }
  }

  #deferInteractionRecovery(envelope: JobEnvelope, delayMs: number): void {
    if (
      this.#recoveryStopped ||
      this.#closed ||
      this.#interactionRecoveryTimers.has(envelope.assignmentId)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.#interactionRecoveryTimers.delete(envelope.assignmentId);
      this.#scheduleInteractionRecovery(envelope);
    }, delayMs);
    timer.unref?.();
    this.#interactionRecoveryTimers.set(envelope.assignmentId, timer);
  }

  #nextInteractionRecoveryDelay(assignmentId: string): number {
    const current = this.#interactionRecoveryRetryMs.get(assignmentId) ?? 100;
    this.#interactionRecoveryRetryMs.set(
      assignmentId,
      Math.min(current * 2, 5_000),
    );
    return current;
  }

  /**
   * 已耐久取消的收束:先完成所有来源共享的本地 quiescence；abort-ticket
   * 再由 job worker 独占 proof 提交，owner-fence 则只由 owner dispatcher
   * 携原 fence 重驱，避免两个 owner 竞争同一终态。
   */
  #scheduleCancellation(envelope: JobEnvelope): Promise<void> {
    this.abort(
      envelope.assignmentId,
      new Error("Job assignment cancellation is being reconciled"),
    );
    this.#scheduleInteractionRecovery(envelope);
    return (
      this.#interactionRecoveries.get(envelope.assignmentId) ??
      Promise.resolve()
    );
  }

  async #finalizeUsageUntilAvailable(
    assignmentId: string,
    envelope: JobEnvelope,
    signal: AbortSignal,
  ): Promise<{ reportDigest: string; upToUsageSeq: number }> {
    return retryRemoteObligation(
      () => this.options.finalizeUsage({ assignmentId, envelope }),
      signal,
    );
  }

  async #hasPendingCancellation(assignmentId: string): Promise<boolean> {
    const [owner, ticket] = await Promise.all([
      this.options.ledger.hasPendingOwnerCancellation(assignmentId),
      this.options.ledger.hasPendingTicketCancellation(assignmentId),
    ]);
    return owner || ticket;
  }

  async #prepareRunEndUntilAvailable(
    assignmentId: string,
    submission: InProcessAssignmentSubmission,
    context: AuthorityCallContext,
    interactionBinding: ActiveJobInteractionBinding | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    await retryDurableObligation(
      async () => {
        await this.options.ledger.closePendingInteractionsForRunEnd(
          assignmentId,
        );
        if (interactionBinding) {
          this.#activeInteractionBindings.set(
            assignmentId,
            interactionBinding,
          );
          await this.#reconcileInteractionObligations({
            assignmentId,
            submission,
            context,
            binding: interactionBinding,
          });
        } else {
          await submission.flushInteractionMirrors(assignmentId, context);
        }
      },
      signal,
    );
  }

  async #reconcileInteractionObligations(input: {
    readonly assignmentId: string;
    readonly submission: InProcessAssignmentSubmission;
    readonly context: AuthorityCallContext;
    readonly binding: DurableJobInteractionBinding;
  }): Promise<
    Awaited<ReturnType<ConversationAssignmentLedger["recoverInteractions"]>>
  > {
    const current = await this.options.ledger.recoverInteractions(
      input.assignmentId,
    );
    const branches = await Promise.allSettled([
      input.submission.flushInteractionMirrors(
        input.assignmentId,
        input.context,
      ),
      this.#interactions.drainAssignment(input.binding),
    ]);
    const failures = branches
      .filter(
        (branch): branch is PromiseRejectedResult =>
          branch.status === "rejected",
      )
      .map((branch) => branch.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Job interaction convergence remains incomplete",
      );
    }
    return current;
  }

  async #markStreamTerminal(
    stream: JobRunStream,
    signal: AbortSignal = this.#recoveryAbort.signal,
  ): Promise<void> {
    if (!stream.markTerminal) return;
    await retryDurableObligation(
      () => stream.markTerminal!().then(() => undefined),
      signal,
    );
  }

  async #settleCancelledStream(
    binding: DurableJobInteractionBinding | undefined,
    stream: JobRunStream | undefined,
  ): Promise<void> {
    if (binding) {
      await retryDurableObligation(
        () => this.#interactions.drainAssignment(binding),
        this.#recoveryAbort.signal,
      );
    }
    if (stream) await this.#markStreamTerminal(stream);
  }
}

function jobResourceContext(
  envelope: JobEnvelope,
  requestId: string,
): AuthorityCallContext {
  const capability = assignmentGlobalCapability({
    assignmentId: envelope.assignmentId,
    execution: "job",
    capabilities: envelope.capabilities,
  });
  return {
    principal: { kind: "assignment", capability },
    requestId: `resource:${envelope.assignmentId}:${requestId}`,
    deadlineAt: capability.expiry,
  };
}

function isRetryableInteractionRecoveryFailure(error: unknown): boolean {
  if (error instanceof AuthorityStorageError) return false;
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every(isRetryableInteractionRecoveryFailure)
    );
  }
  return shouldRetryRemoteObligation(error);
}

function jobStreamRef(envelope: JobEnvelope): {
  readonly execution: "job";
  readonly jobRunId: string;
  readonly taskId: string;
  readonly anchorEpoch: number;
} {
  return {
    execution: "job",
    jobRunId: envelope.work.jobRunId,
    taskId: envelope.work.taskId,
    anchorEpoch: envelope.work.fence.anchorEpoch,
  };
}

function jobAssignmentContext(envelope: JobEnvelope): AuthorityCallContext {
  const capability = envelope.capabilities[0];
  if (!capability) throw new Error("Job assignment has no submission capability");
  return {
    principal: { kind: "assignment", capability },
    requestId: `submission:${envelope.assignmentId}`,
    deadlineAt: capability.expiry,
  };
}

class BoundedTaskQueue {
  readonly #pending: Array<{
    readonly run: () => Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  #active = 0;
  #closedError: Error | undefined;

  constructor(private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new TypeError("Bounded task queue concurrency must be positive");
    }
  }

  run(task: () => Promise<void>): Promise<void> {
    if (this.#closedError) return Promise.reject(this.#closedError);
    return new Promise<void>((resolve, reject) => {
      this.#pending.push({ run: task, resolve, reject });
      this.#drain();
    });
  }

  close(error: Error): void {
    this.#closedError = error;
    for (const pending of this.#pending.splice(0)) pending.reject(error);
  }

  #drain(): void {
    while (this.#active < this.concurrency) {
      const next = this.#pending.shift();
      if (!next) return;
      this.#active += 1;
      void next
        .run()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.#active -= 1;
          this.#drain();
        });
    }
  }
}
