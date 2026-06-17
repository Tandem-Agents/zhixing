import { describe, expect, it } from "vitest";
import type { FileDiffPresentationArtifact } from "@zhixing/core";
import {
  formatFileDiffSummary,
  renderFileDiffBlock,
} from "../diff-block-renderer.js";
import { stripAnsi } from "../../tui/ansi.js";

describe("diff-block-renderer", () => {
  const artifact: FileDiffPresentationArtifact = {
    kind: "file-diff",
    path: "src/example.ts",
    operation: "modified",
    changeStats: { kind: "exact", addedLines: 1, removedLines: 1 },
    hunks: [
      {
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 3,
        lines: [
          {
            type: "context",
            oldLineNumber: 10,
            newLineNumber: 10,
            content: "const a = 1;",
          },
          {
            type: "removed",
            oldLineNumber: 11,
            content: "const b = 2;",
          },
          {
            type: "added",
            newLineNumber: 11,
            content: "const b = 3;",
          },
        ],
      },
    ],
  };

  it("renders a light-gutter hunk block", () => {
    const lines = renderFileDiffBlock({ artifact, columns: 80 }).map(stripAnsi);

    expect(lines[0]).toContain("@@ -10,3 +10,3 @@");
    expect(lines[1]).toContain("10   const a = 1;");
    expect(lines[2]).toContain(" - const b = 2;");
    expect(lines[3]).toContain("11 + const b = 3;");
  });

  it("formats the side-effect summary", () => {
    expect(formatFileDiffSummary(artifact)).toBe(
      "Modified example.ts · +1 -1",
    );
  });

  it("does not show invented counts when change stats are unavailable", () => {
    expect(
      formatFileDiffSummary({
        ...artifact,
        changeStats: { kind: "unavailable", reason: "input-too-large" },
        hunks: [],
        truncated: true,
      }),
    ).toBe("Modified example.ts · diff too large");
  });

  it("clamps long lines to the terminal width", () => {
    const longArtifact: FileDiffPresentationArtifact = {
      ...artifact,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            {
              type: "added",
              newLineNumber: 1,
              content: "x".repeat(200),
            },
          ],
        },
      ],
    };

    const [header, line] = renderFileDiffBlock({
      artifact: longArtifact,
      columns: 40,
    }).map(stripAnsi);

    expect(header).toContain("@@ -1,1 +1,1 @@");
    expect(line.length).toBeLessThanOrEqual(39);
    expect(line).toContain("…");
  });
});
