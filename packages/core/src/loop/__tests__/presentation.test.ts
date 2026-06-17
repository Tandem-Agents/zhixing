import { describe, expect, it } from "vitest";
import {
  stripPresentationFromAgentYield,
  type AgentYield,
} from "../index.js";

describe("stripPresentationFromAgentYield", () => {
  it("removes renderer-only presentation from public tool_end yields", () => {
    const event: AgentYield = {
      type: "tool_end",
      id: "tool-1",
      name: "edit",
      duration: 9,
      result: {
        content: "Replaced text",
        committedToUser: true,
        presentation: {
          kind: "file-diff",
          path: "a.ts",
          operation: "modified",
          changeStats: { kind: "exact", addedLines: 1, removedLines: 1 },
          hunks: [],
        },
      },
    };

    const stripped = stripPresentationFromAgentYield(event);

    expect(stripped).toEqual({
      type: "tool_end",
      id: "tool-1",
      name: "edit",
      duration: 9,
      result: {
        content: "Replaced text",
        committedToUser: true,
      },
    });
  });

  it("returns events without presentation unchanged", () => {
    const event: AgentYield = {
      type: "text_delta",
      text: "hello",
    };

    expect(stripPresentationFromAgentYield(event)).toBe(event);
  });
});
