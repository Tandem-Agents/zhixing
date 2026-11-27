import * as fs from "node:fs/promises";
import { canReadAuthorizedFile } from "../utils.js";
import { listGrepCandidateFiles } from "./candidate-files.js";
import { GrepResultCollector } from "./collector.js";
import type {
  GrepSearchExecution,
  GrepSearchExecutor,
  GrepSearchOptions,
  GrepSearchPlan,
} from "./types.js";

export const nodeGrepSearchExecutor: GrepSearchExecutor = {
  name: "node",

  async qualify() {
    return { executable: true, capabilityMode: "fallback" };
  },

  async search(
    plan: GrepSearchPlan,
    options: GrepSearchOptions = {},
  ): Promise<GrepSearchExecution> {
    const collector = new GrepResultCollector(
      plan,
      { executor: "node", capabilityMode: "fallback" },
      options,
    );

    const stat = await fs.stat(plan.absoluteSearchPath);
    if (stat.isFile()) {
      if (
        !(await canReadAuthorizedFile(
          plan.absoluteSearchPath,
          options.authorizeFileAccess,
        ))
      ) {
        return { ok: true, result: collector.finish() };
      }
    }
    const files = stat.isFile()
      ? [plan.absoluteSearchPath]
      : listGrepCandidateFiles(
          plan.absoluteSearchPath,
          plan.query.glob,
          options.authorizeFileAccess,
        );

    for await (const absolutePath of files) {
      const stateError = collector.checkExecutionState();
      if (stateError !== null) return { ok: false, error: stateError };
      if (!collector.beginFileScan()) break;

      const scanError = await collector.collectFile(absolutePath);
      if (scanError !== null) return { ok: false, error: scanError };
      if (collector.hasTruncated) break;
    }

    return { ok: true, result: collector.finish() };
  },
};
