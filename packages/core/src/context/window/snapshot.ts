import type { ITokenEstimator } from "../types.js";
import type { Message } from "../../types/messages.js";
import type { AttentionWindowState } from "./types.js";

export type AttentionWindowSnapshotStrategyV1 = "full_or_fail" | "tail";

export interface AttentionWindowSnapshotV1 {
  readonly source: "attention_window";
  readonly strategy: AttentionWindowSnapshotStrategyV1;
  readonly messages: readonly Message[];
  readonly estimatedTokens: number;
  readonly capturedAt: string;
}

export type AttentionWindowSnapshotErrorCodeV1 =
  | "context_snapshot_too_large"
  | "invalid_context_snapshot_budget";

export interface AttentionWindowSnapshotErrorV1 {
  readonly code: AttentionWindowSnapshotErrorCodeV1;
  readonly message: string;
  readonly estimatedTokens?: number;
  readonly maxTokens: number;
}

export type SnapshotAttentionWindowResultV1 =
  | { readonly ok: true; readonly snapshot: AttentionWindowSnapshotV1 }
  | { readonly ok: false; readonly error: AttentionWindowSnapshotErrorV1 };

export interface SnapshotAttentionWindowOptionsV1 {
  readonly strategy: AttentionWindowSnapshotStrategyV1;
  readonly maxTokens: number;
  readonly estimator: Pick<ITokenEstimator, "estimateMessages">;
  readonly now?: () => Date;
}

export function snapshotAttentionWindowV1(
  window: Pick<AttentionWindowState, "getMessages">,
  options: SnapshotAttentionWindowOptionsV1,
): SnapshotAttentionWindowResultV1 {
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
    return {
      ok: false,
      error: {
        code: "invalid_context_snapshot_budget",
        message: "context snapshot maxTokens must be a positive integer",
        maxTokens: options.maxTokens,
      },
    };
  }

  const windowMessages = window.getMessages();
  const estimatedTokens = options.estimator.estimateMessages(windowMessages);

  if (
    options.strategy === "full_or_fail" &&
    estimatedTokens > options.maxTokens
  ) {
    return {
      ok: false,
      error: {
        code: "context_snapshot_too_large",
        message: "attention window exceeds context snapshot token budget",
        estimatedTokens,
        maxTokens: options.maxTokens,
      },
    };
  }

  const messages =
    options.strategy === "tail"
      ? selectTailMessages(windowMessages, options)
      : cloneMessages(windowMessages);
  const snapshot: AttentionWindowSnapshotV1 = {
    source: "attention_window",
    strategy: options.strategy,
    messages,
    estimatedTokens: options.estimator.estimateMessages(messages),
    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
  };

  return { ok: true, snapshot: deepFreeze(snapshot) };
}

function selectTailMessages(
  messages: readonly Message[],
  options: SnapshotAttentionWindowOptionsV1,
): readonly Message[] {
  const selected: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = [messages[i]!, ...selected];
    if (options.estimator.estimateMessages(candidate) > options.maxTokens) {
      break;
    }
    selected.unshift(messages[i]!);
  }
  return cloneMessages(selected);
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return structuredClone(messages) as Message[];
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
