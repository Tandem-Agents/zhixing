import chalk from "chalk";
import type {
  FileDiffLine,
  FileDiffPresentationArtifact,
} from "@zhixing/core";
import { clampLine } from "../tui/line-width.js";
import { layout, tone } from "../tui/style.js";

const BLOCK_PREFIX = `${layout.contentPrefix}    `;
const MAX_HUNKS = 6;
const MAX_LINES_PER_HUNK = 80;
const MAX_TOTAL_LINES = 300;

export interface RenderFileDiffBlockOptions {
  readonly artifact: FileDiffPresentationArtifact;
  readonly columns: number;
}

export function formatFileDiffSummary(
  artifact: FileDiffPresentationArtifact,
): string {
  const verb = operationVerb(artifact.operation);
  if (artifact.changeStats.kind === "unavailable") {
    return `${verb} ${basename(artifact.path)} · diff too large`;
  }
  return `${verb} ${basename(artifact.path)} · +${artifact.changeStats.addedLines} -${artifact.changeStats.removedLines}`;
}

export function renderFileDiffBlock(
  options: RenderFileDiffBlockOptions,
): string[] {
  const { artifact } = options;
  const columns = Math.max(20, options.columns);
  if (artifact.hunks.length === 0) {
    return artifact.truncated === true
      ? [fitLine(`${BLOCK_PREFIX}${tone.dim("diff truncated · use git diff for full changes")}`, columns)]
      : [];
  }

  const lineNumberWidth = getLineNumberWidth(artifact);
  const lines: string[] = [];
  let renderedHunks = 0;
  let renderedDiffLines = 0;
  let truncated = artifact.truncated === true;

  for (const hunk of artifact.hunks) {
    if (renderedHunks >= MAX_HUNKS || renderedDiffLines >= MAX_TOTAL_LINES) {
      truncated = true;
      break;
    }

    lines.push(
      fitLine(
        `${BLOCK_PREFIX}${chalk.dim.cyan(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)}`,
        columns,
      ),
    );
    renderedHunks++;

    let hunkLines = 0;
    for (const line of hunk.lines) {
      if (
        hunkLines >= MAX_LINES_PER_HUNK ||
        renderedDiffLines >= MAX_TOTAL_LINES
      ) {
        truncated = true;
        break;
      }
      lines.push(renderDiffLine(line, lineNumberWidth, columns));
      hunkLines++;
      renderedDiffLines++;
    }
  }

  if (truncated) {
    lines.push(
      fitLine(
        `${BLOCK_PREFIX}${tone.dim("diff truncated · use git diff for full changes")}`,
        columns,
      ),
    );
  }

  return lines;
}

function renderDiffLine(
  line: FileDiffLine,
  lineNumberWidth: number,
  columns: number,
): string {
  const lineNumber =
    line.type === "removed"
      ? " ".repeat(lineNumberWidth)
      : String(line.newLineNumber).padStart(lineNumberWidth);

  if (line.type === "added") {
    return fitLine(
      `${BLOCK_PREFIX}${tone.dim(lineNumber)} ${tone.success("+")} ${tone.success(line.content)}`,
      columns,
    );
  }

  if (line.type === "removed") {
    return fitLine(
      `${BLOCK_PREFIX}${tone.dim(lineNumber)} ${tone.error("-")} ${tone.error(line.content)}`,
      columns,
    );
  }

  return fitLine(
    `${BLOCK_PREFIX}${tone.dim(lineNumber)}   ${line.content}`,
    columns,
  );
}

function fitLine(line: string, columns: number): string {
  return clampLine(line, columns - 1);
}

function getLineNumberWidth(artifact: FileDiffPresentationArtifact): number {
  let maxLineNumber = 0;
  for (const hunk of artifact.hunks) {
    for (const line of hunk.lines) {
      if (line.type !== "removed") {
        maxLineNumber = Math.max(maxLineNumber, line.newLineNumber);
      }
    }
  }
  return Math.max(3, String(maxLineNumber).length);
}

function operationVerb(
  operation: FileDiffPresentationArtifact["operation"],
): string {
  switch (operation) {
    case "created":
      return "Created";
    case "deleted":
      return "Deleted";
    case "overwritten":
      return "Overwrote";
    case "modified":
      return "Modified";
    default:
      return "Modified";
  }
}

function basename(path: string): string {
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSep >= 0 ? path.slice(lastSep + 1) : path;
}
