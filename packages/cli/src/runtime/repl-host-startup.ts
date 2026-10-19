import type { StartupCheckResult } from "../startup.js";
import { CoreHostUnavailableError } from "./core-host-connection.js";

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
  signal?: AbortSignal;
}): Promise<ReplHostStartupResult> {
  const connect = async (): Promise<Extract<ReplHostStartupResult, { kind: "connected" | "unavailable" }>> => {
    input.signal?.throwIfAborted();
    input.starting();
    try {
      await input.connection.ensure();
      input.signal?.throwIfAborted();
      return { kind: "connected" };
    } catch (error) {
      input.signal?.throwIfAborted();
      return { kind: "unavailable", error };
    } finally {
      input.settled();
    }
  };
  const initial = await connect();
  input.signal?.throwIfAborted();
  if (initial.kind === "connected") return initial;
  // A long first projection upgrade is owned by the running daemon. A second
  // local configuration read can contend with that preparation and turn its
  // resource/lock failure into a misleading credential error. Keep the original
  // bounded-attempt result; an explicit retry gets a new connection attempt.
  if (initial.error instanceof CoreHostUnavailableError && initial.error.startupPending) return initial;
  const configuration = await input.checkConfiguration();
  input.signal?.throwIfAborted();
  if (configuration.kind !== "ready") return { kind: "configuration", result: configuration };
  // Retry automatically only after the user completed setup. An unchanged
  // configuration must not turn a business failure into another startup wait.
  return configuration.configurationCompleted ? connect() : initial;
}
