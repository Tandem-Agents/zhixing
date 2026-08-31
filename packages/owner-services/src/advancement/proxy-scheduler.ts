import type {
  AdvancementProxyMessage,
  AdvancementSession,
  RunRecordAdvancementMetadata,
  TurnContext,
} from "@zhixing/core";
import type {
  AdvancementReviewProxySchedulePort,
} from "@zhixing/core/advancement/application";
import type {
  AdvancementProxyScheduleResult,
  AdvancementProxyTurnPort,
} from "./ports.js";

export interface ProxyMessageSchedulerOptions {
  readonly proxyTurns: AdvancementProxyTurnPort;
}

export interface ScheduleProxyMessageInput {
  readonly session: AdvancementSession;
  readonly proxyMessage: AdvancementProxyMessage;
  readonly onTaskSettled?: () => void;
}

export type ScheduleProxyMessageResult = AdvancementProxyScheduleResult;

export class ProxyMessageScheduler {
  private readonly proxyTurns: AdvancementProxyTurnPort;

  constructor(options: ProxyMessageSchedulerOptions) {
    this.proxyTurns = options.proxyTurns;
  }

  async schedule(
    input: ScheduleProxyMessageInput,
  ): Promise<ScheduleProxyMessageResult> {
    return this.proxyTurns.schedule({
      conversationId: input.session.conversationId,
      input: input.proxyMessage.content,
      turnId: input.proxyMessage.id,
      turnContext: proxyTurnContext(input.proxyMessage),
      advancement: proxyRunMetadata(input),
      onTaskSettled: input.onTaskSettled,
    });
  }
}

/** Keeps proxy scheduling mechanics behind the Domain application port. */
export function createAdvancementReviewProxySchedulePort(
  proxyTurns: AdvancementProxyTurnPort,
): AdvancementReviewProxySchedulePort {
  const scheduler = new ProxyMessageScheduler({ proxyTurns });
  return {
    schedule: (input) => scheduler.schedule(input).then(() => undefined),
  };
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
