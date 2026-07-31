import { publishTerminalPerformanceObservation } from "@zhixing/core/contracts";
import { describe, expect, it } from "vitest";
import {
  installTerminalPerformanceObservationReporter,
  TERMINAL_PERFORMANCE_OBSERVATION_PREFIX,
} from "./terminal-performance-observation.js";

describe("terminal performance observations", () => {
  it("reports real production measurement points without controlling execution", () => {
    const lines: string[] = [];
    const dispose = installTerminalPerformanceObservationReporter(
      true,
      (line) => lines.push(line),
    );
    try {
      publishTerminalPerformanceObservation({ kind: "workspace-preflight" });
      publishTerminalPerformanceObservation({ kind: "session-activity-commit" });
    } finally {
      dispose();
    }
    expect(lines).toEqual([
      `${TERMINAL_PERFORMANCE_OBSERVATION_PREFIX}workspace-preflight\n`,
      `${TERMINAL_PERFORMANCE_OBSERVATION_PREFIX}session-activity-commit\n`,
    ]);
  });
});
