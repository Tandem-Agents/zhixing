import type {
  ChannelMessageRef,
  ChannelResponderRef,
  ConversationChannelChallengeToken,
  InteractionDisplay,
  JobChannelChallengeToken,
} from "@zhixing/core/contracts";
import type {
  ChannelChallengeLifecycleRecord,
  ConversationChannelChallengePreparedRecord,
  JobChannelChallengePreparedRecord,
} from "./channel-interaction-records.js";

export type PreparedChannelChallenge =
  | ConversationChannelChallengePreparedRecord
  | JobChannelChallengePreparedRecord;

export interface PendingChannelChallenge {
  readonly prepared: PreparedChannelChallenge;
  readonly delivered?: Extract<
    ChannelChallengeLifecycleRecord,
    { readonly t: "channel-challenge-delivered" }
  >;
}

export interface ChannelChallengeOutboxStore {
  pendingChannelChallenges(): Promise<readonly PendingChannelChallenge[]>;
  recordChannelChallengeDelivered(input: {
    readonly challengeId: string;
    readonly receipt: {
      readonly acceptedAt: string;
      readonly platformMessage?: ChannelMessageRef;
    };
  }): Promise<void>;
  closeChannelChallenge(input: {
    readonly challengeId: string;
    readonly outcome: "cancelled" | "expired";
    readonly at: string;
  }): Promise<void>;
}

export interface ChannelChallengeSender {
  send(input: {
    readonly challengeId: string;
    readonly token:
      | ConversationChannelChallengeToken
      | JobChannelChallengeToken;
    readonly responder: ChannelResponderRef;
    readonly toolName: string;
    readonly display: InteractionDisplay;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly acceptedAt: string;
    readonly platformMessage?: ChannelMessageRef;
  }>;
}

export interface ChannelChallengeOutboxResult {
  readonly delivered: number;
  readonly expired: number;
  readonly failures: readonly {
    readonly challengeId: string;
    readonly error: Error;
  }[];
}

export class ChannelChallengeOutbox {
  readonly #store: ChannelChallengeOutboxStore;
  readonly #sender: ChannelChallengeSender;
  readonly #now: () => string;
  readonly #maxAttempts: number;

  constructor(options: {
    readonly store: ChannelChallengeOutboxStore;
    readonly sender: ChannelChallengeSender;
    readonly now?: () => string;
    readonly maxAttempts?: number;
  }) {
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError(
        "Channel challenge outbox attempts must be a positive safe integer",
      );
    }
    this.#store = options.store;
    this.#sender = options.sender;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxAttempts = maxAttempts;
  }

  async drain(signal?: AbortSignal): Promise<ChannelChallengeOutboxResult> {
    const pending = await this.#store.pendingChannelChallenges();
    let delivered = 0;
    let expired = 0;
    const failures: Array<{ readonly challengeId: string; readonly error: Error }> = [];
    for (const item of pending) {
      signal?.throwIfAborted();
      if (item.delivered) continue;
      const challengeId = item.prepared.token.challengeId;
      const now = this.#now();
      if (Date.parse(now) >= Date.parse(item.prepared.token.expiry)) {
        await this.#store.closeChannelChallenge({
          challengeId,
          outcome: "expired",
          at: now,
        });
        expired += 1;
        continue;
      }

      let failure: Error | undefined;
      for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
        signal?.throwIfAborted();
        try {
          const receipt = await this.#sender.send({
            challengeId,
            token: item.prepared.token,
            responder: item.prepared.responder,
            toolName: item.prepared.toolName,
            display: item.prepared.display,
            ...(signal ? { signal } : {}),
          });
          await this.#store.recordChannelChallengeDelivered({
            challengeId,
            receipt,
          });
          delivered += 1;
          failure = undefined;
          break;
        } catch (error) {
          failure = asError(error);
        }
      }
      if (failure) failures.push({ challengeId, error: failure });
    }
    return { delivered, expired, failures };
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
