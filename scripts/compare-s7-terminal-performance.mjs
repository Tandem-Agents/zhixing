import { readFile } from "node:fs/promises";
import {
  assertComparableTerminalPerformanceCaptures,
  compareTerminalPerformanceMatrix,
  validateTerminalPerformanceCaptureAsset,
} from "../packages/cli/src/serve/s7-performance-gate.ts";

const [baselinePath, currentPath] = process.argv.slice(2);
if (!baselinePath || !currentPath) throw new Error("Expected baseline and current capture paths");
const baseline = validateTerminalPerformanceCaptureAsset(JSON.parse(await readFile(baselinePath, "utf8")));
const current = validateTerminalPerformanceCaptureAsset(JSON.parse(await readFile(currentPath, "utf8")));
assertComparableTerminalPerformanceCaptures({ baseline, current });
const report = compareTerminalPerformanceMatrix({ baseline: baseline.runs, current: current.runs });
if (!report.passed) {
  console.error(JSON.stringify(report.comparisons, null, 2));
  process.exitCode = 1;
}
