import { describe, expect, it } from "vitest";
import { buildFileDiffArtifact } from "../file-diff.js";

describe("buildFileDiffArtifact", () => {
  it("returns exact change stats when diffing is within the safety limit", () => {
    const artifact = buildFileDiffArtifact({
      path: "small.txt",
      operation: "modified",
      beforeText: "old\nsame\n",
      afterText: "new\nsame\n",
    });

    expect(artifact.changeStats).toEqual({
      kind: "exact",
      addedLines: 1,
      removedLines: 1,
    });
  });

  it("does not invent change counts when input is too large to diff", () => {
    const artifact = buildFileDiffArtifact({
      path: "large.txt",
      operation: "modified",
      beforeText: "a".repeat(1_000_001),
      afterText: "b",
    });

    const raw = artifact as Record<string, unknown>;
    expect(artifact.changeStats).toEqual({
      kind: "unavailable",
      reason: "input-too-large",
    });
    expect(artifact.hunks).toEqual([]);
    expect(artifact.truncated).toBe(true);
    expect(raw.addedLines).toBeUndefined();
    expect(raw.removedLines).toBeUndefined();
  });
});
