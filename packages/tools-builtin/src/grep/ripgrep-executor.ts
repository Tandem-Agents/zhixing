import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  listGrepCandidateFiles,
  toGrepCandidateRelativePath,
} from "./candidate-files.js";
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

const RIPGREP_MAX_PATH_ARGS = 200;
const RIPGREP_MAX_PATH_ARG_CHARS = 16_000;

class GrepSearchThrownError extends Error {
  constructor(readonly searchError: GrepSearchError) {
    super(searchError.message);
  }
}

export const ripgrepSearchExecutor: GrepSearchExecutor = {
  name: "ripgrep",

  async qualify() {
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
  const seen = new Set<string>();
  if (stat.isFile()) {
    yield* runRipgrepCommand(
      buildRipgrepCommand(plan, path.dirname(plan.absoluteSearchPath), [
        path.basename(plan.absoluteSearchPath),
      ]),
      collector,
      options,
      seen,
    );
    return;
  }

  for await (const paths of listRipgrepPathBatches(plan, collector)) {
    yield* runRipgrepCommand(
      buildRipgrepCommand(plan, plan.absoluteSearchPath, paths),
      collector,
      options,
      seen,
    );
    if (collector.hasTruncated) break;
  }
}

async function* runRipgrepCommand(
  command: RipgrepCommand,
  collector: GrepResultCollector,
  options: GrepSearchOptions,
  seen: Set<string>,
): AsyncIterable<string> {
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
  let stderr = "";
  let processError: GrepSearchError | null = null;

  const fail = (error: GrepSearchError) => {
    processError ??= error;
    child.kill();
  };
  const abort = () => {
    fail({ code: "aborted", message: "Grep search was aborted." });
  };
  const timeoutMs = collector.getRemainingTimeoutMs();
  const timeout = setTimeout(() => {
    fail({
      code: "timeout",
      message: `Grep search timed out after ${collector.getTimeoutMs()}ms.`,
      elapsedMs: collector.getElapsedMs(),
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
        if (searches !== undefined) collector.addScannedFileCount(searches);
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

async function* listRipgrepPathBatches(
  plan: GrepSearchPlan,
  collector: GrepResultCollector,
): AsyncIterable<string[]> {
  let paths: string[] = [];
  let pathArgChars = 0;

  for await (const absolutePath of listGrepCandidateFiles(
    plan.absoluteSearchPath,
    plan.query.glob,
  )) {
    const stateError = collector.checkExecutionState();
    if (stateError !== null) throw new GrepSearchThrownError(stateError);

    const relativePath = toGrepCandidateRelativePath(
      plan.absoluteSearchPath,
      absolutePath,
    );
    if (relativePath === null) continue;

    if (
      paths.length > 0 &&
      (paths.length >= RIPGREP_MAX_PATH_ARGS ||
        pathArgChars + relativePath.length + 1 > RIPGREP_MAX_PATH_ARG_CHARS)
    ) {
      yield paths;
      paths = [];
      pathArgChars = 0;
    }

    paths.push(relativePath);
    pathArgChars += relativePath.length + 1;
  }

  if (paths.length > 0) yield paths;
}

function buildRipgrepCommand(
  plan: GrepSearchPlan,
  cwd: string,
  paths: readonly string[],
): RipgrepCommand {
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

  args.push("--", plan.regexp.ripgrepSource, ...paths);
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
