import { Buffer } from "node:buffer";
import {
  AuthorityStorageError,
  type ArtifactStore,
} from "@zhixing/core/authority";
import {
  type IConfirmationBroker,
  type Message,
  type RunResult,
} from "@zhixing/core";
import type {
  AuthorityCallContext,
  DispatchEnvelope,
  ExecutionAbortRequest,
  ExecutionRef,
  RunSubmissionPort,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  StreamDigestChain,
  type StreamFrameProducer,
} from "@zhixing/core/protocol";
import type { RuntimeFactory } from "@zhixing/owner-kernel";
import type {
  ConversationAssignmentLedger,
  ExecutorResourceGovernor,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import type { DurableConversationInteractionObserver } from "./conversation-protocol-runtime.js";
import {
  shouldRetryRemoteObligation,
} from "./remote-obligation-failure.js";
import { retryDurableObligation } from "./durable-obligation-retry.js";

export interface ConversationAssignmentWorkerOptions {
  readonly ledger: ConversationAssignmentLedger;
  readonly runtimeFactory: RuntimeFactory;
  readonly artifacts: ArtifactStore;
  readonly submissionFor: (envelope: ConversationEnvelope) => RunSubmissionPort;
  readonly finalizeUsage: (input: {
    readonly assignmentId: string;
    readonly envelope: ConversationEnvelope;
  }) => Promise<{ reportDigest: string; upToUsageSeq: number }>;
  readonly resourceGovernor?: ExecutorResourceGovernor;
  readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
  readonly interactions: DurableConversationInteractionObserver;
  readonly createStream?: (input: {
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
  }) => AssignmentRunStream | Promise<AssignmentRunStream>;
  readonly onError?: (assignmentId: string, error: Error) => void;
}

type ConversationEnvelope = Extract<DispatchEnvelope, { execution: "conversation" }>;

export type AssignmentRunStream = StreamFrameProducer;

/** Executor-owned lifecycle from durable receipt through owner acknowledgement. */
export class ConversationAssignmentWorker {
  readonly #running = new Map<string, Promise<void>>();
  readonly #cancellations = new Map<string, Promise<void>>();
  readonly #executionAborts = new Map<string, AbortController>();
  readonly #confirmationBrokers = new Map<string, IConfirmationBroker>();
  readonly #abort = new AbortController();
  #closed = false;

  constructor(private readonly options: ConversationAssignmentWorkerOptions) {}

  accept(envelope: DispatchEnvelope): void {
    if (this.#closed || envelope.execution !== "conversation") return;
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
        this.options.interactions.releaseAssignment(envelope.assignmentId);
      });
    this.#running.set(envelope.assignmentId, task);
  }

  abort(assignmentId: string, reason: Error): boolean {
    const controller = this.#executionAborts.get(assignmentId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(reason);
    return true;
  }

  async abortWithTicket(request: ExecutionAbortRequest): Promise<void> {
    const disposition = await this.options.ledger.abortWithTicket(request);
    if (disposition.kind === "terminal") return;
    this.abort(request.assignmentId, new Error(request.reason));
    const envelope = await this.options.ledger.conversationAssignmentForRecovery(
      request.assignmentId,
    );
    if (!envelope) {
      throw new Error("Ticket cancellation has no conversation assignment");
    }
    this.#scheduleCancellation(envelope);
  }

  async answerInteractionWithTicket(
    input: Parameters<
      ConversationAssignmentLedger["prepareInteractionAnswerFromSurface"]
    >[0],
  ): Promise<void> {
    const prepared =
      await this.options.ledger.prepareInteractionAnswerFromSurface(input);
    if (prepared.kind === "replayed") return;
    const broker = this.#confirmationBrokers.get(input.assignmentId);
    if (!broker) {
      throw new Error("Interaction answer has no active assignment runtime");
    }
    if (
      await this.options.interactions.resolveWithSurfaceTicket(broker, {
        assignmentId: input.assignmentId,
        requestId: input.requestId,
        ticketId: prepared.ticketId,
        surfacePrincipal: prepared.surfacePrincipal,
        decision: prepared.decision,
      })
    ) {
      return;
    }
    const replay =
      await this.options.ledger.prepareInteractionAnswerFromSurface(input);
    if (replay.kind !== "replayed") {
      throw new Error("Interaction answer did not reach a durable terminal result");
    }
  }

  async recover(): Promise<number> {
    const [pending, cancellations] = await Promise.all([
      this.options.ledger.recoverableConversationAssignments(),
      this.options.ledger.recoverableConversationCancellations(),
    ]);
    for (const envelope of pending) this.accept(envelope);
    for (const envelope of cancellations) this.#scheduleCancellation(envelope);
    return pending.length + cancellations.length;
  }

  async drain(): Promise<void> {
    await Promise.all([
      ...this.#running.values(),
      ...this.#cancellations.values(),
    ]);
  }

  stopAccepting(): void {
    this.#closed = true;
  }

  async close(): Promise<void> {
    this.stopAccepting();
    this.#abort.abort(new Error("Conversation assignment worker stopped"));
    for (const controller of this.#executionAborts.values()) {
      controller.abort(new Error("Conversation assignment worker stopped"));
    }
    await Promise.all(
      [...this.#running.values(), ...this.#cancellations.values()].map((task) =>
        task.catch(() => undefined),
      ),
    );
  }

  async #execute(envelope: ConversationEnvelope, abortSignal: AbortSignal): Promise<void> {
    const assignmentId = envelope.assignmentId;
    const context = assignmentContext(envelope);
    const submission = this.options.submissionFor(envelope);
    const durableSubmission = new this.options.InProcessAssignmentSubmission({
      ledger: this.options.ledger,
      owner: submission,
    });
    const started = await this.options.ledger.start(assignmentId);
    if (!started.started) {
      await this.#resumeSealedSubmission(assignmentId, submission, context);
      return;
    }
    try {
      await submission.reportStarted(assignmentId, context);
    } catch (error) {
      if (!shouldRetryRemoteObligation(error)) throw error;
    }

    const streamRef: ExecutionRef = {
      execution: "conversation",
      conversationId: envelope.work.conversationId,
      runId: envelope.work.runId,
      ownerEpoch: envelope.work.ownerEpoch,
    };
    const streamMeta = envelope.work.ingress.turnOrigin
      ? { turnOrigin: envelope.work.ingress.turnOrigin }
      : {};
    let toolCalls = 0;
    let result: RunResult | undefined;
    let runtime: Awaited<ReturnType<RuntimeFactory["create"]>> | undefined;
    let stream: AssignmentRunStream | undefined;
    let protocolEventOrdinal = 0;
    let yieldOrdinal = 0;
    let interactionBinding:
      | Parameters<DurableConversationInteractionObserver["drainAssignment"]>[0]
      | undefined;
    let executionError: Error | undefined;
    try {
      const activeStream = this.options.createStream
        ? await this.options.createStream({ assignmentId, ref: streamRef })
        : new StreamDigestChain(assignmentId);
      stream = activeStream;
      const activeInteractionBinding = {
        assignmentId,
        ledger: this.options.ledger,
        submission: durableSubmission,
        context,
        surfacePrincipal: envelope.work.ingress.surfacePrincipal,
        stream: activeStream,
        streamMeta,
        signal: this.#abort.signal,
      };
      interactionBinding = activeInteractionBinding;
      await retryDurableObligation(
        () =>
          this.options.interactions.drainAssignment(activeInteractionBinding),
        this.#abort.signal,
      );
      runtime = await this.options.runtimeFactory.create(envelope.work.conversationId);
      if (runtime.confirmationBroker) {
        this.#confirmationBrokers.set(assignmentId, runtime.confirmationBroker);
      }
      const messages = await loadWindowMessages(envelope, this.options.artifacts);
      const generator = runtime.run(messages, {
        abortSignal,
        turnIndex: envelope.work.baseRevision,
        source: envelope.work.ingress.kind === "channel" ? "channel" : "interactive",
        turnContext: {
          turnId: envelope.work.ingress.ingressId,
          ...(envelope.work.ingress.kind === "channel"
            ? { emissionTarget: envelope.work.ingress.replyTarget }
            : {}),
          ...(envelope.work.ingress.turnOrigin
            ? { turnOrigin: envelope.work.ingress.turnOrigin }
            : {}),
        },
        onProtocolEvent: async (event, meta) => {
          protocolEventOrdinal += 1;
          await activeStream.append(
            { kind: "agent-event", event },
            {
              ...streamMeta,
              ...(meta.lineage ? { lineage: meta.lineage } : {}),
            },
            abortSignal,
            `event:${protocolEventOrdinal}`,
          );
        },
        authorizeToolExecution: () =>
          this.options.ledger.authorizeToolExecution(
            assignmentId,
            envelope.permissionLease,
          ),
        toolSideEffectObserver: this.options.interactions,
        ...(this.options.resourceGovernor
          ? {
              modelCallResourceMeter: {
                reserve: async ({ callIndex, tokenUpperBound }: {
                  callIndex: number;
                  tokenUpperBound: number;
                }) => {
                  const usageId = `usage:${assignmentId}:model:${callIndex}`;
                  await this.options.resourceGovernor!.reserveUsage(
                    envelope.resourceLease,
                    { usageId, tokens: tokenUpperBound, calls: 1 },
                    assignmentResourceContext(envelope, usageId),
                  );
                  return { usageId };
                },
                consume: async ({ usageId, tokens }: { usageId: string; tokens: number }) => {
                  await this.options.resourceGovernor!.consume(
                    envelope.resourceLease,
                    { usageId, ...(tokens === 0 ? {} : { tokens }), calls: 1 },
                    assignmentResourceContext(envelope, usageId),
                  );
                },
              },
            }
          : {}),
      });
      while (true) {
        const item = await this.options.interactions.withBinding(
          interactionBinding,
          () => generator.next(),
        );
        if (item.done) {
          result = item.value;
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
    this.#confirmationBrokers.delete(assignmentId);
    if (executionError) {
      const usageFinal = await this.#finalizeUsageUntilAvailable(assignmentId, envelope);
      if (await this.options.ledger.hasPendingTicketCancellation(assignmentId)) {
        return;
      }
      try {
        await this.#prepareRunEndUntilAvailable(
          assignmentId,
          durableSubmission,
          context,
          interactionBinding,
        );
      } catch (error) {
        executionError = asError(error);
      }
      await this.options.ledger.failExecution(assignmentId, {
        reason: executionError.message,
        usageFinal,
      });
      throw executionError;
    }

    if (!result) {
      const error = new Error("Conversation runtime ended without a result");
      const usageFinal = await this.#finalizeUsageUntilAvailable(assignmentId, envelope);
      if (await this.options.ledger.hasPendingTicketCancellation(assignmentId)) {
        return;
      }
      await this.options.ledger.failExecution(assignmentId, {
        reason: error.message,
        usageFinal,
      });
      throw error;
    }
    if (!stream) {
      throw new TypeError("Conversation runtime completed without a stream");
    }
    const usageFinal = await this.#finalizeUsageUntilAvailable(assignmentId, envelope);
    if (await this.options.ledger.hasPendingTicketCancellation(assignmentId)) {
      return;
    }
    if (result.agentResult.reason !== "completed") {
      try {
        await this.#prepareRunEndUntilAvailable(
          assignmentId,
          durableSubmission,
          context,
          interactionBinding,
        );
      } catch (error) {
        const failure = asError(error);
        await this.options.ledger.failExecution(assignmentId, {
          reason: failure.message,
          usageFinal,
        });
        throw failure;
      }
      await this.options.ledger.failExecution(assignmentId, {
        reason: runFailureReason(result),
        usageFinal,
      });
      return;
    }
    const source = result.runRecord.source;
    const advancement = result.runRecord.advancement;
    const runRecord: TranscriptRunRecord = {
      ...result.runRecord,
      type: "run",
      runId: envelope.work.runId,
      runIndex: envelope.work.baseRevision,
      ...(source ? { source } : {}),
      ...(advancement ? { advancement } : {}),
    };
    let streamFinal: Awaited<ReturnType<AssignmentRunStream["final"]>>;
    try {
      if (!interactionBinding) {
        throw new TypeError("Conversation runtime completed without interaction binding");
      }
      await this.#prepareRunEndUntilAvailable(
        assignmentId,
        durableSubmission,
        context,
        interactionBinding,
      );
      streamFinal = await stream.final(streamMeta, abortSignal);
    } catch (error) {
      const failure = asError(error);
      await this.options.ledger.failExecution(assignmentId, {
        reason: failure.message,
        usageFinal,
      });
      throw failure;
    }
    const bundle = await this.options.ledger.sealConversationBundle(assignmentId, {
      runRecord,
      ...(result.windowCompact ? { windowCompact: result.windowCompact } : {}),
      contentAssets: [],
      streamFinal,
      usage: {
        inputTokens: result.agentResult.usage.inputTokens,
        outputTokens: result.agentResult.usage.outputTokens,
        toolCalls,
      },
      usageFinal,
    });
    await this.#submitUntilAcknowledged(bundle, submission, context);
  }

  #scheduleCancellation(envelope: ConversationEnvelope): void {
    if (this.#cancellations.has(envelope.assignmentId)) return;
    const running = this.#running.get(envelope.assignmentId);
    const task = (async () => {
      if (running) await running;
      const owner = this.options.submissionFor(envelope);
      const submission = new this.options.InProcessAssignmentSubmission({
        ledger: this.options.ledger,
        owner,
      });
      const context = assignmentContext(envelope);
      await retryDurableObligation(
        async () => {
          await submission.flushInteractionMirrors(
            envelope.assignmentId,
            context,
          );
          const proof = await this.options.ledger.continueTicketCancellation(
            envelope.assignmentId,
          );
          if (!proof) {
            if (
              await this.options.ledger.hasOpenSideEffects(
                envelope.assignmentId,
              )
            ) {
              throw new IncompleteCancellationProofError(
                "Ticket cancellation retains an open side effect for owner reconciliation",
              );
            }
            throw new Error("Ticket cancellation proof is not yet available");
          }
          await owner.submitCancelProof(envelope.assignmentId, proof, context);
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
  }

  async #resumeSealedSubmission(
    assignmentId: string,
    submission: RunSubmissionPort,
    context: AuthorityCallContext,
  ): Promise<void> {
    let delayMs = 100;
    let bundle: Awaited<ReturnType<ConversationAssignmentLedger["sealedBundle"]>> | undefined;
    while (!this.#abort.signal.aborted) {
      try {
        const recovered = await this.options.ledger.sealedBundleForRecovery(assignmentId);
        if (recovered.kind === "not-sealed") return;
        bundle = recovered.bundle;
        break;
      } catch (error) {
        if (
          error instanceof AuthorityStorageError ||
          !shouldRetryRemoteObligation(error)
        ) {
          throw error;
        }
        await abortableDelay(delayMs, this.#abort.signal);
        delayMs = Math.min(delayMs * 2, 5_000);
      }
    }
    if (!bundle) throw asError(this.#abort.signal.reason);
    await this.#submitUntilAcknowledged(bundle, submission, context);
  }

  async #submitUntilAcknowledged(
    bundle: Awaited<ReturnType<ConversationAssignmentLedger["sealedBundle"]>>,
    submission: RunSubmissionPort,
    context: AuthorityCallContext,
  ): Promise<void> {
    let delayMs = 100;
    while (!this.#abort.signal.aborted) {
      try {
        const committed = await submission.submitBundle(bundle, context);
        if (!committed.committed) {
          if (!committed.error.retryable) {
            throw new StableAuthorityRejection(committed.error.message);
          }
        } else {
          await this.options.ledger.acknowledge(bundle.assignmentId, committed.commitRevision);
          return;
        }
      } catch (error) {
        if (
          error instanceof StableAuthorityRejection ||
          !shouldRetryRemoteObligation(error)
        ) {
          throw error;
        }
      }
      await abortableDelay(delayMs, this.#abort.signal);
      delayMs = Math.min(delayMs * 2, 5_000);
    }
    throw asError(this.#abort.signal.reason);
  }

  async #finalizeUsageUntilAvailable(
    assignmentId: string,
    envelope: ConversationEnvelope,
  ): Promise<{ reportDigest: string; upToUsageSeq: number }> {
    let delayMs = 100;
    while (!this.#abort.signal.aborted) {
      try {
        return await this.options.finalizeUsage({ assignmentId, envelope });
      } catch (error) {
        if (!shouldRetryRemoteObligation(error)) throw error;
        await abortableDelay(delayMs, this.#abort.signal);
        delayMs = Math.min(delayMs * 2, 5_000);
      }
    }
    throw asError(this.#abort.signal.reason);
  }

  async #prepareRunEndUntilAvailable(
    assignmentId: string,
    submission: InProcessAssignmentSubmission,
    context: AuthorityCallContext,
    interactionBinding:
      | Parameters<DurableConversationInteractionObserver["drainAssignment"]>[0]
      | undefined,
  ): Promise<void> {
    await retryDurableObligation(
      async () => {
        await submission.prepareForRunEnd(assignmentId, context);
        if (interactionBinding) {
          await this.options.interactions.drainAssignment(interactionBinding);
        }
      },
      this.#abort.signal,
    );
  }
}

async function loadWindowMessages(
  envelope: ConversationEnvelope,
  artifacts: ArtifactStore,
): Promise<readonly Message[]> {
  const input = envelope.work.windowInput;
  if (input.t !== "full") {
    throw new Error("Remote executor requires a full window after losing its local base");
  }
  if (Array.isArray(input.messages)) return input.messages;
  const text = Buffer.from(await artifacts.get(input.messages.ref)).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text || !Array.isArray(value)) {
    throw new TypeError("Conversation window artifact is not a canonical message array");
  }
  return value as Message[];
}

function assignmentContext(envelope: ConversationEnvelope): AuthorityCallContext {
  const capability = envelope.capabilities[0];
  if (!capability) throw new Error("Conversation assignment has no submission capability");
  return {
    principal: { kind: "assignment", capability },
    requestId: `submission:${envelope.assignmentId}`,
    deadlineAt: capability.expiry,
  };
}

function assignmentResourceContext(
  envelope: ConversationEnvelope,
  usageId: string,
): AuthorityCallContext {
  const context = assignmentContext(envelope);
  return {
    ...context,
    requestId: `resource:${envelope.assignmentId}:${usageId}`,
  };
}

function runFailureReason(result: RunResult): string {
  if (result.agentResult.reason === "error") return result.agentResult.error.message;
  if (result.agentResult.reason === "max_turns") return "达到最大轮次限制";
  if (result.agentResult.reason === "aborted") return "运行已中止";
  return "运行未完成";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

class StableAuthorityRejection extends Error {
  constructor(message: string) {
    super(`Conversation commit rejected: ${message}`);
    this.name = "StableAuthorityRejection";
  }
}

class IncompleteCancellationProofError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteCancellationProofError";
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(asError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(asError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
