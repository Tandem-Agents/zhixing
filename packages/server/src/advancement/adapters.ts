import {
  WorksceneBusyError,
  type ConversationManager,
} from "@zhixing/owner-kernel";
import type {
  AdvancementEventSink,
  AdvancementProxyTurnPort,
} from "@zhixing/owner-services";
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
    async schedule(request) {
      const conversationId = request.conversationId;
      let taskSettled = false;
      const settleTask = () => {
        if (taskSettled) return;
        taskSettled = true;
        request.onTaskSettled?.();
      };

      let admission: Awaited<ReturnType<ConversationManager["admitTurn"]>>;
      try {
        admission = await options.manager.admitTurn({
          conversationId,
          exists: options.conversationExists
            ? () => options.conversationExists!(conversationId)
            : undefined,
          makeTask: (managed) => ({
            source: "advancement",
            execute: async () => {
              try {
                await projectSessionTurn({
                  manager: options.manager,
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
                  options.manager.setBusy(conversationId, false);
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
      return { status: admission.status };
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
