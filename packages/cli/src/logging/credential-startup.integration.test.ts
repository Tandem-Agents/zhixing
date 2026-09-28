import { expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { LogFilesProcess } from "./files-process.js";
import { IsolatedLogStore } from "./store-process.js";
import { createDeviceCapacityRuntime } from "../__tests__/device-capacity-fixture.js";

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

it.skipIf(process.platform !== "win32")("unlocks credentials while the full isolated store initializes and remains usable", async () => {
  const home = await createTempDir("credential-isolated-store");
  const capacity = createDeviceCapacityRuntime(home);
  const store = new IsolatedLogStore(home, capacity.arbiter);
  try {
    const [status, state] = await Promise.all([store.initialize(), createPlatformSecretStore({ homeDir: home }).unlockState()]);
    expect(state).toBe("unlocked");
    expect(status.storeId).toBeTruthy();
    // A credential worker may exit during the first process inventory. Keep
    // the fail-closed observation, and require convergence once it is gone.
    await expect.poll(async () => (await store.maintain()).migration?.state, { timeout: 5000, interval: 200 }).toBe("confirmed");
  } finally { await store.close(); capacity.close(); }
}, 15_000);
