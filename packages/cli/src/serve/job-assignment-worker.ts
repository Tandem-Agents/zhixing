import {
  ConfirmationBroker,
  type AgentYield,
  type IConfirmationBroker,
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
import type { StreamFrameProducer } from "@zhixing/core/protocol";
import type {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import {
  abortableDelay,
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

const COMMIT_REJECTION_PREFIX = "Job commit rejected";

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

export interface JobRuntimeRunOptions {
  readonly abortSignal: AbortSignal;
  readonly onProtocolEvent: (
    event: SessionEventProjection,
  ) => Promise<void>;
  readonly authorizeToolExecution: () => Promise<unknown>;
  readonly toolSideEffectObserver: ToolSideEffectObserver;
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
  readonly submissionFor: (envelope: JobEnvelope) => JobSubmissionOwner;
  readonly finalizeUsage: (input: {
    readonly assignmentId: string;
    readonly envelope: JobEnvelope;
  }) => Promise<{ reportDigest: string; upToUsageSeq: number }>;
  readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
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

/** Executor-owned job lifecycle from durable receipt through owner acknowledgement. */
export class JobAssignmentWorker implements JobInteractionAnswerPort {
  readonly #running = new Map<string, Promise<void>>();
  readonly #cancellations = new Map<string, Promise<void>>();
  readonly #cancellationQuiescences = new Map<string, Promise<void>>();
  readonly #interactionRecoveries = new Map<string, Promise<void>>();
  readonly #executionAborts = new Map<string, AbortController>();
  readonly #abort = new AbortController();
  readonly #interactions: DurableJobInteractionCoordinator;
  #closed = false;

  constructor(private readonly options: JobAssignmentWorkerOptions) {
    this.#interactions = new DurableJobInteractionCoordinator(options.ledger);
  }

  accept(envelope: DispatchEnvelope): void {
    if (this.#closed || envelope.execution !== "job") return;
    if (this.#running.has(envelope.assignmentId)) return;
    const executionAbort = new AbortController();
    this.#executionAborts.set(envelope.assignmentId, executionAbort);
    const task = this.#execute(envelope, executionAbort.signal)
      .catch((error) => this.options.onError?.(envelope.assignmentId, asError(error)))
      .finally(() => {
        this.#running.delete(envelope.assignmentId);
        if (this.#executionAborts.get(envelope.assignmentId) === executionAbort) {
          this.#executionAborts.delete(envelope.assignmentId);
        }
        this.#interactions.releaseAssignment(envelope.assignmentId);
      });
    this.#running.set(envelope.assignmentId, task);
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
    await this.#quiesceCancellation(envelope);
  }

  async recover(): Promise<number> {
    const [pending, cancellations, interactions] = await Promise.all([
      this.options.ledger.recoverableJobAssignments(),
      this.options.ledger.recoverableJobCancellations(),
      this.options.ledger.recoverableJobInteractionAssignments(),
    ]);
    const claimed = new Set([
      ...pending.map((envelope) => envelope.assignmentId),
      ...cancellations.map((envelope) => envelope.assignmentId),
    ]);
    for (const envelope of pending) this.accept(envelope);
    for (const envelope of cancellations) {
      void this.#scheduleCancellation(envelope);
    }
    for (const envelope of interactions) {
      if (!claimed.has(envelope.assignmentId)) {
        this.#scheduleInteractionRecovery(envelope);
      }
    }
    return (
      pending.length +
      cancellations.length +
      interactions.filter((envelope) => !claimed.has(envelope.assignmentId))
        .length
    );
  }

  async drain(): Promise<void> {
    await Promise.all([
      ...this.#running.values(),
      ...this.#cancellations.values(),
      ...this.#cancellationQuiescences.values(),
      ...this.#interactionRecoveries.values(),
    ]);
  }

  stopAccepting(): void {
    this.#closed = true;
  }

  async close(): Promise<void> {
    this.stopAccepting();
    this.#abort.abort(new Error("Job assignment worker stopped"));
    for (const controller of this.#executionAborts.values()) {
      controller.abort(new Error("Job assignment worker stopped"));
    }
    await Promise.all(
      [
        ...this.#running.values(),
        ...this.#cancellations.values(),
        ...this.#cancellationQuiescences.values(),
        ...this.#interactionRecoveries.values(),
      ].map((task) => task.catch(() => undefined)),
    );
  }

  async #execute(envelope: JobEnvelope, abortSignal: AbortSignal): Promise<void> {
    const assignmentId = envelope.assignmentId;
    const context = jobAssignmentContext(envelope);
    const owner = this.options.submissionFor(envelope);
    const durableSubmission = new this.options.InProcessAssignmentSubmission({
      ledger: this.options.ledger,
      owner,
    });
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
        signal: abortSignal,
        rejectionPrefix: COMMIT_REJECTION_PREFIX,
      });
      return;
    }
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
    let interactionBinding: DurableJobInteractionBinding | undefined;
    let executionError: Error | undefined;
    try {
      const activeStream = await this.options.createStream({
        assignmentId,
        ref: streamRef,
      });
      stream = activeStream;
      const activeInteractionBinding: DurableJobInteractionBinding = {
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
      if (stream) await this.#markStreamTerminal(stream);
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
      await this.#markStreamTerminal(stream);
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
      signal: this.#abort.signal,
      rejectionPrefix: COMMIT_REJECTION_PREFIX,
    });
  }

  #scheduleInteractionRecovery(envelope: JobEnvelope): void {
    if (
      this.#closed ||
      this.#running.has(envelope.assignmentId) ||
      this.#cancellations.has(envelope.assignmentId) ||
      this.#interactionRecoveries.has(envelope.assignmentId)
    ) {
      return;
    }
    const task = this.#recoverInteractionObligation(envelope)
      .catch((error) =>
        this.options.onError?.(envelope.assignmentId, asError(error)),
      )
      .finally(() => {
        this.#interactionRecoveries.delete(envelope.assignmentId);
        this.#interactions.releaseAssignment(envelope.assignmentId);
      });
    this.#interactionRecoveries.set(envelope.assignmentId, task);
  }

  async #wakeInteractionRecovery(assignmentId: string): Promise<void> {
    if (this.#running.has(assignmentId)) return;
    const envelope =
      await this.options.ledger.jobAssignmentForRecovery(assignmentId);
    if (envelope) this.#scheduleInteractionRecovery(envelope);
  }

  async #recoverInteractionObligation(
    envelope: JobEnvelope,
  ): Promise<void> {
    const assignmentId = envelope.assignmentId;
    const context = jobAssignmentContext(envelope);
    const owner = this.options.submissionFor(envelope);
    const submission = new this.options.InProcessAssignmentSubmission({
      ledger: this.options.ledger,
      owner,
    });
    const stream = await this.options.createStream({
      assignmentId,
      ref: jobStreamRef(envelope),
    });
    const binding: DurableJobInteractionBinding = {
      assignmentId,
      ledger: this.options.ledger,
      submission,
      context,
      stream,
      streamMeta: {},
      signal: this.#abort.signal,
      broker: undefined,
    };
    while (!this.#abort.signal.aborted) {
      const recovery = await retryDurableObligation(
        async () => {
          const current = await this.options.ledger.recoverInteractions(
            assignmentId,
          );
          await submission.flushInteractionMirrors(assignmentId, context);
          await this.#interactions.drainAssignment(binding);
          return current;
        },
        this.#abort.signal,
      );
      if (recovery.pending.length === 0) return;
      const nextExpiry = Math.min(
        ...recovery.pending.map((request) => Date.parse(request.expiresAt)),
      );
      const remaining = Math.max(0, nextExpiry - Date.now());
      await abortableDelay(Math.min(Math.max(remaining, 25), 5_000), this.#abort.signal);
    }
  }

  /**
   * 已耐久取消的收束:先完成所有来源共享的本地 quiescence；abort-ticket
   * 再由 job worker 独占 proof 提交，owner-fence 则只由 owner dispatcher
   * 携原 fence 重驱，避免两个 owner 竞争同一终态。
   */
  #scheduleCancellation(envelope: JobEnvelope): Promise<void> {
    const existing = this.#cancellations.get(envelope.assignmentId);
    if (existing) return existing;
    const task = (async () => {
      await this.#quiesceCancellation(envelope);
      if (
        !(await this.options.ledger.hasPendingTicketCancellation(
          envelope.assignmentId,
        ))
      ) {
        return;
      }
      const owner = this.options.submissionFor(envelope);
      const context = jobAssignmentContext(envelope);
      await retryDurableObligation(
        async () => {
          const proof =
            await this.options.ledger.continueTicketCancellation(
              envelope.assignmentId,
            );
          if (proof) {
            await owner.submitCancelProof(
              envelope.assignmentId,
              proof,
              context,
            );
            return;
          }
          if (
            await this.options.ledger.hasOpenSideEffects(
              envelope.assignmentId,
            )
          ) {
            await owner.completeInteractionSettlement(
              envelope.assignmentId,
              context,
            );
            return;
          }
          throw new Error("Ticket cancellation proof is not yet available");
        },
        this.#abort.signal,
      );
    })()
      .catch((error) =>
        this.options.onError?.(envelope.assignmentId, asError(error)),
      )
      .finally(() => {
        this.#cancellations.delete(envelope.assignmentId);
      });
    this.#cancellations.set(envelope.assignmentId, task);
    return task;
  }

  #quiesceCancellation(envelope: JobEnvelope): Promise<void> {
    const existing = this.#cancellationQuiescences.get(envelope.assignmentId);
    if (existing) return existing;
    const running = this.#running.get(envelope.assignmentId);
    const task = (async () => {
      if (running) await running;
      const owner = this.options.submissionFor(envelope);
      const submission = new this.options.InProcessAssignmentSubmission({
        ledger: this.options.ledger,
        owner,
      });
      const context = jobAssignmentContext(envelope);
      const stream = await this.options.createStream({
        assignmentId: envelope.assignmentId,
        ref: jobStreamRef(envelope),
      });
      const binding: DurableJobInteractionBinding = {
        assignmentId: envelope.assignmentId,
        ledger: this.options.ledger,
        submission,
        context,
        stream,
        streamMeta: {},
        signal: this.#abort.signal,
      };
      await this.#settleCancelledStream(binding, stream);
    })().finally(() => {
      this.#cancellationQuiescences.delete(envelope.assignmentId);
    });
    this.#cancellationQuiescences.set(envelope.assignmentId, task);
    return task;
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
    interactionBinding: DurableJobInteractionBinding | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    await retryDurableObligation(
      async () => {
        await submission.prepareForRunEnd(assignmentId, context);
        if (interactionBinding) {
          await this.#interactions.drainAssignment(interactionBinding);
        }
      },
      signal,
    );
  }

  async #markStreamTerminal(stream: JobRunStream): Promise<void> {
    if (!stream.markTerminal) return;
    await retryDurableObligation(
      () => stream.markTerminal!().then(() => undefined),
      this.#abort.signal,
    );
  }

  async #settleCancelledStream(
    binding: DurableJobInteractionBinding | undefined,
    stream: JobRunStream | undefined,
  ): Promise<void> {
    if (binding) {
      await retryDurableObligation(
        () => this.#interactions.drainAssignment(binding),
        binding.signal,
      );
    }
    if (stream) await this.#markStreamTerminal(stream);
  }
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
