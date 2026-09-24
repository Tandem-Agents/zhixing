import { expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { LogFilesProcess } from "./files-process.js";

it.skipIf(process.platform !== "win32")("finishes real DPAPI alongside native log owner startup without inherited pipe hangs", async () => {
  const home = await createTempDir("credential-log-startup");
  const files = new LogFilesProcess(home);
  try {
    const secretStore = createPlatformSecretStore({ homeDir: home });
    const [, state] = await Promise.all([files.open(false), secretStore.unlockState()]);
    expect(state).toBe("unlocked");
    // The logging helper must remain alive while the credential command completes.
    expect((await files.observeNodeProcesses()).complete).toBe(true);
  } finally { await files.close(); }
}, 15_000);
