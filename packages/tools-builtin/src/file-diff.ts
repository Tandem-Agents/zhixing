import { structuredPatch } from "diff";
import type {
  FileDiffHunk,
  FileDiffLine,
  FileDiffPresentationArtifact,
} from "@zhixing/core";

const MAX_DIFF_INPUT_CHARS = 1_000_000;
const MAX_ARTIFACT_LINES = 1_000;
const DEFAULT_CONTEXT_LINES = 3;

export interface BuildFileDiffArtifactOptions {
  path: string;
  operation: FileDiffPresentationArtifact["operation"];
  beforeText: string;
  afterText: string;
}

export function buildFileDiffArtifact(
  options: BuildFileDiffArtifactOptions,
): FileDiffPresentationArtifact {
  const size = options.beforeText.length + options.afterText.length;
  if (size > MAX_DIFF_INPUT_CHARS) {
    return {
      kind: "file-diff",
      path: options.path,
      operation: options.operation,
      changeStats: { kind: "unavailable", reason: "input-too-large" },
      hunks: [],
      truncated: true,
    };
  }

  const patch = structuredPatch(
    options.path,
    options.path,
    options.beforeText,
    options.afterText,
    undefined,
    undefined,
    { context: DEFAULT_CONTEXT_LINES },
  );

  const hunks: FileDiffHunk[] = [];
  let addedLines = 0;
  let removedLines = 0;
  let artifactLines = 0;
  let truncated = false;

  for (const hunk of patch.hunks) {
    const lines: FileDiffLine[] = [];
    let oldLineNumber = hunk.oldStart;
    let newLineNumber = hunk.newStart;

    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith("\\")) continue;
      const marker = rawLine[0];
      const content = rawLine.slice(1);
      const canStoreLine = artifactLines < MAX_ARTIFACT_LINES;
      if (!canStoreLine) truncated = true;

      if (marker === "+") {
        if (canStoreLine) {
          lines.push({ type: "added", newLineNumber, content });
          artifactLines++;
        }
        newLineNumber++;
        addedLines++;
      } else if (marker === "-") {
        if (canStoreLine) {
          lines.push({ type: "removed", oldLineNumber, content });
          artifactLines++;
        }
        oldLineNumber++;
        removedLines++;
      } else {
        if (canStoreLine) {
          lines.push({
            type: "context",
            oldLineNumber,
            newLineNumber,
            content,
          });
          artifactLines++;
        }
        oldLineNumber++;
        newLineNumber++;
      }
    }

    if (lines.length > 0) {
      hunks.push({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines,
      });
    }
  }

  return {
    kind: "file-diff",
    path: options.path,
    operation: options.operation,
    changeStats: { kind: "exact", addedLines, removedLines },
    hunks,
    ...(truncated ? { truncated: true } : {}),
  };
}
