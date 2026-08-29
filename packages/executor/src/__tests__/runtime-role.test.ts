import {
  defineRuntimeFactoryConformance,
  type RuntimeFactoryConformanceHarness,
} from "@zhixing/test-utils";
import type { SessionRuntime } from "@zhixing/owner-kernel";
import { describe, expect, it, vi } from "vitest";
import {
  createExecutorRole,
  createInProcessRuntimeFactory,
  type ExecutorRoleOptions,
} from "../runtime-role.js";

type AgentRuntime = Awaited<
  ReturnType<ExecutorRoleOptions["createAgentRuntime"]>
>;
type AgentRunParams = Parameters<AgentRuntime["run"]>[0];
type AgentRunCompletion = Awaited<ReturnType<AgentRuntime["run"]>>;
type RunInput = Parameters<SessionRuntime["run"]>[0];
type RunOptions = Parameters<SessionRuntime["run"]>[1];
type RunIterator = ReturnType<SessionRuntime["run"]>;
type RunYield = RunIterator extends AsyncGenerator<infer Yield, unknown>
  ? Yield
  : never;
type RunResult = RunIterator extends AsyncGenerator<unknown, infer Result>
  ? Result
  : never;
type AbortReason = NonNullable<Parameters<SessionRuntime["abort"]>[0]>;

const COMPLETED_INPUT = [
  { role: "user", content: [{ type: "text", text: "complete" }] },
] as unknown as RunInput;
const INTERRUPTED_INPUT = [
  { role: "user", content: [{ type: "text", text: "interrupt" }] },
] as unknown as RunInput;
const FAILED_INPUT = [
  { role: "user", content: [{ type: "text", text: "fail" }] },
] as unknown as RunInput;
const COMPLETED_OPTIONS = {
  turnIndex: 7,
  source: "interactive",
} as RunOptions;
const COMPLETED_YIELDS = [
  { type: "text_delta", text: "first" },
  { type: "text_delta", text: "second" },
] as RunYield[];
const INTERRUPTED_YIELD = {
  type: "text_delta",
  text: "started",
} as RunYield;
const ABORT_REASON = {
  kind: "external",
  origin: "runtime-factory-conformance",
} as AbortReason;
const REPLACEMENT_ABORT_REASON = {
  kind: "external",
  origin: "must-not-replace-first-reason",
} as AbortReason;
const RUN_ERROR = new Error("conformance execution failure");

function buildResult(
  input: RunInput,
  reason: "completed" | "aborted",
  abortReason?: AbortReason,
): RunResult {
  const assistant = {
    role: "assistant",
    content: reason === "completed" ? [{ type: "text", text: "complete" }] : [],
  };
  return {
    agentResult:
      reason === "completed"
        ? {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        : {
            reason: "aborted",
            abortReason,
            usage: { inputTokens: 0, outputTokens: 0 },
          },
    runRecord: {
      timestamp: "2026-07-12T00:00:00.000Z",
      messages: [...input, assistant],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    newMessages: reason === "completed" ? [assistant] : [],
    durationMs: 1,
  } as RunResult;
}

function buildKernelCompletion(
  input: RunInput,
  reason: "completed" | "aborted",
  abortReason?: AbortReason,
): AgentRunCompletion {
  const assistant = {
    role: "assistant" as const,
    content:
      reason === "completed"
        ? [{ type: "text" as const, text: "complete" }]
        : [],
  };
  return {
    terminal:
      reason === "completed"
        ? {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        : {
            reason: "aborted",
            abortReason,
            usage: { inputTokens: 0, outputTokens: 0 },
          },
    artifacts: {
      runRecord: {
        timestamp: "2026-07-12T00:00:00.000Z",
        messages: [...input, assistant],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      newMessages: reason === "completed" ? [assistant] : [],
      durationMs: 1,
    },
  };
}

function createHarness(): RuntimeFactoryConformanceHarness<
  RunInput,
  RunOptions,
  RunYield,
  RunResult,
  AbortReason
> & { createAgentRuntime: ReturnType<typeof vi.fn> } {
  const brokers = new Map<string, object>();
  const disposals = new Map<string, ReturnType<typeof vi.fn>>();
  const completedInvocations: AgentRunParams[] = [];
  const createAgentRuntime = vi.fn(async (sessionId: string) => {
    const broker = { sessionId };
    const dispose = vi.fn(async () => {});
    brokers.set(sessionId, broker);
    disposals.set(sessionId, dispose);

    return {
      confirmationBroker: broker,
      drainLifecycleDiagnostics: () => [],
      async run(params: AgentRunParams): Promise<AgentRunCompletion> {
        const conversationId = params.identity.conversationId;
        if (conversationId === "conversation-failed") throw RUN_ERROR;
        if (conversationId === "conversation-interrupted") {
          await params.observation.onEvent?.(INTERRUPTED_YIELD);
          return await new Promise<AgentRunCompletion>((resolve, reject) => {
            const signal = params.control.abortSignal;
            if (!signal) {
              reject(new Error("conformance run requires an abort signal"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                resolve(
                  buildKernelCompletion(
                    INTERRUPTED_INPUT,
                    "aborted",
                    signal.reason as AbortReason,
                  ),
                );
              },
              { once: true },
            );
          });
        }

        completedInvocations.push(params);
        for (const event of COMPLETED_YIELDS) {
          await params.observation.onEvent?.(event);
        }
        return buildKernelCompletion(COMPLETED_INPUT, "completed");
      },
      dispose,
    } as AgentRuntime;
  });
  const role = createExecutorRole({ createAgentRuntime });

  return {
    factory: createInProcessRuntimeFactory(role),
    createAgentRuntime,
    completed: {
      input: COMPLETED_INPUT,
      options: COMPLETED_OPTIONS,
      yields: COMPLETED_YIELDS,
      result: buildResult(COMPLETED_INPUT, "completed"),
    },
    failed: {
      input: FAILED_INPUT,
      error: RUN_ERROR,
    },
    interrupted: {
      input: INTERRUPTED_INPUT,
      firstYield: INTERRUPTED_YIELD,
      reason: ABORT_REASON,
      replacementReason: REPLACEMENT_ABORT_REASON,
      result: buildResult(INTERRUPTED_INPUT, "aborted", ABORT_REASON),
    },
    brokerFor(sessionId) {
      return brokers.get(sessionId);
    },
    expectCompletedInvocation() {
      expect(completedInvocations).toHaveLength(1);
      expect(completedInvocations[0]).toMatchObject({
        modelInput: { messages: COMPLETED_INPUT },
        identity: {
          conversationId: "conversation-completed",
          turnIndex: 7,
          source: "interactive",
        },
      });
    },
    expectDisposed(sessionId) {
      expect(disposals.get(sessionId)).toHaveBeenCalledWith("session-dispose");
    },
  };
}

defineRuntimeFactoryConformance("in-process executor topology", createHarness);

describe("executor role", () => {
  it("has no startup or listener side effects", () => {
    const harness = createHarness();

    expect(harness.createAgentRuntime).not.toHaveBeenCalled();
  });
});
