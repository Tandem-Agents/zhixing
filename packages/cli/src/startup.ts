/** Text/service startup checks never acquire a screen or a secret input field.
 * Interactive setup is owned by the terminal application and supplies its own
 * edit port directly to the same configuration application. */
import { checkStartupConfiguration, type StartupApplicationOptions, type StartupCheckResult } from "./runtime/startup-application.js";
export type { StartupCheckResult, StartupMode } from "./runtime/startup-application.js";

export type RunStartupCheckOptions = Omit<StartupApplicationOptions, "edit">;

export async function runStartupCheck(options: RunStartupCheckOptions): Promise<StartupCheckResult> {
  return checkStartupConfiguration({
    ...options,
    isTTY: false,
    edit: async () => ({ kind: "non-tty" }),
  });
}
