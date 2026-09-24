import type { StartupCheckResult } from "../startup.js";

export type ReplHostStartupResult =
  | { kind: "connected" }
  | { kind: "unavailable"; error: unknown }
  | { kind: "configuration"; result: Exclude<StartupCheckResult, { kind: "ready" }> };

/** The authenticated Host owns runtime validation; the surface owns setup UX. */
export async function connectReplHost(input: {
  connection: { ensure(): Promise<void> };
  checkConfiguration(): Promise<StartupCheckResult>;
  starting(): void;
  settled(): void;
}): Promise<ReplHostStartupResult> {
  const connect = async (): Promise<Extract<ReplHostStartupResult, { kind: "connected" | "unavailable" }>> => {
    input.starting();
    try {
      await input.connection.ensure();
      return { kind: "connected" };
    } catch (error) {
      return { kind: "unavailable", error };
    } finally {
      input.settled();
    }
  };
  const initial = await connect();
  if (initial.kind === "connected") return initial;
  const configuration = await input.checkConfiguration();
  if (configuration.kind !== "ready") return { kind: "configuration", result: configuration };
  // Retry automatically only after the user completed setup. An unchanged
  // configuration must not turn a business failure into another startup wait.
  return configuration.configurationCompleted ? connect() : initial;
}
