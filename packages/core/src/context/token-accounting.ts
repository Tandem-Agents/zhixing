/**
 * Token accounting primitives shared by loop, segment, and budget views.
 *
 * This module is intentionally pure: it owns the accounting rules but knows
 * nothing about agent-loop state machines, windows, persistence, or providers.
 */

import type { ITokenEstimator } from "./types.js";
import type { Message } from "../types/messages.js";
import type { ToolSpec } from "../types/tools.js";

/**
 * Truth anchor captured after a successful provider request.
 *
 * `totalInputTokens` is the provider-normalized full input size for the request
 * that just succeeded. `baselineMessageCount` is measured in state-message
 * space, so anchor delta accounting never slices provider-only prefix messages.
 */
export interface TokenAnchor {
  readonly totalInputTokens: number;
  readonly baselineMessageCount: number;
  /** 可选前缀代际号：与调用方当前代际不一致时视为锚点失效，回落完整发送视图重算。 */
  readonly prefixGeneration?: number;
}

export interface ContextTokensInput {
  readonly estimator: ITokenEstimator;
  readonly systemPrompt: string;
  readonly stateMessages: readonly Message[];
  readonly providerMessages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly anchor?: TokenAnchor;
  /** 当前发送视图的前缀代际号（若与 anchor.prefixGeneration 不一致则放弃锚点走完整重算）。 */
  readonly prefixGeneration?: number;
  /**
   * 仅在 `anchor.baselineMessageCount` 之后新追加的临时上下文消息（如 Responses 追加式 `user(C_k)`）。
   * 绝不包含已计入 `anchor.totalInputTokens` 的旧 `C_0` 锚定块，避免重复计费/高估。
   */
  readonly ephemeralMessagesAfterAnchor?: readonly Message[];
}

/**
 * Estimate the next provider request size.
 *
 * Anchor path:
 *   provider truth for the already-sent state lineage + estimated state delta
 *   + estimated newly appended ephemeral context after the anchor.
 *
 * Fallback path:
 *   full request view = system prompt + provider messages + tools.
 */
export function computeContextTokens(input: ContextTokensInput): number {
  const {
    estimator,
    systemPrompt,
    stateMessages,
    providerMessages,
    tools,
    anchor,
    prefixGeneration,
    ephemeralMessagesAfterAnchor,
  } = input;

  const generationMatches =
    anchor?.prefixGeneration === undefined ||
    prefixGeneration === undefined ||
    anchor.prefixGeneration === prefixGeneration;

  if (
    anchor &&
    generationMatches &&
    stateMessages.length >= anchor.baselineMessageCount
  ) {
    const delta = stateMessages.slice(anchor.baselineMessageCount);
    const ephemeralDeltaTokens =
      ephemeralMessagesAfterAnchor && ephemeralMessagesAfterAnchor.length > 0
        ? estimator.estimateMessages(ephemeralMessagesAfterAnchor)
        : 0;
    return (
      anchor.totalInputTokens +
      estimator.estimateMessages(delta) +
      ephemeralDeltaTokens
    );
  }

  return (
    estimator.estimateText(systemPrompt) +
    estimator.estimateMessages(providerMessages) +
    estimator.estimateTools(tools)
  );
}
