import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  GREP_DEFAULT_IGNORE_GLOBS,
  GREP_DEFAULT_TIMEOUT_MS,
} from "./constants.js";
import { GrepResultCollector } from "./collector.js";
import type {
  GrepSearchError,
  GrepSearchExecution,
  GrepSearchExecutor,
  GrepSearchOptions,
  GrepSearchPlan,
} from "./types.js";

interface RipgrepJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    stats?: { searches?: number };
  };
}

interface RipgrepCommand {
  args: string[];
  cwd: string;
}

class GrepSearchThrownError extends Error {
  constructor(readonly searchError: GrepSearchError) {
    super(searchError.message);
  }
}

export const ripgrepSearchExecutor: GrepSearchExecutor = {
  name: "ripgrep",

  async qualify(plan: GrepSearchPlan) {
    if (plan.query.maxScannedFiles !== undefined) {
      return {
        executable: false,
        reason: "unsupported-budget",
        notes: ["ripgrep executor cannot prove maxScannedFiles before execution."],
      };
    }

    if (!(await isRipgrepAvailable())) {
      return {
        executable: false,
        reason: "unavailable",
        notes: ["ripgrep executable was not found."],
      };
    }

    return { executable: true, capabilityMode: "native" };
  },

  async search(
    plan: GrepSearchPlan,
    options: GrepSearchOptions = {},
  ): Promise<GrepSearchExecution> {
    const collector = new GrepResultCollector(
      plan,
      {
        executor: "ripgrep",
        capabilityMode: "native",
        trackScannedFileCount: false,
      },
      options,
    );

    try {
      for await (const absolutePath of discoverRipgrepCandidateFiles(
        plan,
        collector,
        options,
      )) {
        const stateError = collector.checkExecutionState();
        if (stateError !== null) return { ok: false, error: stateError };

        const scanError = await collector.collectFile(absolutePath);
        if (scanError !== null) return { ok: false, error: scanError };
        if (collector.hasTruncated) break;
      }
    } catch (err) {
      if (err instanceof GrepSearchThrownError) {
        return { ok: false, error: err.searchError };
      }
      throw err;
    }

    return { ok: true, result: collector.finish() };
  },
};

export async function isRipgrepAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("rg", ["--version"], { windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function* discoverRipgrepCandidateFiles(
  plan: GrepSearchPlan,
  collector: GrepResultCollector,
  options: GrepSearchOptions,
): AsyncIterable<string> {
  const stat = await fs.stat(plan.absoluteSearchPath);
  const command = buildRipgrepCommand(plan, stat.isFile());
  const child = spawn("rg", command.args, {
    cwd: command.cwd,
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const lines = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  const seen = new Set<string>();
  let stderr = "";
  let processError: GrepSearchError | null = null;

  const fail = (error: GrepSearchError) => {
    processError ??= error;
    child.kill();
  };
  const abort = () => {
    fail({ code: "aborted", message: "Grep search was aborted." });
  };
  const timeoutMs = plan.query.timeoutMs ?? GREP_DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    fail({
      code: "timeout",
      message: `Grep search timed out after ${timeoutMs}ms.`,
      elapsedMs: timeoutMs,
    });
  }, timeoutMs);

  const exit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", () => {
    fail({
      code: "executor-unavailable",
      message: "ripgrep executable was not found.",
    });
  });

  if (options.abortSignal?.aborted) abort();
  options.abortSignal?.addEventListener("abort", abort, { once: true });

  try {
    for await (const line of lines) {
      if (processError !== null) throw new GrepSearchThrownError(processError);
      const event = parseRipgrepJsonLine(line);
      if (event === null) continue;

      if (event.type === "summary") {
        const searches = event.data?.stats?.searches;
        if (searches !== undefined) collector.setScannedFileCount(searches);
        continue;
      }

      const candidateFile = getCandidateFile(event, command.cwd);
      if (candidateFile === null || seen.has(candidateFile)) continue;

      seen.add(candidateFile);
      yield candidateFile;
    }

    const exitCode = await exit;
    if (processError !== null) throw new GrepSearchThrownError(processError);
    if (exitCode !== 0 && exitCode !== 1) {
      throw new GrepSearchThrownError({
        code: "internal-error",
        message: stderr.trim() || `ripgrep exited with code ${exitCode}.`,
      });
    }
  } finally {
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", abort);
    lines.close();
    child.kill();
  }
}

function buildRipgrepCommand(
  plan: GrepSearchPlan,
  isFile: boolean,
): RipgrepCommand {
  const cwd = isFile
    ? path.dirname(plan.absoluteSearchPath)
    : plan.absoluteSearchPath;
  const searchTarget = isFile ? path.basename(plan.absoluteSearchPath) : ".";
  const args = [
    "--json",
    "--line-number",
    "--color=never",
    "--no-messages",
    "--hidden",
    "--no-ignore",
    "--crlf",
    "--max-count",
    "1",
  ];

  if (!isFile) {
    for (const ignore of GREP_DEFAULT_IGNORE_GLOBS) {
      args.push("--glob", `!${ignore}`);
    }
  }

  if (!isFile && plan.query.glob !== undefined) {
    args.push("--glob", plan.query.glob);
  }

  args.push("--", plan.regexp.ripgrepSource, searchTarget);
  return { args, cwd };
}

function parseRipgrepJsonLine(line: string): RipgrepJsonEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  try {
    return JSON.parse(trimmed) as RipgrepJsonEvent;
  } catch {
    return null;
  }
}

function getCandidateFile(
  event: RipgrepJsonEvent,
  cwd: string,
): string | null {
  if (event.type !== "match") return null;

  const rawFilePath = event.data?.path?.text;
  if (rawFilePath === undefined) return null;

  return path.isAbsolute(rawFilePath)
    ? path.normalize(rawFilePath)
    : path.resolve(cwd, rawFilePath);
}
