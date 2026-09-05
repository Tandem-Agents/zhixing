import type { AgentYield, RunResult } from "@zhixing/core/loop";
import type {
  ConversationPerspectivesCorrectnessPort,
  ConversationPerspectivesDurableExecutionInput,
  ConversationPerspectivesRuntimePort,
} from "@zhixing/core/conversation/application";
import type {
  ConversationManager,
  ManagedSession,
} from "@zhixing/owner-kernel/conversation-manager";
import type { SessionRuntime } from "@zhixing/owner-kernel/types";

export function createConversationPerspectivesCorrectnessPort(input: Readonly<{
  manager: () => ConversationManager;
}>): ConversationPerspectivesCorrectnessPort {
  const port: ConversationPerspectivesCorrectnessPort = {
    usesDurableTurnProtocol: () => input.manager().usesDurableTurnProtocol(),
    session: (conversationId) => {
      const managed = input.manager().getSession(conversationId);
      return managed ? projectConversationPerspectivesRuntime(managed) : undefined;
    },
    runDurable: (request) => runDurablePerspective(input.manager(), request),
    recordLegacyTurn: async (conversationId, record, turnId) => {
      await input.manager().recordTurn(
        conversationId,
        record,
        undefined,
        turnId ? { turnId } : undefined,
      );
    },
    publishPendingFinals: (conversationId) =>
      input.manager().publishPendingFinals(conversationId),
    releaseBusy: (conversationId) =>
      input.manager().setBusy(conversationId, false),
  };
  return Object.freeze(port);
}

export function projectConversationPerspectivesRuntime(
  managed: ManagedSession,
  runtime: SessionRuntime = managed.runtime,
): ConversationPerspectivesRuntimePort {
  const projection: ConversationPerspectivesRuntimePort = {
    conversationId: managed.conversationId,
    windowMessages: () => managed.window.getMessages(),
    turnCount: () => managed.turnCount,
    estimateMessagesTokens: (messages) =>
      runtime.estimateMessagesTokens?.(messages) ?? roughEstimateMessages(messages),
    callText: async (prompt, role, options) => {
      const runtimeOptions = {
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options?.modelCallMetering
          ? { modelCallMetering: options.modelCallMetering }
          : {}),
      };
      if (runtime.callTextWithUsage) {
        return runtime.callTextWithUsage(prompt, role, runtimeOptions);
      }
      if (runtime.callText) return runtime.callText(prompt, role, runtimeOptions);
      throw new Error("perspective allocation requires runtime text call support.");
    },
    runOrchestration: (request) => {
      if (!runtime.runOrchestrationV1) {
        throw new Error("session runtime does not support orchestration execution.");
      }
      return runtime.runOrchestrationV1({
        executable: request.executable,
        runInput: request.runInput,
        contextSnapshot: request.contextSnapshot,
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        eventBus: request.eventBus,
        parentLineage: "perspectives",
        ...(request.authorizeToolExecution
          ? { authorizeToolExecution: request.authorizeToolExecution }
          : {}),
        ...(request.modelCallMetering
          ? { modelCallMetering: request.modelCallMetering }
          : {}),
      });
    },
  };
  return Object.freeze(projection);
}

async function runDurablePerspective(
  manager: ConversationManager,
  input: ConversationPerspectivesDurableExecutionInput,
): Promise<Awaited<ReturnType<ConversationPerspectivesDurableExecutionInput["execute"]>>["outcome"]> {
  const durable = manager.durableTurnExecutor();
  if (!durable) {
    throw new Error("Durable Conversation perspective execution is unavailable");
  }
  const managed = manager.getSession(input.conversationId);
  if (!managed) {
    throw new Error(`Perspective Conversation runtime is missing: ${input.conversationId}`);
  }
  let outcome:
    | Awaited<ReturnType<ConversationPerspectivesDurableExecutionInput["execute"]>>["outcome"]
    | undefined;
  const createRuntime = (baseRuntime: SessionRuntime): SessionRuntime => ({
    sessionId: `perspectives:${input.conversationId}`,
    async *run(_messages, options): AsyncGenerator<AgentYield, RunResult> {
      const meter = options?.modelCallResourceMeter;
      let callIndex = 0;
      const execution = await input.execute(
        projectConversationPerspectivesRuntime(managed, baseRuntime),
        {
          ...(options?.authorizeToolExecution
            ? { authorizeToolExecution: options.authorizeToolExecution }
            : {}),
          ...(meter
            ? {
                modelCallMetering: {
                  meter,
                  nextCallIndex: () => ++callIndex,
                },
              }
            : {}),
        },
      );
      outcome = execution.outcome;
      return execution.runResult;
    },
    abort: (reason) => baseRuntime.abort(reason),
    async dispose() {},
    securitySnapshot: () => {
      const snapshot = baseRuntime.securitySnapshot?.();
      if (!snapshot) throw new Error("Perspective runtime lacks a security snapshot");
      return snapshot;
    },
    executionPermissionRules: () => {
      const rules = baseRuntime.executionPermissionRules?.();
      if (!rules) {
        throw new Error("Perspective runtime lacks an execution permission snapshot");
      }
      return rules;
    },
    executionProfile: () => {
      const profile = baseRuntime.executionProfile?.();
      if (!profile) throw new Error("Perspective runtime lacks an execution profile");
      return profile;
    },
  });
  const runtime = createRuntime(managed.runtime);
  const generator = durable.run({
    conversationId: input.conversationId,
    input: input.originalInput,
    messages: input.messages,
    baseRevision: input.baseRevision,
    runtime,
    adaptLocalRuntime: createRuntime,
    invocation: {
      kind: "perspectives",
      source: input.source,
      question: input.question,
    },
    options: {
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.turnContext ? { turnContext: input.turnContext } : {}),
      ...(input.surfacePrincipal
        ? { surfacePrincipal: input.surfacePrincipal }
        : {}),
      turnIndex: input.baseRevision,
      source: input.source,
    },
  });
  while (!(await generator.next()).done) {
    // Provisional orchestration events are delivered through the dedicated run bus.
  }
  if (!outcome) throw new Error("Perspective execution returned no durable outcome");
  return outcome;
}

function roughEstimateMessages(
  messages: readonly import("@zhixing/core").Message[],
): number {
  const chars = messages.reduce(
    (sum, message) => sum + JSON.stringify(message).length,
    0,
  );
  return Math.max(1, Math.ceil(chars / 4));
}
