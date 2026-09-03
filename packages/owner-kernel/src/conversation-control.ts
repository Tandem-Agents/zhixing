import type { ConversationResolutionFence } from "@zhixing/core/conversation/application";

const CONVERSATION_RESOLUTION_FENCE_PREFIX = "conversation-resolution-fence:v1:";

/** Correctness/RPC binding for the legacy numeric Conversation owner fence. */
export function createConversationResolutionFence(
  value: number,
): ConversationResolutionFence {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      "Conversation resolution owner epoch must be a non-negative safe integer",
    );
  }
  return `${CONVERSATION_RESOLUTION_FENCE_PREFIX}${value}` as ConversationResolutionFence;
}

/** Strictly opens a fence only at a Conversation Correctness boundary. */
export function parseConversationResolutionFence(
  fence: ConversationResolutionFence,
): number {
  if (
    typeof fence !== "string" ||
    !fence.startsWith(CONVERSATION_RESOLUTION_FENCE_PREFIX)
  ) {
    throw new TypeError("Conversation resolution fence is invalid");
  }
  const encoded = fence.slice(CONVERSATION_RESOLUTION_FENCE_PREFIX.length);
  const value = Number(encoded);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    String(value) !== encoded
  ) {
    throw new TypeError("Conversation resolution fence is invalid");
  }
  return value;
}
