import { createGrepSearchPlan } from "./plan.js";
import { nodeGrepSearchExecutor } from "./node-executor.js";
import { ripgrepSearchExecutor } from "./ripgrep-executor.js";
import type {
  GrepExecutorQualification,
  GrepQuery,
  GrepSearchError,
  GrepSearchExecution,
  GrepSearchExecutor,
  GrepSearchOptions,
} from "./types.js";

export interface ExecuteGrepSearchOptions extends GrepSearchOptions {
  executors?: readonly GrepSearchExecutor[];
}

const DEFAULT_EXECUTORS: readonly GrepSearchExecutor[] = [
  ripgrepSearchExecutor,
  nodeGrepSearchExecutor,
];

export async function executeGrepSearch(
  query: GrepQuery,
  options: ExecuteGrepSearchOptions = {},
): Promise<GrepSearchExecution> {
  const planCreation = await createGrepSearchPlan(query);
  if (!planCreation.ok) return { ok: false, error: planCreation.error };

  const executors = options.executors ?? DEFAULT_EXECUTORS;
  const rejected: string[] = [];

  for (const executor of executors) {
    const qualification = await executor.qualify(planCreation.plan);
    if (!qualification.executable) {
      rejected.push(formatRejectedExecutor(executor.name, qualification));
      continue;
    }

    return executor.search(planCreation.plan, options);
  }

  return {
    ok: false,
    error: noExecutorError(rejected),
  };
}

function formatRejectedExecutor(
  name: GrepSearchExecutor["name"],
  qualification: Extract<GrepExecutorQualification, { executable: false }>,
): string {
  const noteText =
    qualification.notes !== undefined && qualification.notes.length > 0
      ? ` (${qualification.notes.join("; ")})`
      : "";
  return `${name}: ${qualification.reason}${noteText}`;
}

function noExecutorError(rejected: readonly string[]): GrepSearchError {
  if (rejected.length === 0) {
    return {
      code: "executor-unavailable",
      message: "No grep search executors are configured.",
    };
  }

  return {
    code: "executor-unavailable",
    message: "No grep search executor can satisfy this query.",
    notes: [...rejected],
  };
}
