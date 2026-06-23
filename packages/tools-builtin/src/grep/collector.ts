import * as fs from "node:fs/promises";
import {
  GREP_DEFAULT_TIMEOUT_MS,
  GREP_MAX_DIAGNOSTIC_NOTES,
} from "./constants.js";
import { sortGrepFiles, toDisplayPath } from "./paths.js";
import {
  decodeGrepFileBytes,
  splitLogicalLines,
  toGrepLineText,
} from "./text.js";
import type {
  GrepCapabilityMode,
  GrepContextLine,
  GrepExecutorName,
  GrepFileResult,
  GrepLineText,
  GrepMatch,
  GrepSearchError,
  GrepSearchOptions,
  GrepSearchPlan,
  GrepSearchResult,
} from "./types.js";

export interface GrepCollectorDiagnosticsInput {
  executor: GrepExecutorName;
  capabilityMode: GrepCapabilityMode;
  notes?: string[];
  trackScannedFileCount?: boolean;
}

interface MutableGrepFileResult {
  absolutePath: string;
  displayPath: string;
  matches: GrepMatch[];
}

export class GrepResultCollector {
  private readonly startedAt = Date.now();
  private readonly files = new Map<string, MutableGrepFileResult>();
  private resultChars = 0;
  private notes: string[];
  private scannedFileCount: number | undefined;
  private matchedLineCount = 0;
  private truncated = false;

  constructor(
    private readonly plan: GrepSearchPlan,
    private readonly diagnostics: GrepCollectorDiagnosticsInput,
    private readonly options: GrepSearchOptions = {},
  ) {
    this.notes = diagnostics.notes?.slice(0, GREP_MAX_DIAGNOSTIC_NOTES) ?? [];
    this.scannedFileCount =
      diagnostics.trackScannedFileCount === false ? undefined : 0;
  }

  get hasTruncated(): boolean {
    return this.truncated;
  }

  markTruncated(): void {
    this.truncated = true;
  }

  addNote(note: string): void {
    if (this.notes.length >= GREP_MAX_DIAGNOSTIC_NOTES) return;
    this.notes.push(note);
  }

  setScannedFileCount(scannedFileCount: number): void {
    this.scannedFileCount = scannedFileCount;
  }

  addScannedFileCount(scannedFileCount: number): void {
    this.scannedFileCount = (this.scannedFileCount ?? 0) + scannedFileCount;
  }

  getElapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  getTimeoutMs(): number {
    return this.plan.query.timeoutMs ?? GREP_DEFAULT_TIMEOUT_MS;
  }

  getRemainingTimeoutMs(): number {
    return Math.max(0, this.getTimeoutMs() - this.getElapsedMs());
  }

  checkExecutionState(): GrepSearchError | null {
    if (this.options.abortSignal?.aborted) {
      return { code: "aborted", message: "Grep search was aborted." };
    }

    const timeoutMs = this.getTimeoutMs();
    if (this.getElapsedMs() >= timeoutMs) {
      return {
        code: "timeout",
        message: `Grep search timed out after ${timeoutMs}ms.`,
        elapsedMs: this.getElapsedMs(),
      };
    }

    return null;
  }

  beginFileScan(): boolean {
    const maxScannedFiles = this.options.maxScannedFiles;
    if (
      maxScannedFiles !== undefined &&
      this.scannedFileCount !== undefined &&
      this.scannedFileCount >= maxScannedFiles
    ) {
      this.truncated = true;
      return false;
    }

    if (this.scannedFileCount !== undefined) this.scannedFileCount++;
    return true;
  }

  async collectFile(absolutePath: string): Promise<GrepSearchError | null> {
    const stateError = this.checkExecutionState();
    if (stateError !== null) return stateError;

    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(absolutePath);
    } catch {
      this.addNote(`Skipped unreadable file: ${toDisplayPath(absolutePath, this.plan.query.workingDirectory)}`);
      return null;
    }

    const decoded = decodeGrepFileBytes(bytes);
    if (decoded.text.includes("\0")) return null;

    const lines = splitLogicalLines(decoded.text);

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!this.plan.regexp.test(line)) continue;

      const keepGoing = this.addMatch(absolutePath, lines, index);
      if (!keepGoing) break;

      const nextStateError = this.checkExecutionState();
      if (nextStateError !== null) return nextStateError;
    }

    return null;
  }

  finish(): GrepSearchResult {
    const files = sortGrepFiles(
      Array.from(this.files.values(), toImmutableFileResult),
    );

    return {
      query: this.plan.query,
      files,
      matchedFileCount: files.length,
      matchedLineCount: this.matchedLineCount,
      truncated: this.truncated,
      diagnostics: {
        executor: this.diagnostics.executor,
        capabilityMode: this.diagnostics.capabilityMode,
        scannedFileCount: this.scannedFileCount,
        elapsedMs: Date.now() - this.startedAt,
        notes: this.notes.length > 0 ? this.notes : undefined,
      },
    };
  }

  private addMatch(
    absolutePath: string,
    lines: readonly string[],
    lineIndex: number,
  ): boolean {
    if (!this.canAddNewMatch(absolutePath)) return false;

    const match = buildMatch(
      lines,
      lineIndex,
      this.plan.query.contextLines,
      this.plan.query.maxLineChars,
    );
    const displayPath = toDisplayPath(
      absolutePath,
      this.plan.query.workingDirectory,
    );
    const estimatedChars = estimateMatchChars(displayPath, match);

    if (this.resultChars + estimatedChars > this.plan.query.maxResultChars) {
      this.truncated = true;
      return false;
    }

    const file = this.getOrCreateFile(absolutePath, displayPath);
    file.matches.push(match);
    this.resultChars += estimatedChars;
    this.matchedLineCount++;
    return true;
  }

  private canAddNewMatch(absolutePath: string): boolean {
    const maxMatchedLines = this.plan.query.maxMatchedLines;
    if (
      maxMatchedLines !== undefined &&
      this.matchedLineCount >= maxMatchedLines
    ) {
      this.truncated = true;
      return false;
    }

    const maxMatchedFiles = this.plan.query.maxMatchedFiles;
    if (
      maxMatchedFiles !== undefined &&
      !this.files.has(absolutePath) &&
      this.files.size >= maxMatchedFiles
    ) {
      this.truncated = true;
      return false;
    }

    return true;
  }

  private getOrCreateFile(
    absolutePath: string,
    displayPath: string,
  ): MutableGrepFileResult {
    const existing = this.files.get(absolutePath);
    if (existing !== undefined) return existing;

    const file = {
      absolutePath,
      displayPath,
      matches: [],
    };
    this.files.set(absolutePath, file);
    return file;
  }
}

function buildMatch(
  lines: readonly string[],
  lineIndex: number,
  contextLines: number,
  maxLineChars: number,
): GrepMatch {
  return {
    line: lineIndex + 1,
    text: toGrepLineText(lines[lineIndex]!, maxLineChars),
    contextBefore: buildContextLines(
      lines,
      Math.max(0, lineIndex - contextLines),
      lineIndex,
      maxLineChars,
    ),
    contextAfter: buildContextLines(
      lines,
      lineIndex + 1,
      Math.min(lines.length, lineIndex + contextLines + 1),
      maxLineChars,
    ),
  };
}

function buildContextLines(
  lines: readonly string[],
  startIndex: number,
  endIndex: number,
  maxLineChars: number,
): GrepContextLine[] {
  const context: GrepContextLine[] = [];
  for (let index = startIndex; index < endIndex; index++) {
    context.push({
      line: index + 1,
      text: toGrepLineText(lines[index]!, maxLineChars),
    });
  }
  return context;
}

function estimateMatchChars(displayPath: string, match: GrepMatch): number {
  return (
    displayPath.length +
    estimateLineTextChars(match.text) +
    sumLineTextChars(match.contextBefore.map((line) => line.text)) +
    sumLineTextChars(match.contextAfter.map((line) => line.text)) +
    32
  );
}

function sumLineTextChars(lines: readonly GrepLineText[]): number {
  return lines.reduce((total, line) => total + estimateLineTextChars(line), 0);
}

function estimateLineTextChars(line: GrepLineText): number {
  return line.text.length + (line.truncated ? 32 : 0);
}

function toImmutableFileResult(file: MutableGrepFileResult): GrepFileResult {
  return {
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    matches: [...file.matches],
  };
}
