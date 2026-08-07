import type {
  DeferredGlobalIntentPort,
  ScheduleWriteMutation,
} from "@zhixing/core/contracts";
import { validateDeferredIntentMutation } from "@zhixing/core/protocol";

export const DEFERRED_SCHEDULE_MESSAGE =
  "已记录但尚未生效，连接值班设备后需确认";

export interface DeferredScheduleIntentResult {
  readonly kind: "deferred";
  readonly intentId: string;
  readonly message: typeof DEFERRED_SCHEDULE_MESSAGE;
}

export interface DeferredScheduleIntentProducerOptions {
  readonly intents: DeferredGlobalIntentPort;
  readonly now?: () => string;
}

/** Local-only schedule write seam. It deliberately exposes no read/run/abort API. */
export class DeferredScheduleIntentProducer {
  readonly #intents: DeferredGlobalIntentPort;
  readonly #now: () => string;

  constructor(options: DeferredScheduleIntentProducerOptions) {
    this.#intents = options.intents;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async record(input: {
    readonly conversationId: string;
    readonly requestId: string;
    readonly mutation: ScheduleWriteMutation;
  }): Promise<DeferredScheduleIntentResult> {
    validateDeferredIntentMutation(input.mutation, true);
    const { intentId } = await this.#intents.record(
      input.conversationId,
      input.mutation,
      true,
      {
        principal: { kind: "host", component: "local-schedule-intent" },
        requestId: input.requestId,
        deadlineAt: new Date(Date.parse(this.#now()) + 30_000).toISOString(),
      },
    );
    return { kind: "deferred", intentId, message: DEFERRED_SCHEDULE_MESSAGE };
  }
}
