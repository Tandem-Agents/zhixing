import { describe, expect, it } from "vitest";
import type { Message } from "@zhixing-ai/core";
import { projectAgentYieldToKernelRunEvent } from "../kernel-run-event.js";
import { projectAgentResultToKernelTerminal } from "../kernel-terminal.js";

describe("Unit 2 · KernelRunEvent & KernelTerminal strict protocolState validation", () => {
  const validMessage: Message = {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "推理",
        signature: "sig-ok",
        protocolState: {
          protocol: "google-interactions",
          sourceConnectionId: "google-a",
          sourceOriginKey: "google-interactions@https://generativelanguage.googleapis.com",
          sourceModel: "gemini-3.5-pro",
          payloadVersion: 1,
          signature: "sig-ok",
          opaqueStep: JSON.stringify({ type: "thought", signature: "sig-ok" }),
        },
      },
      {
        type: "text",
        text: "结果",
        protocolState: {
          protocol: "openai-responses",
          sourceConnectionId: "openai",
          sourceOriginKey: "openai-responses@https://api.openai.com/v1",
          sourceModel: "gpt-6.2-astra",
          phase: "final_answer",
          itemId: "msg_1",
        },
      },
    ],
  };

  it("accepts and deeply freezes valid ThinkingBlock & TextBlock protocolState", () => {
    const evt = projectAgentYieldToKernelRunEvent({
      type: "assistant_message",
      message: validMessage,
    });
    expect(evt.type).toBe("assistant_message");
    if (evt.type === "assistant_message") {
      expect(Object.isFrozen(evt.message.content[0])).toBe(true);
      expect(evt.message.content[0]).toEqual(validMessage.content[0]);
      expect(evt.message.content[1]).toEqual(validMessage.content[1]);
    }

    const terminal = projectAgentResultToKernelTerminal({
      reason: "completed",
      message: validMessage,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(terminal.reason).toBe("completed");
    if (terminal.reason === "completed") {
      expect(terminal.message.content).toEqual(validMessage.content);
    }
  });

  it("rejects malformed or unbounded protocolState on both KernelRunEvent and KernelTerminal", () => {
    const badThinkingMsg: Message = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "bad",
          protocolState: {
            protocol: "openai-responses",
            sourceConnectionId: "c1",
            sourceOriginKey: "k1",
            sourceModel: "m1",
            payloadVersion: 1,
            extraField: "disallowed",
          } as unknown as NonNullable<
            Extract<Message["content"][number], { type: "thinking" }>["protocolState"]
          >,
        },
      ],
    };

    expect(() =>
      projectAgentYieldToKernelRunEvent({ type: "assistant_message", message: badThinkingMsg }),
    ).toThrow(TypeError);
    expect(() =>
      projectAgentResultToKernelTerminal({
        reason: "completed",
        message: badThinkingMsg,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toThrow(TypeError);
  });
});
