import {
  DurableConversationAdmissionRejectedError,
  WorksceneBusyError,
  type ConversationManager,
} from "@zhixing/owner-kernel";
import type {
  AdvancementEventSink,
  AdvancementOriginalTaskAdmissionPort,
  AdvancementProxyTurnPort,
} from "@zhixing/owner-services";
import { protocolDigest } from "@zhixing/core/protocol";
import type { SessionBroadcast } from "@zhixing/rpc/session-broadcast";
import { createControlSessionEventEnvelope } from "@zhixing/rpc/session-events";
import { projectSessionTurn } from "@zhixing/rpc/session-turn-stream";
import { SESSION_NOTIFICATIONS } from "@zhixing/rpc/session-wire";

export function createAdvancementEventSink(
  sessionBroadcast: () => SessionBroadcast | null,
): AdvancementEventSink {
  return {
    emit(event) {
      sessionBroadcast()?.(
        event.conversationId,
        SESSION_NOTIFICATIONS.event,
        createControlSessionEventEnvelope(event),
      );
    },
  };
}

export interface AdvancementProxyTurnAdapterOptions {
  readonly manager: ConversationManager;
  readonly sessionBroadcast?: () => SessionBroadcast | null;
  readonly conversationExists?: (conversationId: string) => Promise<boolean>;
}

export function createAdvancementProxyTurnPort(
  options: AdvancementProxyTurnAdapterOptions,
): AdvancementProxyTurnPort {
  return {
    isRunning(conversationId) {
      return options.manager.getBusySource(conversationId) === "advancement";
    },
    async inspectDurableClaim(conversationId, proxyMessageId) {
      if (!options.manager.usesDurableTurnProtocol()) {
        // legacy 无耐久 run 日志:耐久 claim 确定不存在,是显式判定而非缺能力兜底。
        return { status: "unclaimed" };
      }
      const durable = await options.manager.findDurableRunByIngress(
        conversationId,
        proxyMessageId,
        "advancement",
      );
      if (!durable) return { status: "unclaimed" };
      return durable.state === "cancelled" ||
        durable.state === "failed" ||
        durable.state === "expired"
        ? { status: "closed", runId: durable.runId }
        : { status: "owned", runId: durable.runId };
    },
    async schedule(request) {
      const manager = options.manager;
      const conversationId = request.conversationId;
      let taskSettled = false;
      const settleTask = () => {
        if (taskSettled) return;
        taskSettled = true;
        request.onTaskSettled?.();
      };

      let admission: Awaited<ReturnType<ConversationManager["admitTurn"]>>;
      try {
        admission = await manager.admitTurn({
          conversationId,
          exists: options.conversationExists
            ? () => options.conversationExists!(conversationId)
            : undefined,
          source: "advancement",
          beforeEnqueue: (managed) =>
            manager.admitDurableTurn({
              conversationId: managed.conversationId,
              input: request.input,
              invocation: {
                kind: "agent",
                source: "advancement",
                advancement: request.advancement,
              },
              options: {
                turnContext: request.turnContext,
                source: "advancement",
                advancement: request.advancement,
              },
            }),
          makeTask: (managed) => ({
            source: "advancement",
            execute: async () => {
              try {
                await projectSessionTurn({
                  manager,
                  managed,
                  input: request.input,
                  turnId: request.turnId,
                  runOptions: {
                    turnContext: request.turnContext,
                    turnIndex: managed.turnCount,
                    source: "advancement",
                    advancement: request.advancement,
                  },
                  notify: (method, params) =>
                    options.sessionBroadcast?.()?.(
                      conversationId,
                      method,
                      params,
                    ),
                });
              } finally {
                try {
                  manager.setBusy(conversationId, false);
                } finally {
                  settleTask();
                }
              }
            },
            cancel: settleTask,
          }),
        });
      } catch (error) {
        if (isWorksceneBusyError(error)) return { status: "busy" };
        throw error;
      }

      if (admission.status === "immediate") {
        void admission.task.execute();
      }
      return {
        status: admission.status === "replayed" ? "queued" : admission.status,
      };
    },
  };
}

export function createAdvancementOriginalTaskAdmissionPort(
  manager: ConversationManager,
  options?: {
    readonly conversationExists?: (conversationId: string) => Promise<boolean>;
  },
): AdvancementOriginalTaskAdmissionPort {
  return {
    async admit(session) {
      const obligation = session.originalTaskAdmission;
      if (!obligation) {
        throw new Error("Advancement original-task admission intent is missing");
      }
      const expected = protocolDigest(
        "AdvancementOriginalTaskInput",
        1,
        session.originalUserTask,
      );
      if (expected !== obligation.intent.inputDigest) {
        throw new Error("Advancement original-task admission input digest mismatch");
      }
      if (
        options?.conversationExists &&
        !(await options.conversationExists(session.conversationId))
      ) {
        return {
          status: "rejected",
          reason: "conversation-not-found",
          message: "Original conversation no longer exists",
        };
      }
      try {
        const admission = await manager.admitDurableTurn({
          conversationId: session.conversationId,
          input: session.originalUserTask,
          invocation: { kind: "agent", source: "interactive" },
          options: {
            turnContext: {
              turnId: obligation.intent.turnId,
              turnOrigin: obligation.intent.turnOrigin,
            },
            source: "interactive",
            surfacePrincipal: obligation.intent.surfacePrincipal,
          },
          surfacePrincipal: obligation.intent.surfacePrincipal,
        });
        if (admission.shouldEnqueue) admission.onDeferred?.();
        if (!admission.runId) {
          throw new Error("Durable original-task admission did not return a run id");
        }
        return { status: "admitted", runId: admission.runId };
      } catch (error) {
        if (error instanceof DurableConversationAdmissionRejectedError) {
          return {
            status: "rejected",
            reason: error.code,
            message: error.message,
          };
        }
        throw error;
      }
    },
  };
}

function isWorksceneBusyError(error: unknown): boolean {
  return (
    error instanceof WorksceneBusyError ||
    (error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: unknown }).code === "WORKSCENE_BUSY")
  );
}
