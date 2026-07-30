import {
  assistantMessage,
  AgentError,
  createEventBus,
  emptyUsage,
  extractText,
  mergeUsage,
  snapshotAttentionWindowV1,
  userMessageFromTurnInput,
  type AgentEventMap,
  type AgentYield,
  type EventBus,
  type Message,
  type OrchestrationExecutableV1,
  type OrchestrationRunResultV1,
  type OrchestrationSystemCapsV1,
  type TokenUsage,
  type RunResult,
} from "@zhixing/core";
import type { ConversationManager, SessionRuntime } from "@zhixing/owner-kernel";
import type { PendingTask } from "@zhixing/owner-kernel/conversation-manager";
import {
  DEFAULT_PERSPECTIVE_COUNT,
  MAX_PERSPECTIVE_COUNT,
} from "./allocation.js";
import {
  DEFAULT_PERSPECTIVES_CAPS,
  assemblePerspectiveExecutable,
} from "./assembly.js";
import {
  PERSPECTIVES_CONVERGENCE_NODE_ID,
  PERSPECTIVES_DELIBERATION_DEFINITION_ID,
} from "./deliberation-template.js";
import type {
  PerspectiveAllocation,
  PerspectivesControllerOptions,
  PerspectivesFailureStage,
  PerspectivesPendingTaskInput,
  PerspectivesTurnInput,
  PerspectivesTurnResult,
} from "./types.js";

const ALLOCATION_CONTEXT_MAX_CHARS = 4_000;

export class PerspectivesController {
  private readonly caps: OrchestrationSystemCapsV1;
  private readonly now: () => Date;

  constructor(private readonly options: PerspectivesControllerOptions) {
    this.caps = options.caps ?? DEFAULT_PERSPECTIVES_CAPS;
    this.now = options.now ?? (() => new Date());
  }

  createPendingTask(input: PerspectivesPendingTaskInput): PendingTask {
    const controller = new AbortController();
    const abort = (reason?: unknown): boolean => {
      if (controller.signal.aborted) return false;
      controller.abort(reason);
      return true;
    };
    return {
      source: input.source ?? "interactive",
      execute: async () => {
        try {
          const result = await this.runPerspectiveTurn({
            manager: input.manager,
            managed: input.managed,
            originalInput: input.originalInput,
            question: input.question,
            abortSignal: controller.signal,
            turnContext: input.turnContext,
            surfacePrincipal: input.surfacePrincipal,
            source: input.source,
          });
          await input.onResult?.(result);
        } finally {
          input.manager.setBusy(input.managed.conversationId, false);
        }
      },
      cancel: () => {
        abort();
      },
      abort,
    };
  }

  async runPerspectiveTurn(
    input: PerspectivesTurnInput,
  ): Promise<PerspectivesTurnResult> {
    const durable = input.manager.durableTurnExecutor();
    if (durable) {
      return this.runDurablePerspectiveTurn(input, durable);
    }
    return this.runPerspectiveWork(input, true);
  }

  async executePerspectiveWork(
    input: PerspectivesTurnInput,
  ): Promise<{
    readonly outcome: PerspectivesTurnResult;
    readonly runResult: RunResult;
  }> {
    const outcome = await this.runPerspectiveWork(input, false);
    return {
      outcome,
      runResult: perspectiveRunResult(outcome, input, this.now()),
    };
  }

  private async runDurablePerspectiveTurn(
    input: PerspectivesTurnInput,
    durable: NonNullable<ReturnType<ConversationManager["durableTurnExecutor"]>>,
  ): Promise<PerspectivesTurnResult> {
    let outcome: PerspectivesTurnResult | undefined;
    const controller = this;
    const createRuntime = (baseRuntime: SessionRuntime): SessionRuntime => ({
      sessionId: `perspectives:${input.managed.conversationId}`,
      async *run(_messages, options): AsyncGenerator<AgentYield, RunResult> {
        // durable assignment 注入的 meter——本 turn 独占该 assignment 的调用序列，
        // 分配调用与编排子 agent 共用同一 usageId 空间
        const meter = options?.modelCallResourceMeter;
        let callIndex = 0;
        const execution = await controller.executePerspectiveWork({
          ...input,
          managed: { ...input.managed, runtime: baseRuntime },
          authorizeToolExecution: options?.authorizeToolExecution,
          ...(meter
            ? {
                modelCallMetering: {
                  meter,
                  nextCallIndex: () => ++callIndex,
                },
              }
            : {}),
        });
        outcome = execution.outcome;
        return execution.runResult;
      },
      abort: (reason) => baseRuntime.abort(reason),
      async dispose() {},
      securitySnapshot() {
        const snapshot = baseRuntime.securitySnapshot?.();
        if (snapshot === undefined) {
          throw new Error("Perspective runtime lacks a security snapshot");
        }
        return snapshot;
      },
      executionPermissionRules() {
        const rules = baseRuntime.executionPermissionRules?.();
        if (rules === undefined) {
          throw new Error(
            "Perspective runtime lacks an execution permission snapshot",
          );
        }
        return rules;
      },
      executionProfile() {
        const profile = baseRuntime.executionProfile?.();
        if (profile === undefined) {
          throw new Error("Perspective runtime lacks an execution profile");
        }
        return profile;
      },
    });
    const runtime = createRuntime(input.managed.runtime);
    try {
      const generator = durable.run({
        conversationId: input.managed.conversationId,
        input: input.originalInput,
        messages: [
          ...input.managed.window.getMessages(),
          userMessageFromTurnInput(input.originalInput),
        ],
        baseRevision: input.managed.turnCount,
        runtime,
        adaptLocalRuntime: createRuntime,
        invocation: {
          kind: "perspectives",
          source: input.source ?? "interactive",
          question: input.question,
        },
        options: {
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          ...(input.turnContext ? { turnContext: input.turnContext } : {}),
          ...(input.surfacePrincipal
            ? { surfacePrincipal: input.surfacePrincipal }
            : {}),
          turnIndex: input.managed.turnCount,
          source: input.source ?? "interactive",
        },
      });
      while (!(await generator.next()).done) {
        // Perspective orchestration emits its provisional events through the run bus.
      }
      if (!outcome) {
        throw new Error("Perspective execution returned no durable outcome");
      }
    } catch (error) {
      return failed(
        "commit",
        `failed to commit perspective final answer: ${errorMessage(error)}`,
      );
    }
    if (outcome.status === "completed") {
      try {
        await input.manager.publishPendingFinals(input.managed.conversationId);
      } catch (error) {
        console.warn(
          "[perspectives] durable result committed; final publication will be retried",
          error,
        );
      }
    }
    return outcome;
  }

  private async runPerspectiveWork(
    input: PerspectivesTurnInput,
    commitLegacy: boolean,
  ): Promise<PerspectivesTurnResult> {
    const question = input.question.trim();
    if (question.length === 0) {
      return failed("allocation", "perspective question must not be empty.");
    }

    const eventBus = this.createRunEventBus();
    const disposeEvents = this.options.decorateRunBus?.({
      bus: eventBus,
      conversationId: input.managed.conversationId,
      turnContext: input.turnContext,
    });

    try {
      const snapshot = snapshotAttentionWindowV1(input.managed.window, {
        strategy: "tail",
        maxTokens: this.caps.maxContextSnapshotTokens,
        estimator: {
          estimateMessages: (messages) =>
            estimateMessages(input.managed.runtime, messages),
        },
        now: this.now,
      });
      if (!snapshot.ok) return failed("snapshot", snapshot.error.message);
      if (input.abortSignal?.aborted) {
        return aborted("snapshot", "perspective turn aborted before allocation.");
      }

      const allocation = await this.allocate(question, snapshot.snapshot.messages, input);
      if (allocation.status !== "ok") return allocation.result;

      const assembly = assembleSafely(allocation.value, this.caps);
      if (!assembly.ok) return assembly.result;
      if (input.abortSignal?.aborted) {
        return aborted("template", "perspective turn aborted before orchestration.");
      }

      let orchestration: OrchestrationRunResultV1;
      try {
        orchestration = await this.options.orchestrationExecutor.run({
          managed: input.managed,
          executable: assembly.executable,
          runInput: question,
          contextSnapshot: snapshot.snapshot,
          abortSignal: input.abortSignal,
          eventBus,
          authorizeToolExecution: input.authorizeToolExecution,
          ...(input.modelCallMetering
            ? { modelCallMetering: input.modelCallMetering }
            : {}),
        });
      } catch (err) {
        if (input.abortSignal?.aborted) {
          return aborted(
            "orchestration",
            "perspective orchestration aborted.",
            allocation.value.usage,
          );
        }
        return failed("orchestration", errorMessage(err), allocation.value.usage);
      }
      const usage = mergeUsage(
        allocation.value.usage ?? emptyUsage(),
        orchestration.usage,
      );
      if (orchestration.status === "aborted" || input.abortSignal?.aborted) {
        return aborted(
          "orchestration",
          formatOrchestrationFailure(orchestration),
          usage,
        );
      }
      if (orchestration.status !== "completed") {
        return failed(
          "orchestration",
          formatOrchestrationFailure(orchestration),
          usage,
        );
      }

      const finalText =
        orchestration.outputs[PERSPECTIVES_CONVERGENCE_NODE_ID]?.content.trim();
      if (!finalText) {
        return failed(
          "convergence",
          "perspective convergence did not produce a final answer.",
          usage,
        );
      }

      const messages = [
        userMessageFromTurnInput(input.originalInput),
        assistantMessage(finalText),
      ];
      if (commitLegacy) {
        const committed = await this.commitTurn(
          input,
          messages,
          usage,
          assembly.allocation.perspectives.length,
        );
        if (!committed.ok) return committed.result;
      }

      return {
        status: "completed",
        finalText,
        recordMessages: messages,
        allocation: assembly.allocation,
        orchestration,
        usage,
      };
    } finally {
      disposeEvents?.();
    }
  }

  private async allocate(
    question: string,
    snapshotMessages: readonly Message[],
    input: PerspectivesTurnInput,
  ): Promise<
    | { readonly status: "ok"; readonly value: PerspectiveAllocation }
    | { readonly status: "done"; readonly result: PerspectivesTurnResult }
  > {
    try {
      const allocation = await this.options.allocationStrategy.allocate({
        managed: input.managed,
        question,
        contextText: renderAllocationContext(snapshotMessages),
        defaultPerspectiveCount: DEFAULT_PERSPECTIVE_COUNT,
        maxPerspectiveCount: MAX_PERSPECTIVE_COUNT,
        abortSignal: input.abortSignal,
        ...(input.modelCallMetering
          ? { modelCallMetering: input.modelCallMetering }
          : {}),
      });
      return { status: "ok", value: allocation };
    } catch (err) {
      if (input.abortSignal?.aborted) {
        return {
          status: "done",
          result: aborted("allocation", "perspective allocation aborted."),
        };
      }
      return {
        status: "done",
        result: failed("allocation", errorMessage(err)),
      };
    }
  }

  private async commitTurn(
    input: PerspectivesTurnInput,
    messages: readonly Message[],
    usage: TokenUsage,
    perspectiveCount: number,
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly result: PerspectivesTurnResult }
  > {
    try {
      await input.manager.recordTurn(
        input.managed.conversationId,
        {
          timestamp: this.now().toISOString(),
          messages: [...messages],
          usage,
          source: input.source ?? "interactive",
          perspectives: {
            definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID,
            perspectiveCount,
          },
        },
        undefined,
        { turnId: input.turnContext?.turnId },
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        result: failed(
          "commit",
          `failed to commit perspective final answer: ${errorMessage(err)}`,
          usage,
        ),
      };
    }
  }

  private createRunEventBus(): EventBus<AgentEventMap> {
    return this.options.createRunEventBus?.() ?? createEventBus<AgentEventMap>();
  }
}

function perspectiveRunResult(
  result: PerspectivesTurnResult,
  input: PerspectivesTurnInput,
  completedAt: Date,
): RunResult {
  const user = userMessageFromTurnInput(input.originalInput);
  const usage = result.usage ?? emptyUsage();
  if (result.status === "completed") {
    const assistant = [...result.recordMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!assistant || assistant.role !== "assistant") {
      throw new Error("Perspective result has no assistant message");
    }
    return {
      agentResult: { reason: "completed", message: assistant, usage },
      runRecord: {
        timestamp: completedAt.toISOString(),
        messages: [...result.recordMessages],
        usage,
        source: input.source ?? "interactive",
        perspectives: {
          definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID,
          perspectiveCount: result.allocation.perspectives.length,
        },
      },
      newMessages: [assistant],
      durationMs: 0,
    };
  }
  return {
    agentResult:
      result.status === "aborted"
        ? { reason: "aborted", usage }
        : {
            reason: "error",
            error: new AgentError(result.message, "unknown", false),
            usage,
          },
    runRecord: {
      timestamp: completedAt.toISOString(),
      messages: [user],
      usage,
      source: input.source ?? "interactive",
    },
    newMessages: [],
    durationMs: 0,
  };
}

function assembleSafely(
  allocation: PerspectiveAllocation,
  caps: OrchestrationSystemCapsV1,
):
  | {
      readonly ok: true;
      readonly executable: OrchestrationExecutableV1;
      readonly allocation: PerspectiveAllocation;
    }
  | { readonly ok: false; readonly result: PerspectivesTurnResult } {
  try {
    const assembly = assemblePerspectiveExecutable({ allocation, caps });
    if (assembly.ok) return assembly;
    return {
      ok: false,
      result: failed(
        "template",
        assembly.loadResult.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; "),
        allocation.usage,
      ),
    };
  } catch (err) {
    return {
      ok: false,
      result: failed("allocation", errorMessage(err), allocation.usage),
    };
  }
}

function renderAllocationContext(messages: readonly Message[]): string {
  const text = messages
    .map((message) => `${message.role}: ${extractText(message)}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n");
  return text.length > ALLOCATION_CONTEXT_MAX_CHARS
    ? text.slice(-ALLOCATION_CONTEXT_MAX_CHARS)
    : text;
}

function estimateMessages(
  runtime: { estimateMessagesTokens?: (messages: readonly Message[]) => number },
  messages: readonly Message[],
): number {
  const tokens = runtime.estimateMessagesTokens?.(messages);
  if (tokens !== undefined) return tokens;
  return roughEstimateMessages(messages);
}

function roughEstimateMessages(messages: readonly Message[]): number {
  const chars = messages.reduce(
    (sum, message) => sum + JSON.stringify(message).length,
    0,
  );
  return Math.max(1, Math.ceil(chars / 4));
}

function formatOrchestrationFailure(result: OrchestrationRunResultV1): string {
  const runError = result.errors.run?.message;
  if (runError) return runError;
  const nodeError = Object.values(result.errors.nodes)[0]?.message;
  return nodeError ?? `perspective orchestration ended with status ${result.status}.`;
}

function failed(
  stage: PerspectivesFailureStage,
  message: string,
  usage?: TokenUsage,
): PerspectivesTurnResult {
  return { status: "failed", stage, message, usage };
}

function aborted(
  stage: PerspectivesFailureStage,
  message: string,
  usage?: TokenUsage,
): PerspectivesTurnResult {
  return { status: "aborted", stage, message, usage };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
