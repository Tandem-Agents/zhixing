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

  it("removes grep results presentation from public tool_end yields", () => {
    const event: AgentYield = {
      type: "tool_end",
      id: "tool-1",
      name: "grep",
      duration: 7,
      result: {
        content: "Found 1 matching line in 1 file",
        presentation: {
          kind: "grep-results",
          query: {
            pattern: "\\bfoo\\b",
            searchPath: "src",
            outputMode: "content",
            regexDialect: "line-regexp",
            caseSensitivity: "sensitive",
            contextLines: 0,
          },
          files: [
            {
              displayPath: "src/app.ts",
              matches: [
                {
                  line: 3,
                  text: { text: "const foo = 1;", truncated: false },
                  contextBefore: [],
                  contextAfter: [],
                },
              ],
            },
          ],
          matchedFileCount: 1,
          matchedLineCount: 1,
          truncated: false,
          diagnostics: {
            executor: "node",
            capabilityMode: "fallback",
          },
        },
      },
    };

    const stripped = stripPresentationFromAgentYield(event);

    expect(stripped).toEqual({
      type: "tool_end",
      id: "tool-1",
      name: "grep",
      duration: 7,
      result: {
        content: "Found 1 matching line in 1 file",
      },
    });
    expect(JSON.stringify(stripped)).not.toContain("grep-results");
  });

  it("returns events without presentation unchanged", () => {
    const event: AgentYield = {
      type: "text_delta",
      text: "hello",
    };

    expect(stripPresentationFromAgentYield(event)).toBe(event);
  });
});
