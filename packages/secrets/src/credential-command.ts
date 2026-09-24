import { existsSync } from "node:fs";
import { fork } from "node:child_process";
import type { CommandRunner } from "./platform-secret-store.js";

/** Isolate slow CreateProcess and inheritable pipe handles from the application's process. */
export const runCredentialCommand: CommandRunner = (command, args, input) => new Promise((resolve, reject) => {
  const built = new URL("./credential-command-worker.js", import.meta.url);
  const entry = existsSync(built) ? built : new URL("./credential-command-worker.ts", import.meta.url);
  const worker = fork(entry, [], { execArgv: [], env: sanitizedCredentialCommandEnvironment(), windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
  let result: { code: number; stdout: Uint8Array; stderr: Uint8Array } | undefined;
  let failure: Error | undefined;
  worker.on("message", (message: { error: string } | { code: number; stdout: Uint8Array; stderr: Uint8Array }) => {
    if ("error" in message) failure = new Error(`SecretStore credential command ${message.error}`);
    else result = message;
  });
  worker.on("error", error => { failure = error; });
  worker.send({ command, args, input }, error => { if (error) { failure = error; worker.kill(); } });
  // Completion includes command-process cleanup, not merely arrival of secret bytes.
  worker.once("close", code => {
    if (failure || code !== 0 || !result) {
      result?.stdout.fill(0); result?.stderr.fill(0);
      reject(failure ?? new Error("SecretStore credential command process exited"));
    } else resolve({ code: result.code, stdout: Buffer.from(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength), stderr: Buffer.from(result.stderr.buffer, result.stderr.byteOffset, result.stderr.byteLength) });
  });
});

function sanitizedCredentialCommandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "NODE_OPTIONS", "NODE_PATH"]) delete env[key];
  return env;
}
