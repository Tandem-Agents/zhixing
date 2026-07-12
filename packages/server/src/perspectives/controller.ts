import {
  assistantMessage,
  createEventBus,
  emptyUsage,
  extractText,
  mergeUsage,
  snapshotAttentionWindowV1,
  userMessageFromTurnInput,
  type AgentEventMap,
  type EventBus,
  type Message,
  type OrchestrationExecutableV1,
  type OrchestrationRunResultV1,
  type OrchestrationSystemCapsV1,
  type TokenUsage,
} from "@zhixing/core";
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
      const committed = await this.commitTurn(
        input,
        messages,
        usage,
        assembly.allocation.perspectives.length,
      );
      if (!committed.ok) return committed.result;

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
