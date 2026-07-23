import { Buffer } from "node:buffer";
import {
  AuthorityStorageError,
  type ArtifactStore,
} from "@zhixing/core/authority";
import {
  type Message,
  type RunResult,
} from "@zhixing/core";
import type {
  AuthorityCallContext,
  DispatchEnvelope,
  RunSubmissionPort,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  StreamDigestChain,
} from "@zhixing/core/protocol";
import type { RuntimeFactory } from "@zhixing/owner-kernel";
import type {
  ConversationAssignmentLedger,
  ExecutorResourceGovernor,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import type { DurableConversationInteractionObserver } from "./conversation-protocol-runtime.js";
import { shouldRetryRemoteObligation } from "./remote-obligation-failure.js";

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
  readonly onError?: (assignmentId: string, error: Error) => void;
}

type ConversationEnvelope = Extract<DispatchEnvelope, { execution: "conversation" }>;

/** Executor-owned lifecycle from durable receipt through owner acknowledgement. */
export class ConversationAssignmentWorker {
  readonly #running = new Map<string, Promise<void>>();
  readonly #executionAborts = new Map<string, AbortController>();
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

  async recover(): Promise<number> {
    const pending = await this.options.ledger
      .recoverableConversationAssignments();
    for (const envelope of pending) this.accept(envelope);
    return pending.length;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.#running.values()]);
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
    await Promise.all([...this.#running.values()].map((task) => task.catch(() => undefined)));
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

    const stream = new StreamDigestChain(assignmentId);
    const streamMeta = envelope.work.ingress.turnOrigin
      ? { turnOrigin: envelope.work.ingress.turnOrigin }
      : {};
    let toolCalls = 0;
    let result: RunResult | undefined;
    let runtime: Awaited<ReturnType<RuntimeFactory["create"]>> | undefined;
    let executionError: Error | undefined;
    try {
      runtime = await this.options.runtimeFactory.create(envelope.work.conversationId);
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
        onProtocolEvent: (event, meta) => stream.append(
          { kind: "agent-event", event },
          {
            ...streamMeta,
            ...(meta.lineage ? { lineage: meta.lineage } : {}),
          },
        ),
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
          {
            assignmentId,
            ledger: this.options.ledger,
            submission: durableSubmission,
            context,
            surfacePrincipal: envelope.work.ingress.surfacePrincipal,
            stream,
            streamMeta,
          },
          () => generator.next(),
        );
        if (item.done) {
          result = item.value;
          break;
        }
        if (item.value.type === "tool_start") toolCalls += 1;
        stream.append({ kind: "agent-yield", yield: item.value }, streamMeta);
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
    if (executionError) {
      const usageFinal = await this.#finalizeUsageUntilAvailable(assignmentId, envelope);
      await durableSubmission.prepareForRunEnd(assignmentId, context);
      await this.options.ledger.failExecution(assignmentId, {
        reason: executionError.message,
        usageFinal,
      });
      throw executionError;
    }

    if (!result) {
      const error = new Error("Conversation runtime ended without a result");
      const usageFinal = await this.#finalizeUsageUntilAvailable(assignmentId, envelope);
      await this.options.ledger.failExecution(assignmentId, {
        reason: error.message,
        usageFinal,
      });
      throw error;
    }
    const usageFinal = await this.#finalizeUsageUntilAvailable(assignmentId, envelope);
    if (result.agentResult.reason !== "completed") {
      await durableSubmission.prepareForRunEnd(assignmentId, context);
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
    await durableSubmission.prepareForRunEnd(assignmentId, context);
    const bundle = await this.options.ledger.sealConversationBundle(assignmentId, {
      runRecord,
      ...(result.windowCompact ? { windowCompact: result.windowCompact } : {}),
      contentAssets: [],
      streamFinal: stream.final(),
      usage: {
        inputTokens: result.agentResult.usage.inputTokens,
        outputTokens: result.agentResult.usage.outputTokens,
        toolCalls,
      },
      usageFinal,
    });
    await this.#submitUntilAcknowledged(bundle, submission, context);
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
