import type {
  WorksceneApplication,
  WorksceneContinuationPort,
} from "@zhixing/core/workscene/application";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import type { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type { AdvancementReviewAttemptApplication } from "@zhixing/core/advancement/application";
import { worksceneConversationId } from "@zhixing/core/conversation";
import { DurableConversationAdmissionRejectedError } from "@zhixing/owner-kernel/run-turn";

/** Infrastructure mapping; continuation decisions remain in the Workscene application. */
export function createWorksceneContinuationPort(input: {
  readonly manager: ConversationManager;
  readonly protocol: ConversationProtocolRuntime;
  readonly workscene: WorksceneApplication;
  readonly advancement: Pick<
    AdvancementReviewAttemptApplication,
    "queryActiveState" | "cancelSession"
  >;
  readonly mcp?: import("@zhixing/core/mcp-management").McpConnectionPort;
  readonly canRunIsolatedMain?: boolean;
}): WorksceneContinuationPort {
  const { manager, protocol, workscene } = input;
  return {
    pendingMcpStatus: (candidate, scope) => input.mcp?.pendingStatus?.(candidate, scope) ?? Promise.resolve("pending"),
    canRunIsolatedMain: () => input.canRunIsolatedMain === true,
    connectMcp: async (candidate, source, scope) => {
      if (!input.mcp) return { status: "failed", message: "MCP 接入入口不可用" };
      if (!await protocol.isWorksceneContinuationCurrent(source)) return { status: "failed", message: "原任务已经停止，未接入新能力" };
      const result = await input.mcp.connect(candidate, undefined, () => protocol.isWorksceneContinuationCurrent(source), scope);
      if (result.status === "active") manager.invalidateRuntimeProjections();
      return result;
    },
    stop: async (conversationId, runId, requestId) => {
      const source = (
        await protocol.worksceneContinuationSources(conversationId)
      ).find((item) => item.runId === runId);
      if (!source) throw new Error("原委托不存在");
      await protocol.cancel({
        conversationId,
        runId,
        requestId,
        principal: protocol.controlPrincipal({
          surfacePrincipal: source.surfacePrincipal,
          connectionId: "workscene-task-stop",
        }),
        reason: { kind: "user-cancel", source: "rpc", pressedAt: Date.now() },
      });
    },
    read: async (conversationId) =>
      Promise.all(
        (await protocol.worksceneContinuationSources(conversationId)).map(
          async (source) => ({
            ...source,
            current:
              source.current &&
              (!source.origin?.worksceneContinuation ||
                (await protocol.isWorksceneContinuationCurrent(
                  source.origin.worksceneContinuation,
                ))),
          }),
        ),
      ),
    inspect: async (conversationId, turnId) => {
      const run =
        (await manager.findDurableRunByIngress(
          conversationId,
          turnId,
          "interactive",
        )) ??
        (await manager.findDurableRunByIngress(
          conversationId,
          turnId,
          "advancement",
        ));
      if (!run) return "missing";
      return [
        "queued",
        "dispatched",
        "running",
        "cancel-requested",
        "uncertain",
      ].includes(run.state)
        ? "open"
        : "closed";
    },
    enter: async (sceneId, requestId) => {
      const observerId = `continuation:${requestId}`;
      const result = await workscene.execute({
        kind: "enter",
        sceneId,
        requestId,
        observerId,
      });
      if (result.kind !== "entered")
        throw new Error("Workscene entry returned another operation");
      manager.removeObserver(result.conversationId, observerId);
    },
    hasActiveAdvancement: async (conversationId) =>
      Boolean(await input.advancement.queryActiveState(conversationId)),
    workspaceMatches: async (sceneId, expected) => {
      const current = await workscene.projectConversationRuntime({
        conversationId: worksceneConversationId(sceneId, "primary"),
      });
      return (
        current.kind === "scene" &&
        (expected === null
          ? current.workspace === null
          : current.workspace?.deviceId === expected.deviceId &&
            current.workspace.bindingRef === expected.bindingRef)
      );
    },
    cancelAdvancement: async (conversationId, sessionId) => {
      const current = await input.advancement.queryActiveState(conversationId);
      if (current?.advancementSessionId !== sessionId) return;
      await input.advancement.cancelSession({
        conversationId,
        advancementSessionId: sessionId,
        reason: "user-cancelled",
        message: "受托工作已取消，原任务停止续推。",
      });
    },
    admit: async (request) => {
      try {
        const admitted = await manager.admitDurableTurn({
          conversationId: request.conversationId,
          input: request.input,
          invocation: {
            kind: "agent",
            source: request.advancement ? "advancement" : "interactive",
            ...(request.advancement
              ? { advancement: request.advancement }
              : {}),
          },
          options: {
            source: request.advancement ? "advancement" : "interactive",
            ...(request.advancement
              ? { advancement: request.advancement }
              : {}),
            surfacePrincipal: request.surfacePrincipal,
            turnContext: { turnId: request.turnId, turnOrigin: request.origin },
          },
          surfacePrincipal: request.surfacePrincipal,
        });
        // Recovery owns the accepted work; no listener/CLI lifetime owns its execution.
        if (admitted.shouldEnqueue) admitted.onDeferred?.();
      } catch (error) {
        // An unknown transport failure must replay the same receipt, not produce a second branch.
        if (error instanceof DurableConversationAdmissionRejectedError)
          return { rejected: error.message };
        throw error;
      }
    },
    cancel: async (conversationId, turnId) => {
      const run =
        (await manager.findDurableRunByIngress(
          conversationId,
          turnId,
          "interactive",
        )) ??
        (await manager.findDurableRunByIngress(
          conversationId,
          turnId,
          "advancement",
        ));
      if (
        run &&
        [
          "queued",
          "dispatched",
          "running",
          "cancel-requested",
          "uncertain",
        ].includes(run.state)
      )
        await protocol.cancelAdmitted(conversationId, run.runId);
    },
  };
}
