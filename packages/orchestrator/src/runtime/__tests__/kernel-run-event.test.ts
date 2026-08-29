import type { AgentYield } from "@zhixing/core";
import { describe, expect, it } from "vitest";
import { projectAgentYieldToKernelRunEvent } from "../kernel-run-event.js";

const LOOP_EVENT_EXACT_SET: readonly AgentYield[] = [
  { type: "text_delta", text: "hello" },
  { type: "thinking_block_start" },
  { type: "thinking_delta", thinking: "reason" },
  { type: "thinking_block_end" },
  {
    type: "assistant_message",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  },
  {
    type: "tool_start",
    id: "tool-1",
    name: "read",
    input: { path: "README.md" },
  },
  {
    type: "tool_end",
    id: "tool-1",
    name: "read",
    result: { content: "contents", isError: false },
    duration: 12,
  },
  {
    type: "turn_complete",
    turnCount: 1,
    usage: { inputTokens: 3, outputTokens: 2 },
  },
];

describe("KernelRunEvent", () => {
  it("exhaustively projects every current AgentYield into a fresh frozen event", () => {
    const projected = LOOP_EVENT_EXACT_SET.map((event) =>
      projectAgentYieldToKernelRunEvent(event),
    );

    expect(projected).toEqual(LOOP_EVENT_EXACT_SET);
    for (const [index, event] of projected.entries()) {
      expect(event).not.toBe(LOOP_EVENT_EXACT_SET[index]);
      expect(Object.isFrozen(event)).toBe(true);
    }
    const assistant = projected.find(
      (event) => event.type === "assistant_message",
    );
    const toolStart = projected.find((event) => event.type === "tool_start");
    const toolEnd = projected.find((event) => event.type === "tool_end");
    const turnComplete = projected.find(
      (event) => event.type === "turn_complete",
    );
    expect(Object.isFrozen(assistant?.message)).toBe(true);
    expect(Object.isFrozen(assistant?.message.content)).toBe(true);
    expect(Object.isFrozen(toolStart?.input)).toBe(true);
    expect(Object.isFrozen(toolEnd?.result)).toBe(true);
    expect(Object.isFrozen(turnComplete?.usage)).toBe(true);
  });

  it("fails closed for unknown, incomplete, or widened loop events", () => {
    expect(() =>
      projectAgentYieldToKernelRunEvent({ type: "future_event" }),
    ).toThrow("Unknown AgentYield variant");
    expect(() =>
      projectAgentYieldToKernelRunEvent({ type: "text_delta" }),
    ).toThrow("Incomplete AgentYield variant");
    expect(() =>
      projectAgentYieldToKernelRunEvent({
        type: "text_delta",
        text: "hello",
        extra: true,
      }),
    ).toThrow("Incomplete AgentYield variant");
  });
});
