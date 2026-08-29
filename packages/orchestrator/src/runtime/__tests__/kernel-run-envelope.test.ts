import { userMessage } from "@zhixing/core";
import { describe, expect, it, vi } from "vitest";
import {
  captureKernelRunEnvelope,
  type KernelRunEnvelope,
} from "../kernel-run-envelope.js";

describe("KernelRunEnvelope", () => {
  it("captures the finite five-part contract before caller mutation", () => {
    const messages = [userMessage("original")];
    const turnContext = {
      turnId: "turn-1",
      turnOrigin: {
        channel: "rpc",
        surface: { capabilities: { postTurnControl: true } },
      },
    };
    const identity = {
      turnIndex: 7,
      conversationId: "conv-1" as const,
      source: "channel" as const,
      turnContext,
    };
    const onYield = vi.fn();
    const abort = new AbortController();
    const input: KernelRunEnvelope = {
      modelInput: { messages },
      identity,
      control: { abortSignal: abort.signal },
      correctness: {},
      observation: { onYield },
    };

    const captured = captureKernelRunEnvelope(input);
    messages.push(userMessage("late mutation"));
    const originalText = messages[0]?.content[0];
    if (originalText?.type === "text") originalText.text = "mutated";
    turnContext.turnId = "mutated";
    turnContext.turnOrigin.surface.capabilities.postTurnControl = false;

    expect(Object.keys(captured).sort()).toEqual([
      "control",
      "correctness",
      "identity",
      "modelInput",
      "observation",
    ]);
    expect(captured.modelInput.messages).toHaveLength(1);
    expect(captured.modelInput.messages[0]).toEqual(userMessage("original"));
    expect(captured.identity.turnContext?.turnId).toBe("turn-1");
    expect(
      captured.identity.turnContext?.turnOrigin?.surface?.capabilities
        ?.postTurnControl,
    ).toBe(true);
    expect(captured.control.abortSignal).toBe(abort.signal);
    expect(captured.observation.onYield).toBe(onYield);
    for (const partition of Object.values(captured)) {
      expect(Object.isFrozen(partition)).toBe(true);
    }
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.modelInput.messages)).toBe(true);
    expect(Object.isFrozen(captured.modelInput.messages[0])).toBe(true);
    expect(Object.isFrozen(captured.modelInput.messages[0]?.content)).toBe(true);
    expect(Object.isFrozen(captured.modelInput.messages[0]?.content[0])).toBe(
      true,
    );
  });
});
