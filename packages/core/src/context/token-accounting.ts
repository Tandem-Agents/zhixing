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
}

export interface ContextTokensInput {
  readonly estimator: ITokenEstimator;
  readonly systemPrompt: string;
  readonly stateMessages: readonly Message[];
  readonly providerMessages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly anchor?: TokenAnchor;
}

/**
 * Estimate the next provider request size.
 *
 * Anchor path:
 *   provider truth for the already-sent state lineage + estimated state delta.
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
  } = input;

  if (anchor && stateMessages.length >= anchor.baselineMessageCount) {
    const delta = stateMessages.slice(anchor.baselineMessageCount);
    return anchor.totalInputTokens + estimator.estimateMessages(delta);
  }

  return (
    estimator.estimateText(systemPrompt) +
    estimator.estimateMessages(providerMessages) +
    estimator.estimateTools(tools)
  );
}
