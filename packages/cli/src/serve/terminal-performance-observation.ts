import {
  observeTerminalPerformance,
} from "@zhixing/core/contracts";

export const TERMINAL_PERFORMANCE_OBSERVATION_PREFIX =
  "__ZHIXING_TERMINAL_PERFORMANCE_V1__:";

export function installTerminalPerformanceObservationReporter(
  enabled = process.env.ZHIXING_TERMINAL_PERFORMANCE_OBSERVATION === "1",
  write: (line: string) => void = (line) => process.stderr.write(line),
): () => void {
  if (!enabled) return () => undefined;
  return observeTerminalPerformance((observation) => {
    write(`${TERMINAL_PERFORMANCE_OBSERVATION_PREFIX}${observation.kind}\n`);
  });
}
