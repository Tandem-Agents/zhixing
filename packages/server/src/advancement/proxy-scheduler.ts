import type {
  AdvancementProxyMessage,
  AdvancementSession,
  RunRecordAdvancementMetadata,
  TurnContext,
} from "@zhixing/core";
import type { ConversationManager } from "../runtime/conversation-manager.js";
import { projectSessionTurn } from "../rpc/session-turn-stream.js";
import type { SessionBroadcast } from "../rpc/session-broadcast.js";

export interface ProxyMessageSchedulerOptions {
  readonly manager: ConversationManager;
  readonly sessionBroadcast?: () => SessionBroadcast | null;
  readonly conversationExists?: (conversationId: string) => Promise<boolean>;
}

export interface ScheduleProxyMessageInput {
  readonly session: AdvancementSession;
  readonly proxyMessage: AdvancementProxyMessage;
  readonly onTaskSettled?: () => void;
}

export type ScheduleProxyMessageResult =
  | { readonly status: "immediate" | "queued" }
  | { readonly status: "not-found" | "full" };

export class ProxyMessageScheduler {
  private readonly manager: ConversationManager;
  private readonly sessionBroadcast: () => SessionBroadcast | null;
  private readonly conversationExists?: (
    conversationId: string,
  ) => Promise<boolean>;

  constructor(options: ProxyMessageSchedulerOptions) {
    this.manager = options.manager;
    this.sessionBroadcast = options.sessionBroadcast ?? (() => null);
    this.conversationExists = options.conversationExists;
  }

  async schedule(
    input: ScheduleProxyMessageInput,
  ): Promise<ScheduleProxyMessageResult> {
    const conversationId = input.session.conversationId;
    let taskSettled = false;
    const settleTask = () => {
      if (taskSettled) return;
      taskSettled = true;
      input.onTaskSettled?.();
    };
    const admission = await this.manager.admitTurn({
      conversationId,
      exists: this.conversationExists
        ? () => this.conversationExists!(conversationId)
        : undefined,
      makeTask: (managed) => ({
        source: "advancement",
        execute: async () => {
          try {
            await projectSessionTurn({
              manager: this.manager,
              managed,
              input: input.proxyMessage.content,
              turnId: input.proxyMessage.id,
              runOptions: {
                turnContext: proxyTurnContext(input.proxyMessage),
                turnIndex: managed.turnCount,
                source: "advancement",
                advancement: proxyRunMetadata(input),
              },
              notify: (method, params) =>
                this.sessionBroadcast()?.(conversationId, method, params),
            });
          } finally {
            try {
              this.manager.setBusy(conversationId, false);
            } finally {
              settleTask();
            }
          }
        },
        cancel: settleTask,
      }),
    });

    if (admission.status === "immediate") {
      void admission.task.execute();
    }
    if (admission.status === "queued" || admission.status === "immediate") {
      return { status: admission.status };
    }
    return { status: admission.status };
  }
}

function proxyTurnContext(proxyMessage: AdvancementProxyMessage): TurnContext {
  return {
    turnId: proxyMessage.id,
    turnOrigin: {
      channel: "advancement",
      triggeredBy: proxyMessage.id,
    },
  };
}

function proxyRunMetadata(
  input: ScheduleProxyMessageInput,
): RunRecordAdvancementMetadata {
  return {
    sessionId: input.session.id,
    proxyMessageId: input.proxyMessage.id,
    reviewId: input.proxyMessage.reviewId,
    rubricFailureHandlingId: input.proxyMessage.rubricFailureHandlingId,
  };
}
