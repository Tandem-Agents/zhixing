import diagnosticsChannel from "node:diagnostics_channel";

export type TerminalPerformanceObservation =
  | { readonly kind: "workspace-preflight" }
  | { readonly kind: "session-activity-commit" };

const channel = diagnosticsChannel.channel(
  "zhixing.terminal-performance-observation.v1",
);

/** Publishes a measurement-only fact without changing production control flow. */
export function publishTerminalPerformanceObservation(
  observation: TerminalPerformanceObservation,
): void {
  if (channel.hasSubscribers) channel.publish(observation);
}

export function observeTerminalPerformance(
  observer: (observation: TerminalPerformanceObservation) => void,
): () => void {
  const listener = (message: unknown) => {
    observer(message as TerminalPerformanceObservation);
  };
  channel.subscribe(listener);
  return () => channel.unsubscribe(listener);
}
