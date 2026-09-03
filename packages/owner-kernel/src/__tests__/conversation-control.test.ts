import { describe, expect, it } from "vitest";
import type { ConversationResolutionFence } from "@zhixing/core/conversation/application";
import {
  createConversationResolutionFence,
  parseConversationResolutionFence,
} from "../conversation-control.js";

describe("Conversation resolution fence", () => {
  it("round-trips the legacy non-negative owner generation", () => {
    expect(parseConversationResolutionFence(createConversationResolutionFence(0))).toBe(0);
    expect(parseConversationResolutionFence(createConversationResolutionFence(7))).toBe(7);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid numeric binding %s",
    (value) => {
      expect(() => createConversationResolutionFence(value)).toThrow(
        "Conversation resolution owner epoch must be a non-negative safe integer",
      );
    },
  );

  it.each([
    "",
    "7",
    "conversation-resolution-fence:v1:",
    "conversation-resolution-fence:v1:01",
    "conversation-resolution-fence:v1:-1",
    "conversation-resolution-fence:v2:7",
  ])("rejects a forged or non-canonical fence %s", (fence) => {
    expect(() =>
      parseConversationResolutionFence(fence as ConversationResolutionFence),
    ).toThrow("Conversation resolution fence is invalid");
  });
});
